import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DesktopJobs, labResults, verdictMessage } from '../src/desktop-jobs';
import { PiwiClient, type BranchFailure } from '../src/piwi-client';
import type { DesktopJobUpdate } from '../src/protocol';
import { hasUntestedSuspect } from '../src/server';
import { DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER, desktopTokenProof } from '@piwitests/core/desktop-proof';
import type { FlakeLabJobPlan, FlakeLabJobReport } from '@piwitests/core/desktop-job';

const BAD = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
const GOOD = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const FIRST_BAD = { sha: 'c1c1c1c1c1c1', subject: 'Drop the coupon cache', author: 'Ada', date: null };
const TOKEN = 'pd_desktop_token';
const TEAM_KEY = 'pd_team_key';

interface Received {
  method: string;
  url: string;
  key: string | undefined;
  body: unknown;
}

/** A stub server answering from `routes`, recording every request it receives. */
async function stub(
  routes: (req: Received) => { status?: number; body: unknown } | undefined,
  provesToken?: string,
): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = http.createServer(async (req, res) => {
    const challenge = req.headers[DESKTOP_CHALLENGE_HEADER];
    if (provesToken && req.url === '/api/health' && typeof challenge === 'string') {
      const proof = await desktopTokenProof(provesToken, (server.address() as AddressInfo).port, challenge);
      res.setHeader(DESKTOP_PROOF_HEADER, proof);
      res.end('{}');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const got = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        key: req.headers['x-api-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      };
      received.push(got);
      const answer = routes(got) ?? { status: 404, body: { message: 'not found' } };
      res.statusCode = answer.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let team: Awaited<ReturnType<typeof stub>>;
let desktop: Awaited<ReturnType<typeof stub>>;
let discovery = '';
/** What the desktop app answers for the job, as the developer and the run move it along. */
let jobState: { status: string; jobVerdict: unknown } = { status: 'waiting', jobVerdict: null };
/** What the desktop app answers a job request with. */
let desktopAnswer: { status: number; body: unknown } = {
  status: 201,
  body: { id: 'f00d', status: 'waiting', windowOpen: true },
};

const DELAY = { kind: 'delay', route: 'GET /api/cart', ms: 1800, match: 'all' };

/** The reproduce plan the team instance answers, with the suspects the command line prints. */
const PLAN = {
  version: 1,
  experimentId: '77',
  kind: 'reproduce',
  projectId: 7,
  testCaseId: 9,
  test: { file: 'tests/cart.spec.ts', title: 'applies the coupon', suite: ['cart'], project: 'chromium' },
  displayTitle: 'cart › applies the coupon',
  windowDays: 14,
  failures: 6,
  passes: 40,
  failureCommit: BAD,
  medianDurationMs: 1800,
  errorSignatures: ['Expected <n> to be <n>'],
  suspects: [
    {
      rank: 1,
      id: 'slow-route:GET /api/cart',
      label: 'slow GET /api/cart',
      sentence: 'GET /api/cart is slower when it fails.',
      counts: { failuresWith: 5, failures: 6, passesWith: 4, passes: 40 },
      conditionLabel: 'delay GET /api/cart 1.8 s',
      skipped: null,
      lab: null,
    },
  ],
  control: { id: 'control', label: 'control', suspectId: null, rank: null, conditions: [], runs: 10, stopAt: null },
  arms: [
    {
      id: 'suspect-1',
      label: 'delay GET /api/cart 1.8 s',
      suspectId: 'slow-route:GET /api/cart',
      rank: 1,
      conditions: [DELAY],
      runs: 10,
      stopAt: 3,
    },
  ],
  combined: null,
  verifies: null,
};
let planAnswer: { status?: number; body: unknown } = { body: PLAN };
let resultsAnswer: { status?: number; body: unknown } = { body: { experimentId: 77, verdict: 'reproduced' } };

const REPORT: FlakeLabJobReport = {
  verdict: 'reproduced',
  reproducingArm: 'suspect-1',
  commit: BAD,
  arms: [
    { id: 'control', runs: 10, matchingFailures: 0, otherFailures: 0, discardedRounds: 0, stoppedEarly: false },
    { id: 'suspect-1', runs: 4, matchingFailures: 3, otherFailures: 1, discardedRounds: 0, stoppedEarly: true },
  ],
};

const failure: BranchFailure = {
  executionId: 501,
  testCaseId: 9,
  clusterId: 214,
  title: 'applies the coupon',
  file: 'tests/cart.spec.ts',
  line: 12,
  status: 'failed',
  headline: 'Expected 40',
  location: null,
  traces: [],
  screenshot: null,
};

beforeAll(async () => {
  team = await stub((req) => {
    if (req.key !== TEAM_KEY) return { status: 401, body: {} };
    if (req.method === 'GET' && req.url === '/api/test-run-cases/501/reproduce') {
      return {
        body: {
          bisect: { available: true },
          desktop: {
            cases: [{ filePath: 'tests/cart.spec.ts', title: 'applies the coupon', line: 12, projectName: 'chromium' }],
            browserName: 'chromium',
            commit: BAD,
            good: GOOD,
            bad: BAD,
            clusterId: 214,
          },
        },
      };
    }
    if (req.method === 'POST' && req.url === '/api/failure-clusters/214/bisect') {
      return { body: { ok: true, bisectedCommit: { ...(req.body as object), commitUrl: null } } };
    }
    if (req.method === 'GET' && req.url.startsWith('/api/test-cases/9/flake-plan?')) return planAnswer;
    if (req.method === 'POST' && req.url === '/api/projects/7/flake-lab/results') return resultsAnswer;
    return undefined;
  });
  desktop = await stub((req) => {
    if (req.key !== TOKEN) return { status: 401, body: {} };
    if (req.method === 'POST' && req.url === '/api/desktop/repro-requests') return desktopAnswer;
    if (req.method === 'GET' && req.url === '/api/desktop/repro-requests/f00d') {
      return { body: { id: 'f00d', ...jobState } };
    }
    return undefined;
  }, TOKEN);
  discovery = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-desktop-jobs-')), 'desktop.json');
  fs.writeFileSync(discovery, JSON.stringify({ url: desktop.url, token: TOKEN, projects: [] }));
});

afterAll(async () => {
  await team.close();
  await desktop.close();
});

beforeEach(() => {
  team.received.length = 0;
  desktop.received.length = 0;
  jobState = { status: 'waiting', jobVerdict: null };
  desktopAnswer = { status: 201, body: { id: 'f00d', status: 'waiting', windowOpen: true } };
  planAnswer = { body: PLAN };
  resultsAnswer = { body: { experimentId: 77, verdict: 'reproduced' } };
});

const instance = () => new PiwiClient({ serverUrl: team.url, apiKey: TEAM_KEY, project: 'shop' });

describe('a job passed to the desktop app', () => {
  test('is offered for a failure of a team instance while the app runs, never for the app itself', () => {
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, () => {});
    expect(jobs.available({ client: instance(), source: 'environment' })).toBe(true);
    expect(jobs.available({ client: instance(), source: 'desktop' })).toBe(false);
    expect(jobs.available({ client: null, source: null })).toBe(false);
    const absent = new DesktopJobs({ PIWI_DESKTOP_CONFIG: path.join(path.dirname(discovery), 'none.json') }, () => {});
    expect(absent.available({ client: instance(), source: 'environment' })).toBe(false);
  });

  test('is a bisect that runs on the desktop app and is shared on the team instance with the editor key', async () => {
    const updates: DesktopJobUpdate[] = [];
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, (u) => updates.push(u), 60_000);

    const started = await jobs.start({ client: instance() }, failure, 'bisect');
    expect(started).toMatchObject({ ok: true, jobId: 'f00d' });
    expect(started.message).toContain('Confirm the job in the Piwi desktop app');

    // The job names commits and tests, and goes to the app with the app's token only.
    const posted = desktop.received.find((r) => r.method === 'POST')!;
    expect(posted.key).toBe(TOKEN);
    expect(posted.body).toEqual({
      kind: 'bisect',
      commit: BAD,
      good: GOOD,
      tests: [{ filePath: 'tests/cart.spec.ts', title: 'applies the coupon', line: 12, projectName: 'chromium' }],
      browser: 'chromium',
      title: 'applies the coupon',
      instanceUrl: team.url,
      clusterId: 214,
    });
    expect(JSON.stringify(desktop.received)).not.toContain(TEAM_KEY);

    // Nothing to share before the verdict.
    expect(await jobs.share('f00d')).toMatchObject({ ok: false });

    jobState = { status: 'running', jobVerdict: null };
    await jobs.poll();
    jobState = { status: 'done', jobVerdict: { kind: 'first-bad', commit: FIRST_BAD } };
    await jobs.poll();
    expect(updates.map((u) => u.status)).toEqual(['running', 'done']);
    const host = new URL(team.url).host;
    expect(updates[1]).toEqual({
      jobId: 'f00d',
      kind: 'bisect',
      status: 'done',
      message: 'The bisect names c1c1c1c as the first bad commit: Drop the coupon cache.',
      share: { label: `Share on ${host}` },
    });

    // A finished job is no longer polled.
    const reads = desktop.received.length;
    await jobs.poll();
    expect(desktop.received.length).toBe(reads);

    const shared = await jobs.share('f00d');
    expect(shared).toEqual({
      ok: true,
      message: `Shared on ${host}: the failure's fix plan names c1c1c1c as the first bad commit.`,
      url: `${team.url}/failure-clusters/214`,
    });
    const recorded = team.received.find((r) => r.method === 'POST')!;
    expect(recorded.key).toBe(TEAM_KEY);
    expect(recorded.body).toEqual(FIRST_BAD);
    jobs.dispose();
  });

  test('reports a reproduction with nothing to share, and a declined job', async () => {
    const updates: DesktopJobUpdate[] = [];
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, (u) => updates.push(u), 60_000);
    await jobs.start({ client: instance() }, failure, 'reproduce');
    const posted = desktop.received.find((r) => r.method === 'POST')!.body as { kind: string; good: unknown };
    expect(posted).toMatchObject({ kind: 'reproduce', good: null });
    jobState = { status: 'done', jobVerdict: { kind: 'reproduced' } };
    await jobs.poll();
    expect(updates).toEqual([
      expect.objectContaining({
        status: 'done',
        message: 'Reproduced at b0b0b0b: "applies the coupon" fails on this machine too.',
        share: null,
      }),
    ]);

    await jobs.start({ client: instance() }, failure, 'bisect');
    jobState = { status: 'declined', jobVerdict: null };
    await jobs.poll();
    expect(updates[updates.length - 1]).toMatchObject({ status: 'declined', share: null });
    jobs.dispose();
  });

  test('is refused without the app, and when the team instance refuses the key', async () => {
    const none = new DesktopJobs({ PIWI_DESKTOP_CONFIG: path.join(path.dirname(discovery), 'none.json') }, () => {});
    expect(await none.start({ client: instance() }, failure, 'bisect')).toMatchObject({ ok: false });
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, () => {});
    const wrongKey = new PiwiClient({ serverUrl: team.url, apiKey: 'pd_other', project: 'shop' });
    expect(await jobs.start({ client: wrongKey }, failure, 'bisect')).toMatchObject({ ok: false });
    expect(desktop.received.filter((r) => r.method === 'POST')).toEqual([]);
  });

  test('reads every verdict as one sentence', () => {
    expect(verdictMessage('reproduce', 't', BAD, { kind: 'not-reproduced' })).toContain('Not reproduced at b0b0b0b');
    expect(verdictMessage('bisect', 't', BAD, { kind: 'error', reason: 'npm ci failed' })).toBe(
      'The desktop app could not bisect "t": npm ci failed',
    );
    expect(verdictMessage('bisect', 't', BAD, { kind: 'stopped' })).toBe(
      'The bisect of "t" was stopped in the desktop app.',
    );
  });
});

