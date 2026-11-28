/**
 * Read-only mode: while the operator has it on, every write under `/api/` is refused with 409 `READ_ONLY`, the
 * reporter's too, except signing in and out, an MCP client's consent, the operator's routes and the reads sent as POST;
 * a GET that writes as a side effect answers without its write, every scheduled task skips, and `/api/notice` says so.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { READ_ONLY_MESSAGE, holdOperatorLimits } from '#shared/operator-limits';
import { ADMIN_ACCESS } from '#shared/permissions';
import { apiError } from '../../server/utils/api-error';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/database')>()),
  getDatabase: async () => state.db,
  getDialect: () => 'sqlite',
}));
vi.mock('../../server/utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/auth')>()),
  requireAuth: async () => ({ id: 1, role: 'administrator' }),
  getRequestAccess: async () => ADMIN_ACCESS,
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
vi.stubGlobal('defineTask', (task: unknown) => task);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('apiError', apiError);

const { readOnlyRefuses } = await import('../../server/utils/read-only-routes');
const { resetOperatorLimits, writeOperatorLimits } = await import('../../server/utils/operator-limits');
const middleware = (await import('../../server/middleware/read-only')).default as unknown as (event: {
  method: string;
  path: string;
}) => Promise<void>;
const notice = (await import('../../server/api/notice.get')).default as unknown as (
  event: unknown,
) => Promise<{ readOnly: boolean }>;
const { storageQuotaState } = await import('../../server/utils/storage-quota');
const { getOrComputeVisualDiff } = await import('../../server/utils/visual-diff');
const { recordShareLinkView } = await import('../../server/utils/share-links');

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));

afterEach(() => {
  resetOperatorLimits();
  vi.unstubAllEnvs();
});

describe('the requests read-only mode refuses', () => {
  const refused = (method: string, path: string) => readOnlyRefuses(method, path);

  test('every write of the reporter, a run in progress included', () => {
    for (const path of [
      '/api/test-runs/setup',
      '/api/test-runs/start',
      '/api/test-runs/submit',
      '/api/test-runs/upload',
      '/api/test-runs/upload/results',
      '/api/test-runs/import',
      '/api/test-runs/import/check',
      '/api/traces/check',
      '/api/test-runs/12/begin',
      '/api/test-runs/12/events',
      '/api/test-runs/12/heartbeat',
      '/api/test-runs/12/case-files',
      '/api/test-runs/12/live-resources',
      '/api/test-runs/12/finish',
    ]) {
      expect(refused('POST', path), path).toBe(true);
    }
  });

  test('every other family of writes, whatever its method', () => {
    expect(refused('PUT', '/api/settings/ai')).toBe(true);
    expect(refused('PATCH', '/api/failure-clusters/3/status')).toBe(true);
    expect(refused('DELETE', '/api/projects/4')).toBe(true);
    expect(refused('DELETE', '/api/test-runs/4')).toBe(true);
    expect(refused('POST', '/api/projects/4/bug-reports')).toBe(true);
    expect(refused('POST', '/api/users/1/api-keys')).toBe(true);
    expect(refused('POST', '/api/assistant/conversations')).toBe(true);
    expect(refused('POST', '/api/auth/setup')).toBe(true);
    expect(refused('POST', '/api/auth/reset-password')).toBe(true);
    expect(refused('POST', '/api/test-runs/12/gate')).toBe(true);
  });

  test('a write spelled another way: upper case, doubled slashes, a trailing slash or a query', () => {
    for (const path of [
      '/API/test-runs/submit',
      '//api/test-runs/submit',
      '/api//test-runs/submit',
      '/api/test-runs/submit/',
      '/api/test-runs/submit?x=1',
    ]) {
      expect(refused('POST', path), path).toBe(true);
    }
  });

  test('not signing in or out, an MCP client’s consent, the operator’s routes or a read sent as POST', () => {
    for (const [method, path] of [
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/logout'],
      ['POST', '/api/oauth/authorizations/abc/decision'],
      ['PUT', '/api/operator/limits'],
      ['DELETE', '/api/operator/notice'],
      ['POST', '/api/operator/admin-invite'],
      ['POST', '/api/widgets/preview'],
      ['POST', '/api/projects/4/selections/preview'],
      ['POST', '/api/projects/4/selections/impact'],
      ['POST', '/api/reports/schedules/preview'],
      ['POST', '/api/projects/4/run-plans/sources'],
    ] as const) {
      expect(refused(method, path), `${method} ${path}`).toBe(false);
    }
  });

  test('a read path with another method: a selection named preview is not deleted', () => {
    expect(refused('DELETE', '/api/projects/4/selections/preview')).toBe(true);
    expect(refused('PATCH', '/api/projects/4/selections/preview')).toBe(true);
    expect(refused('DELETE', '/api/auth/login')).toBe(true);
  });

  test('no read, and nothing outside the API', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(refused(method, '/api/test-runs/12/export'), method).toBe(false);
    }
    expect(refused('POST', '/mcp')).toBe(false);
    expect(refused('POST', '/oauth/token')).toBe(false);
    expect(refused('POST', '/login')).toBe(false);
  });
});

describe('with a database', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
  });
  afterEach(async () => {
    await close();
  });

  const readOnly = (on: boolean) => writeOperatorLimits(db as never, { readOnly: on });

  /** What the middleware answers a request: null when it lets it through. */
  async function answer(method: string, path: string) {
    try {
      await middleware({ method, path });
      return null;
    } catch (error) {
      const { statusCode, data, message } = error as {
        statusCode: number;
        data: { errorCode: string };
        message: string;
      };
      return { statusCode, errorCode: data.errorCode, message };
    }
  }

  test('the middleware refuses a write with 409 READ_ONLY while read-only, and nothing otherwise', async () => {
    expect(await answer('POST', '/api/test-runs/submit')).toBeNull();
    await readOnly(true);
    expect(await answer('POST', '/api/test-runs/submit')).toEqual({
      statusCode: 409,
      errorCode: 'READ_ONLY',
      message: READ_ONLY_MESSAGE,
    });
    expect(await answer('POST', '/api/test-runs/12/heartbeat')).toMatchObject({ statusCode: 409 });
    expect(await answer('GET', '/api/test-runs')).toBeNull();
    expect(await answer('POST', '/api/auth/login')).toBeNull();
    expect(await answer('PUT', '/api/operator/limits')).toBeNull();
    await readOnly(false);
    expect(await answer('DELETE', '/api/projects/4')).toBeNull();
  });

  test('the middleware follows read-only mode set by another process once the held value is stale', async () => {
    expect(await answer('POST', '/api/test-runs/submit')).toBeNull();
    await db.insert(schema.appSettings).values({ key: 'operator_limits', value: { readOnly: true } });
    resetOperatorLimits();
    expect(await answer('POST', '/api/test-runs/submit')).toMatchObject({ errorCode: 'READ_ONLY' });
  });

  test('/api/notice says whether the instance is read-only', async () => {
    expect((await notice({})).readOnly).toBe(false);
    holdOperatorLimits({ readOnly: true });
    expect((await notice({})).readOnly).toBe(true);
  });

  test('the storage quota’s record of going over is not written while read-only', async () => {
    holdOperatorLimits({ storageQuotaBytes: 1024 * 1024, readOnly: true });
    await db.update(schema.storageTotals).set({ bytes: 2 * 1024 * 1024 });
    const state = await storageQuotaState(db as never);
    expect(state).toMatchObject({ filesRefused: true, over: { ceilingBytes: expect.any(Number) } });
    const record = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'storage_quota_over'));
    expect(record).toEqual([]);
  });

  test('a visual diff not stored yet is not computed while read-only', async () => {
    holdOperatorLimits({ readOnly: true });
    expect(await getOrComputeVisualDiff(db as never, 1)).toEqual({ status: 'read-only' });
  });

  test('a share link’s view is not counted while read-only', async () => {
    const [user] = await db.insert(schema.users).values({ username: 'ro', password: 'x', role: 'member' }).returning();
    const [link] = await db
      .insert(schema.shareLinks)
      .values({ entityKind: 'cluster', entityId: 1, tokenHash: 'h', tokenPrefix: 'p', createdBy: user!.id })
      .returning();
    holdOperatorLimits({ readOnly: true });
    await recordShareLinkView(db as never, link!.id);
    const [after] = await db.select().from(schema.shareLinks).where(eq(schema.shareLinks.id, link!.id));
    expect(after!.viewCount).toBe(0);
  });

  test('every scheduled task skips while read-only', async () => {
    await readOnly(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    try {
      for (const file of taskFiles()) {
        const task = (await import(/* @vite-ignore */ file)).default as { run(): Promise<{ result: unknown }> };
        expect(await task.run(), relative(APP_DIR, file)).toEqual({ result: { skipped: 'read-only' } });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Every scheduled task's file. */
function taskFiles(): string[] {
  const dir = join(APP_DIR, 'server/tasks');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

describe('the code that changes data in the background', () => {
  test('asks whether the instance is read-only: every scheduled task and the plugins that write', () => {
    const plugins = ['stale-run-cleanup', 'stuck-tests', 'locator-index-backfill', 'run-branch-backfill'].map((name) =>
      join(APP_DIR, `server/plugins/${name}.ts`),
    );
    for (const file of [...taskFiles(), ...plugins]) {
      expect(readFileSync(file, 'utf8'), relative(APP_DIR, file)).toContain('readOnlyNow(');
    }
  });
});
