/**
 * Self-hosted GitLab hosts an SCM credential may be sent to, from
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
