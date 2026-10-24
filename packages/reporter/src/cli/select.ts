/**
 * `piwi select` / `piwi run` — turn a saved selection into the tests to run.
 *
 * `select` resolves a selection against the dashboard and prints the Playwright
 * arguments (the composable, two-step CI form). `run` resolves and then spawns
 * `playwright test` with those arguments, stamping the run so the dashboard can
 * name the subset and a gate can re-resolve the same definition.
 *
 * A reporting problem must never break the test run: when the dashboard is
 * unreachable, `run` falls back to the full suite (with a warning) and reuses
 * the last good resolution from `.piwi/selection-cache.json` when it has one.
 * `--strict` inverts that for CI, where an unresolvable selection should stop
 * the pipeline. Resolving to zero tests is always an error — a smoke job that
 * silently runs nothing is worse than one that fails loudly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  fetchImpact,
  fetchResolution,
  resolveProjectId,
  type ImpactResolution,
  type SelectionResolution,
} from '../internal/support/selection-client.js';
import { PIWI_SHARD_ENV } from '../internal/config/env.js';
import { parseUnifiedDiff } from '@piwitests/core/diff-anchors';
import { diffImpactInput, type BaseLineChange } from '@piwitests/core/suspect-lines';
import { computeAddReporterArgs } from './add-reporter.js';
import { spawnPlaywright } from '../internal/support/playwright-spawn.js';

const EXIT_OK = 0;
const EXIT_ERROR = 2;

type Resolution = SelectionResolution;

const USAGE = `
piwi select / piwi run — run a saved selection of tests

Usage:
  npx @piwitests/reporter select <key> [options]     print the Playwright args
  npx @piwitests/reporter run <key> [options] [-- <playwright args>]
  npx @piwitests/reporter run impact --base <ref>    run the tests your diff impacts

Connection:
  --server-url <url>    Dashboard URL         (env PIWI_DASHBOARD_URL)
  --api-key <key>       API key               (env PIWI_API_KEY)
  --project <name|id>   Project               (env PIWI_PROJECT_NAME)

Selection:
  --format <fmt>        args (file:line, default) | grep | files | json
  --budget <duration>   Cap total time, e.g. 5m, 90s, 300000 (ms)
  --shard <i/n>         Keep only shard i of n, balanced by duration, lock-aware
  --fail-fast           Order the least-reliable tests first (fail-fast)
  --base <ref>          For "impact": the ref to diff the working tree against

Behavior:
  --strict              Fail (exit 2) instead of falling back when unreachable
  --pkg-runner <cmd>    Package runner for the printed command (default npx)
  --json                Print the full resolution as JSON (select only)
  -h, --help            Show this help

Exit codes: 0 ok, 1 the test run failed (run only), 2 could not resolve.
`.trim();

interface SelectArgs {
  serverUrl: string;
  apiKey: string | null;
  project: string;
  key: string;
  format: string;
  budgetMs: number | null;
  shard: string | null;
  /** Rank order to emit tests in (fail-fast) — set by --fail-fast. */
  order: string | null;
  /** Base ref for `impact` — the diff is computed against it. */
  base: string | null;
  strict: boolean;
  pkgRunner: string;
  json: boolean;
  extra: string[];
}

/** The reserved key that resolves the working-tree diff's impact, not a saved selection. */
const IMPACT_KEY = 'impact';

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set([
  '--server-url',
  '--api-key',
  '--project',
  '--format',
  '--budget',
  '--shard',
  '--base',
  '--pkg-runner',
]);

/** Read `--flag value` / `--flag=value`, or undefined when absent. */
function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

/** The first positional argument (the selection key), skipping value-flag values. */
function findKey(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('-')) {
      if (!tok.includes('=') && VALUE_FLAGS.has(tok)) i++;
      continue;
    }
    return tok;
  }
  return undefined;
}

/** Parse a duration like `5m`, `90s`, `1h`, or a plain millisecond count. */
export function parseDuration(raw: string): number | null {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  const ms = Math.round(value * factor);
  return ms > 0 ? ms : null;
}

