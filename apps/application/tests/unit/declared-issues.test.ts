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
 * The issues a run's failing tests name with `piwi:issue`, linked to their clusters at finalize, against a SQLite
 * database and a stubbed Jira: only issues of the bound project under the key the test named, at most 10 per cluster,
 * never one a person removed, and never one Piwi writes to or lets move the cluster until a person pins it.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { linkDeclaredIssues, MAX_DECLARED_KEYS_PER_RUN } =
  await import('../../server/utils/integrations/declared-issues');
const { syncTrackerLinks } = await import('../../server/utils/integrations/sync');
const { getClusterTrackerLink, getClusterKnownIssue } = await import('../../server/utils/integrations/known-issue');
const { createEnrichedLink } = await import('../../server/utils/integrations/link-create');
const { createLink, deleteLink, deleteLinksTo } = await import('../../shared/handlers/links');
const { clusterKnownIssues } = await import('../../shared/handlers/known-issues');
const { linkNamedIssues } = await import('../../shared/handlers/declared-issues');
const { getOpenFailureClusters } = await import('../../shared/handlers/failure-clusters');
const { getProjectFailureClusters } = await import('../../shared/handlers/projects');
const { mergeFailureClusters, splitFailureCluster } = await import('../../shared/handlers/failure-cluster-ops');

const SITE = 'https://declared.atlassian.net';

interface StubIssue {
  id: string;
  key: string;
  project: string;
  category: 'new' | 'indeterminate' | 'done';
}

/** The issues the stub Jira knows, by the key a lookup asks for: a moved issue answers under its new key. */
const issues = new Map<string, StubIssue>();
/** The keys of each bulk lookup, in order. */
let lookups: string[][] = [];
let jiraDown = false;
/** The bulk lookup answers only once its request is aborted. */
let lookupHangs = false;
const STATUS_NAME = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function issueBody(issue: StubIssue) {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: `Issue ${issue.key}`,
      status: { name: STATUS_NAME[issue.category], statusCategory: { key: issue.category } },
      project: { key: issue.project },
      issuetype: { name: 'Bug' },
    },
  };
}

/** Define an issue of the bound project by key, with an id derived from its number. */
function defineIssue(key: string, over: Partial<StubIssue> = {}): StubIssue {
  const issue = {
    id: String(20000 + Number(key.split('-')[1])),
    key,
    project: 'PROJ',
    category: 'new',
    ...over,
  } as const;
  issues.set(key, { ...issue });
  return issue;
}

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (jiraDown) return json({ errorMessages: ['Service unavailable'] }, 503);
  if (url.pathname === '/rest/api/3/issue/bulkfetch' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { issueIdsOrKeys: string[]; fields: string[] };
    lookups.push(body.issueIdsOrKeys);
    if (lookupHangs) {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    }
    const found = body.issueIdsOrKeys.filter((key) => issues.has(key));
    return json({
      issues: found.map((key) => issueBody(issues.get(key)!)),
      issueErrors: body.issueIdsOrKeys
        .filter((key) => !issues.has(key))
        .map((key) => ({ errorMessages: [`Issue ${key} does not exist`] })),
    });
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+|\d+)$/.exec(url.pathname);
  if (read) {
    const ref = read[1]!;
    const issue = [...issues.values()].find((i) => i.id === ref || i.key === ref);
    return issue ? json(issueBody(issue)) : json({ errorMessages: ['Not found'] }, 404);
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;
let nextRun = 1;
let nextTest = 1;

async function bind(over: { projectKey?: string | null; resolveOnClose?: boolean } = {}) {
  await writeProjectIntegration(dbc, 1, {
    connectionId,
    projectKey: over.projectKey === undefined ? 'PROJ' : over.projectKey,
    issueType: 'Bug',
    policies: { resolveOnClose: over.resolveOnClose ?? false, reopenOnTicketReopen: false },
  } as never);
}

async function newCluster(): Promise<number> {
  const [row] = await db
    .insert(schema.failureClusters)
    .values({
      projectId: 1,
      fingerprint: `fp-${globalThis.crypto.randomUUID()}`,
      signature: 'Error: broken',
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    })
    .returning({ id: schema.failureClusters.id });
  return row!.id;
}

/** A finished run whose executions failed into the given clusters, each naming `issues`. */
async function failRun(
  executions: Array<{
    cluster: number;
    issues: string[];
    status?: string;
    testCaseId?: number;
    /** Which attempt the row is: a retry, a `--repeat-each` repetition, and whether a later attempt replaced it. */
    attempt?: { retries?: number; repeatEachIndex?: number; finalAttempt?: boolean };
  }>,
): Promise<{ runId: number; testCaseIds: number[] }> {
  const runId = nextRun++;
  await db
    .insert(schema.testRuns)
    .values({ id: runId, projectId: 1, status: 'failed', isFullRun: true, startTime: new Date() });
  const testCaseIds: number[] = [];
  for (const execution of executions) {
    let testCaseId = execution.testCaseId;
    if (testCaseId == null) {
      testCaseId = nextTest++;
      await db
        .insert(schema.testCases)
        .values({ id: testCaseId, projectId: 1, title: `test ${testCaseId}`, filePath: 'tests/a.spec.ts' });
    }
    testCaseIds.push(testCaseId);
    await db.insert(schema.testRunsCases).values({
      testRunId: runId,
      testCaseId,
      status: execution.status ?? 'failed',
      error: 'Error: broken',
      failureClusterId: execution.cluster,
      testMeta: { issues: execution.issues } as never,
      ...execution.attempt,
    });
  }
  return { runId, testCaseIds };
}

async function links(clusterId: number) {
  return db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
}

async function dismissals(clusterId: number) {
  return db
    .select()
    .from(schema.entityLinkDismissals)
    .where(eq(schema.entityLinkDismissals.failureClusterId, clusterId));
}

async function clusterRow(id: number) {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, id));
  return row!;
}

