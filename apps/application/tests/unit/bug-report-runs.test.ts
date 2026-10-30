import { beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { ADMIN_ACCESS } from '#shared/permissions';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { applyBugReportLifecycle, bugSpecOutcomes, isReproductionRunAllowed, listBugReports, renderBugReportSpec } =
  await import('#shared/handlers/bug-reports');
const { loadLooksFixedTests, loadNewlyLooksFixedTests } =
  await import('../../server/utils/notifications/run-notifications');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

let db: ReturnType<typeof drizzle<typeof schema>>;

const EMPTY = { steps: { v: 1, steps: [] }, evidence: {}, context: {} };
const fixedIn = (browserName: string) => ({ status: 'failed', expectedStatus: 'failed', browserName });
const stillFailsIn = (browserName: string) => ({ status: 'passed', expectedStatus: 'failed', browserName });

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/bugs/coupon.spec.ts', title: 'coupon' },
    { id: 2, projectId: 1, filePath: 'tests/bugs/total.spec.ts', title: 'total' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'passed', branch: 'main', startTime: new Date(1000_000), totalTests: 2 },
    { id: 2, projectId: 1, status: 'passed', branch: 'main', startTime: new Date(2000_000), totalTests: 2 },
    { id: 3, projectId: 2, status: 'passed', branch: 'main', startTime: new Date(3000_000), totalTests: 0 },
  ]);
  await db.insert(schema.bugReports).values([
    { id: 1, projectId: 1, title: 'Coupon', status: 'test-committed', ...EMPTY },
    { id: 2, projectId: 1, title: 'Total', status: 'test-committed', ...EMPTY },
  ]);
});

describe('a test that runs in several browser projects', () => {
  test('looks fixed only when every project that ran it agrees', async () => {
    // Test 1 passed on chromium and still fails as expected on webkit; test 2 passed on both.
    await db.insert(schema.testRunsCases).values([
      { testRunId: 2, testCaseId: 1, testMeta: { bug: '1' }, ...stillFailsIn('webkit') },
      { testRunId: 2, testCaseId: 1, testMeta: { bug: '1' }, ...fixedIn('chromium') },
      { testRunId: 2, testCaseId: 2, testMeta: { bug: '2' }, ...stillFailsIn('webkit') },
      { testRunId: 2, testCaseId: 2, testMeta: { bug: '2' }, ...fixedIn('chromium') },
      { testRunId: 2, testCaseId: 2, testMeta: { bug: '2' }, retries: 1, ...fixedIn('webkit') },
    ]);

    expect((await loadLooksFixedTests(db as never, 2)).map((t) => t.testCaseId)).toEqual([2]);

    const transitions = await applyBugReportLifecycle(db as never, 2);
    expect(transitions.map((t) => [t.id, t.to])).toEqual([[2, 'looks-fixed']]);
    const statuses = await db
      .select({ id: schema.bugReports.id, status: schema.bugReports.status })
      .from(schema.bugReports)
      .orderBy(schema.bugReports.id);
    expect(statuses).toEqual([
      { id: 1, status: 'test-committed' },
      { id: 2, status: 'looks-fixed' },
    ]);
  });
});

