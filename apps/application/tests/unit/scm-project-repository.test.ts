import { describe, test, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before importing the helpers.
delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;
const { normalizeGitUrl, repositoryUrlFromRemote, sameRepository } = await import('../../server/utils/scm/git-url');
const { isRepositoryPinnedInScope, pinProjectRepository, projectRepositoryFor, readProjectRepositoryUrl } =
  await import('../../server/utils/scm/project-repository');
const { createScmProvider } = await import('../../server/utils/scm');
const { INVALID_REPOSITORY_URL, updateProject } = await import('../../shared/handlers/projects');
const { PROBE_RUN_METADATA_KEY } = await import('../../shared/run-eligibility');
const { createUnfurlProvider } = await import('../../server/utils/unfurl');
const { encryptSecret, getEncryptionKey } = await import('../../server/utils/crypto');
const { detectProvider, extractKey } = await import('../../shared/link-detect');

const migrationsFolder = fileURLToPath(new URL('../../server/database/migrations', import.meta.url));
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder });
  await db.insert(schema.projects).values([
    { id: 1, name: 'Alpha', repositoryUrl: 'https://github.com/acme/shop' },
    { id: 2, name: 'Beta' },
  ]);
});

describe('a repository URL as a project pins it', () => {
  test('reads every remote form as https://host/owner/repo, with no credentials', () => {
    expect(repositoryUrlFromRemote('git@github.com:acme/shop.git')).toBe('https://github.com/acme/shop');
    expect(repositoryUrlFromRemote('https://gitlab-ci-token:secret@gitlab.com/group/sub/app.git/')).toBe(
      'https://gitlab.com/group/sub/app',
    );
    expect(repositoryUrlFromRemote('ssh://git@github.com:22/acme/shop.git')).toBe('https://github.com/acme/shop');
    expect(repositoryUrlFromRemote('https://github.com/acme/shop?tab=readme#top')).toBe('https://github.com/acme/shop');
    for (const bad of [null, '', '/srv/git/shop', 'file:///srv/git/shop', 'https://github.com/acme', 'not a url']) {
      expect(repositoryUrlFromRemote(bad)).toBeNull();
    }
  });

  test('normalizes a remote to an http or https URL, and nothing else', () => {
    expect(normalizeGitUrl('git@github.com:acme/shop.git')).toBe('https://github.com/acme/shop');
    expect(normalizeGitUrl('ssh://git@github.com:22/acme/shop.git')).toBe('https://github.com/acme/shop');
    expect(normalizeGitUrl('https://token:x@gitlab.example.com/acme/shop.git')).toBe(
      'https://gitlab.example.com/acme/shop',
    );
    for (const bad of ['javascript://github.com/%0aalert(1)', 'file:///srv/git/shop', 'not a url', null]) {
      expect(normalizeGitUrl(bad)).toBeNull();
    }
  });

  test('tells the same repository apart from another, whatever the form', () => {
    expect(sameRepository('git@github.com:Acme/Shop.git', 'https://github.com/acme/shop')).toBe(true);
    expect(sameRepository('https://github.com/acme/shop', 'https://github.com/acme/payments-private')).toBe(false);
    expect(sameRepository('https://github.com/acme/shop', 'https://gitlab.com/acme/shop')).toBe(false);
    expect(sameRepository(null, null)).toBe(false);
  });
});

