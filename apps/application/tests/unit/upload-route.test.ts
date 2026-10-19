import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
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
    writeFile: async (path: string, data: Buffer) => {
      if (path.endsWith('unwritable.js')) throw new Error(`503 Slow Down: ${path}`);
      state.written.set(path, data);
    },
    deleteDirectory: async (path: string) => {
      for (const key of [...state.written.keys()]) if (key.startsWith(`${path}/`)) state.written.delete(key);
    },
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
    // Either upload may reach the server first; the other answers as the repeat.
    expect([first, second].filter((r) => (r as { duplicate?: boolean }).duplicate)).toHaveLength(1);
    expect(await db.select().from(schema.testRuns)).toHaveLength(1);
    expect(await db.select().from(schema.files)).toHaveLength(1);
  });

  test('keeps two attachments of one case that share a file name, each under that name', async () => {
    const { runId } = await upload({
      parts: [
        field('projectName', 'upload-same-name'),
        field('testRun', { status: 'failed', startTime: '2026-09-30T10:00:00Z' }),
        field('testCases', [{ title: 'pays', status: 'failed', location: 'tests/pays.spec.ts:1:1' }]),
        field('attach_meta_0', [
          { name: 'screenshot', contentType: 'image/png', originalName: 'screenshot.png' },
          { name: 'screenshot', contentType: 'image/png', originalName: 'screenshot.png' },
        ]),
        { name: 'attach_file_0', filename: 'screenshot.png', data: Buffer.from('first') },
        { name: 'attach_file_0', filename: 'screenshot.png', data: Buffer.from('second') },
      ],
    });

    const attachments = await db.select().from(schema.files).where(eq(schema.files.testRunId, runId));
    const paths = attachments.map((f) => f.path);
    expect(new Set(paths).size).toBe(2);
    expect(paths.map((p) => p.split('/').pop())).toEqual(['screenshot.png', 'screenshot.png']);
    expect(paths.map((p) => state.written.get(p)?.toString())).toEqual(['first', 'second']);
  });

  /** A report directory packed as the reporter packs it: path and content lengths, then the bytes, gzipped. */
  function reportArchive(files: Record<string, string>): Buffer {
    const parts: Buffer[] = [];
    for (const [path, content] of Object.entries(files)) {
      const name = Buffer.from(path);
      const data = Buffer.from(content);
      const lengths = (n: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n);
        return b;
      };
      parts.push(lengths(name.length), name, lengths(data.length), data);
    }
    return gzipSync(Buffer.concat(parts));
  }

  const reportTempDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith('piwi-report-html-'));

  const reportUpload = (archive: Buffer) => [
    field('projectName', 'upload-report'),
    field('testRun', { status: 'passed', startTime: '2026-09-30T10:00:00Z' }),
    { name: 'htmlReport', filename: 'report.gz', data: archive },
  ];

  test('extracts a report into a folder of its own and removes its temp copy', async () => {
    const tempBefore = reportTempDirs();
    await upload({ parts: reportUpload(reportArchive({ 'index.html': '<html>', 'data/app.js': 'app()' })) });
    await upload({ parts: reportUpload(reportArchive({ 'index.html': '<html>', 'data/app.js': 'app()' })) });

    const reports = await db.select().from(schema.files).where(eq(schema.files.type, 'report'));
    expect(reports).toHaveLength(2);
    expect(reports[0]!.path).not.toBe(reports[1]!.path);
    for (const report of reports) {
      expect(report.path).toMatch(/^project-\d+\/run-\d+-[0-9a-f]{8}-html-report\/index\.html$/);
      expect(state.written.get(report.path.replace('index.html', 'data/app.js'))?.toString()).toBe('app()');
    }
    expect(reportTempDirs()).toEqual(tempBefore);
  });

  test('a report whose copy fails halfway keeps no partial folder and is stored as its archive', async () => {
    const tempBefore = reportTempDirs();
    const archive = reportArchive({ 'index.html': '<html>', 'data/unwritable.js': 'app()' });
    await upload({ parts: reportUpload(archive) });

    const [report] = await db.select().from(schema.files).where(eq(schema.files.type, 'report'));
    expect(report!.path).toMatch(/^project-\d+\/run-\d+-[0-9a-f]{8}-report\.gz$/);
    expect([...state.written.keys()].filter((key) => key.includes('html-report'))).toEqual([]);
    expect(state.written.get(report!.path)).toEqual(archive);
    expect(reportTempDirs()).toEqual(tempBefore);
  });
});
