import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
