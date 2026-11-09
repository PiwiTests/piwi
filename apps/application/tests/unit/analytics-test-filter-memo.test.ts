import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';
import { withStoredVerdicts } from './stored-verdicts';

delete process.env.PIWI_DATABASE_URL;
const { getAnalyticsContext } = await import('../../shared/handlers/analytics/common');
const { clearTestFilterMemo, dropProjectTestFilters, memoizedTestFilter } =
  await import('../../shared/handlers/analytics/test-filter-memo');
const { createSelection, updateSelection } = await import('../../shared/handlers/selections');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { addQuarantine, releaseQuarantine } = await import('../../shared/handlers/quarantine');

/**
 * The analytics test filter is resolved once for the widget requests of one
 * page, each of which parses its own scope, and resolved again once a run of a
 * project it reads finishes or one of its selections changes.
 */

let db: ReturnType<typeof drizzle<typeof schema>>;
let runSeq = 0;

async function seedExecution(projectId: number, testCaseId: number, status: string): Promise<void> {
  const id = ++runSeq;
  await db.insert(schema.testRuns).values({ id, projectId, status, startTime: new Date(Date.now() - 1000 + id) });
  await db
    .insert(schema.testRunsCases)
    .values(withStoredVerdicts({ testRunId: id, testCaseId, status, createdAt: new Date(Date.now() - 1000 + id) }));
}

/** The matching test ids of a scope, per project, as a fresh request resolves them. */
async function resolved(query: Record<string, string>, access: 'all' | Set<number> = 'all') {
  const ctx = await getAnalyticsContext(db, parseAnalyticsScope(query), access);
  return ctx.testFilter;
}

const ids = (filter: Awaited<ReturnType<typeof resolved>>) =>
  Object.fromEntries([...(filter?.testCaseIds ?? new Map())].map(([p, set]) => [p, [...set].sort()]));

beforeEach(async () => {
  clearTestFilterMemo();
  runSeq = 0;
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'one' },
    { id: 2, name: 'two' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 11, projectId: 1, filePath: 'a.spec.ts', title: 'breaks' },
    { id: 12, projectId: 1, filePath: 'a.spec.ts', title: 'holds' },
    { id: 21, projectId: 2, filePath: 'b.spec.ts', title: 'breaks too' },
  ]);
  await seedExecution(1, 11, 'failed');
  await seedExecution(1, 12, 'passed');
  await seedExecution(2, 21, 'failed');
});

describe('the analytics test filter memo', () => {
  test('two requests for one filter resolve it once', async () => {
    const first = await resolved({ sel: 'failed' });
    const second = await resolved({ sel: 'failed' });
    expect(second).toBe(first);
    expect(ids(first)).toEqual({ 1: [11], 2: [21] });
  });

  test('a finished run of a project it reads resolves it again', async () => {
    const first = await resolved({ sel: 'failed' });
    await seedExecution(1, 12, 'failed');
    expect(ids(await resolved({ sel: 'failed' }))).toEqual({ 1: [11], 2: [21] });

    dropProjectTestFilters(1);
    const again = await resolved({ sel: 'failed' });
    expect(again).not.toBe(first);
    expect(ids(again)).toEqual({ 1: [11, 12], 2: [21] });
  });

  test('a run of a project it does not read keeps it', async () => {
    const first = await resolved({ sel: 'failed', projects: '1' });
    dropProjectTestFilters(2);
    expect(await resolved({ sel: 'failed', projects: '1' })).toBe(first);
    dropProjectTestFilters(1);
    expect(await resolved({ sel: 'failed', projects: '1' })).not.toBe(first);
  });

  test('a change to a selection of a project it reads resolves it again', async () => {
    await createSelection(db, 1, { key: 'mine', name: 'Mine', definition: { include: [{ text: 'breaks' }] } });
    expect(ids(await resolved({ sel: 'mine', projects: '1' }))).toEqual({ 1: [11] });
    await updateSelection(db, 1, 'mine', { definition: { include: [{ text: 'holds' }] } });
    expect(ids(await resolved({ sel: 'mine', projects: '1' }))).toEqual({ 1: [12] });
  });

  test('a quarantine added or released in a project it reads resolves it again', async () => {
    expect(ids(await resolved({ sel: 'quarantine-free', projects: '1' }))).toEqual({ 1: [11, 12] });
    await addQuarantine(db, 1, 11);
    expect(ids(await resolved({ sel: 'quarantine-free', projects: '1' }))).toEqual({ 1: [12] });
    await releaseQuarantine(db, 1, 11);
    expect(ids(await resolved({ sel: 'quarantine-free', projects: '1' }))).toEqual({ 1: [11, 12] });
  });

  test('the selection, the predicates, the browsers and the allowed projects each make their own key', async () => {
    const base = await resolved({ sel: 'failed' });
    const others = [
      await resolved({ sel: 'flaky' }),
      await resolved({ sel: 'failed', q: 'breaks' }),
      await resolved({ sel: 'failed', browsers: 'chromium' }),
      await resolved({ sel: 'failed', projects: '1' }),
      await resolved({ sel: 'failed' }, new Set([2])),
    ];
    for (const other of others) expect(other).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });

  test("a viewer reads only their projects' tests, whatever another viewer resolved", async () => {
    expect(ids(await resolved({ sel: 'failed' }))).toEqual({ 1: [11], 2: [21] });
    expect(ids(await resolved({ sel: 'failed' }, new Set([2])))).toEqual({ 2: [21] });
    expect(ids(await resolved({ sel: 'failed' }, new Set([1])))).toEqual({ 1: [11] });
  });

  test('the notes of a resolution come with every answer from the memo', async () => {
    const query = { sel: 'mine' };
    await createSelection(db, 1, { key: 'mine', name: 'Mine', definition: { include: [{ text: 'breaks' }] } });
    for (let i = 0; i < 2; i++) {
      const ctx = await getAnalyticsContext(db, parseAnalyticsScope(query), 'all');
      expect(ctx.notes).toEqual(['two has no selection "mine" and is left out.']);
    }
  });

  test('requests arriving while it resolves share the resolution, and a failure is forgotten', async () => {
    const scope = parseAnalyticsScope({ sel: 'failed' });
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('down'));
    };
    const a = memoizedTestFilter(db, scope, 'all', failing);
    const b = memoizedTestFilter(db, scope, 'all', failing);
    await expect(a).rejects.toThrow('down');
    await expect(b).rejects.toThrow('down');
    expect(calls).toBe(1);
    const ok = await memoizedTestFilter(db, scope, 'all', async () => ({ filter: null, notes: [] }));
    expect(ok).toEqual({ filter: null, notes: [] });
  });

  test('another database never reads the filter of the first', async () => {
    const first = await resolved({ sel: 'failed' });
    const other = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(other);
    const ctx = await getAnalyticsContext(other, parseAnalyticsScope({ sel: 'failed' }), 'all');
    expect(ctx.testFilter).not.toBe(first);
    expect(ids(ctx.testFilter)).toEqual({});
  });
});
