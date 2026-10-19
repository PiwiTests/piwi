import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';

/**
 * First-admin setup through its routes: it stays open while no administrator
 * exists, and with `PIWI_SETUP_TOKEN` set the form says it needs the token and
 * the setup refuses a request without it.
 */

delete process.env.PIWI_DATABASE_URL;
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: { body: unknown }) => event.body);
vi.stubGlobal('apiError', apiError);

type Handler = (event: unknown) => Promise<any>;
const setup = (await import('../../server/api/auth/setup.post')).default as unknown as Handler;
const setupStatus = (await import('../../server/api/auth/setup.get')).default as unknown as Handler;

let address = 0;
const request = (body: Record<string, unknown> = {}) => ({
  body: { username: 'admin', password: 'correct-horse', ...body },
  context: {},
  node: { req: { headers: {}, socket: { remoteAddress: `10.3.3.${address}` } }, res: { setHeader: () => {} } },
});

beforeEach(async () => {
  address += 1;
  const db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  state.db = db;
  vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
});

afterAll(() => vi.unstubAllEnvs());

describe('first-admin setup with PIWI_SETUP_TOKEN set', () => {
  beforeEach(() => vi.stubEnv('PIWI_SETUP_TOKEN', 'the-deploy-token'));

  test('the form asks for the token', async () => {
    expect(await setupStatus(request())).toEqual({ needsSetup: true, setupTokenRequired: true });
  });

  test('refuses a request without the token or with a wrong one, and creates the admin with it', async () => {
    await expect(setup(request())).rejects.toMatchObject({ statusCode: 403 });
    await expect(setup(request({ setupToken: 'guess' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(await setup(request({ setupToken: 'the-deploy-token' }))).toMatchObject({
      success: true,
      user: { username: 'admin', role: 'administrator' },
    });
    expect(await setupStatus(request())).toEqual({ needsSetup: false, setupTokenRequired: false });
  });
});

describe('first-admin setup while only members exist', () => {
  beforeEach(async () => {
    vi.stubEnv('PIWI_SETUP_TOKEN', '');
    // The first OAuth sign-ins create members, never an administrator.
    await (state.db as ReturnType<typeof drizzle<typeof schema>>)
      .insert(schema.users)
      .values({ username: 'ada@example.com', password: '', role: 'member', oauthProvider: 'github' });
  });

  test('stays open, refuses a username a member holds, and closes once an administrator exists', async () => {
    expect(await setupStatus(request())).toEqual({ needsSetup: true, setupTokenRequired: false });
    await expect(setup(request({ username: 'ada@example.com' }))).rejects.toMatchObject({ statusCode: 409 });
    expect(await setup(request())).toMatchObject({ success: true, user: { role: 'administrator' } });
    expect(await setupStatus(request())).toEqual({ needsSetup: false, setupTokenRequired: false });
    await expect(setup(request({ username: 'second' }))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('first-admin setup without a token', () => {
  beforeEach(() => vi.stubEnv('PIWI_SETUP_TOKEN', ''));

  test('the form asks for none, and the first request creates the admin', async () => {
    expect(await setupStatus(request())).toEqual({ needsSetup: true, setupTokenRequired: false });
    expect(await setup(request())).toMatchObject({ success: true });
  });
});
