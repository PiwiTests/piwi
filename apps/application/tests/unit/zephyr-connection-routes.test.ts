import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { openTempDb, type TempDb } from './temp-db';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * A Zephyr Scale Cloud connection through the connection routes, called as an administrator against a stubbed
 * Zephyr: created, checked, tested, edited and deleted without its token ever coming back, and never taken for a
 * tracker by the routes that bind, pick from or register a webhook on one.
 */

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
  body?: unknown;
}
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('getQuery', (event: FakeEvent) => event.query);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('apiError', apiError);

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.route-payload.route-signature';
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Every request sent out, as `host/path` with the token it carried. */
const sent: { where: string; token: string | null }[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '') ?? null;
    sent.push({ where: `${url.host}${url.pathname}`, token });
    if (!url.host.endsWith('api.zephyrscale.smartbear.com')) return json({ errorMessages: ['Not found'] }, 404);
    if (token !== TOKEN) return json(fixture('error-unauthorized'), 401);
    return json(fixture(url.searchParams.get('maxResults') === '1' ? 'projects-first' : 'projects-page-2'));
  }),
);

type Route = (event: FakeEvent) => Promise<any>;
const route = (module: { default: unknown }) => underRoutePermission(state, module.default as Route);
const create = route(await import('../../server/api/integrations/connections/index.post'));
const list = route(await import('../../server/api/integrations/connections/index.get'));
const patch = route(await import('../../server/api/integrations/connections/[id].patch'));
const remove = route(await import('../../server/api/integrations/connections/[id].delete'));
const check = route(await import('../../server/api/integrations/connections/check.post'));
const test_ = route(await import('../../server/api/integrations/connections/[id]/test.post'));
const webhookCreate = route(await import('../../server/api/integrations/connections/[id]/webhook-token.post'));
const webhookDelete = route(await import('../../server/api/integrations/connections/[id]/webhook-token.delete'));
const projects = route(await import('../../server/api/integrations/connections/[id]/projects.get'));
const assignable = route(await import('../../server/api/integrations/connections/[id]/assignable.get'));
const issuePicker = route(await import('../../server/api/integrations/connections/[id]/issue-picker.get'));
const bind = route(await import('../../server/api/projects/[id]/integrations.put'));
const { getSetupStatus } = await import('../../shared/handlers/setup-status');
const { resetLimitersForTests } = await import('../../server/utils/integrations/test-management/limiter');
const { connectionPausedUntil, pauseConnectionById } = await import('../../server/utils/integrations/actions');

const as = (
  id: number,
  role: InstanceRole,
  ...grants: Parameters<typeof buildAccessSummary>[1][number][]
): RouteCaller => ({
  user: { id, role, username: `user${id}`, name: null } as unknown as User,
  access: buildAccessSummary(role, grants),
});
const admin = as(1, InstanceRole.ADMINISTRATOR);
const member = as(2, InstanceRole.MEMBER, { projectId: 10, role: ProjectRole.PROJECT_ADMIN });

const event = (body?: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}): FakeEvent => ({
  params,
  query,
  body,
});
const at = (id: number, body?: unknown, query: Record<string, string> = {}) => event(body, { id: String(id) }, query);

async function refusal(promise: Promise<unknown>): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { statusCode, message } = error as { statusCode: number; message: string };
    return { statusCode, message };
  }
  throw new Error('expected a refusal');
}

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 10, name: 'web' });
});
afterAll(async () => {
  await close();
  vi.unstubAllGlobals();
  delete process.env.PIWI_SECRET_KEY;
});
beforeEach(async () => {
  state.caller = admin;
  sent.length = 0;
  await db.delete(schema.integrationConnections);
});

const createZephyr = async (body: Record<string, unknown> = {}) =>
  (
    await create(
      event({ provider: 'zephyr-scale', name: 'Zephyr', region: 'us', credentials: { apiToken: TOKEN }, ...body }),
    )
  ).connection;

