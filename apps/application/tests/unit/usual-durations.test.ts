import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import {
  attachUsualDurations,
  buildUsualDurations,
  durationStandout,
  usualRequestDuration,
  usualStepDuration,
  type PastExecution,
} from '#shared/duration-standout';
import { buildFailureTimeline } from '#shared/failure-timeline';
import { diffAttempts } from '#shared/attempt-diff';

/**
 * The usual duration of a step or a request: the median over the test's last
 * passing executions, first as the pure build over rows in hand, then as the
 * query that picks those executions, on an in-memory SQLite database.
 */

// The schema barrel picks PostgreSQL at import time when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const { getUsualDurations, getFailureTimeline, attemptSteps } = await import('#shared/handlers/test-cases');

const loadReport = (duration: number | null, params?: Record<string, string>) => ({
  title: 'Load report',
  category: 'test.step',
  duration,
  ...(params ? { params } : {}),
});
const reportRequest = (id: number, duration: number | null, status = 200) => ({
  method: 'GET',
  url: `https://app.test/api/report/${id}`,
  status,
  duration,
});

describe('buildUsualDurations', () => {
  test('the median of each step over the executions that ran it', () => {
    const past: PastExecution[] = [400, 600, 900].map((ms) => ({ steps: [loadReport(ms)] }));
    expect(usualStepDuration(buildUsualDurations(past), loadReport(2500))).toBe(600);
  });

  test('an even count reads the middle two, rounded to the ms', () => {
    const past: PastExecution[] = [{ steps: [loadReport(500)] }, { steps: [loadReport(700)] }];
    expect(usualStepDuration(buildUsualDurations(past), loadReport(2500))).toBe(600);
    const odd: PastExecution[] = [{ steps: [loadReport(500)] }, { steps: [loadReport(502)] }];
    expect(usualStepDuration(buildUsualDurations(odd), loadReport(2500))).toBe(501);
  });

  test('fewer than two executions give no usual time', () => {
    const usual = buildUsualDurations([{ steps: [loadReport(600)], networkRequests: [reportRequest(1, 300)] }]);
    expect(usualStepDuration(usual, loadReport(2500))).toBeNull();
    expect(usualRequestDuration(usual, reportRequest(2, 1600))).toBeNull();
  });

  test('a step repeated in one execution still needs a second execution', () => {
    const usual = buildUsualDurations([{ steps: [loadReport(600), loadReport(650), loadReport(700)] }]);
    expect(usualStepDuration(usual, loadReport(2500))).toBeNull();
  });

  test('params tell apart two steps that share a label', () => {
    const tab = (name: string, duration: number) => ({ title: 'Click', duration, params: { locator: name } });
    const past: PastExecution[] = [
      { steps: [tab('Orders', 200), tab('Reports', 1500)] },
      { steps: [tab('Orders', 220), tab('Reports', 1700)] },
    ];
    const usual = buildUsualDurations(past);
    expect(usualStepDuration(usual, tab('Orders', 0))).toBe(210);
    expect(usualStepDuration(usual, tab('Reports', 0))).toBe(1600);
  });

  test('a step whose params change from run to run falls back on its label', () => {
    const past: PastExecution[] = [
      { steps: [loadReport(500, { url: '/report/1' })] },
      { steps: [loadReport(700, { url: '/report/2' })] },
    ];
    expect(usualStepDuration(buildUsualDurations(past), loadReport(2500, { url: '/report/3' }))).toBe(600);
  });

  test('requests group by route: ids and query strings share one usual time', () => {
    const past: PastExecution[] = [
      { networkRequests: [reportRequest(1, 280)] },
      { networkRequests: [{ ...reportRequest(7, 320), url: 'https://app.test/api/report/7?full=1' }] },
    ];
    const usual = buildUsualDurations(past);
    expect(usualRequestDuration(usual, reportRequest(42, 1600))).toBe(300);
    expect(usualRequestDuration(usual, { ...reportRequest(42, 1600), method: 'POST' })).toBeNull();
  });

  test('missing and zero durations, and unanswered or failed requests, record nothing', () => {
    const past: PastExecution[] = [
      { steps: [loadReport(null)], networkRequests: [reportRequest(1, null), reportRequest(2, 30, 0)] },
      { steps: [loadReport(0)], networkRequests: [reportRequest(3, 0), reportRequest(4, 30, 503)] },
      { steps: [loadReport(600)], networkRequests: [reportRequest(5, 300)] },
    ];
    const usual = buildUsualDurations(past);
    expect(usualStepDuration(usual, loadReport(2500))).toBeNull();
    expect(usualRequestDuration(usual, reportRequest(9, 1600))).toBeNull();
  });

  test('a step that ran across a stop at the pause bar counts its own time', () => {
    const at = (startTime: number, ms: number) => ({ ...loadReport(ms), startTime });
    const past: PastExecution[] = [
      { steps: [at(1000, 4600)], stepEvents: [{ category: 'pause', startedAt: 1100, duration: 4000 }] },
      { steps: [at(1000, 600)] },
      { steps: [at(1000, 620)], stepEvents: [{ category: 'hook', startedAt: 1000, duration: 50 }] },
    ];
    expect(usualStepDuration(buildUsualDurations(past), loadReport(2500))).toBe(600);
  });

  test('malformed rows are skipped', () => {
    const past: PastExecution[] = [{ steps: 'not a list' }, { steps: [null, 3, loadReport(600)] }, {}];
    expect(() => buildUsualDurations(past)).not.toThrow();
  });
});

