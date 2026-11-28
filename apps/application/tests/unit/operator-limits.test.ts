/**
 * The operator's limits: what `PUT /api/operator/limits` takes, where each limit comes from (the operator, the
 * environment or the default), a lowered retention's 14 days, and every reader of a limit honoring the operator's
 * value: the storage quota, the upload sizes, the retention sweep. The values are held in memory and read again once
 * they are older than the TTL, so a second process follows a change.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { H3Event } from 'h3';
import { eq } from 'drizzle-orm';
import {
  applyOperatorLimits,
  heldOperatorLimits,
  holdOperatorLimits,
  instanceLimitsOf,
  operatorLimitsInputSchema,
  readStoredOperatorLimits,
  retentionDaysSetting,
  RETENTION_LOWERING_WAIT_DAYS,
} from '#shared/operator-limits';
import {
  DEFAULT_MAX_SUBMIT_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_IMPORT_MAX_BYTES,
  MAX_SUBMIT_MAX_BYTES,
} from '#shared/upload-limits';
import { reportedNotKept } from '#shared/ingest-health';
import { apiError } from '../../server/utils/api-error';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/database')>()),
  getDatabase: async () => state.db,
}));

interface RouteEvent {
  body?: unknown;
  node: { req: { headers: Record<string, string>; socket: { remoteAddress: string } }; res: { setHeader(): void } };
  context: Record<string, unknown>;
}
vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('readBody', async (event: RouteEvent) => event.body);
vi.stubGlobal('apiError', apiError);

type Route = (event: unknown) => Promise<Record<string, any>>;
const getLimits = (await import('../../server/api/operator/limits.get')).default as unknown as Route;
const putLimits = (await import('../../server/api/operator/limits.put')).default as unknown as Route;
const { OPERATOR_LIMITS_TTL_MS, loadOperatorLimits, resetOperatorLimits, writeOperatorLimits } =
  await import('../../server/utils/operator-limits');
const { OPERATOR_TOKEN_MIN_LENGTH } = await import('../../server/utils/operator');
const { resetRateLimit } = await import('../../server/utils/rate-limit');
const { storageQuotaBytes } = await import('../../server/utils/storage-quota');
const { resolveMaxImportBytes, resolveMaxSubmitBytes, resolveMaxUploadBytes } =
  await import('../../server/utils/upload-limits');
const { retentionDays } = await import('../../server/utils/retention');

const TOKEN = 'l'.repeat(OPERATOR_TOKEN_MIN_LENGTH);
const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-27T12:00:00.000Z');

/** A request carrying `authorization` and `body`. */
function request(authorization: string | null, body?: unknown): RouteEvent {
  return {
    body,
    context: {},
    node: {
      req: { headers: authorization === null ? {} : { authorization }, socket: { remoteAddress: '192.0.2.40' } },
      res: { setHeader: () => {} },
    },
  };
}