export function parseSelectArgs(argv: string[], env: NodeJS.ProcessEnv): SelectArgs {
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  const extra = dashIndex === -1 ? [] : argv.slice(dashIndex + 1);

  const serverUrl = (readOption(own, '--server-url') ?? env.PIWI_DASHBOARD_URL ?? '').replace(/\/$/, '');
  if (!serverUrl) throw new Error('No dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL');

  const key = findKey(own);
  if (!key) throw new Error('No selection key — usage: piwi select <key>');

  const budgetRaw = readOption(own, '--budget');
  let budgetMs: number | null = null;
  if (budgetRaw !== undefined) {
    budgetMs = parseDuration(budgetRaw);
    if (budgetMs === null) throw new Error(`--budget expects a duration like 5m or 90s, got "${budgetRaw}"`);
  }

  const shard = readOption(own, '--shard') ?? null;
  if (shard !== null && !/^\d+\s*\/\s*\d+$/.test(shard)) {
    throw new Error(`--shard expects an "i/n" spec like 2/4, got "${shard}"`);
  }

  return {
    serverUrl,
    apiKey: readOption(own, '--api-key') ?? env.PIWI_API_KEY ?? null,
    project: readOption(own, '--project') ?? env.PIWI_PROJECT_NAME ?? '',
    key,
    format: readOption(own, '--format') ?? 'args',
    budgetMs,
    shard,
    order: own.includes('--fail-fast') ? 'failureLikelihood' : null,
    base: readOption(own, '--base') ?? null,
    strict: own.includes('--strict'),
    pkgRunner: readOption(own, '--pkg-runner') ?? 'npx',
    json: own.includes('--json'),
    extra,
  };
}

// ── Offline cache ────────────────────────────────────────────────────────────

const CACHE_FILE = path.join('.piwi', 'selection-cache.json');

/**
 * The entry key: the project exactly as `--project` names it (lower-cased, since
 * the dashboard matches names that way), so a project given by name is found
 * without asking the dashboard for its id. An id and a name are separate entries.
 */
function cacheKey(args: SelectArgs): string {
  return `${args.project.toLowerCase()}:${args.key}:${args.format}:${args.budgetMs ?? 0}:${args.shard ?? ''}:${args.order ?? ''}`;
}

function readCache(args: SelectArgs): Resolution | null {
  try {
    const store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, Resolution>;
    return store[cacheKey(args)] ?? null;
  } catch {
    return null;
  }
}

function writeCache(args: SelectArgs, resolution: Resolution): void {
  try {
    let store: Record<string, Resolution> = {};
    try {
      store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, Resolution>;
    } catch {
      // No cache yet — start fresh.
    }
    store[cacheKey(args)] = resolution;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2));
  } catch {
    // A cache write failure must never break the command.
  }
}

type CachedResolution = { resolution: Resolution; fromCache: boolean } | { error: Error };

/**
 * Resolve the project and the selection from the dashboard, then from the cache;
 * `error` is why the dashboard could not answer when the cache had nothing either.
 */
async function resolveWithCache(args: SelectArgs): Promise<CachedResolution> {
  try {
    const projectId = await resolveProjectId(args);
    const resolution = await fetchResolution(args, projectId);
    writeCache(args, resolution);
    return { resolution, fromCache: false };
  } catch (e) {
    if (args.strict) throw e;
    const cached = readCache(args);
    if (cached) {
      console.error(`piwi: dashboard unreachable, using cached resolution — ${(e as Error).message}`);
      return { resolution: cached, fromCache: true };
    }
    return { error: e as Error };
  }
}

function printWarnings(resolution: Resolution): void {
  for (const w of resolution.warnings) console.error(`piwi: warning [${w.code}] ${w.message}`);
}

