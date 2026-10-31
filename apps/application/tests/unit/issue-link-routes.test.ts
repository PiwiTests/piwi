import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { DEFAULT_POLICIES } from '#shared/integrations/binding';
import { doc } from '#shared/integrations/document';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * Linking an existing issue, called as a Contributor, against two Jira sites
 * behind `fetch`: a link is read, synced and written back only through the
 * connection its project is bound to. A link to another connection's site
 * stays a plain link, and the sync, the webhook, the policies and the outbox
 * pass by a link or a write that carries another connection.
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
// A plain link's page is read with no credentials, through the SSRF guard: answered here, never fetched.
vi.mock('../../server/utils/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  safeFetch: async () => new Response('', { status: 404 }),
}));

interface FakeEvent {
  body?: unknown;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('apiError', apiError);

// Each Jira site, told apart by host: every request it was sent.
const sent: { host: string; method: string; path: string }[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    sent.push({ host: url.host, method, path: url.pathname });
    const [, key, action] = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/comment|\/transitions)?$/.exec(url.pathname) ?? [];
    if (!key) return json({ errorMessages: ['Not found'] }, 404);
    if (action === '/comment') return json({ id: '1' }, 201);
    if (action === '/transitions' && method === 'POST') return new Response(null, { status: 204 });
    if (action === '/transitions') {
      return json({ transitions: [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }] });
    }
    return json({
      id: key,
      key,
      fields: {
        summary: `Summary of ${key}`,
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      },
    });
  }),
);
const WEB_HOST = 'web.atlassian.net';
const BILLING_HOST = 'billing.atlassian.net';
/** The requests one site was sent, as `METHOD path`. */
const sentTo = (host: string) => sent.filter((r) => r.host === host).map((r) => `${r.method} ${r.path}`);

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { enqueueBugLooksFixedPolicies, enqueueFixPolicies, enqueueMergePolicies } =
  await import('../../server/utils/integrations/policies');
const { refreshLinkByExternalId, syncTrackerLinks } = await import('../../server/utils/integrations/sync');
const { enqueueAction, runActionNow } = await import('../../server/utils/integrations/actions');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

type Handler = (event: FakeEvent) => Promise<any>;
const createLink = underRoutePermission(
  state,
  (await import('../../server/api/links/index.post')).default as unknown as Handler,
);
const linkIssue = MCP_TOOLS.find((t) => t.name === 'link_issue')!.handler;

const WEB = 10;
const BILLING = 11;
const DOCS = 12;
/** Each project's failure cluster and bug report, beside a run and a test of the same id. */
const CLUSTER = { [WEB]: 1, [BILLING]: 2, [DOCS]: 3 } as const;
const REPORT = { [WEB]: 1, [BILLING]: 2, [DOCS]: 3 } as const;
/** An issue on billing's site, and one on web's. */
const PAY_7 = `https://${BILLING_HOST}/browse/PAY-7`;
const WEB_5 = `https://${WEB_HOST}/browse/WEB-5`;

// Robin: Contributor on web and docs, nothing on billing.
const robin: RouteCaller = {
  user: { id: 1, role: InstanceRole.MEMBER, username: 'robin', name: null } as unknown as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [
    { projectId: WEB, role: ProjectRole.CONTRIBUTOR },
    { projectId: DOCS, role: ProjectRole.CONTRIBUTOR },
  ]),
};

let db: TempDb;
let close: () => Promise<void>;
let webJira = 0;
let billingJira = 0;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.caller = robin;
  sent.length = 0;
  await db.insert(schema.users).values({ id: 1, username: 'robin', password: '', role: 'member' });
  for (const [project, id] of Object.entries(CLUSTER)) {
    const projectId = Number(project);
    await db.insert(schema.projects).values({ id: projectId, name: `project-${projectId}` });
    await db.insert(schema.testRuns).values({ id, projectId, status: 'failed', startTime: new Date() });
    await db.insert(schema.testCases).values({ id, projectId, title: `test ${id}`, filePath: 'a.spec.ts' });
    await db.insert(schema.failureClusters).values({
      id,
      projectId,
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: id,
      lastSeenRunId: id,
    });
    await db.insert(schema.bugReports).values({
      id,
      projectId,
      title: `Report ${id}`,
      steps: { v: 1, steps: [] },
      evidence: {},
      context: {},
    });
  }

  const credentials = { email: 'ci@example.com', apiToken: 'token' };
  billingJira = (
    await createConnection(db as never, {
      provider: 'jira',
      name: 'Billing Jira',
      baseUrl: `https://${BILLING_HOST}`,
      credentials,
    })
  ).id;
  webJira = (
    await createConnection(db as never, {
      provider: 'jira',
      name: 'Web Jira',
      baseUrl: `https://${WEB_HOST}`,
      credentials,
    })
  ).id;
  // Web comments on and moves its tickets when a fix lands, and notes merges; docs is bound to none.
  await writeProjectIntegration(db as never, WEB, {
    connectionId: webJira,
    projectKey: 'WEB',
    issueType: 'Bug',
    policies: {
      ...DEFAULT_POLICIES,
      commentOnFix: true,
      transitionOnFix: true,
      fixTransitionId: '31',
      commentOnMerge: true,
    },
  });
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

