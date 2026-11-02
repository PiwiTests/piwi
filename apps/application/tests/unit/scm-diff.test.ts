import { afterEach, describe, expect, test, vi } from 'vitest';
import { diffFileFromPatch } from '@piwitests/core/diff-anchors';
import { BitbucketProvider } from '../../server/utils/scm/BitbucketProvider';
import { GitHubProvider } from '../../server/utils/scm/GitHubProvider';
import { GitLabProvider } from '../../server/utils/scm/GitLabProvider';
import { splitGitDiff, unquoteGitPath } from '../../server/utils/scm/diff-text';

/**
 * How each host provider reads a diff: the range it asks for, the files and
 * patches it keeps, the commits it lists and what it caches. Every request is
 * answered by a stubbed `fetch`; each test uses its own refs, since the
 * providers cache by ref.
 */

afterEach(() => vi.unstubAllGlobals());

type Route = (url: URL) => Response | null;

/** Stub `fetch` with routes tried in order; an unrouted URL answers 404. Returns the URLs asked. */
function stubFetch(...routes: Route[]): URL[] {
  const asked: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      asked.push(url);
      for (const route of routes) {
        const res = route(url);
        if (res) return res;
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return asked;
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const text = (body: string) => new Response(body, { status: 200 });

const FROM = '1'.repeat(40);
const TO = '2'.repeat(40);

const RAW_DIFF = [
  'diff --git a/src/cart.ts b/src/cart.ts',
  'index 1111111..2222222 100644',
  '--- a/src/cart.ts',
  '+++ b/src/cart.ts',
  '@@ -1,2 +1,2 @@',
  '-export const label = "Add to cart";',
  '+export const label = "Add to basket";',
  ' export const max = 3;',
  'diff --git a/src/old name.ts b/src/new name.ts',
  'similarity index 90%',
  'rename from src/old name.ts',
  'rename to src/new name.ts',
  'index 3333333..4444444 100644',
  '--- a/src/old name.ts\t',
  '+++ b/src/new name.ts\t',
  '@@ -4 +4 @@',
  '-a',
  '+b',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  'index 5555555..0000000',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'index 6666666..7777777 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

describe('splitGitDiff', () => {
  test('keeps each file’s hunks without its header lines, under its new path', () => {
    expect(splitGitDiff(RAW_DIFF)).toEqual([
      {
        path: 'src/cart.ts',
        hunks:
          '@@ -1,2 +1,2 @@\n-export const label = "Add to cart";\n+export const label = "Add to basket";\n export const max = 3;',
      },
      { path: 'src/new name.ts', hunks: '@@ -4 +4 @@\n-a\n+b' },
      { path: 'gone.ts', hunks: '@@ -1 +0,0 @@\n-bye' },
      { path: null, hunks: undefined },
    ]);
  });

  test('leaves out the last section when the text was cut short', () => {
    expect(splitGitDiff(RAW_DIFF, true).map((s) => s.path)).toEqual(['src/cart.ts', 'src/new name.ts', 'gone.ts']);
  });

  test('reads the paths git quotes', () => {
    expect(unquoteGitPath('"b/q\\"t.ts"')).toBe('b/q"t.ts');
    expect(unquoteGitPath('"b/\\303\\251t\\303\\251.ts"')).toBe('b/été.ts');
    expect(unquoteGitPath('"b/tab\\there.ts"')).toBe('b/tab\there.ts');
    expect(unquoteGitPath('b/plain.ts')).toBe('b/plain.ts');
    const [section] = splitGitDiff(
      'diff --git "a/q\\"t.ts" "b/q\\"t.ts"\n--- "a/q\\"t.ts"\n+++ "b/q\\"t.ts"\n@@ -1 +1 @@\n-1\n+2',
    );
    expect(section).toEqual({ path: 'q"t.ts', hunks: '@@ -1 +1 @@\n-1\n+2' });
  });
});

describe('Bitbucket diffs', () => {
  const bitbucket = () => new BitbucketProvider('acme', 'shop', 'tok');
  const diffstat = {
    values: [
      {
        status: 'modified',
        old: { path: 'src/cart.ts' },
        new: { path: 'src/cart.ts' },
        lines_added: 1,
        lines_removed: 1,
      },
      {
        status: 'renamed',
        old: { path: 'src/old name.ts' },
        new: { path: 'src/new name.ts' },
        lines_added: 1,
        lines_removed: 1,
      },
      { status: 'removed', old: { path: 'gone.ts' }, new: null, lines_added: 0, lines_removed: 1 },
      { status: 'modified', old: { path: 'logo.png' }, new: { path: 'logo.png' } },
    ],
  };
  const routes: Route[] = [
    (u) => (u.pathname.includes('/diffstat/') ? json(diffstat) : null),
    (u) => (u.pathname.includes('/diff/') ? text(RAW_DIFF) : null),
    (u) =>
      u.pathname.endsWith('/commits')
        ? json({
            values: [
              { hash: TO, message: 'Rename the cart label\n\nBody' },
              { hash: 'f'.repeat(40), message: 'Older' },
            ],
          })
        : null,
    (u) =>
      u.pathname.includes('/commit/')
        ? json({ hash: TO, message: 'Rename the cart label\n\nBody', author: { raw: 'Ada <ada@example.com>' } })
        : null,
  ];

  test('asks for the range with the changed commit first, as Bitbucket reads it', async () => {
    const asked = stubFetch(...routes);
    await bitbucket().fetchChanges(FROM, TO);
    const specs = asked.filter((u) => /\/diff(stat)?\//.test(u.pathname)).map((u) => u.pathname.split('/').pop());
    expect(specs).toEqual([`${TO}..${FROM}`, `${TO}..${FROM}`]);
  });

  test('keeps hunks only, so the shared parser reads the changed lines', async () => {
    stubFetch(...routes);
    const changes = (await bitbucket().fetchChanges(FROM, `${TO.slice(0, 39)}3`))!;
    const cart = changes.files.find((f) => f.filename === 'src/cart.ts')!;
    expect(cart.patch).toMatch(/^@@ -1,2 \+1,2 @@/);
    expect(diffFileFromPatch(cart.filename, cart.patch!).hunks[0]!.added).toEqual([
      { line: 1, text: 'export const label = "Add to basket";' },
    ]);
    const renamed = changes.files.find((f) => f.filename === 'src/new name.ts')!;
    expect(renamed.previousFilename).toBe('src/old name.ts');
    expect(renamed.patch).toBe('@@ -4 +4 @@\n-a\n+b');
    expect(changes.files.find((f) => f.filename === 'gone.ts')!.patch).toBe('@@ -1 +0,0 @@\n-bye');
    expect(changes.files.find((f) => f.filename === 'logo.png')!.patch).toBeUndefined();
    expect(changes.commits.map((c) => c.message)).toEqual(['Older', 'Rename the cart label']);
  });

  test('diffs one commit by its own spec, against its first parent, with its message', async () => {
    const asked = stubFetch(...routes);
    const diff = (await bitbucket().fetchCommitDiff(TO))!;
    const specs = asked.filter((u) => /\/diff(stat)?\//.test(u.pathname)).map((u) => u.pathname.split('/').pop());
    expect(specs).toEqual([TO, TO]);
    expect(diff.files).toHaveLength(4);
    expect(diff.commits).toEqual([
      { sha: TO.slice(0, 7), message: 'Rename the cart label', fullMessage: 'Rename the cart label\n\nBody' },
    ]);
  });
});

describe('GitHub diffs', () => {
  test('lists the commits the compare endpoint gives, oldest first, in one request', async () => {
    const asked = stubFetch((u) =>
      u.pathname.includes('/compare/')
        ? json({
            commits: [
              { sha: 'a'.repeat(40), commit: { message: 'Oldest' } },
              { sha: 'b'.repeat(40), commit: { message: 'Newest\n\nBody' } },
            ],
            files: [
              {
                filename: 'src/new.ts',
                previous_filename: 'src/old.ts',
                status: 'renamed',
                additions: 0,
                deletions: 0,
              },
            ],
          })
        : null,
    );
    const changes = (await new GitHubProvider('acme/shop', 'tok').fetchChanges(FROM, '4'.repeat(40)))!;
    expect(asked).toHaveLength(1);
    expect(changes.commits.map((c) => c.message)).toEqual(['Oldest', 'Newest']);
    expect(changes.files[0]!.previousFilename).toBe('src/old.ts');
  });

  test('reads up to 300 files of a commit, flags more, and gives its message', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'added',
      additions: 1,
      deletions: 0,
    }));
    stubFetch((u) =>
      u.pathname.includes('/commits/')
        ? json(
            { sha: TO, commit: { message: 'Big change\n\nBody' }, files },
            { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } },
          )
        : null,
    );
    const diff = (await new GitHubProvider('acme/shop', 'tok').fetchCommitDiff('5'.repeat(40)))!;
    expect(diff.files).toHaveLength(300);
    expect(diff.filesTruncated).toBe(true);
    expect(diff.commits[0]).toEqual({ sha: TO.slice(0, 7), message: 'Big change', fullMessage: 'Big change\n\nBody' });
  });

  test('throws the host’s message when it refuses a commit', async () => {
    stubFetch(() => json({ message: 'No commit found for SHA' }, { status: 422 }));
    await expect(new GitHubProvider('acme/shop', 'tok').fetchCommitDiff('6'.repeat(40))).rejects.toThrow(
      /No commit found for SHA/,
    );
  });

  test('pages the commit list past 100', async () => {
    const asked = stubFetch((u) => {
      if (!u.pathname.endsWith('/commits')) return null;
      const page = Number(u.searchParams.get('page'));
      const count = page === 1 ? 100 : 30;
      return json(
        Array.from({ length: count }, (_, i) => ({
          sha: `${page}${String(i).padStart(39, '0')}`,
          commit: { message: `c${page}-${i}`, author: { name: 'Ada', date: '2026-01-01' } },
        })),
      );
    });
    const commits = await new GitHubProvider('acme/shop', 'tok').listCommits(150, 'paging');
    expect(commits).toHaveLength(130);
    expect(asked.map((u) => u.searchParams.get('per_page'))).toEqual(['100', '100']);
  });

  test('keeps a missing file as an answer, and asks again after a refusal', async () => {
    let status = 403;
    const asked = stubFetch((u) => (u.pathname.includes('/contents/') ? new Response('', { status }) : null));
    const gh = new GitHubProvider('acme/shop', 'tok');
    expect(await gh.fetchFileAtRef('src/a.ts', 'cache-check')).toBeNull();
    expect(await gh.fetchFileAtRef('src/a.ts', 'cache-check')).toBeNull();
    expect(asked).toHaveLength(2);
    status = 404;
    await gh.fetchFileAtRef('src/a.ts', 'cache-check');
    await gh.fetchFileAtRef('src/a.ts', 'cache-check');
    expect(asked).toHaveLength(3);
  });
});

