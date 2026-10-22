/**
 * Pure builders for the URLs/endpoints that open a source file in a local IDE,
 * plus the workspace-root → absolute-path join. Kept free of Vue/DOM so it can
 * be unit-tested in isolation; the reactive prefs and the actual launching live
 * in `useOpenInIde`.
 *
 * Four mechanisms are supported (see `apps/docs/features/ide-integration.md`):
 *  - JetBrains via the Piwi plugin's `/api/piwi/open` on the IDE's built-in
 *    server — the one that finds the file itself and reports whether it opened
 *  - VS Code family via the `vscode://file/<abs>:<line>:<col>` URL scheme, or
 *    via the Piwi extension's `vscode://piwitests.piwi/open` link, which finds
 *    a repo-relative path itself
 *  - JetBrains via the `jetbrains://<product>/navigate/reference` URL scheme
 *  - JetBrains via the built-in local web server / IDE Remote Control plugin
 */
import { JETBRAINS_PORTS } from '#shared/jetbrains-ports';
import { toPosixPath } from './retry-command';

export { parseLocation } from '#shared/parse-location';

export type VscodeScheme = 'vscode' | 'vscode-insiders' | 'vscodium' | 'cursor';

/** IDE argument dialect for the desktop command-line launcher. */
export type IdeFamily = 'vscode' | 'jetbrains';

/**
 * Command-line launcher names each VS Code flavor installs on the `PATH` (the
 * `code`/`cursor`/… commands). The desktop shell spawns these directly — a far
 * more reliable open than a `vscode://` URL, and one it can confirm started.
 */
export const VSCODE_CLI_COMMANDS: Record<VscodeScheme, string> = {
  vscode: 'code',
  'vscode-insiders': 'code-insiders',
  vscodium: 'codium',
  cursor: 'cursor',
};

/** `:line` when a line is present, `:line:col` when a column is too, else ''. */
function positionSuffix(line?: number | null, column?: number | null): string {
  if (line == null) return '';
  if (column == null) return `:${line}`;
  return `:${line}:${column}`;
}

/**
 * Percent-encode only the characters that would break URL parsing (space, `#`,
 * `?`, `%`), leaving `/` (separators) and `:` (the Windows drive letter and the
 * position suffix) intact. Per-segment `encodeURIComponent` is deliberately NOT
 * used — it would turn `C:` into `C%3A` and corrupt the path.
 */
