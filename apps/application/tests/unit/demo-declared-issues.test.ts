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
 * A tag the project's issue key pattern matches names an issue too, linked when it is of the binding's issue type.
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

const ISSUE_PATTERN = '^[A-Z][A-Z0-9]+-[0-9]+$';

/**
 * A run whose one test fails naming `issues` and carrying `tags`, finished as `finish` says; the cluster it failed
 * into. The project reads issue keys from tags when `tagKeys` is set.
 */
async function failNaming(
  issues: string[],
  finish: Partial<TestRunFinishPayload> = {},
  { tags = [], tagKeys = null }: { tags?: string[]; tagKeys?: string | null } = {},
) {
  const run = { projectName: 'demo-checkout', instanceId: 'ci-run-1' };
  const { runId, setupToken } = await apiSetupTestRun(run);
  if (tagKeys) await db.update(schema.projects).set({ tagKeys: { issue: tagKeys, testCase: null } });
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
        tags,
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

  test('links the Bug a tag names with the tag as its source, and leaves the Task it does not link out of the count', async () => {
    const clusterId = await failNaming(
      [],
      {},
      { tags: ['smoke', 'DEMO-52', 'DEMO-53', 'SHOP-1'], tagKeys: ISSUE_PATTERN },
    );

    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    expect(links.map((l) => [l.key, l.origin, l.statusText, l.metadata])).toEqual([
      [
        'DEMO-52',
        'tag',
        'To Do',
        expect.objectContaining({ source: { testCaseId: expect.any(Number), tag: '@DEMO-52' } }),
      ],
    ]);
    // DEMO-53 is a Task and the binding's issue type is Bug, so it is dropped and not counted; SHOP-1 is not in the
    // bound project.
    const [cluster] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, clusterId));
    expect(cluster!.declaredIssuesMore).toBe(0);
  });

  test('reads no tag when the project has no issue key pattern', async () => {
    const clusterId = await failNaming([], {}, { tags: ['DEMO-52'] });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    expect(links).toEqual([]);
  });

  test('links the annotation, not the tag, when both name the issue', async () => {
    const clusterId = await failNaming(['DEMO-52'], {}, { tags: ['DEMO-52'], tagKeys: ISSUE_PATTERN });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    expect(links.map((l) => [l.key, l.origin])).toEqual([['DEMO-52', 'annotation']]);
  });

  test('links nothing for a run the tracker use refuses', async () => {
    const clusterId = await failNaming(['DEMO-57'], { isFullRun: false });
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    expect(links).toEqual([]);
  });
});
