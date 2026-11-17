import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { ADMIN_ACCESS, InstanceRole, type AccessSummary } from '#shared/permissions';
import { credentialReferences, namedForEveryProject } from '#shared/handlers/credentials';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The bot token of a Slack channel of the instance as a credential: the token
 * typed for a global channel is saved as one named after it, a saved one can
 * be named instead, a personal channel keeps its own token, each message is a
 * row of the credential's log naming its channel, a refused credential sends
 * nothing, and the tokens global channels held are moved at startup.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = '0123456789abcdef'.repeat(4);

const state = vi.hoisted(() => ({ db: null as unknown, authEnabled: true, access: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 1 }),
  getRequestAccess: async () => state.access ?? ADMIN_ACCESS,
  isAuthEnabled: () => state.authEnabled,
}));
type RouteEvent = { body?: unknown; params?: Record<string, string>; query?: Record<string, string> };
function stubRouteGlobals() {
  vi.stubGlobal('defineRouteMeta', () => {});
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
  vi.stubGlobal('getQuery', (event: RouteEvent) => event.query ?? {});
  vi.stubGlobal('getRouterParam', (event: RouteEvent, name: string) => event.params?.[name]);
  vi.stubGlobal('apiError', apiError);
}
stubRouteGlobals();

const createChannel = (await import('../../server/api/channels/index.post')).default as unknown as (event: {
  body: unknown;
  context: Record<string, unknown>;
}) => Promise<{ channel: { id: number; config: Record<string, unknown> } }>;
const { importSlackChannelTokens, postSlackWithCredential } =
  await import('../../server/utils/notifications/slack-credentials');
const deleteChannel = (await import('../../server/api/channels/[id].delete')).default as unknown as (
  event: RouteEvent & { context: Record<string, unknown> },
) => Promise<{ credentialDeleted: boolean }>;
const deleteConnection = (await import('../../server/api/integrations/connections/[id].delete')).default as unknown as (
  event: RouteEvent & { context: Record<string, unknown> },
) => Promise<{ credentialDeleted: boolean }>;
const { createConnection } = await import('../../server/utils/integrations/connections');
const testUnsavedChannel = (await import('../../server/api/channels/test.post')).default as unknown as (
  event: RouteEvent & { context: Record<string, unknown> },
) => Promise<{ success: boolean; error?: string }>;
const { slackChannelCredentialProblem } = await import('#shared/handlers/credentials');
const { insertCredential } = await import('#shared/handlers/credentials');
const { sealCredentialSecret } = await import('../../server/utils/credentials');
const { CredentialRefusedError } = await import('../../server/utils/credentials');
const { encryptSecret, getEncryptionKey } = await import('../../server/utils/crypto');

