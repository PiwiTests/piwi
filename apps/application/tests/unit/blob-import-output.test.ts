import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { parseBlobReport } from '../../server/utils/blob-report';
import { openArchive } from '../../server/utils/archive-reader';
import { buildBlobReport } from '../utils/blob-report-fixture';
import { migrateToLatest } from './temp-db';

/**
 * An imported blob report keeps what a reported run keeps of its output and its errors outside any test: the run's
 * errors on the run page, what each attempt wrote to stdout and stderr on its execution's Output tab, through the
 * server's ingest and the demo's alike.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules that import the barrel load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../app/demo/db.client', () => ({ getDemoDb: async () => state.db }));

const { importBlobReportRun } = await import('#shared/handlers/import-runs');
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const demo = await import('../../app/demo/api/reporter');
const { getTestRun } = await import('#shared/handlers/test-runs');
const { getTestRunCase } = await import('#shared/handlers/test-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Port = Parameters<typeof importBlobReportRun>[1];
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'import-output' });
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

const ingests: Array<[string, Port['persistRunCases']]> = [
  [
    'server',
    (database, projectId, testRunId, cases, options) =>
      persistRunCases(database as never, projectId, testRunId, cases as never, options),
  ],
  [
    'demo',
    (database, projectId, testRunId, cases, options) =>
      demo.persistRunCases(database as never, projectId, testRunId, cases as never, false, options),
  ],
];

const archive = buildBlobReport({
  runStatus: 'failed',
  runErrors: [
    {
      message: 'Error: worker teardown failed for https://api.example.test/reset?token=s3cr3t-v4lue',
      stack: 'Error: worker teardown failed\n    at teardown (/repo/fixtures.ts:9:3)',
      location: { file: '/repo/fixtures.ts', line: 9, column: 3 },
    },
  ],
  tests: [
    {
      testId: 't',
      title: 'pays',
      attempts: [
        {
          status: 'failed',
          errorMessage: 'Error: boom',
          stdout: ['order 4521 created\n'],
          stderr: ['GET https://api.example.test/me?access_token=t0k3n-v4lue 502\n'],
        },
      ],
    },
  ],
});

describe.each(ingests)('a blob report imported through the %s ingest', (_name, persist) => {
  test('keeps its errors outside any test on the run, and the output of each attempt on its execution', async () => {
    const port: Port = {
      persistRunCases: persist,
      storeFile: async ({ entryName }) => ({ path: `stored/${entryName}`, size: 1 }),
      readTraceConsole: async () => null,
      parseErrorContext: () => ({ ariaSnapshot: null, testSource: null }),
      publishRunSubmitted: () => {},
      publishRollupUpdated: () => {},
    };
    const { readEntry } = openArchive(archive);
    const { runId } = (await importBlobReportRun(db as never, port, {
      projectId: 1,
      parsed: await parseBlobReport(readEntry),
      readEntry,
      importHash: 'a'.repeat(64),
      source: 'report.zip',
    })) as { runId: number };

    expect((await getTestRun(db as never, runId))?.runErrors).toEqual([
      {
        message: 'Error: worker teardown failed for https://api.example.test/reset?token=<hidden>',
        stack: '    at teardown (/repo/fixtures.ts:9:3)',
        location: { file: 'fixtures.ts', line: 9, column: 3 },
      },
    ]);
    const [execution] = await db
      .select({ id: schema.testRunsCases.id })
      .from(schema.testRunsCases)
      .where(eq(schema.testRunsCases.testRunId, runId));
    const stored = await getTestRunCase(db as never, execution!.id);
    expect(stored?.stdout).toBe('order 4521 created\n');
    expect(stored?.stderr).toBe('GET https://api.example.test/me?access_token=<hidden> 502\n');
  });
});
