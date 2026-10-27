/**
 * `piwi probe` — run the dashboard's probe plan.
 *
 * Fetches the (test, route, fault) pairs the dashboard wants probed, runs
 * `playwright test` with the capture fixtures in probe mode (each fault applied
 * at `page.route`), and posts the outcomes back. The run is stamped as a probe
 * run, so the dashboard never counts it as a real run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCliConnection } from '../internal/support/connection.js';
import { resolveProjectId } from '../internal/support/selection-client.js';
import { spawnPlaywright } from '../internal/support/playwright-spawn.js';
import { PIWI_ENV_KEYS, PIWI_PROBE_ENV } from '../internal/config/env.js';
import type { ProbePlan } from '../internal/probe/plan.js';
import type { ProbeOutcomeLine } from '../internal/probe/mode.js';

const EXIT_OK = 0;
const EXIT_ERROR = 2;

const USAGE = `
piwi probe — run the dashboard's probe plan and record what the suite noticed

Usage:
  npx @piwitests/reporter probe [options] [-- <playwright args>]

Options:
  --server-url <url>   Dashboard URL (or PIWI_DASHBOARD_URL, .env, the desktop app)
  --api-key <key>      Reporter API key (or PIWI_API_KEY, .env)
  --project <name|id>  Project name or id (or PIWI_PROJECT_NAME, .env)
  --budget <n>         Max pairs to probe this run (default the server's)

Everything after \`--\` is passed to \`playwright test\`.
`.trim();

function readOption(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function runProbe(argv: string[]): Promise<number> {
  const sep = argv.indexOf('--');
  const own = sep < 0 ? argv : argv.slice(0, sep);
  const playwrightArgs = sep < 0 ? [] : argv.slice(sep + 1);
  if (own.includes('-h') || own.includes('--help')) {
    console.log(USAGE);
    return EXIT_OK;
  }

  const env = process.env;
  const connection = resolveCliConnection(
    {
      serverUrl: readOption(own, '--server-url'),
      apiKey: readOption(own, '--api-key'),
      project: readOption(own, '--project'),
    },
    env,
    [process.cwd()],
  );
  if (!connection) {
    console.error('piwi probe: no dashboard URL — pass --server-url or set PIWI_DASHBOARD_URL (environment or .env)');
    return EXIT_ERROR;
  }
  const { serverUrl, apiKey, project } = connection;
  const budget = readOption(own, '--budget');

  let projectId: number;
  try {
    projectId = await resolveProjectId({ serverUrl, apiKey, project, key: '' });
  } catch (e) {
    console.error(`piwi probe: ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  const authHeaders = apiKey ? { 'X-API-Key': apiKey } : {};
  const planUrl = `${serverUrl}/api/projects/${projectId}/probes/plan${budget ? `?budget=${encodeURIComponent(budget)}` : ''}`;
  let plan: ProbePlan;
  try {
    const res = await fetch(planUrl, { headers: authHeaders });
    if (!res.ok) throw new Error(`dashboard returned ${res.status}`);
    plan = (await res.json()) as ProbePlan;
  } catch (e) {
    console.error(`piwi probe: could not fetch the probe plan — ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  if (!plan.items || plan.items.length === 0) {
    console.error('piwi probe: nothing to probe — the plan is empty.');
    return EXIT_OK;
  }
  console.error(`piwi probe: ${plan.items.length} pair(s) to probe (budget ${plan.budget}).`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-probe-'));
  const planFile = path.join(dir, 'plan.json');
  const resultsFile = path.join(dir, 'results.jsonl');
  const runOutputFile = path.join(dir, 'run.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  fs.writeFileSync(resultsFile, '');

  // Narrow the run to the probed tests when their titles are known; probe mode
  // only acts on matched tests, but a filter keeps the run cheap.
  const grep = plan.items
    .map((i) => i.testTitle)
    .filter(Boolean)
    .map(escapeRegex)
    .join('|');
  const pwArgs = [...playwrightArgs];
  if (grep && !playwrightArgs.includes('--grep') && !playwrightArgs.includes('-g')) pwArgs.push('--grep', grep);

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    [PIWI_PROBE_ENV.flag]: '1',
    [PIWI_PROBE_ENV.plan]: planFile,
    [PIWI_PROBE_ENV.results]: resultsFile,
    // The reporter creates the probe run and knows its server-assigned id; have
    // it write the run output here so the results POST can name the run.
    [PIWI_ENV_KEYS.outputFile]: runOutputFile,
  };
  // A probe run's tests fail by design when they notice the fault, so Playwright
  // exiting non-zero is expected and is not treated as a command error.
  await spawnPlaywright(pwArgs, childEnv, { command: 'piwi probe' });

  const lines = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean);
  const results: ProbeOutcomeLine[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as ProbeOutcomeLine);
    } catch {
      // skip a malformed line
    }
  }
  if (results.length === 0) {
    console.error('piwi probe: no probe outcomes were recorded (are the Piwi capture fixtures active?).');
    return EXIT_OK;
  }

  // The reporter wrote the run's server-assigned id to the output file; pass it
  // so the dashboard links the outcomes (and their ledger) to the probe run.
  let runId: number | null = null;
  try {
    const out = JSON.parse(fs.readFileSync(runOutputFile, 'utf8')) as { runId?: unknown };
    if (typeof out.runId === 'number') runId = out.runId;
  } catch {
    // No output file (the run never registered) — post without a runId.
  }

  try {
    const res = await fetch(`${serverUrl}/api/projects/${projectId}/probes/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ runId, results }),
    });
    if (!res.ok) throw new Error(`dashboard returned ${res.status}`);
    const body = (await res.json()) as { recorded?: number };
    const noticed = results.filter((r) => r.outcome === 'noticed').length;
    const notNoticed = results.filter((r) => r.outcome === 'not-noticed').length;
    console.error(
      `piwi probe: recorded ${body.recorded ?? results.length} outcome(s) — ${noticed} noticed, ${notNoticed} not noticed.`,
    );
  } catch (e) {
    console.error(`piwi probe: could not post probe results — ${(e as Error).message}`);
    return EXIT_ERROR;
  }
  return EXIT_OK;
}
