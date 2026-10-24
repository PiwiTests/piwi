/**
 * `piwi preflight` — the test locators a change breaks, before it runs.
 *
 * Reads the working tree's diff against a base ref, lists the strings it
 * removes or renames (a label, an `aria-label`, a test id, a placeholder, a
 * translation), and matches them against every chain in the project's locator
 * index with Playwright's own text rules. Each broken chain comes with its
 * tests and call sites and, for a rename, the same chain with the new string,
 * which `--fix` writes into the call sites.
 *
 * A prediction is a warning: preflight exits 0 unless `--strict` is given and
 * a likely break is left unfixed, or `--run`'s tests fail. The index is cached
 * in `.piwi/locator-index.json`, so it runs offline on the last good copy.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  extractDiffAnchors,
  isTranslationFile,
  parseTranslationFile,
  parseUnifiedDiff,
  type DiffAnchor,
  type DiffFile,
} from '@piwitests/core/diff-anchors';
import type { PiwiConnection } from '@piwitests/core/dotenv';
import {
  callSiteFile,
  callSiteLine,
  predictLocatorBreaks,
  reachOfIndex,
  type LocatorBreak,
} from '@piwitests/core/locator-break';
import { buildLiteralEdit } from '@piwitests/core/locator-edit';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { diffImpactInput } from '@piwitests/core/suspect-lines';
import { resolveCliConnection } from '../internal/support/connection.js';
import {
  fetchCodeIndex,
  fetchImpact,
  fetchLocatorIndex,
  resolveProjectId,
  type ImpactResolution,
} from '../internal/support/selection-client.js';
import { spawnPlaywrightForRun } from './select.js';
import { originEnv } from '../internal/config/env.js';

const EXIT_OK = 0;
const EXIT_BREAKS = 1;
const EXIT_ERROR = 2;

/** Breaks listed in full before the rest are counted. */
const MAX_LISTED = 20;

const USAGE = `
piwi preflight — the test locators a change breaks, before it runs

Usage:
  npx @piwitests/reporter preflight [options] [-- <playwright args>]

Diff:
  --base <ref>          Diff the working tree against this ref (default HEAD: uncommitted changes)
  --branch <name>       Compare with this branch's locator index (default: the project's default branch)
  --test-root <dir>     Where call sites resolve (default: the directory of the nearest playwright.config)
  --locale <code>       Translation files of this locale resolve keys first (default en)

Actions:
  --fix                 Write the rewrites into the call sites that hold the string
  --run                 Run the tests that reach the changed files and the tests of the broken locators
  --strict              Exit 1 when a likely break is left unfixed

Connection:
  --server-url <url>    Dashboard URL         (env PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>       API key               (env PIWI_API_KEY)
  --project <name|id>   Project               (env PIWI_PROJECT_NAME)

Output:
  --json                Print the breaks, the edits and the impact as JSON
  -h, --help            Show this help

Exit codes: 0 ok, 1 a likely break left unfixed with --strict or --run's tests failed,
2 the index could not be fetched and there is no cached copy, or the diff could not be read.
`.trim();

export interface PreflightArgs {
  base: string;
  branch: string | null;
  testRoot: string | null;
  locale: string;
  fix: boolean;
  run: boolean;
  strict: boolean;
  json: boolean;
  serverUrl: string | undefined;
  apiKey: string | undefined;
  project: string | undefined;
  pkgRunner: string;
  extra: string[];
}

const VALUE_FLAGS = new Set([
  '--base',
  '--branch',
  '--test-root',
  '--locale',
  '--server-url',
  '--api-key',
  '--project',
]);

function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

