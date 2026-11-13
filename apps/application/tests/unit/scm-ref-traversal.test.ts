import { describe, test, expect, vi, afterEach } from 'vitest';
import { isValidGitRef, encodeGitRef, encodePathSegments } from '../../server/utils/scm/refs';
import { GitHubProvider } from '../../server/utils/scm/GitHubProvider';
import { GitLabProvider } from '../../server/utils/scm/GitLabProvider';
import { BitbucketProvider } from '../../server/utils/scm/BitbucketProvider';

describe('isValidGitRef', () => {
  test('accepts plausible SHAs, branches and tags', () => {
    for (const ref of [
      'main',
      'v1.2.3',
      'release/1.2',
      'feature/add-thing',
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
      'a1b2c3d',
    ]) {
      expect(isValidGitRef(ref)).toBe(true);
    }
  });

  test('rejects traversal and every out-of-repo trick', () => {
    for (const ref of [
      '../../../otherorg/secret/compare/v1',
      '..',
      'a/../../b',
      '/etc/passwd',
      'main/',
      '-rf',
      '.hidden',
      'feature branch',
      'a\tb',
      'head~1', // rev syntax is not a plain ref at the boundary
      'a?b',
      'a#b',
      'a:b',
      '',
    ]) {
      expect(isValidGitRef(ref)).toBe(false);
    }
    expect(isValidGitRef(123 as unknown as string)).toBe(false);
  });
});

describe('encoding helpers preserve slashes, escape the rest', () => {
  test('encodeGitRef keeps branch slashes but escapes specials', () => {
    expect(encodeGitRef('feature/foo')).toBe('feature/foo');
    expect(encodeGitRef('a b')).toBe('a%20b');
  });
  test('encodePathSegments keeps path slashes', () => {
    expect(encodePathSegments('src/app/main.ts')).toBe('src/app/main.ts');
    expect(encodePathSegments('a b/c#d.ts')).toBe('a%20b/c%23d.ts');
  });
});

describe('SCM providers reject a traversal ref before it reaches an API URL', () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('[]', { status: 200 }));
  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
  });

  const TRAVERSAL = '../../../otherorg/secret/compare/v1';

  const providers: Array<
    [
      string,
      { fetchChanges: (a: string, b: string) => Promise<unknown>; fetchCommitDiff: (s: string) => Promise<unknown> },
    ]
  > = [
    ['github', new GitHubProvider('acme/app', 'tok')],
    ['gitlab', new GitLabProvider('gitlab.com', 'acme/app', 'tok')],
    ['bitbucket', new BitbucketProvider('acme', 'app', 'tok')],
  ];

  for (const [name, provider] of providers) {
    test(`${name}: fetchChanges with a traversal base makes no request and returns null`, async () => {
      vi.stubGlobal('fetch', fetchMock);
      const result = await provider.fetchChanges(TRAVERSAL, 'main');
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test(`${name}: fetchCommitDiff with a traversal sha makes no request and returns null`, async () => {
      vi.stubGlobal('fetch', fetchMock);
      const result = await provider.fetchCommitDiff(TRAVERSAL).catch(() => null);
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  test('a legit ref never produces a URL that escapes the repo path', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const gh = new GitHubProvider('acme/app', 'tok');
    await gh.fetchChanges('main', 'feature/x').catch(() => null);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain('/repos/acme/app/compare/');
      expect(u).not.toContain('/otherorg/');
    }
  });
});

describe('GitHub fetchChanges reads the compare endpoint once', () => {
  afterEach(() => vi.unstubAllGlobals());

  const filesPage = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0 }));

  test('asks with no paging parameter and keeps every file the endpoint lists', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ commits: [{ sha: 'abc1234', commit: { message: 'one' } }], files: filesPage(145) }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const gh = new GitHubProvider('acme/app', 'tok');
    const changes = await gh.fetchChanges('main', 'one-request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.has('per_page')).toBe(false);
    expect(changes!.files).toHaveLength(145);
    expect(changes!.filesTruncated).toBe(false);
  });

  test('flags truncation when the endpoint lists its 300-file maximum', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ commits: [], files: filesPage(300) }), { status: 200 })),
    );
    const gh = new GitHubProvider('acme/app', 'tok');
    const changes = await gh.fetchChanges('main', 'all-files');
    const { MAX_SCM_FILES_TOTAL } = await import('../../server/utils/scm/ScmProvider');
    expect(changes!.files).toHaveLength(MAX_SCM_FILES_TOTAL);
    expect(changes!.filesTruncated).toBe(true);
  });
});
