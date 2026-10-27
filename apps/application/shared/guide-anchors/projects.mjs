/** The guide anchors of the Projects list (`/projects`) and of a project's pages (`/projects/[id]` and its sub-pages). */

const PROJECT_1 = { project: { id: 1, name: 'e2e-checkout' } };
const PROJECT_3 = { project: { id: 3, name: 'ui-components' } };
const PROJECT_5 = { project: { id: 5, name: 'web-dashboard' } };
const USERS_ENDPOINTS = {
  ...PROJECT_5,
  fileCoverage: { path: 'api/Users/UsersEndpoints.cs', tests: 3, executable: true },
};

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const PROJECTS_ANCHORS = [
  // ── The Projects list ───────────────────────────────────────────────────
  {
    id: 'projects-page',
    kind: 'page',
    pages: ['/projects'],
    describes:
      'The Projects page’s header, over the list of every project with its latest run, status and pass/fail bar, searchable by name and filtered by tag.',
    help: 'projects.table',
    doc: 'features/ui-overview#projects',
    sample: { route: '/projects' },
  },
  {
    id: 'new-project',
    kind: 'action',
    pages: ['/projects'],
    describes:
      'The New project button: a project created by hand, with its name, display label, description and tags, before a first run reports to it.',
    requires: { permission: 'project:create' },
    doc: 'features/ui-overview#projects',
    sample: { route: '/projects' },
  },
  {
    id: 'projects-tag-filter',
    kind: 'block',
    pages: ['/projects'],
    describes: 'The tag filter of the Projects page: pick tags to list the projects carrying any one of them.',
    shownWhen: 'When the instance has tags.',
    help: 'projects.tag-filter',
    doc: 'features/ui-overview#projects',
    sample: { route: '/projects' },
  },

  // ── A project's page: the header, the filters and the navbar ────────────
  {
    id: 'project-header',
    kind: 'page',
    pages: ['/projects/[id]'],
    describes:
      'The project’s header: its name, description and tags, its latest run and the pass rate of the last 20 runs, then its open clusters, flaky and quarantined tests.',
    help: 'project.status',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },
  {
    id: 'project-filters',
    kind: 'block',
    pages: ['/projects/[id]'],
    describes:
      'The project’s Filters: environment, branch and Full runs only, which scope the header and every tab that reads run history, remembered per project.',
    help: 'project.filters',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },
  {
    id: 'project-more-actions',
    kind: 'action',
    pages: ['/projects/[id]'],
    describes:
      'The project’s More actions menu: Edit, its Test functions, Selections, Locators and Coverage pages, Bug reports, a report schedule, Delete and Refresh.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },
  {
    id: 'project-schedule-report',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ open: 'project-more-actions' }],
    describes:
      'The More actions entry that schedules a quality report over the project, built and sent on a recurring schedule.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },
  {
    id: 'subscribe-bell',
    kind: 'action',
    pages: ['/projects/[id]'],
    describes:
      'The project’s bell, which opens your notification subscriptions to its runs and rings while you are subscribed.',
    requires: { capability: 'notifications' },
    doc: 'features/notifications',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },
  {
    id: 'project-subscriptions',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ open: 'subscribe-bell' }],
    describes:
      'The bell’s subscriptions to the project: the channels that hear about its runs, the events each alerts on, and the branches and environments it follows.',
    requires: { capability: 'notifications' },
    help: 'notifications.subscribe',
    doc: 'features/notifications#branches-and-environments',
    sample: { route: '/projects/1', expect: PROJECT_1 },
  },

  // ── The Runs tab ────────────────────────────────────────────────────────
  {
    id: 'project-runs-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'runs' } }],
    describes:
      'The Runs tab: the run trend over the filtered runs with its timeline markers, then the runs table, 25 runs to a page.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=runs', expect: PROJECT_1 },
  },
  {
    id: 'project-run-trend',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'runs' } }],
    describes:
      'The Run trend chart of the Runs tab: one stacked bar per filtered run, newest on the right and failed at the base, each opening its run.',
    shownWhen: 'When a run matches the filters.',
    help: 'project.runs-trend',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=runs', expect: PROJECT_1 },
  },
  {
    id: 'project-markers',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'runs' } }],
    describes:
      'The Markers button of the Run trend chart, which opens the project’s timeline markers: the deploys, config changes and incidents drawn on its charts.',
    shownWhen: 'When a run matches the filters.',
    requires: { capability: 'markers' },
    doc: 'features/timeline-markers',
    sample: { route: '/projects/1?tab=runs', expect: PROJECT_1 },
  },
  {
    id: 'project-timeline',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'runs' } }, { open: 'project-markers' }],
    describes:
      'The project’s timeline markers, in a drawer: the dated deploys, config changes and incidents drawn on its trend charts, for one environment or all.',
    requires: { capability: 'markers' },
    help: 'project.timeline',
    doc: 'features/timeline-markers',
    sample: { route: '/projects/1?tab=runs', expect: PROJECT_1 },
  },
  {
    id: 'project-runs-table',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'runs' } }],
    describes:
      'The runs table of the Runs tab: tick two runs and Compare to see what changed between them, or tick any number to delete them.',
    doc: 'features/run-changes',
    sample: { route: '/projects/1?tab=runs', expect: PROJECT_1 },
  },

  // ── The Tests tab ───────────────────────────────────────────────────────
  {
    id: 'project-tests-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'tests' } }],
    describes:
      'The Tests tab: every test of the project with its pass rate, results and average duration in file order, searchable with qualifiers such as file: or tag:.',
    help: 'project.test-cases',
    doc: 'reference/test-search',
    sample: { route: '/projects/1?tab=tests', expect: PROJECT_1 },
  },

  // ── The Failures tab and its segments ───────────────────────────────────
  {
    id: 'project-failures-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'failures' } }],
    describes:
      'The Failures tab: the project’s failure clusters, flaky tests and quarantine, one segment at a time, each with its count.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=failures', expect: PROJECT_1 },
  },
  {
    id: 'failure-clusters-list',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'failure-clusters' } }],
    describes:
      'The Clusters segment of the Failures tab: the project’s root causes, one row per failure cluster, filtered and set by triage status.',
    help: 'cluster.concept',
    doc: 'features/failure-clusters#how-failures-are-grouped',
    sample: { route: '/projects/1?tab=failure-clusters', expect: PROJECT_1 },
  },
  {
    id: 'flaky-tests-list',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flaky-tests' } }],
    describes:
      'The Flaky segment of the Failures tab: the tests that fail intermittently, ranked by the CI time their retries waste and filtered by root cause.',
    help: 'project.flaky-tests',
    doc: 'features/flaky-tests#flaky-test-detection',
    sample: { route: '/projects/1?tab=flaky-tests', expect: PROJECT_1 },
  },
  {
    id: 'flaky-test-row',
    kind: 'row',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flaky-tests' } }],
    describes:
      'A row of the project’s flaky tests, ranked by the CI time their retries waste, with its 0–100 flaky score and its top suspect.',
    shownWhen: 'When a test of the project flaked in its recent runs.',
    doc: 'features/flaky-tests',
    sample: { route: '/projects/1?tab=flaky-tests', expect: PROJECT_1 },
  },
  {
    id: 'flaky-test-quarantine',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flaky-tests' } }],
    describes:
      'The Quarantine button of a flaky test, which keeps it running but out of the CI gate’s verdict; hovering it previews the lines no other trusted test runs.',
    shownWhen: 'When a test of the project flaked in its recent runs.',
    requires: { permission: 'quarantine:write' },
    help: 'quarantine.coverage-loss',
    doc: 'features/coverage-insights#what-quarantining-or-deleting-tests-leaves-uncovered',
    sample: { route: '/projects/1?tab=flaky-tests', expect: PROJECT_1 },
  },
  {
    id: 'quarantine-list',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'quarantine' } }],
    describes:
      'The Quarantine segment of the Failures tab: the tests left out of the CI gate’s verdict, each with its passing streak toward release and its age.',
    requires: { capability: 'quarantine' },
    help: 'project.quarantine',
    doc: 'features/flaky-tests#quarantine-with-a-way-out',
    sample: { route: '/projects/1?tab=quarantine', expect: PROJECT_1 },
  },
  {
    id: 'quarantine-release',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'quarantine' } }],
    describes:
      'The Release button of a quarantined test, which returns it to the CI gate, highlighted once its passing streak or a verified fix makes it ready.',
    shownWhen: 'When the project has a quarantined test.',
    requires: { capability: 'quarantine', permission: 'quarantine:write' },
    doc: 'features/flaky-tests#quarantine-with-a-way-out',
    sample: { route: '/projects/1?tab=quarantine', expect: PROJECT_1 },
  },

  // ── The Flake Lab tab ───────────────────────────────────────────────────
  {
    id: 'project-flake-lab-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flake-lab' } }],
    describes:
      'The Flake Lab tab: where each flaky test of the project stands in the lab, the command it needs next, and the project’s newest experiments.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flake-lab',
    sample: { route: '/projects/3?tab=flake-lab', expect: PROJECT_3 },
  },
  {
    id: 'flake-lab-tests',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flake-lab' } }],
    describes:
      'The Flake Lab tab’s list of the project’s flaky tests, each with the state its experiments reached, such as Reproduced or Verified fixed.',
    shownWhen: 'When a test of the project flaked in its recent runs or has an experiment.',
    requires: { capability: 'flake-lab' },
    help: 'project.flake-lab',
    doc: 'features/flake-lab',
    sample: { route: '/projects/3?tab=flake-lab', expect: PROJECT_3 },
  },
  {
    id: 'flake-lab-copy-command',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flake-lab' } }],
    describes:
      'The Copy command button of a Flake Lab test: the piwi flake command that reproduces it, or verifies its fix, to run from the project root.',
    shownWhen: 'When a test of the lab has a next step.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flake-lab#run-an-experiment',
    sample: { route: '/projects/3?tab=flake-lab', expect: PROJECT_3 },
  },
  {
    id: 'flake-lab-experiments',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flake-lab' } }],
    describes:
      'The Experiments of the Flake Lab tab: the project’s newest piwi flake runs, each with its control, its arms and the verdict it reached.',
    requires: { capability: 'flake-lab' },
    help: 'case.flake-experiments',
    doc: 'features/flake-lab#reading-the-verdict',
    sample: { route: '/projects/3?tab=flake-lab', expect: PROJECT_3 },
  },

  // ── The Gaps tab ────────────────────────────────────────────────────────
  {
    id: 'project-gaps-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'gaps' } }],
    describes:
      'The Gaps tab: the tests the suite does not have yet, proposed from the Test Map and ranked by exposure, with the feature map and its graph.',
    requires: { capability: 'test-map' },
    help: 'project.gaps',
    doc: 'features/scenario-gaps',
    sample: { route: '/projects/1?tab=gaps', expect: PROJECT_1 },
  },
  {
    id: 'feature-map',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'gaps' } }],
    describes:
      'The feature map of the Gaps tab: the features the Test Map draws from the routes and pages each feature’s tests reach.',
    shownWhen: 'When tests of the project are tagged with piwi:feature.',
    requires: { capability: 'test-map' },
    doc: 'features/scenario-gaps',
    sample: { route: '/projects/1?tab=gaps', expect: PROJECT_1 },
  },

  // ── The Performance tab ─────────────────────────────────────────────────
  {
    id: 'project-performance-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'performance' } }],
    describes:
      'The Performance tab: duration trends per run, the slowest tests, the timeout opportunities and the slow endpoints of one run.',
    doc: 'features/slow-tests',
    sample: { route: '/projects/1?tab=performance', expect: PROJECT_1 },
  },
  {
    id: 'project-performance-trend',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'performance' } }],
    describes:
      'The Performance trend chart: the average and P90 test durations of each run over the last 20 to 200 runs, with the timeline markers.',
    help: 'project.performance',
    doc: 'features/slow-tests#duration-trends',
    sample: { route: '/projects/1?tab=performance', expect: PROJECT_1 },
  },
  {
    id: 'slowest-tests',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'performance' } }],
    describes:
      'The heading of Slowest tests on the Performance tab: the project’s 20 slowest tests by average duration over recent runs.',
    help: 'project.slowest-tests',
    doc: 'features/slow-tests',
    sample: { route: '/projects/1?tab=performance', expect: PROJECT_1 },
  },
  {
    id: 'project-slow-endpoints',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'performance' } }],
    describes:
      'The Slow endpoints card of the Performance tab: the backend routes one run exercised, per route and ranked by time, from the Piwi capture fixtures.',
    requires: { capability: 'fixtures' },
    help: 'project.slow-endpoints',
    doc: 'features/slow-tests',
    sample: { route: '/projects/1?tab=performance', expect: PROJECT_1 },
  },

  // ── The Settings tab and its sections ───────────────────────────────────
  {
    id: 'project-settings-tab',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings' } }],
    describes:
      'The Settings tab: the project’s settings one section at a time, picked from a menu beside it, each section saving on its own.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=settings', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-general',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'general' } }],
    describes:
      'The General section of the project’s Settings: the project key, its label, description and tags, and the link its tests’ external IDs open.',
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=settings&section=general', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-save',
    kind: 'action',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'general' } }],
    describes:
      'The Save changes button of the General section, enabled once a field changed; each section of the project’s Settings saves on its own.',
    requires: { permission: 'project:manage' },
    doc: 'features/ui-overview#project-detail',
    sample: { route: '/projects/1?tab=settings&section=general', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-members',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'members' } }],
    describes:
      'The Members section of the project’s Settings: the users and groups holding a role on the project, granted here or on All projects.',
    shownWhen: 'When authentication is on.',
    requires: { permission: 'project:members' },
    help: 'project.members',
    doc: 'operate/project-access#who-manages-access',
    sample: { route: '/projects/1?tab=settings&section=members', persona: 1, expect: PROJECT_1 },
  },
  {
    id: 'project-settings-source-control',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'source-control' } }],
    describes:
      'The Source control section: the project’s repository, SCM token, default branch, commit and gate statuses, CI re-run and generated specs.',
    doc: 'guide/source-control',
    sample: { route: '/projects/1?tab=settings&section=source-control', expect: PROJECT_1 },
  },
  {
    id: 'project-scm-token',
    kind: 'field',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'source-control' } }],
    describes:
      'The project’s SCM token: a read-only Git host token, stored encrypted, that lets diagnosis read the commits behind a failure.',
    help: 'project.scm-token',
    doc: 'guide/source-control',
    sample: { route: '/projects/1?tab=settings&section=source-control', expect: PROJECT_1 },
  },
  {
    id: 'project-ci-rerun',
    kind: 'field',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'source-control' } }],
    describes:
      'The CI re-run setting: the GitHub workflow or the GitLab or Bitbucket pipeline that re-runs a cluster’s tests from its page, or a Flake Lab experiment.',
    help: 'project.ci-rerun',
    doc: 'features/pr-feedback#re-run-from-the-dashboard',
    sample: { route: '/projects/1?tab=settings&section=source-control', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-ai',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'ai' } }],
    describes:
      'The AI diagnosis section of the project’s Settings: the instructions the AI reads with the project’s failures, and the language it answers in.',
    doc: 'features/ai-diagnosis#custom-instructions',
    sample: { route: '/projects/1?tab=settings&section=ai', expect: PROJECT_1 },
  },
  {
    id: 'project-ai-instructions',
    kind: 'field',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'ai' } }],
    describes:
      'The project’s AI instructions, read with the global ones from Settings → AI: domain terms, known-flaky areas, or where to look first.',
    help: 'project.ai-instructions',
    doc: 'features/ai-diagnosis#custom-instructions',
    sample: { route: '/projects/1?tab=settings&section=ai', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-capabilities',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'capabilities' } }],
    describes:
      'The Capabilities section: the project’s overrides of the instance’s capability defaults, and what its Gaps tab compares the tests against.',
    doc: 'operate/capabilities',
    sample: { route: '/projects/1?tab=settings&section=capabilities', expect: PROJECT_1 },
  },
  {
    id: 'project-capabilities',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'capabilities' } }],
    describes:
      'The project’s capability overrides: each capability left on the instance default, declined for the project or enabled for it, applied at once.',
    requires: { permission: 'project:manage' },
    help: 'project.capabilities',
    doc: 'operate/capabilities',
    sample: { route: '/projects/1?tab=settings&section=capabilities', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-coverage',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'coverage' } }],
    describes:
      'The Coverage section: the areas of the code counted apart, such as front and back, and the patterns of the files coverage includes or leaves out.',
    requires: { capability: 'coverage', permission: 'project:manage' },
    help: 'coverage.areas',
    doc: 'features/combined-coverage#areas',
    sample: { route: '/projects/1?tab=settings&section=coverage', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-targets',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'targets' } }],
    describes:
      'The Targets section: the pass rate to reach and the limits on flaky tests, wasted CI minutes, open failure age and time to fix the project is held to.',
    requires: { permission: 'project:manage' },
    help: 'project.targets',
    doc: 'features/analytics#targets',
    sample: { route: '/projects/1?tab=settings&section=targets', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-issue-tracker',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'issue-tracker' } }],
    describes:
      'The Issue tracker section: the Jira project and issue type the project’s failures are filed into, what a ticket carries, and how it is kept in sync.',
    requires: { permission: 'project:manage' },
    doc: 'features/issue-tracking#the-project-binding',
    sample: { route: '/projects/1?tab=settings&section=issue-tracker', expect: PROJECT_1 },
  },
  {
    id: 'issue-tracker-required-fields',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'issue-tracker' } }],
    describes:
      'The Jira fields of the project’s binding: the fields its issue type requires beyond what Piwi fills, with the value every issue of the project gets.',
    shownWhen: 'When the binding names a connection, a Jira project and an issue type.',
    requires: { permission: 'project:manage' },
    help: 'integrations.required-fields',
    doc: 'features/issue-tracking#required-jira-fields',
    sample: { route: '/projects/1?tab=settings&section=issue-tracker', persona: 1, expect: PROJECT_1 },
  },
  {
    id: 'issue-tracker-run-scope',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'issue-tracker' } }],
    describes:
      'The runs that write to a tracked ticket: the branches and environments whose results comment on, move or update it, every run when none is named.',
    shownWhen: 'When a tracker connection exists.',
    requires: { permission: 'project:manage' },
    help: 'integrations.run-scope',
    doc: 'features/issue-automation#the-runs-that-write',
    sample: { route: '/projects/1?tab=settings&section=issue-tracker', expect: PROJECT_1 },
  },
  {
    id: 'issue-tracker-auto-create',
    kind: 'block',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'issue-tracker' } }],
    describes:
      'Automatic creation: the rules by which each run files an issue for a failure on its own, the daily cap, and a preview of what they would file now.',
    shownWhen: 'When a tracker connection exists.',
    requires: { permission: 'project:manage' },
    help: 'integrations.auto-create',
    doc: 'features/issue-automation#automatic-creation',
    sample: { route: '/projects/1?tab=settings&section=issue-tracker', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-browser-extension',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'browser-extension' } }],
    describes:
      'The Browser extension URLs section: the addresses the project’s application runs at, which tell Piwi Picker the project a page belongs to.',
    requires: { permission: 'project:manage' },
    help: 'project.url-patterns',
    doc: 'features/extension-connection#url-patterns',
    sample: { route: '/projects/1?tab=settings&section=browser-extension', expect: PROJECT_1 },
  },
  {
    id: 'project-settings-local-folder',
    kind: 'tab',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'settings', section: 'local-folder' } }],
    describes:
      'The Local folder section of the desktop app: the checkout on this machine that runs the project’s tests and opens its files in your IDE.',
    requires: { desktop: true },
    help: 'project.local-folder',
    doc: 'features/desktop#running-tests-from-the-app',
    sample: { route: '/projects/1?tab=settings&section=local-folder', expect: PROJECT_1, surface: 'desktop' },
  },

  // ── The coverage page ───────────────────────────────────────────────────
  {
    id: 'project-coverage-page',
    kind: 'page',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The project’s coverage page: every suite’s coverage of one commit combined, by area and through the file tree, or one file with the lines its tests ran.',
    doc: 'features/combined-coverage',
    sample: { route: '/projects/5/coverage', expect: PROJECT_5 },
  },
  {
    id: 'coverage-overview',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The Combined coverage card: the share of lines the unit suites and the Playwright run of one commit ran together, then each suite’s share.',
    shownWhen: 'When a suite uploaded a coverage report or a run recorded run coverage for the project.',
    requires: { capability: 'coverage' },
    help: 'coverage.combined',
    doc: 'features/combined-coverage',
    sample: {
      route: '/projects/5/coverage',
      expect: { ...PROJECT_5, combinedCoverage: { suites: 3, filesWithoutData: 2 } },
    },
  },
  {
    id: 'coverage-notes',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The note on what a commit’s coverage numbers leave out or take from elsewhere, such as a suite carried from an earlier commit or an incomplete report.',
    shownWhen: 'When the commit’s coverage carries a suite from elsewhere or misses data.',
    requires: { capability: 'coverage' },
    help: 'coverage.notes',
    doc: 'features/combined-coverage#what-the-numbers-leave-out',
    sample: {
      route: '/projects/5/coverage?branch=develop',
      expect: { ...PROJECT_5, supersededCoverage: { branch: 'develop', carried: 'unit-back' } },
    },
  },
  {
    id: 'coverage-class-legend',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The key to the coverage colors: the lines both kinds of suite ran, unit tests only, end-to-end tests only, undetermined, and the lines no suite ran.',
    requires: { capability: 'coverage' },
    help: 'coverage.combined-marks',
    doc: 'features/combined-coverage#find-what-is-not-covered',
    sample: { route: '/projects/5/coverage', expect: PROJECT_5 },
  },
  {
    id: 'coverage-areas',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The Areas card of the coverage page: each area of the code the project names, with the share of its lines that ran and each suite’s share.',
    shownWhen: 'When the project’s coverage settings name areas.',
    requires: { capability: 'coverage' },
    help: 'coverage.areas',
    doc: 'features/combined-coverage#areas',
    sample: { route: '/projects/5/coverage', expect: PROJECT_5 },
  },
  {
    id: 'coverage-files',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The Files card of the coverage page: the repository as a tree at the commit, each folder and file barred by the kinds of suite that ran its lines.',
    shownWhen: 'When the commit keeps its file detail.',
    requires: { capability: 'coverage' },
    help: 'coverage.tree',
    doc: 'features/combined-coverage#find-what-is-not-covered',
    sample: { route: '/projects/5/coverage', expect: PROJECT_5 },
  },
  {
    id: 'coverage-least-covered',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'Least covered here, beside the file tree: the files of the selected folder with the most lines no suite ran, each opening on the next lines to cover.',
    shownWhen: 'When a file of the selected folder has lines no suite ran.',
    requires: { capability: 'coverage' },
    help: 'coverage.least-covered',
    doc: 'features/combined-coverage#find-what-is-not-covered',
    sample: { route: '/projects/5/coverage', expect: PROJECT_5 },
  },
  {
    id: 'coverage-file-heading',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The heading of a file’s coverage: its path, the tests that run it on the branch, the version shown, and whether its lines are marked by test or by suite.',
    requires: { capability: 'coverage' },
    help: 'coverage.file',
    doc: 'features/code-reach#which-tests-run-a-file',
    sample: { route: '/projects/5/coverage?file=api/Users/UsersEndpoints.cs', expect: USERS_ENDPOINTS },
  },
  {
    id: 'coverage-source-marks',
    kind: 'block',
    pages: ['/projects/[id]/coverage', '/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The key over a covered file’s source: the teal bar of a line a test ran, and the slate bar of an executable line no test ran.',
    shownWhen: 'When the source of the file’s version can be read.',
    requires: { capability: 'coverage' },
    help: 'coverage.marks',
    doc: 'features/editor-coverage#the-marks',
    sample: { route: '/projects/5/coverage?file=api/Users/UsersEndpoints.cs', expect: USERS_ENDPOINTS },
  },
  {
    id: 'coverage-file-test-map',
    kind: 'block',
    pages: ['/projects/[id]/coverage'],
    describes:
      'In the Test Map, beside a file’s coverage: the routes and pages the Test Map ties to the file, with the open scenario gaps of each.',
    shownWhen: 'When the Test Map ties the file to a route or a page.',
    requires: { capability: 'test-map' },
    help: 'coverage.test-map',
    doc: 'guide/concepts#coverage-and-the-test-map',
    sample: { route: '/projects/5/coverage?file=api/Users/UsersEndpoints.cs', expect: USERS_ENDPOINTS },
  },

  // ── The Locators, Selections and Test functions pages ───────────────────
  {
    id: 'project-locators-page',
    kind: 'page',
    pages: ['/projects/[id]/locators'],
    describes:
      'The project’s Locators page: pasted locators checked against the chains its tests use, and the index of every chain, for one branch or all.',
    doc: 'features/locator-usage#the-locators-page',
    sample: { route: '/projects/1/locators' },
  },
  {
    id: 'locator-check',
    kind: 'block',
    pages: ['/projects/[id]/locators'],
    describes:
      'Check locators: paste locators, one per line as Piwi Picker copies them, or lines of test code, to list the tests reaching each one.',
    help: 'project.locator-check',
    doc: 'features/locator-usage#the-locators-page',
    sample: { route: '/projects/1/locators' },
  },
  {
    id: 'locator-index',
    kind: 'block',
    pages: ['/projects/[id]/locators'],
    describes:
      'Locators your tests use: every locator chain the steps of the project’s runs recorded, the ones shared by the most tests first, with the tests using each.',
    help: 'project.locator-index',
    doc: 'features/locator-usage#branches',
    sample: { route: '/projects/1/locators' },
  },
  {
    id: 'project-selections-page',
    kind: 'page',
    pages: ['/projects/[id]/selections'],
    describes:
      'The project’s Selections page: the named subsets of the suite resolved from its run history, which piwi run and piwi select run.',
    doc: 'features/test-selection',
    sample: { route: '/projects/1/selections' },
  },
  {
    id: 'project-test-functions-page',
    kind: 'page',
    pages: ['/projects/[id]/test-functions'],
    describes:
      'The project’s Test functions page: the page-object methods and helpers a recording is matched against, to call your own code instead of raw locators.',
    doc: 'features/test-functions',
    sample: { route: '/projects/1/test-functions' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const PROJECTS_EXEMPTIONS = [
  {
    rule: 'page',
    key: '/projects/[id]/compare',
    reason: 'It only redirects to the project’s Runs tab, where ticking two runs compares them.',
  },
  {
    rule: 'page',
    key: '/projects/[id]/edit',
    reason: 'It only redirects to the project’s Settings tab, which holds the edit form.',
  },
  {
    rule: 'page',
    key: '/projects/[id]/test-cases',
    reason: 'It only redirects to the project’s Tests tab, with its query.',
  },
  {
    rule: 'help',
    key: 'coverage.file-source',
    reason:
      'The note shows only when no source can be read for a file a test recorded by line, and the demo’s canned repository holds every such file.',
  },
];