describe('creating a Zephyr connection', () => {
  test('sets the host from the region and never returns the token', async () => {
    const connection = await createZephyr({ region: 'eu' });
    expect(connection).toMatchObject({
      provider: 'zephyr-scale',
      baseUrl: 'https://eu.api.zephyrscale.smartbear.com/v2',
      config: { region: 'eu' },
      hasCredentials: true,
      managedBy: 'db',
    });
    expect(JSON.stringify(connection)).not.toContain(TOKEN);
    expect(JSON.stringify(await list(event()))).not.toContain(TOKEN);
    const [row] = await db.select().from(schema.integrationConnections);
    expect(row!.credentials).not.toContain(TOKEN);
  });

  test('ignores a typed baseUrl', async () => {
    const connection = await createZephyr({ baseUrl: 'https://attacker.example/v2' });
    expect(connection.baseUrl).toBe('https://api.zephyrscale.smartbear.com/v2');
  });

  test('answers 400 for an unknown region and for a typed address alone', async () => {
    for (const body of [{ region: 'mars' }, { region: undefined, baseUrl: 'https://attacker.example/v2' }]) {
      expect(
        await refusal(
          create(event({ provider: 'zephyr-scale', name: 'Z', credentials: { apiToken: TOKEN }, ...body })),
        ),
      ).toMatchObject({
        statusCode: 400,
      });
    }
    expect(await db.select().from(schema.integrationConnections)).toEqual([]);
  });

  test('is for administrators only', async () => {
    state.caller = member;
    expect(
      await refusal(
        create(event({ provider: 'zephyr-scale', name: 'Z', region: 'us', credentials: { apiToken: TOKEN } })),
      ),
    ).toMatchObject({
      statusCode: 403,
    });
  });
});

describe('checking a Zephyr connection', () => {
  test('signs in on the chosen region and reports the projects, with the token kept out of the answer', async () => {
    const result = await check(event({ provider: 'zephyr-scale', region: 'us', credentials: { apiToken: TOKEN } }));
    expect(result).toMatchObject({
      baseUrl: 'https://api.zephyrscale.smartbear.com/v2',
      auth: { ok: true, account: { id: 'zephyr-scale:us' } },
      projects: { ok: true, count: 1, keys: ['WEB_APP'] },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(new Set(sent.map((s) => s.where.split('/')[0]))).toEqual(new Set(['api.zephyrscale.smartbear.com']));
  });

  test('calls the region’s host and not a typed one', async () => {
    await check(
      event({
        provider: 'zephyr-scale',
        region: 'au',
        baseUrl: 'https://attacker.example',
        credentials: { apiToken: TOKEN },
      }),
    );
    expect(new Set(sent.map((s) => s.where.split('/')[0]))).toEqual(new Set(['au.api.zephyrscale.smartbear.com']));
  });

  test('answers 400 for an unknown region before any call', async () => {
    expect(
      await refusal(check(event({ provider: 'zephyr-scale', region: 'mars', credentials: { apiToken: TOKEN } }))),
    ).toMatchObject({
      statusCode: 400,
    });
    expect(sent).toEqual([]);
  });

  test('a blank token is filled from the connection being edited while its region is unchanged', async () => {
    const connection = await createZephyr();
    await check(
      event({ provider: 'zephyr-scale', region: 'us', credentials: { apiToken: '' }, connectionId: connection.id }),
    );
    expect(sent.map((s) => s.token)).toEqual([TOKEN, TOKEN]);

    sent.length = 0;
    const moved = await check(
      event({ provider: 'zephyr-scale', region: 'eu', credentials: { apiToken: '' }, connectionId: connection.id }),
    );
    expect(sent).toEqual([]);
    expect(moved.auth).toBeUndefined();
  });
});

describe('testing a Zephyr connection', () => {
  test('answers ok with the account and records it', async () => {
    const connection = await createZephyr();
    expect(await test_(at(connection.id))).toMatchObject({ ok: true, account: { id: 'zephyr-scale:us' } });
    const [row] = await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connection.id));
    expect(row!.status).toBe('ok');
  });

  test('answers ok false without a call while the provider has the connection paused', async () => {
    const connection = await createZephyr();
    await pauseConnectionById(db, connection.id, 30_000, new Date());
    sent.length = 0;
    expect(await test_(at(connection.id))).toMatchObject({ ok: false, error: expect.stringContaining('Paused') });
    expect(sent).toEqual([]);
    connectionPausedUntil(connection.id, new Date(Date.now() + 1e10));
    expect(await test_(at(connection.id))).toMatchObject({ ok: true });
  });

  test('answers ok false when the connection has more requests queued than a Test waits for, and records nothing', async () => {
    const connection = await createZephyr();
    process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '1';
    resetLimitersForTests();
    try {
      expect(await test_(at(connection.id))).toMatchObject({ ok: true });
      sent.length = 0;
      expect(await test_(at(connection.id))).toMatchObject({ ok: false, error: expect.stringContaining('waiting') });
      expect(sent).toEqual([]);
      expect((await list(event())).connections[0]).toMatchObject({ status: 'ok' });
    } finally {
      delete process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
      resetLimitersForTests();
    }
  });

  test('answers 200 with the error for a refused token, as for Jira, and marks the connection failed', async () => {
    const connection = await createZephyr({ credentials: { apiToken: 'revoked-token' } });
    const result = await test_(at(connection.id));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('401') });
    expect(JSON.stringify(result)).not.toContain('revoked-token');
    expect((await list(event())).connections[0]).toMatchObject({ status: 'failed' });
  });
});

