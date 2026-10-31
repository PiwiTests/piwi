import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * Filing an issue for a cluster and keeping it, against a SQLite database and a
 * stubbed Jira: the cluster page, an execution of the cluster and a rule share
 * one filing, an issue whose link was removed or that is Done does not answer a
 * new create, a rule that finds an open issue with the failure's labels leaves
 * it to a person (unless the cluster already links it), and the sync's resolve
 * and reopen policies act on a move of the ticket, never on where it stands,
 * for an issue filed or linked.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { createIssue } = await import('../../server/utils/integrations/create');
const { syncTrackerLinks } = await import('../../server/utils/integrations/sync');
const { deleteLink } = await import('../../shared/handlers/links');
const { createEnrichedLink } = await import('../../server/utils/integrations/link-create');
const { runTrackerAutomation } = await import('../../server/utils/integrations/automation');
const { DEFAULT_AUTO_CREATE_RULE } = await import('../../shared/integrations/automation');
const { clusterIssueFilings } = await import('../../shared/handlers/known-issues');

const SITE = 'https://refile.atlassian.net';

let created: string[] = [];
/** The issues the label search finds, by key; it keeps those not Done, as Jira's would. */
let labeled: string[] = [];
let issueSeq = 0;
/** The category each stub issue reads back with, by key. */
const categories = new Map<string, 'new' | 'indeterminate' | 'done'>();
const STATUS_NAME = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stub Jira: an empty create screen, create, and read-back by key or id. */
async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/createmeta\//.test(url.pathname)) return json({ total: 0, fields: [] });
  // The issues a test says carry a failure's labels; none by default.
  if (url.pathname === '/rest/api/3/search/jql') {
    return json({
      issues: labeled.map((key) => {
        const category = categories.get(key) ?? 'new';
        return {
          id: String(10000 + Number(key.split('-')[1])),
          key,
          fields: { summary: 'Broken', status: { name: STATUS_NAME[category], statusCategory: { key: category } } },
        };
      }),
    });
  }
  if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
    issueSeq += 1;
    const key = `PROJ-${issueSeq}`;
    created.push(key);
    categories.set(key, 'new');
    return json({ id: String(10000 + issueSeq), key }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+|\d+)$/.exec(url.pathname);
  if (read) {
    const ref = read[1]!;
    const key = /^\d+$/.test(ref) ? `PROJ-${Number(ref) - 10000}` : ref;
    const category = categories.get(key);
    if (!category) return json({ errorMessages: ['Not found'] }, 404);
    return json({
      id: String(10000 + Number(key.split('-')[1])),
      key,
      fields: { summary: 'Broken', status: { name: STATUS_NAME[category], statusCategory: { key: category } } },
    });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-refile-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;

  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2, 3, 4]) {
    await db.insert(schema.testCases).values({ id, projectId: 1, title: `test ${id}`, filePath: 'tests/a.spec.ts' });
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    await db.insert(schema.testRunsCases).values({
      id: 100 + id,
      testRunId: 1,
      testCaseId: id,
      status: 'failed',
      error: `Error: broken ${id}`,
      failureClusterId: id,
    });
  }
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Refile Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
  // Issues are filed through the connection the project is bound to.
  await writeProjectIntegration(dbc, 1, { connectionId, projectKey: 'PROJ', issueType: 'Bug' });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  created = [];
  labeled = [];
});

function file(entityType: 'failure_cluster' | 'test_runs_case', entityId: number) {
  return createIssue(dbc, {
    entityType,
    entityId,
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    title: 'Broken',
  });
}

async function clusterLinks(clusterId: number) {
  return db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
}

async function setPolicies(policies: { resolveOnClose?: boolean; reopenOnTicketReopen?: boolean }) {
  await writeProjectIntegration(dbc, 1, {
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    policies: { resolveOnClose: false, reopenOnTicketReopen: false, ...policies },
  });
}

async function clusterRow(id: number) {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, id));
  return row!;
}

