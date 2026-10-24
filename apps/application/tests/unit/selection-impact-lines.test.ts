import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { storeRunCoverage } = await import('../../server/utils/coverage');
const { resolveImpact } = await import('../../server/utils/selection-impact');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { InstanceRole, ProjectRole, buildAccessSummary } = await import('#shared/permissions');

type Db = ReturnType<typeof drizzle<typeof schema>>;
const T0 = Date.UTC(2026, 8, 1);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const BASKET = 'src/Web/Services/BasketService.cs';
const CART = 'src/lib/cart.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-impact-lines-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

function basket(lines: Array<[number, number]>, blob = BASE) {
  return { path: BASKET, runtime: 'server', blob, functions: [[50, 80]], lines };
}

function execution(title: string, files: unknown[], extra: Record<string, unknown> = {}) {
  return {
    title,
    filePath: 'tests/shop.spec.ts',
    status: 'passed',
    line: 1,
    column: 1,
    coverage: { v: 1, files },
    ...extra,
  };
}

let db: Db;
const ids = new Map<string, number>();

beforeAll(async () => {
  db = drizzle(createClient({ url: `file:${join(tmpDir, 'impact.db')}` }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  await db.insert(schema.testRuns).values({
    id: 10,
    projectId: 1,
    status: 'passed',
    startTime: new Date(T0),
    branch: 'main',
    totalTests: 5,
    passedTests: 5,
  });
  await persistRunCases(db as never, 1, 10, [
    // Adds an item: runs the guard and the add path of the method.
    execution('adds', [basket([[51, 56]])]),
    // Empties the basket: runs the guard and the clear path.
    execution('empties', [
      basket([
        [51, 52],
        [70, 75],
      ]),
    ]),
    // Recorded at another version of the file.
    execution('lists', [basket([[51, 56]], OTHER)]),
    // A capture that lost part of its coverage.
    {
      ...execution('restarts', [basket([[51, 52]])]),
      coverage: { v: 1, files: [basket([[51, 52]])], incomplete: true },
    },
    // Only the browser cart.
    execution('browses', [{ path: CART, runtime: 'browser', blob: BASE, functions: [[3, 9]] }]),
  ]);
  // The run's coverage names the version's executable lines.
  await storeRunCoverage(db as never, 10, 1, [
    {
      path: BASKET,
      runtime: 'server',
      blob: BASE,
      executable: [
        [51, 56],
        [60, 62],
        [70, 75],
      ],
    },
  ]);
  for (const row of await db
    .select({ id: schema.testCases.id, title: schema.testCases.title })
    .from(schema.testCases)) {
    ids.set(row.title, row.id);
  }
});

/** The titles of the tests an impact resolution selects, sorted. */
function titles(testCaseIds: number[]): string[] {
  const byId = new Map([...ids].map(([title, id]) => [id, title]));
  return testCaseIds.map((id) => byId.get(id)!).sort();
}

describe('resolveImpact at line level', () => {
  test('without changed lines, every test reaching the file is selected', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET]);
    expect(titles(impact.tests.map((t) => t.testCaseId))).toEqual(['adds', 'empties', 'lists', 'restarts']);
    expect(impact.impact.lineLevelFiles).toBe(0);
    expect(impact.impact.files[0]!.level).toBe('file');
  });

  test('a changed line selects the tests that ran it, and keeps those the coverage cannot rule out', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET], {
      changes: [{ filePath: BASKET, blob: BASE.slice(0, 7), lines: [[54, 54]] }],
    });
    expect(impact.impact.widened).toBe(false);
    // `empties` never ran line 54; `lists` ran another version, `restarts` an incomplete capture.
    expect(titles(impact.tests.map((t) => t.testCaseId))).toEqual(['adds', 'lists', 'restarts']);
    const [file] = impact.impact.files;
    expect(file).toMatchObject({ filePath: BASKET, level: 'lines', testCount: 3, ruledOut: 1, notRun: [] });
    expect(file!.tests).toEqual([
      { testCaseId: ids.get('adds'), via: 'lines', lines: [[54, 54]] },
      { testCaseId: ids.get('lists'), via: 'file' },
      { testCaseId: ids.get('restarts'), via: 'file' },
    ]);
  });

  test('a changed line inside the method that is not a statement selects every test that ran the method', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET], {
      changes: [{ filePath: BASKET, blob: BASE, lines: [[58, 58]] }],
    });
    expect(titles(impact.tests.map((t) => t.testCaseId))).toEqual(['adds', 'empties', 'lists', 'restarts']);
    expect(impact.impact.files[0]!.tests.slice(0, 2).map((t) => t.via)).toEqual(['functions', 'functions']);
  });

  test('a changed statement no test ran selects no test from the file, and names the line', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET], {
      changes: [{ filePath: BASKET, blob: BASE, lines: [[61, 61]] }],
    });
    expect(titles(impact.tests.map((t) => t.testCaseId))).toEqual(['lists', 'restarts']);
    expect(impact.impact.files[0]).toMatchObject({ ruledOut: 2, notRun: [[61, 61]] });
  });

  test('a change outside the method is at file level', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET], {
      changes: [{ filePath: BASKET, blob: BASE, lines: [[45, 45]] }],
    });
    expect(titles(impact.tests.map((t) => t.testCaseId))).toEqual(['adds', 'empties', 'lists', 'restarts']);
    expect(impact.impact.files[0]).toMatchObject({ level: 'lines', ruledOut: 0, fileLevelLines: [[45, 45]] });
  });

  test('a base blob no coverage recorded leaves the file at file level', async () => {
    const impact = await resolveImpact(db as never, 1, [BASKET], {
      changes: [{ filePath: BASKET, blob: 'd'.repeat(40), lines: [[54, 54]] }],
    });
    expect(impact.impact.lineLevelFiles).toBe(0);
    expect(impact.tests).toHaveLength(4);
  });

  test('a test file in the change is never narrowed', async () => {
    const impact = await resolveImpact(db as never, 1, ['tests/shop.spec.ts', BASKET], {
      changes: [
        { filePath: 'tests/shop.spec.ts', blob: BASE, lines: [[1, 1]] },
        { filePath: BASKET, blob: BASE, lines: [[61, 61]] },
      ],
    });
    expect(impact.tests).toHaveLength(5);
    expect(impact.impact.files.find((f) => f.filePath === 'tests/shop.spec.ts')!.level).toBe('file');
  });
});