describe('the pinned repository', () => {
  test('the first run that names a remote pins a project that has none, and later runs change nothing', async () => {
    await pinProjectRepository(db as never, 2, { scm: { remoteUrl: 'git@github.com:acme/api.git' } });
    expect(await readProjectRepositoryUrl(db as never, 2)).toBe('https://github.com/acme/api');

    await pinProjectRepository(db as never, 2, { scm: { remoteUrl: 'https://github.com/acme/payments-private' } });
    await pinProjectRepository(db as never, 1, { scm: { remoteUrl: 'https://github.com/acme/payments-private' } });
    expect(await readProjectRepositoryUrl(db as never, 2)).toBe('https://github.com/acme/api');
    expect(await readProjectRepositoryUrl(db as never, 1)).toBe('https://github.com/acme/shop');
  });

  test('a run with no remote, or a probe run, pins nothing', async () => {
    await pinProjectRepository(db as never, 2, { scm: { branch: 'main' } });
    await pinProjectRepository(db as never, 2, {
      [PROBE_RUN_METADATA_KEY]: true,
      scm: { remoteUrl: 'https://github.com/acme/api' },
    });
    expect(await readProjectRepositoryUrl(db as never, 2)).toBeNull();
  });

  test('SCM calls read the pinned repository only: a run naming another gets no provider', async () => {
    expect(await projectRepositoryFor(db as never, 1, 'git@github.com:acme/shop.git')).toBe(
      'https://github.com/acme/shop',
    );
    expect(await projectRepositoryFor(db as never, 1, 'https://github.com/acme/payments-private')).toBeNull();
    expect(await createScmProvider('https://github.com/acme/payments-private', db as never, 1)).toBeNull();
    expect(await createScmProvider('git@github.com:acme/shop.git', db as never, 1)).not.toBeNull();
    // A project with no pinned repository reads none.
    expect(await createScmProvider('https://github.com/acme/shop', db as never, 2)).toBeNull();
  });

  test('a link reads a repository with the instance token only when a readable project pins it', async () => {
    expect(await isRepositoryPinnedInScope(db as never, 'all', 'https://github.com/acme/shop')).toBe(true);
    expect(await isRepositoryPinnedInScope(db as never, new Set([1]), 'git@github.com:acme/shop.git')).toBe(true);
    expect(await isRepositoryPinnedInScope(db as never, new Set([2]), 'https://github.com/acme/shop')).toBe(false);
    expect(await isRepositoryPinnedInScope(db as never, new Set(), 'https://github.com/acme/shop')).toBe(false);
    expect(await isRepositoryPinnedInScope(db as never, 'all', 'https://github.com/acme/payments-private')).toBe(false);
  });

  test('a link is unfurled with the instance token only for a repository a readable project pins', async () => {
    vi.stubEnv('PIWI_SECRET_KEY', 'project-repository-test-secret-0123456789');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ title: 'PR', state: 'open' })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await db
        .insert(schema.appSettings)
        .values({ key: 'scm_token', value: { value: encryptSecret('ghp_instance', getEncryptionKey()) } });
      const authorization = async (url: string, readable: 'all' | Set<number>) => {
        fetchMock.mockClear();
        const provider = await createUnfurlProvider(url, db as never, readable);
        await provider!.unfurl(url, extractKey(url, detectProvider(url)));
        const headers = (fetchMock.mock.calls.at(-1) as unknown[] | undefined)?.[1] as {
          headers?: Record<string, string>;
        };
        return headers?.headers?.Authorization ?? null;
      };
      expect(await authorization('https://github.com/acme/shop/pull/7', new Set([1]))).toBe('Bearer ghp_instance');
      expect(await authorization('https://github.com/acme/shop/pull/7', new Set([2]))).toBeNull();
      expect(await authorization('https://github.com/acme/payments-private/pull/7', 'all')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  test('a project admin sets it in any remote form, clears it, and a non-repository is refused', async () => {
    // updateProject writes in a transaction, which needs a database on disk.
    const temp = await openTempDb();
    try {
      const tx = temp.db as never;
      await temp.db.insert(schema.projects).values([
        { id: 1, name: 'Alpha', repositoryUrl: 'https://github.com/acme/shop' },
        { id: 2, name: 'Beta' },
      ]);
      await updateProject(tx, 2, { repositoryUrl: 'git@github.com:acme/api.git' });
      expect(await readProjectRepositoryUrl(tx, 2)).toBe('https://github.com/acme/api');
      await updateProject(tx, 2, { repositoryUrl: '' });
      expect(await readProjectRepositoryUrl(tx, 2)).toBeNull();
      await expect(updateProject(tx, 2, { repositoryUrl: '/srv/git/api' })).rejects.toThrow(INVALID_REPOSITORY_URL);
      // Leaving the field out keeps it.
      await updateProject(tx, 1, { label: 'Shop' });
      expect(await readProjectRepositoryUrl(tx, 1)).toBe('https://github.com/acme/shop');
    } finally {
      await temp.close();
    }
  });
});

describe('the backfill migration', () => {
  test("pins each project to its latest run's remote, normalized and without credentials", async () => {
    const remotes: Record<number, string | null> = {
      1: 'https://gitlab-ci-token:glcbt-secret@gitlab.com/group/sub/app.git',
      2: 'git@github.com:acme/api.git',
      3: 'ssh://git@github.com/acme/ssh-remote.git/',
      4: '/srv/git/local-path',
      5: null,
    };
    await db.delete(schema.projects);
    for (const [id, remote] of Object.entries(remotes)) {
      await db.insert(schema.projects).values({ id: Number(id), name: `p${id}` });
      await db.insert(schema.testRuns).values([
        {
          projectId: Number(id),
          status: 'passed',
          startTime: new Date('2026-01-01'),
          metadata: { scm: { remoteUrl: 'https://github.com/acme/older-run' } },
        },
        {
          projectId: Number(id),
          status: 'passed',
          startTime: new Date('2026-02-01'),
          metadata: remote ? { scm: { remoteUrl: remote } } : { scm: { branch: 'main' } },
        },
      ]);
    }

    const file = readdirMigration('backfill_project_repository_url');
    for (const statement of file.split('--> statement-breakpoint')) await db.run(sql.raw(statement));

    const pinned = Object.fromEntries(
      (await db.select({ id: schema.projects.id, url: schema.projects.repositoryUrl }).from(schema.projects)).map(
        (row) => [row.id, row.url],
      ),
    );
    expect(pinned).toEqual({
      1: 'https://gitlab.com/group/sub/app',
      2: 'https://github.com/acme/api',
      3: 'https://github.com/acme/ssh-remote',
      4: null,
      // The latest run names no remote: the one before it does.
      5: 'https://github.com/acme/older-run',
    });
    // A project that has one keeps it.
    await db
      .update(schema.projects)
      .set({ repositoryUrl: 'https://github.com/acme/kept' })
      .where(eq(schema.projects.id, 2));
    for (const statement of file.split('--> statement-breakpoint')) await db.run(sql.raw(statement));
    expect(await readProjectRepositoryUrl(db as never, 2)).toBe('https://github.com/acme/kept');
  });
});

/** The SQL of the SQLite migration whose file name ends with `name`. */
function readdirMigration(name: string): string {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const entry = journal.entries.find((e) => e.tag.endsWith(name));
  if (!entry) throw new Error(`no migration named ${name}`);
  return readFileSync(`${migrationsFolder}/${entry.tag}.sql`, 'utf8');
}