/** The status a route answers, 200 when it answers. */
async function status(route: Route, event: RouteEvent): Promise<number> {
  try {
    await route(event as unknown as H3Event);
    return 200;
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

const ENV_VARS = ['PIWI_STORAGE_QUOTA_BYTES', 'PIWI_IMPORT_MAX_BYTES', 'PIWI_SUBMIT_MAX_BYTES', 'PIWI_RETENTION_DAYS'];

afterEach(() => {
  resetOperatorLimits();
  vi.unstubAllEnvs();
  for (const name of ENV_VARS) delete process.env[name];
});

describe('what the operator sends', () => {
  const accepts = (input: unknown) => operatorLimitsInputSchema.safeParse(input).success;

  test('takes any of the limits, a number or a boolean setting it and null clearing it', () => {
    expect(accepts({})).toBe(true);
    expect(
      accepts({
        storageQuotaBytes: MIB,
        importMaxBytes: MAX_IMPORT_MAX_BYTES,
        submitMaxBytes: MIB,
        retentionDays: 0,
        readOnly: true,
      }),
    ).toBe(true);
    expect(
      accepts({
        storageQuotaBytes: null,
        importMaxBytes: null,
        submitMaxBytes: null,
        retentionDays: null,
        readOnly: null,
      }),
    ).toBe(true);
  });

  test('refuses a value out of its variable’s bounds, a fraction, a string and an unknown field', () => {
    expect(accepts({ storageQuotaBytes: MIB - 1 })).toBe(false);
    expect(accepts({ importMaxBytes: MIB - 1 })).toBe(false);
    expect(accepts({ importMaxBytes: MAX_IMPORT_MAX_BYTES + 1 })).toBe(false);
    expect(accepts({ submitMaxBytes: MAX_SUBMIT_MAX_BYTES + 1 })).toBe(false);
    expect(accepts({ retentionDays: -1 })).toBe(false);
    expect(accepts({ retentionDays: 1.5 })).toBe(false);
    expect(accepts({ retentionDays: '30' })).toBe(false);
    expect(accepts({ readOnly: 'yes' })).toBe(false);
    expect(accepts({ retentionMinRuns: 3 })).toBe(false);
  });

  test('is read back field by field, a field that is not one left out', () => {
    expect(readStoredOperatorLimits({ storageQuotaBytes: 5, importMaxBytes: 2 * MIB, readOnly: 'no' })).toEqual({
      importMaxBytes: 2 * MIB,
    });
    expect(readStoredOperatorLimits('nonsense')).toEqual({});
    expect(readStoredOperatorLimits(null)).toEqual({});
  });
});

describe('where each limit comes from', () => {
  test('the default with nothing set', () => {
    expect(instanceLimitsOf({}, {}, NOW)).toEqual({
      storageQuotaBytes: { value: null, source: 'default' },
      importMaxBytes: { value: DEFAULT_MAX_UPLOAD_BYTES, source: 'default' },
      submitMaxBytes: { value: DEFAULT_MAX_SUBMIT_BYTES, source: 'default' },
      retentionDays: { value: null, source: 'default', pending: null },
      readOnly: { value: false, source: 'default' },
    });
  });

  test('the environment, clamped as each variable is, and the operator over it', () => {
    const env = {
      PIWI_STORAGE_QUOTA_BYTES: String(10 * MIB),
      PIWI_IMPORT_MAX_BYTES: '1',
      PIWI_SUBMIT_MAX_BYTES: String(64 * MIB),
      PIWI_RETENTION_DAYS: '30',
    };
    expect(instanceLimitsOf({}, env, NOW)).toMatchObject({
      storageQuotaBytes: { value: 10 * MIB, source: 'environment' },
      importMaxBytes: { value: MIB, source: 'environment' },
      submitMaxBytes: { value: 64 * MIB, source: 'environment' },
      retentionDays: { value: 30, source: 'environment', pending: null },
    });
    const stored = { storageQuotaBytes: 2 * MIB, importMaxBytes: 3 * MIB, submitMaxBytes: 4 * MIB, retentionDays: 90 };
    expect(instanceLimitsOf({ ...stored, readOnly: false }, env, NOW)).toMatchObject({
      storageQuotaBytes: { value: 2 * MIB, source: 'operator' },
      importMaxBytes: { value: 3 * MIB, source: 'operator' },
      submitMaxBytes: { value: 4 * MIB, source: 'operator' },
      retentionDays: { value: 90, source: 'operator' },
      readOnly: { value: false, source: 'operator' },
    });
  });

  test('a variable that sets nothing usable leaves the default', () => {
    const env = { PIWI_STORAGE_QUOTA_BYTES: '12', PIWI_IMPORT_MAX_BYTES: 'big', PIWI_RETENTION_DAYS: '-3' };
    expect(instanceLimitsOf({}, env, NOW)).toMatchObject({
      storageQuotaBytes: { value: null, source: 'default' },
      importMaxBytes: { value: DEFAULT_MAX_UPLOAD_BYTES, source: 'default' },
      retentionDays: { value: null, source: 'default' },
    });
  });
});

describe('a lowered retention', () => {
  const later = (days: number) => new Date(NOW.getTime() + days * DAY_MS);
  const appliesAt = later(RETENTION_LOWERING_WAIT_DAYS).toISOString();

  test('waits 14 days, the sweep keeping the days it kept until then', () => {
    const stored = applyOperatorLimits({}, { retentionDays: 7 }, { PIWI_RETENTION_DAYS: '30' }, NOW);
    expect(stored).toEqual({
      retentionDays: 7,
      retentionKept: { days: 30, source: 'environment', until: appliesAt },
    });
    const env = { PIWI_RETENTION_DAYS: '30' };
    expect(retentionDaysSetting(stored, env, later(13))).toEqual({
      value: 30,
      source: 'environment',
      pending: { value: 7, source: 'operator', appliesAt },
    });
    expect(retentionDaysSetting(stored, env, later(14))).toEqual({ value: 7, source: 'operator', pending: null });
  });

  test('set where none was set waits too: every run is kept until then', () => {
    const stored = applyOperatorLimits({}, { retentionDays: 90 }, {}, NOW);
    expect(retentionDaysSetting(stored, {}, later(1))).toMatchObject({ value: null, pending: { value: 90 } });
    const fromZero = applyOperatorLimits({}, { retentionDays: 90 }, { PIWI_RETENTION_DAYS: '0' }, NOW);
    expect(retentionDaysSetting(fromZero, {}, later(1))).toMatchObject({ value: 0, pending: { value: 90 } });
  });

  test('cleared back to a variable that keeps fewer days waits too', () => {
    const env = { PIWI_RETENTION_DAYS: '10' };
    const stored = applyOperatorLimits({ retentionDays: 60 }, { retentionDays: null }, env, NOW);
    expect(stored).toEqual({ retentionKept: { days: 60, source: 'operator', until: appliesAt } });
    expect(retentionDaysSetting(stored, env, later(1))).toEqual({
      value: 60,
      source: 'operator',
      pending: { value: 10, source: 'environment', appliesAt },
    });
  });

  test('raised, or kept as long, applies at once and ends a wait', () => {
    const waiting = applyOperatorLimits({}, { retentionDays: 7 }, { PIWI_RETENTION_DAYS: '30' }, NOW);
    const raised = applyOperatorLimits(waiting, { retentionDays: 30 }, { PIWI_RETENTION_DAYS: '30' }, later(1));
    expect(raised).toEqual({ retentionDays: 30 });
    expect(applyOperatorLimits({ retentionDays: 30 }, { retentionDays: 0 }, {}, NOW)).toEqual({ retentionDays: 0 });
    expect(applyOperatorLimits({ retentionDays: 30 }, { retentionDays: 45 }, {}, NOW)).toEqual({ retentionDays: 45 });
  });

  test('lowered again while it waits keeps the days the sweep keeps now, and waits 14 days from then', () => {
    const waiting = applyOperatorLimits({ retentionDays: 90 }, { retentionDays: 30 }, {}, NOW);
    const again = applyOperatorLimits(waiting, { retentionDays: 7 }, {}, later(5));
    expect(again.retentionKept).toEqual({
      days: 90,
      source: 'operator',
      until: later(5 + RETENTION_LOWERING_WAIT_DAYS).toISOString(),
    });
  });

  test('leaves the wait alone when another limit changes, and drops one that ended', () => {
    const waiting = applyOperatorLimits({ retentionDays: 90 }, { retentionDays: 30 }, {}, NOW);
    expect(applyOperatorLimits(waiting, { readOnly: true }, {}, later(1)).retentionKept).toEqual(waiting.retentionKept);
    expect(applyOperatorLimits(waiting, { readOnly: true }, {}, later(15)).retentionKept).toBeUndefined();
  });
});

describe('every reader of a limit', () => {
  test('reads the operator’s value first, then the environment, then the default', () => {
    process.env.PIWI_STORAGE_QUOTA_BYTES = String(10 * MIB);
    process.env.PIWI_IMPORT_MAX_BYTES = String(20 * MIB);
    process.env.PIWI_SUBMIT_MAX_BYTES = String(30 * MIB);
    process.env.PIWI_RETENTION_DAYS = '40';
    expect([storageQuotaBytes(), resolveMaxUploadBytes(), resolveMaxSubmitBytes(), retentionDays(NOW)]).toEqual([
      10 * MIB,
      20 * MIB,
      30 * MIB,
      40,
    ]);
    holdOperatorLimits({
      storageQuotaBytes: 2 * MIB,
      importMaxBytes: 3 * MIB,
      submitMaxBytes: 4 * MIB,
      retentionDays: 50,
    });
    expect([storageQuotaBytes(), resolveMaxUploadBytes(), resolveMaxImportBytes(), resolveMaxSubmitBytes()]).toEqual([
      2 * MIB,
      3 * MIB,
      3 * MIB,
      4 * MIB,
    ]);
    expect(retentionDays(NOW)).toBe(50);
  });

  test('the retention sweep keeps the days it kept while a lowered retention waits', () => {
    process.env.PIWI_RETENTION_DAYS = '40';
    holdOperatorLimits(applyOperatorLimits({}, { retentionDays: 5 }, process.env, NOW));
    expect(retentionDays(new Date(NOW.getTime() + DAY_MS))).toBe(40);
    expect(retentionDays(new Date(NOW.getTime() + 14 * DAY_MS))).toBe(5);
  });

  test('a run’s files the reporter did not send count once the operator sets a quota, without a variable', () => {
    const metadata = { ingestHealth: { tracesNotKept: 2 } };
    expect(reportedNotKept(metadata)).toEqual({});
    holdOperatorLimits({ storageQuotaBytes: MIB });
    expect(reportedNotKept(metadata)).toEqual({ reporterNotKept: { tracesNotKept: 2 } });
  });
});

describe('GET and PUT /api/operator/limits', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    state.db = db;
    resetRateLimit('operator:192.0.2.40');
    vi.stubEnv('PIWI_OPERATOR_TOKEN', TOKEN);
  });
  afterEach(async () => {
    await close();
  });

  const bearer = `Bearer ${TOKEN}`;
  const stored = async () =>
    (await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'operator_limits')))[0]?.value ?? null;

  test('answer the operator token alone: 404 without one set, 401 for another', async () => {
    expect(await status(getLimits, request(null))).toBe(401);
    expect(await status(putLimits, request('Bearer wrong', { readOnly: true }))).toBe(401);
    expect(await status(putLimits, request(`Bearer pd_${'0'.repeat(64)}`, { readOnly: true }))).toBe(401);
    vi.stubEnv('PIWI_OPERATOR_TOKEN', '');
    expect(await status(getLimits, request(bearer))).toBe(404);
    expect(await status(putLimits, request(bearer, { readOnly: true }))).toBe(404);
    expect(await stored()).toBeNull();
  });

  test('refuse an input that is not strict, out of bounds or not an object, storing nothing', async () => {
    for (const body of [
      { readOnly: true, quota: 1 },
      { importMaxBytes: MAX_IMPORT_MAX_BYTES + 1 },
      { retentionDays: -1 },
      { storageQuotaBytes: '10' },
      undefined,
      [],
    ]) {
      expect(await status(putLimits, request(bearer, body)), JSON.stringify(body)).toBe(400);
    }
    expect(await stored()).toBeNull();
  });

  test('set limits, answer each with its source, and clear one back to its variable with null', async () => {
    vi.stubEnv('PIWI_IMPORT_MAX_BYTES', String(50 * MIB));
    const answer = await putLimits(request(bearer, { storageQuotaBytes: 8 * MIB, importMaxBytes: 2 * MIB }));
    expect(answer.limits).toMatchObject({
      storageQuotaBytes: { value: 8 * MIB, source: 'operator' },
      importMaxBytes: { value: 2 * MIB, source: 'operator' },
      submitMaxBytes: { value: DEFAULT_MAX_SUBMIT_BYTES, source: 'default' },
      readOnly: { value: false, source: 'default' },
    });
    expect(await stored()).toEqual({ storageQuotaBytes: 8 * MIB, importMaxBytes: 2 * MIB });
    expect(resolveMaxUploadBytes()).toBe(2 * MIB);

    const cleared = await putLimits(request(bearer, { importMaxBytes: null }));
    expect(cleared.limits.importMaxBytes).toEqual({ value: 50 * MIB, source: 'environment' });
    expect(cleared.limits.storageQuotaBytes).toEqual({ value: 8 * MIB, source: 'operator' });
    expect(await stored()).toEqual({ storageQuotaBytes: 8 * MIB });
    expect((await getLimits(request(bearer))).limits).toEqual(cleared.limits);
  });

  test('say a lowered retention’s wait, and the date it applies', async () => {
    vi.stubEnv('PIWI_RETENTION_DAYS', '30');
    const answer = await putLimits(request(bearer, { retentionDays: 7 }));
    expect(answer.limits.retentionDays).toEqual({
      value: 30,
      source: 'environment',
      pending: { value: 7, source: 'operator', appliesAt: expect.any(String) },
    });
    const waits = Date.parse(answer.limits.retentionDays.pending.appliesAt) - Date.now();
    expect(Math.abs(waits - 14 * DAY_MS)).toBeLessThan(60_000);
    expect(retentionDays()).toBe(30);
  });

  test('read the limits a second process wrote once the held ones are older than the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW);
      await writeOperatorLimits(db as never, { importMaxBytes: 2 * MIB });
      await db.update(schema.appSettings).set({ value: { importMaxBytes: 9 * MIB } });
      await loadOperatorLimits();
      expect(heldOperatorLimits()).toEqual({ importMaxBytes: 2 * MIB });
      vi.setSystemTime(NOW.getTime() + OPERATOR_LIMITS_TTL_MS);
      await loadOperatorLimits();
      expect(heldOperatorLimits()).toEqual({ importMaxBytes: 9 * MIB });
      expect(resolveMaxUploadBytes()).toBe(9 * MIB);
    } finally {
      vi.useRealTimers();
    }
  });
});