/** A tracker link on an entity that carries a connection, as a match on that connection stores it. */
async function pinThrough(
  connectionId: number,
  key: string,
  on: { failureClusterId: number } | { bugReportId: number },
) {
  const host = connectionId === webJira ? WEB_HOST : BILLING_HOST;
  const [link] = await db
    .insert(schema.entityLinks)
    .values({ ...on, url: `https://${host}/browse/${key}`, provider: 'jira', key, connectionId, externalId: key })
    .returning();
  return link!;
}

async function linkTitle(id: number): Promise<string | null> {
  const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.id, id));
  return link!.title;
}

describe('POST /api/links', () => {
  test("a Contributor's link to another connection's site stays plain, and nothing is read through that connection", async () => {
    for (const body of [
      { entityType: 'failure_cluster', entityId: CLUSTER[WEB], url: PAY_7 },
      { entityType: 'bug_report', entityId: REPORT[WEB], url: PAY_7 },
    ]) {
      const { link } = await createLink({ body });
      expect(link).toMatchObject({
        url: PAY_7,
        provider: 'jira',
        key: 'PAY-7',
        connectionId: null,
        externalId: null,
        title: null,
        statusText: null,
      });
    }
    expect(sent).toEqual([]);
  });

  test("a link on the project's own site is read through its connection", async () => {
    const { link } = await createLink({ body: { entityType: 'failure_cluster', entityId: CLUSTER[WEB], url: WEB_5 } });
    expect(link).toMatchObject({
      connectionId: webJira,
      externalId: 'WEB-5',
      title: 'Summary of WEB-5',
      statusText: 'In Progress',
    });
    expect(sentTo(WEB_HOST)).toEqual(['GET /rest/api/3/issue/WEB-5']);
    expect(sentTo(BILLING_HOST)).toEqual([]);
  });

  test('a project bound to no tracker reads its links through none', async () => {
    const { link } = await createLink({ body: { entityType: 'failure_cluster', entityId: CLUSTER[DOCS], url: WEB_5 } });
    expect(link).toMatchObject({ key: 'WEB-5', connectionId: null, title: null });
    expect(sent).toEqual([]);
  });
});

describe('the link_issue MCP tool', () => {
  test("links another connection's issue as a plain link, reading nothing through it", async () => {
    const ctx = { user: robin.user, access: robin.access, scope: new Set([WEB, DOCS]) };
    const result = await linkIssue(
      db as never,
      { entityType: 'failure_cluster', entityId: CLUSTER[WEB], url: PAY_7 },
      ctx,
    );
    expect(result).toMatchObject({ url: PAY_7, key: 'PAY-7' });
    const [stored] = await db
      .select()
      .from(schema.entityLinks)
      .where(eq(schema.entityLinks.failureClusterId, CLUSTER[WEB]));
    expect(stored).toMatchObject({ connectionId: null, externalId: null, title: null });
    expect(sent).toEqual([]);
  });
});

