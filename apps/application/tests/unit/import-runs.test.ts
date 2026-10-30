import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { ImportedRunCase, ParsedBlobReport } from '../../server/utils/blob-report';
import type { ParsedTraceImport } from '../../server/utils/trace-import';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules that import the barrel load.
delete process.env.PIWI_DATABASE_URL;
const { importBlobReportRun, importTraceRun, findImportedRun } = await import('#shared/handlers/import-runs');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Port = Parameters<typeof importBlobReportRun>[1];
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'import-project' });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

function port(overrides: Partial<Port> = {}): Port {
  return {
    persistRunCases: (database, projectId, testRunId, cases, options) =>
      persistRunCases(database as never, projectId, testRunId, cases as never, options),
    storeFile: async ({ entryName }) => ({ path: `stored/${entryName}`, size: 1 }),
    readTraceConsole: async () => null,
    parseErrorContext: () => ({ ariaSnapshot: null, testSource: null }),
    publishRunSubmitted: () => {},
    publishRollupUpdated: () => {},
    ...overrides,
  };
}

function execution(title: string, screenshot: string): ImportedRunCase {
  return {
    case: { title, filePath: 'tests/checkout.spec.ts', status: 'passed', line: 10, column: 5, browser: 'chromium' },
    traces: [],
    attachments: [{ entry: `resources/${screenshot}`, name: 'screenshot', contentType: 'image/png' }],
  };
}

function report(cases: ImportedRunCase[]): ParsedBlobReport {
  return {
    blobVersion: 2,
    playwrightVersion: '1.55.0',
    startTime: new Date('2026-09-30T10:00:00Z'),
    duration: 1000,
    status: 'passed',
    totalTests: cases.length,
    passedTests: cases.length,
    failedTests: 0,
    timedOutTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
    flakyTests: 0,
    shard: null,
    projectNames: ['chromium'],
    scm: null,
    cases,
  };
}

const readEntry = async (name: string) => new TextEncoder().encode(name);

const failingPersist: Partial<Port> = {
  persistRunCases: async () => {
    throw new Error('SQLITE_BUSY: database is locked');
  },
};

function trace(title: string): ParsedTraceImport {
  return {
    case: { title, filePath: 'checkout.spec.ts', status: 'passed', line: 10, column: 5 },
    startedAt: Date.parse('2026-09-30T10:00:00Z'),
    duration: 500,
    playwrightVersion: '1.55.0',
    rawFilePath: 'checkout.spec.ts',
  };
}

const traceInput = (importGroup: string | null = null) => ({
  projectId: 1,
  parsed: trace('pays'),
  bytes: new TextEncoder().encode('trace bytes'),
  importHash: 'c'.repeat(64),
  importGroup,
  source: 'trace.zip',
});

describe('importBlobReportRun', () => {
  test("puts the branch and commit the blob's config metadata recorded on the run", async () => {
    const result = await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: { ...report([execution('pays', 'pays.png')]), scm: { commit: 'abc123', branch: 'feature/pay' } },
      readEntry,
      importHash: 'b'.repeat(64),
      source: 'report.zip',
    });

    const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, result.runId));
    expect(run!.branch).toBe('feature/pay');
    expect(run!.metadata).toMatchObject({
      scm: { commit: 'abc123', branch: 'feature/pay' },
      piwiOrigin: { kind: 'import' },
    });
  });

  test("an archive older than the newest run keeps the tests' current metadata and dates its executions from their attempts", async () => {
    await db
      .insert(schema.testRuns)
      .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-10-01T10:00:00Z') });
    await persistRunCases(db as never, 1, 1, [
      {
        title: 'pays',
        filePath: 'tests/checkout.spec.ts',
        status: 'passed',
        tags: ['checkout'],
        locks: ['payments-db'],
        testAnnotations: [{ type: 'piwi:owner', description: 'team-pay' }],
      },
    ] as never);
    const attemptStart = Date.parse('2026-09-30T10:00:05Z');
    const old = execution('pays', 'pays.png');
    old.case = { ...old.case, status: 'failed', startedAt: attemptStart, tags: ['legacy'], locks: [] };

    const result = await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: report([old]),
      readEntry,
      importHash: 'd'.repeat(64),
      source: 'old-report.zip',
    });

    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    expect(testCase).toMatchObject({ tags: ['checkout'], locks: ['payments-db'], owner: 'team-pay' });
    const [imported] = await db
      .select()
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, result.runId));
    expect(imported!.createdAt.getTime()).toBe(attemptStart);
  });

  test('an archive newer than every stored run updates the tests it declares', async () => {
    await db
      .insert(schema.testRuns)
      .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-09-01T10:00:00Z') });
    await persistRunCases(db as never, 1, 1, [
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'passed', tags: ['checkout'] },
    ] as never);
    const fresh = execution('pays', 'pays.png');
    fresh.case = { ...fresh.case, tags: ['checkout', 'smoke'] };

    await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: report([fresh]),
      readEntry,
      importHash: 'e'.repeat(64),
      source: 'report.zip',
    });

    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    expect(testCase!.tags).toEqual(['checkout', 'smoke']);
  });

  test('an archive older than the newest run leaves a snoozed cluster asleep; a newer one wakes it', async () => {
    const error = 'Error: locator.click: Timeout 5000ms exceeded.\n\n    at /ci/tests/checkout.spec.ts:8:3';
    await db
      .insert(schema.testRuns)
      .values({ id: 1, projectId: 1, status: 'failed', startTime: new Date('2026-09-15T10:00:00Z') });
    await persistRunCases(db as never, 1, 1, [
      { title: 'pays', filePath: 'tests/checkout.spec.ts', status: 'failed', error },
    ] as never);
    await db.update(schema.failureClusters).set({ snoozedUntil: new Date(8.64e15), snoozeMode: 'until-recurs' });
    const failing = (title: string) => {
      const entry = execution(title, `${title}.png`);
      entry.case = { ...entry.case, status: 'failed', error };
      return entry;
    };
    const snoozed = async () => (await db.select().from(schema.failureClusters))[0]!.snoozedUntil;

    await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: { ...report([failing('pays')]), startTime: new Date('2026-09-01T10:00:00Z') },
      readEntry,
      importHash: 'f'.repeat(64),
      source: 'old-report.zip',
    });
    expect(await snoozed()).not.toBeNull();

    await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: report([failing('pays')]),
      readEntry,
      importHash: '9'.repeat(64),
      source: 'new-report.zip',
    });
    expect(await snoozed()).toBeNull();
  });

  test('links each file to the execution of its own case when a repeated case is deduplicated', async () => {
    const result = await importBlobReportRun(db as never, port(), {
      projectId: 1,
      parsed: report([
        execution('adds to cart', 'cart.png'),
        execution('adds to cart', 'cart-again.png'),
        execution('pays', 'pays.png'),
      ]),
      readEntry,
      importHash: 'a'.repeat(64),
      source: 'report.zip',
    });

    const executions = await db
      .select({ id: schema.testRunsCases.id, title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    const idOf = (title: string) => executions.find((e) => e.title === title)!.id;
    const linked = await db.select().from(schema.files);

    expect(result.attachmentCount).toBe(2);
    expect(linked.map((f) => [f.testRunsCaseId, f.path]).sort()).toEqual(
      [
        [idOf('adds to cart'), 'stored/resources/cart.png'],
        [idOf('pays'), 'stored/resources/pays.png'],
      ].sort(),
    );
  });
});

