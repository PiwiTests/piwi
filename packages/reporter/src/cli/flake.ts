/**
 * `piwi flake` — make a flaky test fail on demand, then prove the fix.
 *
 * Fetches the test's experiment plan from the dashboard (a control arm and one
 * arm per suspect of its flake profile), runs each arm as `playwright test`
 * with retries off and the capture fixtures in flake mode, counts only the
 * failures whose error signature matches the test's failures in history, and
 * prints each arm against the control with its verdict. The results go back to
 * the dashboard, which recomputes the verdicts and shows them on the test.
 * `piwi flake verify` reruns the arm that reproduced the test, and its
 * control, for enough runs to say the fix holds. With `--bisect` it runs that
 * arm alone, saves nothing and answers good, bad or skip in the exit codes
 * `git bisect run` reads, so a bisect can ask it at each commit.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FlakeResultLine } from '@piwitests/core/flake-plan';
import { FLAKE_PLAN_VERSION } from '@piwitests/core/flake-plan';
import { PIWI_FLAKE_ENV, PIWI_PROBE_ENV } from '../internal/config/env.js';
import {
  EXIT_BISECT_SKIP,
  EXIT_ERROR,
  armDone,
  bisectExitCode,
  armVerdict,
  countArm,
  estimateMs,
  exitCodeFor,
  formatDuration,
  nextBatch,
  parseDuration,
  playwrightArgs,
  verifyVerdict,
  withinBudget,
  type ArmCount,
  type LabArm,
  type LabPlan,
  type VerifyVerdict,
} from '../internal/flake/lab.js';
import { resolveCliConnection } from '../internal/support/connection.js';
import { spawnPlaywright } from '../internal/support/playwright-spawn.js';
import { resolveProjectId } from '../internal/support/selection-client.js';

const USAGE = `
piwi flake — make a flaky test fail on demand, then prove the fix

Usage:
  npx @piwitests/reporter flake <test> [options]
  npx @piwitests/reporter flake verify <test> [--runs <n>] [--bisect] [--json]

<test> is a test case id (the number in its dashboard URL) or a spec file and
line, tests/checkout.spec.ts:42, looked up in the project on the dashboard.

It fetches the test's plan from the dashboard: a control arm and one arm per
suspect of its flake profile, most likely first. It runs the control (10 runs),
then each arm (up to 10 runs, stopping at 3 failures with the same error as in
CI), one test at a time with retries off, in the checkout it runs in. It prints
each arm against the control with its verdict and saves the experiment on the
test's Flakiness tab. The capture fixtures must be in use (piwiFixtures).

verify reruns the arm that last reproduced the test, and its control, until a
matching failure appears or enough runs pass to say the fix holds.

verify --bisect runs that arm alone at this checkout and saves nothing, for
git bisect run: exit 0 (good) when enough runs pass, 1 (bad) on a failure with
the same error as in CI, 125 (skip) when this commit cannot tell.

Options:
  --suspect <n>        Run only the arm of suspect n (its rank on the Flakiness tab)
  --all                Also run every condition at once when none reproduces alone
  --runs <n>           Runs of the control and of each arm (default 10; verify:
                       the number that proves the fix at the rate it reproduced)
  --budget <duration>  Start no new arm after this long: 15m (default), 90s, 1h
  --no-upload          Keep the results off the dashboard; it still needs the plan
                       from the dashboard, or from --plan when it cannot be reached
  --plan <file>        Read the plan from a file (a saved flake-plan response, or
                       the plan the plan_flake_experiment MCP tool returns) and run
                       it without the dashboard; implies --no-upload
  --bisect             verify only: one bisect step, as above; implies --no-upload
  --source <where>     Where the lab runs, recorded on the experiment: cli, ci or
                       desktop (default: ci when CI is set, else cli)
  --json               Print the results as JSON instead of text
  --server-url <url>   Dashboard URL (env PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>      Reporter API key (env PIWI_API_KEY, .env)
  --project <name|id>  The Piwi project, for a file:line test (env PIWI_PROJECT_NAME, .env)

Exit codes: 0 an arm reproduced the failure (verify: the fix held),
            1 nothing reproduced (verify: it still fails, or too few runs),
            2 error; with --bisect, 0 good, 1 bad, 125 skip, 2 error.
`.trim();

const DEFAULT_BUDGET_MS = 15 * 60_000;
const SOURCES = ['cli', 'ci', 'desktop'] as const;
type FlakeSource = (typeof SOURCES)[number];
/** The most Playwright invocations one arm makes, discarded rounds included. */
const MAX_BATCHES = 12;
/** Lines of Playwright's output shown when an arm records nothing. */
const LOG_TAIL_LINES = 40;

