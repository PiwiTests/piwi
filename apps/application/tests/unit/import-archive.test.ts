import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import { buildBlobReport } from '../utils/blob-report-fixture';

/** The server's import of one archive: a file it cannot store fails the import, which leaves no run. */

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_AUTH_ENABLED;

const storageDir = mkdtempSync(join(tmpdir(), 'piwi-import-archive-'));
process.env.PIWI_STORAGE_PATH = storageDir;
const { resetStorage } = await import('../../server/storage');
const { LocalStorageAdapter } = await import('../../server/storage/local');
resetStorage();
const { importArchive } = await import('../../server/utils/import-archive');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

let db: TempDb;
let close: () => Promise<void>;

const archive = {
  filename: 'report.zip',
  data: buildBlobReport({
    tests: [
      {
        testId: 'pays',
        title: 'pays',
        attempts: [{ status: 'passed', attachments: [{ name: 'screenshot', contentType: 'image/png', body: 'png' }] }],
      },
    ],
  }),
};

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  // Each test's database and storage start empty: forget the test cases a previous one stored.
  testCaseCache.invalidate(1);
  testSuiteCache.invalidate(1);
  rmSync(storageDir, { recursive: true, force: true });
  mkdirSync(storageDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});
afterAll(() => rmSync(storageDir, { recursive: true, force: true }));

describe('importArchive', () => {
  test('fails when it cannot store a file, leaving no run, and imports in full once storage recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = vi
      .spyOn(LocalStorageAdapter.prototype, 'writeFile')
      .mockRejectedValue(new Error('ENOSPC: no space left on device'));

    await expect(importArchive({ user: null, projectName: 'shop', archive })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await db.select().from(schema.testRuns)).toEqual([]);
    expect(await db.select().from(schema.files)).toEqual([]);

    write.mockRestore();
    const retry = await importArchive({ user: null, projectName: 'shop', archive });
    expect(retry).toMatchObject({ status: 'imported', attachmentCount: 1 });
  });

  test('removes the files it stored for a run it discards', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const archiveWithTrace = {
      filename: 'report-2.zip',
      data: buildBlobReport({
        tests: ['adds to cart', 'pays'].map((title, i) => ({
          testId: title,
          title,
          attempts: [
            {
              status: 'passed' as const,
              attachments: [
                ...(i === 0 ? [{ name: 'trace', contentType: 'application/zip', body: 'trace bytes' }] : []),
                { name: 'screenshot', contentType: 'image/png', body: `png ${i}` },
              ],
            },
          ],
        })),
      }),
    };
    // The second screenshot cannot be written: the first is already in the run's folder, the trace in the blobs.
    const write = LocalStorageAdapter.prototype.writeFile;
    let runWrites = 0;
    vi.spyOn(LocalStorageAdapter.prototype, 'writeFile').mockImplementation(async function (
      this: InstanceType<typeof LocalStorageAdapter>,
      path: string,
      data: Buffer,
    ) {
      if (/\/run-\d+\//.test(path) && ++runWrites === 2) throw new Error('EIO: i/o error');
      return write.call(this, path, data);
    });

    await expect(importArchive({ user: null, projectName: 'shop', archive: archiveWithTrace })).rejects.toMatchObject({
      statusCode: 503,
    });

    expect(runWrites).toBe(2);
    expect(await db.select().from(schema.testRuns)).toEqual([]);
    expect(await db.select().from(schema.traceBlobs)).toEqual([]);
    const [project] = await db.select().from(schema.projects);
    const projectDir = join(storageDir, `project-${project!.id}`);
    expect(readdirSync(projectDir).filter((name) => name.startsWith('run-'))).toEqual([]);
    expect(existsSync(join(projectDir, 'blobs')) ? readdirSync(join(projectDir, 'blobs')) : []).toEqual([]);
  });
});