export function parsePreflightArgs(argv: string[]): PreflightArgs {
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  for (let i = 0; i < own.length; i++) {
    const tok = own[i]!;
    const name = tok.split('=')[0]!;
    if (VALUE_FLAGS.has(name)) {
      if (!tok.includes('=')) {
        if (own[i + 1] === undefined || own[i + 1]!.startsWith('--')) throw new Error(`${name} needs a value`);
        i++;
      }
      continue;
    }
    if (!['--fix', '--run', '--strict', '--json'].includes(tok)) throw new Error(`unknown argument "${tok}"`);
  }
  return {
    base: readOption(own, '--base') ?? 'HEAD',
    branch: readOption(own, '--branch') ?? null,
    testRoot: readOption(own, '--test-root') ?? null,
    locale: readOption(own, '--locale') ?? 'en',
    fix: own.includes('--fix'),
    run: own.includes('--run'),
    strict: own.includes('--strict'),
    json: own.includes('--json'),
    serverUrl: readOption(own, '--server-url'),
    apiKey: readOption(own, '--api-key'),
    project: readOption(own, '--project'),
    pkgRunner: 'npx',
    extra: dashIndex === -1 ? [] : argv.slice(dashIndex + 1),
  };
}

// ── The workspace ────────────────────────────────────────────────────────────

const CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs'];

/** The directory of the nearest Playwright config at or above `from`; null when there is none. */
export function findPlaywrightRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

const TEST_FILE = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

/** The connection from flags, the environment, the workspace `.env`, then the desktop app. */
function resolveConnection(args: PreflightArgs, env: NodeJS.ProcessEnv, dirs: string[]): PiwiConnection | null {
  return resolveCliConnection({ serverUrl: args.serverUrl, apiKey: args.apiKey, project: args.project }, env, dirs);
}

/**
 * Translation values by key, for templates whose key changed. Files of the
 * preferred locale come first; the new side reads the working tree, the old
 * side the base ref.
 */
function translationLookup(repoRoot: string, base: string, locale: string) {
  const files = (tryGit(repoRoot, ['ls-files']) ?? '')
    .split('\n')
    .filter((f) => f && isTranslationFile(f))
    .sort((a, b) => Number(prefersLocale(b, locale)) - Number(prefersLocale(a, locale)) || a.localeCompare(b));
  const maps: Record<'old' | 'new', Map<string, string> | null> = { old: null, new: null };
  const build = (side: 'old' | 'new') => {
    const map = new Map<string, string>();
    for (const file of files) {
      const content =
        side === 'new' ? readText(path.join(repoRoot, file)) : tryGit(repoRoot, ['show', `${base}:${file}`]);
      if (content === undefined) continue;
      for (const entry of parseTranslationFile(file, content)) {
        if (!map.has(entry.key)) map.set(entry.key, entry.value);
        // A key under a locale root (`en.checkout.pay`) also resolves without it.
        const dot = entry.key.indexOf('.');
        if (dot > 0 && !map.has(entry.key.slice(dot + 1))) map.set(entry.key.slice(dot + 1), entry.value);
      }
    }
    return map;
  };
  return (key: string, side: 'old' | 'new') => (maps[side] ??= build(side)).get(key);
}

function prefersLocale(file: string, locale: string): boolean {
  const parts = file.toLowerCase().split('/');
  const stem = parts[parts.length - 1]!.replace(/\.[^.]+$/, '');
  return (
    parts.includes(locale.toLowerCase()) || stem === locale.toLowerCase() || stem.endsWith(`.${locale.toLowerCase()}`)
  );
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

// ── The index and its cache ──────────────────────────────────────────────────

const CACHE_FILE = path.join('.piwi', 'locator-index.json');

interface CachedIndex {
  savedAt: string;
  index: LocatorIndex;
}

function cacheKey(connection: PiwiConnection, branch: string | null): string {
  return `${connection.serverUrl}|${connection.project}|${branch ?? ''}`;
}

function readCache(root: string, key: string): CachedIndex | null {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(root, CACHE_FILE), 'utf-8')) as Record<string, CachedIndex>;
    return store[key] ?? null;
  } catch {
    return null;
  }
}

