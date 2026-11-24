/**
 * The single source of provider-specific SCM URLs — host detection and the
 * deep-link shapes for a commit, a compare range, a file and a branch.
 *
 * Provider-specific hostname rules and URL templates live *only* here: nothing
 * else in the codebase re-implements a `github.com` / `gitlab` / `bitbucket.org`
 * switch or hand-writes a `/commit/<sha>` path. The server's `ScmProvider`
 * subclasses and the browser demo both go through these pure functions, so a
 * link renders identically wherever it is built.
 */

/** The SCM hosts Piwi builds links for. */
export type ScmProviderName = 'github' | 'gitlab' | 'bitbucket';

/** How a sentence names each repository host. */
export const SCM_PROVIDER_LABELS: Record<ScmProviderName, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

/**
 * Host names a Git host serves SSH on besides its own (SSH over port 443, an
 * alternate SSH host), with the host they stand for. A remote on one of them
 * names the same repository as on the host itself.
 */
const SSH_HOST_ALIASES: Record<string, string> = {
  'ssh.github.com': 'github.com',
  'ssh.bitbucket.org': 'bitbucket.org',
  'altssh.bitbucket.org': 'bitbucket.org',
};

/** A host name in lower case, with a Git host's SSH alias replaced by the host it stands for. */
export function canonicalScmHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  return SSH_HOST_ALIASES[host] ?? host;
}

/**
 * The SCM provider a repository URL points at, or null when the host is not one
 * Piwi links to or the URL is not `http:` or `https:`, so no other scheme ever
 * becomes a link. Same hostname rules as the server's `detectScmProvider`.
 */
export function detectScmHost(repositoryUrl: string | null | undefined): ScmProviderName | null {
  if (!repositoryUrl) return null;
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const hostname = canonicalScmHostname(url.hostname);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github';
    if (hostname === 'gitlab.com' || hostname.includes('gitlab')) return 'gitlab';
    if (hostname === 'bitbucket.org') return 'bitbucket';
  } catch {
    // Not a URL — nothing to link.
  }
  return null;
}

/**
 * Whether a revision is a plain commit SHA or ref name (`a1b2c3d`, `main`,
 * `release/1.2`): letters, digits, `.`, `_`, `/` and `-`, not starting with `-`
 * and without `..` — safe to put in a URL path or a shell command as it is.
 */
export function isPlainRevision(revision: string): boolean {
  return /^[A-Za-z0-9][\w./-]{0,199}$/.test(revision) && !revision.includes('..');
}

/** A commit as a sentence shows it: a full hex SHA cut to its first 7 characters, any other ref as it is. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

/**
 * Base repository URL without a trailing slash, on the host itself when the URL
 * names an SSH alias of it, or null when the host is unknown.
 */
function repoBase(repositoryUrl: string): { host: ScmProviderName; base: string } | null {
  const host = detectScmHost(repositoryUrl);
  if (!host) return null;
  const url = new URL(repositoryUrl);
  const canonical = canonicalScmHostname(url.hostname);
  const base = canonical === url.hostname ? repositoryUrl : `${url.protocol}//${canonical}${url.pathname}`;
  return { host, base: base.replace(/\/$/, '') };
}

/** Deep link to a single commit, or null when the host is unknown. */
export function commitUrl(repositoryUrl: string | null | undefined, sha: string): string | null {
  if (!repositoryUrl || !sha) return null;
  const repo = repoBase(repositoryUrl);
  if (!repo) return null;
  switch (repo.host) {
    case 'github':
      return `${repo.base}/commit/${sha}`;
    case 'gitlab':
      return `${repo.base}/-/commit/${sha}`;
    case 'bitbucket':
      return `${repo.base}/commits/${sha}`;
  }
}

/** Deep link comparing two commits (`from`…`to`), or null when the host is unknown. */
export function compareUrl(repositoryUrl: string | null | undefined, fromSha: string, toSha: string): string | null {
  if (!repositoryUrl || !fromSha || !toSha) return null;
  const repo = repoBase(repositoryUrl);
  if (!repo) return null;
  switch (repo.host) {
    case 'github':
      return `${repo.base}/compare/${fromSha}...${toSha}`;
    case 'gitlab':
      return `${repo.base}/-/compare/${fromSha}...${toSha}`;
    case 'bitbucket':
      return `${repo.base}/branches/compare/${toSha}..${fromSha}#diff`;
  }
}

