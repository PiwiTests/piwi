import { getAppSetting } from '../app-settings';
import { decryptSecret, getEncryptionKey } from '../crypto';
import { projects } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { GitHubProvider } from './GitHubProvider';
import { GitLabProvider } from './GitLabProvider';
import { BitbucketProvider } from './BitbucketProvider';
import { localGitProvider, type LocalGitProvider } from './local-git';
import { projectRepositoryFor } from './project-repository';
import { detectScmHost, type ScmProviderName } from '#shared/scm-urls';
import type { DbClient } from '../../database';

/** Returns the SCM provider name for a repository URL, or null if unsupported. */
export function detectScmProvider(repositoryUrl: string | null | undefined): ScmProviderName | null {
  return detectScmHost(repositoryUrl);
}

/**
 * Self-hosted GitLab hosts a stored SCM token may be sent to, from
 * `PIWI_SCM_GITLAB_HOSTS` (comma-separated host names). `gitlab.com` needs no entry.
 */
export function configuredGitlabHosts(): Set<string> {
  return new Set(
    (process.env.PIWI_SCM_GITLAB_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

const warnedGitlabHosts = new Set<string>();

/**
 * Instantiate the correct provider for the given URL with a pre-loaded token.
 *
 * The repository URL usually comes from run metadata the reporter submits, so it
 * never chooses where the token goes: GitHub and Bitbucket are called on their
 * fixed API hosts, and GitLab only on `gitlab.com` or a host listed in
 * `PIWI_SCM_GITLAB_HOSTS`. Any other GitLab-looking host gets no provider.
 */
export function scmProviderForUrl(
  repositoryUrl: string,
  token: string | null,
): GitHubProvider | GitLabProvider | BitbucketProvider | null {
  try {
    const { hostname, pathname } = new URL(repositoryUrl);
    const repoPath = pathname.replace(/^\//, '').replace(/\/$/, '');
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      return new GitHubProvider(repoPath, token);
    }
    if (hostname === 'gitlab.com' || configuredGitlabHosts().has(hostname.toLowerCase())) {
      return new GitLabProvider(hostname, repoPath, token);
    }
    if (hostname.includes('gitlab')) {
      if (!warnedGitlabHosts.has(hostname)) {
        warnedGitlabHosts.add(hostname);
        console.warn(
          `[scm] ${hostname} is not in PIWI_SCM_GITLAB_HOSTS, so Piwi does not call it; add it to read that GitLab instance.`,
        );
      }
      return null;
    }
    if (hostname === 'bitbucket.org') {
      const [workspace, repoSlug] = repoPath.split('/');
      if (workspace && repoSlug) return new BitbucketProvider(workspace, repoSlug, token);
    }
  } catch {
    /* invalid URL */
  }
  return null;
}

/**
 * Instantiate the provider of a project's repository, loading the SCM token from:
 * 1. Per-project scmToken
 * 2. Global scm_token app setting (fallback)
 *
 * The provider reads the project's pinned repository only
 * (`project-repository.ts`): `repositoryUrl`, which usually comes from a run's
 * metadata, must name it, or there is no provider.
 *
 * On the desktop app with no token, a project linked to a clone of the
 * repository reads its history with local git in that folder, and asks the host
 * only for what the clone does not have (see {@link localGitProvider}).
 */
export async function createScmProvider(
  repositoryUrl: string,
  db: DbClient,
  projectId: number,
): Promise<GitHubProvider | GitLabProvider | BitbucketProvider | LocalGitProvider | null> {
  const repository = await projectRepositoryFor(db, projectId, repositoryUrl);
  if (!repository) return null;
  const token = await resolveScmToken(db, projectId);
  const hosted = scmProviderForUrl(repository, token);
  if (hosted && !token) {
    return (await localGitProvider(projectId, repository, hosted)) ?? hosted;
  }
  return hosted;
}

/**
 * Resolve the SCM token to use, decrypted: the per-project token when set,
 * otherwise the global `scm_token` app setting. Returns null when neither is
 * configured. Shared by {@link createScmProvider} and callers that only need to
 * know whether a token exists (e.g. the CI re-run availability check).
 */
export async function resolveScmToken(db: DbClient, projectId?: number): Promise<string | null> {
  if (projectId) {
    const [project] = await db.select({ scmToken: projects.scmToken }).from(projects).where(eq(projects.id, projectId));
    if (project?.scmToken) return decryptSecret(project.scmToken, getEncryptionKey());
  }

  const tokenSetting = await getAppSetting<{ value?: string }>(db, 'scm_token');
  if (tokenSetting?.value) return decryptSecret(tokenSetting.value, getEncryptionKey());

  return null;
}