async function pin(clusterId: number, key: string, origin: string, over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.entityLinks)
    .values({
      failureClusterId: clusterId,
      url: `${SITE}/browse/${key}`,
      provider: 'jira',
      key,
      connectionId,
      externalId: String(20000 + Number(key.split('-')[1])),
      origin,
      ...over,
    } as never)
    .returning();
  return row!;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-declared-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: nextRun++, projectId: 1, status: 'failed', startTime: new Date() });
  await db.insert(schema.users).values({ id: 7, username: 'pat', password: '', role: 'member' });
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Declared Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
  await bind();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  issues.clear();
  lookups = [];
  jiraDown = false;
  lookupHangs = false;
  await bind();
});

describe('the link step', () => {
  test('links the issue a failing test names, as read through the binding', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-412', { category: 'indeterminate' });
    const { runId, testCaseIds } = await failRun([{ cluster, issues: [`${SITE}/browse/PROJ-412`] }]);

    const result = await linkDeclaredIssues(dbc, runId);

    expect(result.linked).toEqual([{ clusterId: cluster, key: 'PROJ-412' }]);
    const [link] = await links(cluster);
    expect(link).toMatchObject({
      provider: 'jira',
      key: 'PROJ-412',
      url: `${SITE}/browse/PROJ-412`,
      title: 'Issue PROJ-412',
      statusText: 'In Progress',
      connectionId,
      externalId: '20412',
      origin: 'annotation',
      createdBy: null,
    });
    expect(link!.metadata).toMatchObject({ statusCategory: 'indeterminate', source: { testCaseId: testCaseIds[0] } });
    expect(link!.unfurledAt).toBeTruthy();
  });

  test('looks up only keys of the bound project, and stores nothing else', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-2');
    defineIssue('PROJ-3');
    const { runId } = await failRun([
      {
        cluster,
        issues: [
          'OTHER-1',
          'PROJ-01',
          'PROJECT-4',
          'https://evil.example/browse/PROJ-3',
          'https://other.atlassian.net/browse/PROJ-3',
          `${SITE}/browse/PROJ-2`,
        ],
      },
    ]);

    const result = await linkDeclaredIssues(dbc, runId);

    expect(lookups).toEqual([['PROJ-2']]);
    expect(result.looked).toEqual(['PROJ-2']);
    expect((await links(cluster)).map((l) => l.key)).toEqual(['PROJ-2']);
  });

  test('a key Jira does not know is left out of a batch that links the others, and asked again next run', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-5');
    const first = await failRun([{ cluster, issues: ['PROJ-404', 'PROJ-5'] }]);
    await linkDeclaredIssues(dbc, first.runId);
    expect((await links(cluster)).map((l) => l.key)).toEqual(['PROJ-5']);

    const second = await failRun([{ cluster, issues: ['PROJ-404', 'PROJ-5'] }]);
    await linkDeclaredIssues(dbc, second.runId);
    expect(lookups.at(-1)).toEqual(['PROJ-404']);
  });

  test('keeps the first 10 links from the tests, counts the rest, and pinned links do not count', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-900', 'pinned');
    const keys = Array.from({ length: 12 }, (_, i) => `PROJ-${i + 1}`);
    for (const key of keys) defineIssue(key);
    const { runId } = await failRun([
      { cluster, issues: keys.slice(0, 10) },
      { cluster, issues: keys.slice(10) },
    ]);

    await linkDeclaredIssues(dbc, runId);

    const declared = (await links(cluster)).filter((l) => l.origin === 'annotation');
    expect(declared).toHaveLength(10);
    expect((await clusterRow(cluster)).declaredIssuesMore).toBe(2);

    // At the cap, the next run looks up nothing for the cluster and keeps the count.
    const again = await failRun([
      { cluster, issues: keys.slice(0, 10) },
      { cluster, issues: keys.slice(10) },
    ]);
    lookups = [];
    await linkDeclaredIssues(dbc, again.runId);
    expect(lookups).toEqual([]);
    expect((await links(cluster)).filter((l) => l.origin === 'annotation')).toHaveLength(10);
    expect((await clusterRow(cluster)).declaredIssuesMore).toBe(2);

    // A run that names nothing clears it.
    const quiet = await failRun([{ cluster, issues: [] }]);
    await linkDeclaredIssues(dbc, quiet.runId);
    expect((await clusterRow(cluster)).declaredIssuesMore).toBe(0);
  });

  test(`looks up at most ${MAX_DECLARED_KEYS_PER_RUN} keys, the most named first`, async () => {
    const clusters = await Promise.all(Array.from({ length: 6 }, () => newCluster()));
    const executions = clusters.flatMap((cluster, c) =>
      Array.from({ length: 10 }, (_, i) => ({ cluster, issues: [`PROJ-${c * 10 + i + 1}`] })),
    );
    // PROJ-60 is named by two executions, so it is asked even though it sorts last.
    executions.push({ cluster: clusters[5]!, issues: ['PROJ-60'] });
    const { runId } = await failRun(executions);

    await linkDeclaredIssues(dbc, runId);

    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toHaveLength(MAX_DECLARED_KEYS_PER_RUN);
    expect(lookups[0]![0]).toBe('PROJ-60');
  });

  test('a passing or skipped execution names nothing', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-6');
    const { runId } = await failRun([
      { cluster, issues: ['PROJ-6'], status: 'passed' },
      { cluster, issues: ['PROJ-6'], status: 'skipped' },
    ]);
    const result = await linkDeclaredIssues(dbc, runId);
    expect(result.skipped).toBe('nothing-named');
    expect(lookups).toEqual([]);
  });

  test('a moved issue is dropped: under its new key, or in another project', async () => {
    const cluster = await newCluster();
    issues.set('PROJ-8', { id: '20008', key: 'PROJ-80', project: 'PROJ', category: 'new' });
    issues.set('PROJ-9', { id: '20009', key: 'PROJ-9', project: 'OTHER', category: 'new' });
    const { runId } = await failRun([{ cluster, issues: ['PROJ-8', 'PROJ-9'] }]);

    const result = await linkDeclaredIssues(dbc, runId);

    expect(result.looked).toEqual(['PROJ-8', 'PROJ-9']);
    expect(await links(cluster)).toEqual([]);
  });

  test('two steps at once link the key once', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-11');
    const { runId } = await failRun([{ cluster, issues: ['PROJ-11'] }]);

    await Promise.all([linkDeclaredIssues(dbc, runId), linkDeclaredIssues(dbc, runId)]);

    expect(await links(cluster)).toHaveLength(1);
  });

  test('at the deadline the lookup is aborted and nothing is written', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-12');
    lookupHangs = true;
    const { runId } = await failRun([{ cluster, issues: ['PROJ-12'] }]);

    const result = await linkDeclaredIssues(dbc, runId, { timeoutMs: 30 });

    expect(result.failed).toBe('deadline');
    expect(await links(cluster)).toEqual([]);
  });

  test('a test whose retry passed names nothing; one whose last attempt failed does', async () => {
    const flaky = await newCluster();
    const broken = await newCluster();
    defineIssue('PROJ-15');
    defineIssue('PROJ-16');
    const { runId } = await failRun([
      { cluster: flaky, issues: ['PROJ-15'], attempt: { retries: 0, finalAttempt: false } },
      { cluster: flaky, issues: ['PROJ-15'], status: 'passed', testCaseId: nextTest - 1, attempt: { retries: 1 } },
      { cluster: broken, issues: ['PROJ-16'], attempt: { retries: 0, finalAttempt: false } },
      { cluster: broken, issues: ['PROJ-16'], testCaseId: nextTest, attempt: { retries: 1 } },
    ]);

    await linkDeclaredIssues(dbc, runId);

    expect(lookups).toEqual([['PROJ-16']]);
    expect(await links(flaky)).toEqual([]);
    expect((await links(broken)).map((l) => l.key)).toEqual(['PROJ-16']);
  });

  test('a test counts once per key, however many of its repetitions fail', async () => {
    const clusters = await Promise.all(Array.from({ length: 6 }, () => newCluster()));
    const executions: Parameters<typeof failRun>[0] = clusters.flatMap((cluster, c) =>
      Array.from({ length: 10 }, (_, i) => ({ cluster, issues: [`PROJ-${c * 10 + i + 1}`] })),
    );
    // Two tests name PROJ-60; one test names PROJ-59 in three repetitions, which still counts once.
    executions.push({ cluster: clusters[5]!, issues: ['PROJ-60'] });
    const { runId, testCaseIds } = await failRun(executions);
    for (const repeatEachIndex of [1, 2]) {
      await db.insert(schema.testRunsCases).values({
        testRunId: runId,
        testCaseId: testCaseIds[58]!,
        status: 'failed',
        error: 'Error: broken',
        failureClusterId: clusters[5]!,
        testMeta: { issues: ['PROJ-59'] } as never,
        repeatEachIndex,
      });
    }

    await linkDeclaredIssues(dbc, runId);

    expect(lookups[0]![0]).toBe('PROJ-60');
    expect(lookups[0]![1]).not.toBe('PROJ-59');
  });

  test('once the deadline fires mid-write, nothing more is written', async () => {
    const cluster = await newCluster();
    const { runId } = await failRun([{ cluster, issues: ['PROJ-17', 'PROJ-18', 'PROJ-19'] }]);
    const more = (await clusterRow(cluster)).declaredIssuesMore;
    // The deadline fires on its fourth read: the start, after the lookup and the first insert pass, the second does not.
    let reads = 0;
    const deadline = {
      get aborted() {
        return ++reads > 3;
      },
    } as AbortSignal;
    const issue = (key: string) => ({
      id: String(20000 + Number(key.split('-')[1])),
      key,
      url: `${SITE}/browse/${key}`,
      title: `Issue ${key}`,
      status: 'To Do',
      statusCategory: 'new' as const,
      statusColor: 'info',
      assignee: null,
      projectKey: 'PROJ',
    });
    const tracker = {
      parseIssueUrl: () => null,
      getIssues: async (keys: string[]) => ({ issues: keys.map(issue), missing: [] }),
    };

    const result = await linkNamedIssues(db as never, runId, {
      projectKey: 'PROJ',
      connectionId,
      tracker: tracker as never,
      deadline,
    });

    expect(result.failed).toBe('deadline');
    expect((await links(cluster)).map((l) => l.key)).toEqual(['PROJ-17']);
    expect((await clusterRow(cluster)).declaredIssuesMore).toBe(more);
  });

  test('a binding without a project key links nothing', async () => {
    await bind({ projectKey: null });
    const cluster = await newCluster();
    defineIssue('PROJ-13');
    const { runId } = await failRun([{ cluster, issues: ['PROJ-13'] }]);

    const result = await linkDeclaredIssues(dbc, runId);

    expect(result.skipped).toBe('no-project-key');
    expect(lookups).toEqual([]);
    expect(await links(cluster)).toEqual([]);
  });

  test('with Jira down it links nothing, and the next failing run tries again', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-14');
    jiraDown = true;
    const first = await failRun([{ cluster, issues: ['PROJ-14'] }]);
    expect((await linkDeclaredIssues(dbc, first.runId)).failed).toBe('lookup');
    expect(await links(cluster)).toEqual([]);

    jiraDown = false;
    const second = await failRun([{ cluster, issues: ['PROJ-14'] }]);
    await linkDeclaredIssues(dbc, second.runId);
    expect((await links(cluster)).map((l) => l.key)).toEqual(['PROJ-14']);
  });
});