// ── impact-from-diff ───────────────────────────────────────────────────────────

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The change between `base` and the working tree (committed + uncommitted):
 * every file it touches, and the changed base lines of the modified files, which
 * let the dashboard keep only the tests that ran them. The file list stands on
 * its own when the full diff cannot be read.
 */
function gitChange(base: string): { changedFiles: string[]; changes: BaseLineChange[] } {
  const names = git(['diff', '--name-only', base])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  let fromDiff: { changedFiles: string[]; changes: BaseLineChange[] } = { changedFiles: [], changes: [] };
  try {
    fromDiff = diffImpactInput(
      parseUnifiedDiff(git(['diff', '--full-index', '--unified=0', '--no-color', '--no-ext-diff', base, '--'])),
    );
  } catch {
    // Without the full diff, the changed files are mapped at file level.
  }
  return { changedFiles: [...new Set([...names, ...fromDiff.changedFiles])], changes: fromDiff.changes };
}

/** Compute the working-tree diff and ask the dashboard which tests it impacts. */
async function loadImpact(args: SelectArgs, projectId: number): Promise<ImpactResolution> {
  const { changedFiles, changes } = gitChange(args.base!);
  return fetchImpact(args, projectId, changedFiles, changes);
}

/** How many changed files the impact narrowed to the tests that ran their changed lines, as a suffix. */
function lineLevelNote(impact: ImpactResolution): string {
  const files = impact.impact.lineLevelFiles ?? 0;
  return files > 0 ? `, ${files} file(s) narrowed by line coverage` : '';
}

// ── select ───────────────────────────────────────────────────────────────────

