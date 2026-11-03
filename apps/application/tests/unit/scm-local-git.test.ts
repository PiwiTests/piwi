import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { GitHubProvider } from '../../server/utils/scm/GitHubProvider';
import { LocalGitProvider, localGitProvider, remoteKey } from '../../server/utils/scm/local-git';
import { desktopLinkedFolder } from '../../server/utils/desktop-links';
import { encryptSecret, getEncryptionKey } from '../../server/utils/crypto';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the SCM index (which imports the barrel) loads.
delete process.env.PIWI_DATABASE_URL;
const { createScmProvider } = await import('../../server/utils/scm');
const { getSourceAtBlob, clearSourceAtBlobCache } = await import('../../server/utils/source-at-blob');

const REPO_URL = 'https://github.com/acme/shop';
const DESKTOP_TOKEN = 'pd_local_git_test';
const PROJECT_ID = 7;

let home: string;
let repo: string;
const sha: Record<'first' | 'second' | 'third', string> = { first: '', second: '', third: '' };
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, token: process.env.PIWI_DESKTOP_TOKEN };

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
}

function writeDiscoveryFile(body: unknown) {
  mkdirSync(join(home, '.piwi'), { recursive: true });
  writeFileSync(join(home, '.piwi', 'desktop.json'), JSON.stringify(body));
}

