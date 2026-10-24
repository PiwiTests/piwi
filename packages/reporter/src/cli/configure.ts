/**
 * The deterministic edits `init` makes to a project: wrapping the Playwright
 * config, creating the capture-fixtures file, and recording connection details
 * in `.env` / `.gitignore`.
 *
 * Every function here is pure — string in, string out — so the risky part
 * (rewriting someone's config) is unit-tested without touching disk, and the
 * command layer only owns reading and writing files. Each transform is
 * idempotent: running it against already-configured input reports `already`
 * rather than doubling anything up.
 */
import { quoteJsString } from '@piwitests/core/locator-chain';

export interface WrapOptions {
  /** Written into the config; omitted when empty so the reporter reads the env instead. */
  serverUrl?: string;
  projectName: string;
  /** Written into the config when set: when results go to the desktop app instead of `serverUrl`. */
  desktopApp?: 'prefer' | 'fallback' | 'off';
}

export interface ConfigEdit {
  text: string;
  status: 'updated' | 'already' | 'manual';
  detail: string;
}

const REPORTER_IMPORT = "import { wrapConfig } from '@piwitests/reporter'";

/** The manual step for a config `wrapPlaywrightConfig` cannot rewrite, with the options it would have written. */
function manualHint(opts: WrapOptions): string {
  const options = optionsLiteral(opts).replace(/\s+/g, ' ');
  return (
    'Could not find `export default defineConfig(...)`. Wrap your exported config by hand: ' +
    "import { wrapConfig } from '@piwitests/reporter', then " +
    `export default wrapConfig(defineConfig({ ... }), ${options}).`
  );
}

/** Single-quote a value for embedding in a config literal. */
const quote = quoteJsString;

/**
 * Index of the `)` that closes the `(` at `openIndex`, or -1 if unbalanced.
 * Skips parentheses that appear inside strings and comments so a URL or a
 * commented-out block can't throw the count off.
 */
function matchClosingParen(src: string, openIndex: number): number {
  let depth = 0;
  let quoteChar: string | null = null;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (quoteChar) {
      if (c === quoteChar && src[i - 1] !== '\\') quoteChar = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quoteChar = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The Piwi options object, printed multi-line to sit inside the wrapped call. */
function optionsLiteral(opts: WrapOptions): string {
  const lines: string[] = [];
  if (opts.serverUrl) lines.push(`    serverUrl: ${quote(opts.serverUrl)},`);
  lines.push(`    projectName: ${quote(opts.projectName)},`);
  if (opts.desktopApp) lines.push(`    desktopApp: ${quote(opts.desktopApp)},`);
  return `{\n${lines.join('\n')}\n  }`;
}

/**
 * Add the `wrapConfig` import next to the file's existing imports — after the
 * last complete single-line `import ... from '...'` (or side-effect import), so
 * the two land together. Falls back to prepending when the head has no import
 * the insertion can safely anchor to (e.g. only multi-line imports).
 */
function withReporterImport(head: string): string {
  const importLine = /^import\b.*$/gm;
  let insertAt = -1;
  let match: RegExpExecArray | null;
  while ((match = importLine.exec(head))) {
    const line = match[0];
    const complete = /from\s*['"][^'"]+['"]\s*;?\s*$/.test(line) || /^import\s+['"][^'"]+['"]\s*;?\s*$/.test(line);
    if (complete) insertAt = match.index + line.length;
  }
  if (insertAt === -1) return `${REPORTER_IMPORT}\n${head}`;
  return `${head.slice(0, insertAt)}\n${REPORTER_IMPORT}${head.slice(insertAt)}`;
}

/**
 * Wrap a Playwright config's `export default defineConfig(...)` with
 * `wrapConfig(...)` and add the import. Returns `already` when the reporter is
 * present, and `manual` (with the exact snippet in `detail`) when the config
 * uses a shape this cannot rewrite safely.
 */
export function wrapPlaywrightConfig(source: string, opts: WrapOptions): ConfigEdit {
  if (/@piwitests\/reporter/.test(source)) {
    return { text: source, status: 'already', detail: 'Piwi reporter is already wired into the config' };
  }

  const match = /export\s+default\s+defineConfig\s*\(/.exec(source);
  if (!match) return { text: source, status: 'manual', detail: manualHint(opts) };

  const openParen = match.index + match[0].length - 1;
  const closeParen = matchClosingParen(source, openParen);
  const callStart = source.indexOf('defineConfig', match.index);
  if (closeParen === -1 || callStart === -1) return { text: source, status: 'manual', detail: manualHint(opts) };

  const callExpr = source.slice(callStart, closeParen + 1);
  let before = withReporterImport(source.slice(0, match.index));
  const after = source.slice(closeParen + 1);
  if (before.length && !before.endsWith('\n')) before += '\n';

  const wrapped = `export default wrapConfig(\n  ${callExpr},\n  ${optionsLiteral(opts)},\n)`;
  const text = `${before}${wrapped}${after}`;
  return { text, status: 'updated', detail: 'Wrapped defineConfig(...) with wrapConfig(...) and added the import' };
}

/** Contents of the capture-fixtures file — identical for TS and JS projects. */
export function fixturesContents(): string {
  return [
    "import { test as base, expect } from '@playwright/test'",
    "import { piwiFixtures } from '@piwitests/reporter'",
    '',
    'export const test = base.extend(piwiFixtures)',
    'export { expect }',
    '',
  ].join('\n');
}

/**
 * Add each `KEY=value` line that is not already present. Existing keys are left
 * untouched (a value already set by the user is never overwritten).
 */
export function upsertEnvKeys(
  existing: string,
  entries: ReadonlyArray<readonly [string, string]>,
): {
  text: string;
  added: string[];
} {
  let text = existing;
  const added: string[] = [];
  for (const [key, value] of entries) {
    if (new RegExp(`^\\s*${key}=`, 'm').test(text)) continue;
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
    added.push(key);
  }
  return { text, added };
}

/** Ensure `entry` (default `.env`) appears in a `.gitignore`'s contents. */
export function ensureGitignoreEntry(existing: string, entry = '.env'): { text: string; added: boolean } {
  const present = existing.split(/\r?\n/).some((line) => line.trim() === entry);
  if (present) return { text: existing, added: false };
  let text = existing;
  if (text.length && !text.endsWith('\n')) text += '\n';
  text += `${entry}\n`;
  return { text, added: true };
}