describe('which runs move a report', () => {
  const closingRun = async (id: number, values: Partial<typeof schema.testRuns.$inferInsert>) => {
    await db
      .insert(schema.testRuns)
      .values({ id, projectId: 1, status: 'passed', startTime: new Date(id * 1000_000), ...values });
    await db.insert(schema.testRunsCases).values({
      testRunId: id,
      testCaseId: 1,
      testMeta: { bug: '1' },
      status: 'passed',
      browserName: 'chromium',
    });
    return applyBugReportLifecycle(db as never, id);
  };

  test('a feature-branch run moves nothing', async () => {
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    expect(await closingRun(10, { branch: 'feature/coupon' })).toEqual([]);
    const [report] = await db.select().from(schema.bugReports).where(eq(schema.bugReports.id, 1));
    expect(report!.status).toBe('test-committed');
  });

  test('a piwi bug --write run on the default branch moves nothing, a selection run does', async () => {
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    expect(
      await closingRun(10, { branch: 'main', isFullRun: 0, metadata: { piwiOrigin: { kind: 'bug', ref: '1' } } }),
    ).toEqual([]);
    const selection = await closingRun(11, { branch: 'main', isFullRun: 0, metadata: { piwiOrigin: { kind: 'ci' } } });
    expect(selection.map((t) => [t.id, t.to])).toEqual([[1, 'closed']]);
  });

  test('a run with no branch moves the report only when the project records no branch', async () => {
    await db.delete(schema.testRunsCases);
    await db.delete(schema.testRuns);
    expect((await closingRun(10, {})).map((t) => t.to)).toEqual(['closed']);

    await db.update(schema.bugReports).set({ status: 'test-committed' }).where(eq(schema.bugReports.id, 1));
    await db.update(schema.projects).set({ defaultBranch: 'main' }).where(eq(schema.projects.id, 1));
    expect(await closingRun(11, {})).toEqual([]);
  });

  test('a full run of the default branch moves the report', async () => {
    const moved = await closingRun(10, { branch: 'main' });
    expect(moved.map((t) => [t.id, t.from, t.to])).toEqual([[1, 'test-committed', 'closed']]);
  });
});

describe('runs that move no report', () => {
  test.each(['bug', 'bisect', 'reproduce', 'flake-lab'])('a %s run leaves the reports where they are', async (kind) => {
    await db
      .update(schema.testRuns)
      .set({ metadata: { piwiOrigin: { kind } } })
      .where(eq(schema.testRuns.id, 2));
    await db
      .insert(schema.testRunsCases)
      .values([{ testRunId: 2, testCaseId: 2, testMeta: { bug: '2' }, ...fixedIn('chromium') }]);

    expect(await applyBugReportLifecycle(db as never, 2)).toEqual([]);
    const [report] = await db.select().from(schema.bugReports).where(eq(schema.bugReports.id, 2));
    expect(report!.status).toBe('test-committed');
    expect(await db.select().from(schema.handbackOutcomes)).toEqual([]);
  });
});

describe('bug-spec outcomes', () => {
  const outcomes = async () =>
    (await db.select().from(schema.handbackOutcomes).orderBy(schema.handbackOutcomes.id)).map((o) => [
      o.kind,
      o.subjectId,
      o.outcome,
      o.runId,
    ]);

  test('the committed test applies the spec, closing verifies it, a failure after closing regresses it', async () => {
    await db.update(schema.bugReports).set({ status: 'open' }).where(eq(schema.bugReports.id, 1));
    await db.insert(schema.testRuns).values({
      id: 4,
      projectId: 1,
      status: 'failed',
      branch: 'main',
      startTime: new Date(4000_000),
      totalTests: 2,
    });
    const bug = { testCaseId: 1, testMeta: { bug: '1' }, browserName: 'chromium' };
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, status: 'failed', expectedStatus: 'passed', ...bug },
      { testRunId: 2, status: 'passed', expectedStatus: 'passed', ...bug },
      { testRunId: 4, status: 'failed', expectedStatus: 'passed', ...bug },
    ]);

    await applyBugReportLifecycle(db as never, 1);
    await applyBugReportLifecycle(db as never, 2);
    await applyBugReportLifecycle(db as never, 2);
    await applyBugReportLifecycle(db as never, 4);

    expect(await outcomes()).toEqual([
      ['bug-spec', 1, 'applied', 1],
      ['bug-spec', 1, 'verified', 2],
      ['bug-spec', 1, 'regressed', 4],
    ]);
  });

  test('which moves record which outcome', () => {
    expect(bugSpecOutcomes('open', 'test-committed')).toEqual(['applied']);
    expect(bugSpecOutcomes('open', 'closed')).toEqual(['applied', 'verified']);
    expect(bugSpecOutcomes('test-committed', 'looks-fixed')).toEqual([]);
    expect(bugSpecOutcomes('looks-fixed', 'closed')).toEqual(['verified']);
    expect(bugSpecOutcomes('closed', 'test-committed')).toEqual(['regressed']);
    expect(bugSpecOutcomes('looks-fixed', 'test-committed')).toEqual([]);
    expect(bugSpecOutcomes('closed', 'closed')).toEqual([]);
  });
});

