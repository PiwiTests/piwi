import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubProvider } from '~~/server/utils/scm/GitHubProvider';
import { GitLabProvider } from '~~/server/utils/scm/GitLabProvider';
import { BitbucketProvider } from '~~/server/utils/scm/BitbucketProvider';

const HEAL_MESSAGE = 'test: heal broken locators\n\nPiwi-Heal: heal:v1:1:abcd1234';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function textResponse(body: string) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchChanges returns full commit messages', () => {
  test('GitHub keeps the subject as the message and the whole text as the full message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        commits: [{ sha: '1111111aaaa', commit: { message: HEAL_MESSAGE } }],
        files: [{ filename: 'tests/a.spec.ts', status: 'modified', additions: 1, deletions: 1 }],
      }),
    );
    const changes = await new GitHubProvider('acme/shop', 'tok').fetchChanges('aaa0001', 'bbb0001');
    expect(changes?.commits).toEqual([
      { sha: '1111111', message: 'test: heal broken locators', fullMessage: HEAL_MESSAGE },
    ]);
  });

  test('GitLab keeps the subject as the message and the whole text as the full message', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        commits: [{ id: '2222222bbbb', message: HEAL_MESSAGE }],
        diffs: [],
      }),
    );
    const changes = await new GitLabProvider('gitlab.com', 'acme/shop', 'tok').fetchChanges('aaa0002', 'bbb0002');
    expect(changes?.commits).toEqual([
      { sha: '2222222', message: 'test: heal broken locators', fullMessage: HEAL_MESSAGE },
    ]);
  });

  test('Bitbucket lists the range’s commits, oldest first, beside the diff', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.includes('/diffstat/')) {
        return jsonResponse({ values: [{ status: 'modified', new: { path: 'tests/a.spec.ts' }, lines_added: 1 }] });
      }
      if (url.includes('/diff/')) return textResponse('');
      if (url.includes('/commits?')) {
        return jsonResponse({
          values: [
            { hash: '4444444dddd', message: 'chore: newer\n' },
            { hash: '3333333cccc', message: HEAL_MESSAGE },
          ],
        });
      }
      return jsonResponse({}, false, 404);
    });

    const changes = await new BitbucketProvider('acme', 'shop', 'tok').fetchChanges('aaa0003', 'bbb0003');

    expect(changes?.files.map((f) => f.filename)).toEqual(['tests/a.spec.ts']);
    expect(changes?.commits).toEqual([
      { sha: '3333333', message: 'test: heal broken locators', fullMessage: HEAL_MESSAGE },
      { sha: '4444444', message: 'chore: newer', fullMessage: 'chore: newer\n' },
    ]);
    const commitsCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/commits?'));
    const params = new URL(commitsCall!).searchParams;
    expect(params.get('include')).toBe('bbb0003');
    expect(params.get('exclude')).toBe('aaa0003');
  });

  test('Bitbucket still answers with the files when the commits call fails', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url.includes('/diffstat/')) return jsonResponse({ values: [{ status: 'added', new: { path: 'b.ts' } }] });
      if (url.includes('/diff/')) return textResponse('');
      return jsonResponse({}, false, 500);
    });

    const changes = await new BitbucketProvider('acme', 'shop', 'tok').fetchChanges('aaa0004', 'bbb0004');

    expect(changes?.files.map((f) => f.filename)).toEqual(['b.ts']);
    expect(changes?.commits).toEqual([]);
  });
});

describe('changed files carry their blob id at the head', () => {
  test('GitHub gives the blob of each file but a removed one', async () => {
    const head = 'C0FFEE'.padEnd(40, '0');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        commits: [],
        files: [
          { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, sha: head },
          { filename: 'src/b.ts', status: 'removed', additions: 0, deletions: 3, sha: 'a'.repeat(40) },
          { filename: 'vendor/lib', status: 'modified', additions: 0, deletions: 0, sha: null },
        ],
      }),
    );
    const changes = await new GitHubProvider('acme/shop', 'tok').fetchChanges('aaa0005', 'bbb0005');
    expect(changes?.files.map((f) => f.blob)).toEqual([head.toLowerCase(), undefined, undefined]);
  });
});