describe('a link removed by hand', () => {
  test('is recorded with who removed it and the issue id, and not added back', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-21');
    const first = await failRun([{ cluster, issues: ['PROJ-21'] }]);
    await linkDeclaredIssues(dbc, first.runId);
    const [link] = await links(cluster);

    await deleteLink(db as never, link!.id, 7);

    expect(await dismissals(cluster)).toEqual([
      expect.objectContaining({ key: 'PROJ-21', externalId: '20021', removedBy: 7 }),
    ]);
    const second = await failRun([{ cluster, issues: ['PROJ-21'] }]);
    lookups = [];
    await linkDeclaredIssues(dbc, second.runId);
    expect(lookups).toEqual([]);
    expect(await links(cluster)).toEqual([]);
  });

  test('stays removed once the issue moves to another key', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-22', 'annotation');
    await deleteLinksTo(db as never, 'failure_cluster', cluster, `${SITE}/browse/PROJ-22`, null);
    // The same issue now answers under PROJ-122, and the test names the new key.
    issues.set('PROJ-122', { id: '20022', key: 'PROJ-122', project: 'PROJ', category: 'new' });
    const { runId } = await failRun([{ cluster, issues: ['PROJ-122'] }]);

    await linkDeclaredIssues(dbc, runId);

    expect(lookups).toEqual([['PROJ-122']]);
    expect(await links(cluster)).toEqual([]);
  });

  test('a removed issue named under its new key is not counted among the keys left out', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-26', 'annotation');
    await deleteLinksTo(db as never, 'failure_cluster', cluster, `${SITE}/browse/PROJ-26`, null);
    issues.set('PROJ-126', { id: '20026', key: 'PROJ-126', project: 'PROJ', category: 'new' });
    const { runId } = await failRun([{ cluster, issues: ['PROJ-126'] }]);

    await linkDeclaredIssues(dbc, runId);

    expect(await links(cluster)).toEqual([]);
    expect((await clusterRow(cluster)).declaredIssuesMore).toBe(0);
  });

  test('a delete whose dismissal cannot be written is undone', async () => {
    const cluster = await newCluster();
    const link = await pin(cluster, 'PROJ-27', 'annotation');

    // User 999 does not exist, so the dismissal breaks its foreign key.
    await expect(deleteLink(db as never, link.id, 999)).rejects.toThrow();
    await expect(deleteLinksTo(db as never, 'failure_cluster', cluster, link.url, 999)).rejects.toThrow();

    expect((await links(cluster)).map((l) => l.id)).toEqual([link.id]);
    expect(await dismissals(cluster)).toEqual([]);
  });

  test('a pinned link is recorded by its key only', async () => {
    const cluster = await newCluster();
    const link = await pin(cluster, 'PROJ-23', 'pinned');
    await deleteLink(db as never, link.id);
    expect(await dismissals(cluster)).toEqual([
      expect.objectContaining({ key: 'PROJ-23', externalId: null, removedBy: null }),
    ]);
  });

  test('pinning the issue again by hand clears the dismissal', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-24');
    const link = await pin(cluster, 'PROJ-24', 'annotation');
    await deleteLink(db as never, link.id);
    expect(await dismissals(cluster)).toHaveLength(1);

    await createEnrichedLink(
      dbc,
      { entityType: 'failure_cluster', entityId: cluster, url: `${SITE}/browse/PROJ-24` },
      'all',
    );

    expect(await dismissals(cluster)).toEqual([]);
    expect((await links(cluster)).map((l) => l.origin)).toEqual(['pinned']);
  });
});

