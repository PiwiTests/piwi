import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_DATABASE_POOL_MAX, MAX_DATABASE_POOL_MAX, postgresPoolMax } from '../../server/database/postgres-pool';

/**
 * The PostgreSQL pool's size is a number, from `PIWI_DATABASE_POOL_MAX`, else the URL's `max`, else `PGMAX`, else 10,
 * and the server opens PostgreSQL with it.
 */

const URL_WITHOUT_MAX = 'postgres://piwi:secret@db:5432/piwi';

/** What the server passed postgres.js as it opened the database. */
const opened = vi.hoisted(() => [] as unknown[][]);
vi.mock('postgres', () => ({
  default: (...args: unknown[]) => {
    opened.push(args);
    throw new Error('The test stops at the driver.');
  },
}));

const env = { ...process.env };
afterAll(() => {
  process.env = { ...env };
});
afterEach(() => vi.restoreAllMocks());

describe('postgresPoolMax', () => {
  test('is the driver’s default with nothing set', () => {
    expect(postgresPoolMax(URL_WITHOUT_MAX, {})).toBe(DEFAULT_DATABASE_POOL_MAX);
    expect(DEFAULT_DATABASE_POOL_MAX).toBe(10);
  });

  test('reads a max in the URL as a number, a URL of several hosts with their ports included', () => {
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=3`, {})).toBe(3);
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?sslmode=require&max=20`, {})).toBe(20);
    expect(postgresPoolMax('postgres://u:p@h1:5432,h2:5433/db?max=3&target_session_attrs=read-write', {})).toBe(3);
    expect(postgresPoolMax('postgres:///piwi?host=/run/postgresql&max=4', {})).toBe(4);
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}#max=7`, {})).toBe(DEFAULT_DATABASE_POOL_MAX);
  });

  test('takes PIWI_DATABASE_POOL_MAX over the URL, and the URL over PGMAX', () => {
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=3`, { PIWI_DATABASE_POOL_MAX: '5', PGMAX: '6' })).toBe(5);
    expect(postgresPoolMax(URL_WITHOUT_MAX, { PIWI_DATABASE_POOL_MAX: ' 2 ' })).toBe(2);
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=3`, { PGMAX: '6' })).toBe(3);
    expect(postgresPoolMax(URL_WITHOUT_MAX, { PGMAX: '6' })).toBe(6);
  });

  test('leaves out a value that is not a whole number of at least 1, with a warning that names no credential', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=4`, { PIWI_DATABASE_POOL_MAX: 'many' })).toBe(4);
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=0`, {})).toBe(DEFAULT_DATABASE_POOL_MAX);
    for (const written of ['2.5', '0x10', '1e2', '-3']) {
      expect(postgresPoolMax(URL_WITHOUT_MAX, { PIWI_DATABASE_POOL_MAX: written }), written).toBe(
        DEFAULT_DATABASE_POOL_MAX,
      );
    }
    expect(postgresPoolMax(URL_WITHOUT_MAX, { PIWI_DATABASE_POOL_MAX: '' })).toBe(DEFAULT_DATABASE_POOL_MAX);
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  test('lowers a size above the most it takes, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(postgresPoolMax(URL_WITHOUT_MAX, { PIWI_DATABASE_POOL_MAX: '100000' })).toBe(MAX_DATABASE_POOL_MAX);
    expect(postgresPoolMax(`${URL_WITHOUT_MAX}?max=4294967296`, {})).toBe(MAX_DATABASE_POOL_MAX);
    expect(postgresPoolMax(URL_WITHOUT_MAX, { PIWI_DATABASE_POOL_MAX: String(MAX_DATABASE_POOL_MAX) })).toBe(
      MAX_DATABASE_POOL_MAX,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

test('the server opens PostgreSQL with that pool size', async () => {
  process.env.PIWI_DATABASE_URL = `${URL_WITHOUT_MAX}?max=3`;
  delete process.env.PIWI_DATABASE_POOL_MAX;
  delete process.env.PGMAX;
  vi.resetModules();
  const { initDatabase } = await import('../../server/database');
  await expect(initDatabase()).rejects.toThrow('The test stops at the driver.');
  expect(opened).toEqual([[`${URL_WITHOUT_MAX}?max=3`, { max: 3 }]]);
});
