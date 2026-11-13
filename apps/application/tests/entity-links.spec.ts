import { test, expect } from './fixtures';
import { detectProvider, extractKey } from '#shared/link-detect';
import type { LinkProvider } from '#shared/link-detect';

// ============================================================================
// Provider detection tests
// ============================================================================

type ProviderTest = { url: string; expected: LinkProvider };

const providerTests: ProviderTest[] = [
  // Jira
  { url: 'https://example.atlassian.net/browse/PROJ-123', expected: 'jira' },
  { url: 'https://example.atlassian.net/jira/software/c/projects/FOO/bar/123', expected: 'jira' },
  // GitHub
  { url: 'https://github.com/owner/repo/issues/456', expected: 'github-issue' },
  { url: 'https://github.com/owner/repo/pull/789', expected: 'github-pr' },
  // GitLab
  { url: 'https://gitlab.com/owner/repo/-/issues/101', expected: 'gitlab-issue' },
  { url: 'https://gitlab.example.com/group/project/-/merge_requests/202', expected: 'gitlab-mr' },
  // Bitbucket
  { url: 'https://bitbucket.org/owner/repo/pull-requests/303', expected: 'bitbucket' },
  // Confluence
  { url: 'https://example.atlassian.net/wiki/spaces/SPACE/pages/12345', expected: 'confluence' },
  // Slack
  { url: 'https://workspace.slack.com/archives/C01234/p56789', expected: 'slack' },
  // Linear
  { url: 'https://linear.app/team/issue/TEAM-456/some-title', expected: 'linear' },
  // Notion
  { url: 'https://www.notion.so/Some-Page-abc123def456', expected: 'notion' },
  { url: 'https://notion.so/abc123def456', expected: 'notion' },
  // Generic
  { url: 'https://example.com/some/page', expected: 'generic' },
  { url: 'https://internal.company.com/browse/XYZ-99', expected: 'generic' },
];

for (const { url, expected } of providerTests) {
  test(`detectProvider: ${expected} — ${url}`, () => {
    expect(detectProvider(url)).toBe(expected);
  });
}

// ============================================================================
// Key extraction tests
// ============================================================================

type KeyTest = { url: string; provider: LinkProvider; expected: string | null };

const keyTests: KeyTest[] = [
  { url: 'https://example.atlassian.net/browse/PROJ-123', provider: 'jira', expected: 'PROJ-123' },
  { url: 'https://github.com/owner/repo/issues/456', provider: 'github-issue', expected: '456' },
  { url: 'https://github.com/owner/repo/pull/789', provider: 'github-pr', expected: '789' },
  { url: 'https://gitlab.com/owner/repo/-/issues/101', provider: 'gitlab-issue', expected: '101' },
  { url: 'https://gitlab.example.com/group/project/-/merge_requests/202', provider: 'gitlab-mr', expected: '202' },
  { url: 'https://bitbucket.org/owner/repo/pull-requests/303', provider: 'bitbucket', expected: '303' },
  { url: 'https://linear.app/team/issue/TEAM-456/some-title', provider: 'linear', expected: 'TEAM-456' },
  { url: 'https://example.com/some/page', provider: 'generic', expected: null },
  { url: 'https://workspace.slack.com/archives/C01234/p56789', provider: 'slack', expected: null },
];

for (const { url, provider, expected } of keyTests) {
  test(`extractKey: ${provider} from ${url} → ${expected ?? 'null'}`, () => {
    expect(extractKey(url, provider)).toBe(expected);
  });
}
