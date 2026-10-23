/**
 * The workspace as the editor service sees it: the Playwright configs it
 * holds (each one a context: call sites resolve against its directory), the
 * git repository around them, and a file as `HEAD` or a run's commit holds it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTranslationFile, parseTranslationFile } from '@piwitests/core/diff-anchors';

const run = promisify(execFile);

/** The names Playwright reads a config from without `--config`. */
const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.mts',
  'playwright.config.cts',
];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.output',
  '.nuxt',
  '.next',
  'coverage',
  'test-results',
]);
/** Directory levels searched below a workspace folder for Playwright configs. */
const MAX_DEPTH = 4;

/** The directories under `root` (itself included) that hold a Playwright config. */
export function findPlaywrightRoots(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && CONFIG_NAMES.includes(e.name))) found.push(dir);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

/** The Playwright config a directory holds; null when it holds none. */
export function playwrightConfigFile(dir: string): string | null {
  const name = CONFIG_NAMES.find((n) => fs.existsSync(path.join(dir, n)));
  return name ? path.join(dir, name) : null;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' });
    return stdout;
  } catch {
    return null;
  }
}

/** The repository root around `dir`; `dir` itself outside a repository. */
export async function repositoryRoot(dir: string): Promise<string> {
  const out = await git(dir, ['rev-parse', '--show-toplevel']);
  return out ? path.resolve(out.trim()) : path.resolve(dir);
}

/** The checked-out branch; null on a detached head or outside a repository. */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  const out = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return out && out !== 'HEAD' ? out : null;
}

/** The commit `HEAD` names; null outside a repository. */
export async function headCommit(repoRoot: string): Promise<string | null> {
  return (await git(repoRoot, ['rev-parse', 'HEAD']))?.trim() || null;
}

/**
 * The files git writes when `HEAD` moves, by a checkout or a commit: `HEAD` and `logs/HEAD` of the repository around
 * `repoRoot`, where git keeps them (those of a worktree or a submodule lie in the main repository's `.git`). Empty
 * outside a repository.
 */
export async function headFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['rev-parse', '--git-path', 'HEAD', '--git-path', 'logs/HEAD']);
  return (out ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.resolve(repoRoot, file));
}

/** A file as `HEAD` holds it; null when it is new or outside a repository. */
export async function committedText(repoRoot: string, relativePath: string): Promise<string | null> {
  return git(repoRoot, ['show', `HEAD:${relativePath.split(path.sep).join('/')}`]);
}

/** A commit's object name as git prints it, full or abbreviated: anything else is never passed to git. */
const COMMIT = /^[0-9a-f]{4,64}$/i;

/**
 * A file as `commit` holds it, by its path relative to the repository; null when the local repository lacks the
 * commit or the path, or when `commit` is not an object name.
 */
export async function committedTextAt(repoRoot: string, commit: string, relativePath: string): Promise<string | null> {
  if (!COMMIT.test(commit)) return null;
  return git(repoRoot, ['show', `${commit}:${relativePath.split(path.sep).join('/')}`]);
}

/** A git blob id: 40 hexadecimal characters, or 64 in a SHA-256 repository. */
const BLOB = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A file's text as git stores it, by its blob id (`git cat-file blob`); null when the local repository lacks the blob,
 * or when `blob` is not a blob id.
 */
export async function blobText(repoRoot: string, blob: string): Promise<string | null> {
  if (!BLOB.test(blob)) return null;
  return git(repoRoot, ['cat-file', 'blob', blob]);
}

/**
 * The version of `@piwitests/reporter` a Playwright config's folder installs: its `node_modules`, else that of a
 * folder above it, up to the repository root, as Node resolves it. Null when none is found or its `package.json` has
 * no version.
 */
export function reporterVersion(dir: string, repoRoot: string): string | null {
  let current = path.resolve(dir);
  const stop = path.resolve(repoRoot);
  for (;;) {
    try {
      const manifest = path.join(current, 'node_modules', '@piwitests', 'reporter', 'package.json');
      const version = (JSON.parse(fs.readFileSync(manifest, 'utf-8')) as { version?: unknown }).version;
      if (typeof version === 'string' && version) return version;
    } catch {
      // Not installed here: look above.
    }
    const parent = path.dirname(current);
    if (current === stop || parent === current || relativeTo(stop, current) === null) return null;
    current = parent;
  }
}

/** A path relative to `root`, with forward slashes; null when it is outside. */
export function relativeTo(root: string, file: string): string | null {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * A Playwright config's folder as the editor names it: relative to the deepest workspace folder holding it, with
 * forward slashes, after that folder's name when the workspace has several (`shop/e2e`); the workspace folder's name
 * for a config at its root; the whole path outside every workspace folder.
 */
export function contextLabel(root: string, folders: readonly string[]): string {
  const folder = folders
    .filter((f) => path.relative(f, root) === '' || relativeTo(f, root) !== null)
    .sort((a, b) => b.length - a.length)[0];
  if (!folder) return root;
  const name = path.basename(folder) || folder;
  const rel = relativeTo(folder, root);
  if (!rel) return name;
  return folders.length > 1 ? `${name}/${rel}` : rel;
}

/**
 * Translation values by key for one side of a change: the working tree
 * (`new`) or `HEAD` (`old`). Built once per side and repository state; the
 * files of `locale` come first.
 */
export async function translationValues(
  repoRoot: string,
  side: 'old' | 'new',
  locale = 'en',
): Promise<Map<string, string>> {
  const listed = (await git(repoRoot, ['ls-files']))?.split('\n').filter((f) => f && isTranslationFile(f)) ?? [];
  const prefers = (f: string) => {
    const parts = f.toLowerCase().split('/');
    const stem = parts[parts.length - 1]!.replace(/\.[^.]+$/, '');
    return parts.includes(locale) || stem === locale || stem.endsWith(`.${locale}`);
  };
  listed.sort((a, b) => Number(prefers(b)) - Number(prefers(a)) || a.localeCompare(b));
  const map = new Map<string, string>();
  for (const file of listed) {
    const text =
      side === 'new'
        ? await fs.promises.readFile(path.join(repoRoot, file), 'utf-8').catch(() => null)
        : await committedText(repoRoot, file);
    if (text === null) continue;
    for (const entry of parseTranslationFile(file, text)) {
      if (!map.has(entry.key)) map.set(entry.key, entry.value);
      const dot = entry.key.indexOf('.');
      if (dot > 0 && !map.has(entry.key.slice(dot + 1))) map.set(entry.key.slice(dot + 1), entry.value);
    }
  }
  return map;
}

/**
 * The workspace file a path reported by a run names: CI paths are absolute on
 * another machine, so the path is tried as given, then relative to each root,
 * then by ever shorter suffixes (at least the file and its directory) under
 * each root. Null when none exists.
 */
export function resolveReportedFile(roots: string[], reported: string): string | null {
  const normalized = reported.replace(/\\/g, '/');
  if (path.isAbsolute(normalized) && fs.existsSync(normalized)) return path.resolve(normalized);
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  for (const root of roots) {
    for (let from = 0; from < parts.length; from++) {
      if (parts.length - from < Math.min(2, parts.length)) break;
      const candidate = path.join(root, ...parts.slice(from));
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/** A `file:line:col` location split into its parts; the file keeps any drive letter. */
export function splitLocation(location: string): { file: string; line: number; column: number } | null {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(location);
  if (!m) return null;
  return { file: m[1]!, line: Number(m[2]), column: m[3] ? Number(m[3]) : 1 };
}
