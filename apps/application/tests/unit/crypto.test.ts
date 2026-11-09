import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, eventHandler, toWebHandler } from 'h3';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import {
  DEFAULT_INSECURE_SECRET,
  canEncryptSecrets,
  decryptSecret,
  encryptSecret,
  getEncryptionKey,
} from '../../server/utils/crypto';
import { createConnection } from '../../server/utils/integrations/connections';
import { migrateToLatest } from './temp-db';

const KEY = 'unit-test-secret-key-not-for-production';
const GENERATE_COMMAND = `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encryptSecret', () => {
  test('round-trips through decryptSecret with a configured key', () => {
    const sealed = encryptSecret('sk-live-token', KEY);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('sk-live-token');
    expect(decryptSecret(sealed, KEY)).toBe('sk-live-token');
  });

  test.each([
    ['no key', ''],
    ['the published default', DEFAULT_INSECURE_SECRET],
  ])('refuses %s with a 409 naming PIWI_SECRET_KEY and how to generate one', (_label, secret) => {
    expect(() => encryptSecret('sk-live-token', secret)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        data: { errorCode: 'SECRET_KEY_NOT_CONFIGURED' },
        message: expect.stringContaining(GENERATE_COMMAND),
      }),
    );
    expect(() => encryptSecret('sk-live-token', secret)).toThrow(/configured PIWI_SECRET_KEY/);
  });

  test('an endpoint storing a secret answers 409', async () => {
    vi.stubEnv('PIWI_SECRET_KEY', '');
    const app = createApp().use(
      '/',
      eventHandler(() => ({ stored: encryptSecret('sk-live-token', getEncryptionKey()) })),
    );
    const res = await toWebHandler(app)(new Request('http://localhost/', { method: 'POST' }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { data: { errorCode: string } };
    expect(body.data.errorCode).toBe('SECRET_KEY_NOT_CONFIGURED');
  });
});

describe('canEncryptSecrets', () => {
  test('is true only for a key other than the published default', () => {
    vi.stubEnv('PIWI_SECRET_KEY', KEY);
    expect(canEncryptSecrets()).toBe(true);
    vi.stubEnv('PIWI_SECRET_KEY', DEFAULT_INSECURE_SECRET);
    expect(canEncryptSecrets()).toBe(false);
    vi.stubEnv('PIWI_SECRET_KEY', '');
    expect(canEncryptSecrets()).toBe(false);
  });
});

describe('creating a connection without PIWI_SECRET_KEY', () => {
  let tmpDir: string;
  let client: ReturnType<typeof createClient>;
  let dbc: DbClient;

  beforeEach(async () => {
    vi.stubEnv('PIWI_SECRET_KEY', '');
    tmpDir = mkdtempSync(join(tmpdir(), 'piwi-crypto-'));
    client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
    const db = drizzle(client, { schema });
    await migrateToLatest(db);
    dbc = db as unknown as DbClient;
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('answers 409 for credentials and writes no row', async () => {
    await expect(
      createConnection(dbc, {
        provider: 'jira',
        name: 'Team Jira',
        baseUrl: 'https://team.atlassian.net',
        credentials: { email: 'me@team.io', apiToken: 'secret-token' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, data: { errorCode: 'SECRET_KEY_NOT_CONFIGURED' } });
    expect(await dbc.select().from(schema.integrationConnections)).toHaveLength(0);
  });

  test('still saves a connection that carries no credentials', async () => {
    const created = await createConnection(dbc, {
      provider: 'jira',
      name: 'Team Jira',
      baseUrl: 'https://team.atlassian.net',
    });
    expect(created.hasCredentials).toBe(false);
  });
});
