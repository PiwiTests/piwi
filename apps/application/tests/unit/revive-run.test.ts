import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the helper.
delete process.env.PIWI_DATABASE_URL;
const { validateAndReviveRun } = await import('../../server/utils/revive-run');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'Alpha' });
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'interrupted', streamToken: 'run-token', startTime: new Date() },
    { id: 2, projectId: 1, status: 'running', streamToken: 'run-token', startTime: new Date() },
    { id: 3, projectId: 1, status: 'passed', streamToken: null, startTime: new Date() },
    { id: 4, projectId: 1, status: 'interrupted', streamToken: null, startTime: new Date() },
  ]);
});

async function statusOf(id: number) {
  const [row] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, id));
  return row;
}

async function run(id: number) {
  const row = await statusOf(id);
  return { status: row!.status, streamToken: row!.streamToken };
}

describe('validateAndReviveRun', () => {
  test('refuses to revive an interrupted run with a token that is not its own', async () => {
    await expect(validateAndReviveRun(db as never, 1, await run(1), 'attacker-token')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await statusOf(1))?.status).toBe('interrupted');
    expect((await statusOf(1))?.streamToken).toBe('run-token');
  });

  test('refuses an interrupted run whose token was cleared', async () => {
    await expect(validateAndReviveRun(db as never, 4, await run(4), 'any-token')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await statusOf(4))?.status).toBe('interrupted');
  });

  test('revives an interrupted run with its own token and keeps that token', async () => {
    const testRun = await run(1);
    await validateAndReviveRun(db as never, 1, testRun, 'run-token');
    expect(testRun.status).toBe('running');
    expect(await statusOf(1)).toMatchObject({ status: 'running', streamToken: 'run-token' });
  });

  test('revives an interrupted run with one of its shard tokens without replacing the run token', async () => {
    await validateAndReviveRun(db as never, 1, await run(1), 'shard-2', (t) => t === 'shard-2');
    expect(await statusOf(1)).toMatchObject({ status: 'running', streamToken: 'run-token' });
  });

  test('checks the token of a running run', async () => {
    await expect(validateAndReviveRun(db as never, 2, await run(2), 'wrong')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(validateAndReviveRun(db as never, 2, await run(2), 'run-token')).resolves.toBeUndefined();
  });

  test('rejects a missing token and a finished run', async () => {
    await expect(validateAndReviveRun(db as never, 2, await run(2), undefined)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(validateAndReviveRun(db as never, 3, await run(3), 'run-token')).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
