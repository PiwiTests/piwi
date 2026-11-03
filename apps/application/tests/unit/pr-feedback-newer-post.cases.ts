import { expect, test } from 'vitest';
import { normalizeGitUrl } from '../../server/utils/scm/git-url';
import {
  hasNewerPostOnPullRequest,
  readPrFeedbackPost,
  recordPrFeedbackPost,
} from '../../server/utils/scm/pr-feedback-posts';
import type { DbClient } from '../../server/database';

/**
 * The cases of `hasNewerPostOnPullRequest`, run on each dialect. `insertRuns` creates a project and the given runs
 * and returns the project id.
 */
export function newerPostCases(setup: () => { db: DbClient; insertRuns: (ids: number[]) => Promise<number> }) {
  async function post(projectId: number, runId: number, repositoryUrl: string, prNumber: number) {
    await recordPrFeedbackPost(setup().db, { projectId, runId, repositoryUrl, prNumber });
  }
  async function hasNewer(runId: number) {
    const stored = await readPrFeedbackPost(setup().db, runId);
    return hasNewerPostOnPullRequest(setup().db, stored!);
  }

  test('a later post stored with another case names the same pull request', async () => {
    const projectId = await setup().insertRuns([101, 102]);
    await post(projectId, 101, normalizeGitUrl('git@github.com:Acme/Shop.git')!, 5);
    await post(projectId, 102, 'https://github.com/acme/shop', 5);
    expect(await hasNewer(101)).toBe(true);
    expect(await hasNewer(102)).toBe(false);
  });

  test('a later post stored with the host, not its SSH alias, names the same pull request', async () => {
    const projectId = await setup().insertRuns([201, 202]);
    await post(projectId, 201, 'https://ssh.github.com/acme/shop', 6);
    await post(projectId, 202, 'https://github.com/acme/shop', 6);
    expect(await hasNewer(201)).toBe(true);
  });

  test('a later post on the same number of another repository does not', async () => {
    const projectId = await setup().insertRuns([301, 302]);
    await post(projectId, 301, 'https://github.com/acme/shop', 7);
    await post(projectId, 302, 'https://github.com/acme/billing', 7);
    expect(await hasNewer(301)).toBe(false);
  });

  test('an earlier post does not, nor a later one on another pull request', async () => {
    const projectId = await setup().insertRuns([401, 402, 403]);
    await post(projectId, 401, 'https://github.com/acme/shop', 8);
    await post(projectId, 402, 'https://github.com/acme/shop', 8);
    await post(projectId, 403, 'https://github.com/acme/shop', 9);
    expect(await hasNewer(402)).toBe(false);
  });

  test('a post that names no pull request has none later', async () => {
    const projectId = await setup().insertRuns([501, 502]);
    await recordPrFeedbackPost(setup().db, { projectId, runId: 501, repositoryUrl: 'https://github.com/acme/shop' });
    await post(projectId, 502, 'https://github.com/acme/shop', 11);
    expect(await hasNewer(501)).toBe(false);
  });
}
