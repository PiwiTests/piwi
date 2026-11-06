import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * Issues a person files about a run, or about an execution with no failure
 * cluster, against a SQLite database and a stubbed Jira: the comment opens the
 * body under the person's name, each submission of the dialog files once, a
 * comment on a cluster already filed reaches that issue, and a create whose
 * worker stopped during the call to Jira never files twice.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { createIssue } = await import('../../server/utils/integrations/create');
const { enqueueAction, runActionNow, outcomeUnknownMessage } = await import('../../server/utils/integrations/actions');
const { enqueueDescriptionUpdate } = await import('../../server/utils/integrations/policies');
const { buildRunIssue, listedRunTests, runIssueTitle, RUN_ISSUE_MAX_TESTS } =
  await import('../../shared/integrations/run-issue');
const { renderMarkdown } = await import('../../shared/integrations/render-markdown');

const SITE = 'https://runs.atlassian.net';

/** The bodies Jira received, in order: creates and comments. */
let creates: string[] = [];
let comments: { key: string; body: string }[] = [];
let updates: { key: string; body: string }[] = [];
/** Each issue as Jira holds it, so a read and a rewrite see what was filed. */
const issues = new Map<string, { summary: string; description: unknown }>();
let issueSeq = 0;
/** Answers the next creates with this status instead of creating. */
let failCreatesWith: number | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/createmeta\//.test(url.pathname)) return json({ total: 0, fields: [] });
  if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
    if (failCreatesWith) return json({ errorMessages: ['Unavailable'] }, failCreatesWith);
    issueSeq += 1;
    creates.push(String(init.body));
    const { fields } = JSON.parse(String(init.body));
    issues.set(`PROJ-${issueSeq}`, { summary: fields.summary, description: fields.description });
    return json({ id: String(10000 + issueSeq), key: `PROJ-${issueSeq}` }, 201);
  }
  const comment = /\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(url.pathname);
  if (comment && init?.method === 'POST') {
    comments.push({ key: comment[1]!, body: String(init.body) });
    return json({ id: '1' }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
  const issue = read ? issues.get(read[1]!) : undefined;
  if (read && issue && init?.method === 'PUT') {
    updates.push({ key: read[1]!, body: String(init.body) });
    const { fields } = JSON.parse(String(init.body));
    if (fields.summary) issue.summary = fields.summary;
    if (fields.description) issue.description = fields.description;
    return new Response(null, { status: 204 });
  }
  if (read && issue) {
    return json({
      id: String(10000 + Number(read[1]!.split('-')[1])),
      key: read[1],
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { name: 'To Do', statusCategory: { key: 'new' } },
      },
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
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-run-issue-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;

  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({
    id: 7,
    projectId: 1,
    status: 'failed',
    startTime: new Date('2026-11-06T10:00:00Z'),
    branch: 'main',
    commit: '9f8e7d6c5b4a3f2e1d0c',
    totalTests: 3,
    passedTests: 2,
    failedTests: 1,
  });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, title: 'pays with a coupon', filePath: 'tests/checkout.spec.ts' },
    { id: 2, projectId: 1, title: 'keeps the basket', filePath: 'tests/cart.spec.ts' },
    { id: 3, projectId: 1, title: 'signs in', filePath: 'tests/login.spec.ts' },
  ]);
  await db.insert(schema.failureClusters).values([
    {
      id: 1,
      projectId: 1,
      fingerprint: 'fp-1',
      signature: 'Error: coupon refused',
      errorType: 'assertion',
      firstSeenRunId: 7,
      lastSeenRunId: 7,
    },
    {
      id: 2,
      projectId: 1,
      fingerprint: 'fp-2',
      signature: 'Error: basket emptied',
      errorType: 'assertion',
      firstSeenRunId: 7,
      lastSeenRunId: 7,
    },
  ]);
  await db.insert(schema.testRunsCases).values([
    { id: 71, testRunId: 7, testCaseId: 2, status: 'passed', line: 12 },
    {
      id: 72,
      testRunId: 7,
      testCaseId: 1,
      status: 'failed',
      line: 30,
      error: 'Error: coupon refused',
      failureClusterId: 1,
    },
    { id: 73, testRunId: 7, testCaseId: 3, status: 'passed', line: 5 },
  ]);
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Runs Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
  await writeProjectIntegration(dbc, 1, {
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    policies: { updateDescription: true } as never,
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  creates = [];
  comments = [];
  updates = [];
  failCreatesWith = null;
});

const file = (entityType: 'test_run' | 'test_runs_case' | 'failure_cluster', entityId: number, extra = {}) =>
  createIssue(dbc, {
    entityType,
    entityId,
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    filedBy: 'Dana Lee',
    ...extra,
  });

describe('an issue about a run', () => {
  test('opens with the comment under the name, lists the tests and links on the run', async () => {
    const outcome = await file('test_run', 7, {
      comment: 'The coupon is accepted twice on reload.\nNo test covers it.',
      submissionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(outcome).toMatchObject({ status: 'done', key: 'PROJ-1' });
    const body = creates[0]!;
    expect(body.indexOf('Comment from Dana Lee')).toBeGreaterThan(-1);
    expect(body.indexOf('Comment from Dana Lee')).toBeLessThan(body.indexOf('The run'));
    expect(body).toContain('No test covers it.');
    expect(body).toContain('pays with a coupon');
    expect(body).toContain('Filed by Dana Lee from Piwi.');
    expect(body).toContain('piwi-run-7');
    const [link] = await db
      .select()
      .from(schema.entityLinks)
      .where(and(eq(schema.entityLinks.testRunId, 7), isNotNull(schema.entityLinks.key)));
    expect(link).toMatchObject({ key: 'PROJ-1', origin: 'created', failureClusterId: null });
  });

  test('the same submission files once, a new one files again', async () => {
    const submissionId = '00000000-0000-4000-8000-000000000002';
    const first = await file('test_run', 7, { submissionId });
    const again = await file('test_run', 7, { submissionId });
    expect(again).toMatchObject({ status: 'done', key: first.key });
    expect(again?.alreadyFiled).toBeUndefined();
    const other = await file('test_run', 7, { submissionId: '00000000-0000-4000-8000-000000000003' });
    expect(other?.key).not.toBe(first.key);
    expect(creates).toHaveLength(2);
  });
});

describe('an issue about an execution', () => {
  test('one with no failure cluster files for itself, titled after its test', async () => {
    const outcome = await file('test_runs_case', 71, { submissionId: '00000000-0000-4000-8000-000000000004' });
    expect(outcome).toMatchObject({ status: 'done' });
    expect(JSON.parse(creates[0]!).fields.summary).toBe('keeps the basket');
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.key, outcome!.key!));
    expect(link).toMatchObject({ testRunsCaseId: 71, failureClusterId: null });
  });

  test('a comment on a cluster already filed is added to its issue', async () => {
    const first = await file('failure_cluster', 1);
    expect(first).toMatchObject({ status: 'done' });
    const again = await file('test_runs_case', 72, {
      comment: 'Also fails on Safari.',
      submissionId: '00000000-0000-4000-8000-000000000005',
    });
    expect(again).toMatchObject({ alreadyFiled: true, commentAdded: true, key: first!.key });
    expect(creates).toHaveLength(1);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.key).toBe(first!.key);
    expect(comments[0]!.body).toContain('Also fails on Safari.');
    expect(comments[0]!.body).toContain('Comment from Dana Lee');
  });

  test("a description update of a cluster's issue keeps the comment it was filed with first", async () => {
    const filed = await file('failure_cluster', 2, { comment: 'Seen on staging.' });
    expect(filed).toMatchObject({ status: 'done' });
    await db.update(schema.failureClusters).set({ occurrences: 9 }).where(eq(schema.failureClusters.id, 2));
    await enqueueDescriptionUpdate(dbc, { clusterId: 2, projectId: 1, reason: 'day:2026-11-06' });
    expect(updates.map((u) => u.key)).toEqual([filed!.key]);
    const body = updates[0]!.body;
    expect(body).toContain('Seen on staging.');
    expect(body.indexOf('Comment from Dana Lee')).toBeLessThan(body.indexOf('What happened'));
  });
});

