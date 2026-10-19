import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { firstRetryPassAfter, getVerifiedFixes, markingExperiments } =
  await import('../../shared/handlers/flake-verified');
const { getProjectFlakyTests, getProjectFlakyTestsWithVerified } = await import('../../shared/handlers/projects');
const { addQuarantine, listQuarantine } = await import('../../shared/handlers/quarantine');
const { runOrigin } = await import('../../shared/run-eligibility');

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 8, 1);
const at = (hours: number) => new Date(T0 + hours * HOUR_MS);

describe('which experiment marks a test verified fixed', () => {
  const exp = (id: number, kind: string, verdict: string, hours: number) => ({
    id,
    testCaseId: 1,
    kind,
    verdict,
    commit: `c${id}`,
    finishedAt: at(hours),
  });

  test('a verified verify marks it', () => {
    const marks = markingExperiments([exp(1, 'reproduce', 'reproduced', 0), exp(2, 'verify', 'verified', 1)]);
    expect(marks.get(1)?.id).toBe(2);
  });

  test('still-fails and inconclusive do not mark it', () => {
    expect(markingExperiments([exp(1, 'verify', 'still-fails', 1)]).size).toBe(0);
    expect(markingExperiments([exp(1, 'verify', 'inconclusive', 1)]).size).toBe(0);
  });

  test('a later still-fails, or a later reproduction, undoes the mark', () => {
    expect(markingExperiments([exp(1, 'verify', 'verified', 1), exp(2, 'verify', 'still-fails', 2)]).size).toBe(0);
    expect(markingExperiments([exp(1, 'verify', 'verified', 1), exp(2, 'reproduce', 'reproduced', 2)]).size).toBe(0);
  });

  test('a later inconclusive verify leaves the mark, and a later verified one restores it', () => {
    expect(markingExperiments([exp(1, 'verify', 'verified', 1), exp(2, 'verify', 'inconclusive', 2)]).get(1)?.id).toBe(
      1,
    );
    expect(markingExperiments([exp(1, 'verify', 'still-fails', 1), exp(2, 'verify', 'verified', 2)]).get(1)?.id).toBe(
      2,
    );
  });
});

describe('when a test flakes again after the verification', () => {
  const exec = (runId: number, hours: number, status: string, browserKey = 'chromium') => ({
    testCaseId: 1,
    runId,
    runStartedAt: at(hours),
    browserKey,
    status,
  });

  test('a failed and a passed attempt in one run and browser, started after it', () => {
    expect(firstRetryPassAfter([exp2(1, 5, 'failed'), exp2(1, 5, 'passed')], at(4))).toEqual(at(5));
    function exp2(runId: number, hours: number, status: string) {
      return exec(runId, hours, status);
    }
  });

  test('a retry-pass in a run that started before it does not count', () => {
    expect(firstRetryPassAfter([exec(1, 3, 'failed'), exec(1, 3, 'passed')], at(4))).toBeNull();
  });

  test('a plain failure or pass is not a retry-pass, nor are attempts on two browsers', () => {
    expect(firstRetryPassAfter([exec(1, 5, 'failed'), exec(2, 6, 'passed')], at(4))).toBeNull();
    expect(firstRetryPassAfter([exec(1, 5, 'failed', 'chromium'), exec(1, 5, 'passed', 'firefox')], at(4))).toBeNull();
  });

  test('the earliest such run is reported, and a timed-out attempt counts as failed', () => {
    const list = [exec(2, 8, 'timedout'), exec(2, 8, 'passed'), exec(1, 6, 'failed'), exec(1, 6, 'passed')];
    expect(firstRetryPassAfter(list, at(4))).toEqual(at(6));
  });
});

