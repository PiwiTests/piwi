import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { LocalStorageAdapter } from '../../server/storage/local';
import { S3StorageAdapter } from '../../server/storage/s3';
import type { StorageAdapter } from '../../server/storage/types';

/**
 * `GET /api/admin/storage` and `GET /api/admin/stats` measure the storage folder on disk for local storage, and walk
 * nothing on S3, whose `storageSizeOnDisk` is null.
 */

const state = vi.hoisted(() => ({ storage: null as StorageAdapter | null }));
vi.mock('../../server/storage', () => ({ getStorage: () => state.storage }));
vi.mock('../../server/database', () => ({ getDatabase: async () => null }));
vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({}) }));
vi.mock('#shared/handlers/admin-storage', () => ({ getStorageAnalysis: async () => ({ trackedTotal: 7 }) }));
vi.mock('#shared/handlers/admin', () => ({ getAdminStats: async () => ({ projects: 2 }) }));
const walked = vi.hoisted(() => [] as string[]);
vi.mock('../../server/utils/filesize', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/utils/filesize')>();
  return {
    getDirectorySize: (path: string) => {
      walked.push(path);
      return real.getDirectorySize(path);
    },
  };
});

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);

type Answer = { storageSizeOnDisk: number | null; storageLocation: string };
const routes = {
  storage: (await import('../../server/api/admin/storage.get')).default as unknown as (e: unknown) => Promise<Answer>,
  stats: (await import('../../server/api/admin/stats.get')).default as unknown as (e: unknown) => Promise<Answer>,
};

const env = { ...process.env };
let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'piwi-data-location-'));
  walked.length = 0;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  process.env = { ...env };
});

describe.each(Object.entries(routes))('GET /api/admin/%s', (name, route) => {
  test('measures the local storage folder', async () => {
    writeFileSync(join(folder, 'report.html'), 'x'.repeat(1234));
    process.env.PIWI_STORAGE_TYPE = 'local';
    process.env.PIWI_STORAGE_PATH = folder;
    state.storage = new LocalStorageAdapter(folder);

    const answer = await route({});

    expect(answer.storageSizeOnDisk).toBe(1234);
    expect(answer.storageLocation).toBe(resolve(folder));
    expect(answer).toMatchObject(name === 'storage' ? { trackedTotal: 7 } : { projects: 2 });
    expect(walked).toEqual([resolve(folder)]);
  });

  test('walks nothing on S3, and reports no size on disk', async () => {
    process.env.PIWI_STORAGE_TYPE = 's3';
    process.env.PIWI_S3_BUCKET = 'evidence';
    state.storage = new S3StorageAdapter({ bucket: 'evidence', region: 'eu-west-3' });

    const answer = await route({});

    expect(answer.storageSizeOnDisk).toBeNull();
    expect(answer.storageLocation).toBe('S3 bucket: evidence');
    expect(walked).toEqual([]);
  });
});