function writeCache(root: string, key: string, index: LocatorIndex): void {
  const file = path.join(root, CACHE_FILE);
  try {
    let store: Record<string, CachedIndex> = {};
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, CachedIndex>;
    } catch {
      // No cache yet.
    }
    store[key] = { savedAt: new Date().toISOString(), index };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store));
  } catch {
    // A cache write failure never fails the command.
  }
}

/**
 * Which files each test reaches, from the project's code index, for the
 * likely/possible split. Undefined when the project records no client code
 * reach, so every break keeps the confidence of its string's kind.
 */
async function loadReach(
  connection: PiwiConnection,
  projectId: number | null,
  branch: string | null,
): Promise<((testId: number, file: string) => boolean) | undefined> {
  if (projectId === null) return undefined;
  try {
    return reachOfIndex(await fetchCodeIndex(connection, projectId, branch));
  } catch {
    return undefined;
  }
}

// ── Edits ────────────────────────────────────────────────────────────────────

/** One call site of a broken chain and what preflight can do there. */
interface PreflightSite {
  /** The call site as the index holds it, relative to the test root. */
  callSite: string;
  /**
   * `edit`: the line holds the literal; `applied`: the line already holds the new one; `by-hand`: files holding
   * the literal instead; `elsewhere`: not in this checkout; `none`: no rewrite.
   */
  action: 'edit' | 'applied' | 'by-hand' | 'elsewhere' | 'none';
  edit?: { file: string; line: number; old: string; new: string };
  /** For `by-hand`: `file:line` of the test files that contain the old literal. */
  holders?: string[];
}

interface PreflightBreak {
  anchor: DiffAnchor;
  locator: string;
  confidence: LocatorBreak['confidence'];
  actions: string[];
  tests: Array<{ id: number; title: string; file: string }>;
  rewrite: string | null;
  sites: PreflightSite[];
}

function planSites(b: LocatorBreak, testRoot: string): PreflightSite[] {
  const sites = [...new Set(b.uses.flatMap((u) => u.callSites))];
  return sites.map((callSite): PreflightSite => {
    if (!b.rewrite || !b.replacements?.length) return { callSite, action: 'none' };
    const file = path.resolve(testRoot, callSiteFile(callSite));
    const lineNo = callSiteLine(callSite);
    const text = readText(file);
    if (text === undefined || lineNo === null) return { callSite, action: 'elsewhere' };
    const lines = text.split(/\r?\n/);
    const original = lines[lineNo - 1] ?? '';
    let current = original;
    for (const [before, after] of b.replacements) current = buildLiteralEdit(current, before, after)?.new ?? current;
    if (current !== original) {
      return { callSite, action: 'edit', edit: { file, line: lineNo, old: original, new: current } };
    }
    // The index keeps the old chain until the next run records the edited one.
    if (b.replacements.every(([before, after]) => buildLiteralEdit(original, after, before))) {
      return { callSite, action: 'applied' };
    }
    const holders = new Set<string>();
    for (const [before] of b.replacements) {
      for (const quote of ["'", '"', '`']) {
        const out = tryGit(testRoot, ['grep', '-n', '--fixed-strings', `${quote}${before}${quote}`]);
        for (const row of (out ?? '').split('\n')) {
          const m = /^(.+?):(\d+):/.exec(row);
          if (m) holders.add(`${m[1]}:${m[2]}`);
        }
      }
    }
    return { callSite, action: 'by-hand', holders: [...holders].sort() };
  });
}

/** Whether `--fix` applies a break's planned edits: only a `likely` break's, a `possible` one is a bare string that matched. */
function isFixable(b: PreflightBreak): boolean {
  return b.confidence === 'likely';
}

/**
 * Apply the planned edits of the `likely` breaks, line by line, re-reading each
 * line as edited so far. Returns the edited files.
 */
