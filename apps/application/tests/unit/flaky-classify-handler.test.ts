import { describe, test, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules load.
delete process.env.PIWI_DATABASE_URL;
const { classifyAndPersistFlakyRootCause, classifyRunFlakyTests, withFlakyRootCauses } =
  await import('../../shared/handlers/flaky-classify');
const { runOrigin } = await import('../../shared/run-eligibility');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'checkout.spec.ts', title: 'pays' });
});

async function addRun(status: 'passed' | 'failed'): Promise<number> {
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId: 1, status, startTime: new Date(), duration: 60_000, totalTests: 1 })
    .returning({ id: schema.testRuns.id });
  return run!.id;
}

async function addAttempt(
  testRunId: number,
  retries: number,
  status: string,
  project: string,
  error: string | null = null,
  createdAt?: Date,
  testCaseId = 1,
): Promise<void> {
  await db.insert(schema.testRunsCases).values({
    ...(createdAt ? { createdAt } : {}),
    testRunId,
    testCaseId,
    status,
    retries,
    duration: 1_000,
    error,
    browserName: project,
    browser: { projectName: project, browserName: project },
  });
}

describe('classifyAndPersistFlakyRootCause', () => {
  test('reads the failed attempts of green runs that passed on retry', async () => {
    for (let i = 0; i < 3; i++) {
      const runId = await addRun('passed');
      await addAttempt(runId, 0, 'failed', 'chromium', 'Error: connect ECONNREFUSED 127.0.0.1:3000');
      await addAttempt(runId, 1, 'passed', 'chromium');
    }
    const result = await classifyAndPersistFlakyRootCause(db as any, 1, 1);
    expect(result.rootCause).toBe('network');
  });

  test('counts the passes of other browsers toward environment', async () => {
    for (let i = 0; i < 3; i++) {
      const runId = await addRun('passed');
      await addAttempt(runId, 0, 'failed', 'webkit', 'Error: something odd happened');
      await addAttempt(runId, 1, 'passed', 'webkit');
      await addAttempt(runId, 0, 'passed', 'chromium');
    }
    const result = await classifyAndPersistFlakyRootCause(db as any, 1, 1);
    expect(result.rootCause).toBe('environment');
  });

  test('keeps the failures of a rare flake behind many more recent passes', async () => {
    const start = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 3; i++) {
      const runId = await addRun('passed');
      await addAttempt(
        runId,
        0,
        'failed',
        'chromium',
        'Error: connect ECONNREFUSED 127.0.0.1:3000',
        new Date(start + i),
      );
    }
    for (let i = 0; i < 150; i++) {
      await addAttempt(await addRun('passed'), 0, 'passed', 'chromium', null, new Date(start + 1_000 + i * 1_000));
    }
    const result = await classifyAndPersistFlakyRootCause(db as any, 1, 1);
    expect(result.rootCause).toBe('network');
  });

  test('reads the real failures behind more newer lab-run failures than it reads', async () => {
    const start = Date.UTC(2026, 8, 1);
    for (let i = 0; i < 3; i++) {
      const runId = await addRun('passed');
      await addAttempt(
        runId,
        0,
        'failed',
        'chromium',
        'Error: connect ECONNREFUSED 127.0.0.1:3000',
        new Date(start + i),
      );
      await addAttempt(runId, 1, 'passed', 'chromium', null, new Date(start + i));
    }
    // A flake experiment replays the test under an injected slowdown.
    const labMetadata = { piwiFlakeLab: { experimentId: 'exp-1', armId: 'slow' } };
    for (let i = 0; i < 120; i++) {
      const [lab] = await db
        .insert(schema.testRuns)
        .values({
          projectId: 1,
          status: 'passed',
          startTime: new Date(start + 1_000 + i),
          metadata: labMetadata,
          origin: runOrigin(labMetadata),
        })
        .returning({ id: schema.testRuns.id });
      const at = new Date(start + 1_000 + i);
      await addAttempt(lab!.id, 0, 'failed', 'chromium', 'TimeoutError: Timeout 5000ms exceeded', at);
      await addAttempt(lab!.id, 1, 'passed', 'chromium', null, at);
    }
    const result = await classifyAndPersistFlakyRootCause(db as any, 1, 1);
    expect(result.rootCause).toBe('network');
  });

  test('stays other with no failed attempt', async () => {
    const runId = await addRun('passed');
    await addAttempt(runId, 0, 'passed', 'chromium');
    const result = await classifyAndPersistFlakyRootCause(db as any, 1, 1);
    expect(result.rootCause).toBe('other');
    expect(await storedRootCause(1)).toBe('other');
  });
});

