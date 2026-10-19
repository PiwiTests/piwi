/** Documented last-resort default branch when nothing else resolves one. */
export const FALLBACK_DEFAULT_BRANCH = 'main';

/**
 * Normalize a git remote URL (SSH or HTTPS, with or without a `.git` suffix or
 * embedded credentials) into a clean `https://host/owner/repo` form the SCM
 * providers can parse. An SSH or `git://` remote reads over https on its host.
 * Returns null when there is nothing to normalize, and for a URL of any other
 * scheme (`file:`, `javascript:`…), which is never a repository link.
 *
 * Lives in its own module so both `regression-context` (which re-exports it for
 * its many callers) and the default-branch resolver can use it without a
 * circular import.
 */
export function normalizeGitUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  let url = remoteUrl.trim();
  if (url.startsWith('git@')) {
    url = url.replace(/^git@([^:]+):/, 'https://$1/');
  }
  url = url.replace(/\.git$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ssh:' || parsed.protocol === 'git:') {
      return parsed.hostname ? `https://${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '') : null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * A git remote as a project's pinned repository: `https://host/owner/repo`,
 * with no credentials, port, `.git` suffix, query or trailing slash. SSH,
 * `ssh://` and `git://` remotes read over https. Null for anything that is not
 * a web host with an owner and a repository path (a local path, a bare host).
 */
export function repositoryUrlFromRemote(remoteUrl: string | null | undefined): string | null {
  const normalized = normalizeGitUrl(remoteUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) return null;
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!path.includes('/')) return null;
    const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
    return `${protocol}//${parsed.hostname}/${path}`;
  } catch {
    return null;
  }
}

/** Whether two remotes name the same repository, whatever their form (https, SSH, case, credentials). */
export function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (url: string | null | undefined) =>
    repositoryUrlFromRemote(url)
      ?.replace(/^https?:/, '')
      .toLowerCase();
  const left = key(a);
  return !!left && left === key(b);
}