describe('the bug.looks_fixed notification', () => {
  test('names only tests that did not already look fixed on the previous run of the branch', async () => {
    await db.insert(schema.testRunsCases).values([
      { testRunId: 1, testCaseId: 1, ...fixedIn('chromium') },
      { testRunId: 1, testCaseId: 2, ...stillFailsIn('chromium') },
      { testRunId: 2, testCaseId: 1, ...fixedIn('chromium') },
      { testRunId: 2, testCaseId: 2, ...fixedIn('chromium') },
    ]);

    const tests = await loadNewlyLooksFixedTests(db as never, { id: 2, projectId: 1 }, 'main');
    expect(tests.map((t) => t.testCaseId)).toEqual([2]);
    // Another branch has no earlier run: everything that looks fixed is new there.
    const elsewhere = await loadNewlyLooksFixedTests(db as never, { id: 2, projectId: 1 }, 'feature/x');
    expect(elsewhere.map((t) => t.testCaseId)).toEqual([1, 2]);
  });
});

describe('a reproduction naming a run', () => {
  test('is allowed without a run, or with a run of the report’s own project', async () => {
    expect(await isReproductionRunAllowed(db as never, 1, null)).toBe(true);
    expect(await isReproductionRunAllowed(db as never, 1, 2)).toBe(true);
  });

  test('is refused for a run of another project or one that does not exist', async () => {
    expect(await isReproductionRunAllowed(db as never, 1, 3)).toBe(false);
    expect(await isReproductionRunAllowed(db as never, 1, 999)).toBe(false);
  });
});

describe('list_bug_reports', () => {
  test('pages past the newest 500 reports', async () => {
    await db.delete(schema.bugReports);
    await db
      .insert(schema.bugReports)
      .values(Array.from({ length: 520 }, (_, i) => ({ id: i + 1, projectId: 1, title: `Bug ${i + 1}`, ...EMPTY })));
    expect((await listBugReports(db as never, 1, { beforeId: 11 })).map((r) => r.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 10 - i),
    );

    const tool = MCP_TOOLS.find((t) => t.name === 'list_bug_reports')!;
    const ctx = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };
    const page = (await tool.handler(db as never, { projectId: 1, pageSize: 50, cursor: '12' }, ctx)) as {
      items: Array<{ id: number }>;
      nextCursor?: string | null;
    };
    expect(page.items.map((r) => r.id)).toEqual(Array.from({ length: 11 }, (_, i) => 11 - i));
    expect(page.nextCursor ?? null).toBeNull();
  });
});

describe('a bug report spec written outside the bugs folder', () => {
  test('imports the test module by a path from its own folder', async () => {
    await db
      .update(schema.projects)
      .set({ generatedSpecs: { testImport: '../fixtures', bugsFolder: 'apps/web/tests/bugs' } })
      .where(eq(schema.projects.id, 1));
    const inBugsFolder = await renderBugReportSpec(db as never, 1, 'commit');
    expect(inBugsFolder?.path).toBe('apps/web/tests/bugs/coupon.spec.ts');
    expect(inBugsFolder?.code).toContain("from '../fixtures'");
    const elsewhere = await renderBugReportSpec(db as never, 1, 'commit', 'apps/web/e2e/repro');
    expect(elsewhere?.code).toContain("from '../../tests/fixtures'");
  });
});
