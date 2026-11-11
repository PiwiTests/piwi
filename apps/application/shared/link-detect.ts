import { detectScmHost, type ScmProviderName } from '#shared/scm-urls';

export type LinkProvider =
  | 'jira'
  | 'github-issue'
  | 'github-pr'
  | 'gitlab-issue'
  | 'gitlab-mr'
  | 'bitbucket'
  | 'confluence'
  | 'slack'
  | 'linear'
  | 'notion'
  | 'zephyr-scale'
  | 'generic';

/**
 * A provider entry matches a URL when every regex in `tests` matches it and,
 * for an SCM provider, `detectScmHost` resolves the URL's host to `scmHost` —
 * so provider-host rules live only in `#shared/scm-urls` and a self-hosted
 * GitLab is recognized here the same as everywhere. The `tests` of an SCM entry
 * carry only the path shape that tells an issue from a PR/MR.
 */
const providerPatterns: { provider: LinkProvider; scmHost?: ScmProviderName; tests: RegExp[]; keyExtract?: RegExp }[] =
  [
    {
      provider: 'jira',
      tests: [
        /^https:\/\/([^./]+)\.atlassian\.net\/browse\//i,
        /^https:\/\/[^/]+\/jira\/software\/c\/projects\//i,
        /^https:\/\/[^/]+\/.+\/browse\//i,
      ],
      keyExtract: /\/([A-Z][A-Z0-9_]+-\d+)(?:\?|$|#)/i,
    },
    {
      provider: 'github-issue',
      scmHost: 'github',
      tests: [/\/[^/]+\/[^/]+\/issues\/\d+/i],
      keyExtract: /\/issues\/(\d+)/,
    },
    {
      provider: 'github-pr',
      scmHost: 'github',
      tests: [/\/[^/]+\/[^/]+\/pull\/\d+/i],
      keyExtract: /\/pull\/(\d+)/,
    },
    {
      provider: 'gitlab-issue',
      scmHost: 'gitlab',
      tests: [/\/-\/issues\/\d+/i],
      keyExtract: /\/issues\/(\d+)/,
    },
    {
      provider: 'gitlab-mr',
      scmHost: 'gitlab',
      tests: [/\/-\/merge_requests\/\d+/i],
      keyExtract: /\/merge_requests\/(\d+)/,
    },
    {
      provider: 'bitbucket',
      scmHost: 'bitbucket',
      tests: [/\/[^/]+\/[^/]+\/pull-requests\/\d+/i],
      keyExtract: /\/pull-requests\/(\d+)/,
    },
    {
      provider: 'confluence',
      tests: [/^https:\/\/([^./]+)\.atlassian\.net\/wiki\//i],
    },
    {
      provider: 'slack',
      tests: [/^https:\/\/[^/]+\.slack\.com\//i],
    },
    {
      provider: 'linear',
      tests: [/^https:\/\/linear\.app\//i],
      keyExtract: /\/([A-Za-z]+-\d+)(?:\/|\?|$|#)/,
    },
    {
      provider: 'notion',
      tests: [/^https:\/\/(www\.)?notion\.so\//i],
    },
  ];

export function detectProvider(url: string): LinkProvider {
  const scmHost = detectScmHost(url);
  for (const entry of providerPatterns) {
    if (entry.scmHost && entry.scmHost !== scmHost) continue;
    if (entry.tests.some((r) => r.test(url))) {
      return entry.provider;
    }
  }
  return 'generic';
}

export function extractKey(url: string, provider: LinkProvider): string | null {
  const entry = providerPatterns.find((p) => p.provider === provider);
  if (!entry?.keyExtract) return null;
  const m = entry.keyExtract.exec(url);
  return m?.[1] ?? null;
}

export function getProviderIcon(provider: LinkProvider): string {
  const icons: Record<LinkProvider, string> = {
    jira: 'i-simple-icons-jira',
    'github-issue': 'i-simple-icons-github',
    'github-pr': 'i-simple-icons-github',
    'gitlab-issue': 'i-simple-icons-gitlab',
    'gitlab-mr': 'i-simple-icons-gitlab',
    bitbucket: 'i-simple-icons-bitbucket',
    confluence: 'i-simple-icons-confluence',
    slack: 'i-simple-icons-slack',
    linear: 'i-simple-icons-linear',
    notion: 'i-simple-icons-notion',
    'zephyr-scale': 'i-lucide-list-checks',
    generic: 'i-lucide-link',
  };
  return icons[provider];
}

/** The tracker or tool a link points at, as a reader names it; null for a generic link. */
export function getProviderName(provider: LinkProvider): string | null {
  const names: Record<LinkProvider, string | null> = {
    jira: 'Jira',
    'github-issue': 'GitHub',
    'github-pr': 'GitHub',
    'gitlab-issue': 'GitLab',
    'gitlab-mr': 'GitLab',
    bitbucket: 'Bitbucket',
    confluence: 'Confluence',
    slack: 'Slack',
    linear: 'Linear',
    notion: 'Notion',
    'zephyr-scale': 'Zephyr Scale',
    generic: null,
  };
  return names[provider] ?? null;
}
