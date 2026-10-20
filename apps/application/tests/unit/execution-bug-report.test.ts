import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { bugReportFromFiles, isBugReportArchive } from '@piwitests/core/bug-report';
import * as schema from '../../server/database/schema.sqlite';
import type { ExportAssetReader } from '../../shared/export/types';
import { parseZipSync } from '../utils/zip';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the handler.
delete process.env.PIWI_DATABASE_URL;
const { executionBugReportArchive, executionReplaySummary, getExecutionBugReport } =
  await import('../../shared/handlers/execution-bug-report');

let db: ReturnType<typeof drizzle<typeof schema>>;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const reader = (bytes: Uint8Array | null): ExportAssetReader => ({ read: async () => bytes });

const ERROR =
  'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'total\')\nExpected string: "Total: 42"\nReceived string: "Total: 50"\nTimeout: 5000ms\n\n    at tests/cart.spec.ts:9:40';

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });

  await db.insert(schema.projects).values([{ id: 1, name: 'Shop' }]);
  await db.insert(schema.testRuns).values([{ id: 1, projectId: 1, status: 'failed', startTime: new Date() }]);
  await db
    .insert(schema.testCases)
    .values([{ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'Coupon applies to the total' }]);
  const at = (line: number) => `/ci/shop/tests/cart.spec.ts:${line}:5`;
  await db.insert(schema.testRunsCases).values([
    {
      id: 7,
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error: ERROR,
      startedAt: 1790000000000,
      browser: { projectName: 'chromium', browserName: 'chromium', viewport: { width: 1280, height: 720 } },
      pageState: { url: 'https://staging.shop.test/cart' },
      consoleLogs: [
        { type: 'error', text: 'Failed to load resource: 500', timestamp: 1790000000300 },
        { type: 'log', text: 'hello', timestamp: 1790000000301 },
      ],
      steps: [
        { title: 'Navigate', subtitle: '/cart', category: 'navigation', depth: 0, location: at(5) },
        { title: 'Fill "SPRING10"', subtitle: "getByLabel('Coupon')", category: 'input', depth: 0, location: at(6) },
        { title: 'Fill "hunter2"', subtitle: "locator('#pw')", category: 'input', depth: 0, location: at(7) },
        { title: 'POST', subtitle: '/api/seed', category: 'api', depth: 0, location: at(8) },
        {
          title: 'Expect "toHaveText"',
          subtitle: "getByTestId('total')",
          category: 'assertion',
          depth: 0,
          location: at(9),
          failed: true,
          error: { message: ERROR },
        },
      ],
    },
  ]);
  await db.insert(schema.networkRequests).values([
    { testRunsCaseId: 7, testRunId: 1, method: 'POST', url: 'https://staging.shop.test/api/coupons', status: 500 },
    { testRunsCaseId: 7, testRunId: 1, method: 'GET', url: 'https://staging.shop.test/api/cart', status: 200 },
  ]);
  await db.insert(schema.locatorSnapshots).values([
    {
      testCaseId: 1,
      location: at(7),
      usedMethod: 'locator',
      usedArgs: JSON.stringify(['#pw']),
      usedArgsFp: 'x',
      elementTag: 'INPUT',
      elementAttrs: JSON.stringify({ type: 'password', accessibleName: 'Password' }),
      elementText: null,
      alternatives: JSON.stringify([{ locator: "getByLabel('Password')", method: 'getByLabel', args: {}, score: 90 }]),
      lastSeenRunId: 1,
      lastSeenAt: new Date(),
    },
  ]);
  await db.insert(schema.files).values([
    {
      testRunsCaseId: 7,
      testRunId: 1,
      type: 'attachment',
      subtype: 'screenshot',
      label: 'image/png',
      path: 'p/1.png',
    },
  ]);
});

describe('getExecutionBugReport', () => {
  test('makes the report from the stored steps, snapshots, console, requests and browser', async () => {
    const built = (await getExecutionBugReport(db as never, 7))!;
    const { report } = built;
    expect(built.fileName).toBe('coupon-applies-to-the-total.piwibug');
    expect(built.screenshotPath).toBe('p/1.png');
    expect(report.steps.origin).toBe('https://staging.shop.test');
    expect(report.steps.steps.map((s) => s.action)).toEqual(['goto', 'fill', 'fill', 'assert']);
    expect(report.steps.steps[2]).toMatchObject({
      redacted: true,
      value: null,
      target: { accessibleName: 'Password' },
    });
    expect(report.steps.steps[3]!.assertion).toMatchObject({ expected: 'Total: 42', actual: 'Total: 50' });
    expect(report.steps.viewports).toEqual([{ step: 0, width: 1280, height: 720 }]);
    expect(report.evidence.console.map((c) => c.message)).toEqual(['Failed to load resource: 500']);
    expect(report.evidence.requests).toEqual([{ method: 'POST', url: '/api/coupons', status: 500, page: '', time: 0 }]);
    expect(report.export).toMatchObject({ executionId: 7, failedStep: 3 });
    expect(report.export!.notes.map((n) => [n.title, n.location])).toEqual([
      ['POST /api/seed', 'tests/cart.spec.ts:8'],
    ]);
    expect(executionReplaySummary(built)).toMatchObject({
      stepCount: 4,
      manualSteps: 0,
      notReplayed: 1,
      failedStep: 3,
    });
  });

  test('answers null for an execution that does not exist', async () => {
    expect(await getExecutionBugReport(db as never, 999)).toBeNull();
  });
});

describe('executionBugReportArchive', () => {
  test('writes the archive as Piwi Picker does: mimetype first and stored, every entry uncompressed', async () => {
    const built = (await getExecutionBugReport(db as never, 7))!;
    const bytes = await executionBugReportArchive(built, reader(PNG));
    expect(isBugReportArchive(bytes)).toBe(true);
    const entries = parseZipSync(Buffer.from(bytes));
    expect(entries.map((e) => e.name)).toEqual([
      'mimetype',
      'steps.json',
      'coupon-applies-to-the-total.spec.ts',
      'bug-report.md',
      'evidence.json',
      'screenshots/1-finish.png',
    ]);
    const text = (name: string) => entries.find((e) => e.name === name)!.data.toString('utf8');
    expect(Uint8Array.from(entries.at(-1)!.data)).toEqual(PNG);
    expect(text('steps.json')).not.toContain('hunter2');
    expect(text('bug-report.md')).toContain('## Not replayed');
    const back = bugReportFromFiles({ steps: text('steps.json'), evidence: text('evidence.json') });
    expect(back.ok && back.report).toEqual(built.report);
  });

  test('says the report has no screenshot when the screenshot cannot be read', async () => {
    const built = (await getExecutionBugReport(db as never, 7))!;
    const entries = parseZipSync(Buffer.from(await executionBugReportArchive(built, reader(null))));
    expect(entries.map((e) => e.name)).not.toContain('screenshots/1-finish.png');
    const evidence = JSON.parse(entries.find((e) => e.name === 'evidence.json')!.data.toString('utf8'));
    expect(evidence.evidence).toMatchObject({
      screenshots: [],
      screenshotNote: 'the failure screenshot could not be read',
    });
  });
});