describe('pinning a link from the tests by hand', () => {
  test('turns it into the pinned link instead of adding a row, and Piwi writes to it', async () => {
    const cluster = await newCluster();
    defineIssue('PROJ-31');
    const declared = await pin(cluster, 'PROJ-31', 'annotation');
    expect(await getClusterTrackerLink(dbc, cluster)).toBeNull();

    const link = await createEnrichedLink(
      dbc,
      { entityType: 'failure_cluster', entityId: cluster, url: `${SITE}/browse/PROJ-31` },
      'all',
    );

    expect(link?.id).toBe(declared.id);
    expect(link?.origin).toBe('pinned');
    expect(await links(cluster)).toHaveLength(1);
    expect((await getClusterTrackerLink(dbc, cluster))?.id).toBe(declared.id);
  });
  test('keeps the connection when pinned through a URL no connection resolves', async () => {
    const cluster = await newCluster();
    const declared = await pin(cluster, 'PROJ-32', 'annotation');

    const { link } = await createLink(db as never, {
      entityType: 'failure_cluster',
      entityId: cluster,
      url: `${SITE}/browse/PROJ-32`,
    });

    expect(link).toMatchObject({ id: declared.id, origin: 'pinned', connectionId });
  });
});

describe('links from the tests are read-only', () => {
  test('no policy writes to one, and an issue body Piwi writes does not list it', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-41', 'annotation');
    expect(await getClusterTrackerLink(dbc, cluster)).toBeNull();
    expect((await clusterKnownIssues(db as never, [cluster], { declared: false })).has(cluster)).toBe(false);
  });

  test('its status is refreshed but never resolves the cluster', async () => {
    await bind({ resolveOnClose: true });
    const cluster = await newCluster();
    defineIssue('PROJ-42', { category: 'new' });
    await pin(cluster, 'PROJ-42', 'annotation', { metadata: { statusCategory: 'new' } });

    issues.get('PROJ-42')!.category = 'done';
    await syncTrackerLinks(dbc);

    const [link] = await links(cluster);
    expect(link!.statusText).toBe('Done');
    expect((await clusterRow(cluster)).status).toBe('open');
  });

  test('the status pull deletes one whose issue moved out of the bound project', async () => {
    const cluster = await newCluster();
    issues.set('PROJ-43', { id: '20043', key: 'OTHER-1', project: 'OTHER', category: 'new' });
    await pin(cluster, 'PROJ-43', 'annotation');
    const pinned = await newCluster();
    await pin(pinned, 'PROJ-43', 'pinned');

    await syncTrackerLinks(dbc);

    expect(await links(cluster)).toEqual([]);
    expect(await links(pinned)).toHaveLength(1);
  });
});