describe('a Flake Lab job passed to the desktop app', () => {
  const host = () => new URL(team.url).host;
  const { suspects: _printed, ...runnable } = PLAN;
  const jobPlan = { ...runnable, suspects: [] } as unknown as FlakeLabJobPlan;

  test('runs the plan the instance recorded for this machine, and shares the results there with the editor key', async () => {
    const updates: DesktopJobUpdate[] = [];
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, (u) => updates.push(u), 60_000);

    const started = await jobs.startFlakeLab({ client: instance() }, { testCaseId: 9, clusterId: 214 });
    expect(started).toMatchObject({ ok: true, jobId: 'f00d' });

    // The plan is read with the editor's key, recorded as an experiment the desktop app runs on this machine.
    const read = team.received.find((r) => r.url.startsWith('/api/test-cases/9/flake-plan?'))!;
    expect(read.key).toBe(TEAM_KEY);
    expect(Object.fromEntries(new URL(read.url, team.url).searchParams)).toEqual({
      kind: 'reproduce',
      source: 'desktop',
      machine: os.hostname(),
      record: 'true',
    });

    // The job names the commit and carries the plan's arms, not the suspects' text, and never the team key.
    const posted = desktop.received.find((r) => r.method === 'POST')!;
    expect(posted.key).toBe(TOKEN);
    expect(posted.body).toEqual({
      kind: 'flake-lab',
      commit: BAD,
      plan: jobPlan,
      title: 'cart › applies the coupon',
      instanceUrl: team.url,
      clusterId: 214,
    });
    expect(JSON.stringify(desktop.received)).not.toContain(TEAM_KEY);

    expect(await jobs.share('f00d')).toMatchObject({ ok: false });

    jobState = { status: 'running', jobVerdict: null };
    await jobs.poll();
    jobState = { status: 'done', jobVerdict: { kind: 'lab', report: REPORT } };
    await jobs.poll();
    expect(updates).toEqual([
      expect.objectContaining({
        status: 'running',
        kind: 'flake-lab',
        message: 'The desktop app is running Flake Lab on "cart › applies the coupon".',
        share: null,
      }),
      {
        jobId: 'f00d',
        kind: 'flake-lab',
        status: 'done',
        message:
          'Flake Lab reproduced "cart › applies the coupon" at b0b0b0b: 3 of 4 runs under delay GET /api/cart 1.8 s failed as in CI (control 0 of 10).',
        share: { label: `Share on ${host()}` },
      },
    ]);

    const shared = await jobs.share('f00d');
    expect(shared).toEqual({
      ok: true,
      message: `Shared on ${host()}: the test's Flakiness tab shows the experiment.`,
      url: `${team.url}/test-cases/9?tab=flakiness`,
    });
    const uploads = team.received.filter((r) => r.method === 'POST');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('/api/projects/7/flake-lab/results');
    expect(uploads[0]!.key).toBe(TEAM_KEY);
    expect(uploads[0]!.body).toEqual({
      experimentId: '77',
      commit: BAD,
      playwrightProject: 'chromium',
      arms: [
        {
          id: 'control',
          label: 'control',
          suspectId: null,
          conditions: [],
          runs: 10,
          matchingFailures: 0,
          otherFailures: 0,
          discardedRounds: 0,
          stoppedEarly: false,
        },
        {
          id: 'suspect-1',
          label: 'delay GET /api/cart 1.8 s',
          suspectId: 'slow-route:GET /api/cart',
          conditions: [DELAY],
          runs: 4,
          matchingFailures: 3,
          otherFailures: 1,
          discardedRounds: 0,
          stoppedEarly: true,
        },
      ],
    });

    // Shared once: a second click posts nothing.
    expect(await jobs.share('f00d')).toMatchObject({ ok: true, message: `Already shared on ${host()}.` });
    expect(team.received.filter((r) => r.method === 'POST')).toHaveLength(1);
    jobs.dispose();
  });

  test('takes the failure title it was offered on, and has nothing to share after an error', async () => {
    const updates: DesktopJobUpdate[] = [];
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, (u) => updates.push(u), 60_000);
    await jobs.startFlakeLab({ client: instance() }, { testCaseId: 9, title: 'applies the coupon' });
    expect(desktop.received.find((r) => r.method === 'POST')!.body).toMatchObject({
      title: 'applies the coupon',
      clusterId: null,
    });
    jobState = { status: 'done', jobVerdict: { kind: 'error', reason: 'npm ci failed' } };
    await jobs.poll();
    expect(updates).toEqual([
      expect.objectContaining({
        status: 'done',
        message: 'The desktop app could not run Flake Lab on "applies the coupon": npm ci failed',
        share: null,
      }),
    ]);
    expect(await jobs.share('f00d')).toEqual({ ok: false, message: 'There are no Flake Lab results to share.' });
    jobs.dispose();
  });

  test('is refused when the plan cannot run in the desktop app, and when either side refuses', async () => {
    const jobs = new DesktopJobs({ PIWI_DESKTOP_CONFIG: discovery }, () => {}, 60_000);
    const start = () => jobs.startFlakeLab({ client: instance() }, { testCaseId: 9 });

    planAnswer = { body: { ...PLAN, failureCommit: null } };
    expect(await start()).toMatchObject({ ok: false, message: expect.stringContaining('recorded no commit') });
    planAnswer = { body: { ...PLAN, arms: [] } };
    expect(await start()).toMatchObject({ ok: false, message: expect.stringContaining('nothing to run') });
    expect(desktop.received.filter((r) => r.method === 'POST')).toEqual([]);

    const wrongKey = new PiwiClient({ serverUrl: team.url, apiKey: 'pd_other', project: 'shop' });
    expect(await jobs.startFlakeLab({ client: wrongKey }, { testCaseId: 9 })).toEqual({
      ok: false,
      message: `${host()} refused: running Flake Lab needs a reporter or administrator key.`,
    });

    planAnswer = { body: PLAN };
    desktopAnswer = { status: 400, body: { message: 'Invalid repro request' } };
    expect(await start()).toEqual({
      ok: false,
      message: 'The desktop app refused the job: it is too old to take Flake Lab jobs from the editor',
    });

    desktopAnswer = { status: 201, body: { id: 'f00d', status: 'waiting', windowOpen: false } };
    expect(await start()).toMatchObject({ ok: true, message: expect.stringContaining('Open the Piwi desktop app') });
    jobState = { status: 'done', jobVerdict: { kind: 'lab', report: REPORT } };
    await jobs.poll();
    resultsAnswer = { status: 409, body: { message: 'This experiment already has its results' } };
    expect(await jobs.share('f00d')).toEqual({
      ok: false,
      message: `${host()} already holds this experiment's results.`,
    });
    jobs.dispose();
  });

  test("records each arm with the plan's conditions, and leaves out an arm the plan does not hold", () => {
    const combined = { ...PLAN.arms[0]!, id: 'combined', label: 'all at once', suspectId: null, rank: null };
    const plan = { ...jobPlan, combined } as FlakeLabJobPlan;
    const body = labResults(plan, {
      ...REPORT,
      verdict: 'not-reproduced',
      reproducingArm: null,
      arms: [
        ...REPORT.arms,
        { id: 'combined', runs: 10, matchingFailures: 0, otherFailures: 0, discardedRounds: 1, stoppedEarly: false },
        { id: 'suspect-9', runs: 10, matchingFailures: 9, otherFailures: 0, discardedRounds: 0, stoppedEarly: false },
      ],
    });
    expect(body.arms.map((a) => [a.id, a.label, a.conditions])).toEqual([
      ['control', 'control', []],
      ['suspect-1', 'delay GET /api/cart 1.8 s', [DELAY]],
      ['combined', 'all at once', [DELAY]],
    ]);
  });

  test('reads every lab verdict as one sentence', () => {
    const plan = jobPlan;
    expect(
      verdictMessage(
        'flake-lab',
        't',
        BAD,
        { kind: 'lab', report: { ...REPORT, verdict: 'amplified', reproducingArm: null } },
        plan,
      ),
    ).toBe('Flake Lab made "t" fail more often at b0b0b0b, without reproducing it (control 0 of 10).');
    expect(
      verdictMessage(
        'flake-lab',
        't',
        BAD,
        { kind: 'lab', report: { ...REPORT, verdict: 'not-reproduced', reproducingArm: null } },
        plan,
      ),
    ).toBe('Flake Lab did not reproduce "t" at b0b0b0b: no condition made it fail as in CI (control 0 of 10).');
    expect(verdictMessage('flake-lab', 't', BAD, { kind: 'stopped' })).toBe(
      'The Flake Lab run of "t" was stopped in the desktop app.',
    );
  });

  test('is offered on a failure whose test has a flake suspect no experiment tested', () => {
    const entry = { testCaseId: 9, state: 'untested', nextCommand: 'npx @piwitests/reporter flake 9', flaky: true };
    expect(hasUntestedSuspect(undefined)).toBe(false);
    expect(hasUntestedSuspect({ ...entry, reproducedBy: null })).toBe(false);
    expect(hasUntestedSuspect({ ...entry, reproducedBy: null, untestedSuspects: 2 })).toBe(true);
    expect(
      hasUntestedSuspect({
        ...entry,
        reproducedBy: null,
        suspect: { id: 's', label: 'slow GET /api/cart', standing: 'untested', lab: 'untested' },
      }),
    ).toBe(true);
    expect(
      hasUntestedSuspect({
        ...entry,
        reproducedBy: 'delay',
        untestedSuspects: 0,
        suspect: { id: 's', label: 'slow GET /api/cart', standing: 'reproduced', lab: 'reproduced 7 of 10' },
      }),
    ).toBe(false);
  });
});
