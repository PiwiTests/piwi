/**
 * The pull request a run's feedback goes to: the one its CI named first, a
 * pull request from a fork included, then the one open on its branch.
 */
import { describe, expect, test } from 'vitest';

delete process.env.PIWI_DATABASE_URL;
const { ciNamesRepository, findRunPullRequestNumber } = await import('../../server/utils/scm/pr-feedback');
const { resolveRunPullRequest } = await import('../../server/utils/scm/change-coverage');

function provider(open: Record<number, 'open' | 'draft' | 'closed' | 'merged'>, onBranch: number | null) {
  const asked: string[] = [];
  return {
    asked,
    fetchPullRequest: async (n: number) => {
      asked.push(`number ${n}`);
      const state = open[n];
      return state ? { title: null, state, author: null, url: null, updatedAt: null } : null;
    },
    findPullRequestForBranch: async (branch: string) => {
      asked.push(`branch ${branch}`);
      return onBranch == null ? null : { number: onBranch, url: '' };
    },
  };
}

describe('findRunPullRequestNumber', () => {
  test('the pull request the run names wins, without a branch lookup', async () => {
    const p = provider({ 42: 'open' }, 7);
    expect(await findRunPullRequestNumber(p, 42, 'feature/x')).toBe(42);
    expect(p.asked).toEqual(['number 42']);
  });

  test('a fork pull request, whose branch the base repository does not have, is found by its number', async () => {
    expect(await findRunPullRequestNumber(provider({ 42: 'draft' }, null), 42, 'patch-1')).toBe(42);
  });

  test('a named pull request that is closed gives way to the one open on the branch', async () => {
    expect(await findRunPullRequestNumber(provider({ 42: 'merged' }, 7), 42, 'feature/x')).toBe(7);
  });

  test('a run that names none is found by its branch, and a run with neither has none', async () => {
    expect(await findRunPullRequestNumber(provider({}, 7), null, 'feature/x')).toBe(7);
    expect(await findRunPullRequestNumber(provider({}, 7), null, null)).toBeNull();
  });
});

describe('ciNamesRepository', () => {
  test("a number from the CI of the repository Piwi posts to is that repository's", () => {
    expect(ciNamesRepository('PiwiTests/piwi', 'https://github.com/piwitests/piwi')).toBe(true);
    expect(ciNamesRepository(null, 'https://github.com/piwitests/piwi')).toBe(true);
  });

  test("a suite checked out from another repository names its CI's pull requests, not this one's", () => {
    expect(ciNamesRepository('acme/shop', 'https://github.com/acme/shop-e2e')).toBe(false);
    expect(ciNamesRepository('acme/shop', 'https://github.com/other/acme/shop-e2e')).toBe(false);
  });
});

describe('resolveRunPullRequest', () => {
  const byBranch = (pr: { number: number; baseBranch?: string | null } | null) => {
    const asked: string[] = [];
    return {
      asked,
      findPullRequestForBranch: async (branch: string) => {
        asked.push(branch);
        return pr ? { ...pr, url: '' } : null;
      },
    };
  };

  test('the pull request a run’s CI named merges into the base its CI recorded, without a lookup', async () => {
    const provider = byBranch({ number: 7, baseBranch: 'develop' });
    expect(await resolveRunPullRequest(provider, 42, 'feature/x', 'main', 'release/2')).toEqual({
      number: 42,
      baseBranch: 'release/2',
    });
    expect(provider.asked).toEqual([]);
  });

  test('a push-triggered run finds the pull request open on its branch, and its base', async () => {
    expect(
      await resolveRunPullRequest(byBranch({ number: 7, baseBranch: 'develop' }), null, 'feature/x', 'main', 'main'),
    ).toEqual({
      number: 7,
      baseBranch: 'develop',
    });
    expect(await resolveRunPullRequest(byBranch({ number: 7 }), null, 'feature/x', 'main', 'main')).toEqual({
      number: 7,
      baseBranch: 'main',
    });
  });

  test('a run on the default branch, or with no pull request open, has none', async () => {
    const provider = byBranch({ number: 7 });
    expect(await resolveRunPullRequest(provider, null, 'main', 'main', 'main')).toBeNull();
    expect(provider.asked).toEqual([]);
    expect(await resolveRunPullRequest(byBranch(null), null, 'feature/x', 'main', 'main')).toBeNull();
    expect(await resolveRunPullRequest(byBranch(null), null, null, 'main', 'main')).toBeNull();
  });
});