describe('the known issue', () => {
  test('is the oldest open link from the tests, before a Done one, and the tracker link above both', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-100', 'annotation', { metadata: { statusCategory: 'done' } });
    await pin(cluster, 'PROJ-412', 'annotation', { metadata: { statusCategory: 'indeterminate' } });
    await pin(cluster, 'PROJ-413', 'annotation', { metadata: { statusCategory: 'new' } });
    expect((await getClusterKnownIssue(dbc, cluster))?.key).toBe('PROJ-412');

    await pin(cluster, 'PROJ-500', 'pinned', { metadata: { statusCategory: 'done' } });
    expect((await getClusterKnownIssue(dbc, cluster))?.key).toBe('PROJ-500');
  });

  test('is the oldest link from the tests when all are Done', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-101', 'annotation', { metadata: { statusCategory: 'done' } });
    await pin(cluster, 'PROJ-102', 'annotation', { metadata: { statusCategory: 'done' } });
    expect((await clusterKnownIssues(db as never, [cluster])).get(cluster)?.key).toBe('PROJ-101');
  });
});

describe('the cluster lists', () => {
  test('a cluster whose tests name only a Done issue shows it and still counts as untracked', async () => {
    const done = await newCluster();
    const open = await newCluster();
    await pin(done, 'PROJ-201', 'annotation', { metadata: { statusCategory: 'done' }, statusText: 'Done' });
    await pin(open, 'PROJ-202', 'annotation', { metadata: { statusCategory: 'new' } });

    const inbox = await getOpenFailureClusters(db as never, 'all', 500);
    const row = (id: number) => inbox.find((c) => c.id === id)!;
    expect(row(done)).toMatchObject({ issueLink: { key: 'PROJ-201', status: 'Done' }, hasKnownIssue: false });
    expect(row(open)).toMatchObject({ issueLink: { key: 'PROJ-202' }, hasKnownIssue: true });

    const list: any[] = await getProjectFailureClusters(db as never, 1);
    expect(list.find((c) => c.id === done)?.issueLink?.key).toBe('PROJ-201');
  });

  test('the chip names the known issue before a newer plain link', async () => {
    const cluster = await newCluster();
    await pin(cluster, 'PROJ-203', 'annotation', { metadata: { statusCategory: 'new' } });
    await db.insert(schema.entityLinks).values({
      failureClusterId: cluster,
      url: 'https://wiki.example/notes',
      provider: 'generic',
    } as never);

    const [row] = (await getOpenFailureClusters(db as never, 'all', 500)).filter((c) => c.id === cluster);
    expect(row?.issueLink?.key).toBe('PROJ-203');
  });
});