describe('a create whose worker stopped during the call', () => {
  test('fails as outcome unknown and never calls Jira again', async () => {
    const action = await enqueueAction(dbc, {
      connectionId,
      projectId: 1,
      kind: 'create-issue',
      entityType: 'test_run',
      entityId: 7,
      dedupeKey: 'create-issue:test_run:7:reclaimed',
      payload: {
        projectKey: 'PROJ',
        issueType: 'Bug',
        title: 'Run #7',
        document: { nodes: [] },
        labels: [],
        linkEntityType: 'test_run',
        linkEntityId: 7,
      },
    });
    await db
      .update(schema.integrationActions)
      .set({ result: { createStartedAt: Date.now() } as never })
      .where(eq(schema.integrationActions.id, action.id));
    const outcome = await runActionNow(dbc, action.id);
    expect(outcome).toMatchObject({ status: 'failed', error: outcomeUnknownMessage('Run #7'), final: true });
    expect(creates).toHaveLength(0);
  });

  test('a create Jira answered with an error clears the marker, so the retry files', async () => {
    failCreatesWith = 503;
    const pending = await file('test_run', 7, { submissionId: '00000000-0000-4000-8000-000000000006' });
    expect(pending).toMatchObject({ status: 'pending' });
    const [row] = await db
      .select()
      .from(schema.integrationActions)
      .where(eq(schema.integrationActions.id, pending!.actionId!));
    expect(row!.result).toBeNull();
    failCreatesWith = null;
    const retried = await file('test_run', 7, { submissionId: '00000000-0000-4000-8000-000000000006' });
    expect(retried).toMatchObject({ status: 'done' });
    expect(creates).toHaveLength(1);
  });
});

