import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { TestRunFinishPayload } from '#shared/types';
import { migrateToLatest } from './temp-db';

/**
 * The demo runs the link step at a run's finish as the server does (`tests/unit/declared-issues.test.ts`), with its
 * canned Jira answering the lookup: the issues a failing test names in the DEMO project are linked to its cluster,
 * a key the demo's Jira does not know is counted in *and N more*, and a run the `tracker` use refuses links nothing.
 */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));

const { apiSetupTestRun, apiBeginTestRun, apiPostRunEvents, apiFinishTestRun } =
  await import('../../app/demo/api/reporter');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
});

/** A run whose one test fails naming `issues`, finished as `finish` says; the cluster it failed into. */
async function failNaming(issues: string[], finish: Partial<TestRunFinishPayload> = {}) {
  const run = { projectName: 'demo-checkout', instanceId: 'ci-run-1' };
  const { runId, setupToken } = await apiSetupTestRun(run);
  const { streamToken } = await apiBeginTestRun(runId, { setupToken, totalTests: 1, ...run });
  await apiPostRunEvents(runId, {
    streamToken,
    testCases: [
      {
        type: 'complete',
        title: 'pays with Apple Pay',
        location: 'tests/checkout.spec.ts:1:1',
        status: 'failed',
        duration: 10,
        error: "TimeoutError: locator.fill: Timeout 10000ms exceeded.\nwaiting for getByLabel('Email address')",
        testMeta: { issues },
      },
    ],
  });
  await apiFinishTestRun(runId, {
    streamToken,
    status: 'failed',
    duration: 1000,
    totalTests: 1,
    passedTests: 0,
    failedTests: 1,
    skippedTests: 0,
    flakyTests: 0,
    isFullRun: true,
    ...finish,
  });
  const [execution] = await db.select().from(schema.testRunsCases).where(eq(schema.testRunsCases.testRunId, runId));
  return execution!.failureClusterId!;
}

describe("the demo's link step", () => {
  test("links the issues the demo's Jira knows and counts the rest", async () => {
    const clusterId = await failNaming(['DEMO-57', 'https://demo.atlassian.net/browse/DEMO-61', 'DEMO-64', 'SHOP-1']);
    expect(clusterId).toBeTruthy();

    const links = await db
      .select()
      .from(schema.entityLinks)
      .where(eq(schema.entityLinks.failureClusterId, clusterId))
      .orderBy(schema.entityLinks.key);
    expect(links.map((l) => [l.key, l.origin, l.statusText, l.externalId, l.createdBy])).toEqual([
      ['DEMO-57', 'annotation', 'In Progress', '10057', null],
      ['DEMO-61', 'annotation', 'Done', '10061', null],
    ]);
    expect(links[0]!.url).toBe('https://demo.atlassian.net/browse/DEMO-57');
    // DEMO-64 is not in the demo's Jira; SHOP-1 is not in the bound project, so it is not named at all.
    const [cluster] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, clusterId));
    expect(cluster!.declaredIssuesMore).toBe(1);
  });

  test('links nothing for a run the tracker use refuses', async () => {
    const clusterId = await failNaming(['DEMO-57'], { isFullRun: false });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    expect(links).toEqual([]);
  });
});
