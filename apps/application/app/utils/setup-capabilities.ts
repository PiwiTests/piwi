/**
 * UI copy for the Setup page's capability ladder.
 *
 * Single source of truth for what each optional capability is, why you'd want
 * it, and how to switch it on. Keyed by `SetupCapabilityId` so a capability
 * added to the detection handler without copy here (or vice versa) is a
 * compile error.
 *
 * Ordered deliberately: the ladder runs from "results arriving at all" through
 * the capabilities that build on each other (fixtures → locator healing) to
 * the optional extras. That order is the answer to "what should I do next?",
 * so it is the order the page renders within each group.
 */
import type { SetupCapabilityId } from '#shared/handlers/setup-status';
import type { CapabilityState } from '#shared/capabilities';

/** The four groups the Setup ladder sorts capabilities into. */
export type LadderGroup = 'active' | 'available' | 'notset' | 'declined';

/**
 * Which ladder group a capability's resolved state belongs to. Undecided and
 * not-applicable both fall under "not set up" — a stack without a backend
 * package reads the same as one that has not been switched on.
 */
export function ladderGroupOf(state: CapabilityState): LadderGroup {
  if (state === 'active') return 'active';
  if (state === 'declined') return 'declined';
  if (state === 'available') return 'available';
  return 'notset';
}

export interface SetupCapabilityCopy {
  id: SetupCapabilityId;
  title: string;
  /** One line: what it gives you. */
  summary: string;
  /** How to switch it on, when inactive. */
  how: string;
  icon: string;
  /** Marks a capability that ships behind a flag and is not yet validated. */
  experimental?: boolean;
  /** A one-line caveat rendered when `experimental`, e.g. what is not measured yet. */
  experimentalNote?: string;
  /** Docs page (+ optional `#anchor`), passed through `DocLink`. */
  doc?: string;
  /** In-app route that configures it, when there is one. */
  to?: string;
  /** Label for `to`. */
  toLabel?: string;
}

