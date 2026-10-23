/** The guide anchors of the layout around every page: the sidebar, its destinations, the command palette and the user menu. */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const LAYOUT_ANCHORS = [
  {
    id: 'nav-home',
    kind: 'nav',
    pages: ['*'],
    describes: 'The sidebar’s Home link: the health check across every project, ending on the inbox of open failures.',
    doc: 'features/ui-overview#home',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-analytics',
    kind: 'nav',
    pages: ['*'],
    describes:
      'The sidebar’s Analytics link: trends across the projects and over time, on the Overview dashboard and the saved ones.',
    doc: 'features/ui-overview#analytics',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-quality-reports',
    kind: 'nav',
    pages: ['*'],
    describes:
      'The sidebar’s Quality reports link: the report snapshots kept and the schedules that build and send them.',
    requires: { capability: 'quality-reports' },
    doc: 'features/ui-overview#quality-reports',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-projects',
    kind: 'nav',
    pages: ['*'],
    describes: 'The sidebar’s Projects link: every project with its last run, searchable and filtered by tag.',
    doc: 'features/ui-overview#projects',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-project',
    kind: 'nav',
    pages: ['*'],
    describes:
      'A project’s link in the sidebar, listed under Active or Others, whose status badge opens the project’s latest run.',
    shownWhen: 'When the instance has at least one project.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-api-docs',
    kind: 'nav',
    pages: ['*'],
    describes: 'The sidebar’s API Docs link: this instance’s own OpenAPI reference of every REST endpoint.',
    doc: 'features/ui-overview#settings',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-setup',
    kind: 'nav',
    pages: ['*'],
    describes: 'The sidebar’s Setup link: how results reach this instance, and which optional capabilities it uses.',
    requires: { permission: 'settings:manage' },
    doc: 'features/ui-overview#setup',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-mcp',
    kind: 'nav',
    pages: ['*'],
    describes:
      'The sidebar’s MCP server link: the configuration that connects Claude Code, Cursor or another MCP client to this instance.',
    requires: { capability: 'mcp' },
    doc: 'features/mcp',
    sample: { route: '/projects' },
  },
  {
    id: 'nav-documentation',
    kind: 'nav',
    pages: ['*'],
    describes: 'The sidebar’s Documentation link, which opens the Piwi docs in a new tab.',
    doc: 'features/ui-overview',
    sample: { route: '/projects' },
  },
  {
    id: 'command-palette',
    kind: 'action',
    pages: ['*'],
    describes:
      'The search button that opens the command palette (Ctrl+K): go to any page, or find a project, run, test or failure cluster.',
    doc: 'reference/keyboard-shortcuts#anywhere',
    sample: { route: '/projects' },
  },
  {
    id: 'user-menu',
    kind: 'action',
    pages: ['*'],
    describes:
      'The user menu at the foot of the sidebar: the settings pages, the theme, Open in IDE and the Piwi tools to install.',
    doc: 'features/ui-overview#settings',
    sample: { route: '/projects' },
  },
  {
    id: 'user-menu-open-in-ide',
    kind: 'action',
    pages: ['*'],
    reveal: [{ open: 'user-menu' }],
    describes:
      'The user menu’s Open in IDE entry, which sets how a source path clicked in the dashboard opens in your editor.',
    doc: 'features/ide-integration#set-it-up',
    sample: { route: '/projects' },
  },
  {
    id: 'open-in-ide-settings',
    kind: 'block',
    pages: ['*'],
    reveal: [{ open: 'user-menu' }, { open: 'user-menu-open-in-ide' }],
    describes:
      'The Open in IDE settings: the editor, workspace root and method a clicked source path opens with, kept in this browser.',
    help: 'ide.open',
    doc: 'features/ide-integration#set-it-up',
    sample: { route: '/projects' },
  },
  {
    id: 'app-version',
    kind: 'nav',
    pages: ['*'],
    describes:
      'The version this instance runs, at the foot of the sidebar, which opens Settings → About and its build details.',
    shownWhen: 'When the sidebar is expanded.',
    doc: 'operate/upgrading',
    sample: { route: '/projects' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const LAYOUT_EXEMPTIONS = [];
