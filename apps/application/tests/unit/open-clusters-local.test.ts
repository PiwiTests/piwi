import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { countLocalOnlyClusters, getOpenFailureClusters } = await import('#shared/handlers/failure-clusters');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'laptop-only' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds a mug' },
    { id: 2, projectId: 2, filePath: 'tests/cart.spec.ts', title: 'adds a mug' },
  ]);
});

afterEach(async () => {
  await close();
});

/** A run of `projectId` from `origin`, its id. */
async function run(projectId: number, origin: string): Promise<number> {
  const [row] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'failed', startTime: new Date(), origin })
    .returning({ id: schema.testRuns.id });
  return row!.id;
}

/** An open cluster of `projectId`, failing in each of `runIds`, its id. */
async function cluster(projectId: number, signature: string, runIds: number[]): Promise<number> {
  const [row] = await db
    .insert(schema.failureClusters)
    .values({
      projectId,
      fingerprint: signature,
      signature,
      errorType: 'timeout',
      firstSeenRunId: runIds[0]!,
      lastSeenRunId: runIds[runIds.length - 1]!,
      occurrences: runIds.length,
    })
    .returning({ id: schema.failureClusters.id });
  for (const testRunId of runIds) {
    await db.insert(schema.testRunsCases).values({
      testRunId,
      testCaseId: projectId,
      status: 'failed',
      error: signature,
      failureClusterId: row!.id,
    });
  }
  return row!.id;
}

describe('the clusters seen only in developers’ own runs', () => {
  test('stay out of the team’s list when asked, in a project that has other runs too', async () => {
    const ci = await run(1, 'ci');
    const laptop = await run(1, 'local');
    const editor = await run(1, 'editor');
    const onlyLaptop = await run(2, 'local');
    const inCi = await cluster(1, 'checkout times out', [ci]);
    const wip = await cluster(1, 'new test, wrong locator', [laptop, editor]);
    const both = await cluster(1, 'cart is empty', [laptop, ci]);
    const solo = await cluster(2, 'solo project failure', [onlyLaptop]);

    const all = await getOpenFailureClusters(db as never, 'all', 50);
    expect(all.map((c) => [c.id, c.seenOnlyLocally]).sort()).toEqual(
      [
        [inCi, false],
        [wip, true],
        [both, false],
        [solo, false],
      ].sort(),
    );

    const team = await getOpenFailureClusters(db as never, 'all', 50, new Date(), { localOnly: 'exclude' });
    expect(team.map((c) => c.id).sort()).toEqual([inCi, both, solo].sort());
    expect(await countLocalOnlyClusters(db as never, 'all')).toBe(1);
    // Out of the caller's scope, it counts for nothing.
    expect(await countLocalOnlyClusters(db as never, new Set([2]))).toBe(0);
  });
});