function hosted() {
  return new GitHubProvider('acme/shop', null);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'piwi-local-git-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = join(home, 'shop');
  mkdirSync(join(repo, 'e2e'), { recursive: true });
  git('init', '--quiet', '--initial-branch=main');

  writeFileSync(join(repo, 'README.md'), 'shop\n');
  writeFileSync(join(repo, 'e2e', 'cart.spec.ts'), "test('adds to cart', () => {});\n");
  writeFileSync(join(repo, 'old-name.ts'), 'export const name = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Initial commit');
  sha.first = git('rev-parse', 'HEAD');

  writeFileSync(join(repo, 'README.md'), 'shop\nnow with a cart\n');
  writeFileSync(join(repo, 'notes.md'), 'temporary\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'Describe the cart\n\nWith a body that is not the subject.');
  sha.second = git('rev-parse', 'HEAD');

  unlinkSync(join(repo, 'notes.md'));
  renameSync(join(repo, 'old-name.ts'), join(repo, 'new-name.ts'));
  writeFileSync(join(repo, 'e2e', 'checkout.spec.ts'), "test('pays', () => {});\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'Rename and add checkout');
  sha.third = git('rev-parse', 'HEAD');

  git('branch', 'feature/pay', sha.second);
  git('remote', 'add', 'origin', 'git@github.com:Acme/Shop.git');
  // The same repository as two other hosts would name it: on Bitbucket's SSH
  // alias, and on a host Piwi has no client for.
  git('remote', 'add', 'bitbucket', 'git@ssh.bitbucket.org:acme/shop.git');
  git('remote', 'add', 'internal', 'git@git.example.internal:acme/shop.git');
  git('update-ref', 'refs/remotes/origin/main', sha.second);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
});

afterAll(() => {
  for (const [key, value] of [
    ['HOME', saved.HOME],
    ['USERPROFILE', saved.USERPROFILE],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.PIWI_DESKTOP_TOKEN = DESKTOP_TOKEN;
  // The tests link a subfolder: the clone is found from the folder up.
  writeDiscoveryFile({
    url: 'http://127.0.0.1:3000',
    token: DESKTOP_TOKEN,
    projects: [{ id: PROJECT_ID, path: join(repo, 'e2e') }],
  });
});

afterEach(() => {
  if (saved.token === undefined) delete process.env.PIWI_DESKTOP_TOKEN;
  else process.env.PIWI_DESKTOP_TOKEN = saved.token;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function provider(): Promise<LocalGitProvider> {
  const local = await localGitProvider(PROJECT_ID, REPO_URL, hosted());
  expect(local).toBeInstanceOf(LocalGitProvider);
  return local!;
}

describe('remoteKey', () => {
  test('names one repository the same in every remote URL form', () => {
    for (const url of [
      'git@github.com:Acme/Shop.git',
      'https://github.com/acme/shop',
      'https://user:secret@github.com/acme/shop.git/',
      'ssh://git@github.com/acme/shop.git',
    ]) {
      expect(remoteKey(url), url).toBe('github.com/acme/shop');
    }
  });

  test('names a repository on a Git host’s SSH alias as on the host', () => {
    expect(remoteKey('git@ssh.bitbucket.org:Acme/Shop.git')).toBe('bitbucket.org/acme/shop');
    expect(remoteKey('ssh://git@altssh.bitbucket.org:443/acme/shop.git')).toBe('bitbucket.org/acme/shop');
    expect(remoteKey('ssh://git@ssh.github.com:443/acme/shop.git')).toBe('github.com/acme/shop');
  });

  test('a local path names no repository', () => {
    expect(remoteKey('/srv/git/shop.git')).toBeNull();
    expect(remoteKey('../shop')).toBeNull();
  });
});

describe('desktopLinkedFolder', () => {
  test('reads the folder the desktop app links to the project', () => {
    expect(desktopLinkedFolder(PROJECT_ID)).toBe(join(repo, 'e2e'));
    expect(desktopLinkedFolder(PROJECT_ID + 1)).toBeNull();
  });

  test('ignores a discovery file published for another server', () => {
    writeDiscoveryFile({ token: 'pd_other', projects: [{ id: PROJECT_ID, path: repo }] });
    expect(desktopLinkedFolder(PROJECT_ID)).toBeNull();
  });

  test('is null outside the desktop app', () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    expect(desktopLinkedFolder(PROJECT_ID)).toBeNull();
  });
});

describe('localGitProvider', () => {
  test('is null when no remote of the clone is the repository', async () => {
    expect(await localGitProvider(PROJECT_ID, 'https://github.com/acme/other', hosted())).toBeNull();
  });

  test('takes the host and links from the hosted provider', async () => {
    const local = await provider();
    expect(local.provider).toBe('github');
    expect(local.commitUrl(sha.first)).toBe(`https://github.com/acme/shop/commit/${sha.first}`);
  });
});

describe('localGitProvider for a host Piwi has no client for', () => {
  const INTERNAL_URL = 'https://git.example.internal/acme/shop';

  test('reads the clone alone, with no host and no links', async () => {
    const local = await localGitProvider(PROJECT_ID, INTERNAL_URL, null);
    expect(local).toBeInstanceOf(LocalGitProvider);
    expect(local!.provider).toBeNull();
    expect(local!.commitUrl(sha.first)).toBeNull();
    expect(await local!.fetchBlob(git('rev-parse', `${sha.first}:README.md`))).toBe('shop\n');
    expect((await local!.listCommits(10)).map((c) => c.sha)).toEqual([sha.third, sha.second, sha.first]);
  });

  test('finds nothing the clone does not have, and writes nothing', async () => {
    const local = (await localGitProvider(PROJECT_ID, INTERNAL_URL, null))!;
    expect(await local.fetchBlob('e'.repeat(40))).toBeNull();
    expect(await local.fetchChanges(sha.first, 'f'.repeat(40))).toBeNull();
    expect(await local.listCommits(10, 'release/9')).toEqual([]);
    expect(await local.probeError('release/9')).not.toMatch(/token/);
    await expect(local.createBranch('heal', sha.first)).rejects.toThrow(/does not support/);
  });

  test('reads a remote on a Git host’s SSH alias for the host’s repository', async () => {
    const local = await localGitProvider(PROJECT_ID, 'https://bitbucket.org/acme/shop', null);
    expect(local).toBeInstanceOf(LocalGitProvider);
    expect(await local!.fetchBlob(git('rev-parse', `${sha.second}:README.md`))).toBe('shop\nnow with a cart\n');
  });
});

describe('LocalGitProvider reads', () => {
  test('lists the default branch, local and remote-tracking together', async () => {
    const commits = await (await provider()).listCommits(10);
    expect(commits.map((c) => c.sha)).toEqual([sha.third, sha.second, sha.first]);
    expect(commits[1]).toEqual({
      sha: sha.second,
      shortSha: sha.second.slice(0, 7),
      message: 'Describe the cart',
      author: 'Ada Lovelace',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test('lists a named branch, and asks the host for one the clone does not have', async () => {
    const local = await provider();
    expect((await local.listCommits(10, 'feature/pay')).map((c) => c.sha)).toEqual([sha.second, sha.first]);

    const hostCommits = vi.spyOn(GitHubProvider.prototype, 'listCommits').mockResolvedValue([]);
    expect(await local.listCommits(10, 'release/9')).toEqual([]);
    expect(hostCommits).toHaveBeenCalledWith(10, 'release/9');
  });

  test('lists branches once each, local and remote-tracking', async () => {
    const branches = await (await provider()).listBranches();
    expect([...branches].sort()).toEqual(['feature/pay', 'main']);
  });

  test('diffs a range from the merge base, with the commits oldest first and their full messages', async () => {
    const changes = await (await provider()).fetchChanges(sha.first, sha.third);
    expect(changes?.commits).toEqual([
      {
        sha: sha.second.slice(0, 7),
        message: 'Describe the cart',
        fullMessage: 'Describe the cart\n\nWith a body that is not the subject.',
      },
      { sha: sha.third.slice(0, 7), message: 'Rename and add checkout', fullMessage: 'Rename and add checkout' },
    ]);
    const byName = Object.fromEntries((changes?.files ?? []).map((f) => [f.filename, f]));
    expect(Object.keys(byName).sort()).toEqual(['README.md', 'e2e/checkout.spec.ts', 'new-name.ts']);
    expect(byName['README.md']).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(byName['README.md']!.patch).toMatch(/^@@ -1 \+1,2 @@\n shop\n\+now with a cart$/);
    expect(byName['e2e/checkout.spec.ts']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(byName['new-name.ts']).toMatchObject({
      status: 'renamed',
      previousFilename: 'old-name.ts',
      additions: 0,
      deletions: 0,
      patch: undefined,
    });
    expect(changes?.filesTruncated).toBe(false);
    // Each file carries its blob id at the head, the one git stores.
    for (const name of Object.keys(byName)) expect(byName[name]!.blob).toBe(git('rev-parse', `${sha.third}:${name}`));
  });

  test('diffs a commit against its parent, and a root commit against nothing', async () => {
    const local = await provider();
    const third = await local.fetchCommitDiff(sha.third);
    expect(third?.files.map((f) => [f.filename, f.status]).sort()).toEqual([
      ['e2e/checkout.spec.ts', 'added'],
      ['new-name.ts', 'renamed'],
      ['notes.md', 'removed'],
    ]);
    // A removed file has no blob at the head.
    expect(third?.files.find((f) => f.filename === 'notes.md')?.blob).toBeUndefined();
    expect(third?.commits).toEqual([
      { sha: sha.third.slice(0, 7), message: 'Rename and add checkout', fullMessage: 'Rename and add checkout' },
    ]);
    const root = await local.fetchCommitDiff(sha.first);
    expect(root?.files.map((f) => f.status)).toEqual(['added', 'added', 'added']);
  });

  test('keeps the patch of a file whose name git quotes', async () => {
    const other = mkdtempSync(join(home, 'quoted-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8', env: gitEnv }).trim();
    run('init', '--quiet', '--initial-branch=main');
    for (const name of ['q"t.ts', 'a b.ts', 'é.ts']) writeFileSync(join(other, name), 'one\n');
    run('add', '.');
    run('commit', '--quiet', '-m', 'First');
    const first = run('rev-parse', 'HEAD');
    for (const name of ['q"t.ts', 'a b.ts', 'é.ts']) writeFileSync(join(other, name), 'two\n');
    run('commit', '--quiet', '-am', 'Second');
    const second = run('rev-parse', 'HEAD');
    const changes = await new LocalGitProvider(other, 'origin', hosted()).fetchChanges(first, second);
    expect(changes?.files.map((f) => [f.filename, f.patch])).toEqual([
      ['a b.ts', '@@ -1 +1 @@\n-one\n+two'],
      ['q"t.ts', '@@ -1 +1 @@\n-one\n+two'],
      ['é.ts', '@@ -1 +1 @@\n-one\n+two'],
    ]);
  });

  test('keeps each file’s patch when one file of the diff becomes a symlink', async () => {
    const other = mkdtempSync(join(home, 'typechange-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8', env: gitEnv }).trim();
    run('init', '--quiet', '--initial-branch=main');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(other, name), 'one\n');
    run('add', '.');
    run('commit', '--quiet', '-m', 'First');
    unlinkSync(join(other, 'a.txt'));
    symlinkSync('b.txt', join(other, 'a.txt'));
    for (const name of ['b.txt', 'c.txt']) writeFileSync(join(other, name), 'two\n');
    run('add', '-A');
    run('commit', '--quiet', '-m', 'Second');
    const diff = await new LocalGitProvider(other, 'origin', hosted()).fetchCommitDiff(run('rev-parse', 'HEAD'));
    const patches = Object.fromEntries((diff?.files ?? []).map((f) => [f.filename, f.patch]));
    expect(patches['b.txt']).toBe('@@ -1 +1 @@\n-one\n+two');
    expect(patches['c.txt']).toBe('@@ -1 +1 @@\n-one\n+two');
  });

  test('reads a blob by its id, and asks the host for one the clone does not have', async () => {
    const local = await provider();
    expect(await local.fetchBlob(git('rev-parse', `${sha.second}:README.md`))).toBe('shop\nnow with a cart\n');
    const missing = 'e'.repeat(40);
    const hostBlob = vi.spyOn(GitHubProvider.prototype, 'fetchBlob').mockResolvedValue(null);
    expect(await local.fetchBlob(missing)).toBeNull();
    expect(hostBlob).toHaveBeenCalledWith(missing);
    expect(await local.fetchBlob('not-a-blob')).toBeNull();
  });

  test('asks the host for a range the clone does not have', async () => {
    const missing = 'f'.repeat(40);
    const hostChanges = vi.spyOn(GitHubProvider.prototype, 'fetchChanges').mockResolvedValue(null);
    expect(await (await provider()).fetchChanges(sha.first, missing)).toBeNull();
    expect(hostChanges).toHaveBeenCalledWith(sha.first, missing);
  });

  test('reads files, the tree, the author and the default branch at a commit', async () => {
    const local = await provider();
    expect(await local.fetchFileAtRef('/README.md', sha.first)).toEqual({
      path: 'README.md',
      content: 'shop\n',
      truncated: false,
    });
    const hostFile = vi.spyOn(GitHubProvider.prototype, 'fetchFileAtRef');
    expect(await local.fetchFileAtRef('notes.md', sha.first)).toBeNull();
    expect(hostFile).not.toHaveBeenCalled();

    expect((await local.fetchTree(sha.first))?.sort()).toEqual(['README.md', 'e2e/cart.spec.ts', 'old-name.ts']);
    expect(await local.getCommitAuthor(sha.second)).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(await local.getDefaultBranch()).toBe('main');
  });

  test('refuses a revision that could pass as a git option', async () => {
    const local = await provider();
    expect(await local.fetchChanges('--output=/tmp/x', sha.third)).toBeNull();
    expect(await local.fetchFileAtRef('README.md', '--help')).toBeNull();
  });
});

describe('createScmProvider on the desktop app', () => {
  type Db = ReturnType<typeof drizzle<typeof schema>>;
  let db: Db;

  beforeEach(async () => {
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: PROJECT_ID, name: 'shop', repositoryUrl: REPO_URL });
  });

  test('reads a linked clone with local git when no token is set', async () => {
    expect(await createScmProvider(REPO_URL, db, PROJECT_ID)).toBeInstanceOf(LocalGitProvider);
  });

  test('keeps the host when a token is set', async () => {
    vi.stubEnv('PIWI_SECRET_KEY', 'local-git-test-secret-key-0123456789abcdef');
    await db
      .update(schema.projects)
      .set({ scmToken: encryptSecret('ghp_test', getEncryptionKey()) })
      .where(eq(schema.projects.id, PROJECT_ID));
    expect(await createScmProvider(REPO_URL, db, PROJECT_ID)).toBeInstanceOf(GitHubProvider);
  });

  test('keeps the host outside the desktop app', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    expect(await createScmProvider(REPO_URL, db, PROJECT_ID)).toBeInstanceOf(GitHubProvider);
  });

  test('reads a linked clone of a repository on a Git host’s SSH alias', async () => {
    await db
      .update(schema.projects)
      .set({ repositoryUrl: 'https://bitbucket.org/acme/shop' })
      .where(eq(schema.projects.id, PROJECT_ID));
    const local = await createScmProvider('git@ssh.bitbucket.org:acme/shop.git', db, PROJECT_ID);
    expect(local).toBeInstanceOf(LocalGitProvider);
    expect(local!.provider).toBe('bitbucket');
  });

  describe('for a host Piwi has no client for', () => {
    const INTERNAL_REMOTE = 'git@git.example.internal:acme/shop.git';

    beforeEach(async () => {
      clearSourceAtBlobCache();
      await db
        .update(schema.projects)
        .set({ repositoryUrl: 'https://git.example.internal/acme/shop' })
        .where(eq(schema.projects.id, PROJECT_ID));
      await db.insert(schema.testRuns).values({
        id: 1,
        projectId: PROJECT_ID,
        status: 'passed',
        startTime: new Date(),
        metadata: { scm: { remoteUrl: INTERNAL_REMOTE, commit: sha.third } },
      });
    });

    test('reads the linked clone, with or without a token', async () => {
      expect(await createScmProvider(INTERNAL_REMOTE, db, PROJECT_ID)).toBeInstanceOf(LocalGitProvider);
      vi.stubEnv('PIWI_SECRET_KEY', 'local-git-test-secret-key-0123456789abcdef');
      await db
        .update(schema.projects)
        .set({ scmToken: encryptSecret('token', getEncryptionKey()) })
        .where(eq(schema.projects.id, PROJECT_ID));
      expect(await createScmProvider(INTERNAL_REMOTE, db, PROJECT_ID)).toBeInstanceOf(LocalGitProvider);
    });

    test('serves a file at a blob from the linked clone', async () => {
      const blob = git('rev-parse', `${sha.third}:README.md`);
      expect(await getSourceAtBlob(db, PROJECT_ID, { path: 'README.md', blob })).toEqual({
        path: 'README.md',
        blob,
        content: 'shop\nnow with a cart\n',
      });
    });

    test('has no provider outside the desktop app', async () => {
      delete process.env.PIWI_DESKTOP_TOKEN;
      expect(await createScmProvider(INTERNAL_REMOTE, db, PROJECT_ID)).toBeNull();
      expect(await getSourceAtBlob(db, PROJECT_ID, { path: 'README.md', blob: 'a'.repeat(40) })).toBeNull();
    });
  });
});
