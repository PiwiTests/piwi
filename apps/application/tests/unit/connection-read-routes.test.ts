import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole, type RoleBindingGrant } from '#shared/permissions';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * The routes that read a tracker through the connection their URL names (the
 * pickers of the create-issue modal and of a project's Issue tracker settings),
 * called against Jira sites behind `fetch`: a Contributor reads only through the
 * connection of a project they file issues on, a Project admin and an
 * administrator through any, and anyone else gets the answer of a missing
 * connection before any cache or tracker call.
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
  params: Record<string, string>;
  query: Record<string, string>;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('setResponseHeaders', () => {});
vi.stubGlobal('apiError', apiError);

/** Every request sent out, to a Jira site or an avatar host, as `host/path`. */
const sent: string[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    sent.push(`${url.host}${url.pathname}`);
    // Each site names itself in its answers: `billing` for billing.atlassian.net.
    const site = url.host.split('.')[0];
    switch (url.pathname) {
      case '/rest/api/3/project/search':
        return json({ values: [{ id: '1', key: 'PAY', name: `${site} payments` }], isLast: true });
      case '/rest/api/3/project/PAY':
        return json({ issueTypes: [{ id: '10001', name: 'Bug' }] });
      case '/rest/api/3/issue/createmeta/PAY/issuetypes/10001':
        return json({
          total: 1,
          fields: [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }],
        });
      case '/rest/api/3/user/assignable/search':
        return json([{ accountId: `${site}-1`, displayName: `${site} person` }]);
      case '/rest/api/3/issue/picker':
        return json({ sections: [{ id: 'cs', issues: [{ key: 'PAY-1', summaryText: `${site} card declined` }] }] });
      case '/images/icons/issuetypes/bug.svg':
      case '/avatar/robin':
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          headers: { 'Content-Type': 'image/svg+xml' },
        });
    }
    return json({ errorMessages: ['Not found'] }, 404);
  }),
);

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const pickerCaches = await import('../../server/utils/integrations/picker-cache');

type Route = (event: FakeEvent) => Promise<unknown>;
const route = (module: { default: unknown }) => underRoutePermission(state, module.default as Route);
const request =
  (params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  (connectionId: number): FakeEvent => ({ params: { id: String(connectionId), ...params }, query });

const icon = route(await import('../../server/api/integrations/connections/[id]/icon.get'));
/** Each route, with the request the pickers send it for a connection. */
const ROUTES = {
  projects: {
    call: route(await import('../../server/api/integrations/connections/[id]/projects.get')),
    to: request(),
  },
  'issue types': {
    call: route(await import('../../server/api/integrations/connections/[id]/projects/[key]/issue-types.get')),
    to: request({ key: 'PAY' }),
  },
  fields: {
    call: route(
      await import('../../server/api/integrations/connections/[id]/projects/[key]/issue-types/[type]/fields.get'),
    ),
    to: request({ key: 'PAY', type: '10001' }),
  },
  assignable: {
    call: route(await import('../../server/api/integrations/connections/[id]/assignable.get')),
    to: request({}, { project: 'PAY', q: '' }),
  },
  'issue picker': {
    call: route(await import('../../server/api/integrations/connections/[id]/issue-picker.get')),
    to: request({}, { project: 'PAY', q: 'card' }),
  },
  icon: { call: icon, to: request({}, { path: '/images/icons/issuetypes/bug.svg' }) },
  avatar: { call: icon, to: request({}, { path: 'https://secure.gravatar.com/avatar/robin' }) },
} satisfies Record<string, { call: Route; to: (connectionId: number) => FakeEvent }>;

const WEB = 10;
const BILLING = 11;
const DOCS = 12;

const caller = (id: number, instanceRole: InstanceRole, ...grants: RoleBindingGrant[]): RouteCaller => ({
  user: { id, role: instanceRole, username: `user${id}`, name: null } as unknown as User,
  access: buildAccessSummary(instanceRole, grants),
});
// Robin files issues on web, Sam on billing; Pat is the Project admin of docs, which is bound to no connection.
const robin = caller(1, InstanceRole.MEMBER, { projectId: WEB, role: ProjectRole.CONTRIBUTOR });
const sam = caller(2, InstanceRole.MEMBER, { projectId: BILLING, role: ProjectRole.CONTRIBUTOR });
const pat = caller(3, InstanceRole.MEMBER, { projectId: DOCS, role: ProjectRole.PROJECT_ADMIN });
const admin = caller(4, InstanceRole.ADMINISTRATOR);

let db: TempDb;
let close: () => Promise<void>;
let webJira = 0;
let billingJira = 0;
/** A connection bound to no project. */
let spareJira = 0;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values([WEB, BILLING, DOCS].map((id) => ({ id, name: `project-${id}` })));
  const connect = async (site: string) =>
    (
      await createConnection(db as never, {
        provider: 'jira',
        name: `${site} Jira`,
        baseUrl: `https://${site}.atlassian.net`,
        credentials: { email: 'ci@example.com', apiToken: 'token' },
      })
    ).id;
  billingJira = await connect('billing');
  webJira = await connect('web');
  spareJira = await connect('spare');
  await writeProjectIntegration(db as never, WEB, { connectionId: webJira, projectKey: 'WEB', issueType: 'Bug' });
  await writeProjectIntegration(db as never, BILLING, {
    connectionId: billingJira,
    projectKey: 'PAY',
    issueType: 'Bug',
  });
});