describe('merge and split', () => {
  test('a merge keeps one link per key and moves the dismissals', async () => {
    const survivor = await newCluster();
    const victim = await newCluster();
    // Both name PROJ-51: the victim's goes.
    await pin(survivor, 'PROJ-51', 'annotation');
    await pin(victim, 'PROJ-51', 'annotation');
    // The victim pinned PROJ-52, which the survivor's tests named: the survivor's link from the tests goes.
    await pin(survivor, 'PROJ-52', 'annotation');
    await pin(victim, 'PROJ-52', 'pinned');
    // The survivor dismissed PROJ-53: the victim's link from the tests goes.
    await db.insert(schema.entityLinkDismissals).values({ failureClusterId: survivor, key: 'PROJ-53' });
    await pin(victim, 'PROJ-53', 'annotation');
    // The victim dismissed PROJ-54 and PROJ-53; the survivor's PROJ-53 holds.
    await db.insert(schema.entityLinkDismissals).values([
      { failureClusterId: victim, key: 'PROJ-54', externalId: '20054' },
      { failureClusterId: victim, key: 'PROJ-53', externalId: '20053' },
    ]);

    await mergeFailureClusters(db as never, survivor, victim);

    const merged = (await links(survivor)).map((l) => `${l.key}:${l.origin}`).sort();
    expect(merged).toEqual(['PROJ-51:annotation', 'PROJ-52:pinned']);
    const kept = (await dismissals(survivor)).map((d) => `${d.key}:${d.externalId}`).sort();
    expect(kept).toEqual(['PROJ-53:null', 'PROJ-54:20054']);
    expect(await dismissals(victim)).toEqual([]);
  });

  test('a split copies the dismissals to the cluster split off', async () => {
    const source = await newCluster();
    defineIssue('PROJ-61');
    const { testCaseIds } = await failRun([
      { cluster: source, issues: [] },
      { cluster: source, issues: [] },
    ]);
    await db
      .insert(schema.entityLinkDismissals)
      .values({ failureClusterId: source, key: 'PROJ-61', externalId: '20061' });

    const split = await splitFailureCluster(db as never, source, [testCaseIds[1]!]);

    expect((await dismissals(split!.clusterId!)).map((d) => d.key)).toEqual(['PROJ-61']);
    expect((await dismissals(source)).map((d) => d.key)).toEqual(['PROJ-61']);
    const { runId } = await failRun([{ cluster: split!.clusterId!, issues: ['PROJ-61'], testCaseId: testCaseIds[1] }]);
    await linkDeclaredIssues(dbc, runId);
    expect(await links(split!.clusterId!)).toEqual([]);
  });
});
