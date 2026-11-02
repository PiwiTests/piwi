import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { multipartEvent, type MultipartPart } from './multipart-event';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route module (which imports the barrel) loads.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, written: new Map<string, Buffer>() }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    mkdir: async () => {},
    writeFile: async (path: string, data: Buffer) => void state.written.set(path, data),
  }),
}));
vi.mock('../../server/utils/trace-fallback-evidence', () => ({ deriveTraceEvidence: vi.fn() }));
// The feature-graph write runs after persistRunCases returns, off the request path: it has nothing to do here.
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return { ...mod, ingestRunGraph: async () => {}, ingestRequestGraph: async () => {} };
});

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: { params?: Record<string, string> }, name: string) => event.params?.[name]);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);

const route = (await import('../../server/api/test-runs/[id]/case-files.post')).default as unknown as (
  event: unknown,
) => Promise<{ executionId: number; attachments: number }>;
const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { streamTokenDigest } = await import('../../server/utils/shard-tokens');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;
let runId: number;

const STREAM_TOKEN = 'stream-token-of-the-run';

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  state.written.clear();
  const [project] = await db.insert(schema.projects).values({ name: 'case-files' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
  const [run] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'running',
      startTime: new Date(),
      metadata: {},
      origin: 'ci',
      streamToken: streamTokenDigest(STREAM_TOKEN),
    })
    .returning();
  runId = run!.id;
});

const field = (name: string, value: unknown): MultipartPart => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

/** The reporter's upload of one screenshot for the execution `testCase` names. */
function uploadScreenshot(testCase: Record<string, unknown>, name = 'screenshot.png') {
  return route({
    params: { id: String(runId) },
    ...multipartEvent([
      field('streamToken', STREAM_TOKEN),
      field('testCase', testCase),
      field('attach_meta', [{ name: 'screenshot', contentType: 'image/png', originalName: name }]),
      { name: 'attach_file', filename: name, data: Buffer.from(name) },
    ]),
  });
}

/** Store the executions of the run, as its streamed `complete` events do. */
async function stream(cases: Array<Record<string, unknown>>) {
  return persistRunCases(db as never, projectId, runId, cases as never);
}

describe('POST /api/test-runs/:id/case-files', () => {
  test('finds the execution of a test whose title is too long to be stored whole', async () => {
    const title = `shows the receipt of ${'a very long order '.repeat(200)}`;
    const [execution] = await stream([
      { title, filePath: 'tests/receipt.spec.ts', status: 'failed', line: 3, column: 1, retries: 0 },
    ]);

    const answer = await uploadScreenshot({ title, location: 'tests/receipt.spec.ts:3:1', retries: 0 });

    expect(answer).toMatchObject({ executionId: execution!.id, attachments: 1 });
  });

  test('finds the execution of a test with an empty title, as Playwright runs it', async () => {
    const [execution] = await stream([
      { title: '', filePath: 'tests/receipt.spec.ts', status: 'failed', line: 3, column: 1, retries: 0 },
    ]);

    const answer = await uploadScreenshot({ title: '', location: 'tests/receipt.spec.ts:3:1', retries: 0 });

    expect(answer).toMatchObject({ executionId: execution!.id, attachments: 1 });
  });
});

describe('the execution a case-files upload lands on', () => {
  const ranIn = (projectName: string) => ({
    title: 'pays',
    filePath: 'tests/pay.spec.ts',
    status: 'failed',
    line: 3,
    column: 1,
    retries: 0,
    browser: { projectName, browserName: projectName },
  });
  const testCase = { title: 'pays', location: 'tests/pay.spec.ts:3:1', retries: 0, repeatEachIndex: 0 };
  const attached = async () =>
    (await db.select().from(schema.files)).map((file) => [file.testRunsCaseId, file.path.split('/').pop()]);

  test('is the one of the Playwright project the upload names', async () => {
    const [chromium, firefox] = await stream([ranIn('chromium'), ranIn('firefox')]);

    await uploadScreenshot({ ...testCase, projectName: 'chromium' }, 'chromium.png');
    await uploadScreenshot({ ...testCase, projectName: 'firefox' }, 'firefox.png');

    expect(await attached()).toEqual([
      [chromium!.id, 'chromium.png'],
      [firefox!.id, 'firefox.png'],
    ]);
  });

  test("is not another project's when the one named has no execution yet", async () => {
    await stream([ranIn('firefox')]);

    await expect(uploadScreenshot({ ...testCase, projectName: 'chromium' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('is found by the test alone when the upload names no project', async () => {
    const [execution] = await stream([ranIn('chromium')]);

    await expect(uploadScreenshot(testCase)).resolves.toMatchObject({ executionId: execution!.id });
  });
});