export interface FlakeArgs {
  verify: boolean;
  test: string | null;
  suspect: number | null;
  all: boolean;
  runs: number | null;
  budgetMs: number;
  upload: boolean;
  planFile: string | null;
  /** One bisect step: the verify arm alone, nothing saved, good/bad/skip exit codes. */
  bisect: boolean;
  /** Where the lab runs; null reads it from the environment. */
  source: FlakeSource | null;
  json: boolean;
  serverUrl?: string;
  apiKey?: string;
  project?: string;
  help: boolean;
}

/** Read the command line; throws with a message naming the bad option. */
export function parseFlakeArgs(argv: string[]): FlakeArgs {
  const args: FlakeArgs = {
    verify: argv[0] === 'verify',
    test: null,
    suspect: null,
    all: false,
    runs: null,
    budgetMs: DEFAULT_BUDGET_MS,
    upload: true,
    planFile: null,
    bisect: false,
    source: null,
    json: false,
    help: false,
  };
  const rest = args.verify ? argv.slice(1) : argv;
  const value = (i: number, name: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const whole = (text: string, name: string, min: number, max: number): number => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--suspect':
        args.suspect = whole(value(i++, arg), arg, 1, 50);
        break;
      case '--all':
        args.all = true;
        break;
      case '--runs':
        args.runs = whole(value(i++, arg), arg, 1, 100);
        break;
      case '--budget': {
        const ms = parseDuration(value(i++, arg));
        if (ms == null) throw new Error('--budget must be a duration like 15m, 90s or 1h');
        args.budgetMs = ms;
        break;
      }
      case '--no-upload':
        args.upload = false;
        break;
      case '--plan':
        args.planFile = value(i++, arg);
        args.upload = false;
        break;
      case '--bisect':
        args.bisect = true;
        args.upload = false;
        break;
      case '--source': {
        const where = value(i++, arg);
        if (!(SOURCES as readonly string[]).includes(where))
          throw new Error(`--source must be one of ${SOURCES.join(', ')}`);
        args.source = where as FlakeSource;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--server-url':
        args.serverUrl = value(i++, arg);
        break;
      case '--api-key':
        args.apiKey = value(i++, arg);
        break;
      case '--project':
        args.project = value(i++, arg);
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        if (args.test !== null) throw new Error(`one test at a time (got "${args.test}" and "${arg}")`);
        args.test = arg;
    }
  }
  if (args.suspect !== null && args.all) throw new Error('--suspect and --all cannot be used together');
  if (args.verify && (args.suspect !== null || args.all))
    throw new Error('verify reruns one arm: drop --suspect and --all');
  if (args.bisect && !args.verify) throw new Error('--bisect is a verify option: flake verify <test> --bisect');
  return args;
}

/** One arm as it ran. */
export interface ArmResult {
  arm: LabArm;
  count: ArmCount;
  /** Against the control (a reproduce arm), or for the fix (the verify arm). */
  verdict: string | null;
  pValue: number | null;
  /** Why the arm did not run. */
  skipped: string | null;
}