export const SETUP_CAPABILITIES: SetupCapabilityCopy[] = [
  {
    id: 'reporter',
    title: 'Results arriving',
    summary: 'Your Playwright runs are reaching this dashboard and their history is being kept.',
    how: 'Follow the four steps above to add the reporter to your Playwright config.',
    icon: 'i-lucide-antenna',
    doc: 'guide/reporter',
  },
  {
    id: 'fixtures',
    title: 'Capture fixtures',
    summary:
      'Network timing, Web Vitals, console errors and ARIA snapshots, captured per test. Powers slow endpoints, performance trends and the richer AI diagnosis context.',
    how: 'Extend your Playwright `test` with `piwiFixtures` — see "Go further" above.',
    icon: 'i-lucide-radio',
    doc: 'guide/capture-fixtures',
  },
  {
    id: 'locator-healing',
    title: 'Locator healing',
    summary:
      'When a selector breaks, ranked replacement locators captured from the last passing run — with a recommended fix.',
    how: 'Comes with the capture fixtures; enable those and healing data starts accumulating on passing runs.',
    icon: 'i-lucide-bandage',
    doc: 'guide/capture-fixtures',
  },
  {
    id: 'green-samples',
    title: 'Green page samples',
    summary:
      'A passing-page ARIA snapshot sampled about once a day per test, so a failure can be diffed against the page as it last looked when green.',
    how: 'Comes with the capture fixtures; enable those and samples start accruing on passing runs.',
    icon: 'i-lucide-scan-text',
    doc: 'features/evidence',
  },
  {
    id: 'backend-logs',
    title: 'Backend logs',
    summary:
      'Server-side warnings, errors and spans captured during each test and shown next to the network request that triggered them.',
    how: 'Needs a backend package in the app under test; available today for Nitro and ASP.NET Core.',
    icon: 'i-lucide-server',
    doc: 'guide/backend-logs',
  },
  {
    id: 'coverage',
    title: 'Coverage',
    summary:
      'The browser files and backend lines each test ran, listed under its source on the execution page, with the changed lines a failing test ran ranked as suspect lines.',
    how: "Set the reporter's `coverage` option (`browser: 'files'`, `server: 'lines'`) in a scheduled run; the server side needs an ASP.NET Core build with Piwi's coverage package.",
    icon: 'i-lucide-scan-line',
    doc: 'features/code-reach',
  },
  {
    id: 'clustering',
    title: 'Failure clustering',
    summary: 'Forty red tests collapsed into the three root causes behind them, each triaged once.',
    how: 'Automatic — clusters form as soon as failures with a shared error fingerprint arrive.',
    icon: 'i-lucide-layers',
    doc: 'features/ai-diagnosis',
  },
  {
    id: 'ai',
    title: 'AI diagnosis',
    summary:
      'An LLM you configure explains a cluster against your actual git diff, with its suggested patch validated against your source before you see it.',
    how: 'Configure a provider in Settings — Anthropic, OpenAI, or any OpenAI-compatible endpoint including local models.',
    icon: 'i-lucide-sparkles',
    doc: 'guide/ai-provider',
    to: '/settings/ai',
    toLabel: 'Configure AI',
  },
  {
    id: 'mcp',
    title: 'MCP server',
    summary: 'A local MCP endpoint so agents like Claude can query your results, failures and fix plans.',
    how: 'Always available — open the MCP server page for the URL and one-click setup for every client.',
    icon: 'i-lucide-bot',
    doc: 'features/mcp',
    to: '/mcp',
    toLabel: 'Open MCP setup',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    summary: 'Email, Slack, webhook and browser channels, with per-project subscriptions and digests.',
    how: 'Add a channel in Settings, then subscribe the projects you care about.',
    icon: 'i-lucide-bell',
    doc: 'features/notifications',
    to: '/settings/notifications',
    toLabel: 'Add a channel',
  },
  {
    id: 'quality-reports',
    title: 'Quality reports',
    summary:
      'The analytics page as a document for someone who never opens the dashboard: a verdict, headline numbers, the trend, what is being done and the risks, as PDF, HTML, Markdown, Excel or JSON.',
    how: 'Click Export on the Analytics page or on a project page, pick a dashboard and download the format you need.',
    icon: 'i-lucide-file-chart-column',
    doc: 'features/quality-reports',
  },
  {
    id: 'pr-feedback',
    title: 'Pull-request feedback',
    summary: 'When a run finishes on a branch with an open pull request, the result posted back to it.',
    how: 'Configure it in Settings — needs a repository access token.',
    icon: 'i-lucide-git-pull-request',
    doc: 'features/pr-feedback',
    to: '/settings/pr-feedback',
    toLabel: 'Configure',
  },
  {
    id: 'auto-heal',
    title: 'Auto-heal',
    summary:
      'When a locator breaks on the default branch and healing is confident, Piwi opens the fix as a pull request.',
    how: 'Configure it in Settings — needs a repository token, and the capture fixtures for healing data.',
    icon: 'i-lucide-bandage',
    doc: 'features/auto-heal',
    to: '/settings/auto-heal',
    toLabel: 'Configure',
  },
  {
    id: 'integrations',
    title: 'Issue tracking',
    summary: 'Create and link issues in Jira, GitHub or GitLab straight from a failure cluster.',
    how: 'Connect a system in Settings.',
    icon: 'i-lucide-plug',
    doc: 'features/issue-tracking',
    to: '/settings/integrations',
    toLabel: 'Connect a system',
  },
  {
    id: 'scm',
    title: 'Source control',
    summary:
      'The commits behind a failure, CODEOWNERS-derived ownership, and pull-request feedback on the branch that broke.',
    how: 'Add a repository access token on the project, or globally in Settings.',
    icon: 'i-lucide-git-branch',
    doc: 'guide/source-control',
    to: '/settings/ai',
    toLabel: 'Add a token',
  },
  {
    id: 'tags',
    title: 'Tags & ownership',
    summary:
      "Playwright's own test tags plus `piwi:owner` / `priority` / `feature` annotations, filterable across the catalog and the flaky leaderboard.",
    how: 'Tag tests in your specs, or define project tags in Settings.',
    icon: 'i-lucide-tags',
    doc: 'guide/reporter',
    to: '/settings/tags',
    toLabel: 'Manage tags',
  },
  {
    id: 'markers',
    title: 'Timeline markers',
    summary: 'Your deploys and infrastructure changes overlaid on the trend charts, so a step change has a cause.',
    how: "Add a marker from a project's Timeline tab.",
    icon: 'i-lucide-git-commit-horizontal',
    doc: 'features/timeline-markers',
  },
  {
    id: 'quarantine',
    title: 'Quarantine',
    summary:
      'A known-bad test keeps running and reporting, but stops failing the CI gate — and earns its way out on a passing streak.',
    how: "Quarantine a test from its test-case page, or from the project's Quarantine tab.",
    icon: 'i-lucide-shield-alert',
    doc: 'features/flaky-tests',
  },
  {
    id: 'test-map',
    title: 'Scenario gaps',
    summary:
      'The tests you have not written yet: routes and pages your runs reach but nothing checks, ranked by exposure, each with a skeleton to start from.',
    how: "Automatic — the map builds from your runs, and gaps appear on a project's Gaps tab as reach accrues.",
    icon: 'i-lucide-map',
    doc: 'features/scenario-gaps',
  },
  {
    id: 'server-probes',
    title: 'Server probes',
    summary:
      'A fault injected inside the server for one signed request, to check whether a passing test would notice a 500, a dropped field or a slow dependency.',
    how: 'Needs a backend package in the app under test; available today for Nitro and ASP.NET Core. Turn it on per project once client probes report not-noticed.',
    icon: 'i-lucide-radar',
    experimental: true,
    experimentalNote:
      'Experimental — the entry condition (client probes reporting not-noticed on at least one pair in ten) has not been measured yet.',
    doc: 'features/probes#server-probes',
  },
  {
    id: 'bug-reports',
    title: 'Bug reports',
    summary:
      'Bugs reported from Piwi Picker with their steps, the expected result and evidence, each turned into a failing test and followed until it passes.',
    how: 'Connect Piwi Picker to this instance, then use Report a bug and Send to Piwi on the page that shows the bug.',
    icon: 'i-lucide-bug',
    doc: 'features/bug-reports',
  },
  {
    id: 'flake-lab',
    title: 'Flake suspects',
    summary:
      'For a flaky test, the requests, neighbors and load its failures share and its passes do not, each with the counts behind it and the condition that would test it.',
    how: 'Automatic — suspects appear on a flaky test’s Flakiness tab once its history holds at least three failures that share something.',
    icon: 'i-lucide-search-check',
    doc: 'features/flaky-tests',
  },
  {
    id: 'resources',
    title: 'Resources',
    summary:
      'Browsers, contexts and pages a run left open, pages opened and never used, and what the run cost its machine: CPU by process, peak memory and disk.',
    how: 'Automatic from reporter 0.45: every run sends what it cost, shown on its Resources tab. The findings need the capture fixtures.',
    icon: 'i-lucide-cpu',
    doc: 'features/resource-leaks',
  },
  {
    id: 'agent-diagnoses',
    title: 'Agent diagnoses',
    summary:
      'Diagnoses your coding agent writes on a failure cluster over MCP, stored with the model it ran on and shown as written by an agent. They need no AI provider on this instance.',
    how: 'Connect an agent through MCP; it records a diagnosis with record_diagnosis. Decline to refuse them.',
    icon: 'i-lucide-bot',
    doc: 'features/ai-diagnosis',
  },
  {
    id: 'agent-write-log',
    title: 'Agent write log',
    summary:
      'One line per write an agent makes over MCP (the key, the tool, what it acted on, the result), shown on the cluster it touched and kept as long as notifications.',
    how: 'Automatic once an agent calls a write tool. Decline to keep no log.',
    icon: 'i-lucide-scroll-text',
    doc: 'features/mcp',
  },
];
