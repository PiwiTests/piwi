/**
 * The pure half of **Debug in my editor**: the dashboard's open link with `debug=1`
 * (`vscode://piwitests.piwi/open?file=…&line=…&debug=1&spec=…&test=…&playwrightProject=…&execution=…`), read and
 * checked field by field. A link is anyone's to write, so it names files, a line and a title, never a command or an
 * option: every value has its own rule, a link naming a field twice is refused, and the files must be in a workspace
 * folder of this window once every link is followed (`debugFiles`), under a Playwright config's folder. No VS Code
 * API here, so the rules are tested without an editor.
 */
import * as path from 'node:path';
import { SPEC_FILE, inertLinks, resolveOpenFile } from './glue';

/** What a debug link names, each value checked. Lines are 1-based. */
export interface DebugLink {
  /** The failing line's file, as the run reported it (the spec or a page object). */
  file: string;
  line: number;
  column: number;
  /** The folder the files are relative to, when the dashboard knows it. */
  root: string | null;
  /** The test's spec, as the run reported it; the failing file when the link names none. */
  spec: string;
  /** The test's title after its describe blocks', joined by ` › `. */
  title: string;
  /** The Playwright project it failed in; null runs every project. */
  project: string | null;
  /** The failed execution on the instance, whose suggested locator is outlined at the stop. */
  execution: number | null;
}

/** The fields an open link takes; a debug link takes the last five too. */
const FIELDS = ['file', 'line', 'column', 'root', 'debug', 'spec', 'test', 'playwrightProject', 'execution'];

/** The longest path, title and project name a link may name. */
const MAX_PATH = 4096;
const MAX_TITLE = 1000;
const MAX_PROJECT = 200;

/** The largest execution id: an instance's ids are 32-bit. */
const MAX_EXECUTION = 2_147_483_647;

/**
 * Text alone: no control character, and none of the characters a message could read as markup or a link (`[`, `]`,
 * `<`, `>`, a backtick, a backslash).
 */
