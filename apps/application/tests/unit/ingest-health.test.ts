import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { addIngestHealth, carryIngestHealth, describeIngestHealth, readIngestHealth } from '../../shared/ingest-health';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { recordIngestHealth } = await import('../../server/utils/ingest-health');
const { sanitizeMetadata, capSteps, countDroppedSteps } = await import('../../server/utils/sanitize');
const { DEFAULT_INGEST_LIMITS } = await import('../../shared/ingest-limits');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'ingest-health' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'running',
    startTime: new Date(),
    metadata: { ci: { provider: 'github' } },
  });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  process.env.PIWI_INGEST_MAX_STEPS = '20';
  process.env.PIWI_INGEST_MAX_CONSOLE_ENTRIES = '25';
});

afterEach(() => {
  delete process.env.PIWI_INGEST_MAX_STEPS;
  delete process.env.PIWI_INGEST_MAX_CONSOLE_ENTRIES;
});

async function runMetadata() {
  const [run] = await db
    .select({ metadata: schema.testRuns.metadata })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, 1));
  return run!.metadata as Record<string, unknown>;
}

const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ title: `step ${i}`, category: 'pw:api', duration: 1 }));
const consoleLogs = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'log', text: `line ${i}` }));

describe('ingest health on persisted executions', () => {
  test('records the steps and console entries the caps left out, adding up across batches', async () => {
    await persistRunCases(db as never, 1, 1, [
      { title: 'a', filePath: 'a.spec.ts', status: 'passed', steps: steps(25), consoleLogs: consoleLogs(30) },
      { title: 'b', filePath: 'a.spec.ts', status: 'passed', steps: steps(5) },
    ] as never);
    // 25 steps under a cap of 20 keep 19 and a marker: six dropped. Thirty console entries under 25: five.
    expect((await runMetadata()).ingestHealth).toEqual({ stepsDropped: 6, consoleEntriesDropped: 5 });

    await persistRunCases(db as never, 1, 1, [
      { title: 'c', filePath: 'a.spec.ts', status: 'passed', steps: steps(22) },
    ] as never);
    const metadata = await runMetadata();
    expect(metadata.ingestHealth).toEqual({ stepsDropped: 9, consoleEntriesDropped: 5 });
    // The run's other metadata stays.
    expect(metadata.ci).toEqual({ provider: 'github' });
  });

  test('a batch stored again counts nothing twice', async () => {
    const batch = [{ title: 'a', filePath: 'a.spec.ts', status: 'passed', browser: 'chromium', steps: steps(25) }];
    await persistRunCases(db as never, 1, 1, batch as never);
    await persistRunCases(db as never, 1, 1, batch as never);
    expect((await runMetadata()).ingestHealth).toEqual({ stepsDropped: 6 });
  });

  test('a run stored whole carries no ingest health', async () => {
    await persistRunCases(db as never, 1, 1, [
      { title: 'a', filePath: 'a.spec.ts', status: 'passed', steps: steps(3), consoleLogs: consoleLogs(3) },
    ] as never);
    expect((await runMetadata()).ingestHealth).toBeUndefined();
  });

  test('traces skipped and evidence rebuilt from a trace add to the counts', async () => {
    await recordIngestHealth(db as never, 1, { tracesSkipped: 2 });
    await recordIngestHealth(db as never, 1, { evidenceFromTrace: 1 });
    await recordIngestHealth(db as never, 1, { evidenceFromTrace: 1, consoleEntriesDropped: 0 });
    expect((await runMetadata()).ingestHealth).toEqual({ tracesSkipped: 2, evidenceFromTrace: 2 });
  });
});

describe('the step cap count', () => {
  test('matches the steps capSteps leaves out', () => {
    const limits = { ...DEFAULT_INGEST_LIMITS, steps: 10 };
    const capped = capSteps(steps(15), limits) as Array<{ title: string }>;
    expect(capped).toHaveLength(10);
    expect(capped.find((s) => s.title.endsWith('not stored'))?.title).toBe(
      `${countDroppedSteps(steps(15), limits)} steps not stored`,
    );
    expect(countDroppedSteps(steps(10), limits)).toBe(0);
  });
});

