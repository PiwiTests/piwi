import { projects } from '../../database/schema';
import { eq } from 'drizzle-orm';
import { CredentialRefusedError, withCredential, type CredentialActor } from '../credentials';
import { loadCredentialRecords, readInstanceScmCredentialIds } from '#shared/handlers/credentials';
import { isUnderBaseUrl } from '#shared/ci-server';
import { GitHubProvider } from './GitHubProvider';
import { GitLabProvider } from './GitLabProvider';
import { BitbucketProvider } from './BitbucketProvider';
import { localGitProvider, type LocalGitProvider } from './local-git';
import { projectRepositoryFor } from './project-repository';
import { configuredGitlabHosts } from './gitlab-hosts';

import { canonicalScmHostname, detectScmHost, type ScmProviderName } from '#shared/scm-urls';
import type { DbClient } from '../../database';

/** Returns the SCM provider name for a repository URL, or null if unsupported. */
export function detectScmProvider(repositoryUrl: string | null | undefined): ScmProviderName | null {
  return detectScmHost(repositoryUrl);
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
export function scmProviderForUrl(repositoryUrl: string, token: string | null): HostedScmProvider | null {
  try {
    const url = new URL(repositoryUrl);
    const hostname = canonicalScmHostname(url.hostname);
    const pathname = url.pathname;
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

/** A provider of a repository on a host Piwi has a client for. */
export type HostedScmProvider = GitHubProvider | GitLabProvider | BitbucketProvider;

/** How a repository's calls are made: who starts them, and the credential a CI action names. */
export interface ScmCallOptions {
  /** Who starts the calls, for the credential's log; the instance itself when absent. */
  actor?: CredentialActor;
  /** The SCM credential a CI action names, which goes before the project's. */
  credentialId?: number | null;
  /**
   * Throw the credential's refusal ({@link CredentialRefusedError}) instead of
   * going on without a token, for a call that cannot do without one (a dispatch).
   */
  strict?: boolean;
}

const INSTANCE_ACTOR: CredentialActor = { userId: null, apiKeyId: null };

/**
 * The SCM credential a repository call carries, by id, or null for none: the
 * one a CI action names, else the project's (`projects.scm_credential_id`),
 * else the instance credential (`scm_credentials`) whose destination holds the
 * repository's API URL, the narrowest first. With no project (a link
 * preview), the instance's alone; with no API URL, any of the instance's.
 */
export async function scmCredentialFor(
  db: DbClient,
  projectId: number | null,
  apiUrl: string | null,
  override?: number | null,
): Promise<number | null> {
  if (override) return override;
  if (projectId != null) {
    const [project] = await db
      .select({ credentialId: projects.scmCredentialId })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (project?.credentialId != null) return project.credentialId;
  }
  const ids = await readInstanceScmCredentialIds(db);
  if (ids.length === 0) return null;
  const holding = (await loadCredentialRecords(db))
    .filter((r) => ids.includes(r.id) && r.service === 'scm' && (!apiUrl || isUnderBaseUrl(r.destination, apiUrl)))
    .sort((a, b) => b.destination.length - a.destination.length || a.id - b.id);
  return holding[0]?.id ?? null;
}

/** Whether a repository call of the project would carry a credential ({@link scmCredentialFor}). */
export async function hasScmCredential(
  db: DbClient,
  projectId: number,
  repositoryUrl: string | null,
  override?: number | null,
): Promise<boolean> {
  const apiUrl = repositoryUrl ? (scmProviderForUrl(repositoryUrl, null)?.apiUrl ?? null) : null;
  return (await scmCredentialFor(db, projectId, apiUrl, override)) !== null;
}

/**
 * The provider of a repository, with the credential its calls carry
 * ({@link scmCredentialFor}). `withCredential` checks the credential and opens
 * it as one counted read (`scm-read`), and builds the provider with it; each
 * write of the provider goes through `withCredential` again, with its feature
 * and subject. With no credential, or one its rules refuse (logged), the
 * provider carries no token and reads the repository as a public one, unless
 * `strict`. `repository` is the project's pinned repository, or, with no
 * project, one pinned in a project the caller reads.
 */
export async function openScmProvider(
  db: DbClient,
  projectId: number | null,
  repository: string,
  options: ScmCallOptions = {},
): Promise<HostedScmProvider | null> {
  const anonymous = scmProviderForUrl(repository, null);
  if (!anonymous) return null;
  const credentialId = await scmCredentialFor(db, projectId, anonymous.apiUrl, options.credentialId);
  if (credentialId === null) return anonymous;
  const use = {
    credentialId,
    projectId,
    url: anonymous.apiUrl,
    custom: false,
    actor: options.actor ?? INSTANCE_ACTOR,
  };
  try {
    return await withCredential(db, { ...use, feature: 'scm-read' }, async (opened) =>
      scmProviderForUrl(repository, opened.secret)!.gateWrites((write, run, failure) =>
        // The provider holds the token opened above: a write does not refresh it again, and a 401 the host answers
        // marks a person's token refused, so they are asked for it again.
        withCredential(db, { ...use, feature: write.feature, subject: write.subject }, () => run(), failure, {
          refresh: false,
          unauthorizedError: (message) => /\bfailed \(401\)/.test(message),
        }),
      ),
    );
  } catch (e) {
    if (e instanceof CredentialRefusedError && !options.strict) return anonymous;
    throw e;
  }
}

/**
 * The provider of a project's repository, with the credential its calls carry
 * ({@link openScmProvider}).
 *
 * The provider reads the project's pinned repository only
 * (`project-repository.ts`): `repositoryUrl`, which usually comes from a run's
 * metadata, must name it, or there is no provider.
 *
 * On the desktop app, a project linked to a clone of the repository reads its
 * history with local git in that folder, and asks the host only for what the
 * clone does not have (see {@link localGitProvider}): with no credential, or
 * for a host Piwi has no client for, where the clone is the only source. A
 * credential on a host Piwi has a client for always goes to that host.
 */
export async function createScmProvider(
  repositoryUrl: string,
  db: DbClient,
  projectId: number,
  options: ScmCallOptions = {},
): Promise<HostedScmProvider | LocalGitProvider | null> {
  const repository = await projectRepositoryFor(db, projectId, repositoryUrl);
  if (!repository) return null;
  const hosted = await openScmProvider(db, projectId, repository, options);
  if (hosted?.hasToken) return hosted;
  return (await localGitProvider(projectId, repository, hosted)) ?? hosted;
}
