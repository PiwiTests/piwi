import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { emptyBugEvidence } from '@piwitests/core/bug-report';
import * as schema from '../../server/database/schema.sqlite';
import type { CreateIssueResponse, IssueDraft } from '../../shared/integrations/types';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Create issue on a bug report in the demo: the draft is about the report, as the server's, and the filed issue is
 * linked to the report, never read as an execution's id.
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
  await db.insert(schema.bugReports).values({
    id: 1,
    projectId: 1,
    title: 'Coupon field clears the cart',
    steps: { v: 1, steps: [] },
    evidence: emptyBugEvidence(),
    context: {},
  });
});

afterAll(() => close());

const draft = (query: string) =>
  handleDemoRequest('/api/integrations/issue-draft', 'GET', undefined, query) as Promise<IssueDraft>;
const create = (body: Record<string, unknown>) =>
  handleDemoRequest('/api/integrations/issues', 'POST', {
    connectionId: 1,
    title: 'Coupon field clears the cart',
    fields: { customfield_10050: { value: { id: '10101' }, label: 'Major' } },
    ...body,
  }) as Promise<CreateIssueResponse>;

describe('the demo issue draft and create for a bug report', () => {
  test('drafts about the bug report, with no cluster', async () => {
    const d = await draft('entityType=bug_report&entityId=1');
    expect(d).toMatchObject({ entityType: 'bug_report', entityId: 1, clusterId: null, projectId: 1 });
    expect(d.title).toContain('Coupon field clears the cart');
    expect(d.existing).toEqual([]);
  });

  test('answers 404 for a bug report that does not exist, and 400 for an unknown entity type', async () => {
    await expect(draft('entityType=bug_report&entityId=99')).rejects.toMatchObject({ statusCode: 404 });
    await expect(draft('entityType=test_run&entityId=1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ entityType: 'bug_report', entityId: 99 })).rejects.toMatchObject({ statusCode: 404 });
    // Before the required fields and the connection, as the server checks them.
    await expect(
      handleDemoRequest('/api/integrations/issues', 'POST', {
        entityType: 'bug_report',
        entityId: 99,
        connectionId: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      handleDemoRequest('/api/integrations/issues', 'POST', { entityType: 'test_run', entityId: 1 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('links the filed issue to the bug report, and answers it again for a second create', async () => {
    const first = await create({ entityType: 'bug_report', entityId: 1 });
    expect(first).toMatchObject({ status: 'done' });
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.key, first.key!));
    expect(link).toMatchObject({ bugReportId: 1, failureClusterId: null, origin: 'created' });

    expect(await create({ entityType: 'bug_report', entityId: 1 })).toMatchObject({
      key: first.key,
      alreadyFiled: true,
    });
    expect((await draft('entityType=bug_report&entityId=1')).existing.map((e) => e.key)).toEqual([first.key]);
  });
});