describe('filing once per cluster', () => {
  test('a create from an execution answers with the issue its cluster already has', async () => {
    const first = await file('failure_cluster', 1);
    expect(first).toMatchObject({ status: 'done', key: 'PROJ-1' });
    expect(first?.alreadyFiled).toBeUndefined();

    const again = await file('test_runs_case', 101);
    expect(again).toMatchObject({ status: 'done', key: 'PROJ-1', alreadyFiled: true });
    expect(created).toEqual(['PROJ-1']);
    expect(await clusterLinks(1)).toHaveLength(1);
  });

  test('a create from the cluster answers with the issue an execution filed', async () => {
    const first = await file('test_runs_case', 102);
    expect(first).toMatchObject({ status: 'done' });
    const again = await file('failure_cluster', 2);
    expect(again).toMatchObject({ status: 'done', key: first!.key, alreadyFiled: true });
    expect(created).toHaveLength(1);
  });

  test('the filing is recorded against the cluster', async () => {
    await file('test_runs_case', 103);
    const actions = await db.select().from(schema.integrationActions);
    const forCluster3 = actions.find((a) => a.dedupeKey === `create-issue:failure_cluster:3:conn${connectionId}`);
    expect(forCluster3).toMatchObject({ entityType: 'failure_cluster', entityId: 3, status: 'done' });
  });
});

describe('filing again after the link was removed', () => {
  test('files a new issue and links it, instead of answering with the unlinked one', async () => {
    const first = await file('failure_cluster', 4);
    const [link] = await clusterLinks(4);
    expect(link?.key).toBe(first!.key);

    await deleteLink(db as never, link!.id);
    const again = await file('failure_cluster', 4);
    expect(again?.status).toBe('done');
    expect(again?.alreadyFiled).toBeUndefined();
    expect(again?.key).not.toBe(first!.key);
    expect((await clusterLinks(4)).map((l) => l.key)).toEqual([again!.key]);

    // The first filing stays as history, under a retired key.
    const actions = await db.select().from(schema.integrationActions);
    const live = actions.filter((a) => a.dedupeKey === `create-issue:failure_cluster:4:conn${connectionId}`);
    expect(live).toHaveLength(1);
    expect(
      actions.some((a) => a.dedupeKey.startsWith(`create-issue:failure_cluster:4:conn${connectionId}:retired:`)),
    ).toBe(true);

    // The new filing is the answer from now on.
    const third = await file('test_runs_case', 104);
    expect(third).toMatchObject({ key: again!.key, alreadyFiled: true });
  });
});

describe('filing again once the issue is Done', () => {
  test('files a new issue next to the Done one, which stays linked', async () => {
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: 1,
        fingerprint: 'fp-done',
        signature: 'Error: broken done',
        errorType: 'unknown',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
      })
      .returning({ id: schema.failureClusters.id });
    const first = await file('failure_cluster', cluster!.id);
    const [link] = await clusterLinks(cluster!.id);
    await db
      .update(schema.entityLinks)
      .set({ metadata: { statusCategory: 'done' } as never })
      .where(eq(schema.entityLinks.id, link!.id));

    const again = await file('failure_cluster', cluster!.id);
    expect(again?.alreadyFiled).toBeUndefined();
    expect(again?.key).not.toBe(first!.key);
    expect((await clusterLinks(cluster!.id)).map((l) => l.key).sort()).toEqual([first!.key, again!.key].sort());
  });
});