describe('the policies', () => {
  const fixLands = () =>
    enqueueFixPolicies(db as never, {
      clusterId: CLUSTER[WEB],
      projectId: WEB,
      runId: CLUSTER[WEB],
      commit: null,
      verification: 'stopped-failing',
    });
  const moved = (key: string) => [
    `POST /rest/api/3/issue/${key}/comment`,
    `GET /rest/api/3/issue/${key}/transitions`,
    `POST /rest/api/3/issue/${key}/transitions`,
  ];

  test('a fix comments on and transitions nothing through a connection the project is not bound to', async () => {
    await pinThrough(billingJira, 'PAY-7', { failureClusterId: CLUSTER[WEB] });
    await fixLands();
    expect(sent).toEqual([]);
    expect(await db.select().from(schema.integrationActions)).toEqual([]);
  });

  test("a fix comments on and transitions the ticket on the project's own connection", async () => {
    await pinThrough(webJira, 'WEB-1', { failureClusterId: CLUSTER[WEB] });
    await fixLands();
    expect(sentTo(WEB_HOST)).toEqual(moved('WEB-1'));
    expect(sentTo(BILLING_HOST)).toEqual([]);
  });

  test("a bug report that looks fixed: only its ticket on the project's own connection is written to", async () => {
    const looksFixed = () =>
      enqueueBugLooksFixedPolicies(db as never, { bugReportId: REPORT[WEB], projectId: WEB, runId: CLUSTER[WEB] });
    await pinThrough(billingJira, 'PAY-7', { bugReportId: REPORT[WEB] });
    await looksFixed();
    expect(sent).toEqual([]);
    expect(await db.select().from(schema.integrationActions)).toEqual([]);

    await pinThrough(webJira, 'WEB-2', { bugReportId: REPORT[WEB] });
    await looksFixed();
    expect(sentTo(WEB_HOST)).toEqual(moved('WEB-2'));
    expect(sentTo(BILLING_HOST)).toEqual([]);
  });

  test("a merge notes it only on the ticket on the project's own connection", async () => {
    await db.insert(schema.failureClusters).values({
      id: 4,
      projectId: WEB,
      fingerprint: 'fp-4',
      signature: 'Error: broken 4',
      errorType: 'unknown',
      firstSeenRunId: CLUSTER[WEB],
      lastSeenRunId: CLUSTER[WEB],
    });
    await pinThrough(webJira, 'WEB-1', { failureClusterId: CLUSTER[WEB] });
    await pinThrough(billingJira, 'PAY-7', { failureClusterId: 4 });
    await enqueueMergePolicies(db as never, { survivorId: CLUSTER[WEB], victimId: 4, projectId: WEB });
    expect(sentTo(WEB_HOST)).toEqual(['POST /rest/api/3/issue/WEB-1/comment']);
    expect(sentTo(BILLING_HOST)).toEqual([]);
  });
});

describe('the status sync and the webhook', () => {
  test('read a link only through the connection its project is bound to', async () => {
    const foreign = await pinThrough(billingJira, 'PAY-7', { failureClusterId: CLUSTER[WEB] });
    const own = await pinThrough(webJira, 'WEB-1', { failureClusterId: CLUSTER[WEB] });
    const billing = await pinThrough(billingJira, 'PAY-7', { failureClusterId: CLUSTER[BILLING] });

    expect(await syncTrackerLinks(db as never)).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
    expect(sentTo(WEB_HOST)).toEqual(['GET /rest/api/3/issue/WEB-1']);
    // One read of PAY-7: billing's own link.
    expect(sentTo(BILLING_HOST)).toEqual(['GET /rest/api/3/issue/PAY-7']);
    expect(await linkTitle(own.id)).toBe('Summary of WEB-1');
    expect(await linkTitle(billing.id)).toBe('Summary of PAY-7');
    expect(await linkTitle(foreign.id)).toBeNull();

    // Billing's webhook names PAY-7: billing's link is read again, web's is not.
    sent.length = 0;
    expect(await refreshLinkByExternalId(db as never, billingJira, 'PAY-7')).toBe(true);
    expect(sentTo(BILLING_HOST)).toEqual(['GET /rest/api/3/issue/PAY-7']);
    expect(await linkTitle(foreign.id)).toBeNull();
  });
});

describe('the outbox', () => {
  const queueComment = (connectionId: number, key: string) =>
    enqueueAction(db as never, {
      connectionId,
      projectId: WEB,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: CLUSTER[WEB],
      dedupeKey: `test-comment:${key}`,
      payload: { issueKey: key, document: doc().paragraph('Fix landed').build() },
    });

  test('skips a write queued through a connection the project is not bound to', async () => {
    const foreign = await queueComment(billingJira, 'PAY-7');
    expect(await runActionNow(db as never, foreign.id)).toEqual({
      status: 'skipped',
      reason: 'the project is not bound to this connection',
    });
    expect(sent).toEqual([]);

    const own = await queueComment(webJira, 'WEB-1');
    expect(await runActionNow(db as never, own.id)).toEqual({ status: 'done' });
    expect(sentTo(WEB_HOST)).toEqual(['POST /rest/api/3/issue/WEB-1/comment']);
  });
});