describe('attachUsualDurations', () => {
  test('sets usual on the steps and requests that have one, by their row index', () => {
    const startedAt = Date.parse('2026-09-06T12:00:00Z');
    const steps = [
      { title: 'Open reports', duration: 300, startTime: startedAt },
      { ...loadReport(2500), startTime: startedAt + 300 },
    ];
    const networkRequests = [
      { ...reportRequest(2, 1600), startTime: startedAt + 400 },
      { method: 'GET', url: 'https://app.test/api/me', status: 200, duration: 40, startTime: startedAt + 10 },
    ];
    const timeline = buildFailureTimeline({ startedAt, duration: 20_000, status: 'passed', steps, networkRequests });
    const usual = buildUsualDurations(
      [600, 640].map((ms) => ({ steps: [loadReport(ms)], networkRequests: [reportRequest(1, ms / 2)] })),
    );
    const withUsual = attachUsualDurations(timeline, { steps, networkRequests }, usual);

    expect(withUsual.lanes.steps.map((item) => item.usual)).toEqual([undefined, 620]);
    expect(withUsual.lanes.network.map((item) => [item.ref.index, item.usual])).toEqual([
      [0, 310],
      [1, undefined],
    ]);
    // The step and the request stand out against it, though neither takes a third of the 20 s test.
    expect(durationStandout({ ms: 2500, testMs: 20_000, usualMs: 620 })?.reason).toBe('usual');
    expect(durationStandout({ ms: 1600, testMs: 20_000, usualMs: 310 })?.reason).toBe('usual');
    // The input timeline is left as it was.
    expect(timeline.lanes.steps.every((item) => item.usual === undefined)).toBe(true);
  });
});

