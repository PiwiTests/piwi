import { detectProvider, extractKey } from '#shared/link-detect';
import type { LinkProvider } from '#shared/link-detect';
import { getAppSetting } from '../app-settings';
import { decryptSecret, getEncryptionKey } from '../crypto';
import { scmProviderForUrl } from '../scm';
import { resolveJiraUnfurlConfig } from '../integrations/connections';
import { UnfurlProvider, type UnfurlResult } from './UnfurlProvider';
import { GenericUnfurlProvider } from './GenericUnfurlProvider';
import { JiraUnfurlProvider } from './JiraUnfurlProvider';
import type { AtlassianConfig } from './JiraUnfurlProvider';
import { ScmUnfurlProvider } from './ScmUnfurlProvider';
import type { DbClient } from '../../database';
import type { ProjectScope } from '../project-access';
import { isRepositoryPinnedInScope } from '../scm/project-repository';

/** The SCM link providers, whose entity is unfurled through `server/utils/scm/`. */
const SCM_PROVIDERS: ReadonlySet<LinkProvider> = new Set([
  'github-issue',
  'github-pr',
  'gitlab-issue',
  'gitlab-mr',
  'bitbucket',
]);

/**
 * The web URL of the repository a link points at, derived from the link itself,
 * so `scmProviderForUrl` can build the right provider. Returns null when the
 * link has no owner/repo (or group/project) segments.
 */
function repositoryUrlFromLink(url: string, provider: LinkProvider): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+/, '');
    // A GitLab project path can be nested (group/subgroup/project) and always
    // sits before the `/-/` that begins the issue / MR route.
    if (provider === 'gitlab-issue' || provider === 'gitlab-mr') {
      const repoPath = path.split('/-/')[0]?.replace(/\/+$/, '') ?? '';
      return repoPath.includes('/') ? `${parsed.origin}/${repoPath}` : null;
    }
    const [owner, repo] = path.split('/');
    if (!owner || !repo) return null;
    return `${parsed.origin}/${owner}/${repo.replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * Construct a provider from a URL and pre-resolved config/token.
 * For SCM providers (GitHub/GitLab/Bitbucket) that work with public APIs,
 * pass `url` and optional `scmToken`; for Atlassian providers pass `atlassianConfig`.
 */
export function unfurlProviderForProvider(
  provider: LinkProvider,
  url?: string,
  atlassianConfig?: AtlassianConfig | null,
  scmToken?: string | null,
): UnfurlProvider | null {
  switch (provider) {
    case 'jira':
      return atlassianConfig ? new JiraUnfurlProvider(atlassianConfig) : null;
    default: {
      if (!SCM_PROVIDERS.has(provider) || !url) return null;
      const repositoryUrl = repositoryUrlFromLink(url, provider);
      if (!repositoryUrl) return null;
      const scm = scmProviderForUrl(repositoryUrl, scmToken ?? null);
      return scm ? new ScmUnfurlProvider(provider, scm) : null;
    }
  }
}

/**
 * Construct a provider for a URL, loading config from DB if needed. `readable`
 * is the projects the caller can read: the instance SCM token reads only a
 * repository one of them is pinned to, and any other SCM link is unfurled with
 * no token, as a public one.
 */
export async function createUnfurlProvider(
  url: string,
  db: DbClient,
  readable: ProjectScope,
): Promise<UnfurlProvider | null> {
  const providerType = detectProvider(url);

  // Jira reads its config from the matching connection; Confluence is unreachable.
  if (providerType === 'jira') {
    const config = await resolveJiraUnfurlConfig(db, url);
    return config ? unfurlProviderForProvider(providerType, url, config) : null;
  }
  if (providerType === 'confluence') {
    return null;
  }

  // SCM providers — the instance token for a repository a readable project is pinned to, else none.
  if (SCM_PROVIDERS.has(providerType)) {
    const repositoryUrl = repositoryUrlFromLink(url, providerType);
    const pinned = repositoryUrl ? await isRepositoryPinnedInScope(db, readable, repositoryUrl) : false;
    return unfurlProviderForProvider(providerType, url, null, pinned ? await loadScmToken(db) : null);
  }

  return null;
}

/**
 * Main unfurl entry point.
 * Tries rich (API-based) unfurl first when a database connection is available,
 * falls back to generic OpenGraph parsing. `readable` is the projects the
 * caller can read (see {@link createUnfurlProvider}).
 */
export async function unfurlUrl(url: string, db?: DbClient, readable: ProjectScope = new Set()): Promise<UnfurlResult> {
  if (db) {
    const provider = await createUnfurlProvider(url, db, readable);
    if (provider) {
      const key = extractKey(url, detectProvider(url));
      const result = await provider.unfurl(url, key);
      if (result.title || result.statusText) {
        return result;
      }
    }
  }

  const generic = new GenericUnfurlProvider();
  return generic.unfurl(url, null);
}

async function loadScmToken(db: DbClient): Promise<string | null> {
  const setting = await getAppSetting<{ value?: string }>(db, 'scm_token');
  if (!setting?.value) return null;
  try {
    return decryptSecret(setting.value, getEncryptionKey());
  } catch {
    return null;
  }
}