describe('sync policies act on a move of the ticket', () => {
  async function linkOf(clusterId: number) {
    const [link] = await clusterLinks(clusterId);
    return link!;
  }

  test('a created link records the status category it was created with', async () => {
    const link = await linkOf(1);
    expect((link.metadata as { statusCategory?: string } | null)?.statusCategory).toBe('new');
  });

  test('a ticket moved to Done resolves the cluster once, and a reopened cluster stays open', async () => {
    await setPolicies({ resolveOnClose: true });
    const link = await linkOf(1);
    categories.set(link.key!, 'done');
    await syncTrackerLinks(dbc);
    expect((await clusterRow(1)).status).toBe('resolved');

    // A person reopens the cluster while the ticket stays Done: no move, no resolve.
    await db.update(schema.failureClusters).set({ status: 'open' }).where(eq(schema.failureClusters.id, 1));
    await syncTrackerLinks(dbc);
    expect((await clusterRow(1)).status).toBe('open');
  });

  test('a regressed cluster is not closed by its ticket moving to Done', async () => {
    await setPolicies({ resolveOnClose: true });
    await db
      .update(schema.failureClusters)
      .set({ fixVerification: 'regressed' })
      .where(eq(schema.failureClusters.id, 2));
    const link = await linkOf(2);
    categories.set(link.key!, 'done');
    await syncTrackerLinks(dbc);
    expect((await clusterRow(2)).status).toBe('open');
  });

  test('a cluster resolved by hand while its ticket is open is not reopened', async () => {
    await setPolicies({ reopenOnTicketReopen: true });
    await db.update(schema.failureClusters).set({ status: 'resolved' }).where(eq(schema.failureClusters.id, 3));
    await syncTrackerLinks(dbc, { now: new Date(Date.now() + 2 * 24 * 3600_000) });
    expect((await clusterRow(3)).status).toBe('resolved');

    // The ticket moving out of Done does reopen it.
    const link = await linkOf(3);
    categories.set(link.key!, 'done');
    await syncTrackerLinks(dbc, { now: new Date(Date.now() + 4 * 24 * 3600_000) });
    categories.set(link.key!, 'indeterminate');
    await syncTrackerLinks(dbc, { now: new Date(Date.now() + 6 * 24 * 3600_000) });
    expect((await clusterRow(3)).status).toBe('open');
  });

  test("a linked issue's first move to Done resolves the cluster, as for a filed one", async () => {
    await setPolicies({ resolveOnClose: true });
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: 1,
        fingerprint: 'fp-pinned',
        signature: 'Error: broken pinned',
        errorType: 'unknown',
        firstSeenRunId: 1,
        lastSeenRunId: 1,
      })
      .returning({ id: schema.failureClusters.id });
    categories.set('PROJ-900', 'indeterminate');
    const link = await createEnrichedLink(dbc, {
      entityType: 'failure_cluster',
      entityId: cluster!.id,
      url: `${SITE}/browse/PROJ-900`,
    });
    expect(link?.connectionId).toBe(connectionId);
    expect((link?.metadata as { statusCategory?: string } | null)?.statusCategory).toBe('indeterminate');

    categories.set('PROJ-900', 'done');
    await syncTrackerLinks(dbc);
    expect((await clusterRow(cluster!.id)).status).toBe('resolved');
  });
});

describe('a rule files through the same per-cluster filing', () => {
  test('once per cluster, and a new issue once the first is Done', async () => {
    await db.insert(schema.testRuns).values({ id: 2, projectId: 1, status: 'failed', startTime: new Date() });
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: 1,
        fingerprint: 'fp-rule',
        signature: 'Error: broken by rule',
        errorType: 'unknown',
        firstSeenRunId: 2,
        lastSeenRunId: 2,
      })
      .returning({ id: schema.failureClusters.id });
    await db.insert(schema.testRunsCases).values({
      id: 200,
      testRunId: 2,
      testCaseId: 1,
      status: 'failed',
      error: 'Error: broken by rule',
      failureClusterId: cluster!.id,
    });
    await writeProjectIntegration(dbc, 1, {
      connectionId,
      projectKey: 'PROJ',
      issueType: 'Bug',
      autoCreate: {
        enabled: true,
        rules: [{ ...DEFAULT_AUTO_CREATE_RULE, defaultBranch: false, minOccurrences: 1, minRuns: 1 }],
        skipFlaky: true,
        dailyCap: 5,
        routeUnmatchedToDefault: false,
      },
    });

    expect(await runTrackerAutomation(dbc, 2)).toBe(1);
    const [first] = await clusterLinks(cluster!.id);
    expect(created).toEqual([first!.key]);

    // The issue tracks the cluster: the next failing run files nothing.
    expect(await runTrackerAutomation(dbc, 2)).toBe(0);
    expect(created).toHaveLength(1);

    // Done while the failure goes on: the rule files a new issue, the Done one stays linked.
    await db
      .update(schema.entityLinks)
      .set({ metadata: { statusCategory: 'done' } as never })
      .where(eq(schema.entityLinks.id, first!.id));
    expect(await runTrackerAutomation(dbc, 2)).toBe(1);
    expect(created).toHaveLength(2);
    expect((await clusterLinks(cluster!.id)).map((l) => l.key).sort()).toEqual([...created].sort());
    expect(await runTrackerAutomation(dbc, 2)).toBe(0);
  });
});

