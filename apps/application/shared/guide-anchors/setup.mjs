/**
 * The guide anchors of the pages that connect things to the instance and take
 * things in: Setup (`/setup`), the MCP server (`/mcp`), the API reference
 * (`/docs`), a project's bug reports and imports, and a bug report's page.
 */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const SETUP_ANCHORS = [
  {
    id: 'setup-page',
    kind: 'page',
    pages: ['/setup'],
    describes:
      'The Setup page: the steps that get results to this instance, what you want Piwi for, which optional capabilities it uses and the tools to install.',
    requires: { permission: 'settings:manage' },
    doc: 'features/ui-overview#setup',
    sample: { route: '/setup' },
  },
  {
    id: 'capability-presets',
    kind: 'block',
    pages: ['/setup'],
    describes:
      'The What do you want Piwi for card: the groups of capabilities this instance uses; unchecking one declines its capabilities everywhere.',
    requires: { permission: 'settings:manage' },
    help: 'setup.presets',
    doc: 'operate/capabilities',
    sample: { route: '/setup' },
  },
  {
    id: 'setup-ladder',
    kind: 'block',
    pages: ['/setup'],
    describes:
      'The heading of What’s switched on: every optional capability, whether this instance uses it, and what each of the others needs.',
    requires: { permission: 'settings:manage' },
    doc: 'operate/capabilities',
    sample: { route: '/setup' },
  },
  {
    id: 'mcp-page',
    kind: 'page',
    pages: ['/mcp'],
    describes:
      'The MCP server page: how to connect Claude Code, Cursor, VS Code or another MCP client to this instance, the tools it serves and how clients sign in.',
    requires: { capability: 'mcp' },
    doc: 'features/mcp',
    sample: { route: '/mcp' },
  },
  {
    id: 'mcp-setup',
    kind: 'block',
    pages: ['/mcp'],
    describes:
      'The Client setup card: the configuration that connects Claude Code, Cursor, VS Code or another MCP client to this instance.',
    requires: { capability: 'mcp' },
    help: 'mcp.client-setup',
    doc: 'features/mcp',
    sample: { route: '/mcp' },
  },
  {
    id: 'mcp-tools',
    kind: 'block',
    pages: ['/mcp'],
    describes:
      'The What it provides card: the MCP tools this instance serves, grouped by module, and the switch that narrows a client to the core tools.',
    requires: { capability: 'mcp' },
    help: 'mcp.tools',
    doc: 'features/mcp#what-it-provides',
    sample: { route: '/mcp' },
  },
  {
    id: 'mcp-skills',
    kind: 'block',
    pages: ['/mcp'],
    describes:
      'The Agent skills card: the SKILL.md workflows the reporter CLI installs in a test project, such as investigating a failed run.',
    requires: { capability: 'mcp' },
    help: 'mcp.skills',
    doc: 'features/agent-skills',
    sample: { route: '/mcp' },
  },
  {
    id: 'mcp-auth',
    kind: 'block',
    pages: ['/mcp'],
    describes:
      'The Authentication card: how an MCP client proves who it is, by signing in through OAuth in the browser or with an API key.',
    requires: { capability: 'mcp' },
    help: 'mcp.auth',
    doc: 'features/mcp#authentication',
    sample: { route: '/mcp' },
  },
  {
    id: 'api-reference-page',
    kind: 'page',
    pages: ['/docs'],
    describes:
      'The API Reference page: this instance’s OpenAPI reference of every REST endpoint, with its parameters, its responses and a form to try it out.',
    doc: 'features/ui-overview#settings',
    sample: { route: '/docs' },
  },
  {
    id: 'bug-report-list',
    kind: 'page',
    pages: ['/projects/[id]/bug-reports'],
    describes:
      'A project’s Bug reports: each bug sent from Piwi Picker, newest first, with the page it happened on, who reported it, its last try and its status.',
    requires: { capability: 'bug-reports' },
    help: 'project.bug-reports',
    doc: 'features/bug-reports#the-report-s-page',
    sample: { route: '/projects/1/bug-reports' },
  },
  {
    id: 'bug-report-summary',
    kind: 'page',
    pages: ['/bug-reports/[id]'],
    describes:
      'The bug report’s summary: what the tester expected and what the page showed, where the report stands, what to do next and why no test caught it.',
    help: 'project.bug-reports',
    doc: 'features/bug-reports#the-report-s-page',
    sample: { route: '/bug-reports/1' },
  },
  {
    id: 'bug-report-create-issue',
    kind: 'action',
    pages: ['/bug-reports/[id]'],
    describes:
      'The bug report’s Create issue button: files the report in the connected issue tracker, with its steps, its evidence and the failing test.',
    shownWhen: 'When an issue tracker is connected and the report has no issue yet.',
    requires: { permission: 'issue:create' },
    doc: 'features/bug-reports#filing-it-in-jira',
    sample: { route: '/bug-reports/1' },
  },
  {
    id: 'bug-report-steps',
    kind: 'tab',
    pages: ['/bug-reports/[id]'],
    reveal: [{ query: { tab: 'steps' } }],
    describes:
      'The Steps tab: the report’s steps in words, each marked step with its expected result, the value the page showed and the tester’s note.',
    doc: 'features/bug-reports#the-report-s-page',
    sample: { route: '/bug-reports/1?tab=steps' },
  },
  {
    id: 'bug-report-evidence',
    kind: 'tab',
    pages: ['/bug-reports/[id]'],
    reveal: [{ query: { tab: 'evidence' } }],
    describes:
      'The Evidence tab: the screenshots, the page as each step began, the failed requests, the console entries and the outline of the page.',
    doc: 'features/bug-reports#the-report-s-page',
    sample: { route: '/bug-reports/1?tab=evidence' },
  },
  {
    id: 'bug-report-reproductions',
    kind: 'tab',
    pages: ['/bug-reports/[id]'],
    reveal: [{ query: { tab: 'reproductions' } }],
    describes:
      'The Reproductions tab: each time someone replayed the report in a browser or ran it with Playwright, with what they found.',
    doc: 'features/bug-reports#replaying-a-report-from-piwi',
    sample: { route: '/bug-reports/1?tab=reproductions' },
  },
  {
    id: 'bug-report-spec',
    kind: 'tab',
    pages: ['/bug-reports/[id]'],
    reveal: [{ query: { tab: 'spec' } }],
    describes:
      'The Spec tab: the steps written as a Playwright test with the project’s settings, to commit marked test.fail() or to run as it is.',
    help: 'bug-report.spec',
    doc: 'features/bug-reports#the-failing-test',
    sample: { route: '/bug-reports/1?tab=spec' },
  },
  {
    id: 'import-runs',
    kind: 'page',
    pages: ['/projects/[id]/import'],
    describes:
      'The Import past runs page: upload the archives Playwright’s blob reporter writes, to backfill the project with runs from before Piwi.',
    requires: { permission: 'storage:manage' },
    help: 'project.import',
    doc: 'guide/importing-runs',
    sample: { route: '/projects/1/import' },
  },
  {
    id: 'import-choose-files',
    kind: 'action',
    pages: ['/projects/[id]/import'],
    describes:
      'The Choose files button of Import past runs: picks the report-*.zip archives to import, one run each; they can also be dropped on the page.',
    requires: { permission: 'storage:manage' },
    doc: 'guide/importing-runs#importing-them',
    sample: { route: '/projects/1/import' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const SETUP_EXEMPTIONS = [
  {
    rule: 'page',
    key: '/login',
    reason: 'The sign-in page has no dashboard layout and shows only to someone signed out, before any guide can run.',
  },
  {
    rule: 'page',
    key: '/forgot-password',
    reason: 'The password reset request page has no dashboard layout and shows only to someone signed out.',
  },
  {
    rule: 'page',
    key: '/reset-password',
    reason: 'The new password page has no dashboard layout and opens only from the link of a password reset email.',
  },
  {
    rule: 'page',
    key: '/oauth/consent',
    reason:
      'The MCP client consent page has no dashboard layout and opens only from a client’s sign-in, with the request it made.',
  },
  {
    rule: 'page',
    key: '/extension/connect',
    reason:
      'The connect page has no dashboard layout and opens only from Piwi Picker or an editor, with the one-time code it shows.',
  },
];