describe('GitLab diffs', () => {
  test('pages a commit’s diff, keeps renamed files’ old path and gives the commit’s message', async () => {
    const diffItem = (i: number) => ({
      old_path: `old${i}.ts`,
      new_path: `f${i}.ts`,
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      new_file: false,
      deleted_file: false,
      renamed_file: i === 0,
    });
    const asked = stubFetch((u) => {
      if (u.pathname.endsWith('/diff')) {
        const page = Number(u.searchParams.get('page'));
        const items = Array.from({ length: page === 1 ? 100 : 20 }, (_, i) => diffItem((page - 1) * 100 + i));
        return json(items, { headers: { 'x-next-page': page === 1 ? '2' : '' } });
      }
      if (u.pathname.includes('/repository/commits/')) return json({ id: TO, message: 'Rename\n\nBody' });
      return null;
    });
    const diff = (await new GitLabProvider('gitlab.com', 'acme/shop', 'tok').fetchCommitDiff('7'.repeat(40)))!;
    expect(asked.filter((u) => u.pathname.endsWith('/diff')).map((u) => u.searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
    expect(diff.files).toHaveLength(120);
    expect(diff.filesTruncated).toBe(false);
    expect(diff.files[0]).toMatchObject({ filename: 'f0.ts', previousFilename: 'old0.ts', additions: 1, deletions: 1 });
    expect(diff.commits[0]?.message).toBe('Rename');
  });
});