describe('editing a Zephyr connection', () => {
  test('changes the region and drops the token when none is given for it', async () => {
    const connection = await createZephyr();
    const { connection: edited } = await patch(at(connection.id, { region: 'de', credentials: {} }));
    expect(edited).toMatchObject({
      baseUrl: 'https://de.api.zephyrscale.smartbear.com/v2',
      config: { region: 'de' },
      hasCredentials: false,
    });
  });

  test('changes the region with a new token', async () => {
    const connection = await createZephyr();
    const { connection: edited } = await patch(
      at(connection.id, { region: 'de', credentials: { apiToken: 'new-token' } }),
    );
    expect(edited).toMatchObject({ config: { region: 'de' }, hasCredentials: true });
  });

  test('keeps the token and the region when only the name changes, even if a host is typed', async () => {
    const connection = await createZephyr({ region: 'au' });
    const { connection: edited } = await patch(
      at(connection.id, { name: 'Renamed', baseUrl: 'https://attacker.example/v2', credentials: {} }),
    );
    expect(edited).toMatchObject({
      name: 'Renamed',
      baseUrl: 'https://au.api.zephyrscale.smartbear.com/v2',
      config: { region: 'au' },
      hasCredentials: true,
    });
  });

  test('answers 400 for an unknown region and leaves the connection as it was', async () => {
    const connection = await createZephyr();
    expect(await refusal(patch(at(connection.id, { region: 'mars' })))).toMatchObject({ statusCode: 400 });
    expect((await list(event())).connections[0]).toMatchObject({ config: { region: 'us' }, hasCredentials: true });
  });

  test('refuses to edit an environment-managed connection', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    try {
      const [connection] = (await list(event())).connections;
      expect(connection).toMatchObject({ provider: 'zephyr-scale', managedBy: 'env' });
      expect(await refusal(patch(at(connection.id, { region: 'eu' })))).toMatchObject({ statusCode: 403 });
    } finally {
      delete process.env.PIWI_ZEPHYR_API_TOKEN;
    }
  });
});

describe('deleting a Zephyr connection', () => {
  test('removes it', async () => {
    const connection = await createZephyr();
    await remove(at(connection.id));
    expect((await list(event())).connections).toEqual([]);
  });
});

describe('the tracker routes, called with a Zephyr connection', () => {
  test('the pickers answer as for a connection without credentials, and call nothing', async () => {
    const connection = await createZephyr();
    for (const call of [projects, assignable, issuePicker]) {
      expect(await refusal(call(at(connection.id, undefined, { project: 'WEB_APP', q: '' })))).toEqual({
        statusCode: 404,
        message: 'Connection not found or has no credentials',
      });
    }
    expect(sent).toEqual([]);
  });

  test('a project cannot be bound to it', async () => {
    const connection = await createZephyr();
    state.caller = admin;
    expect(
      await refusal(bind(event({ connectionId: connection.id, projectKey: 'WEB', issueType: 'Bug' }, { id: '10' }))),
    ).toEqual({ statusCode: 400, message: 'A project is bound to a tracker connection only' });
    expect(await db.select().from(schema.projectIntegrations)).toEqual([]);
  });

  test('a project can still be bound to a Jira connection', async () => {
    const jira = (
      await create(
        event({
          provider: 'jira',
          name: 'Jira',
          baseUrl: 'https://acme.atlassian.net',
          credentials: { email: 'ci@example.com', apiToken: 'jira-token' },
        }),
      )
    ).connection;
    await bind(event({ connectionId: jira.id, projectKey: 'WEB', issueType: 'Bug' }, { id: '10' }));
    expect(await db.select().from(schema.projectIntegrations)).toHaveLength(1);
  });

  test('has no inbound webhook to register or remove', async () => {
    const connection = await createZephyr();
    for (const call of [webhookCreate, webhookDelete]) {
      expect(await refusal(call(at(connection.id)))).toEqual({
        statusCode: 400,
        message: 'This provider has no inbound webhook',
      });
    }
    const [row] = await db.select().from(schema.integrationConnections);
    expect(JSON.stringify(row!.config)).not.toContain('webhookTokenDigest');
  });
});

describe('the setup checklist', () => {
  test('a Zephyr connection alone does not mark the issue tracker step done; a Jira one does', async () => {
    const active = async () =>
      (await getSetupStatus(db as never)).capabilities.find((c) => c.id === 'integrations')!.active;
    await createZephyr();
    expect(await active()).toBe(false);
    await create(
      event({
        provider: 'jira',
        name: 'Jira',
        baseUrl: 'https://acme.atlassian.net',
        credentials: { email: 'ci@example.com', apiToken: 'jira-token' },
      }),
    );
    expect(await active()).toBe(true);
  });
});
