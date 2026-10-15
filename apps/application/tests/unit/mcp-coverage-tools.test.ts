import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import type { User } from '../../server/database/schema';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async readFile() {
      throw new Error('no file');
    },
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler;
};

const BLOB = 'a'.repeat(40);
const BASKET = 'src/Services/BasketService.cs';
const T0 = Date.UTC(2026, 8, 1);

const admin: McpContext = { user: null, access: ADMIN_ACCESS, scope: 'all' };
const reader: McpContext = {
  user: { id: 3, role: InstanceRole.MEMBER, name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 2, role: ProjectRole.VIEWER }]),
  scope: new Set([2]),
};

let db: TempDb;
let close: () => Promise<void>;

async function idOf(title: string): Promise<number> {
  const [row] = await db
    .select({ id: schema.testCases.id })
    .from(schema.testCases)
    .where(eq(schema.testCases.title, title));
  return row!.id;
}

function execution(title: string, status: 'passed' | 'failed', lines: Array<[number, number]>, startedAt: number) {
  return {
    title,
    filePath: 'tests/basket.spec.ts',
    status,
    duration: 1_000,
    line: 1,
    column: 1,
    startedAt,
    workerIndex: 0,
    browser: { projectName: 'chromium', browserName: 'chromium' },
    coverage: { v: 1, files: [{ path: BASKET, runtime: 'server', blob: BLOB, lines, functions: [[40, 80]] }] },
  };
}

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', defaultBranch: 'main' },
    { id: 2, name: 'docs', defaultBranch: 'main' },
  ]);
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  for (const [run, status] of [
    [1, 'passed'],
    [2, 'failed'],
  ] as const) {
    await db.insert(schema.testRuns).values({
      id: run,
      projectId: 1,
      status,
      startTime: new Date(T0 + run * 3_600_000),
      branch: 'main',
      totalTests: 2,
    });
    await persistRunCases(db as never, 1, run, [
      execution('adds an item', status, status === 'failed' ? [[40, 70]] : [[40, 50]], T0 + run * 3_600_000),
      execution('applies a coupon', 'passed', [[40, 45]], T0 + run * 3_600_000 + 2_000),
    ]);
  }
  await db.insert(schema.testCases).values({ id: 90, projectId: 2, filePath: 'docs.spec.ts', title: 'renders' });
});

afterAll(async () => {
  await close();
});

describe('get_coverage', () => {
  test('a file’s ranges grouped by the tests that ran them, with the test to copy', async () => {
    const answer = (await tool('get_coverage')(
      db as never,
      { projectId: 1, file: 'BasketService.cs', lines: '60-62' },
      admin,
    )) as {
      tests: Array<{ title: string }>;
      versions: Array<{ lines: Array<{ lines: string; tests: number[] }> }>;
      nearest: { title: string; function: number[] };
    };
    expect(answer.tests.map((t) => t.title)).toEqual(['adds an item', 'applies a coupon']);
    expect(answer.versions[0]!.lines).toEqual([
      { lines: '40-45', tests: [0, 1] },
      { lines: '46-70', tests: [0] },
    ]);
    expect(answer.nearest).toMatchObject({ title: 'adds an item', function: [40, 80], ranTarget: '60-62' });
  });

  test('a test named by its file and title: which target lines its latest execution ran', async () => {
    expect(
      await tool('get_coverage')(
        db as never,
        { projectId: 1, testFile: 'basket.spec.ts', testTitle: 'applies a coupon', file: BASKET, lines: '44-46' },
        admin,
      ),
    ).toMatchObject({
      available: true,
      testCaseId: await idOf('applies a coupon'),
      reachedFile: true,
      granularity: 'lines',
      complete: true,
      ran: '44-45',
      notRan: '46',
      nearest: { title: 'adds an item' },
    });
  });

  test('an execution’s files, a project without coverage in one sentence, and the scope', async () => {
    const [execution] = await db
      .select({ id: schema.testRunsCases.id })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testCaseId, await idOf('adds an item')))
      .limit(1);
    expect(await tool('get_coverage')(db as never, { executionId: execution!.id }, admin)).toMatchObject({
      fileCount: 1,
      files: [{ path: BASKET, runtime: 'server', lines: 11, functions: 1 }],
    });
    expect(await tool('get_coverage')(db as never, { testCaseId: 90 }, admin)).toBe(
      "Project 2 has recorded no coverage: set the reporter's `coverage` option (`coverage: { server: 'lines' }` with an instrumented ASP.NET Core backend, `coverage: { browser: 'files' }` for browser files) and run the tests again.",
    );
    await expect(tool('get_coverage')(db as never, { projectId: 1, file: BASKET }, reader)).rejects.toThrow(
      'No access to project 1',
    );
    await expect(tool('get_coverage')(db as never, { projectId: 1 }, admin)).rejects.toThrow('Pass projectId and file');
  });
});

describe('compare_coverage and get_coverage_loss', () => {
  test('a failure against its last passing execution', async () => {
    const [failed] = await db
      .select({ id: schema.testRunsCases.id })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.status, 'failed'));
    expect(await tool('compare_coverage')(db as never, { executionId: failed!.id }, admin)).toMatchObject({
      available: true,
      baseline: { runId: 1, sameProject: true, sameBranch: true },
      files: [{ path: BASKET, status: 'diverged', linesOnlyHere: '51-70' }],
    });
    expect(
      await tool('compare_coverage')(db as never, { testCaseId: await idOf('adds an item') }, admin),
    ).toMatchObject({
      available: true,
      executions: { compared: 2, failed: 1 },
      varying: [{ ranIn: 1, failedIn: 1 }],
    });
    await expect(tool('compare_coverage')(db as never, {}, admin)).rejects.toThrow('Pass executionId or testCaseId');
  });

  test('what quarantining a test leaves uncovered, in the loss tool and the quarantine answer', async () => {
    const adds = await idOf('adds an item');
    expect(await tool('get_coverage_loss')(db as never, { projectId: 1, testCaseIds: [adds] }, admin)).toMatchObject({
      available: true,
      summary: { files: 1, filesPartial: 1, lines: 25 },
      files: [{ path: BASKET, status: 'partial', lines: '46-70' }],
    });
    expect(
      await tool('set_test_quarantine')(db as never, { testCaseId: adds, quarantined: true }, admin),
    ).toMatchObject({
      quarantined: true,
      uniqueCoverage: { projectId: 1, files: 1, lines: 25, worst: [{ path: BASKET, lines: '46-70' }] },
    });
  });
});