async function storedRootCause(testCaseId: number): Promise<string | null> {
  const [row] = await db
    .select({ flakyRootCause: schema.testCases.flakyRootCause })
    .from(schema.testCases)
    .where(eq(schema.testCases.id, testCaseId));
  return row!.flakyRootCause;
}

async function addNetworkFlake(testCaseId: number, runId: number): Promise<void> {
  await addAttempt(runId, 0, 'failed', 'chromium', 'Error: connect ECONNREFUSED 127.0.0.1:3000', undefined, testCaseId);
  await addAttempt(runId, 1, 'passed', 'chromium', null, undefined, testCaseId);
}

describe('classifyRunFlakyTests', () => {
  beforeEach(async () => {
    await db.insert(schema.testCases).values([
      { id: 2, projectId: 1, filePath: 'checkout.spec.ts', title: 'refunds' },
      { id: 3, projectId: 1, filePath: 'checkout.spec.ts', title: 'browses' },
    ]);
  });

  test('classifies the tests that passed on retry in the run and no others', async () => {
    const otherRun = await addRun('passed');
    await addNetworkFlake(3, otherRun);
    const runId = await addRun('passed');
    await addNetworkFlake(1, runId);
    await addAttempt(runId, 0, 'passed', 'chromium', null, undefined, 2);

    await classifyRunFlakyTests(db as any, 1, runId);

    expect(await storedRootCause(1)).toBe('network');
    expect(await storedRootCause(2)).toBeNull();
    expect(await storedRootCause(3)).toBeNull();
  });

  test('reclassifies a test that already has a category from its newer evidence', async () => {
    await db.update(schema.testCases).set({ flakyRootCause: 'other' }).where(eq(schema.testCases.id, 1));
    const runId = await addRun('passed');
    await addNetworkFlake(1, runId);

    await classifyRunFlakyTests(db as any, 1, runId);

    expect(await storedRootCause(1)).toBe('network');
  });

  test('classifies nothing for a run with no retry-passed test', async () => {
    const runId = await addRun('failed');
    await addAttempt(runId, 0, 'failed', 'chromium', 'Error: connect ECONNREFUSED 127.0.0.1:3000');

    await classifyRunFlakyTests(db as any, 1, runId);

    expect(await storedRootCause(1)).toBeNull();
  });
});

describe('withFlakyRootCauses', () => {
  const item = (testCaseId: number, rootCause: string | null = null) => ({ testCaseId, rootCause });

  test('classifies and stores the root cause of the items that have none', async () => {
    const runId = await addRun('passed');
    await addNetworkFlake(1, runId);

    const items = await withFlakyRootCauses(db as any, 1, [item(1)]);

    expect(items).toEqual([item(1, 'network')]);
    expect(await storedRootCause(1)).toBe('network');
  });

  test('leaves the items that already have a root cause as they are', async () => {
    await db.update(schema.testCases).set({ flakyRootCause: 'timing' }).where(eq(schema.testCases.id, 1));
    const runId = await addRun('passed');
    await addNetworkFlake(1, runId);
    const items = [item(1, 'timing')];

    expect(await withFlakyRootCauses(db as any, 1, items)).toBe(items);
    expect(await storedRootCause(1)).toBe('timing');
  });

  test('classifies at most ten items per call, first in the list first', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 10);
    await db
      .insert(schema.testCases)
      .values(ids.map((id) => ({ id, projectId: 1, filePath: 'checkout.spec.ts', title: `case ${id}` })));

    const items = await withFlakyRootCauses(
      db as any,
      1,
      ids.map((id) => item(id)),
    );

    expect(items.filter((i) => i.rootCause).map((i) => i.testCaseId)).toEqual(ids.slice(0, 10));
    expect(await storedRootCause(ids[11]!)).toBeNull();
  });

  test('skips a test it cannot classify instead of failing the read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const runId = await addRun('passed');
      await addNetworkFlake(1, runId);

      const items = await withFlakyRootCauses(db as any, 1, [item(999), item(1)]);

      expect(items).toEqual([item(999), item(1, 'network')]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the flaky-tests read on the server and in the demo', () => {
  const sources = ['../../server/api/projects/[id]/flaky-tests.get.ts', '../../app/demo/api/router.ts'];
  for (const rel of sources) {
    test(`${rel} fills in the missing root causes through the shared helper`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src).toContain('withFlakyRootCauses(');
    });
  }
});
