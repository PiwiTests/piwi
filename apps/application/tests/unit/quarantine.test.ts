import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before importing the handler (which imports the barrel).
delete process.env.PIWI_DATABASE_URL;
const { addQuarantine, listQuarantine, releaseQuarantine, getQuarantinedCaseIds, RELEASE_AFTER_CONSECUTIVE_PASSES } =
  await import('../../shared/handlers/quarantine');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;
let caseSeq = 0;

async function seedCase(title: string): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({ id, projectId: 1, filePath: 'tests/a.spec.ts', title });
  return id;
}

type Attempt = { status: string; retries?: number; browserName?: string; repeatEachIndex?: number };

/**
 * One run recording `attempts` of `testCaseId`, started a minute after anything seeded before it (a quarantine made
 * meanwhile included), unless `startTime` says otherwise. Returns the run id.
 */
async function seedRun(
  testCaseId: number,
  attempts: Attempt[],
  opts: { metadata?: object | null; startTime?: Date } = {},
): Promise<number> {
  const runId = ++runSeq;
  vi.setSystemTime(Date.now() + 60_000);
  const metadata = opts.metadata ?? null;
  await db.insert(schema.testRuns).values({
    id: runId,
    projectId: 1,
    status: attempts.some((a) => a.status !== 'passed') ? 'failed' : 'passed',
    startTime: opts.startTime ?? new Date(),
    metadata,
    origin: runOrigin(metadata),
  });
  await db.insert(schema.testRunsCases).values(
    attempts.map((a) => ({
      testRunId: runId,
      testCaseId,
      status: a.status,
      retries: a.retries ?? 0,
      browserName: a.browserName ?? 'chromium',
      repeatEachIndex: a.repeatEachIndex ?? 0,
    })),
  );
  return runId;
}

/** One run recording `status` for `testCaseId`. Returns the run id. */
async function seedExecution(testCaseId: number, status: string, metadata: object | null = null): Promise<number> {
  return seedRun(testCaseId, [{ status }], { metadata });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 1) });
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'quarantine-project' });
  runSeq = 0;
  caseSeq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('addQuarantine', () => {
  test('records a quarantine and reports it as created', async () => {
    const caseId = await seedCase('wobbly');
    expect(await addQuarantine(db, 1, caseId, { reason: 'flaky on CI' })).toEqual({ created: true });

    const { entries } = await listQuarantine(db, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ testCaseId: caseId, reason: 'flaky on CI', source: 'manual' });
  });

  // Re-quarantining must not reset the streak, or a test can never get out.
  test('is idempotent and preserves the original entry', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId, { reason: 'first' });
    expect(await addQuarantine(db, 1, caseId, { reason: 'second' })).toEqual({ created: false });

    const { entries } = await listQuarantine(db, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason).toBe('first');
  });

  test('refuses a test case from another project', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'other-project' });
    const caseId = await seedCase('wobbly');
    await expect(addQuarantine(db, 2, caseId)).rejects.toThrow(/not found in this project/);
  });

  test('stores no creator when the request has no real user', async () => {
    const caseId = await seedCase('wobbly');
    // With auth disabled the caller is a synthetic user with id 0, which no
    // `users` row has — storing it would trip the foreign key.
    await expect(addQuarantine(db, 1, caseId, { createdBy: 0 })).resolves.toEqual({ created: true });
  });
});