describe('the reporter fallback and the server counts', () => {
  test('metadata a reporter sends keeps only its submit fallback', () => {
    const sent = {
      scm: { branch: 'main' },
      ingestHealth: { stepsDropped: 999, submitFallback: { path: 'upload', reason: 'finish-failed' } },
    };
    expect(sanitizeMetadata(sent)).toEqual({
      scm: { branch: 'main' },
      ingestHealth: { submitFallback: { path: 'upload', reason: 'finish-failed' } },
    });
    expect(sanitizeMetadata({ ingestHealth: { tracesSkipped: 3 } })).toEqual({});
    expect(sanitizeMetadata({ ingestHealth: { submitFallback: { path: 'carrier-pigeon' } } })).toEqual({});
  });

  test('a metadata write keeps the stored counts and takes the incoming fallback', () => {
    const stored = { ingestHealth: { stepsDropped: 4, submitFallback: { path: 'upload' } } };
    expect(carryIngestHealth({ scm: { branch: 'main' } }, stored)).toEqual({
      scm: { branch: 'main' },
      ingestHealth: { stepsDropped: 4, submitFallback: { path: 'upload' } },
    });
    expect(
      carryIngestHealth({ ingestHealth: { submitFallback: { path: 'submit', reason: 'upload-failed' } } }, stored),
    ).toEqual({ ingestHealth: { stepsDropped: 4, submitFallback: { path: 'submit', reason: 'upload-failed' } } });
    expect(carryIngestHealth({ a: 1 }, null)).toEqual({ a: 1 });
  });

  test('a recorded fallback reads back alongside the counts', async () => {
    await recordIngestHealth(db as never, 1, { submitFallback: { path: 'recovery' } });
    await recordIngestHealth(db as never, 1, { stepsDropped: 2 });
    expect(readIngestHealth(await runMetadata())).toEqual({ stepsDropped: 2, submitFallback: { path: 'recovery' } });
  });
});

describe('describeIngestHealth', () => {
  test('one sentence per thing ingest dropped or rebuilt', () => {
    expect(
      describeIngestHealth({
        stepsDropped: 1240,
        consoleEntriesDropped: 1,
        tracesSkipped: 2,
        evidenceFromTrace: 3,
        submitFallback: { path: 'upload', reason: 'finish-failed' },
      }),
    ).toEqual([
      '1,240 steps not stored: the step cap kept the failing steps',
      '1 console entry not stored: the console cap kept the first and the latest',
      '2 traces sent but not stored',
      'Console, network or ARIA evidence of 3 executions rebuilt from the trace',
      'Delivered by the batch upload instead of the live stream: finishing the live stream failed',
    ]);
    expect(describeIngestHealth(null)).toEqual([]);
  });

  test('addIngestHealth drops zero counts', () => {
    expect(addIngestHealth(null, { stepsDropped: 0 })).toBeNull();
    expect(addIngestHealth({ tracesSkipped: 1 }, { tracesSkipped: 2 })).toEqual({ tracesSkipped: 3 });
  });
});

describe('the AI context', () => {
  test("the run context says what ingest left out of the execution's run", async () => {
    const { runContextSection } = await import('../../server/utils/ai-context');
    const rep = {
      runIsFullRun: 1,
      runMetadata: { ingestHealth: { stepsDropped: 30, submitFallback: { path: 'upload' } } },
    } as unknown as Parameters<typeof runContextSection>[0];
    const markdown = runContextSection(rep);
    expect(markdown).toContain('Stored incomplete');
    expect(markdown).toContain('30 steps not stored');
    expect(markdown).toContain('Delivered by the batch upload instead of the live stream');
    expect(runContextSection({ runIsFullRun: 1, runMetadata: {} } as unknown as typeof rep)).toBeNull();
  });
});
