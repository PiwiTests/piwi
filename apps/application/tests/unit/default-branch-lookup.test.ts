import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const scm = vi.hoisted(() => {
  const getDefaultBranch = vi.fn(async (): Promise<string | null> => null);
  return { getDefaultBranch, createScmProvider: vi.fn(async () => ({ getDefaultBranch })) };
});
vi.mock('../../server/utils/scm/index', () => ({ createScmProvider: scm.createScmProvider }));

const { resolveDefaultBranch } = await import('../../server/utils/scm/default-branch');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let project: { id: number; defaultBranch: string | null };

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [row] = await db.insert(schema.projects).values({ name: 'shop' }).returning();
  project = { id: row!.id, defaultBranch: null };
  scm.createScmProvider.mockClear();
  scm.getDefaultBranch.mockReset();
  scm.getDefaultBranch.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The lookups are remembered per project and repository, so each test has a repository of its own.
const runOf = (repo: string) => ({ scm: { remoteUrl: `https://github.com/acme/${repo}.git` }, defaultBranch: 'trunk' });

describe('resolveDefaultBranch provider lookups', () => {
  test('asks the provider once for runs that finish together, and not again for ten minutes after it found none', async () => {
    const run = runOf('no-access');
    const branches = await Promise.all([1, 2, 3].map(() => resolveDefaultBranch(db as never, project, run)));
    expect(branches).toEqual(['trunk', 'trunk', 'trunk']);
    expect(scm.getDefaultBranch).toHaveBeenCalledTimes(1);

    expect(await resolveDefaultBranch(db as never, project, run)).toBe('trunk');
    expect(scm.getDefaultBranch).toHaveBeenCalledTimes(1);

    const later = Date.now() + 10 * 60 * 1000 + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect(await resolveDefaultBranch(db as never, project, run)).toBe('trunk');
    expect(scm.getDefaultBranch).toHaveBeenCalledTimes(2);
  });

  test('remembers a provider that cannot be built as a failed lookup', async () => {
    scm.createScmProvider.mockRejectedValueOnce(new Error('no token'));
    const run = runOf('no-token');
    expect(await resolveDefaultBranch(db as never, project, run)).toBe('trunk');
    expect(await resolveDefaultBranch(db as never, project, run)).toBe('trunk');
    expect(scm.createScmProvider).toHaveBeenCalledTimes(1);
  });

  test('stores a found branch on the project and keeps no failure for it', async () => {
    scm.getDefaultBranch.mockResolvedValue('develop');
    const run = runOf('found');
    expect(await resolveDefaultBranch(db as never, project, run)).toBe('develop');
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, project.id));
    expect(row!.defaultBranch).toBe('develop');

    // A caller still holding the project as read before the write asks again.
    expect(await resolveDefaultBranch(db as never, project, run)).toBe('develop');
    expect(scm.getDefaultBranch).toHaveBeenCalledTimes(2);
  });
});