describe("a rule that finds an open issue with the failure's labels", () => {
  /** A cluster failing in a run of its own, whose rule-filed issue the last sync read Done. */
  async function clusterWithDoneIssue(runId: number, fingerprint: string) {
    await writeProjectIntegration(dbc, 1, {
      connectionId,
      projectKey: 'PROJ',
      issueType: 'Bug',
      autoCreate: {
        enabled: true,
        rules: [{ ...DEFAULT_AUTO_CREATE_RULE, defaultBranch: false, minOccurrences: 1, minRuns: 1 }],
        skipFlaky: true,
        dailyCap: 50,
        routeUnmatchedToDefault: false,
      },
    });
    await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status: 'failed', startTime: new Date() });
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: 1,
        fingerprint,
        signature: `Error: ${fingerprint}`,
        errorType: 'unknown',
        firstSeenRunId: runId,
        lastSeenRunId: runId,
      })
      .returning({ id: schema.failureClusters.id });
    await db.insert(schema.testRunsCases).values({
      testRunId: runId,
      testCaseId: 1,
      status: 'failed',
      error: `Error: ${fingerprint}`,
      failureClusterId: cluster!.id,
    });
    expect(await runTrackerAutomation(dbc, runId)).toBe(1);
    const [link] = await clusterLinks(cluster!.id);
    await db
      .update(schema.entityLinks)
      .set({ metadata: { statusCategory: 'done' } as never })
      .where(eq(schema.entityLinks.id, link!.id));
    categories.set(link!.key!, 'done');
    created = [];
    return { clusterId: cluster!.id, key: link!.key! };
  }

  async function filingsOf(clusterId: number) {
    const all = await db.select().from(schema.integrationActions);
    return all.filter((a) => a.kind === 'create-issue' && a.entityId === clusterId);
  }

  test("finding the cluster's own issue open again files nothing and records nothing", async () => {
    const { clusterId, key } = await clusterWithDoneIssue(10, 'fp-own-labels');
    // The tracker has the issue open again; the sync has not read it back yet.
    categories.set(key, 'indeterminate');
    labeled = [key];
    expect(await runTrackerAutomation(dbc, 10)).toBe(0);
    expect(created).toEqual([]);
    expect((await filingsOf(clusterId)).map((a) => a.status)).toEqual(['done']);
    expect((await clusterIssueFilings(db as never, [clusterId])).failures.get(clusterId)).toBeUndefined();
  });

  test('another open issue is named on the cluster, beside its Done filing, which is retired', async () => {
    const { clusterId, key } = await clusterWithDoneIssue(11, 'fp-other-labels');
    categories.set('PROJ-77', 'indeterminate');
    labeled = ['PROJ-77'];
    expect(await runTrackerAutomation(dbc, 11)).toBe(0);
    expect(created).toEqual([]);

    const filings = await filingsOf(clusterId);
    const liveKey = `create-issue:failure_cluster:${clusterId}:conn${connectionId}`;
    expect(filings.find((a) => a.dedupeKey === liveKey)).toMatchObject({
      status: 'skipped',
      payload: { existingKey: 'PROJ-77' },
    });
    expect(filings.find((a) => a.status === 'done')?.dedupeKey).toMatch(new RegExp(`^${liveKey}:retired:`));
    expect((await clusterIssueFilings(db as never, [clusterId])).failures.get(clusterId)).toMatchObject({
      existingKey: 'PROJ-77',
    });

    // Once no open issue carries the labels, the rule files a new issue beside the Done one.
    labeled = [];
    expect(await runTrackerAutomation(dbc, 11)).toBe(1);
    expect((await clusterLinks(clusterId)).map((l) => l.key)).toEqual(expect.arrayContaining([key, created[0]]));
  });
});