const TOKEN = 'xoxb-1111-2222-secret';
let db: TempDb;
let close: () => Promise<void>;
const posted: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.users).values({ id: 1, username: 'avery', password: '', role: 'administrator' });
});
afterAll(async () => {
  delete process.env.PIWI_SECRET_KEY;
  await close();
});
beforeEach(async () => {
  posted.length = 0;
  state.authEnabled = true;
  state.access = null;
  await db.delete(schema.notificationChannels);
  await db.delete(schema.credentialUses);
  await db.delete(schema.credentials);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      posted.push({ authorization: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  stubRouteGlobals();
});

const create = (config: Record<string, unknown>, global = true, name = 'Releases') =>
  createChannel({ body: { name, type: 'slack', config, global }, context: {} });

const credentialRows = () =>
  db
    .select({
      id: schema.credentials.id,
      name: schema.credentials.name,
      service: schema.credentials.service,
      destination: schema.credentials.destination,
      allProjects: schema.credentials.allProjects,
    })
    .from(schema.credentials)
    .orderBy(asc(schema.credentials.id));

describe('a Slack channel of the instance', () => {
  test('keeps the bot token typed for it as a credential named after it, and its config names it', async () => {
    const { channel } = await create({ token: ` ${TOKEN} `, channelId: 'C0123456789' });
    const [credential] = await credentialRows();
    expect(credential).toMatchObject({
      name: 'Releases',
      service: 'slack',
      destination: 'https://slack.com/api/',
      allProjects: true,
    });
    expect(channel.config).toEqual({ credentialId: credential!.id, channelId: 'C0123456789' });
    expect((await credentialReferences(db as never)).get(credential!.id)).toEqual([
      { kind: 'channel', projectId: null, projectName: null, actionId: null, name: 'Releases' },
    ]);
    expect(await namedForEveryProject(db as never, credential!.id)).toBe(true);
  });

  test('posts each message with its credential as one log row naming the channel', async () => {
    const { channel } = await create({ token: TOKEN, channelId: 'C0123456789' });
    const credentialId = channel.config.credentialId as number;
    await postSlackWithCredential(db as never, {
      credentialId,
      channel: { id: channel.id, slackChannelId: 'C0123456789' },
      message: { text: 'hello' },
      projectId: null,
    });
    expect(posted).toEqual([{ authorization: `Bearer ${TOKEN}`, body: { text: 'hello', channel: 'C0123456789' } }]);
    const uses = await db
      .select({
        feature: schema.credentialUses.feature,
        result: schema.credentialUses.result,
        subjectType: schema.credentialUses.subjectType,
        subjectId: schema.credentialUses.subjectId,
      })
      .from(schema.credentialUses);
    expect(uses).toEqual([
      { feature: 'notification', result: 'ok', subjectType: 'channel', subjectId: String(channel.id) },
    ]);
  });

  test('sends nothing once its credential is disabled', async () => {
    const { channel } = await create({ token: TOKEN, channelId: 'C0123456789' });
    const credentialId = channel.config.credentialId as number;
    await db.update(schema.credentials).set({ disabled: true }).where(eq(schema.credentials.id, credentialId));
    await expect(
      postSlackWithCredential(db as never, {
        credentialId,
        channel: { id: channel.id, slackChannelId: 'C0123456789' },
        message: { text: 'hello' },
      }),
    ).rejects.toBeInstanceOf(CredentialRefusedError);
    expect(posted).toEqual([]);
  });

  test('can name a saved Slack credential instead of a token, but a personal channel cannot', async () => {
    const first = await create({ token: TOKEN, channelId: 'C0123456789' });
    const credentialId = first.channel.config.credentialId as number;
    const second = await create({ credentialId, channelId: 'C0987654321' }, true, 'Nightly');
    expect(second.channel.config).toEqual({ credentialId, channelId: 'C0987654321' });
    expect(await credentialRows()).toHaveLength(1);
    await expect(create({ credentialId, channelId: 'C0987654321' }, false, 'Mine')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(create({ credentialId: 999, channelId: 'C0987654321' }, true, 'Nope')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('a personal channel keeps its own token, encrypted, and makes no credential', async () => {
    const { channel } = await create({ token: TOKEN, channelId: 'C0123456789' }, false, 'Mine');
    expect(channel.config).toEqual({ channelId: 'C0123456789' });
    const [row] = await db
      .select({ config: schema.notificationChannels.config, userId: schema.notificationChannels.userId })
      .from(schema.notificationChannels);
    expect(row?.userId).toBe(1);
    const sealed = (row!.config as Record<string, unknown>).token as string;
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(await credentialRows()).toEqual([]);
  });
});

describe('importSlackChannelTokens', () => {
  const channelWithToken = async (name: string, token: string, userId: number | null = null) => {
    const [row] = await db
      .insert(schema.notificationChannels)
      .values({
        name,
        type: 'slack',
        config: { token: encryptSecret(token, getEncryptionKey()), channelId: 'C0123456789' },
        userId,
        verified: true,
      })
      .returning();
    return row!;
  };

  test('leaves a token it cannot open where it is', async () => {
    const [row] = await db
      .insert(schema.notificationChannels)
      .values({
        name: 'Broken',
        type: 'slack',
        config: { token: 'v1:not-a-sealed-value', channelId: 'C0123456789' },
        userId: null,
        verified: true,
      })
      .returning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await importSlackChannelTokens(db as never)).toBe(0);
    const [after] = await db
      .select({ config: schema.notificationChannels.config })
      .from(schema.notificationChannels)
      .where(eq(schema.notificationChannels.id, row!.id));
    expect(after?.config).toEqual({ token: 'v1:not-a-sealed-value', channelId: 'C0123456789' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('moves the global channels’ tokens to credentials, equal tokens sharing one, once', async () => {
    const a = await channelWithToken('Releases', TOKEN);
    const b = await channelWithToken('Nightly', TOKEN);
    const c = await channelWithToken('Other workspace', 'xoxb-other');
    const mine = await channelWithToken('Mine', TOKEN, 1);
    expect(await importSlackChannelTokens(db as never)).toBe(3);
    expect(await importSlackChannelTokens(db as never)).toBe(0);

    const configs = new Map(
      (
        await db
          .select({ id: schema.notificationChannels.id, config: schema.notificationChannels.config })
          .from(schema.notificationChannels)
      ).map((row) => [row.id, row.config as Record<string, unknown>]),
    );
    const credentials = await credentialRows();
    expect(credentials.map((credential) => credential.name)).toEqual(['Releases', 'Other workspace']);
    expect(configs.get(a.id)).toEqual({ credentialId: credentials[0]!.id, channelId: 'C0123456789' });
    expect(configs.get(b.id)).toEqual({ credentialId: credentials[0]!.id, channelId: 'C0123456789' });
    expect(configs.get(c.id)).toEqual({ credentialId: credentials[1]!.id, channelId: 'C0123456789' });
    expect(configs.get(mine.id)?.token).toEqual(expect.any(String));

    await postSlackWithCredential(db as never, {
      credentialId: credentials[0]!.id,
      channel: { id: a.id, slackChannelId: 'C0123456789' },
      message: { text: 'moved' },
    });
    expect(posted[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('deleting what names a credential', () => {
  const removeChannel = (id: number, deleteCredential: boolean) =>
    deleteChannel({
      params: { id: String(id) },
      query: deleteCredential ? { deleteCredential: 'true' } : {},
      context: {},
    });

  test('a channel deletes its credential when asked and nothing else names it', async () => {
    const { channel } = await create({ token: TOKEN, channelId: 'C0123456789' });
    expect(await removeChannel(channel.id, true)).toMatchObject({ credentialDeleted: true });
    expect(await credentialRows()).toEqual([]);
  });

  test('a channel keeps its credential when not asked, or while another channel names it', async () => {
    const first = await create({ token: TOKEN, channelId: 'C0123456789' });
    const credentialId = first.channel.config.credentialId as number;
    const second = await create({ credentialId, channelId: 'C0987654321' }, true, 'Nightly');
    expect(await removeChannel(second.channel.id, true)).toMatchObject({ credentialDeleted: false });
    expect(await removeChannel(first.channel.id, false)).toMatchObject({ credentialDeleted: false });
    expect(await credentialRows()).toHaveLength(1);
  });

  test('a connection deletes its credential when asked, and keeps it otherwise', async () => {
    await db.delete(schema.integrationConnections);
    const jira = (name: string) =>
      createConnection(db as never, {
        provider: 'jira',
        name,
        baseUrl: 'https://team.atlassian.net',
        credentials: { email: 'me@team.io', apiToken: 'jira-token' },
      });
    const kept = await jira('Kept');
    const asked = await jira('Asked');
    const remove = (id: number, deleteCredential: boolean) =>
      deleteConnection({
        params: { id: String(id) },
        query: deleteCredential ? { deleteCredential: 'true' } : {},
        context: {},
      });
    expect(await remove(kept.id, false)).toMatchObject({ credentialDeleted: false });
    expect(await remove(asked.id, true)).toMatchObject({ credentialDeleted: true });
    expect((await credentialRows()).map((credential) => credential.name)).toEqual(['Kept']);
  });
});

describe('who may send with a saved Slack credential', () => {
  const MEMBER: AccessSummary = { instanceRole: InstanceRole.MEMBER, allProjects: [], projects: {} };
  const slackCredential = (name: string, fields: { destination?: string; allProjects?: boolean } = {}) =>
    insertCredential(
      db as never,
      {
        name,
        description: null,
        service: 'slack',
        user: null,
        destination: fields.destination ?? 'https://slack.com/api/',
        scope: fields.allProjects === false ? { allProjects: false, projectIds: [] } : { allProjects: true },
        allowedInputs: null,
        customRequests: false,
        disabled: false,
      },
      sealCredentialSecret(fields.destination ?? 'https://slack.com/api/', TOKEN),
      null,
    );

  test('a test before saving sends with one for an administrator, and refuses anyone else', async () => {
    const credentialId = await slackCredential('Slack · bot');
    const event = { body: { type: 'slack', config: { credentialId, channelId: 'C0123456789' } }, context: {} };
    expect(await testUnsavedChannel(event)).toEqual({ success: true });
    expect(posted).toHaveLength(1);
    state.access = MEMBER;
    await expect(testUnsavedChannel(event)).rejects.toMatchObject({ statusCode: 403 });
    expect(posted).toHaveLength(1);
  });

  test('a channel names only one shared with all projects and sent to the Web API', async () => {
    expect(
      await slackChannelCredentialProblem(db as never, await slackCredential('Narrow', { allProjects: false })),
    ).toContain('is not shared with all projects');
    expect(
      await slackChannelCredentialProblem(
        db as never,
        await slackCredential('Elsewhere', { destination: 'https://hooks.slack.com/' }),
      ),
    ).toContain('not to Slack’s Web API');
  });

  test('only an administrator deletes a channel’s credential with it', async () => {
    const { channel } = await create({ token: TOKEN, channelId: 'C0123456789' }, false, 'Mine');
    const credentialId = await slackCredential('Slack · shared');
    await db
      .update(schema.notificationChannels)
      .set({ config: { credentialId, channelId: 'C0123456789' } })
      .where(eq(schema.notificationChannels.id, channel.id));
    state.access = MEMBER;
    expect(
      await deleteChannel({ params: { id: String(channel.id) }, query: { deleteCredential: 'true' }, context: {} }),
    ).toMatchObject({ credentialDeleted: false });
    expect((await credentialRows()).map((credential) => credential.id)).toEqual([credentialId]);
  });
});
