import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * Filing an issue and drafting one, called as a Contributor, against two Jira
 * sites behind `fetch`: a project's issues go through the connection it is
 * bound to and no other, and a project bound to none files nothing.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

interface FakeEvent {
  body?: unknown;
  query?: Record<string, string>;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query ?? {});
vi.stubGlobal('apiError', apiError);

// Each Jira site, told apart by host: the issues it was asked to create.
const filed: { host: string; project: string }[] = [];
let issueSeq = 0;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.includes('/rest/api/3/issue/createmeta/')) return json({ total: 0, fields: [] });
    if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [] });
    if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
      const { project } = (JSON.parse(String(init.body)) as { fields: { project: { key: string } } }).fields;
      filed.push({ host: url.host, project: project.key });
      issueSeq += 1;
      return json({ id: String(10000 + issueSeq), key: `${project.key}-${issueSeq}` }, 201);
    }
    const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
    if (read) {
      return json({
        id: String(10000 + issueSeq),
        key: read[1],
        fields: { summary: 'Broken', status: { name: 'To Do', statusCategory: { key: 'new' } } },
      });
    }
    return json({ errorMessages: ['Not found'] }, 404);
  }),
);

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');

type Handler = (event: FakeEvent) => Promise<any>;
const createIssue = underRoutePermission(
  state,
  (await import('../../server/api/integrations/issues.post')).default as unknown as Handler,
);
const issueDraft = underRoutePermission(
  state,
  (await import('../../server/api/integrations/issue-draft.get')).default as unknown as Handler,
);

const WEB = 10;
const BILLING = 11;
const DOCS = 12;
/** The failure cluster of each project. */
const CLUSTER = { [WEB]: 1, [BILLING]: 2, [DOCS]: 3 } as const;

const caller = (id: number, ...grants: { projectId: number; role: ProjectRole }[]): RouteCaller => ({
  user: { id, role: InstanceRole.MEMBER, username: `user${id}`, name: null } as unknown as User,
  access: buildAccessSummary(InstanceRole.MEMBER, grants),
});
// Robin: Contributor on web and docs. Sam: Contributor on billing only.
const robin = caller(
  1,
  { projectId: WEB, role: ProjectRole.CONTRIBUTOR },
  { projectId: DOCS, role: ProjectRole.CONTRIBUTOR },
);
const sam = caller(2, { projectId: BILLING, role: ProjectRole.CONTRIBUTOR });

let db: TempDb;
let close: () => Promise<void>;
let webJira = 0;
let billingJira = 0;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  filed.length = 0;
  await db.insert(schema.users).values([
    { id: 1, username: 'robin', password: '', role: 'member' },
    { id: 2, username: 'sam', password: '', role: 'member' },
  ]);
  for (const [projectId, id] of Object.entries(CLUSTER)) {
    await db.insert(schema.projects).values({ id: Number(projectId), name: `project-${projectId}` });
    await db
      .insert(schema.testRuns)
      .values({ id, projectId: Number(projectId), status: 'failed', startTime: new Date() });
    await db
      .insert(schema.testCases)
      .values({ id, projectId: Number(projectId), title: `test ${id}`, filePath: 'a.spec.ts' });
    await db.insert(schema.failureClusters).values({
      id,
      projectId: Number(projectId),
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: id,
      lastSeenRunId: id,
    });
    await db.insert(schema.testRunsCases).values({
      id: 100 + id,
      testRunId: id,
      testCaseId: id,
      status: 'failed',
      error: `Error: broken ${id}`,
      failureClusterId: id,
    });
  }

  // Billing's connection is created first; docs is bound to none.
  const credentials = { email: 'ci@example.com', apiToken: 'token' };
  billingJira = (
    await createConnection(db as never, {
      provider: 'jira',
      name: 'Billing Jira',
      baseUrl: 'https://billing.atlassian.net',
      credentials,
    })
  ).id;
  webJira = (
    await createConnection(db as never, {
      provider: 'jira',
      name: 'Web Jira',
      baseUrl: 'https://web.atlassian.net',
      credentials,
    })
  ).id;
  await writeProjectIntegration(db as never, WEB, { connectionId: webJira, projectKey: 'WEB', issueType: 'Bug' });
  await writeProjectIntegration(db as never, BILLING, {
    connectionId: billingJira,
    projectKey: 'PAY',
    issueType: 'Bug',
  });
});

afterEach(() => close());

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.PIWI_SECRET_KEY;
});

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
  throw new Error('expected a refusal');
}

describe('POST /api/integrations/issues', () => {
  const body = (clusterId: number, connectionId: number, projectKey = 'PAY') => ({
    entityType: 'failure_cluster',
    entityId: clusterId,
    connectionId,
    title: 'Checkout times out',
    projectKey,
    issueType: 'Bug',
  });

  test('refuses a connection the project is not bound to, before anything is queued or sent', async () => {
    state.caller = robin;
    expect(await refusal(createIssue({ body: body(CLUSTER[WEB], billingJira) }))).toEqual({
      statusCode: 403,
      message: 'This project files its issues through the connection it is bound to',
    });
    expect(filed).toEqual([]);
    expect(await db.select().from(schema.integrationActions)).toEqual([]);
  });

  test('refuses every connection for a project bound to none', async () => {
    state.caller = robin;
    for (const connectionId of [webJira, billingJira]) {
      expect(await refusal(createIssue({ body: body(CLUSTER[DOCS], connectionId) }))).toEqual({
        statusCode: 403,
        message: 'This project is not bound to an issue tracker',
      });
    }
    expect(filed).toEqual([]);
  });

  test("files through the project's own connection", async () => {
    state.caller = robin;
    const created = await createIssue({ body: body(CLUSTER[WEB], webJira, 'WEB') });
    expect(created.status).toBe('done');
    expect(filed).toEqual([{ host: 'web.atlassian.net', project: 'WEB' }]);
  });

  test("refuses a Contributor of another project, even through that project's connection", async () => {
    state.caller = sam;
    expect(await refusal(createIssue({ body: body(CLUSTER[WEB], billingJira) }))).toEqual({
      statusCode: 403,
      message: 'No access to this project',
    });
    expect(filed).toEqual([]);
  });
});

describe('GET /api/integrations/issue-draft', () => {
  const draft = async (clusterId: number, query: Record<string, string> = {}) => {
    state.caller = robin;
    return issueDraft({ query: { entityType: 'failure_cluster', entityId: String(clusterId), ...query } });
  };

  test("proposes the project's own connection only, whatever the request names", async () => {
    expect((await draft(CLUSTER[WEB])).connectionId).toBe(webJira);
    expect((await draft(CLUSTER[WEB], { connectionId: String(billingJira) })).connectionId).toBe(webJira);
    expect((await draft(CLUSTER[WEB])).connections).toBeUndefined();
  });

  test('proposes no connection for a project bound to none', async () => {
    expect((await draft(CLUSTER[DOCS])).connectionId).toBeNull();
  });
});
