/**
 * `piwi plan` and `piwi run --reuse` / `--plan`: pass reuse, experimental.
 *
 * `plan` asks the dashboard which tests of a selection have a pass whose code
 * may not have changed, diffs the working tree against each of those passes'
 * commits (fetching a commit a shallow clone lacks), and stores the plan: the
 * tests to run and the tests reused. It prints the plan's id, which every shard
 * of a CI matrix then runs with `piwi run --plan <id> --shard i/n`.
 *
 * As `piwi run` does, a planning problem never breaks the test run: when the
 * dashboard cannot plan, the run executes every test it would have without
 * reuse. `--strict` makes it exit 2 instead.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createPlan,
  fetchPlan,
  fetchPlanSources,
  resolveProjectId,
  type CreatedPlan,
  type PlanDiff,
  type PlanReason,
} from '../internal/support/selection-client.js';
import { privateTempDir, writePrivateFile } from '../internal/support/private-file.js';
import { PIWI_PLAN_ENV } from '../internal/config/env.js';
import { resolveCliConnection } from '../internal/support/connection.js';
import { readInstalledPlaywrightVersion } from './add-reporter.js';
import { findKey, git, gitChange, readOption, runRun, spawnPlaywrightForRun } from './select.js';

const EXIT_OK = 0;
const EXIT_ERROR = 2;
/** How long fetching one source commit into a shallow clone may take. */
const FETCH_TIMEOUT_MS = 120_000;
/** Changed files one diff may carry, as the dashboard takes them; a larger diff is not sent and its tests run. */
const MAX_CHANGED_FILES = 5000;

const USAGE = `
piwi plan — plan a run that reuses the passes whose code has not changed (experimental)

Usage:
  npx @piwitests/reporter plan <key> [options]       print the plan's id
  npx @piwitests/reporter run --plan <id> [--shard <i/n>]   run its tests

<key> is a saved or built-in selection, or "full" for the whole suite. The
dashboard finds each test's newest pass from a clean checkout; this command
diffs the working tree against those passes' commits, and the dashboard reuses
a test whose code the change does not reach. Needs the pass reuse capability.

Connection:
  --server-url <url>    Dashboard URL         (env PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>       API key               (env PIWI_API_KEY, .env)
  --project <name|id>   Project               (env PIWI_PROJECT_NAME, .env)

Behavior:
  --json                Print the plan as JSON instead of its id
  -h, --help            Show this help

Exit codes: 0 planned, 2 could not plan.
`.trim();

interface PlanArgs {
  serverUrl: string;
  apiKey: string | null;
  project: string;
  key: string | null;
  planId: number | null;
  reuse: boolean;
  shard: string | null;
  strict: boolean;
  json: boolean;
  pkgRunner: string;
  extra: string[];
}

const REASON_LABELS: Record<Exclude<PlanReason, 'reused'>, string> = {
  changed: 'changed',
  widened: 'unmapped change',
  'no-source': 'no reusable pass',
  'commit-unavailable': 'commit not readable',
  flaky: 'flaky',
  'open-cluster': 'open failure',
  quarantined: 'quarantined',
  'no-reuse-tag': '@no-reuse',
  serial: 'serial group',
};

function parsePlanArgs(argv: string[], env: NodeJS.ProcessEnv, command: string): PlanArgs {
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  const connection = resolveCliConnection(
    {
      serverUrl: readOption(own, '--server-url'),
      apiKey: readOption(own, '--api-key'),
      project: readOption(own, '--project'),
    },
    env,
    [process.cwd()],
    command,
  );
  if (!connection)
    throw new Error('No dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL (environment or .env)');
  const planRaw = readOption(own, '--plan');
  const planGiven = own.some((arg) => arg === '--plan' || arg.startsWith('--plan='));
  if (planGiven && (planRaw === undefined || !/^\d+$/.test(planRaw))) {
    throw new Error(`--plan expects a plan id, got "${planRaw ?? ''}"`);
  }
  const shard = readOption(own, '--shard') ?? null;
  if (shard !== null && !/^\d+\s*\/\s*\d+$/.test(shard)) {
    throw new Error(`--shard expects an "i/n" spec like 2/4, got "${shard}"`);
  }
  return {
    serverUrl: connection.serverUrl,
    apiKey: connection.apiKey,
    project: connection.project,
    key: findKey(own) ?? null,
    planId: planRaw === undefined ? null : Number(planRaw),
    reuse: own.includes('--reuse'),
    shard,
    strict: own.includes('--strict'),
    json: own.includes('--json'),
    pkgRunner: readOption(own, '--pkg-runner') ?? 'npx',
    extra: dashIndex === -1 ? [] : argv.slice(dashIndex + 1),
  };
}