describe('verified fixes on the flaky ranking and in quarantine', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let runSeq = 0;

  /** One run at `hours` where test 1 fails then passes on retry (or just passes). */
  async function seedRun(hours: number, retryPass: boolean, metadata: object | null = null) {
    const runId = ++runSeq;
    await db.insert(schema.testRuns).values({
      id: runId,
      projectId: 1,
      status: 'passed',
      startTime: at(hours),
      duration: 60_000,
      totalTests: 1,
      metadata,
      origin: runOrigin(metadata),
    });
    const attempt = (status: string, retries: number) => ({
      testRunId: runId,
      testCaseId: 1,
      status,
      retries,
      duration: status === 'passed' ? 2_000 : 30_000,
      browserName: 'chromium',
      browser: { projectName: 'chromium' },
    });
    await db
      .insert(schema.testRunsCases)
      .values(retryPass ? [attempt('failed', 0), attempt('passed', 1)] : [attempt('passed', 0)]);
  }

  async function experiment(kind: 'reproduce' | 'verify', verdict: string, hours: number, commit = 'fix1234abcd') {
    await db.insert(schema.flakeExperiments).values({
      projectId: 1,
      testCaseId: 1,
      kind,
      verdict,
      commit,
      source: 'cli',
      createdAt: at(hours - 0.1),
      finishedAt: at(hours),
    });
  }

  /** A verified fix finished a moment after now, so after a quarantine made now. */
  async function verifyAfterNow() {
    const now = Date.now();
    await db.insert(schema.flakeExperiments).values({
      projectId: 1,
      testCaseId: 1,
      kind: 'verify',
      verdict: 'verified',
      commit: 'fix1234abcd',
      source: 'cli',
      createdAt: new Date(now + 1_000),
      finishedAt: new Date(now + 2_000),
    });
    return now;
  }

  beforeEach(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
    await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });
    runSeq = 0;
    // Six runs, three of them retry-passes: a flaky test.
    for (let i = 0; i < 6; i++) await seedRun(i, i % 2 === 0);
    await experiment('reproduce', 'reproduced', 6);
  });

  test('without a verification the test is ranked', async () => {
    expect((await getProjectFlakyTests(db as never, 1, 50)).map((t) => t.testCaseId)).toEqual([1]);
  });

  test('a verified fix takes it off the ranking and lists it apart', async () => {
    await experiment('verify', 'verified', 7);
    await seedRun(8, false);

    expect(await getProjectFlakyTests(db as never, 1, 50)).toEqual([]);
    const { items, verifiedFixed } = await getProjectFlakyTestsWithVerified(db as never, 1, 50);
    expect(items).toEqual([]);
    expect(verifiedFixed).toEqual([
      expect.objectContaining({
        testCaseId: 1,
        title: 'pays',
        retryPassRuns: 3,
        verifiedFix: expect.objectContaining({ commit: 'fix1234abcd', flakedAgainAt: null }),
      }),
    ]);
  });

  test('a retry-pass after the verification brings it back', async () => {
    await experiment('verify', 'verified', 7);
    await seedRun(9, true);

    const { items, verifiedFixed } = await getProjectFlakyTestsWithVerified(db as never, 1, 50);
    expect(items.map((t) => t.testCaseId)).toEqual([1]);
    expect(verifiedFixed).toEqual([]);
    const fix = (await getVerifiedFixes(db as never, [1])).get(1);
    expect(fix?.flakedAgainAt).toBe(at(9).toISOString());
  });

  test('a retry-pass in a lab run after the verification does not', async () => {
    await experiment('verify', 'verified', 7);
    await seedRun(9, true, { piwiFlakeLab: { experimentId: '9', armId: 'verify' } });
    expect(await getProjectFlakyTests(db as never, 1, 50)).toEqual([]);
  });

  test('a retry-pass in a bisect run after the verification does not', async () => {
    await experiment('verify', 'verified', 7);
    await seedRun(9, true, { piwiOrigin: { kind: 'bisect' } });
    expect((await getVerifiedFixes(db as never, [1])).get(1)?.flakedAgainAt).toBeNull();
  });

  test('still-fails and inconclusive leave it ranked', async () => {
    await experiment('verify', 'still-fails', 7);
    expect((await getProjectFlakyTests(db as never, 1, 50)).map((t) => t.testCaseId)).toEqual([1]);
    await db.delete(schema.flakeExperiments);
    await experiment('verify', 'inconclusive', 7);
    expect((await getProjectFlakyTests(db as never, 1, 50)).map((t) => t.testCaseId)).toEqual([1]);
  });

  test('a fix verified after the quarantine proposes release at once', async () => {
    await addQuarantine(db as never, 1, 1, { reason: 'flaky' });
    const before = await listQuarantine(db as never, 1);
    expect(before.entries[0]).toMatchObject({ releaseProposed: false, releaseReason: null, verifiedFix: null });

    await verifyAfterNow();
    const after = await listQuarantine(db as never, 1);
    expect(after.entries[0]).toMatchObject({
      releaseProposed: true,
      releaseReason: 'verified-fix',
      consecutivePasses: 0,
      verifiedFix: expect.objectContaining({ commit: 'fix1234abcd' }),
    });
    expect(after.debt.readyToRelease).toBe(1);
  });

  test('a verification older than the quarantine proposes nothing', async () => {
    await experiment('verify', 'verified', 7);
    // Quarantined now, well after the verification at hour 7.
    await addQuarantine(db as never, 1, 1, { reason: 'flaky' });
    expect((await listQuarantine(db as never, 1)).entries[0]).toMatchObject({
      releaseProposed: false,
      verifiedFix: null,
    });
  });

  test('a retry-pass after the verification withdraws the release proposal', async () => {
    await addQuarantine(db as never, 1, 1, { reason: 'flaky' });
    const quarantinedAt = await verifyAfterNow();
    expect((await listQuarantine(db as never, 1)).entries[0]).toMatchObject({ releaseReason: 'verified-fix' });

    const runId = ++runSeq;
    await db.insert(schema.testRuns).values({
      id: runId,
      projectId: 1,
      status: 'passed',
      startTime: new Date(quarantinedAt + 60_000),
      duration: 60_000,
      totalTests: 1,
    });
    await db.insert(schema.testRunsCases).values([
      { testRunId: runId, testCaseId: 1, status: 'failed', retries: 0, browser: { projectName: 'chromium' } },
      { testRunId: runId, testCaseId: 1, status: 'passed', retries: 1, browser: { projectName: 'chromium' } },
    ]);
    expect((await listQuarantine(db as never, 1)).entries[0]).toMatchObject({
      releaseProposed: false,
      releaseReason: null,
      verifiedFix: null,
    });
  });
});