interface FlakeReport {
  kind: 'reproduce' | 'verify';
  testCaseId: number;
  test: string;
  experimentId: string | null;
  commit: string | null;
  failureCommit: string | null;
  commitsDiffer: boolean;
  playwrightProject: string | null;
  estimateMs: number | null;
  arms: Array<{
    id: string;
    label: string;
    suspectId: string | null;
    rank: number | null;
    runs: number;
    matchingFailures: number;
    otherFailures: number;
    discardedRounds: number;
    stoppedEarly: boolean;
    otherSignatures: string[];
    verdict: string | null;
    pValue: number | null;
    skipped: string | null;
  }>;
  verdict: string;
  reproducingArm: string | null;
  uploaded: boolean;
  verifyCommand: string | null;
  exitCode: number;
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** True when two commit ids name different commits (either may be abbreviated). */
export function commitsDiffer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return !x.startsWith(y) && !y.startsWith(x);
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function fraction(count: Pick<ArmCount, 'runs' | 'matchingFailures'>): string {
  return `${count.matchingFailures}/${count.runs}`;
}

function formatP(p: number): string {
  return p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`;
}

class FlakeError extends Error {}

interface Http {
  serverUrl: string;
  headers: Record<string, string>;
}

async function getJson<T>(http: Http, url: string): Promise<T> {
  const res = await fetch(`${http.serverUrl}${url}`, { headers: http.headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new FlakeError(body.message || `the dashboard returned ${res.status} for ${url.split('?')[0]}`);
  }
  return (await res.json()) as T;
}

/** The test case id `<test>` names: the number itself, or the test at a file and line. */
async function resolveTestCase(http: Http, test: string, project: string, apiKey: string | null): Promise<number> {
  if (/^\d+$/.test(test)) return Number(test);
  const m = /^(.+):(\d+)$/.exec(test);
  if (!m) throw new FlakeError(`"${test}" is neither a test case id nor file:line`);
  const projectId = await resolveProjectId({ serverUrl: http.serverUrl, apiKey, project, key: '' });
  const found = await getJson<{ testCaseId: number }>(
    http,
    `/api/projects/${projectId}/flake-lab/test?location=${encodeURIComponent(`${m[1]!.replace(/\\/g, '/')}:${m[2]}`)}`,
  );
  return found.testCaseId;
}

/** Everything the run loop needs from the outside world; tests replace it. */
export interface FlakeRunner {
  /** Run one batch of an arm; resolves with its results lines. */
  runBatch(plan: LabPlan, arm: LabArm, repeat: number, batch: number): Promise<FlakeResultLine[]>;
  now(): number;
}

/** Run Playwright for real, one plan file per arm and one results file per batch. */
function playwrightRunner(dir: string, log: string): FlakeRunner {
  return {
    now: () => Date.now(),
    async runBatch(plan, arm, repeat, batch) {
      const planFile = path.join(dir, `${arm.id}.plan.json`);
      if (!fs.existsSync(planFile)) {
        fs.writeFileSync(
          planFile,
          JSON.stringify({
            version: FLAKE_PLAN_VERSION,
            experimentId: plan.experimentId ?? `local-${process.pid}`,
            test: plan.test,
            arm: { id: arm.id, conditions: arm.conditions },
            errorSignatures: plan.errorSignatures,
          }),
        );
      }
      const resultsFile = path.join(dir, `${arm.id}.${batch}.jsonl`);
      fs.writeFileSync(resultsFile, '');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        [PIWI_FLAKE_ENV.plan]: planFile,
        [PIWI_FLAKE_ENV.results]: resultsFile,
      };
      delete env[PIWI_PROBE_ENV.flag];
      fs.appendFileSync(log, `\n── ${arm.id} batch ${batch} ──\n`);
      await spawnPlaywright(playwrightArgs(plan.test, arm, repeat), env, {
        output: { file: log },
        command: 'piwi flake',
      });
      return readResults(resultsFile);
    },
  };
}

function readResults(file: string): FlakeResultLine[] {
  const lines: FlakeResultLine[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as FlakeResultLine);
    } catch {
      // A torn line: the attempt it described is not counted.
    }
  }
  return lines;
}

/**
 * Run one arm in batches until it reaches its stop or its runs. Throws when a
 * batch records no attempt of the test at all (the fixtures are not in use, or
 * the plan names a test this checkout does not have).
 */
async function runArm(runner: FlakeRunner, plan: LabPlan, arm: LabArm): Promise<ArmCount> {
  const batches: FlakeResultLine[][] = [];
  let count = countArm(batches, arm);
  for (let batch = 1; batch <= MAX_BATCHES && !armDone(count, arm); batch++) {
    const repeat = nextBatch(count, arm);
    if (repeat <= 0) break;
    const lines = await runner.runBatch(plan, arm, repeat, batch);
    if (!lines.some((l) => l.role === 'target')) {
      throw new FlakeError(
        `the ${arm.id} arm recorded no attempt of "${plan.displayTitle}" in ${plan.test.file}. Is the test in this checkout, and does its spec use the Piwi capture fixtures?`,
      );
    }
    batches.push(lines);
    count = countArm(batches, arm);
  }
  return count;
}

/** Run the arms of a plan within the budget, and judge them. */
export async function runSession(
  runner: FlakeRunner,
  plan: LabPlan,
  args: Pick<FlakeArgs, 'suspect' | 'all' | 'budgetMs'> & { bisect?: boolean },
  onArm: (result: ArmResult, control: ArmCount | null) => void = () => {},
): Promise<{ control: ArmResult; arms: ArmResult[] }> {
  const started = runner.now();
  // A bisect step judges its commit by the verify arm alone.
  const control: ArmResult = args.bisect
    ? { arm: plan.control, count: countArm([], plan.control), verdict: null, pValue: null, skipped: 'bisect step' }
    : {
        arm: plan.control,
        count: await runArm(runner, plan, plan.control),
        verdict: null,
        pValue: null,
        skipped: null,
      };
  onArm(control, null);
  const arms = args.suspect != null ? plan.arms.filter((a) => a.rank === args.suspect) : plan.arms;
  const results: ArmResult[] = [];
  const run = async (arm: LabArm) => {
    if (!withinBudget(started, runner.now(), args.budgetMs)) {
      const result: ArmResult = { arm, count: countArm([], arm), verdict: null, pValue: null, skipped: 'budget spent' };
      results.push(result);
      onArm(result, control.count);
      return;
    }
    const count = await runArm(runner, plan, arm);
    let verdict: string;
    let pValue: number | null = null;
    if (plan.kind === 'verify') {
      verdict = verifyVerdict(count, plan.verifies?.rate ?? 1);
    } else {
      const v = armVerdict(count, control.count);
      verdict = v.verdict;
      pValue = v.pValue;
    }
    const result: ArmResult = { arm, count, verdict, pValue, skipped: null };
    results.push(result);
    onArm(result, control.count);
  };
  for (const arm of arms) await run(arm);
  if (args.all && plan.combined && !results.some((r) => r.verdict === 'reproduced')) await run(plan.combined);
  return { control, arms: results };
}

/** The session's verdict: the first arm that reproduced (or the verify arm's), else the best one seen. */
export function sessionVerdict(
  kind: 'reproduce' | 'verify',
  arms: ArmResult[],
): { verdict: string; reproducingArm: string | null } {
  if (kind === 'verify') {
    const v = arms.find((a) => a.arm.id === 'verify');
    return {
      verdict: (v?.verdict as VerifyVerdict | undefined) ?? 'inconclusive',
      reproducingArm: v ? 'verify' : null,
    };
  }
  const reproduced = arms.find((a) => a.verdict === 'reproduced');
  if (reproduced) return { verdict: 'reproduced', reproducingArm: reproduced.arm.id };
  return {
    verdict: arms.some((a) => a.verdict === 'amplified') ? 'amplified' : 'not-reproduced',
    reproducingArm: null,
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** One arm's line in the lab table. */
export function armLine(result: ArmResult, stopAt: number | null): string {
  const { arm, count } = result;
  const name = arm.id === 'control' ? 'control' : `${arm.rank != null ? `${arm.rank}  ` : '   '}${arm.label}`;
  if (result.skipped) return `  ${pad(clip(name, 34), 35)}${result.skipped}`;
  const notes: string[] = [];
  if (count.stoppedEarly && stopAt != null) notes.push(`stopped at ${stopAt}`);
  if (count.matchingFailures > 0) notes.push('same error as in CI');
  if (count.otherFailures > 0)
    notes.push(`${count.otherFailures} different error${count.otherFailures === 1 ? '' : 's'} (counted apart)`);
  if (count.discardedRounds > 0) {
    notes.push(`${count.discardedRounds} round${count.discardedRounds === 1 ? '' : 's'} left out`);
  }
  const verdict = result.verdict ? result.verdict.replace('-', ' ') : '';
  return `  ${pad(clip(name, 34), 35)}${pad(fraction(count), 7)}${pad(notes.join(' · '), 44)}${verdict}`.trimEnd();
}

function verdictSentence(report: FlakeReport, arms: ArmResult[], control: ArmResult): string {
  const c = fraction(control.count);
  const against = control.skipped ? '' : ` (control ${c})`;
  if (report.kind === 'verify') {
    const v = arms.find((a) => a.arm.id === 'verify');
    if (!v) return 'Verdict: the verify arm did not run.';
    const label = v.arm.label;
    if (report.verdict === 'verified') {
      return `Verdict: fix verified: 0 matching failures in ${v.count.runs} runs under ${label}${against}`;
    }
    if (report.verdict === 'still-fails') {
      return `Verdict: still fails: ${fraction(v.count)} under ${label} failed as in CI${against}`;
    }
    return `Verdict: inconclusive: ${v.count.runs} clean runs under ${label}, too few to verify the fix`;
  }
  const r = arms.find((a) => a.arm.id === report.reproducingArm);
  if (r) {
    return `Verdict: reproduced by ${r.arm.label} (${fraction(r.count)} against ${c}, p ${formatP(r.pValue ?? 1)})`;
  }
  const amplified = arms.find((a) => a.verdict === 'amplified');
  if (amplified) {
    return `Verdict: not reproduced; ${amplified.arm.label} made it fail more often (${fraction(amplified.count)} against ${c}, p ${formatP(amplified.pValue ?? 1)})`;
  }
  return `Verdict: not reproduced (control ${c})`;
}

/** The word `git bisect` would record for a step's exit code. */
function bisectStepWord(code: number): string {
  if (code === 0) return 'good (the arm held at this commit)';
  if (code === 1) return 'bad (a failure with the same error as in CI)';
  return 'skip (too few clean runs to tell)';
}

function printHeader(plan: LabPlan, commit: string | null, estimate: number | null, budgetMs: number): void {
  const out: string[] = [];
  out.push(
    `piwi flake${plan.kind === 'verify' ? ' verify' : ''} · ${plan.displayTitle} · ${plan.failures} failures in ${plan.windowDays} days`,
  );
  out.push('');
  if (plan.kind === 'verify' && plan.verifies) {
    out.push(
      `Rerunning ${plan.verifies.label}: it reproduced ${Math.round(plan.verifies.rate * 100)}% of runs on ${short(plan.verifies.commit)}`,
    );
  } else if (plan.suspects.length === 0) {
    out.push('Suspects from history: none. Nothing in its history separates its failures from its passes.');
  } else {
    out.push(`${pad('Suspects from history', 57)}condition`);
    for (const s of plan.suspects) {
      const counts = `${s.counts.failuresWith}/${s.counts.failures} failures · ${s.counts.passesWith}/${s.counts.passes} passes`;
      out.push(
        `  ${s.rank}  ${pad(clip(s.label, 40), 41)}${pad(counts, 30)}${s.skipped ? `none: ${s.skipped}` : s.conditionLabel}`,
      );
      if (s.sharedRoutes?.length) out.push(`     both write ${s.sharedRoutes.join(', ')}`);
    }
  }
  out.push('');
  const estimateText = estimate != null ? `up to ${formatDuration(estimate)}` : 'unknown (no passing run on record)';
  out.push(`Estimate: ${estimateText} · budget ${formatDuration(budgetMs)}`);
  out.push(`Lab · ${os.hostname()} · HEAD ${short(commit)} · ${plan.test.project ?? 'default project'} · retries off`);
  if (commitsDiffer(commit, plan.failureCommit)) {
    out.push(`warning: this checkout is ${short(commit)}; the latest failure ran on ${short(plan.failureCommit)}.`);
  }
  console.log(out.join('\n'));
}

async function loadPlan(args: FlakeArgs, commit: string | null): Promise<{ plan: LabPlan; http: Http | null }> {
  if (args.planFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(args.planFile, 'utf8')) as LabPlan | { plan: LabPlan };
      const plan = 'plan' in raw && raw.plan ? raw.plan : (raw as LabPlan);
      if (plan.version !== 1 || !plan.control || !Array.isArray(plan.arms)) throw new Error('not a flake-lab plan');
      if (args.verify !== (plan.kind === 'verify')) {
        throw new Error(`it is a ${plan.kind} plan; run ${plan.kind === 'verify' ? 'flake verify' : 'flake'} with it`);
      }
      return { plan: args.runs ? withRuns(plan, args.runs) : plan, http: null };
    } catch (error) {
      throw new FlakeError(`cannot read the plan ${args.planFile}: ${(error as Error).message}`);
    }
  }
  if (!args.test) throw new FlakeError('name the test: a test case id or file:line');
  const connection = resolveCliConnection(
    { serverUrl: args.serverUrl, apiKey: args.apiKey, project: args.project },
    process.env,
    [process.cwd()],
    args.verify ? 'piwi flake verify' : 'piwi flake',
  );
  if (!connection) {
    throw new FlakeError(
      'no dashboard to read the plan from: pass --server-url or set PIWI_DASHBOARD_URL (or run it offline with --plan <file>)',
    );
  }
  const http: Http = {
    serverUrl: connection.serverUrl,
    headers: connection.apiKey ? { 'X-API-Key': connection.apiKey } : {},
  };
  try {
    const testCaseId = await resolveTestCase(http, args.test, connection.project, connection.apiKey);
    const params = new URLSearchParams({
      kind: args.verify ? 'verify' : 'reproduce',
      source: args.source ?? (process.env.CI ? 'ci' : 'cli'),
      machine: os.hostname(),
      record: String(args.upload),
    });
    if (commit) params.set('commit', commit);
    if (args.runs) params.set('runs', String(args.runs));
    return { plan: await getJson<LabPlan>(http, `/api/test-cases/${testCaseId}/flake-plan?${params}`), http };
  } catch (error) {
    if (error instanceof FlakeError) throw error;
    throw new FlakeError(
      `could not reach the dashboard at ${connection.serverUrl} (${(error as Error).message}). The plan comes from the dashboard; to run offline, pass --plan <file> with a plan saved earlier.`,
    );
  }
}

function withRuns(plan: LabPlan, runs: number): LabPlan {
  const set = (arm: LabArm): LabArm => ({ ...arm, runs });
  return {
    ...plan,
    control: set(plan.control),
    arms: plan.arms.map(set),
    combined: plan.combined && set(plan.combined),
  };
}

export async function runFlake(argv: string[], runner?: FlakeRunner): Promise<number> {
  let args: FlakeArgs;
  try {
    args = parseFlakeArgs(argv);
  } catch (error) {
    console.error(`piwi flake: ${(error as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const commit = gitHead();
  let plan: LabPlan;
  let http: Http | null;
  try {
    ({ plan, http } = await loadPlan(args, commit));
  } catch (error) {
    console.error(`piwi flake: ${(error as Error).message}`);
    return EXIT_ERROR;
  }
  if (args.suspect != null && !plan.arms.some((a) => a.rank === args.suspect)) {
    console.error(`piwi flake: suspect ${args.suspect} has no arm (${plan.arms.length} arm(s) in the plan).`);
    return EXIT_ERROR;
  }
  if (plan.kind === 'reproduce' && plan.arms.length === 0) {
    if (!args.json) printHeader(plan, commit, null, args.budgetMs);
    console.error('piwi flake: no suspect with a condition to test, so there is nothing to run.');
    return 1;
  }

  const planned = [
    ...(args.bisect ? [] : [plan.control]),
    ...(args.suspect != null ? plan.arms.filter((a) => a.rank === args.suspect) : plan.arms),
  ];
  if (args.all && plan.combined) planned.push(plan.combined);
  const estimate = estimateMs(planned, plan.medianDurationMs);
  if (!args.json) {
    printHeader(plan, commit, estimate, args.budgetMs);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-flake-'));
  const log = path.join(dir, 'playwright.log');
  let session: { control: ArmResult; arms: ArmResult[] };
  try {
    session = await runSession(runner ?? playwrightRunner(dir, log), plan, args, (result) => {
      if (!args.json && !result.skipped?.startsWith('bisect')) console.log(armLine(result, result.arm.stopAt));
    });
  } catch (error) {
    console.error(`piwi flake: ${(error as Error).message}`);
    if (fs.existsSync(log)) {
      const tail = fs.readFileSync(log, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');
      console.error(`\nPlaywright's output (${log}):\n${tail}`);
    }
    // A commit whose checkout cannot run the arm is skipped, not judged.
    if (args.bisect) {
      console.log('Bisect step: skip (this commit could not run the arm)');
      return EXIT_BISECT_SKIP;
    }
    return EXIT_ERROR;
  }

  const { verdict, reproducingArm } = sessionVerdict(plan.kind, session.arms);
  const ran = [session.control, ...session.arms.filter((a) => !a.skipped)];
  let uploaded = false;
  if (args.upload && http && plan.experimentId) {
    try {
      const res = await fetch(`${http.serverUrl}/api/projects/${plan.projectId}/flake-lab/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...http.headers },
        body: JSON.stringify({
          experimentId: plan.experimentId,
          commit,
          playwrightProject: plan.test.project,
          arms: ran.map((r) => ({
            id: r.arm.id,
            label: r.arm.label,
            suspectId: r.arm.suspectId,
            conditions: r.arm.conditions,
            runs: r.count.runs,
            matchingFailures: r.count.matchingFailures,
            otherFailures: r.count.otherFailures,
            discardedRounds: r.count.discardedRounds,
            stoppedEarly: r.count.stoppedEarly,
          })),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `the dashboard returned ${res.status}`);
      }
      uploaded = true;
    } catch (error) {
      console.error(`piwi flake: could not save the results — ${(error as Error).message}`);
    }
  }

  const code = args.bisect ? bisectExitCode(verdict) : exitCodeFor(verdict);
  const verifyCommand = `npx @piwitests/reporter flake verify ${plan.testCaseId}`;
  const report: FlakeReport = {
    kind: plan.kind,
    testCaseId: plan.testCaseId,
    test: plan.displayTitle,
    experimentId: plan.experimentId,
    commit,
    failureCommit: plan.failureCommit,
    commitsDiffer: commitsDiffer(commit, plan.failureCommit),
    playwrightProject: plan.test.project,
    estimateMs: estimate,
    arms: [session.control, ...session.arms].map((r) => ({
      id: r.arm.id,
      label: r.arm.label,
      suspectId: r.arm.suspectId,
      rank: r.arm.rank,
      ...r.count,
      verdict: r.verdict,
      pValue: r.pValue,
      skipped: r.skipped,
    })),
    verdict,
    reproducingArm,
    uploaded,
    verifyCommand: plan.kind === 'reproduce' && verdict === 'reproduced' ? verifyCommand : null,
    exitCode: code,
  };
  fs.rmSync(dir, { recursive: true, force: true });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return code;
  }
  const lines = [verdictSentence(report, session.arms, session.control)];
  if (args.bisect) lines.push(`Bisect step: ${bisectStepWord(code)}`);
  if (uploaded)
    lines.push(`Saved to the test's Flakiness tab.${report.verifyCommand ? ` After your fix: ${verifyCommand}` : ''}`);
  else if (report.verifyCommand) lines.push(`Not saved (--no-upload). After your fix: ${verifyCommand}`);
  console.log(lines.join('\n'));
  return code;
}