export function encodePathForUrl(posixPath: string): string {
  return posixPath
    .replace(/%/g, '%25') // must run first so we don't double-encode below
    .replace(/ /g, '%20')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

/**
 * Join a user-configured absolute workspace root with a repo-relative path into
 * a single POSIX absolute path. Trims a trailing slash on the root and a leading
 * `./` or `/` on the relative part; normalizes backslashes on both.
 * e.g. ('/home/me/repo', 'tests/a.spec.ts') → '/home/me/repo/tests/a.spec.ts'.
 */
export function joinWorkspacePath(root: string, relPath: string): string {
  const posixRoot = toPosixPath(root).replace(/\/+$/, '');
  const posixRel = toPosixPath(relPath).replace(/^\.?\/+/, '');
  if (!posixRoot) return posixRel;
  return `${posixRoot}/${posixRel}`;
}

/** `vscode://file/<abs>:<line>:<col>` (and insiders/vscodium/cursor variants). */
export function buildVscodeUrl(o: {
  scheme: VscodeScheme;
  absPath: string;
  line?: number | null;
  column?: number | null;
}): string {
  const encoded = encodePathForUrl(toPosixPath(o.absPath));
  // Exactly one slash after `file`: Unix abs paths already start with '/',
  // Windows (`C:/…`) does not, so add one → `vscode://file/C:/…`.
  const withSlash = encoded.startsWith('/') ? encoded : `/${encoded}`;
  return `${o.scheme}://file${withSlash}${positionSuffix(o.line, o.column)}`;
}

/** The Piwi extension's id in VS Code and its forks, the authority of its `vscode://` links. */
export const VSCODE_EXTENSION_ID = 'piwitests.piwi';

/**
 * `vscode://piwitests.piwi/open?file=<path>&line=&column=&root=` (and the
 * insiders/vscodium/cursor variants): the Piwi extension finds the path as the
 * run reported it under its workspace's folders, so no workspace root is
 * needed. `root`, when known, is the folder the path is relative to. Line and
 * column are 1-based. Each value is percent-encoded whole, a space as `%20`.
 */
export function buildVscodeExtensionUrl(o: {
  scheme: VscodeScheme;
  path: string;
  line?: number | null;
  column?: number | null;
  root?: string | null;
}): string {
  const query = [`file=${encodeURIComponent(toPosixPath(o.path))}`];
  if (o.line != null) query.push(`line=${o.line}`);
  if (o.line != null && o.column != null) query.push(`column=${o.column}`);
  if (o.root) query.push(`root=${encodeURIComponent(toPosixPath(o.root))}`);
  return `${o.scheme}://${VSCODE_EXTENSION_ID}/open?${query.join('&')}`;
}

/** A 1-based line or column as the 0-based value an IDE API takes, or null. */
function zeroBased(n?: number | null): number | null {
  return n == null ? null : Math.max(n - 1, 0);
}

/**
 * `jetbrains://<product>/navigate/reference?project=<name>&path=<rel>:<line>:<col>`.
 * Uses the IDE project name + a project-relative path, so no absolute root is
 * needed. Line/column are appended to the `path` value with literal colons
 * (JetBrains does not accept separate line/column query params). The IDE reads
 * them as a 0-based editor position, so the 1-based line and column shown in
 * the dashboard are sent minus one: `:12:3` would land on line 13, column 4.
 */
export function buildJetbrainsNavigateUrl(o: {
  product: string;
  projectName: string;
  relPath: string;
  line?: number | null;
  column?: number | null;
}): string {
  const path = encodePathForUrl(toPosixPath(o.relPath)) + positionSuffix(zeroBased(o.line), zeroBased(o.column));
  return `jetbrains://${o.product}/navigate/reference?project=${encodeURIComponent(o.projectName)}&path=${path}`;
}

/**
 * The ports to ask for the Piwi JetBrains plugin, the configured one first. A
 * JetBrains IDE's built-in server takes the first free port of 63342…63361, so
 * a second IDE running (Rider next to WebStorm) is on 63343, not the default.
 */
export function jetbrainsPorts(configured: number): number[] {
  return [...new Set([configured, ...JETBRAINS_PORTS].filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
}

/**
 * `http://127.0.0.1:<port>/api/piwi/open?file=…` — the Piwi JetBrains plugin's
 * Open in IDE endpoint. `path` is the run's repo-relative path (or an absolute
 * one); `root`, when known, is the folder it is relative to. Line and column are
 * 1-based. With `check`, the IDE only says whether one of its open projects
 * holds the file.
 */
export function buildPiwiPluginOpenUrl(o: {
  port: number;
  path: string;
  root?: string | null;
  line?: number | null;
  column?: number | null;
  project?: string | null;
  check?: boolean;
}): string {
  const query = new URLSearchParams({ file: toPosixPath(o.path) });
  if (o.root) query.set('root', toPosixPath(o.root));
  if (o.line != null) query.set('line', String(o.line));
  if (o.line != null && o.column != null) query.set('column', String(o.column));
  if (o.project) query.set('project', o.project);
  if (o.check) query.set('check', '1');
  return `http://127.0.0.1:${o.port}/api/piwi/open?${query}`;
}

/** What the Piwi JetBrains plugin answers (`found: false` comes with a 404). */
export interface PiwiPluginAnswer {
  found: boolean;
  /** The file is being opened (false for a `check`). */
  opened?: boolean;
  /** The IDE's name: `Rider`, `WebStorm`, `IntelliJ IDEA`. */
  ide?: string;
  /** The IDE project that holds the file. */
  project?: string;
  /** The file's absolute path in that project. */
  file?: string;
  /** The IDE's open projects, when none holds the file. */
  projects?: string[];
  error?: string;
}

/** Whether an IDE name (`IntelliJ IDEA`) is the product a `jetbrains://` tag names (`idea`). */
export function isJetbrainsProduct(ide: string | undefined, product: string): boolean {
  const tag = product.trim().toLowerCase();
  return !!tag && !!ide && ide.toLowerCase().replace(/\s+/g, '').includes(tag);
}

/**
 * The IDE to open the file in, among the answers of a check: one that holds
 * the file, the configured product first, then in port order (the answers'
 * order). Null when none holds it.
 */
export function pickPiwiPluginAnswer<T extends { answer: PiwiPluginAnswer | null }>(
  answers: T[],
  product: string,
): T | null {
  const holding = answers.filter((a) => a.answer?.found);
  return holding.find((a) => isJetbrainsProduct(a.answer?.ide, product)) ?? holding[0] ?? null;
}

/**
 * `http://localhost:<port>/api/file/<path>:<line>:<col>` — the JetBrains built-in
 * web server / IDE Remote Control plugin endpoint. `path` may be absolute (giving
 * the expected `/api/file//abs/...` double slash) or content-root-relative.
 */
export function buildJetbrainsHttpUrl(o: {
  port: number;
  path: string;
  line?: number | null;
  column?: number | null;
}): string {
  const encoded = encodePathForUrl(toPosixPath(o.path));
  return `http://localhost:${o.port}/api/file/${encoded}${positionSuffix(o.line, o.column)}`;
}
