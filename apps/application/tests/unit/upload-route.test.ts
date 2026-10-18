import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { durationStats } from '#shared/utils/stats';
import { multipartEvent, type MultipartPart as Part } from './multipart-event';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown, written: new Map<string, Buffer>() }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  isAuthEnabled: () => false,
}));
vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    mkdir: async () => {},
    writeFile: async (path: string, data: Buffer) => void state.written.set(path, data),
  }),
}));
vi.mock('../../server/utils/trace-blobs', () => ({ upsertTraceBlob: vi.fn(), findTraceBlob: vi.fn() }));
vi.mock('../../server/utils/trace-fallback-evidence', () => ({ deriveTraceEvidence: vi.fn() }));
vi.mock('../../server/utils/run-finalize-side-effects', () => ({ runFinalizeSideEffects: vi.fn(async () => {}) }));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRequestHeader', () => undefined);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('durationStats', durationStats);

const route = (await import('../../server/api/test-runs/upload.post')).default as unknown as (
  event: unknown,
) => Promise<{ runId: number; projectId: number }>;

/** Post the parts to the route as the reporter does: a chunked multipart body. */
const upload = ({ parts }: { parts: Part[] }) => route(multipartEvent(parts));
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  state.db = db;
  state.written.clear();
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
});

const field = (name: string, value: unknown): Part => ({
  name,
  data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});

function screenshot(index: number, originalName: string): Part[] {
  return [
    field(`attach_meta_${index}`, [{ name: 'screenshot', contentType: 'image/png', originalName }]),
    { name: `attach_file_${index}`, filename: originalName, data: Buffer.from(originalName) },
  ];
}

describe('POST /api/test-runs/upload', () => {
  test('links each attachment to the execution of its own case when a duplicate case is skipped', async () => {
    const testCase = (title: string) => ({
      title,
      status: 'failed',
      location: 'tests/checkout.spec.ts:10:5',
      browser: 'chromium',
      retries: 0,
    });

    const { runId } = await upload({
      parts: [
        field('projectName', 'upload-links'),
        field('testRun', { status: 'failed', startTime: '2026-09-30T10:00:00Z', totalTests: 3 }),
        field('testCases', [testCase('adds to cart'), testCase('adds to cart'), testCase('pays')]),
        ...screenshot(1, 'duplicate.png'),
        ...screenshot(2, 'pays.png'),
      ],
    });

    const executions = await db
      .select({ id: schema.testRunsCases.id, title: schema.testCases.title })
      .from(schema.testRunsCases)
      .innerJoin(schema.testCases, eq(schema.testCases.id, schema.testRunsCases.testCaseId));
    const attachments = await db.select().from(schema.files);

    expect(executions).toHaveLength(2);
    const paysId = executions.find((e) => e.title === 'pays')!.id;
    expect(attachments.map((f) => [f.testRunId, f.testRunsCaseId, f.path.split('/').pop()])).toEqual([
      [runId, paysId, 'pays.png'],
    ]);
  });

  test('refuses a chunked upload past the size cap, counted on the bytes read', async () => {
    process.env.PIWI_IMPORT_MAX_BYTES = String(1024 * 1024);
    try {
      await expect(
        upload({
          parts: [
            field('projectName', 'upload-cap'),
            field('testRun', { status: 'passed', startTime: '2026-09-30T10:00:00Z' }),
            { name: 'htmlReport', filename: 'report.gz', data: Buffer.alloc(2 * 1024 * 1024, 1) },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 413 });
      expect(await db.select().from(schema.testRuns)).toHaveLength(0);
    } finally {
      delete process.env.PIWI_IMPORT_MAX_BYTES;
    }
  });

  test('shards of a batch run join one run, which the last shard settles', async () => {
    const shard = (shardIndex: number, title: string) => [
      field('projectName', 'upload-shards'),
      field('testRun', {
        status: 'passed',
        startTime: '2026-09-30T10:00:00Z',
        totalTests: 1,
        passedTests: 1,
        instanceId: 'ci-42',
        shardIndex,
        shardTotal: 2,
      }),
      field('testCases', [{ title, status: 'passed', location: `tests/${title}.spec.ts:1:1`, duration: 5 }]),
    ];

    const one = await upload({ parts: shard(1, 'pays') });
    expect((await db.select().from(schema.testRuns))[0]).toMatchObject({ status: 'running', shardsFinished: 1 });

    const two = await upload({ parts: shard(2, 'adds') });
    expect(two.runId).toBe(one.runId);
    const runs = await db.select().from(schema.testRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'passed', shardsFinished: 2, passedTests: 2 });
  });

  test('an upload repeated under its delivery key answers with the first run and stores nothing again', async () => {
    const parts = () => [
      field('projectName', 'upload-repeat'),
      field('testRun', { status: 'passed', startTime: '2026-09-30T10:00:00Z', deliveryKey: 'upload-delivery-key-1' }),
      field('testCases', [{ title: 'pays', status: 'passed', location: 'tests/pays.spec.ts:1:1' }]),
      ...screenshot(0, 'pays.png'),
    ];

    const [first, second] = await Promise.all([upload({ parts: parts() }), upload({ parts: parts() })]);
    expect(second.runId).toBe(first.runId);
    expect(second).toMatchObject({ duplicate: true });
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
    expect(await db.select().from(schema.files)).toHaveLength(1);
  });
});
