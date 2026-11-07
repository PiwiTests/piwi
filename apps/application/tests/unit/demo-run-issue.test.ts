import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { CreateIssueResponse, IssueDraft } from '../../shared/integrations/types';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Create issue on a run, and on an execution with no failure cluster, in the demo: the draft is about the run or the
 * test, the comment opens the body, each submission files once, and a new one files another issue.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  // The demo's sql.js database enforces no foreign key, and seeds no row for its canned Jira connection.
  await db.run(sql`PRAGMA foreign_keys = OFF`);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 6, projectId: 1, status: 'passed', startTime: new Date() });
  await db.insert(schema.testRuns).values({
    id: 5,
    projectId: 1,
    status: 'passed',
    startTime: new Date('2026-11-06T09:00:00Z'),
    branch: 'main',
    totalTests: 1,
    passedTests: 1,
  });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, title: 'keeps the basket', filePath: 'cart.spec.ts' });
  await db.insert(schema.testRunsCases).values({ id: 50, testRunId: 5, testCaseId: 1, status: 'passed', line: 3 });
});

afterAll(() => close());

const draft = (query: string) =>
  handleDemoRequest('/api/integrations/issue-draft', 'GET', undefined, query) as Promise<IssueDraft>;
const create = (body: Record<string, unknown>) =>
  handleDemoRequest('/api/integrations/issues', 'POST', {
    connectionId: 1,
    title: 'Run #5',
    fields: { customfield_10050: { value: { id: '10101' }, label: 'Major' } },
    ...body,
  }) as Promise<CreateIssueResponse>;

describe('the demo issue draft and create for a run', () => {
  test('drafts about the run, with no cluster', async () => {
    const d = await draft('entityType=test_run&entityId=5');
    expect(d).toMatchObject({ entityType: 'test_run', entityId: 5, clusterId: null, projectId: 1 });
    expect(d.title).toBe('Run #5 on main');
    expect(d.markdown).toContain('keeps the basket');
  });

  test('each submission files once, and a new one files another issue', async () => {
    const submissionId = '00000000-0000-4000-8000-00000000000a';
    const first = await create({ entityType: 'test_run', entityId: 5, submissionId, comment: 'Slow on reload.' });
    expect(first).toMatchObject({ status: 'done' });
    expect(await create({ entityType: 'test_run', entityId: 5, submissionId })).toEqual({
      ...first,
      submissionFiled: true,
    });
    const other = await create({
      entityType: 'test_run',
      entityId: 5,
      submissionId: '00000000-0000-4000-8000-00000000000b',
    });
    expect(other.key).not.toBe(first.key);
    const links = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.testRunId, 5));
    expect(links.map((l) => l.key).sort()).toEqual([first.key, other.key].sort());
    expect((await draft('entityType=test_run&entityId=5')).existing).toHaveLength(2);
  });

  test('a submission id sent for another run files there, and a malformed body is refused', async () => {
    const submissionId = '00000000-0000-4000-8000-00000000000c';
    const onFive = await create({ entityType: 'test_run', entityId: 5, submissionId });
    const onSix = await create({ entityType: 'test_run', entityId: 6, submissionId });
    expect(onSix.key).not.toBe(onFive.key);
    await expect(create({ entityType: 'test_run', entityId: 5, comment: 5 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(create({ entityType: 'test_run', entityId: 5, submissionId: 'twice' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test('an execution with no cluster files for itself', async () => {
    const d = await draft('entityType=test_runs_case&entityId=50');
    expect(d).toMatchObject({ entityType: 'test_runs_case', clusterId: null, title: 'keeps the basket' });
    const filed = await create({ entityType: 'test_runs_case', entityId: 50, title: d.title });
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.key, filed.key!));
    expect(link).toMatchObject({ testRunsCaseId: 50, failureClusterId: null, origin: 'created' });
  });
});
