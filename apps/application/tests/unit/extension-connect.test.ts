import { describe, test, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;
const {
  startDeviceConnect,
  pollDeviceConnect,
  decideDeviceConnect,
  describeConnectRequest,
  normalizeUserCode,
  generateUserCode,
  connectClientKind,
  extensionClientName,
  DEVICE_CODE_TTL_MS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  SLOW_DOWN_STEP_SECONDS,
  CONNECT_RATE_LIMITS,
  USER_CODE_ALPHABET,
} = await import('../../server/utils/extension-connect');
const { checkRateLimit, resetRateLimit } = await import('../../server/utils/rate-limit');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let userId: number;

const T0 = new Date('2026-09-01T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [user] = await db
    .insert(schema.users)
    .values({ username: 'tester', password: 'x', role: 'member', name: 'Test User' })
    .returning();
  userId = user!.id;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyDb = () => db as any;

async function started(now = T0) {
  return startDeviceConnect(anyDb(), { browser: 'Chrome', os: 'Windows' }, now);
}

describe('codes', () => {
  test('a user code is two groups of four letters from the alphabet, and normalizes loosely', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    for (const ch of code.replace('-', '')) expect(USER_CODE_ALPHABET).toContain(ch);
    expect(normalizeUserCode(code.toLowerCase().replace('-', ' '))).toBe(code.replace('-', ''));
    expect(normalizeUserCode('ABCD-EFGH')).toBeNull(); // vowels are not in the alphabet
    expect(normalizeUserCode('BCDF')).toBeNull();
    expect(normalizeUserCode(42)).toBeNull();
  });

  test('the client name keeps only plain words', () => {
    expect(extensionClientName({ browser: 'Chrome', os: 'Windows' })).toBe('Piwi Picker in Chrome on Windows');
    expect(extensionClientName({ browser: '<b>Edge</b>', os: 'macOS' })).toBe('Piwi Picker in bEdgeb on macOS');
    expect(extensionClientName({})).toBe('Piwi Picker in a browser');
    expect(extensionClientName({ browser: 'x'.repeat(100) }).length).toBeLessThanOrEqual('Piwi Picker in '.length + 40);
  });

  test('an editor is named after itself, and read back as an editor', () => {
    expect(extensionClientName({ editor: 'VS Code', os: 'macOS' })).toBe('Piwi in VS Code on macOS');
    expect(extensionClientName({ editor: 'Rider' })).toBe('Piwi in Rider');
    expect(extensionClientName({ editor: '' })).toBe('Piwi in an editor');
    expect(connectClientKind('Piwi in VS Code on macOS')).toBe('editor');
    expect(connectClientKind('Piwi Picker in Chrome on Windows')).toBe('picker');
  });

  test('only the hashes of both codes are stored', async () => {
    const start = await started();
    expect(start.deviceCode).toMatch(/^pdc_[0-9a-f]{64}$/);
    expect(start.expiresIn).toBe(DEVICE_CODE_TTL_MS / 1000);
    expect(start.interval).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    const [row] = await db.select().from(schema.extensionDeviceCodes);
    expect(row!.deviceCodeHash).toBe(createHash('sha256').update(start.deviceCode).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(start.deviceCode.slice(4));
    expect(JSON.stringify(row)).not.toContain(start.userCode.replace('-', ''));
    expect(row!.clientName).toBe('Piwi Picker in Chrome on Windows');
  });
});

describe('the flow', () => {
  test('pending until allowed, then one key for the user, returned once', async () => {
    const start = await started();
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(5))).toEqual({ status: 'pending' });

    const view = await describeConnectRequest(anyDb(), start.userCode, at(6));
    expect(view).toMatchObject({ userCode: start.userCode, status: 'pending', clientName: expect.any(String) });

    expect(await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId, allow: true }, at(7))).toBe(
      'approved',
    );
    const approved = await pollDeviceConnect(anyDb(), start.deviceCode, at(10));
    expect(approved).toMatchObject({ status: 'approved', user: { name: 'Test User' } });
    const apiKey = (approved as { apiKey: string }).apiKey;
    expect(apiKey).toMatch(/^pd_[0-9a-f]{64}$/);

    const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, userId));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).toBe('Piwi Picker in Chrome on Windows');
    expect(keys[0]!.keyHash).toBe(createHash('sha256').update(apiKey).digest('hex'));

    // Single use: the next poll never sees the key again.
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(15))).toEqual({ status: 'expired' });
    expect(await db.select().from(schema.apiKeys)).toHaveLength(1);
    expect((await describeConnectRequest(anyDb(), start.userCode, at(16)))!.status).toBe('consumed');
  });

  test('two concurrent polls of an approved request yield one key', async () => {
    const start = await started();
    await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId, allow: true }, at(1));
    const answers = await Promise.all([
      pollDeviceConnect(anyDb(), start.deviceCode, at(6)),
      pollDeviceConnect(anyDb(), start.deviceCode, at(6)),
    ]);
    expect(answers.filter((a) => a.status === 'approved')).toHaveLength(1);
    expect(await db.select().from(schema.apiKeys)).toHaveLength(1);
  });

  test('denied: no key, and the request cannot be allowed afterwards', async () => {
    const start = await started();
    expect(await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId, allow: false }, at(3))).toBe(
      'denied',
    );
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(6))).toEqual({ status: 'denied' });
    expect(await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId, allow: true }, at(7))).toBe(
      'already-decided',
    );
    expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  test('expires after ten minutes, allowed or not', async () => {
    const late = DEVICE_CODE_TTL_MS / 1000 + 1;
    const a = await started();
    expect(await pollDeviceConnect(anyDb(), a.deviceCode, at(late))).toEqual({ status: 'expired' });
    expect(await decideDeviceConnect(anyDb(), { userCode: a.userCode, userId, allow: true }, at(late))).toBe('expired');
    expect((await describeConnectRequest(anyDb(), a.userCode, at(late)))!.status).toBe('expired');

    const b = await started();
    await decideDeviceConnect(anyDb(), { userCode: b.userCode, userId, allow: true }, at(10));
    expect(await pollDeviceConnect(anyDb(), b.deviceCode, at(late))).toEqual({ status: 'expired' });
    expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  test('polling faster than the interval answers slow_down and lengthens it', async () => {
    const start = await started();
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(5))).toEqual({ status: 'pending' });
    const fast = await pollDeviceConnect(anyDb(), start.deviceCode, at(6));
    expect(fast).toEqual({ status: 'slow_down', interval: DEFAULT_POLL_INTERVAL_SECONDS + SLOW_DOWN_STEP_SECONDS });
    // Waiting the new interval is fine again.
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(16))).toEqual({ status: 'pending' });
  });

  test('an unknown or malformed device code reads as expired', async () => {
    expect(await pollDeviceConnect(anyDb(), `pdc_${'0'.repeat(64)}`, T0)).toEqual({ status: 'expired' });
    expect(await pollDeviceConnect(anyDb(), 'nope', T0)).toEqual({ status: 'expired' });
    expect(await pollDeviceConnect(anyDb(), undefined, T0)).toEqual({ status: 'expired' });
    expect(await describeConnectRequest(anyDb(), 'BCDF-GHJK', T0)).toBeNull();
    expect(await decideDeviceConnect(anyDb(), { userCode: 'BCDF-GHJK', userId, allow: true }, T0)).toBe('not-found');
  });

  test('with authentication off, allowing yields an empty key and creates none', async () => {
    const start = await started();
    await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId: null, allow: true }, at(1));
    expect(await pollDeviceConnect(anyDb(), start.deviceCode, at(6))).toEqual({
      status: 'approved',
      apiKey: '',
      user: null,
    });
    expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  test('revoking the key keeps the request row', async () => {
    const start = await started();
    await decideDeviceConnect(anyDb(), { userCode: start.userCode, userId, allow: true }, at(1));
    await pollDeviceConnect(anyDb(), start.deviceCode, at(6));
    await db.delete(schema.apiKeys);
    const [row] = await db.select().from(schema.extensionDeviceCodes);
    expect(row!.apiKeyId).toBeNull();
    expect(row!.status).toBe('consumed');
  });

  test('a start deletes requests expired for more than a day', async () => {
    await started(new Date(T0.getTime() - 2 * 24 * 3600 * 1000));
    await started();
    expect(await db.select().from(schema.extensionDeviceCodes)).toHaveLength(1);
  });
});

describe('rate limits', () => {
  test('starts are limited per address', () => {
    const key = 'extension-connect:start:test-ip';
    resetRateLimit(key);
    const { limit, windowMs } = CONNECT_RATE_LIMITS.start;
    for (let i = 0; i < limit; i++) expect(checkRateLimit(key, limit, windowMs)).toBe(true);
    expect(checkRateLimit(key, limit, windowMs)).toBe(false);
    resetRateLimit(key);
  });

  test('polling is limited per address well above what one honest client sends', () => {
    const { limit, windowMs } = CONNECT_RATE_LIMITS.token;
    // One client polling every interval for the whole lifetime of a request stays under it.
    expect(DEVICE_CODE_TTL_MS / (DEFAULT_POLL_INTERVAL_SECONDS * 1000)).toBeLessThanOrEqual(limit);
    expect(windowMs).toBeGreaterThanOrEqual(DEVICE_CODE_TTL_MS);
  });
});
