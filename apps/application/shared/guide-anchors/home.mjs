/** The guide anchors of Home (`/`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const HOME_ANCHORS = [
  {
    id: 'home-page',
    kind: 'page',
    pages: ['/'],
    describes:
      'Home, the health check across projects: the filters, the stat strip, Project health beside the recent activity, then the Failure inbox.',
    doc: 'features/ui-overview#home',
    sample: { route: '/' },
  },
  {
    id: 'project-health',
    kind: 'block',
    pages: ['/'],
    describes:
      'The Project health table: each project’s last 20 runs, its tendency and the pass rate of its latest run, failing projects first.',
    shownWhen: 'When the instance has at least one project.',
    help: 'home.project-health',
    doc: 'features/ui-overview#home',
    sample: { route: '/' },
  },
  {
    id: 'failure-inbox',
    kind: 'block',
    pages: ['/'],
    describes:
      'The Failure inbox: the open failure clusters you still owe a decision, in queues such as new, mine or regressions, triaged from the keyboard.',
    shownWhen: 'When the instance has at least one project.',
    help: 'home.failure-inbox',
    doc: 'features/failure-clusters#the-failure-inbox',
    sample: { route: '/' },
  },
  {
    id: 'failure-inbox-row',
    kind: 'row',
    pages: ['/'],
    describes:
      'A row of the Failure inbox: one open failure cluster across the projects, however many tests it breaks, triaged from the keyboard.',
    shownWhen: 'When at least one failure cluster is open.',
    doc: 'features/failure-clusters#the-failure-inbox',
    sample: { route: '/' },
  },
  {
    id: 'failure-inbox-triage',
    kind: 'block',
    pages: ['/'],
    describes:
      'The Failure inbox’s keyboard line: j and k move between rows, and one key resolves, ignores, quarantines, assigns, snoozes or links the selected cluster.',
    shownWhen: 'On a screen with a pointer, when you can triage a row of the inbox.',
    requires: { permission: 'triage:write' },
    doc: 'features/failure-clusters#triage-from-the-row-or-the-keyboard',
    sample: { route: '/' },
  },
  {
    id: 'flake-lab-inbox',
    kind: 'block',
    pages: ['/'],
    describes:
      'The flaky tests waiting in the Flake Lab: a reproduced flake whose fix waits for a verify, then a flaky test whose top suspect is untested.',
    shownWhen: 'When a flaky test waits for its next Flake Lab experiment.',
    requires: { capability: 'flake-lab' },
    help: 'home.flake-lab',
    doc: 'features/flake-lab#from-the-editor-and-the-failure-pages',
    sample: { route: '/' },
  },
  {
    id: 'flake-lab-inbox-command',
    kind: 'action',
    pages: ['/'],
    describes:
      'The Copy command button of a Flake Lab inbox row: the command that runs the test’s next experiment from the project root.',
    shownWhen: 'When a flaky test waits for its next Flake Lab experiment.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flake-lab#from-the-editor-and-the-failure-pages',
    sample: { route: '/' },
  },
  {
    id: 'get-started-wizard',
    kind: 'block',
    pages: ['/setup', '/'],
    describes:
      'The Get started wizard: the one-command init, then the steps that install the reporter, wire the Playwright config and send a first run.',
    shownWhen: 'On Setup, and on Home while the instance has no project.',
    help: 'home.get-started',
    doc: 'guide/reporter',
    sample: { route: '/setup' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const HOME_EXEMPTIONS = [];
