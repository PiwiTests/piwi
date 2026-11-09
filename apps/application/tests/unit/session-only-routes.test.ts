import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { buildAccessSummary, InstanceRole, ProjectRole } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState, type RouteCaller } from './route-access';

/**
 * The routes that change the caller's credentials or create a credential take
 * a signed-in session: called with an API key, each refuses (403) before it
 * acts, and called with a session, it acts.
 */

const state = vi.hoisted(
  () => ({ db: null, caller: null, routePermission: [], acted: [] }) as RouteAccessState & { acted: string[] },
);
vi.mock('../../server/database', () => ({
  // change-password reads the caller's row: a stored password the mocked check accepts.
  getDatabase: async () => ({
    select: () => ({ from: () => ({ where: async () => [{ id: 7, password: 'stored-hash' }] }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          state.acted.push('password');
        },
      }),
    }),
  }),
}));
vi.mock('../../server/utils/auth', async () => ({
  ...(await import('./route-access')).authMock(state),
  generateApiKey: () => ({ plaintext: 'pd_new', hash: 'hash', prefix: 'new' }),
  hashPassword: async (password: string) => `hashed:${password}`,
  verifyPassword: async () => true,
  revokeUserSessions: async () => 1,
  setUserSession: async () => {
    state.acted.push('session');
  },
}));
vi.mock('#shared/handlers/users', () => ({
  createUserApiKeyRecord: async () => {
    state.acted.push('api-key');
  },
}));
vi.mock('../../server/utils/oauth', () => ({
  unlinkProvider: async () => {
    state.acted.push('unlink');
  },
}));
vi.mock('../../server/utils/rate-limit', () => ({
  limitLookupMisses: async (_event: unknown, _key: string, _limit: unknown, lookup: () => Promise<unknown>) => lookup(),
  rateLimitClientIp: () => 'test',
  checkRateLimit: () => true,
  rateLimitedError: () => new Error('rate limited'),
  takeRateLimitSlots: () => [],
  releaseRateLimit: () => {},
}));
vi.mock('../../server/utils/extension-connect', () => ({
  CONNECT_RATE_LIMITS: { lookupMiss: { limit: 10, windowMs: 1000 } },
  decideDeviceConnect: async () => {
    state.acted.push('extension-connect');
    return 'approved';
  },
}));
vi.mock('../../server/utils/mcp-oauth-helpers', () => ({
  MCP_OAUTH_RATE_LIMITS: { lookupMiss: { limit: 10, windowMs: 1000 } },
}));
vi.mock('../../server/utils/mcp-oauth', () => ({
  requireMcpOAuthEnabled: () => {},
  decideAuthorization: async () => {
    state.acted.push('mcp-oauth');
    return { status: 'approved', redirectTo: 'http://localhost/callback?code=x' };
  },
}));
vi.mock('../../server/utils/project-access', async (original) => ({
  ...(await original<typeof import('../../server/utils/project-access')>()),
  requireProjectPermission: async () => {},
  resolveRunProjectId: async () => 1,
}));
vi.mock('../../server/utils/run-requests', () => ({
  newRunRequestId: () => '0123456789abcdef0123456789abcdef',
  requireMachineRunsOn: async () => {},
  requireSignInForRunRequests: () => {},
  runRequestView: async () => ({}),
}));
vi.mock('#shared/handlers/run-requests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/handlers/run-requests')>()),
  createRunRequest: async () => {
    state.acted.push('run-request');
    return { ok: true, row: { id: '0123456789abcdef0123456789abcdef' }, skipped: 0 };
  },
}));
vi.mock('../../server/utils/public-base-url', () => ({ publicBaseUrl: () => 'http://localhost' }));
vi.mock('../../server/utils/profile-picture', () => ({
  saveProfilePicture: async () => {
    state.acted.push('picture');
    return 'avatars/7/picture.webp';
  },
  removeProfilePicture: async () => {
    state.acted.push('picture-removed');
    return true;
  },
}));
vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  getRequestWebStream: () => undefined,
}));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<unknown>;

async function loadRoute(path: string): Promise<Handler> {
  return underRoutePermission(state, (await import(path)).default as Handler);
}

const ROUTES: Array<{ name: string; handler: Handler; event: FakeEvent; acts: string; contributor?: true }> = [
  {
    name: 'POST /api/users/:id/api-keys',
    handler: await loadRoute('../../server/api/users/[id]/api-keys/index.post'),
    event: { params: { id: '7' }, body: { name: 'CI' } },
    acts: 'api-key',
  },
  {
    name: 'POST /api/auth/change-password',
    handler: await loadRoute('../../server/api/auth/change-password.post'),
    event: { body: { currentPassword: 'current-password', newPassword: 'new-password' } },
    acts: 'password',
  },
  {
    name: 'POST /api/auth/oauth/:provider/unlink',
    handler: await loadRoute('../../server/api/auth/oauth/[provider]/unlink.post'),
    event: { params: { provider: 'github' } },
    acts: 'unlink',
  },
  {
    name: 'PUT /api/auth/avatar',
    handler: await loadRoute('../../server/api/auth/avatar.put'),
    event: {},
    acts: 'picture',
  },
  {
    name: 'DELETE /api/auth/avatar',
    handler: await loadRoute('../../server/api/auth/avatar.delete'),
    event: {},
    acts: 'picture-removed',
  },
  {
    name: 'POST /api/extension/connect/decision',
    handler: await loadRoute('../../server/api/extension/connect/decision.post'),
    event: { body: { userCode: 'BCDF-GHJK', allow: true } },
    acts: 'extension-connect',
  },
  {
    name: 'POST /api/oauth/authorizations/:id/decision',
    handler: await loadRoute('../../server/api/oauth/authorizations/[id]/decision.post'),
    event: { params: { id: 'request' }, body: { allow: true } },
    acts: 'mcp-oauth',
  },
  {
    name: 'POST /api/run-requests',
    handler: await loadRoute('../../server/api/run-requests/index.post'),
    event: { body: { source: { runId: 1, tests: 'failed' } } },
    acts: 'run-request',
    contributor: true,
  },
];

const user = { id: 7, role: InstanceRole.MEMBER, username: 'robin', name: null } as unknown as User;
const signedIn: RouteCaller = { user, access: buildAccessSummary(InstanceRole.MEMBER, []) };
const contributor: RouteCaller = {
  user,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.CONTRIBUTOR }]),
};

beforeEach(() => {
  state.acted = [];
});

describe.each(ROUTES)('$name', ({ handler, event, acts, contributor: needsRole }) => {
  const caller = needsRole ? contributor : signedIn;
  test('refuses an API key before it acts', async () => {
    state.caller = { ...caller, apiKey: true };
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 403 });
    expect(state.acted).toEqual([]);
  });

  test('acts for a signed-in session', async () => {
    state.caller = caller;
    await handler(event);
    expect(state.acted).toContain(acts);
  });
});
