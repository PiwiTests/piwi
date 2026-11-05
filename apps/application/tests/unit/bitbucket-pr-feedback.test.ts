import { afterEach, describe, expect, test, vi } from 'vitest';
import { BitbucketProvider, bitbucketCommentMarker } from '../../server/utils/scm/BitbucketProvider';
import { PR_COMMENT_MARKER } from '#shared/pr-feedback';
import { HEAL_BRANCH_VERIFIED_MARKER } from '#shared/heal-pr';

const API = 'https://api.bitbucket.org/2.0/repositories/acme/shop';
const HIDDEN = '[//]: # (piwi-dashboard:run-summary)';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Answers each request with the next response, and records what was sent. */
function mockFetch(responses: Array<{ status?: number; json?: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const next = responses.shift() ?? { status: 500 };
      return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = (token: string | null = 'bb-token') => new BitbucketProvider('acme', 'shop', token);

describe('the marker on Bitbucket', () => {
  test('becomes a Markdown link reference, which renders as nothing', () => {
    expect(bitbucketCommentMarker(PR_COMMENT_MARKER)).toBe(HIDDEN);
    expect(bitbucketCommentMarker(HEAL_BRANCH_VERIFIED_MARKER)).toBe(
      '[//]: # (piwi-dashboard:auto-heal-branch-verified)',
    );
  });

  test('stays as it is when it is not an HTML comment', () => {
    expect(bitbucketCommentMarker('piwi')).toBe('piwi');
  });
});

describe('the summary comment', () => {
  const body = `${PR_COMMENT_MARKER}\n\n### Piwi — shop`;

  test('is created when the pull request has none, with the hidden marker', async () => {
    const calls = mockFetch([{ json: { values: [{ id: 1, content: { raw: 'LGTM' } }] } }, { json: { id: 77 } }]);
    expect(await provider().postPullRequestComment(12, PR_COMMENT_MARKER, body)).toEqual({ id: '77' });
    expect(calls[0]).toMatchObject({ url: `${API}/pullrequests/12/comments?pagelen=100`, method: 'GET' });
    expect(calls[1]).toEqual({
      url: `${API}/pullrequests/12/comments`,
      method: 'POST',
      body: { content: { raw: `${HIDDEN}\n\n### Piwi — shop` } },
    });
  });

  test('edits the comment that carries the marker, found on a later page', async () => {
    const calls = mockFetch([
      { json: { values: [{ id: 1, content: { raw: 'first' } }], next: `${API}/pullrequests/12/comments?page=2` } },
      {
        json: {
          values: [
            { id: 5, deleted: true, content: { raw: HIDDEN } },
            { id: 6, inline: { path: 'a.ts' }, content: { raw: `quoting ${HIDDEN}` } },
            { id: 7, parent: { id: 1 }, content: { raw: `replying ${HIDDEN}` } },
            { id: 9, content: { raw: `${HIDDEN}\n\nold` } },
          ],
        },
      },
      { json: { id: 9 } },
    ]);
    expect(await provider().postPullRequestComment(12, PR_COMMENT_MARKER, body)).toEqual({ id: '9' });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${API}/pullrequests/12/comments?pagelen=100`],
      ['GET', `${API}/pullrequests/12/comments?page=2`],
      ['PUT', `${API}/pullrequests/12/comments/9`],
    ]);
    expect(calls[2]!.body).toEqual({ content: { raw: `${HIDDEN}\n\n### Piwi — shop` } });
  });

  test('is not posted when the comments cannot all be read, so it is never duplicated', async () => {
    const calls = mockFetch([
      { json: { values: [], next: `${API}/pullrequests/12/comments?page=2` } },
      { status: 500 },
    ]);
    expect(await provider().postPullRequestComment(12, PR_COMMENT_MARKER, body)).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
  });

  test('is not posted when the comments run past the pages read', async () => {
    const page = (n: number) => ({ json: { values: [], next: `${API}/pullrequests/12/comments?page=${n}` } });
    const calls = mockFetch([page(2), page(3), page(4), page(5), page(6)]);
    expect(await provider().postPullRequestComment(12, PR_COMMENT_MARKER, body)).toBeNull();
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  test('never follows a next link off this repository’s API, and then posts nothing', async () => {
    for (const next of [
      'https://evil.example/2.0/repositories/acme/shop/pullrequests/12/comments',
      `${API}/../../other/repo/pullrequests/12/comments`,
    ]) {
      const calls = mockFetch([{ json: { values: [], next } }, { json: { id: 3 } }]);
      expect(await provider().postPullRequestComment(12, PR_COMMENT_MARKER, body)).toBeNull();
      expect(calls.map((c) => c.url)).toEqual([`${API}/pullrequests/12/comments?pagelen=100`]);
    }
  });

  test('is not posted without a token, or when the host refuses it', async () => {
    const calls = mockFetch([{ json: { values: [] } }, { status: 403 }]);
    expect(await provider(null).postPullRequestComment(12, PR_COMMENT_MARKER, body)).toBeNull();
    expect(calls).toEqual([]);
    expect(await provider().upsertPullRequestComment(12, PR_COMMENT_MARKER, body)).toBe(false);
  });
});

describe('the commit status', () => {
  const status = {
    description: '118/120 passed',
    targetUrl: 'https://piwi.example.com/runs/4',
    context: 'piwi/tests',
  };

  test('is a build status keyed by its context, on the pull request of its branch', async () => {
    const calls = mockFetch([{}]);
    expect(await provider().postCommitStatus('4e1f2a9', { ...status, state: 'failure', ref: 'feature/cart' })).toBe(
      true,
    );
    expect(calls).toEqual([
      {
        url: `${API}/commit/4e1f2a9/statuses/build`,
        method: 'POST',
        body: {
          key: 'piwi/tests',
          name: 'piwi/tests',
          state: 'FAILED',
          description: '118/120 passed',
          url: 'https://piwi.example.com/runs/4',
          refname: 'feature/cart',
        },
      },
    ]);
  });

  test('names no branch when the run reported none', async () => {
    const calls = mockFetch([{}]);
    await provider().postCommitStatus('4e1f2a9', { ...status, state: 'success', ref: null });
    expect(calls[0]!.body).not.toHaveProperty('refname');
  });

  test('names each state as Bitbucket does', async () => {
    const states: Record<string, string> = {
      success: 'SUCCESSFUL',
      failure: 'FAILED',
      error: 'FAILED',
      pending: 'INPROGRESS',
    };
    for (const [state, expected] of Object.entries(states)) {
      const calls = mockFetch([{}]);
      await provider().postCommitStatus('abc1234', { ...status, state: state as 'success' });
      expect((calls[0]!.body as { state: string }).state).toBe(expected);
    }
  });

  test('is refused for a commit that is not a plain ref, without a token, or on an error', async () => {
    const calls = mockFetch([{ status: 401 }]);
    expect(await provider().postCommitStatus('../x', { ...status, state: 'success' })).toBe(false);
    expect(await provider(null).postCommitStatus('abc1234', { ...status, state: 'success' })).toBe(false);
    expect(calls).toEqual([]);
    expect(await provider().postCommitStatus('abc1234', { ...status, state: 'success' })).toBe(false);
  });
});