describe('a failed import', () => {
  const blobInput = (cases: ImportedRunCase[]) => ({
    projectId: 1,
    parsed: report(cases),
    readEntry,
    importHash: 'b'.repeat(64),
    source: 'report.zip',
  });

  test('leaves no run behind, so the retry imports instead of reporting a duplicate', async () => {
    await expect(
      importBlobReportRun(db as never, port(failingPersist), blobInput([execution('pays', 'pays.png')])),
    ).rejects.toThrow('SQLITE_BUSY');

    expect(await db.select().from(schema.testRuns)).toEqual([]);
    expect(await findImportedRun(db as never, 1, 'b'.repeat(64))).toBeNull();

    const retry = await importBlobReportRun(db as never, port(), blobInput([execution('pays', 'pays.png')]));
    expect(retry.status).toBe('imported');
  });

  test('removes the executions and files it already wrote', async () => {
    let stored = 0;
    const failsOnSecondFile: Partial<Port> = {
      storeFile: async ({ entryName }) => {
        if (++stored > 1) throw new Error('disk full');
        return { path: `stored/${entryName}`, size: 1 };
      },
    };

    await expect(
      importBlobReportRun(
        db as never,
        port(failsOnSecondFile),
        blobInput([execution('adds to cart', 'cart.png'), execution('pays', 'pays.png')]),
      ),
    ).rejects.toThrow('disk full');

    expect(await db.select().from(schema.testRuns)).toEqual([]);
    expect(await db.select().from(schema.testRunsCases)).toEqual([]);
    expect(await db.select().from(schema.files)).toEqual([]);
  });

  test('of a single trace leaves no run keyed by its hash', async () => {
    await expect(importTraceRun(db as never, port(failingPersist), traceInput())).rejects.toThrow('SQLITE_BUSY');

    expect(await db.select().from(schema.testRuns)).toEqual([]);
    const retry = await importTraceRun(db as never, port(), traceInput());
    expect(retry.status).toBe('imported');
  });

  test('of a trace joining an existing group run keeps that run', async () => {
    const group = 'd'.repeat(64);
    await importTraceRun(db as never, port(), { ...traceInput(group), parsed: trace('adds to cart') });

    await expect(
      importTraceRun(db as never, port(failingPersist), { ...traceInput(group), importHash: 'e'.repeat(64) }),
    ).rejects.toThrow('SQLITE_BUSY');

    const runs = await db.select().from(schema.testRuns);
    expect(runs.map((r) => r.importHash)).toEqual([group]);
    expect(await db.select().from(schema.testRunsCases)).toHaveLength(1);
  });
});

describe('importTraceRun', () => {
  test("dates the execution from the trace's start and leaves a newer run's metadata alone", async () => {
    await db
      .insert(schema.testRuns)
      .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date('2026-10-01T10:00:00Z') });
    await persistRunCases(db as never, 1, 1, [
      { title: 'pays', filePath: 'checkout.spec.ts', status: 'passed', tags: ['checkout'] },
    ] as never);
    const input = traceInput();
    input.parsed.case = { ...input.parsed.case, tags: ['legacy'] } as never;

    const result = await importTraceRun(db as never, port(), input);

    const [imported] = await db
      .select()
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, result.runId));
    expect(imported!.createdAt.getTime()).toBe(input.parsed.startedAt);
    const [testCase] = await db.select().from(schema.testCases).where(eq(schema.testCases.title, 'pays'));
    expect(testCase!.tags).toEqual(['checkout']);
  });
});