describe('release streaks', () => {
  test('counts only runs started after the quarantine', async () => {
    const caseId = await seedCase('wobbly');
    // A long green history before quarantining must not count — the reason the
    // test was quarantined is that its history is untrustworthy.
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES + 2; i++) await seedExecution(caseId, 'passed');
    await addQuarantine(db, 1, caseId);

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(0);
    expect(entries[0]!.releaseProposed).toBe(false);
    expect(entries[0]!.runsSinceQuarantine).toBe(0);
  });

  test('proposes release once the streak clears the threshold', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) await seedExecution(caseId, 'passed');

    const { entries, debt } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(RELEASE_AFTER_CONSECUTIVE_PASSES);
    expect(entries[0]!.releaseProposed).toBe(true);
    expect(debt.readyToRelease).toBe(1);
  });

  test('lab, bisect, reproduction and incident runs neither count toward nor break the streak', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'passed');
    const lab = { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' } };
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) await seedExecution(caseId, 'passed', lab);
    await seedExecution(caseId, 'failed', lab);
    await seedExecution(caseId, 'failed', { piwiProbe: true });
    await seedExecution(caseId, 'failed', { piwiOrigin: { kind: 'bisect' } });
    await seedExecution(caseId, 'failed', { piwiOrigin: { kind: 'reproduce' } });
    await seedExecution(caseId, 'failed', { piwiOrigin: { kind: 'ci' }, incident: { reason: 'staging was down' } });

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(1);
    expect(entries[0]!.runsSinceQuarantine).toBe(1);
    expect(entries[0]!.releaseProposed).toBe(false);
  });

  test('one failure resets the streak', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) await seedExecution(caseId, 'passed');
    await seedExecution(caseId, 'failed');

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(0);
    expect(entries[0]!.releaseProposed).toBe(false);
  });

  test('counts the streak back from the newest run, not the oldest', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'passed');
    await seedExecution(caseId, 'failed');
    await seedExecution(caseId, 'passed');
    await seedExecution(caseId, 'passed');

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(2);
  });

  // An older report imported after the quarantine gets a newer run id, but it ran before.
  test('a run reported after the quarantine but started before it does not count', async () => {
    const caseId = await seedCase('wobbly');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await addQuarantine(db, 1, caseId);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) {
      await seedRun(caseId, [{ status: 'passed' }], { startTime: anHourAgo });
    }

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]).toMatchObject({ consecutivePasses: 0, runsSinceQuarantine: 0, releaseProposed: false });
  });

  test('counts a run once, whatever its projects and repetitions', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    // Five browser projects, each with `--repeat-each 5`.
    const browsers = ['chromium', 'firefox', 'webkit', 'mobile-chrome', 'mobile-safari'];
    await seedRun(
      caseId,
      browsers.flatMap((browserName) =>
        [0, 1, 2, 3, 4].map((repeatEachIndex) => ({ status: 'passed', browserName, repeatEachIndex })),
      ),
    );

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]).toMatchObject({ consecutivePasses: 1, runsSinceQuarantine: 1, releaseProposed: false });
  });

  test('a run fails when one of its projects or repetitions failed', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'passed');
    await seedRun(caseId, [
      { status: 'passed', browserName: 'chromium' },
      { status: 'failed', browserName: 'firefox' },
    ]);
    await seedExecution(caseId, 'passed');
    expect((await listQuarantine(db, 1)).entries[0]!.consecutivePasses).toBe(1);

    await seedRun(caseId, [
      { status: 'passed', repeatEachIndex: 0 },
      { status: 'failed', repeatEachIndex: 1 },
    ]);
    expect((await listQuarantine(db, 1)).entries[0]!.consecutivePasses).toBe(0);
  });

  test('a pass on a retry resets the streak, and the run counts once', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    for (let i = 0; i < RELEASE_AFTER_CONSECUTIVE_PASSES; i++) await seedExecution(caseId, 'passed');
    await seedRun(caseId, [
      { status: 'failed', retries: 0 },
      { status: 'passed', retries: 1 },
    ]);

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]).toMatchObject({
      consecutivePasses: 0,
      runsSinceQuarantine: RELEASE_AFTER_CONSECUTIVE_PASSES + 1,
      releaseProposed: false,
    });
  });

  test('a run that skipped the test in one project counts as a pass when it passed in the others', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedRun(caseId, [
      { status: 'passed', browserName: 'chromium' },
      { status: 'skipped', browserName: 'webkit' },
    ]);

    expect((await listQuarantine(db, 1)).entries[0]!.consecutivePasses).toBe(1);
  });

  // A skip proves nothing either way — counting it would manufacture a release,
  // and breaking on it would make a quarantined-and-skipped test unreleasable.
  test.each(['skipped', 'didnotrun'])('a %s execution neither counts nor breaks the streak', async (status) => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'passed');
    await seedExecution(caseId, status);
    await seedExecution(caseId, 'passed');

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(2);
  });

  test('a timed-out execution breaks the streak like a failure', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'passed');
    await seedExecution(caseId, 'timedOut');

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(0);
  });
});