/** Deep link to a file at a ref, optionally anchored to a line, or null when unknown. */
export function fileUrl(
  repositoryUrl: string | null | undefined,
  ref: string,
  path: string,
  line?: number | null,
): string | null {
  if (!repositoryUrl || !ref || !path) return null;
  const repo = repoBase(repositoryUrl);
  if (!repo) return null;
  const clean = path.replace(/^\//, '');
  switch (repo.host) {
    case 'github':
      return `${repo.base}/blob/${ref}/${clean}${line ? `#L${line}` : ''}`;
    case 'gitlab':
      return `${repo.base}/-/blob/${ref}/${clean}${line ? `#L${line}` : ''}`;
    case 'bitbucket':
      return `${repo.base}/src/${ref}/${clean}${line ? `#lines-${line}` : ''}`;
  }
}

/** Deep link to a branch, or null when the host is unknown. */
export function branchUrl(repositoryUrl: string | null | undefined, branch: string): string | null {
  if (!repositoryUrl || !branch) return null;
  const repo = repoBase(repositoryUrl);
  if (!repo) return null;
  const encoded = encodeURIComponent(branch);
  switch (repo.host) {
    case 'github':
      return `${repo.base}/tree/${encoded}`;
    case 'gitlab':
      return `${repo.base}/-/tree/${encoded}`;
    case 'bitbucket':
      return `${repo.base}/branch/${encoded}`;
  }
}

/**
 * The API each host serves its repositories under, as an SCM credential's
 * destination names it: the host's API origin, then the path of its
 * repositories. A destination is the origin alone, or a path under the
 * repositories' (one owner's, one repository's).
 */
const SCM_API: Record<ScmProviderName, { origin: string; repositories: string }> = {
  github: { origin: 'https://api.github.com', repositories: '/repos/' },
  gitlab: { origin: 'https://gitlab.com', repositories: '/api/v4/projects/' },
  bitbucket: { origin: 'https://api.bitbucket.org', repositories: '/2.0/repositories/' },
};

/** The destination of an SCM credential for each host's whole API. */
export const SCM_API_DESTINATIONS: Record<ScmProviderName, string> = {
  github: `${SCM_API.github.origin}/`,
  gitlab: `${SCM_API.gitlab.origin}/`,
  bitbucket: `${SCM_API.bitbucket.origin}/`,
};

/**
 * The host an SCM credential's destination is for, or null when it is none
 * Piwi calls: the API of GitHub, Bitbucket, the GitLab cloud or a GitLab host
 * of `gitlabHosts` (`PIWI_SCM_GITLAB_HOSTS`), over https, whole or narrowed to
 * a path under its repositories.
 */
export function scmDestinationHost(
  destination: string,
  gitlabHosts: ReadonlySet<string> = new Set(),
): ScmProviderName | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const name = (Object.keys(SCM_API) as ScmProviderName[]).find(
    (key) => new URL(SCM_API[key].origin).hostname === host,
  );
  const provider = name ?? (gitlabHosts.has(host) ? 'gitlab' : null);
  if (!provider) return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (path === '/') return provider;
  if (!path.startsWith(SCM_API[provider].repositories)) return null;
  // GitLab names a project by its whole path, `group%2Fproject`, encoded as one segment: a destination narrows it to one project.
  if (provider === 'gitlab') {
    return /^[^/]*%2F[^/]*\/$/i.test(path.slice(SCM_API.gitlab.repositories.length)) ? provider : null;
  }
  return provider;
}

/**
 * An SCM credential's destination as it is stored: GitHub and Bitbucket
 * ignore the case of an owner and a repository, so their path is kept in
 * lower case, as {@link scmRepositoryApiUrl} writes it.
 */
export function normalizeScmDestination(destination: string): string {
  const host = scmDestinationHost(destination);
  if (host !== 'github' && host !== 'bitbucket') return destination;
  const url = new URL(destination);
  return `${url.origin}${url.pathname.toLowerCase()}`;
}

/**
 * The API URL of a repository, which an SCM credential's destination must
 * hold for the credential to go with its calls: GitHub's and Bitbucket's in
 * lower case, GitLab's with the project's path as one encoded segment. Null
 * for a host Piwi has no client for.
 */
export function scmRepositoryApiUrl(repositoryUrl: string | null | undefined): string | null {
  const repo = repositoryUrl ? repoBase(repositoryUrl) : null;
  if (!repo) return null;
  const url = new URL(repo.base);
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!path.includes('/')) return null;
  if (repo.host === 'gitlab') return `https://${url.hostname}${SCM_API.gitlab.repositories}${encodeURIComponent(path)}`;
  const [owner, name] = path.toLowerCase().split('/');
  return `${SCM_API[repo.host].origin}${SCM_API[repo.host].repositories}${owner}/${name}`;
}

/**
 * The destination of an SCM credential for a repository's host, its whole
 * API: GitHub's or Bitbucket's, or the GitLab host's (`https://gitlab.com/`,
 * `https://gitlab.example.com/`). Null for a host Piwi has no client for.
 */
export function scmApiDestination(repositoryUrl: string | null | undefined): string | null {
  const host = detectScmHost(repositoryUrl);
  if (!host) return null;
  if (host !== 'gitlab') return SCM_API_DESTINATIONS[host];
  return `https://${canonicalScmHostname(new URL(repositoryUrl!).hostname)}/`;
}