beforeEach(() => {
  sent.length = 0;
  for (const cache of Object.values(pickerCaches)) cache.deleteWhere(() => true);
});

afterAll(async () => {
  await close();
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

const MISSING = { statusCode: 404, message: 'Connection not found or has no credentials' };

describe('the routes that read a tracker through a connection', () => {
  test('refuse a Contributor of a project bound to another connection, before any call', async () => {
    state.caller = robin;
    for (const connectionId of [billingJira, spareJira]) {
      for (const [name, { call, to }] of Object.entries(ROUTES)) {
        expect(await refusal(call(to(connectionId))), `${name} through ${connectionId}`).toEqual(MISSING);
      }
    }
    expect(sent).toEqual([]);
  });

  test('refuse with the answer a connection that does not exist gets', async () => {
    const { call, to } = ROUTES.projects;
    state.caller = admin;
    const missing = await refusal(call(to(999)));
    state.caller = robin;
    expect(await refusal(call(to(billingJira)))).toEqual(missing);
    expect(await refusal(call(to(999)))).toEqual(missing);
  });

  test('serve a Contributor through the connection of the project they file issues on', async () => {
    state.caller = sam;
    const answers: Record<string, unknown> = {};
    for (const [name, { call, to }] of Object.entries(ROUTES)) answers[name] = await call(to(billingJira));
    expect(answers).toMatchObject({
      projects: { projects: [{ key: 'PAY', name: 'billing payments' }] },
      'issue types': { issueTypes: [{ id: '10001', name: 'Bug' }] },
      fields: { fields: [{ id: 'summary', required: true }] },
      assignable: { users: [{ id: 'billing-1' }] },
      'issue picker': { issues: [{ key: 'PAY-1', summary: 'billing card declined' }] },
    });
    expect(String(answers.icon)).toContain('<svg');
    expect(String(answers.avatar)).toContain('<svg');
    expect(new Set(sent.map((r) => r.split('/')[0]))).toEqual(
      new Set(['billing.atlassian.net', 'secure.gravatar.com']),
    );
  });

  test('never serve a cached answer to a caller the connection refuses', async () => {
    state.caller = sam;
    for (const { call, to } of Object.values(ROUTES)) await call(to(billingJira));
    const asked = sent.length;

    state.caller = robin;
    for (const [name, { call, to }] of Object.entries(ROUTES)) {
      expect(await refusal(call(to(billingJira))), name).toEqual(MISSING);
    }
    expect(sent).toHaveLength(asked);
  });

  test('serve a Project admin of any project, and an administrator, through every connection, bound or not', async () => {
    for (const who of [pat, admin]) {
      state.caller = who;
      for (const connectionId of [billingJira, spareJira]) {
        for (const [name, { call, to }] of Object.entries(ROUTES)) {
          await expect(call(to(connectionId)), `${name} through ${connectionId}`).resolves.toBeDefined();
        }
      }
    }
    expect(sent).toContain('spare.atlassian.net/rest/api/3/project/search');
  });
});