describe('streak queries', () => {
  test('the number of queries does not grow with the quarantine list', async () => {
    const one = await seedCase('one');
    await addQuarantine(db, 1, one);
    await seedExecution(one, 'passed');

    const select = vi.spyOn(db, 'select');
    await listQuarantine(db, 1);
    const queriesForOne = select.mock.calls.length;

    for (const title of ['two', 'three', 'four', 'five']) {
      const caseId = await seedCase(title);
      await addQuarantine(db, 1, caseId);
      await seedExecution(caseId, 'passed');
    }

    select.mockClear();
    const { entries } = await listQuarantine(db, 1);
    expect(entries).toHaveLength(5);
    expect(select.mock.calls.length).toBe(queriesForOne);
    select.mockRestore();
  });

  test('reads the streaks of a thousand quarantined tests', async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => i + 1);
    await db
      .insert(schema.testCases)
      .values(ids.map((id) => ({ id, projectId: 1, filePath: 'tests/a.spec.ts', title: `test ${id}` })));
    caseSeq = ids.length;
    await db.insert(schema.quarantinedTests).values(ids.map((testCaseId) => ({ projectId: 1, testCaseId })));
    await seedExecution(1, 'passed');

    const { entries } = await listQuarantine(db, 1);
    expect(entries).toHaveLength(1_000);
    expect(entries.find((entry) => entry.testCaseId === 1)!.runsSinceQuarantine).toBe(1);
  });

  test('scans at most the newest runs of each test', async () => {
    const caseId = await seedCase('long-history');
    await addQuarantine(db, 1, caseId);
    await seedExecution(caseId, 'failed');
    for (let i = 0; i < 40; i++) await seedExecution(caseId, 'passed');

    const { entries } = await listQuarantine(db, 1);
    expect(entries[0]!.consecutivePasses).toBe(30);
    expect(entries[0]!.runsSinceQuarantine).toBe(30);
  });
});

describe('debt', () => {
  test('separates tests that have never run from ones still failing', async () => {
    const untouched = await seedCase('never run since quarantine');
    const failing = await seedCase('still failing');
    const recovering = await seedCase('recovering');

    await addQuarantine(db, 1, untouched);
    await addQuarantine(db, 1, failing);
    await addQuarantine(db, 1, recovering);

    await seedExecution(failing, 'failed');
    await seedExecution(recovering, 'passed');

    const { debt } = await listQuarantine(db, 1);
    expect(debt.active).toBe(3);
    // "Still failing" means it ran and did not pass — a test nothing has
    // exercised yet is unknown, not broken.
    expect(debt.stillFailing).toBe(1);
    expect(debt.readyToRelease).toBe(0);
  });
});

describe('releaseQuarantine', () => {
  test('releases an active quarantine and keeps the row as history', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    expect(await releaseQuarantine(db, 1, caseId, 'stable now')).toEqual({ released: true });

    expect((await listQuarantine(db, 1)).entries).toEqual([]);
    const rows = await db.select().from(schema.quarantinedTests);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.releasedReason).toBe('stable now');
  });

  test('reports nothing released when there is no active quarantine', async () => {
    const caseId = await seedCase('wobbly');
    expect(await releaseQuarantine(db, 1, caseId)).toEqual({ released: false });
  });

  // Releasing then re-quarantining is a new episode with a fresh streak.
  test('a released test can be quarantined again', async () => {
    const caseId = await seedCase('wobbly');
    await addQuarantine(db, 1, caseId);
    await releaseQuarantine(db, 1, caseId);
    expect(await addQuarantine(db, 1, caseId, { reason: 'regressed' })).toEqual({ created: true });

    const { entries } = await listQuarantine(db, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason).toBe('regressed');
  });
});

describe('getQuarantinedCaseIds', () => {
  test('returns only active quarantines, scoped to the project', async () => {
    const active = await seedCase('active');
    const released = await seedCase('released');
    await addQuarantine(db, 1, active);
    await addQuarantine(db, 1, released);
    await releaseQuarantine(db, 1, released);

    expect(await getQuarantinedCaseIds(db, 1)).toEqual(new Set([active]));
    expect(await getQuarantinedCaseIds(db, 2)).toEqual(new Set());
  });
});