/** The project's id, from its name or id. */
function projectIdOf(args: PlanArgs): Promise<number> {
  return resolveProjectId({ serverUrl: args.serverUrl, apiKey: args.apiKey, project: args.project, key: '' });
}

function tryGit(args: string[]): string | null {
  try {
    return git(args).trim() || null;
  } catch {
    return null;
  }
}

/** Whether a commit is in the local repository, fetching it from `origin` when a shallow clone lacks it. */
function ensureCommit(commit: string): boolean {
  if (commitExists(commit)) return true;
  try {
    execFileSync('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: FETCH_TIMEOUT_MS,
    });
  } catch {
    return false;
  }
  return commitExists(commit);
}

/** Whether the working tree matches its commit, untracked files counted; null outside a git checkout. */
function worktreeState(): 'clean' | 'dirty' | null {
  try {
    return git(['status', '--porcelain', '--untracked-files=normal']).trim() === '' ? 'clean' : 'dirty';
  } catch {
    return null;
  }
}

function commitExists(commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The reasons tests run, as one line: `12 changed, 3 flaky`. */
export function formatPlanReasons(reasons: Partial<Record<PlanReason, number>>): string {
  return (Object.keys(REASON_LABELS) as Array<keyof typeof REASON_LABELS>)
    .filter((reason) => (reasons[reason] ?? 0) > 0)
    .map((reason) => `${reasons[reason]} ${REASON_LABELS[reason]}`)
    .join(', ');
}

/** Find the passes to reuse, diff against their commits, and store the plan. */
async function makePlan(args: PlanArgs, projectId: number, key: string): Promise<CreatedPlan> {
  const playwrightVersion = readInstalledPlaywrightVersion(process.cwd());
  const sources = await fetchPlanSources(args, projectId, key, playwrightVersion);
  // Files git does not track yet are part of the change: a diff against a commit never names them.
  const untracked = (tryGit(['ls-files', '--others', '--exclude-standard', '--full-name', '--', ':/']) ?? '')
    .split('\n')
    .filter(Boolean);
  const diffs: PlanDiff[] = [];
  for (const { commit } of sources.commits) {
    if (!ensureCommit(commit)) {
      console.error(`piwi plan: commit ${commit.slice(0, 12)} is not readable here; its tests will run`);
      continue;
    }
    try {
      const change = gitChange(commit);
      const changedFiles = [...new Set([...change.changedFiles, ...untracked])];
      if (changedFiles.length > MAX_CHANGED_FILES) {
        console.error(
          `piwi plan: ${changedFiles.length} files changed since ${commit.slice(0, 12)}; its tests will run`,
        );
        continue;
      }
      diffs.push({ commit, changedFiles, changes: change.changes });
    } catch (e) {
      console.error(
        `piwi plan: could not diff against ${commit.slice(0, 12)} (${(e as Error).message}); its tests will run`,
      );
    }
  }
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return createPlan(args, projectId, {
    selection: key,
    playwrightVersion,
    commit: tryGit(['rev-parse', 'HEAD']),
    branch: branch && branch !== 'HEAD' ? branch : null,
    worktree: worktreeState(),
    diffs,
  });
}

function describePlan(plan: CreatedPlan): string {
  const reasons = formatPlanReasons(plan.reasons);
  return `${plan.selection.key} → ${plan.counts.run} to run, ${plan.counts.reused} reused of ${plan.counts.candidates} (plan ${plan.id})${reasons ? ` — run: ${reasons}` : ''}`;
}

export async function runPlanCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }
  let args: PlanArgs;
  try {
    args = parsePlanArgs(argv, env, 'piwi plan');
    if (!args.key) throw new Error('No selection key — usage: piwi plan <key> ("full" for the whole suite)');
  } catch (e) {
    console.error(`piwi plan: ${(e as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }
  try {
    const projectId = await projectIdOf(args);
    const plan = await makePlan(args, projectId, args.key!);
    console.error(`piwi plan: ${describePlan(plan)}`);
    console.log(args.json ? JSON.stringify(plan, null, 2) : String(plan.id));
    return EXIT_OK;
  } catch (e) {
    console.error(`piwi plan: ${(e as Error).message}`);
    return EXIT_ERROR;
  }
}

/** Whether `piwi run` was asked for pass reuse. */
export function isPlannedRun(argv: string[]): boolean {
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  return own.includes('--reuse') || own.some((arg) => arg === '--plan' || arg.startsWith('--plan='));
}

/** `argv` without `--reuse`, for the run a failed plan falls back to. */
function withoutReuse(argv: string[]): string[] {
  const dashIndex = argv.indexOf('--');
  const own = dashIndex === -1 ? argv : argv.slice(0, dashIndex);
  return [...own.filter((arg) => arg !== '--reuse'), ...(dashIndex === -1 ? [] : argv.slice(dashIndex))];
}

/**
 * Run a plan: its selection, less the tests it reuses, through Playwright's
 * `--test-list-invert`, sharded by Playwright's own `--shard` so every shard
 * filters the same list. A plan read by another job than the one that made it
 * is used only when both checkouts are clean at one commit, since it skips
 * tests on the diff of the tree it was made in: otherwise this throws, and the
 * caller falls back.
 */
async function runStoredPlan(
  args: PlanArgs,
  projectId: number,
  planId: number,
  env: NodeJS.ProcessEnv,
  madeHere: boolean,
) {
  const plan = await fetchPlan(args, projectId, planId);
  if (!madeHere) {
    const head = tryGit(['rev-parse', 'HEAD']);
    if (!plan.commit || plan.commit !== head) {
      throw new Error(
        `plan ${planId} was made at ${plan.commit?.slice(0, 12) ?? 'no commit'}, this checkout is at ${head?.slice(0, 12) ?? 'no commit'}`,
      );
    }
    if (plan.worktree !== 'clean' || worktreeState() !== 'clean') {
      throw new Error(`plan ${planId} and this checkout must both match their commit to skip tests in another job`);
    }
  }
  const shardArgs = args.shard ? [`--shard=${args.shard.replace(/\s+/g, '')}`] : [];
  console.error(
    `piwi run: plan ${planId}${args.shard ? ` (shard ${args.shard})` : ''} → ${plan.selection.key}, skipping ${plan.counts.reused} reused test(s)`,
  );
  // The reporter records the plan, and the dashboard the tests it skipped as the run's reused results.
  const planEnv: NodeJS.ProcessEnv = { ...env, [PIWI_PLAN_ENV]: String(planId) };
  if (plan.skip.length === 0) {
    return spawnPlaywrightForRun(args.pkgRunner, [...plan.args, ...shardArgs, ...args.extra], planEnv);
  }
  const dir = fs.mkdtempSync(path.join(privateTempDir(), 'plan-'));
  const list = path.join(dir, 'skip.txt');
  try {
    writePrivateFile(list, `${plan.skip.join('\n')}\n`);
    return await spawnPlaywrightForRun(
      args.pkgRunner,
      [...plan.args, '--test-list-invert', list, ...shardArgs, ...args.extra],
      planEnv,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPlannedRun(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: PlanArgs;
  try {
    args = parsePlanArgs(argv, env, 'piwi run');
    if (args.planId !== null && args.reuse) throw new Error('--plan runs a stored plan; drop --reuse');
    if (args.planId === null && !args.key) {
      throw new Error('--reuse needs a selection key ("full" for the whole suite)');
    }
    if (args.key === 'impact') throw new Error('--reuse plans a selection; impact already runs only what changed');
    if (args.reuse && args.shard) {
      throw new Error('--reuse plans once per job; in a sharded job, run piwi plan once and pass --plan to each shard');
    }
  } catch (e) {
    console.error(`piwi run: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  let projectId: number;
  let planId: number;
  try {
    projectId = await projectIdOf(args);
    if (args.planId !== null) planId = args.planId;
    else {
      const plan = await makePlan(args, projectId, args.key!);
      console.error(`piwi run: ${describePlan(plan)}`);
      planId = plan.id;
    }
  } catch (e) {
    if (args.strict) {
      console.error(`piwi run: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
    return fallBack(args, argv, env, (e as Error).message);
  }

  try {
    return await runStoredPlan(args, projectId, planId, env, args.planId === null);
  } catch (e) {
    if (args.strict) {
      console.error(`piwi run: ${(e as Error).message}`);
      return EXIT_ERROR;
    }
    return fallBack(args, argv, env, (e as Error).message);
  }
}

/**
 * The run when no plan can be used: the selection without reuse for `--reuse`,
 * else the whole suite. A shard of a matrix runs the whole suite, not a
 * Playwright shard of it: the other shards may be filtering the plan, whose
 * shards do not line up with the unfiltered suite's.
 */
function fallBack(args: PlanArgs, argv: string[], env: NodeJS.ProcessEnv, reason: string): Promise<number> {
  if (args.reuse && args.key && args.key !== 'full') {
    console.error(`piwi run: ${reason} — running "${args.key}" without reuse`);
    return runRun(withoutReuse(argv), env);
  }
  console.error(
    `piwi run: ${reason} — running the full suite${args.shard ? ` (all of it, not shard ${args.shard})` : ''}`,
  );
  return spawnPlaywrightForRun(args.pkgRunner, args.extra, env);
}