describe('getUsualDurations', () => {
  type Db = ReturnType<typeof drizzle<typeof schema>>;
  let db: Db;
  const T0 = Date.parse('2026-09-06T12:00:00Z');
  const minute = 60_000;

  beforeAll(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values({ id: 1, name: 'reports' });
    await db.insert(schema.testCases).values([
      { id: 1, projectId: 1, title: 'opens the monthly report', filePath: 'tests/reports.spec.ts' },
      { id: 2, projectId: 1, title: 'exports the report', filePath: 'tests/reports.spec.ts' },
    ]);
    // Runs 1 to 9 in order; run 3 is a probe, run 4 an environment incident.
    await db.insert(schema.testRuns).values(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({
        id,
        projectId: 1,
        status: id === 9 ? 'failed' : 'passed',
        startTime: new Date(T0 + id * minute),
        ...(id === 3 ? { origin: 'probe' } : {}),
        ...(id === 4 ? { metadata: { incident: { reason: 'the database was down' } } } : {}),
      })),
    );
    const exec = (id: number, testRunId: number, stepMs: number, extra: Record<string, unknown> = {}) => ({
      id,
      testRunId,
      testCaseId: 1,
      status: 'passed',
      browserName: 'chromium',
      steps: [loadReport(stepMs)],
      createdAt: new Date(T0 + testRunId * minute),
      ...extra,
    });
    await db
      .insert(schema.testRunsCases)
      .values([
        exec(11, 1, 10_000),
        exec(12, 2, 500),
        exec(13, 3, 9000),
        exec(14, 4, 9000),
        exec(15, 5, 600),
        exec(16, 6, 700),
        exec(17, 6, 9000, { browserName: 'firefox' }),
        exec(18, 7, 9000, { status: 'failed' }),
        exec(19, 7, 9000, { testCaseId: 2 }),
        exec(20, 8, 650),
        exec(21, 8, 640, { retries: 1 }),
        exec(30, 9, 2500, { status: 'failed' }),
      ]);
    const request = (testRunsCaseId: number, testRunId: number, duration: number) => ({
      testRunsCaseId,
      testRunId,
      method: 'GET',
      url: `https://app.test/api/report/${testRunsCaseId}`,
      status: 200,
      duration,
      startTime: T0 + testRunId * minute + 100,
    });
    await db
      .insert(schema.networkRequests)
      .values([
        request(12, 2, 250),
        request(15, 5, 300),
        request(16, 6, 320),
        request(17, 6, 9000),
        request(20, 8, 280),
        request(21, 8, 300),
        request(30, 9, 1600),
      ]);
  });

  test('reads the five newest passing executions on the same browser in eligible runs, the execution itself left out', async () => {
    const usual = await getUsualDurations(db, { testCaseId: 1, browserName: 'chromium', excludeId: 30 });
    // Executions 21, 20, 16, 15 and 12: run 1 is the sixth newest, runs 3 and 4 are a probe and an
    // incident, 17 ran on Firefox, 18 failed and 19 is another test.
    expect(usualStepDuration(usual, loadReport(2500))).toBe(640);
    expect(usualRequestDuration(usual, reportRequest(30, 1600))).toBe(300);
  });

  test('an unknown browser reads every browser', async () => {
    const usual = await getUsualDurations(db, { testCaseId: 1, browserName: null, excludeId: 30 });
    // Executions 21, 20, 17, 16 and 15.
    expect(usualStepDuration(usual, loadReport(2500))).toBe(650);
  });

  test('a passing execution is left out of its own usual time', async () => {
    const usual = await getUsualDurations(db, { testCaseId: 1, browserName: 'chromium', excludeId: 21 });
    // Executions 20, 16, 15, 12 and 11.
    expect(usualStepDuration(usual, loadReport(2500))).toBe(650);
  });

  test('a test with fewer than two passing executions has none', async () => {
    const usual = await getUsualDurations(db, { testCaseId: 2, browserName: 'chromium', excludeId: 0 });
    expect(usual.steps.size + usual.stepLabels.size + usual.requests.size).toBe(0);
  });

  test('the timeline carries the usual time on the step and the request', async () => {
    const timeline = await getFailureTimeline(db, 30);
    expect(timeline.lanes.steps.map((item) => item.usual)).toEqual([640]);
    expect(timeline.lanes.network.map((item) => item.usual)).toEqual([300]);
  });
});

describe('attemptSteps', () => {
  test('an attempt that stood paused at the pause bar is compared on its own time', () => {
    const failing = [{ ...loadReport(4600), startTime: 1000 }];
    const pauses = [{ title: 'Click', category: 'pause', startedAt: 1100, duration: 4000, status: 'breakpoint' }];
    expect(attemptSteps(failing, pauses)).toEqual([{ ...loadReport(600), startTime: 1000 }]);
    expect(attemptSteps(failing, null)).toBe(failing);
    expect(attemptSteps(null, pauses)).toBeNull();
    const steps = (list: unknown) => ({ error: null, steps: list as never });
    const slower = (diff: ReturnType<typeof diffAttempts>) => diff.filter((d) => d.kind === 'step');
    expect(slower(diffAttempts(steps(failing), steps([loadReport(550)])))).toHaveLength(1);
    expect(slower(diffAttempts(steps(attemptSteps(failing, pauses)), steps([loadReport(550)])))).toEqual([]);
  });
});