async function runSelectImpact(args: SelectArgs): Promise<number> {
  let impact: ImpactResolution;
  try {
    const projectId = await resolveProjectId(args);
    impact = await loadImpact(args, projectId);
  } catch (e) {
    console.error(`piwi select: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  printWarnings(impact);
  console.error(
    `piwi select: ${impact.impact.changedFiles} changed file(s) → ${impact.estimate.count} impacted test(s)${impact.impact.widened ? ' (widened to full suite)' : lineLevelNote(impact)}`,
  );
  if (args.json) {
    console.log(JSON.stringify(impact, null, 2));
    return EXIT_OK;
  }
  // Widened = run everything, which is the empty (no-filter) arg list.
  console.log(impact.impact.widened ? '' : impact.materialization.args.join(' '));
  return EXIT_OK;
}

export async function runSelect(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  let args: SelectArgs;
  try {
    args = parseSelectArgs(argv, env);
  } catch (e) {
    console.error(`piwi select: ${(e as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  if (args.key === IMPACT_KEY) {
    if (!args.base) {
      console.error('piwi select: impact needs a base ref — pass --base <ref> (e.g. --base origin/main)');
      return EXIT_ERROR;
    }
    return runSelectImpact(args);
  }

  let resolution: Resolution;
  try {
    const projectId = await resolveProjectId(args);
    resolution = await fetchResolution(args, projectId);
  } catch (e) {
    console.error(`piwi select: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  printWarnings(resolution);
  if (resolution.estimate.count === 0) {
    console.error(`piwi select: "${args.key}" resolved to 0 tests`);
    return EXIT_ERROR;
  }

  if (args.json) console.log(JSON.stringify(resolution, null, 2));
  else console.log(resolution.materialization.args.join(' '));
  return EXIT_OK;
}

// ── run ──────────────────────────────────────────────────────────────────────

/**
 * Spawn Playwright for `run`, prepending `--add-reporter @piwitests/reporter`
 * when the target config has no Piwi reporter and the installed Playwright is
 * 1.63 or later. Logs one line naming what was added, or why it was not.
 */
export function spawnPlaywrightForRun(
  pkgRunner: string,
  playwrightArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const decision = computeAddReporterArgs(process.cwd(), playwrightArgs);
  if (decision.log) console.error(decision.log);
  return spawnPlaywright([...decision.args, ...playwrightArgs], env, { runner: pkgRunner, command: 'piwi run' });
}

/** The shard the resolved tests belong to, for the reporter to report — none when the run is not sharded. */
function shardEnv(args: SelectArgs): NodeJS.ProcessEnv {
  return args.shard ? { [PIWI_SHARD_ENV]: args.shard } : {};
}

async function runRunImpact(args: SelectArgs, env: NodeJS.ProcessEnv): Promise<number> {
  let projectId: number;
  try {
    projectId = await resolveProjectId(args);
  } catch (e) {
    if (args.strict) {
      console.error(`piwi run: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
    console.error(`piwi run: ${(e as Error).message} — running the full suite`);
    return spawnPlaywrightForRun(args.pkgRunner, args.extra, env);
  }

  let impact: ImpactResolution;
  try {
    impact = await loadImpact(args, projectId);
  } catch (e) {
    if (args.strict) {
      console.error(`piwi run: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
    console.error(`piwi run: ${(e as Error).message} — running the full suite`);
    return spawnPlaywrightForRun(args.pkgRunner, args.extra, env);
  }

  printWarnings(impact);
  if (impact.impact.widened) {
    console.error(
      `piwi run: impact widened to the full suite (${impact.impact.unmappedSourceFiles.length} changed file(s) not fully mapped to tests)`,
    );
    return spawnPlaywrightForRun(args.pkgRunner, args.extra, env);
  }
  if (impact.estimate.count === 0) {
    console.error(`piwi run: no tests impacted by ${impact.impact.changedFiles} changed file(s) — nothing to run`);
    return EXIT_OK;
  }
  const runEnv: NodeJS.ProcessEnv = {
    ...env,
    PIWI_SELECTION: IMPACT_KEY,
    PIWI_SELECTION_VERSION: '0',
    PIWI_SELECTION_HASH: impact.resolvedHash,
    PIWI_SELECTION_COUNT: String(impact.estimate.count),
    ...shardEnv(args),
  };
  console.error(`piwi run: impact → ${impact.estimate.count} test(s)${lineLevelNote(impact)}`);
  return spawnPlaywrightForRun(args.pkgRunner, [...impact.materialization.args, ...args.extra], runEnv);
}

export async function runRun(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  let args: SelectArgs;
  try {
    args = parseSelectArgs(argv, env);
  } catch (e) {
    console.error(`piwi run: ${(e as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }
  if (args.format === 'json') {
    console.error('piwi run: --format json cannot be run; use args, grep or files');
    return EXIT_ERROR;
  }

  if (args.key === IMPACT_KEY) {
    if (!args.base) {
      console.error('piwi run: impact needs a base ref — pass --base <ref> (e.g. --base origin/main)');
      return EXIT_ERROR;
    }
    return runRunImpact(args, env);
  }

  let outcome: CachedResolution;
  try {
    outcome = await resolveWithCache(args);
  } catch (e) {
    console.error(`piwi run: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  if ('error' in outcome) {
    console.error(`piwi run: ${outcome.error.message} — no cached resolution, running the full suite`);
    return spawnPlaywrightForRun(args.pkgRunner, args.extra, env);
  }

  const { resolution } = outcome;
  printWarnings(resolution);
  if (resolution.estimate.count === 0) {
    console.error(`piwi run: "${args.key}" resolved to 0 tests`);
    return EXIT_ERROR;
  }

  const runEnv: NodeJS.ProcessEnv = {
    ...env,
    PIWI_SELECTION: resolution.key ?? args.key,
    PIWI_SELECTION_VERSION: String(resolution.version ?? 0),
    PIWI_SELECTION_HASH: resolution.resolvedHash,
    PIWI_SELECTION_COUNT: String(resolution.estimate.count),
    ...shardEnv(args),
  };
  console.error(
    `piwi run: ${args.key} → ${resolution.estimate.count} tests${resolution.materialization.format !== args.format ? ` (materialized as ${resolution.materialization.format})` : ''}`,
  );
  return spawnPlaywrightForRun(args.pkgRunner, [...resolution.materialization.args, ...args.extra], runEnv);
}