function applyEdits(breaks: PreflightBreak[], replacementsOf: Map<PreflightBreak, Array<[string, string]>>): string[] {
  const byFile = new Map<string, Array<{ line: number; replacements: Array<[string, string]> }>>();
  for (const b of breaks) {
    if (!isFixable(b)) continue;
    for (const site of b.sites) {
      if (site.action !== 'edit' || !site.edit) continue;
      const list = byFile.get(site.edit.file) ?? [];
      list.push({ line: site.edit.line, replacements: replacementsOf.get(b) ?? [] });
      byFile.set(site.edit.file, list);
    }
  }
  const edited: string[] = [];
  for (const [file, edits] of byFile) {
    const text = fs.readFileSync(file, 'utf-8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    for (const e of edits) {
      let line = lines[e.line - 1] ?? '';
      for (const [before, after] of e.replacements) line = buildLiteralEdit(line, before, after)?.new ?? line;
      lines[e.line - 1] = line;
    }
    const next = lines.join(eol);
    if (next !== text) {
      fs.writeFileSync(file, next);
      edited.push(file);
    }
  }
  return edited.sort();
}

// ── Output ───────────────────────────────────────────────────────────────────

interface PreflightResult {
  project: string;
  branch: string;
  base: string;
  index: { locators: number; tests: number; fromCache: string | null; truncated: boolean };
  anchors: number;
  breaks: PreflightBreak[];
  impact: { count: number; widened: boolean } | null;
  edited: string[];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function describeAnchor(a: DiffAnchor): string {
  const what = a.after !== undefined ? `"${a.before}" → "${a.after}"` : `"${a.before}" removed`;
  const extra = a.key ? ` (key ${a.key})` : a.attribute ? ` (${a.attribute})` : '';
  return `${what}${extra}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text}  ` : text + ' '.repeat(width - text.length);
}

/** The human-readable report. */
function renderPreflight(result: PreflightResult, cwdToRoot: (file: string) => string = (f) => f): string {
  const out: string[] = [];
  const cache = result.index.fromCache ? ` · cached ${result.index.fromCache}` : '';
  out.push(
    `piwi preflight · ${result.project} · ${result.branch} · ${plural(result.index.locators, 'locator')} from ${plural(result.index.tests, 'test')} · diff against ${result.base}${cache}`,
  );
  out.push('');
  const likely = result.breaks.filter((b) => b.confidence === 'likely');
  const possible = result.breaks.filter((b) => b.confidence === 'possible');
  if (!result.breaks.length) {
    out.push(`No break found in the ${plural(result.anchors, 'string')} this diff changes.`);
  }
  const listGroup = (list: PreflightBreak[], budget: number): number => {
    const byAnchor = new Map<DiffAnchor, PreflightBreak[]>();
    for (const b of list) byAnchor.set(b.anchor, [...(byAnchor.get(b.anchor) ?? []), b]);
    let shown = 0;
    for (const [anchor, group] of byAnchor) {
      if (shown >= budget) break;
      out.push(`  ${pad(`${anchor.file}:${anchor.line}`, 38)} ${describeAnchor(anchor)}`);
      for (const b of group) {
        if (shown >= budget) break;
        shown++;
        const meta = `${b.actions.slice(0, 3).join(', ') || 'used'} · ${plural(b.tests.length, 'test')} · ${b.confidence}`;
        out.push(`    ${pad(b.locator, 48)} ${meta}`);
        for (const site of b.sites.slice(0, 5)) {
          const where = pad(cwdToRoot(site.callSite.replace(/:\d+$/, '')), 34);
          if (site.action === 'edit') out.push(`      ${where} → ${b.rewrite}`);
          else if (site.action === 'applied') out.push(`      ${where} already rewritten`);
          else if (site.action === 'none') {
            out.push(
              `      ${where} ${b.anchor.after === undefined ? 'no replacement: the string is gone' : 'no rewrite: the locator uses a pattern'}`,
            );
          } else if (site.action === 'elsewhere')
            out.push(`      ${where} not in this checkout; rewrite: ${b.rewrite}`);
          else {
            out.push(`      ${where} edit by hand, the string is not on this line: ${b.rewrite}`);
            for (const h of site.holders?.slice(0, 3) ?? []) out.push(`        holds it: ${h}`);
          }
        }
        if (b.sites.length > 5) out.push(`      … ${plural(b.sites.length - 5, 'more call site')}`);
      }
    }
    return shown;
  };
  if (likely.length) {
    out.push(`${plural(new Set(likely.map((b) => b.locator)).size, 'locator')} this change breaks`);
    const shown = listGroup(likely, MAX_LISTED);
    if (likely.length > shown) out.push(`  … ${plural(likely.length - shown, 'more break')} (--json lists every one)`);
  }
  if (possible.length) {
    if (likely.length) out.push('');
    out.push(`${plural(new Set(possible.map((b) => b.locator)).size, 'locator')} it may break (a bare string matched)`);
    for (const b of possible.slice(0, Math.max(0, MAX_LISTED - likely.length))) {
      out.push(
        `  ${pad(b.locator, 48)} ${plural(b.tests.length, 'test')} · ${b.anchor.file}:${b.anchor.line} ${describeAnchor(b.anchor)}`,
      );
      if (b.rewrite) out.push(`    if it does, edit by hand: ${b.rewrite}`);
    }
    const listed = Math.max(0, MAX_LISTED - likely.length);
    if (possible.length > listed) out.push(`  … ${plural(possible.length - listed, 'more')} (--json lists every one)`);
  }
  if (result.index.truncated)
    out.push('', 'The locator index is truncated: the project has more chains than it serves.');
  out.push('');
  if (result.impact) {
    out.push(
      result.impact.widened
        ? 'The changed files reach tests the dashboard cannot narrow down: the whole suite · run it: npx @piwitests/reporter preflight --run'
        : `${plural(result.impact.count, 'test')} reach the changed files · run them: npx @piwitests/reporter preflight --run`,
    );
  }
  const fixable = result.breaks
    .filter(isFixable)
    .reduce((n, b) => n + b.sites.filter((s) => s.action === 'edit').length, 0);
  if (result.edited.length)
    out.push(`Edited ${plural(result.edited.length, 'file')}:`, ...result.edited.map((f) => `  ${cwdToRoot(f)}`));
  else if (fixable) out.push(`Apply the ${plural(fixable, 'rewrite')}: npx @piwitests/reporter preflight --fix`);
  return out.join('\n').replace(/\n+$/, '');
}

// ── The command ──────────────────────────────────────────────────────────────

export async function runPreflight(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }
  let args: PreflightArgs;
  try {
    args = parsePreflightArgs(argv);
  } catch (e) {
    console.error(`piwi preflight: ${(e as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  const repoRoot = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!repoRoot) {
    console.error('piwi preflight: not inside a git repository');
    return EXIT_ERROR;
  }
  const testRoot = path.resolve(cwd, args.testRoot ?? findPlaywrightRoot(cwd) ?? cwd);

  let files: DiffFile[];
  try {
    files = parseUnifiedDiff(
      git(repoRoot, ['diff', '--full-index', '--unified=0', '--no-color', '--no-ext-diff', args.base, '--']),
    );
  } catch (e) {
    console.error(`piwi preflight: could not diff against ${args.base} — ${(e as Error).message.split('\n')[0]}`);
    return EXIT_ERROR;
  }

  const connection = resolveConnection(args, env, [...new Set([testRoot, cwd, repoRoot])]);
  if (!connection) {
    console.error('piwi preflight: no dashboard URL — pass --server-url, set PIWI_DASHBOARD_URL, or run piwi init');
    return EXIT_ERROR;
  }

  // The index: fetched, else the last good copy.
  const key = cacheKey(connection, args.branch);
  let index: LocatorIndex;
  let fromCache: string | null = null;
  let projectId: number | null = null;
  try {
    projectId = await resolveProjectId({ ...connection, key: '' });
    index = await fetchLocatorIndex(connection, projectId, args.branch);
    writeCache(testRoot, key, index);
  } catch (e) {
    const cached = readCache(testRoot, key);
    if (!cached) {
      console.error(`piwi preflight: ${(e as Error).message}, and there is no cached index`);
      return EXIT_ERROR;
    }
    console.error(
      `piwi preflight: dashboard unreachable, using the index cached ${cached.savedAt} — ${(e as Error).message}`,
    );
    index = cached.index;
    fromCache = cached.savedAt;
  }

  const anchors = extractDiffAnchors(files, {
    testIdAttributes: index.testIdAttributes ?? undefined,
    isTestFile: (file) => TEST_FILE.test(file),
    translations: translationLookup(repoRoot, args.base, args.locale),
    readFile: (file, side) =>
      side === 'new' ? readText(path.join(repoRoot, file)) : tryGit(repoRoot, ['show', `${args.base}:${file}`]),
  });
  const found = predictLocatorBreaks(anchors, index, { reach: await loadReach(connection, projectId, args.branch) });
  const replacementsOf = new Map<PreflightBreak, Array<[string, string]>>();
  const breaks = found.map((b): PreflightBreak => {
    const pb: PreflightBreak = {
      anchor: b.anchor,
      locator: b.locator,
      confidence: b.confidence,
      actions: [...new Set(b.uses.flatMap((u) => u.actions))],
      tests: b.tests.map((t) => ({ id: t.id, title: t.title, file: t.file })),
      rewrite: b.rewrite ?? null,
      sites: planSites(b, testRoot),
    };
    replacementsOf.set(pb, b.replacements ?? []);
    return pb;
  });

  // The tests that reach the changed files, with the specs of the broken locators when running them.
  let impact: ImpactResolution | null = null;
  const { changedFiles: changed, changes } = diffImpactInput(files);
  const breakSpecs = [...new Set(breaks.flatMap((b) => b.tests.map((t) => t.file)))];
  if (projectId !== null && (changed.length || (args.run && breakSpecs.length))) {
    try {
      impact = await fetchImpact(
        { ...connection, key: 'impact', format: 'args', pkgRunner: args.pkgRunner },
        projectId,
        args.run ? [...new Set([...changed, ...breakSpecs])] : changed,
        changes,
      );
    } catch (e) {
      console.error(`piwi preflight: could not ask which tests reach the changed files — ${(e as Error).message}`);
    }
  }

  const edited = args.fix ? applyEdits(breaks, replacementsOf) : [];
  const result: PreflightResult = {
    project: index.projectName,
    branch: index.branch ?? index.defaultBranch,
    base: args.base,
    index: { locators: index.locators.length, tests: index.tests.length, fromCache, truncated: index.truncated },
    anchors: anchors.length,
    breaks,
    impact: impact ? { count: impact.estimate.count, widened: impact.impact.widened } : null,
    edited,
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const rel = (file: string) => {
      const abs = path.isAbsolute(file) ? file : path.resolve(testRoot, file);
      const r = path.relative(cwd, abs).split(path.sep).join('/');
      return r.startsWith('..') ? file : r || file;
    };
    console.log(renderPreflight(result, rel));
  }

  let code = EXIT_OK;
  const editedSet = new Set(edited);
  const fixed = (s: PreflightSite) =>
    s.action === 'applied' || (s.action === 'edit' && !!s.edit && editedSet.has(s.edit.file));
  const unfixed = breaks.some((b) => b.confidence === 'likely' && !(b.sites.length && b.sites.every(fixed)));
  if (args.strict && unfixed) code = EXIT_BREAKS;

  if (args.run) {
    if (!impact) {
      console.error('piwi preflight: nothing to run — the dashboard did not say which tests reach this change');
      return code;
    }
    const runArgs = impact.impact.widened ? [] : impact.materialization.args;
    if (!impact.impact.widened && impact.estimate.count === 0) {
      console.error('piwi preflight: no test reaches this change — nothing to run');
      return code;
    }
    const runCode = await spawnPlaywrightForRun(args.pkgRunner, [...runArgs, ...args.extra], {
      ...env,
      ...originEnv('preflight'),
    });
    if (runCode !== 0) code = EXIT_BREAKS;
  }
  return code;
}