const PLAIN_TEXT = /^[^\p{Cc}[\]<>`\\]+$/u;

/**
 * Characters a shell expands, which no Playwright project name on a command line may hold: PowerShell reads the
 * typographic double quotes (“ ” „) as `"` too.
 */
const SHELL_EXPANDED = /[$"%!\u201C\u201D\u201E]/;

/** A positive whole number as a link writes it: no sign, no leading zero, no exponent. */
const POSITIVE = /^[1-9]\d{0,9}$/;

/** A file a failing line can be in; a spec is one as the editor service reads specs (`SPEC_FILE`). */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/** Whether an open link's query (as `vscode.Uri.query` gives it, decoded) asks to debug: `debug=1`, alone or not. */
export function isDebugLink(query: string): boolean {
  return /(?:^|&)debug=/.test(query);
}

/** Why a path a link names is refused; null when it is one Piwi looks for. */
function refusedPath(name: string, value: string): string | null {
  if (value.length > MAX_PATH) return `${name} is longer than ${MAX_PATH} characters`;
  if (/\p{Cc}/u.test(value)) return `${name} holds a control character`;
  const slashed = value.replace(/\\/g, '/');
  // A network path would have the editor reach a share, and send it the user's credentials.
  if (slashed.startsWith('//')) return `${name} is a network path`;
  if (slashed.split('/').includes('..')) return `${name} climbs out of its folder with ..`;
  return null;
}

/**
 * A debug link's query, as `vscode.Uri.query` gives it (decoded), each value checked; why it is refused otherwise.
 * Each value runs up to the next `&` that starts one of the link's fields, so a path or a title may hold an `&`.
 */
export function debugLink(query: string): DebugLink | { refused: string } {
  const pattern = new RegExp(`&(?=(?:${FIELDS.join('|')})=)`);
  const params = new Map<string, string>();
  for (const pair of query.split(pattern)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    if (!FIELDS.includes(name)) continue;
    if (params.has(name)) return { refused: `it names ${name} twice` };
    params.set(name, pair.slice(eq + 1));
  }
  if (params.get('debug') !== '1') return { refused: 'debug is not 1' };
  const file = params.get('file')?.trim() ?? '';
  if (!file) return { refused: 'it names no file' };
  const spec = params.get('spec')?.trim() || file;
  const root = params.get('root')?.trim() || null;
  for (const [name, value] of [['file', file], ['spec', spec], ...(root ? [['root', root]] : [])] as const) {
    const refused = refusedPath(name, value);
    if (refused) return { refused };
  }
  const line = params.get('line') ?? '';
  if (!POSITIVE.test(line) || Number(line) > MAX_EXECUTION) return { refused: 'line is not a positive whole number' };
  const column = params.get('column');
  if (column !== undefined && (!POSITIVE.test(column) || Number(column) > MAX_EXECUTION)) {
    return { refused: 'column is not a positive whole number' };
  }
  const title = params.get('test')?.trim() ?? '';
  if (!title || title.length > MAX_TITLE || !PLAIN_TEXT.test(title)) {
    return { refused: `test is not a title of 1 to ${MAX_TITLE} characters of plain text` };
  }
  const project = params.get('playwrightProject')?.trim() || null;
  if (project !== null && (project.length > MAX_PROJECT || !PLAIN_TEXT.test(project) || SHELL_EXPANDED.test(project))) {
    return { refused: `playwrightProject is not a project name of 1 to ${MAX_PROJECT} characters of plain text` };
  }
  const execution = params.get('execution');
  if (execution !== undefined && (!POSITIVE.test(execution) || Number(execution) > MAX_EXECUTION)) {
    return { refused: 'execution is not an id' };
  }
  return {
    file,
    line: Number(line),
    column: column === undefined ? 1 : Number(column),
    root,
    spec,
    title,
    project,
    execution: execution === undefined ? null : Number(execution),
  };
}

/** Whether `file` is `folder` or inside it. */
function within(folder: string, file: string): boolean {
  const rel = path.relative(folder, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** What `debugFiles` reads of the disk. */
export interface DebugDisk {
  isFile(file: string): boolean;
  /** The file's path with every link followed; null when it cannot be told. */
  realpath(file: string): string | null;
}

/**
 * The files a debug link names, found as an open link's are (`resolveOpenFile`), then checked again with every link
 * followed: each in a workspace folder of this window and under a Playwright config's folder, the failing line's a
 * script file and the test's a spec. Why not otherwise, naming the file as the link named it.
 */
export function debugFiles(
  link: Pick<DebugLink, 'file' | 'spec' | 'root'>,
  places: { workspaceFolders: readonly string[]; configRoots: readonly string[] },
  disk: DebugDisk,
): { file: string; spec: string } | { refused: string } {
  const real = (folders: readonly string[]) => folders.flatMap((f) => disk.realpath(f) ?? []);
  const folders = real(places.workspaceFolders);
  const configs = real(places.configRoots);
  const found = (named: string, pattern: RegExp, kind: string): string | { refused: string } => {
    const file = resolveOpenFile({ file: named, root: link.root }, places, disk.isFile);
    if (!file) return { refused: `no file of this window matches ${named}` };
    const actual = disk.realpath(file);
    if (!actual || !folders.some((f) => within(f, actual)))
      return { refused: `${named} is outside this window's folders` };
    if (!configs.some((c) => within(c, actual))) return { refused: `${named} is under no Playwright config's folder` };
    if (!pattern.test(actual)) return { refused: `${named} is not ${kind}` };
    return file;
  };
  const file = found(link.file, SCRIPT_FILE, 'a JavaScript or TypeScript file');
  if (typeof file !== 'string') return file;
  const spec = found(link.spec, SPEC_FILE, 'a spec');
  if (typeof spec !== 'string') return spec;
  return { file, spec };
}

/** The prompt that asks before a link runs anything: the test, and the Playwright project it runs in. */
export function debugPrompt(link: Pick<DebugLink, 'title' | 'line' | 'project'>): string {
  const project = link.project ? ` in the Playwright project “${link.project}”,` : '';
  return `Piwi: Debug this test here? Piwi runs “${link.title}”${project} headed, one worker, and stops at line ${link.line}.`;
}

/** What a refused debug link says: the paths it quotes are the link's, so none reads as a link of its own. */
export function debugRefusal(why: string): string {
  return inertLinks(`Piwi: this Debug in my editor link was refused: ${why}. Nothing was opened or run.`);
}
