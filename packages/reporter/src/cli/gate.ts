/**
 * `piwi gate` — fail a CI job on the dashboard's analysis of a run.
 *
 * Playwright's own exit code answers "did anything fail". It cannot answer the
 * questions a merge policy actually asks: *did this change break something that
 * was working*, *did a critical test fail*, *did a brand-new failure cause
 * appear*. Those need the run history, so the dashboard evaluates the policy and
 * this command reports the verdict as an exit code.
 *
 * Exit codes are part of the contract:
 *   0  policy satisfied
 *   1  policy violated
 *   2  the gate could not be evaluated (bad arguments, unreachable dashboard)
 *   3  inconclusive: the run is an environment incident, so it cannot say
 *      whether the change is good
 *
 * A gate that cannot run exits 2 rather than 0, so a misconfigured pipeline
 * fails loudly instead of silently waving every merge through. An inconclusive
 * run is non-zero for the same reason, and distinct so a pipeline can re-run.
 */
import * as fs from 'node:fs';
import { formatGateResult, type GatePolicy, type GateResult } from '@piwitests/core/gate';

const EXIT_OK = 0;
const EXIT_VIOLATED = 1;
const EXIT_ERROR = 2;
const EXIT_INCONCLUSIVE = 3;

interface GateArgs {
  serverUrl: string;
  apiKey: string | null;
  runId: number;
  policy: GatePolicy;
  /** Warn-only: report (never fail on) more than n uncovered changed files. */
  maxUncoveredChanges?: number;
  /** Warn-only: report (never fail on) a patch coverage under this percentage. */
  minPatchCoverage?: number;
}

const USAGE = `
piwi gate — fail a CI job on the dashboard's analysis of a run

Usage:
  npx @piwitests/reporter gate [options]

Where the run comes from (first match wins):
  --run-id <id>            Run id to evaluate
  --from-file <path>       Read runId from the reporter's output JSON
  PIWI_OUTPUT_FILE         Same, from the environment
  (default)                ./piwi-run.json, if it exists

Connection:
  --server-url <url>       Dashboard URL      (env PIWI_DASHBOARD_URL)
  --api-key <key>          API key            (env PIWI_API_KEY)

Policy (at least one is required):
  --require-tag <tags>     Comma-separated; every test carrying the tag must pass
  --max-failed <n>         Fail when more than n tests failed
  --max-new-regressions <n>  Fail when more than n tests newly started failing
  --max-new-flaky <n>      Fail when more than n tests newly became flaky
  --max-quarantined <n>    Fail when more than n tests are quarantined
  --fail-on-new-cluster    Fail when this run introduced a new failure cluster
  --fail-on-flaky          Fail when this run contains any flaky test
  --require-selection <key>  Fail when a test the named selection matches did not run or failed
  --max-leaks <n>          Fail when the run left more than n browsers, contexts or pages open (per opening line)
  --max-new-leaks <n>      Fail when more than n of those were never seen on the base branch

Warn-only (reported, never fails the build):
  --max-uncovered-changes <n>  Warn when more than n changed files have no observed test reach
  --min-patch-coverage <percent>  Warn when fewer of the changed lines ran, in the commit's combined coverage

Other:
  --json                   Print the raw result as JSON instead of a summary
  -h, --help               Show this help

Exit codes: 0 satisfied, 1 violated, 2 could not evaluate, 3 inconclusive (an environment incident).
`.trim();

/** Read `--flag value` / `--flag=value`, or undefined when absent. */
function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function readPercent(argv: string[], name: string): number | undefined {
  const raw = readOption(argv, name)?.replace(/%$/, '');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100)
    throw new Error(`${name} expects a percentage from 0 to 100, got "${raw}"`);
  return n;
}

function readCount(argv: string[], name: string): number | undefined {
  const raw = readOption(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} expects a non-negative number, got "${raw}"`);
  return Math.floor(n);
}

/** The run id the reporter wrote for this pipeline, if it left a file behind. */
function readRunIdFromFile(path: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf-8')) as { runId?: unknown };
    const runId = Number(parsed.runId);
    return Number.isFinite(runId) && runId > 0 ? runId : null;
  } catch {
    return null;
  }
}

export function parseGateArgs(argv: string[], env: NodeJS.ProcessEnv): GateArgs {
  const serverUrl = (readOption(argv, '--server-url') ?? env.PIWI_DASHBOARD_URL ?? '').replace(/\/$/, '');
  if (!serverUrl) throw new Error('No dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL');

  let runId = Number(readOption(argv, '--run-id') ?? NaN);
  if (!Number.isFinite(runId) || runId <= 0) {
    const candidate = readOption(argv, '--from-file') ?? env.PIWI_OUTPUT_FILE ?? 'piwi-run.json';
    runId = readRunIdFromFile(candidate) ?? NaN;
  }
  if (!Number.isFinite(runId) || runId <= 0) {
    throw new Error(
      'No run to evaluate — pass --run-id, or set PIWI_OUTPUT_FILE so the reporter records the run it submitted',
    );
  }

  const requireTags = (readOption(argv, '--require-tag') ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^@+/, ''))
    .filter(Boolean);

  const policy: GatePolicy = {
    requireTags,
    maxFailed: readCount(argv, '--max-failed'),
    maxNewRegressions: readCount(argv, '--max-new-regressions'),
    maxNewFlaky: readCount(argv, '--max-new-flaky'),
    maxQuarantined: readCount(argv, '--max-quarantined'),
    failOnNewCluster: argv.includes('--fail-on-new-cluster'),
    failOnFlaky: argv.includes('--fail-on-flaky'),
    requireSelection: readOption(argv, '--require-selection'),
    maxLeaks: readCount(argv, '--max-leaks'),
    maxNewLeaks: readCount(argv, '--max-new-leaks'),
  };

  return {
    serverUrl,
    apiKey: readOption(argv, '--api-key') ?? env.PIWI_API_KEY ?? null,
    runId,
    policy,
    maxUncoveredChanges: readCount(argv, '--max-uncovered-changes'),
    minPatchCoverage: readPercent(argv, '--min-patch-coverage'),
  };
}

async function requestGate(args: GateArgs): Promise<GateResult> {
  // `X-Piwi-Client: cli` names this command as the evaluation's source.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Piwi-Client': 'cli' };
  if (args.apiKey) headers['X-API-Key'] = args.apiKey;

  // `maxUncoveredChanges` and `minPatchCoverage` are warn-only body fields the
  // server reads outside the policy; JSON.stringify drops them when undefined.
  const res = await fetch(`${args.serverUrl}/api/test-runs/${args.runId}/gate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...args.policy,
      maxUncoveredChanges: args.maxUncoveredChanges,
      minPatchCoverage: args.minPatchCoverage,
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Dashboard returned ${res.status} evaluating the gate`);
  }
  return (await res.json()) as GateResult;
}

/** Run the gate. Returns the process exit code rather than calling `exit`. */
export async function runGate(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  let args: GateArgs;
  try {
    args = parseGateArgs(argv, env);
  } catch (e) {
    console.error(`piwi gate: ${(e as Error).message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  let result: GateResult;
  try {
    result = await requestGate(args);
  } catch (e) {
    console.error(`piwi gate: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatGateResult(result));
  }

  if (result.verdict === 'inconclusive') return EXIT_INCONCLUSIVE;
  return result.passed ? EXIT_OK : EXIT_VIOLATED;
}
