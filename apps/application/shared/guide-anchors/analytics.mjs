/** The guide anchors of Analytics: the dashboards and the quality reports. */

/** The pages a dashboard renders on: `/analytics` opens your default dashboard, Overview unless you picked another. */
const DASHBOARD_PAGES = ['/analytics', '/analytics/d/[id]'];
/** The pages of what only another dashboard than Overview shows: its own page, and `/analytics` when it is your default. */
const OTHER_DASHBOARD_PAGES = ['/analytics/d/[id]', '/analytics'];

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const ANALYTICS_ANCHORS = [
  // ── A dashboard: its header and its Filters block ───────────────────────
  {
    id: 'analytics-page',
    kind: 'page',
    pages: DASHBOARD_PAGES,
    describes:
      'An analytics dashboard: its header with the switcher and the dashboard’s actions, the Filters block that scopes every widget, and its bands of widgets.',
    doc: 'features/dashboards',
    sample: { route: '/analytics' },
  },
  {
    id: 'dashboard-switcher',
    kind: 'action',
    pages: DASHBOARD_PAGES,
    describes:
      'The dashboard switcher in the header: every dashboard you can open, built-in, shared and personal, with a search and Manage dashboards.',
    doc: 'features/dashboards#built-in-and-saved-dashboards',
    sample: { route: '/analytics' },
  },
  {
    id: 'dashboard-edit',
    kind: 'action',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Edit button, which turns a saved dashboard into its editor: band titles, Add widget, each widget’s menu and the Default filters.',
    shownWhen: 'On a saved dashboard you can change: one you own, or any of them for an administrator.',
    doc: 'features/dashboards#editing-a-dashboard',
    sample: { route: '/analytics/d/1' },
  },
  {
    id: 'dashboard-export',
    kind: 'action',
    pages: DASHBOARD_PAGES,
    describes:
      'The Export button, which previews the dashboard’s scope as a quality report to download as PDF, HTML, Markdown, Excel or JSON.',
    requires: { capability: 'quality-reports' },
    doc: 'features/quality-reports#exporting-a-report',
    sample: { route: '/analytics' },
  },
  {
    id: 'dashboard-schedule',
    kind: 'action',
    pages: DASHBOARD_PAGES,
    describes:
      'The Schedule… button, which creates a report schedule on this dashboard and its scope, sent on a cadence to its channels.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    doc: 'features/dashboards#scheduling-and-exporting-a-dashboard',
    sample: { route: '/analytics' },
  },
  {
    id: 'dashboard-hidden-projects',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The count of the projects in the dashboard’s scope you cannot open, which no widget shows, since a dashboard grants no access.',
    shownWhen: 'When the dashboard’s scope holds a project you cannot open.',
    help: 'dashboards.hidden-projects',
    doc: 'features/dashboards#sharing-and-access',
    sample: { route: '/analytics', persona: 3 },
  },
  {
    id: 'analytics-filters',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Filters block that scopes every widget: the period and its comparison, the projects, environments and branches of the runs, and the tests.',
    doc: 'features/analytics#scope',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-period-button',
    kind: 'action',
    pages: DASHBOARD_PAGES,
    describes:
      'The period button of the Filters block, which names the period and opens the picker of the period, the comparison and the buckets.',
    doc: 'features/analytics#periods',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-period',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    reveal: [{ open: 'analytics-period-button' }],
    describes:
      'The period picker: a rolling window, a calendar unit, a custom range, the time since a timeline marker, or a sprint.',
    help: 'analytics.period',
    doc: 'features/analytics#periods',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-comparison',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    reveal: [{ open: 'analytics-period-button' }],
    describes:
      'The period picker’s Compare with: the previous period, calendar unit, release cycle or sprint, the same period a year earlier, or nothing.',
    help: 'analytics.comparison',
    doc: 'features/analytics#comparison-and-buckets',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-buckets',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    reveal: [{ open: 'analytics-period-button' }],
    describes:
      'The period picker’s Buckets: how the trend charts and the heatmap cut the period, automatically, by day, by week or by month.',
    help: 'analytics.granularity',
    doc: 'features/analytics#comparison-and-buckets',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-branch-policy',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The branch policy of the Filters block: count the runs on each project’s default branch only, or the runs on every branch.',
    shownWhen: 'While no branch is picked by hand.',
    help: 'analytics.branch-policy',
    doc: 'features/analytics#branch-policy',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-tests-button',
    kind: 'action',
    pages: DASHBOARD_PAGES,
    describes:
      'The test filter’s button in the Filters block, which reads All tests, or the count of the test filters set.',
    doc: 'features/analytics#test-filter',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-test-filter',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    reveal: [{ open: 'analytics-tests-button' }],
    describes:
      'The test filter: a selection, test tags or browsers that narrow every number to the tests matching today, with their whole history.',
    help: 'analytics.test-filter',
    doc: 'features/analytics#test-filter',
    sample: { route: '/analytics' },
  },

  // ── The widgets of Overview, band by band ───────────────────────────────
  {
    id: 'analytics-headline',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Headline numbers of a dashboard: pass rates, flaky tests, wasted CI minutes, open failure causes and time to fix, against the period before.',
    shownWhen: 'When the dashboard holds the Headline numbers widget, as Overview does.',
    help: 'analytics.stats',
    doc: 'features/analytics',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-portfolio',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Portfolio health widget: each project’s pass rate and its change, flaky volume, open failure clusters and latest run, worst first.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.portfolio',
    doc: 'reference/analytics-widgets#where-things-stand',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-insights',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Insights widget: findings over the period, such as a missed target, a pass-rate drop or a stale cluster, ranked by severity.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.insights',
    doc: 'reference/analytics-widgets#where-things-stand',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-heatmap',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Pass rate heatmap: the pass rate of each project per day or wider bucket, green from 90%, amber from 50%, red below and gray without runs.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.heatmap',
    doc: 'reference/analytics-widgets#where-things-stand',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-cluster-landscape',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Failure clusters widget: the open root causes across projects, the biggest and oldest first, and those resolved in the period.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.cluster-landscape',
    doc: 'features/failure-clusters#how-failures-are-grouped',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-flaky-leaderboard',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Flakiest tests widget: the worst flaky tests across projects, scored as on each project’s Flaky tests tab, by the CI time they waste.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.flaky-leaderboard',
    doc: 'features/flaky-tests#flaky-test-detection',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-wasted-time',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Wasted CI time chart: the minutes spent in wait steps and in attempts that failed or timed out, over time and per project.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.wasted-time',
    doc: 'reference/analytics-widgets#where-the-pain-is',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-time-to-fix',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Time to fix chart: failure causes opened and fixed per bucket, the median time from first failure to fix, the fixes that held, open causes by age.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.time-to-fix',
    doc: 'reference/analytics-widgets#where-the-pain-is',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-handbacks',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Hand-back outcomes widget: what became of the locator heals, auto-heal pull requests, AI diagnoses, merge gates and Flake Lab fixes.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.handbacks',
    doc: 'features/analytics#hand-back-outcomes',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-metric',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'A Metric widget: one metric of the catalog as a number, a line, bars, a table or a heatmap, against the comparison period.',
    shownWhen: 'When the dashboard holds one, as Overview does with Pass rate over time.',
    help: 'analytics.metric',
    doc: 'features/dashboards#the-metric-widget',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-regression-velocity',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Regression velocity chart: per bucket, the tests that passed in a baseline and now fail, and the tests that turned flaky.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.regression-velocity',
    doc: 'features/flaky-tests#regression-signals',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-ci-time',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The CI time chart: the minutes the test runs consumed over time, with the change against the comparison period.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.ci-time',
    doc: 'reference/analytics-widgets#which-way-it-is-going',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-suite-growth',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Suite growth chart: how many tests the suite has over time, and the share of them skipped or not run.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.suite-growth',
    doc: 'reference/analytics-widgets#which-way-it-is-going',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-flaky-debt',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Flaky debt chart: per bucket, the flaky occurrences per run, the tests that passed only on a retry and the tests in quarantine.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.flaky-debt',
    doc: 'reference/analytics-widgets#which-way-it-is-going',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-browser-matrix',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Browser matrix: the pass rate of each project in each browser, where a failure only one browser shows stands out.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    help: 'analytics.browser-matrix',
    doc: 'reference/analytics-widgets#detail',
    sample: { route: '/analytics' },
  },
  {
    id: 'analytics-slow-endpoints',
    kind: 'block',
    pages: DASHBOARD_PAGES,
    describes:
      'The Slow endpoints table: the backend calls captured during tests across projects, by route, with their p50 and p90 latency and error rate.',
    shownWhen: 'When the dashboard holds it, as Overview does.',
    requires: { capability: 'fixtures' },
    help: 'analytics.slow-endpoints',
    doc: 'guide/capture-fixtures',
    sample: { route: '/analytics' },
  },

  // ── The widgets of the built-in report dashboards ───────────────────────
  {
    id: 'analytics-verdict',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Verdict widget: one or two sentences on where the scope stands, built by fixed rules from numbers shown elsewhere, never by a model.',
    shownWhen: 'When the dashboard holds it, as the built-in Executive and Engineering dashboards do.',
    help: 'analytics.verdict',
    doc: 'features/quality-reports#the-verdict-is-built-by-rules',
    sample: { route: '/analytics/d/executive' },
  },
  {
    id: 'analytics-progress',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Fixes and triage widget: the failure causes fixed and whether the fixes held, the open ones assigned or linked to a ticket, the tests quarantined.',
    shownWhen: 'When the dashboard holds it, as the built-in Executive and Engineering dashboards do.',
    help: 'analytics.progress',
    doc: 'reference/analytics-widgets#where-the-pain-is',
    sample: { route: '/analytics/d/executive' },
  },
  {
    id: 'analytics-risks',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Risks widget: the metrics that moved the wrong way, the projects failing run after run, the oldest open failure causes and the quarantined tests.',
    shownWhen: 'When the dashboard holds it, as the built-in Executive and Engineering dashboards do.',
    help: 'analytics.risks',
    doc: 'reference/analytics-widgets#where-the-pain-is',
    sample: { route: '/analytics/d/executive' },
  },
  {
    id: 'analytics-ownership',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Ownership widget: per owner, the open failure causes assigned to them, and the flaky tests and wasted CI minutes of the tests they own.',
    shownWhen: 'When the dashboard holds it, as the built-in Engineering dashboard does.',
    help: 'analytics.ownership',
    doc: 'reference/analytics-widgets#where-the-pain-is',
    sample: { route: '/analytics/d/engineering' },
  },
  {
    id: 'analytics-coverage-trend',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Coverage trend chart: the share of executable lines the unit tests and the Playwright runs ran together, commit after commit over the period.',
    shownWhen: 'When the dashboard holds it, as the built-in Engineering dashboard does.',
    requires: { capability: 'coverage' },
    help: 'analytics.coverage-trend',
    doc: 'features/combined-coverage#over-time',
    sample: { route: '/analytics/d/engineering' },
  },
  {
    id: 'analytics-movers',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Movers widget: the tests that turned flaky or stopped being flaky, and those whose passing duration grew or shrank by more than 25%.',
    shownWhen: 'When the dashboard holds it, as the built-in Engineering dashboard does.',
    help: 'analytics.movers',
    doc: 'reference/analytics-widgets#detail',
    sample: { route: '/analytics/d/engineering' },
  },
  {
    id: 'analytics-environment-comparison',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Environment comparison chart: the test pass rate and run success of each environment side by side, with their change and their trend.',
    shownWhen: 'When the dashboard holds it, as the built-in Engineering dashboard does.',
    help: 'analytics.environment-comparison',
    doc: 'reference/analytics-widgets#detail',
    sample: { route: '/analytics/d/engineering' },
  },
  {
    id: 'analytics-scenario-gaps',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Scenario gaps widget: the Test Map’s open gaps by class and by feature, the gaps closed in the period and the accepted gaps never tested.',
    shownWhen: 'When the dashboard holds it, as the built-in Engineering and Gaps digest dashboards do.',
    requires: { capability: 'test-map' },
    help: 'analytics.scenario-gaps',
    doc: 'features/scenario-gaps',
    sample: { route: '/analytics/d/engineering' },
  },
  {
    id: 'analytics-new-gaps',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The New scenario gaps widget: the top five new open gaps of each project created in the period, highest exposure first.',
    shownWhen: 'When the dashboard holds it, as the built-in Gaps digest dashboard does.',
    requires: { capability: 'test-map' },
    help: 'analytics.new-gaps',
    doc: 'features/scenario-gaps',
    sample: { route: '/analytics/d/gaps-digest' },
  },

  // ── The widgets of the saved dashboards ─────────────────────────────────
  {
    id: 'analytics-list',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'A List widget: the latest runs, the open failure causes seen most, the flakiest tests or the top open scenario gaps, each opening its page.',
    shownWhen: 'When a saved dashboard holds one.',
    help: 'analytics.list',
    doc: 'features/dashboards#widgets',
    sample: { route: '/analytics/d/1' },
  },
  {
    id: 'analytics-markers',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    describes:
      'The Timeline markers widget: the releases, deploys, incidents and other markers of the period, the ones the trend charts draw.',
    shownWhen: 'When a saved dashboard holds it.',
    help: 'analytics.markers',
    doc: 'features/timeline-markers',
    sample: { route: '/analytics/d/1' },
  },
  {
    id: 'chart-export',
    kind: 'action',
    pages: [
      '/analytics',
      '/analytics/d/[id]',
      '/projects/[id]',
      '/test-runs/[id]',
      '/test-cases/[id]',
      '/failure-clusters/[id]',
      '/settings/storage',
    ],
    describes:
      'The export menu of a trend chart: Copy as PNG for a slide or a document, and Download Excel for the numbers behind the chart.',
    shownWhen: 'On every trend chart’s card, while a card that folds is open.',
    help: 'chart.export',
    doc: 'features/analytics#exporting-a-chart',
    sample: { route: '/analytics' },
  },

  // ── Editing a dashboard ─────────────────────────────────────────────────
  {
    id: 'widget-menu',
    kind: 'action',
    pages: OTHER_DASHBOARD_PAGES,
    reveal: [{ open: 'dashboard-edit' }],
    describes:
      'A widget’s menu in the dashboard editor: Configure, Half or Full width, Move up, Move down, Move to band, Duplicate and Remove.',
    shownWhen: 'While a saved dashboard is edited.',
    doc: 'features/dashboards#editing-a-dashboard',
    sample: { route: '/analytics/d/1' },
  },
  {
    id: 'widget-configure',
    kind: 'action',
    pages: OTHER_DASHBOARD_PAGES,
    reveal: [{ open: 'dashboard-edit' }, { open: 'widget-menu' }],
    describes: 'The Configure entry of a widget’s menu, which opens the widget’s title, its options and its own scope.',
    shownWhen: 'While a saved dashboard is edited.',
    doc: 'features/dashboards#periods-and-filters-per-widget',
    sample: { route: '/analytics/d/1' },
  },
  {
    id: 'widget-scope',
    kind: 'block',
    pages: OTHER_DASHBOARD_PAGES,
    reveal: [{ open: 'dashboard-edit' }, { open: 'widget-menu' }, { open: 'widget-configure' }],
    describes:
      'A widget’s own scope: a period that replaces the dashboard’s, and filters that narrow its projects, selection, test tags and browsers.',
    shownWhen: 'While a widget of a saved dashboard is configured.',
    help: 'dashboards.widget-scope',
    doc: 'features/dashboards#periods-and-filters-per-widget',
    sample: { route: '/analytics/d/1' },
  },

  // ── The quality report preview ──────────────────────────────────────────
  {
    id: 'report-preview',
    kind: 'block',
    pages: [...DASHBOARD_PAGES, '/projects/[id]'],
    reveal: [{ open: 'dashboard-export' }],
    describes:
      'The quality report preview: the scope on screen as a document for readers who do not open the dashboard, from the dashboard and language picked.',
    requires: { capability: 'quality-reports' },
    help: 'reports.export',
    doc: 'features/quality-reports#exporting-a-report',
    sample: { route: '/analytics' },
  },
  {
    id: 'report-download',
    kind: 'action',
    pages: [...DASHBOARD_PAGES, '/projects/[id]'],
    reveal: [{ open: 'dashboard-export' }],
    describes: 'The Download menu of the quality report preview: the report as PDF, HTML, Markdown, Excel or JSON.',
    requires: { capability: 'quality-reports' },
    doc: 'features/quality-reports#exporting-a-report',
    sample: { route: '/analytics' },
  },

  // ── The Dashboards page ─────────────────────────────────────────────────
  {
    id: 'dashboards-page',
    kind: 'page',
    pages: ['/analytics/dashboards'],
    describes:
      'The Dashboards page: the built-in dashboards and the saved ones, shared and personal, each with its menu, and New dashboard.',
    doc: 'features/dashboards#built-in-and-saved-dashboards',
    sample: { route: '/analytics/dashboards' },
  },
  {
    id: 'new-dashboard',
    kind: 'action',
    pages: ['/analytics/dashboards'],
    describes:
      'The New dashboard button: a saved dashboard, empty or a copy of one you can open, private or shared with everyone.',
    doc: 'features/dashboards#built-in-and-saved-dashboards',
    sample: { route: '/analytics/dashboards' },
  },
  {
    id: 'default-dashboard',
    kind: 'block',
    pages: ['/analytics/dashboards'],
    describes:
      'The Default for everyone card: the dashboard Analytics opens for everyone who has not picked their own.',
    requires: { permission: 'settings:manage' },
    help: 'dashboards.default',
    doc: 'features/dashboards#your-default-dashboard',
    sample: { route: '/analytics/dashboards' },
  },
  {
    id: 'team-dashboards',
    kind: 'block',
    pages: ['/analytics/dashboards'],
    describes:
      'The saved dashboards of the Dashboards page, shared with everyone or personal: the widgets and scope a person or a team keeps.',
    shownWhen: 'When at least one dashboard is saved.',
    help: 'dashboards.sharing',
    doc: 'features/dashboards',
    sample: { route: '/analytics/dashboards' },
  },

  // ── The Quality reports page and a report snapshot ──────────────────────
  {
    id: 'reports-page',
    kind: 'page',
    pages: ['/reports'],
    describes:
      'The Quality reports page: the report snapshots kept, each opening on its own page, and the schedules that build and send them.',
    doc: 'features/quality-reports',
    sample: { route: '/reports' },
  },
  {
    id: 'new-schedule',
    kind: 'action',
    pages: ['/reports'],
    describes:
      'The New schedule button: a quality report sent on a cadence, with its dashboard, comparison, language and channels.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/reports' },
  },
  {
    id: 'report-snapshots',
    kind: 'block',
    pages: ['/reports'],
    describes:
      'The Report snapshots card: every quality report generated, by a schedule or by hand, kept with its numbers as they were.',
    requires: { capability: 'quality-reports' },
    help: 'reports.snapshots',
    doc: 'features/quality-reports#report-snapshots',
    sample: { route: '/reports' },
  },
  {
    id: 'report-schedules',
    kind: 'block',
    pages: ['/reports'],
    describes:
      'The Report schedules card: each schedule that builds a quality report every day, week or month and sends it to its channels.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    help: 'reports.schedule',
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/reports' },
  },
  {
    id: 'schedule-form',
    kind: 'block',
    pages: ['/reports', ...DASHBOARD_PAGES, '/projects/[id]'],
    reveal: [{ open: 'new-schedule' }],
    describes:
      'The report schedule form: the dashboard, cadence and time, comparison, language and channels, and Preview of the report it would send now.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    help: 'reports.schedule',
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/reports' },
  },
  {
    id: 'schedule-narrative',
    kind: 'block',
    pages: ['/reports', ...DASHBOARD_PAGES, '/projects/[id]'],
    reveal: [{ open: 'new-schedule' }],
    describes:
      'The AI narrative switch of a report schedule: three paragraphs by the configured AI model at the top of each report, labeled as generated.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    help: 'reports.narrative',
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/reports' },
  },
  {
    id: 'report-snapshot-page',
    kind: 'page',
    pages: ['/reports/[id]'],
    describes:
      'A report snapshot: one quality report as it was generated, with when, from which schedule and to which channels it was sent.',
    doc: 'features/quality-reports#report-snapshots',
    sample: { route: '/reports/1' },
  },
  {
    id: 'report-snapshot-download',
    kind: 'action',
    pages: ['/reports/[id]'],
    describes: 'The Download menu of a report snapshot: the report as PDF, HTML, Markdown, Excel or JSON.',
    doc: 'features/quality-reports#exporting-a-report',
    sample: { route: '/reports/1' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const ANALYTICS_EXEMPTIONS = [
  {
    rule: 'help',
    key: 'analytics.narrative',
    reason: 'No built-in or seeded dashboard holds the Narrative widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'analytics.spec-health',
    reason: 'No built-in or seeded dashboard holds the Spec health widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'analytics.slow-tests',
    reason: 'No built-in or seeded dashboard holds the Slowest tests widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'analytics.performance-trend',
    reason: 'No built-in or seeded dashboard holds the Performance trend widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'analytics.timeout-opportunities',
    reason: 'No built-in or seeded dashboard holds the Timeout opportunities widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'analytics.selection-health',
    reason: 'No built-in or seeded dashboard holds the Selection health widget, so no seeded route renders it.',
  },
  {
    rule: 'help',
    key: 'reports.share-link',
    reason: 'The Share link switch shows only where share links are on, and the demo has no share links.',
  },
  {
    rule: 'help',
    key: 'share-links.badge',
    reason: 'The share links dialog never renders in the demo, which has no share links.',
  },
  {
    rule: 'help',
    key: 'dashboards.live-links',
    reason: 'The live dashboard links dialog never renders in the demo, which has no share links.',
  },
];