describe('the run issue document', () => {
  const facts = {
    runId: 9,
    projectName: 'shop',
    branch: 'main',
    commit: '9f8e7d6',
    environment: 'staging',
    startedAt: 'Nov 6, 2026',
    counts: { total: 40, passed: 37, failed: 3, flaky: 0, skipped: 0 },
    tests: [],
    moreTests: 0,
    clusters: [],
    runUrl: null,
    filedBy: null,
  };

  test('proposes a title with the failures and the branch', () => {
    expect(runIssueTitle('en', facts)).toBe('Run #9: 3 of 40 failed on main');
    expect(runIssueTitle('en', { ...facts, branch: null, counts: { ...facts.counts, failed: 0 } })).toBe('Run #9');
    expect(runIssueTitle('fr', facts)).toBe('Série #9: 3 sur 40 en échec sur main');
  });

  test('a comment without a name has a plain heading', () => {
    const markdown = renderMarkdown(buildRunIssue(facts, { comment: { text: 'Too slow.', author: null } }).document);
    expect(markdown.startsWith('## Comment\n\nToo slow.')).toBe(true);
    expect(markdown).toContain('Filed from Piwi.');
  });

  test('lists failed tests first, then cuts the list', () => {
    const tests = Array.from({ length: RUN_ISSUE_MAX_TESTS + 5 }, (_, i) => ({
      title: `test ${i}`,
      filePath: 'a.spec.ts',
      line: i + 1,
      project: null,
      result: (i === 20 ? 'failed' : 'passed') as 'failed' | 'passed',
      url: null,
    }));
    const listed = listedRunTests(tests);
    expect(listed.tests[0]!.title).toBe('test 20');
    expect(listed.tests).toHaveLength(RUN_ISSUE_MAX_TESTS);
    expect(listed.moreTests).toBe(5);
  });
});
