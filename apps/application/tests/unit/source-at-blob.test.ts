import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

/**
 * A file's source at a git blob: read by the blob's id where the project's
 * provider can, else as the file at the run's commit when its blob id is the
 * one asked; kept by blob; refused past the fetch cap or with no repository.
 */

const provider = {
  fetchBlob: vi.fn<(blob: string) => Promise<string | null>>(),
  fetchFileAtRef:
    vi.fn<(path: string, ref: string) => Promise<{ path: string; content: string; truncated: boolean } | null>>(),
};
const createScmProvider = vi.fn(async (_url: string, _db: unknown, _projectId?: number) => provider);
vi.mock('../../server/utils/scm', () => ({
  createScmProvider: (...args: Parameters<typeof createScmProvider>) => createScmProvider(...args),
}));

delete process.env.PIWI_DATABASE_URL;
const { getSourceAtBlob, clearSourceAtBlobCache } = await import('../../server/utils/source-at-blob');
const { gitBlobId } = await import('../../shared/utils/hash');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

const SOURCE = 'public static class Basket\n{\n    public static int Count => 3;\n}\n';
const PATH = 'src/Basket.cs';
const REPO = 'https://github.com/acme/shop';
const COMMIT = 'c'.repeat(40);
let BLOB: string;

beforeAll(async () => {
  BLOB = await gitBlobId(SOURCE);
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'no-repo' },
  ]);
  const at = new Date();
  await db.insert(schema.testRuns).values([
    {
      id: 1,
      projectId: 1,
      status: 'passed',
      startTime: at,
      metadata: { scm: { remoteUrl: `${REPO}.git`, commit: COMMIT } },
    },
    { id: 2, projectId: 1, status: 'passed', startTime: at, metadata: { scm: { commit: 'd'.repeat(40) } } },
    { id: 3, projectId: 2, status: 'passed', startTime: at, metadata: { scm: { commit: COMMIT } } },
  ]);
});

beforeEach(() => {
  clearSourceAtBlobCache();
  provider.fetchBlob.mockReset();
  provider.fetchFileAtRef.mockReset();
  createScmProvider.mockClear();
});

describe('gitBlobId', () => {
  test('is the id git hash-object gives a file', async () => {
    expect(await gitBlobId('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(await gitBlobId('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // The byte length counts UTF-8 bytes, not characters.
    expect(await gitBlobId('é\n')).toBe('c6003325155f475bd7c87731607525dce73be9cf');
    expect(await gitBlobId('hello\n', 'sha256')).toHaveLength(64);
  });
});

describe('getSourceAtBlob', () => {
  test('reads the blob by id through the repository the project’s runs record, and keeps it', async () => {
    provider.fetchBlob.mockResolvedValue(SOURCE);
    expect(await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB.toUpperCase() })).toEqual({
      path: PATH,
      blob: BLOB,
      content: SOURCE,
    });
    expect(createScmProvider).toHaveBeenCalledWith(REPO, db, 1);
    expect(provider.fetchBlob).toHaveBeenCalledWith(BLOB);
    expect(provider.fetchFileAtRef).not.toHaveBeenCalled();

    // A blob never changes: the second read asks nobody.
    expect((await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB }))?.content).toBe(SOURCE);
    expect(provider.fetchBlob).toHaveBeenCalledTimes(1);
  });

  test('falls back on the file at the run’s commit when its blob id is the one asked', async () => {
    provider.fetchBlob.mockResolvedValue(null);
    provider.fetchFileAtRef.mockResolvedValue({ path: PATH, content: SOURCE, truncated: false });
    expect((await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 1 }))?.content).toBe(SOURCE);
    expect(provider.fetchFileAtRef).toHaveBeenCalledWith(PATH, COMMIT);
  });

  test('reads a run without a repository at its own commit, through the project’s repository', async () => {
    provider.fetchBlob.mockResolvedValue(null);
    provider.fetchFileAtRef.mockResolvedValue({ path: PATH, content: SOURCE, truncated: false });
    await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 2 });
    expect(createScmProvider).toHaveBeenCalledWith(REPO, db, 1);
    expect(provider.fetchFileAtRef).toHaveBeenCalledWith(PATH, 'd'.repeat(40));
  });

  test('refuses a file at the commit whose blob id differs, or that was cut at the fetch cap, and keeps the miss', async () => {
    provider.fetchBlob.mockResolvedValue(null);
    provider.fetchFileAtRef.mockResolvedValue({ path: PATH, content: `${SOURCE}// edited\n`, truncated: false });
    expect(await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 1 })).toBeNull();
    expect(await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 1 })).toBeNull();
    expect(provider.fetchFileAtRef).toHaveBeenCalledTimes(1);

    clearSourceAtBlobCache();
    provider.fetchFileAtRef.mockResolvedValue({ path: PATH, content: SOURCE, truncated: true });
    expect(await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 1 })).toBeNull();
  });

  test('answers nothing for a project whose runs record no repository, or a run of another project', async () => {
    expect(await getSourceAtBlob(db as never, 2, { path: PATH, blob: BLOB, runId: 3 })).toBeNull();
    expect(createScmProvider).not.toHaveBeenCalled();

    provider.fetchBlob.mockResolvedValue(null);
    provider.fetchFileAtRef.mockResolvedValue({ path: PATH, content: SOURCE, truncated: false });
    // Run 3 belongs to project 2: project 1 reads the commit of its newest run that records a repository.
    await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB, runId: 3 });
    expect(provider.fetchFileAtRef).toHaveBeenCalledWith(PATH, COMMIT);
  });

  test('a provider failure is a miss, never an error', async () => {
    provider.fetchBlob.mockRejectedValue(new Error('network down'));
    expect(await getSourceAtBlob(db as never, 1, { path: PATH, blob: BLOB })).toBeNull();
  });
});