describe('get_impacted_tests', () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'get_impacted_tests')!;
  const ctx = {
    user: null,
    access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
    scope: new Set([1]),
  };
  const diff = [
    `diff --git a/${BASKET} b/${BASKET}`,
    `index ${BASE}..${'e'.repeat(40)} 100644`,
    `--- a/${BASKET}`,
    `+++ b/${BASKET}`,
    '@@ -54 +54 @@',
    '-        basket.Add(item);',
    '+        basket.Add(item, quantity);',
  ].join('\n');

  test('refuses a project out of scope, and a call with no change', async () => {
    await expect(tool.handler(db as never, { projectId: 2, diff }, ctx)).rejects.toThrow('No access to project 2');
    await expect(tool.handler(db as never, { projectId: 1, diff: ' ' }, ctx)).rejects.toThrow(/Pass diff/);
  });

  test('reads a diff to the tests that ran its changed lines, each with how', async () => {
    const answer = (await tool.handler(db as never, { projectId: 1, diff }, ctx)) as Record<string, any>;
    expect(answer).toMatchObject({ matched: 3, changedFiles: 1, lineLevelFiles: 1 });
    expect(answer.widened).toBeUndefined();
    const [file] = answer.files;
    expect(file).toMatchObject({ filePath: BASKET, level: 'lines', testCount: 3, ruledOut: 1 });
    expect(file.tests.map((t: any) => [t.title, t.via, t.lines])).toEqual([
      ['adds', 'lines', '54'],
      ['lists', 'file', undefined],
      ['restarts', 'file', undefined],
    ]);
    expect(answer.command).toContain('playwright test');
  });

  test('changedFiles alone stays at file level', async () => {
    const answer = (await tool.handler(db as never, { projectId: 1, changedFiles: [BASKET] }, ctx)) as Record<
      string,
      any
    >;
    expect(answer).toMatchObject({ matched: 4, lineLevelFiles: 0 });
    expect(answer.files[0].level).toBe('file');
  });
});
