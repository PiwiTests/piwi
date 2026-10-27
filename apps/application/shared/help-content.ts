/**
 * Single source of truth for every inline-help hint shown by `HelpHint`.
 *
 * Keying by a stable dotted topic id keeps copy consistent and auditable, makes
 * future i18n trivial, and turns a missing/typo'd key into a compile-time error
 * at the call site (the `help` prop is typed as `HelpTopicKey`).
 *
 * Copy rules: 1–2 sentences, sentence case, American English. The text is
 * Markdown (rendered by `renderHelpMarkdown`): wrap identifiers, commands and
 * patterns in `code`. When a hint can't stay short, lead with one sentence and
 * break the rest into a `- **Label** — …` list, one line per array entry
 * joined with `\n`. The `doc` field
 * is a docs page + optional `#anchor` passed through `docsUrl()`; omit it when
 * no docs section exists yet (text-only hint). The optional `recipe` links the
 * recipe that answers the question the block raises, labeled with that
 * question. The `envVars` field lists the
 * `PIWI_*` environment variable(s) that override the setting; it is typed as
 * `PiwiEnvVarName[]` so a typo is a compile error (see `shared/piwi-env-vars`).
 *
 * Shared so the server reads it too (the assistant's `explain_setting` tool);
 * `app/utils/help-content.ts` re-exports it, so the app auto-imports it.
 */
import type { PiwiEnvVarName } from '#shared/piwi-env-vars';

export interface HelpTopic {
  /** Optional bold heading shown at the top of the popover. */
  title?: string;
  /** 1–2 sentence explanation, in Markdown. */
  text: string;
  /** Docs page + optional `#anchor` (passed to `docsUrl()`); omit if none. */
  doc?: string;
  /**
   * The recipe that answers the question this block raises, shown under
   * "Learn more" as a second link labeled with the recipe's question.
   */
  recipe?: { question: string; doc: string };
  /**
   * `PIWI_*` environment variable(s) that override this setting (env always
   * wins; the UI shows the field read-only when set). Listed in the popover so a
   * system admin knows which env var backs this setting. Omit for settings that
   * are not env-overridable (DB-only, informational, etc.).
   */
  envVars?: PiwiEnvVarName[];
}

export const HELP_TOPICS = {
  // ── Issue tracking ──────────────────────────────────────────────────────
  'integrations.create-issue': {
    title: 'Create issue',
    text: 'File a Jira issue from this failure, with the fix plan as its body. Piwi links it to the failure’s cluster as its known issue, so the key shows on the cluster page, on every execution of the cluster, in the inbox, Slack, email and PR comments. Filing again for the same cluster, from its page or one of its executions, names the issue already filed until that issue is Done or unlinked; then it files a new one, and a Done issue stays linked. A filing Jira refused shows beside the ticket on both pages, with Jira’s reason. The modal offers to link an existing issue instead.',
    doc: 'features/issue-tracking#what-it-does-exactly',
  },
  'integrations.required-fields': {
    title: 'Required Jira fields',
    text: 'Fields the Jira project requires for this issue type, beyond what Piwi fills (summary, description, labels, assignee). A value set in the project settings fills every issue filed from the project; the create modal shows each one, and a create that would leave one empty is refused before Jira is called. A field Jira fills by default reads “Jira’s default” while empty and never holds the create back. You can also set any optional field, such as components or a parent, in the settings for every issue or in the create modal with Add a field for one. The fix and reopen transitions can require fields too, such as a resolution: set them under each transition.',
    doc: 'features/issue-tracking#required-jira-fields',
  },
  'integrations.known-issue': {
    title: 'Known issue',
    text: 'The tracker issue this cluster is tracked by: the newest Jira issue, or issue on a connected tracker, linked to it. Linking or filing another keeps the earlier one linked, and the new one takes its place. Its key and status show on the cluster page’s Issue line, at the end of an execution’s Cluster line, and wherever the cluster is listed.',
    doc: 'features/issue-tracking#the-key-travels',
  },
  'integrations.run-scope': {
    title: 'Runs that write to the ticket',
    text: 'The runs whose results comment on, move or update a tracked issue: the fix, regression and still-failing notes, the transitions and the description updates.\n\n- **Branches** — names or `*` patterns (`release/*`)\n- **Default branch** — the project default branch, whatever it is named\n- **Environments** — names or `*` patterns\n\nNothing named means every run. A run from an editor, a lab run, a bisect step or a reproduction never writes, nor does a developer run of part of the suite.',
    doc: 'features/issue-automation#the-runs-that-write',
  },
  'integrations.auto-create': {
    title: 'Automatic creation',
    text: 'After each run, Piwi files an issue for each failure that meets a rule, counting only the runs the rule names.\n\n- **Occurrences, Runs** — how often it failed, and in how many distinct runs\n- **Days** — how long since the first occurrence counted\n- **Test tags** — only failures of tests carrying one of them\n\nA failure that is snoozed, looks flaky, is already tracked or that an open issue already carries the labels of is never filed, and the daily cap holds. Preview shows what the rules file before you save.',
    doc: 'features/issue-automation#automatic-creation',
  },

  // ── Home ──────────────────────────────────────────────────────────────
  'home.project-health': {
    title: 'Project health',
    text: 'Every project at a glance — run history bars and a tendency badge so you can immediately see which project needs attention. Only full runs count.',
    doc: 'features/ui-overview#home',
  },
  'home.get-started': {
    title: 'Reporter setup',
    text: 'Every path ends in the same setup: `wrapConfig` around your Playwright config and the capture fixtures in your specs. The reporter entry alone keeps your runs; the two add the failure evidence, the network and console capture and locator healing.',
    doc: 'guide/getting-started#_2-connect-your-suite',
  },
  'home.failure-inbox': {
    title: 'Failure inbox',
    text: "A queue of the failures you still owe a decision. Switch queues to focus — new since you last looked, mine, regressions, fixes that didn't hold, quarantines ready to release, merge suggestions. Triage from the row or the keyboard: j / k move, x select, r resolve, i ignore, q quarantine, a assign, s snooze, l link, o open.",
    doc: 'features/failure-clusters#the-failure-inbox',
  },
  'home.flake-lab': {
    title: 'Flake Lab queue',
    text: 'Flaky tests the Flake Lab can move forward: a reproduced flake whose fix waits for a verify, then a flaky test whose top suspect no experiment has tested. Run the command from the project root, or from the code lens in your editor.',
    doc: 'features/flake-lab#from-the-editor-and-the-failure-pages',
  },
  'cluster.state': {
    title: 'Cluster state',
    text: 'One sentence with one verb for where this cluster stands — still failing, fixed and verified, fixed while the diagnosed patch still applies at the commit of the fix (the change may not be in the code yet), stopped failing, regressed, resolved, ignored, snoozed or quarantined — with the single action that reconciles it, unless the Next line offers it. Triage sets the status, a note and the assignee; Snooze hides it from the inbox without changing the status.',
    doc: 'features/failure-clusters#the-state-line',
  },
  // What changed, when the configuration is what is missing.
  'cluster.scm-no-commit': {
    title: 'Commit not recorded',
    text: 'The runs record no commit, so Piwi has no range to read. The reporter reads the commit from the Git checkout the tests run in (`collectScmInfo`, on by default): run them from a clone of the repository.',
    doc: 'guide/source-control#troubleshooting',
  },
  'cluster.scm-no-repository': {
    title: 'Repository unknown',
    text: 'The runs record their commits but no repository URL, so Piwi cannot list the commits in this range. The reporter takes the URL from the `origin` remote of the checkout the tests run in; until it has one, **More actions › Copy git log** lists the range in your own clone.',
    doc: 'guide/source-control#troubleshooting',
  },
  'cluster.scm-unsupported-host': {
    title: 'Host not supported',
    text: 'Piwi reads commits from GitHub, Bitbucket, GitLab and the self-hosted GitLab hosts you list. For another host, **More actions › Copy git log** lists the range in your own clone.',
    doc: 'guide/source-control#troubleshooting',
    envVars: ['PIWI_SCM_GITLAB_HOSTS'],
  },
  'cluster.scm-fetch-failed': {
    title: 'Changes not read',
    text: 'Piwi knows the range, but the host did not return its commits: a private repository needs an SCM token (**Settings → AI → Repository access**, or the project’s **Source control** settings). On the desktop app, run `git fetch` in the linked folder.',
    doc: 'guide/source-control#troubleshooting',
  },
  'cluster.scm-host-error': {
    title: 'Host error',
    text: 'Piwi asked the host for the commits in this range with the SCM token set, and the host answered with the error the line shows. A 403 or a 404 means the token cannot read this repository: give it read access to the repository contents. A rate limit or a server error passes with time: open the cluster again later. Until then, **More actions › Copy git log** lists the range in your own clone.',
    doc: 'guide/source-control#troubleshooting',
  },

  // ── Analytics ─────────────────────────────────────────────────────────
  'analytics.insights': {
    title: 'Insights',
    text: 'Auto-generated findings over the selected period — missed targets, pass-rate drops, failing streaks, stale clusters, wasted CI time, a growing time to fix, a shrinking suite, a growing quarantine, one owner holding most open failure causes. Ranked by severity; click one to jump to the source.',
  },
  'analytics.portfolio': {
    title: 'Portfolio health',
    text: 'Every project over the selected period: pass rate with its change vs the previous period, flaky volume, open failure clusters, and the latest run. Worst health sorts first.',
  },
  'analytics.heatmap': {
    title: 'Pass rate heatmap',
    text: 'Each cell is the aggregate pass rate of one project over one time bucket — green at 90% or more, amber from 50%, red below 50%, gray means no runs. A cell is one UTC day, or a wider bucket on long periods.',
  },
  'analytics.ci-time': {
    title: 'CI time',
    text: 'Total minutes your test runs consumed, over time, with the change against the comparison period. Steady growth here is a capacity conversation.',
  },
  'analytics.wasted-time': {
    title: 'Wasted CI time',
    text: 'Minutes that produced no signal: time inside wait steps plus time executing attempts that ended failed or timed out. The strongest argument for fixing slow waits and flaky tests.',
  },
  'analytics.flaky-leaderboard': {
    title: 'Flakiest tests',
    text: 'The worst flaky tests across all projects, using the same scoring as each project’s Flaky tests tab, sorted by wasted-CI impact.',
    doc: 'features/flaky-tests#flaky-test-detection',
  },
  'analytics.cluster-landscape': {
    title: 'Failure clusters',
    text: 'Open failure clusters across all projects — the biggest and oldest unresolved root causes. Clusters outlive run retention, so this works on long horizons.',
    doc: 'features/failure-clusters#how-failures-are-grouped',
  },
  'analytics.regression-velocity': {
    title: 'Regression velocity',
    text: 'How much new breakage each period introduces: tests that passed in a baseline and now fail (regressions), plus tests that turned flaky. Rising bars mean quality debt is accumulating.',
    doc: 'features/flaky-tests#regression-signals',
  },
  'analytics.suite-growth': {
    title: 'Suite growth',
    text: 'How many tests the suite has over time (the highest test count one run reported in each bucket), and the share of them skipped or not run. A growing suite whose skipped share grows too is adding tests nobody runs.',
    doc: 'reference/analytics-widgets#which-way-it-is-going',
  },
  'analytics.coverage-trend': {
    title: 'Coverage trend',
    text: 'The share of executable lines the suites ran together (the unit-test reports uploaded for each commit and the Playwright runs), at the commit whose coverage arrived last in each bucket, summed over the projects in scope. Kept per day, so it outlives the reports it came from.',
    doc: 'features/combined-coverage#over-time',
  },
  'analytics.flaky-debt': {
    title: 'Flaky debt',
    text: 'Whether flakiness is going down: flaky occurrences per run in each bucket (from the daily rollups, so over any window), the distinct tests that passed only on a retry (from the stored runs, so only as far back as retention keeps them) and the tests in quarantine at the end of each bucket.',
    doc: 'reference/analytics-widgets#which-way-it-is-going',
  },
  'analytics.time-to-fix': {
    title: 'Time to fix',
    text: 'How fast failures get fixed: failure causes opened and fixed per bucket, the median and 90th-percentile time from first failure to fix over the causes fixed in the period, the share of those fixes that held, and the open causes by age. Failure clusters outlive run retention, so this reaches as far back as they do.',
    doc: 'reference/analytics-widgets#where-the-pain-is',
  },
  'analytics.ownership': {
    title: 'Ownership',
    text: 'One row per owner: the open failure causes assigned to them, and the flaky tests and wasted CI minutes of the tests they own (their `piwi:owner` annotation), with the median time to fix of the causes they fixed. The Unowned row holds everything nobody is assigned to or owns. Test counts reach back only as far as retention keeps runs.',
    doc: 'reference/analytics-widgets#where-the-pain-is',
  },
  'analytics.environment-comparison': {
    title: 'Environment comparison',
    text: 'Test pass rate and run success per environment (the `environment` your runs report), side by side with their change against the comparison period, and the pass rate of each over time, so a staging that is green while production is not stands out.',
    doc: 'reference/analytics-widgets#detail',
  },
  'analytics.movers': {
    title: 'Movers',
    text: 'The tests that changed against the comparison period: those that became flaky or stopped being flaky, and those whose average passing duration grew or shrank by more than 25 %. Read from the stored runs, so both periods reach back only as far as retention keeps them; each direction lists its top tests, at most 25.',
    doc: 'reference/analytics-widgets#detail',
  },
  'analytics.browser-matrix': {
    title: 'Browser matrix',
    text: 'Pass rate per project × browser, so a suite that is green on one browser but failing on another (a browser-specific bug) stands out immediately.',
  },
  'chart.export': {
    title: 'Chart export',
    text: 'Copy as PNG puts the chart, with its title, on the clipboard as an image to paste into a slide or a document; a browser that cannot copy images downloads the PNG instead. Download Excel saves the numbers behind the chart as a workbook, one row per bucket or group, with numbers and dates in their own cell types and text that never runs as a formula.',
    doc: 'features/analytics#exporting-a-chart',
  },
  'analytics.stats': {
    title: 'Headline numbers',
    text: 'Numbers from the metric catalog across every project in scope, each with its change against the comparison period. Green and red say whether the change is good news for that number, not whether it went up.',
  },
  'analytics.metric': {
    title: 'Metric over time',
    text: 'One metric from the catalog bucketed over the period. The faint line is the comparison period, bucket for bucket; the vertical lines are timeline markers.',
  },
  'analytics.verdict': {
    title: 'Verdict',
    text: 'One or two sentences built by fixed rules from the pass rate, its change, the failure causes fixed and still open, and the wasted CI time. Never written by a model, so it only repeats numbers shown elsewhere on the page.',
  },
  'analytics.narrative': {
    title: 'Narrative',
    text: 'In a scheduled quality report with the AI narrative on, the configured diagnosis model writes three paragraphs here from the report’s numbers only, labeled as generated; an answer citing a number the report lacks is refused. Everywhere else, and whenever the model fails or none is configured, this shows the rule-based verdict.',
    doc: 'reference/analytics-widgets#where-things-stand',
  },
  'reports.narrative': {
    title: 'AI narrative',
    text: 'Adds three paragraphs written by the configured diagnosis model at the top of each report, from the report’s numbers only and labeled as generated. The rule-based verdict and tiles stay; without a model, or when its answer cites a number the report lacks, the verdict stands in. Spends tokens once per report.',
    doc: 'reference/analytics-widgets#where-things-stand',
  },
  'analytics.progress': {
    title: 'Fixes and triage',
    text: 'Failure causes fixed in the period and whether the fixes held, open causes assigned or linked to a ticket, tests quarantined and released, and auto-heal pull requests opened.',
  },
  'analytics.handbacks': {
    title: 'Hand-back outcomes',
    text: 'What became of what Piwi handed back in the period: locator heals now used in the code, auto-heal pull requests merged or closed, AI diagnoses rated and confirmed by the fix, merges the gate blocked or that were merged anyway, and flaky tests Flake Lab proved fixed. Counted per project and day, so branch and environment filters do not narrow it, and a rate needs ten ratings, pull requests or fixes before it is given. A kind whose capability a project declined leaves that project out.',
    doc: 'features/analytics#hand-back-outcomes',
  },
  'analytics.risks': {
    title: 'Risks',
    text: 'Metrics that moved the wrong way against the comparison period, projects failing run after run, the oldest open failure causes, and the tests waiting in quarantine.',
  },
  'analytics.scenario-gaps': {
    title: 'Scenario gaps',
    text: 'Open gaps of the Test Map by class and by feature, the gaps closed in the period, accepted gaps whose test was never written, and open resilience findings. Counts only, never a coverage percentage. A project that declined the Test Map is left out.',
    doc: 'features/scenario-gaps',
  },
  'analytics.new-gaps': {
    title: 'New scenario gaps',
    text: 'The Test Map’s weekly digest: the top five new open gaps of each project created in the period, highest exposure first.',
    doc: 'features/scenario-gaps',
  },
  'analytics.list': {
    title: 'List',
    text: 'The top items matching the scope: the latest runs of the period, the open failure causes with the most occurrences, the flakiest tests, or the highest-scored open scenario gaps. Each one opens its page.',
    doc: 'features/dashboards#widgets',
  },
  'analytics.markers': {
    title: 'Timeline markers',
    text: 'The timeline markers of the period, the ones the trends draw: every marker when one project is in scope, across projects only releases, infrastructure changes and incidents.',
    doc: 'features/timeline-markers',
  },
  'analytics.spec-health': {
    title: 'Spec health',
    text: 'Pass and flaky rates per spec directory of one project, over the period (at most the last 90 days), worst first. Pick a single project under Filters.',
    doc: 'features/dashboards#widgets',
  },
  'analytics.slow-tests': {
    title: 'Slowest tests',
    text: 'The tests with the longest average duration over one project’s last 20 runs. Pick a single project under Filters.',
    doc: 'features/dashboards#widgets',
  },
  'analytics.performance-trend': {
    title: 'Performance trend',
    text: 'Total run duration, average and p90 test duration of one project’s runs over the period. Pick a single project under Filters.',
    doc: 'features/dashboards#widgets',
  },
  'analytics.timeout-opportunities': {
    title: 'Timeout opportunities',
    text: 'Tests of one project whose timeout is far above what they really take, so a hang wastes minutes, or that keep a test.slow() mark they no longer need.',
    doc: 'features/dashboards#widgets',
  },
  'analytics.selection-health': {
    title: 'Selection health',
    text: 'How each selection of one project resolves today, its warnings and drift since its last run, and how many tests no selection picks.',
    doc: 'features/test-selection',
  },
  'dashboards.widget-scope': {
    title: 'Widget scope',
    text: 'A widget can replace the dashboard’s period (a Last 7 days number on a quarterly dashboard) and narrow its filters (only some projects, a selection, test tags, browsers). It never widens them, so what a dashboard covers can be read off its Filters block.',
    doc: 'features/dashboards#periods-and-filters-per-widget',
  },
  'dashboards.hidden-projects': {
    title: 'Hidden projects',
    text: 'A dashboard grants no access: every widget is computed for the projects you can open. The projects of this dashboard’s scope you cannot open are counted here and never shown.',
    doc: 'features/dashboards#sharing-and-access',
  },
  'dashboards.default': {
    title: 'Default dashboard',
    text: 'Analytics opens the dashboard you picked in this browser, else the one an administrator set for everyone, else Overview. A saved dashboard must be shared to be the default for everyone.',
    doc: 'features/dashboards#your-default-dashboard',
  },
  'dashboards.sharing': {
    title: 'Sharing a dashboard',
    text: 'A shared dashboard is listed for every signed-in user; only its owner and administrators change it, everyone else duplicates it. Sharing needs the Maintainer role or above on at least one project, and shows nobody a project they cannot open.',
    doc: 'features/dashboards#sharing-and-access',
  },
  'reports.schedule': {
    title: 'Report schedule',
    text: 'A quality report sent on a schedule, daily, weekly, every other week or monthly, to email, Slack, webhook or browser channels. Each firing covers the whole days since the previous one, compared with the period before or a year earlier, and is kept as a snapshot. A period with no run still sends, so a stopped pipeline shows. Team sends the engineering report for one owner’s tests; Gaps digest is the Test Map’s weekly digest.',
    doc: 'features/quality-reports#report-schedules',
    envVars: ['PIWI_TIME_ZONE'],
  },
  'notifications.teams': {
    title: 'Microsoft Teams channel',
    text: 'Posts an Adaptive Card to a Teams channel. In Teams, open the channel’s Workflows, pick the template "Send webhook alerts to a channel" and paste the URL it gives here; a legacy connector webhook still works while Microsoft keeps it. Events, digests and quality reports all get a card.',
    doc: 'features/notifications#microsoft-teams',
  },
  'reports.share-link': {
    title: 'Share link per report',
    text: 'Each report this schedule generates gets its own read-only share link, which the email and the Slack message carry, so a reader without an account opens the report in one click. The link expires a week after the next report arrives. Slack also shows the trend as an image through it. Needs share links enabled on the instance.',
    doc: 'features/share-links#report-share-links',
    envVars: ['PIWI_SHARE_LINKS_ENABLED', 'PIWI_SHARE_LINK_MAX_TTL_DAYS'],
  },
  'share-links.badge': {
    title: 'Status badge',
    text: 'An SVG image of the test pass rate, the branch policy and the period ("tests on main · 97.8% · 7 d") that rides on this share link, for a README or a wiki page. It stops resolving with the link.',
    doc: 'features/share-links#status-badge',
  },
  'dashboards.live-links': {
    title: 'Live dashboard links',
    text: 'A read-only page of this dashboard for a wall screen or a bookmark, with nobody signed in. It is computed at every view with your project access and reloads every minute; it dies when it expires, is revoked, or you lose access to the dashboard or its projects. It never serves evidence files.',
    doc: 'features/share-links#live-dashboard-links',
    envVars: ['PIWI_SHARE_LINKS_ENABLED'],
  },
  'reports.snapshots': {
    title: 'Report snapshots',
    text: 'Every quality report generated, scheduled or by hand, stored with its numbers as they were, so a report received months ago reads the same today whatever retention deleted since. You see the snapshots whose every project you can open.',
    doc: 'features/quality-reports#report-snapshots',
    envVars: ['PIWI_RETENTION_REPORT_DAYS'],
  },
  'reports.export': {
    title: 'Quality report',
    text: 'The scope on screen as a document for someone who does not open the dashboard: a rule-based verdict, headline numbers, the trend, what is being done and the risks. Executive keeps to plain words; Engineering adds flaky tests, clusters and detail; Overview is this page. Download it as PDF, HTML, Markdown, Excel or JSON.',
    doc: 'features/quality-reports',
  },
  'analytics.period': {
    title: 'Period',
    text: 'Which days the page covers: a rolling window, a calendar week, month, quarter or year, a custom range, the time since a timeline marker, a release cycle (between two release markers) or a sprint. Rolling periods count whole UTC days; calendar periods follow your time zone.',
    doc: 'features/analytics#periods',
  },
  'analytics.comparison': {
    title: 'Compare with',
    text: 'The reference every change on the page is measured against: the previous period of the same length, the previous calendar unit, release cycle or sprint, the same period a year earlier, or nothing.',
    doc: 'features/analytics#comparison-and-buckets',
  },
  'analytics.granularity': {
    title: 'Buckets',
    text: 'How the trends and the heatmap cut the period: automatic (about 31 buckets), daily, weekly or monthly. Buckets start at UTC midnight.',
    doc: 'features/analytics#comparison-and-buckets',
  },
  'analytics.branch-policy': {
    title: 'Branch policy',
    text: 'Default branch counts runs on each project’s default branch, so a broken feature branch does not move the trends; a run whose branch is unknown counts only in a project that never reported a branch. All branches counts everything; picking branches by hand overrides both.',
    doc: 'features/analytics#branch-policy',
  },
  'analytics.test-filter': {
    title: 'Test filter',
    text: 'Narrow every number to some tests: a selection (resolved by key in each project), test tags, or browsers. It means the tests that match today, with their whole history, and it counts from stored executions, so it reaches back only as far as retention keeps runs.',
    doc: 'features/analytics#test-filter',
  },
  'analytics.slow-endpoints': {
    title: 'Slow endpoints',
    text: 'Backend calls captured during tests, aggregated across all projects by route: p50/p90 latency, error rate, and how many projects hit each one — a shared endpoint regressing shows up here first.',
    doc: 'guide/capture-fixtures',
  },

  // ── Projects list ─────────────────────────────────────────────────────
  'projects.tag-filter': {
    text: 'Filter projects by tag. Selecting several tags uses OR logic — a project matching any of them is shown.',
  },
  'projects.table': {
    title: 'Projects',
    text: 'Every project that has reported results, with its latest run, pass rate and activity. Click a row to drill in.',
    doc: 'features/ui-overview#projects',
  },
  'project.import': {
    title: 'Importing past runs',
    text: 'Upload the archives Playwright writes to blob-report/ to backfill runs from before you adopted Piwi. One archive becomes one run, complete with traces and screenshots, and re-uploading the same archive changes nothing. Imports are silent by design — no notifications, AI diagnosis or regression signals, so a backfill never pages the team about months-old failures.',
    doc: 'guide/importing-runs',
    envVars: ['PIWI_IMPORT_MAX_BYTES'],
  },

  // ── Project detail ────────────────────────────────────────────────────
  'project.runs-trend': {
    title: 'Run trend',
    text: 'One stacked bar per run — failed anchored at the bottom, passed on top — following the filters above. A growing red base marks where things broke; skipped tests take two greys, the stronger one for test.fixme(). Hover a bar for the counts, click it to open the run.',
    doc: 'features/ui-overview#project-detail',
  },
  'project.flaky-tests': {
    title: 'Flaky tests',
    text: 'Tests that fail intermittently across runs. Impact estimates wasted CI time; the score (0–100) rates severity and root cause explains why.',
    doc: 'features/flaky-tests#flaky-test-detection',
    recipe: { question: 'Cut costly flakiness', doc: 'recipes/flaky-cleanup' },
  },
  'project.flake-lab': {
    title: 'Flake Lab tests',
    text: 'Every test on the flaky ranking of the last runs, and every test the lab has run, with where it stands: not tested, not reproduced, reproduced and waiting for a fix, or fixed. The command is the one it needs next: `piwi flake` reproduces a flake, `piwi flake verify` proves a fix under the condition that reproduced it.',
    doc: 'features/flake-lab',
  },
  'project.gaps': {
    title: 'Scenario gaps',
    text: 'Tests that do not exist yet, from the Test Map: what the application exposes against what the suite observably reaches and would notice breaking. A blind spot is something no test reaches, false comfort a route a probe broke without any test failing, fragile a node one test holds up. Ranked by exposure, counted per class, never a percentage.',
    doc: 'features/scenario-gaps',
  },
  'project.quarantine': {
    title: 'Quarantine',
    text: 'A quarantined test still runs and still reports — it is only excluded from the CI gate’s verdict. Passing runs accumulate as a streak, so a test that recovers is flagged ready to release instead of staying quarantined forever.',
    doc: 'features/flaky-tests#quarantine-with-a-way-out',
  },
  'quarantine.coverage-loss': {
    title: 'Code only these tests run',
    text: 'The lines of the tests’ latest coverage on the default branch that no other trusted test runs: trusted means not quarantined. Quarantining the tests leaves those lines to no test the CI gate counts; releasing a quarantined test covers them again. Lines only flaky tests run besides them are counted apart, and a file other tests ran only at another version is not compared.',
    doc: 'features/coverage-insights#what-quarantining-or-deleting-tests-leaves-uncovered',
  },
  'project.performance': {
    title: 'Performance',
    text: 'Duration trends for the suite — average and P90 (the slowest 10% threshold). Use it to catch tests getting steadily slower.',
    doc: 'features/slow-tests',
    recipe: { question: 'Cut the time it costs', doc: 'recipes/faster-suite' },
  },
  'project.timeline': {
    title: 'Timeline markers',
    text: 'Dated events — deploys, config changes, infra migrations, incidents — overlaid as vertical lines on the trend charts, so you can tell whether a change moved your results or performance. Markers can be scoped to an environment; some are detected automatically when tooling versions change between runs.',
    doc: 'features/timeline-markers',
    envVars: ['PIWI_AUTO_MARKERS'],
  },
  'project.slowest-tests': {
    title: 'Slowest tests',
    text: 'The tests taking the most time, ranked. Optimizing the top entries shortens your overall run the fastest.',
    doc: 'features/slow-tests',
  },
  'project.slow-endpoints': {
    title: 'Slow endpoints',
    text: 'Backend routes exercised during a run, aggregated per route and ranked by time. Needs the Piwi capture fixtures. Pick a run to inspect its endpoint timings.',
    doc: 'features/slow-tests',
  },
  'project.status': {
    title: 'Project status',
    text: [
      'Where the project stands within the page’s filters; each figure links to what it counts.',
      '',
      '- **Runs** — the latest run, its age, and the pass rate of the last 20 runs.',
      '- **Failures** — the open failure clusters, the flaky tests and the quarantined ones.',
    ].join('\n'),
    doc: 'features/ui-overview#project-detail',
  },
  'project.filters': {
    title: 'Filters',
    text: [
      'Environment, branch and **Full runs only** scope the whole page; the choice is remembered per project.',
      '',
      '- **Scoped** — the status above, the runs, the test catalog, the failures, the Flake Lab and the performance trends.',
      '- **Not scoped** — the quarantine list and the Gaps tab, which belong to the project whatever the filters.',
      '- **Branch** — with none picked, the default branch and the runs that report no branch; **All branches** reads every branch.',
    ].join('\n'),
    doc: 'features/ui-overview#project-detail',
  },
  'project.test-cases': {
    title: 'Tests',
    text: 'Every distinct test in the project with its executed-only pass rate, result breakdown and average duration across runs, in file order. Words search the title, describe blocks and file; qualifiers such as file:, describe:, tag: or owner: search one field, and a leading - excludes. Filter by status, and group by file, or by file and describe block, to see each one’s numbers. Tests not run within the selected age window are hidden by default (last 30 days) — pick "All time" to see obsolete ones. Click a test to see its full history.',
    doc: 'reference/test-search',
  },
  'project.members': {
    title: 'Project members',
    text: 'The users and groups holding a role on this project, granted here or on All projects. A Project admin can grant any project role here; administrators can do everything on every project.',
    doc: 'operate/project-access#who-manages-access',
  },
  'project.ai-instructions': {
    title: 'AI diagnosis instructions',
    text: 'Extra guidance handed to the AI when diagnosing this project’s failures — e.g. domain terms, known-flaky areas, or where to look first.',
    doc: 'features/ai-diagnosis#custom-instructions',
  },
  'project.scm-token': {
    title: 'Repository access token',
    text: 'A read-only Git host token lets diagnosis pull the actual commit diffs behind a failure for SCM-grounded analysis. Stored encrypted. On the desktop app, a project linked to a clone of its repository reads them with git instead, without a token.',
    doc: 'guide/source-control',
  },
  'case.stability-trend': {
    title: 'Stability trend',
    text: 'This test’s pass rate, flaky rate (passed only on a retry) and average duration over time, one point per day, week or month in UTC, with the project’s timeline markers. Probe runs are left out. A gap is a bucket where the test did not run.',
    doc: 'features/flaky-tests#per-test-stability-trend',
  },
  'cluster.occurrence-trend': {
    title: 'Occurrences over time',
    text: 'How often this failure cause failed, and how many tests it failed, per day, week or month (UTC), with the moment its fix landed and, if it failed again afterwards, the first failure after the fix. It opens on the days since the cluster was first seen, a week at least and a year at most, or on the last 90 days when the run that first saw it is no longer kept; the menu also offers the last 30, 90 and 365 days. Probe runs are left out.',
    doc: 'features/failure-clusters#occurrences-over-time',
  },
  'project.targets': {
    title: 'Targets',
    text: 'Goals this project is checked against over the period a dashboard or a quality report shows: a pass rate to reach, and limits on flaky tests, wasted CI minutes per week, the age of the oldest open failure cause and the median time to fix. Each is optional; a met or missed target shows on the headline tiles, in the portfolio, in the insights and in the report.',
    doc: 'features/analytics#targets',
  },
  'project.url-patterns': {
    title: 'Browser extension URLs',
    text: [
      'The addresses this project’s application is served at, as patterns over the whole URL: `*` matches within one path segment, `**` across segments. Piwi Picker reads them when it connects and tries them in this order to tell which project a page belongs to; a pattern saved in one browser overrides them there.',
      '',
      '- **Environment** is a label.',
      '- **Branch** is the one deployed at those addresses, whose tests Tested elements shows.',
      '- **Path prefix** is the part of the path the site serves its pages under and the tests did not (`/app`). Piwi Picker removes it before comparing the page with the pages the tests ran on.',
      '- **Tests’ path prefix** is the reverse: the part of the path the tests ran under and the site does not. Piwi Picker puts it in front.',
    ].join('\n'),
    doc: 'features/extension-connection#url-patterns',
  },
  'project.ci-rerun': {
    title: 'CI re-run',
    text: [
      'Lets a Maintainer or Project admin re-run a cluster’s affected tests in CI straight from its page, on the branch of the cluster’s latest run, passing each affected test’s file and line through the input/variable you name:',
      '',
      '- **GitHub** — a `workflow_dispatch`; the run is recognized by the optional dispatch id input.',
      '- **GitLab** — a pipeline, recognized by its pipeline id.',
      '- **Bitbucket** — a custom pipeline, recognized by its build number.',
      '',
      'The run it starts is recorded as a CI re-run when it finishes. Uses the project’s SCM token (which needs write scope) and is off until you fill in your provider’s block. The optional Flake Lab block names a workflow that runs `piwi flake` for one flaky test, from its next step.',
    ].join('\n'),
    doc: 'features/pr-feedback#re-run-from-the-dashboard',
  },
  'project.local-folder': {
    title: 'Linked local folder',
    text: 'The checkout on this machine that produces this project’s runs. Linking it enables running tests from the app and opening files in your IDE. The link is stored on this machine only — never on the server.',
    doc: 'features/desktop#running-tests-from-the-app',
  },

  // ── Test run detail ───────────────────────────────────────────────────
  'run.partial': {
    title: 'Partial run',
    text: 'This run covered only part of the suite (a shard, retry or filtered selection), so its totals aren’t a full picture.',
    doc: 'features/ui-overview#test-run-detail',
  },
  'run.live': {
    title: 'Live run',
    text: 'This run is still streaming results in real time. Results and counts update as each test finishes.',
    doc: 'guide/reporter#live-streaming',
  },
  'run.reports': {
    title: 'Storage & reports',
    text: 'HTML reports, traces and attachments uploaded with this run. A run can carry several reports (e.g. per shard).',
    doc: 'guide/reporter#multiple-reports',
  },
  'run.keep': {
    title: 'Kept runs',
    text: 'Retention (the nightly sweep and the storage cleanup) never deletes a kept run. Keep one from the run menu, or have the reporter keep it at ingest with keep: true. Only a Project admin can release it.',
    doc: 'operate/storage#keeping-runs-forever',
    envVars: ['PIWI_RETENTION_DAYS'],
  },
  'run.ingestHealth': {
    title: 'Ingest',
    text: 'What the dashboard left out or rebuilt while storing this run: steps and console entries over the ingest caps, traces it could not store, evidence rebuilt from a trace, and the fallback the reporter took when its usual way of sending the run failed. A missing step or console line may be one of these, not something the test skipped.',
    doc: 'features/ui-overview#test-run-detail',
    envVars: ['PIWI_INGEST_MAX_STEPS', 'PIWI_INGEST_MAX_CONSOLE_ENTRIES'],
  },
  'run.externalIdDuplicates': {
    title: 'Duplicate external IDs',
    text: "Each of these IDs is declared by more than one test (with `piwi:id`, or in the title read by the reporter’s `externalId.pattern`). An ID names one test, so this run matched those tests by file, describe path and title instead, as if they had no ID: a renamed or moved one starts a new history. Give each test its own ID; set `externalId.onDuplicate: 'fail'` to fail the run while two tests share one.",
    doc: 'reference/test-metadata#external-test-ids',
  },
  'run.coverageIncomplete': {
    title: 'Incomplete server coverage',
    text: 'Part of this run’s server coverage is missing. A backend that **restarted** during the run starts its coverage empty: the lines each test ran are kept, but what the earlier process ran outside a request (startup, background work) is lost. One **unreachable** at the end of the run sent no run-level coverage: only the lines the tests ran are kept. The commit’s combined coverage says so in its notes.',
    doc: 'features/server-coverage#limits',
  },
  'run.shuffle': {
    title: 'Shuffled run',
    text: 'Playwright ran this run’s tests in a random order (`--shuffle`). Click the seed to copy `--shuffle <seed>`: a run with the same tests, workers and seed runs them in the same order again, to reproduce a failure that depends on which test ran before.',
    doc: 'features/run-changes#shuffled-runs',
  },
  'run.metadata': {
    title: 'Tags, links & custom data',
    text: 'Extra context attached to the run: tags for grouping, links to external issues, and any custom key/value data your reporter sent.',
  },
  'run.test-cases': {
    title: 'Tests',
    text: 'Every execution in this run, in the order the tests ran (file order when grouped by file). Words search the title, describe blocks, path and error; qualifiers such as `file:`, `describe:`, `tag:` or `browser:` search one field, and a leading `-` excludes. Ctrl+F jumps to the search. Group by cluster, file, file and describe block, lock, or none. The count bar in the header filters by status (`test.skip()` and `test.fixme()` skips apart); New regressions and Newly flaky narrow the list further. While the run goes on, a running test shows the step its worker is on and what that worker and its browsers use right now: cores, memory and open pages.',
    doc: 'reference/test-search',
  },
  'run.changes': {
    title: 'Changes',
    text: [
      'What differs between this run and one baseline. By default that is the last passing run in the same environment — on the same branch, then the branch it forked from (the pull request’s target, else the project’s default branch), then any branch. When no earlier full run passed, it is the last failed run, found the same way; the line under the selector says which rung applied.',
      '',
      'Pick a base branch to take the baseline from that branch only, or pick one earlier run: each shows its branch, environment and outcome. The tests that started or stopped failing, the ones that got slower or faster, the commits landed since the baseline, and the environment fields that moved are all read against that one baseline.',
    ].join('\n'),
    doc: 'features/run-changes',
    recipe: { question: 'Regression or flake?', doc: 'recipes/regression-or-flaky' },
  },
  'run.timeline': {
    title: 'Workers timeline',
    text: [
      'When each test ran on each parallel worker. Gaps and long bars reveal poor parallelization or a single slow test stalling a shard.',
      '',
      '- **Lanes** — one per worker. Playwright replaces a worker process after a failed test; ↻ marks where the new process took over. A dashed line is time the worker ran no test: hover it or ↻ for what it was.',
      '- **Hatched ends** — hook time: setup (`beforeAll`, `beforeEach`, fixtures) at the start, teardown (`afterEach`, `afterAll`, worker cleanup) at the end. A bar spans the hooks Playwright leaves out of a test’s duration, such as a slow `beforeAll`. A failed hook shows in dark red even with **Show hooks** off; hover it for the hooks it ran and the error, click it to open the steps on that hook.',
      '- **Retries** — a test Playwright retried has one bar per attempt, labelled **Attempt 1**, **Attempt 2**…. An attempt that was retried is drawn pale with an outline; the last one is solid: purple when the test passed on retry, red when every attempt failed. Hover any attempt to bring the others forward, joined by arrows in the order they ran, with when and where each one ran.',
      '- **Click a test** to expand its steps into a nested waterfall on the same axis, like a span viewer.',
      '- **Show waits** marks the wasted waits; **Show locks** shows when each named lock was held and how much of the run it serialized.',
      '- **Paused** — a pale striped band over a test is a stop at an editor breakpoint: the test stood still while someone looked at the page. Its time stays on the clock and out of the test’s duration (for a test that ended under the bar, Piwi corrects the runner’s count where Playwright lets it), and the slowest-step and wasted-time figures leave it out too; the bar of a test that stood paused ends where the test ended.',
      '- **Resources** — when the reporter measured them, the machine’s CPU, the memory of the run’s processes and the pages open in the workers share the axis above the rows, one set per shard. While the run is open live, they fill in every few seconds as the reporter measures them. Hover them for the values at that moment and the tests running then. The Resources menu turns each off, and draws one metric under each worker row: its open pages, the CPU or memory of the worker and the browsers it started, or the share of each test spent waiting for a CPU.',
    ].join('\n'),
    doc: 'features/ui-overview#test-run-detail',
  },
  'run.resource-findings': {
    title: 'Resource findings',
    text: 'What the capture fixtures found at the end of each test: browsers, contexts and pages left open after the test or describe block that opened them (with how long they stayed open), pages opened and never used, pages, listeners or route handlers piling up on a page or context that lives across tests, and Node handles a test left running in its worker. Each names the line or the fixture that opened the object. Without the fixtures, the reporter only counts browsers and contexts opened and closed in each file’s steps: those are probable leaks.',
    doc: 'features/resource-leaks#what-it-reports',
  },
  'run.resource-pages': {
    title: 'Open pages over time',
    text: 'How many pages each worker kept open over the run, drawn on the timeline above the worker rows. A line that keeps rising is a page left open test after test.',
    doc: 'features/resource-leaks#in-the-dashboard',
  },
  'run.resource-machine': {
    title: 'Machine',
    text: 'What the run cost the machine it ran on, sampled by the reporter: how busy the CPUs were, CPU time by process (renderers, browsers, workers, the web server), time spent waiting for a CPU, peak memory and the largest process, and the disk the artifacts used. A sharded run shows one machine per shard. What a platform cannot tell is listed as not measured.',
    doc: 'features/cpu-memory-disk#reading-it',
  },
  'run.resource-costliest': {
    title: 'Costliest tests',
    text: 'The tests that used the most CPU in their worker and in the browser processes they started, measured at the end of each test. A test that found pages already open paid for what an earlier test left behind.',
    doc: 'features/cpu-memory-disk#in-the-dashboard',
  },
  // ── Single execution (test-run-case) ──────────────────────────────────
  'case.situation': {
    title: 'Situation',
    text: "One block, read top to bottom; every clue, the raw error and the rest of the facts are one click away.\n\n- **Headline** — what broke, built from the Playwright error itself, and under it since when, on which commit, and whether a newer execution of the test failed again or passed; for a test that passed on retry, its failed attempt's error, naming that attempt\n- **Most likely** — a strong or medium story that chains the deterministic clues, else the cluster's completed diagnosis, else a weak story, else the top clue, as on the cluster page; for a test that did not run, the test that blocked it or where the run stopped\n- **Next** — one action chosen by a policy, with the change it copies and where it comes from\n- **Cluster** — the cluster the failure belongs to, with its issue",
    doc: 'features/evidence#one-execution-diagnosis-first',
  },
  'case.evidence': {
    title: 'Evidence',
    text: [
      'Everything captured for this execution, one tab per view: the failure timeline (steps, network and console on one clock), the attempts of a test that retried, the page at the failure, the test source with what the test ran where the project records coverage, the locators it used, the network requests, the console output, the app state at the end, and the browser performance. It opens on the tab a strong or medium clue cites when that is the source or the performance, else on the Timeline when it can place two or more items; a test that passed on retry opens on Attempts. On a cluster, the line above the tabs names the test and the run it shows.',
      '',
      '- **Timeline** colors a step’s or a request’s duration only when it stands out, and **Network** a request’s by the same rule: at least 1 s, and either a third of the test or more, or twice its usual time and 1 s more, the usual time being the median over the last five passing runs on the same browser (shown under it). A step with parameters opens them from its title, and an arrow at the edge of the axis marks a bar that runs on outside the window.',
      '- **Screen** shows the page as views: its screenshot, its DOM, its accessibility tree, the visual and page diffs, the video. **Open in picker** finds a locator on that DOM; the failing step on the timeline carries the same first three.',
      '- **Most likely** marks what it cites: a dot on the tab that holds it, and "Cited by Most likely" on the timeline rows. A citation opens the tab and rings the request or console entry it names for a moment.',
      '- **An empty tab** says whether the evidence was never captured, captured with nothing to show, or does not apply.',
    ].join('\n'),
    doc: 'features/evidence#one-execution-diagnosis-first',
  },
  // ── Setup & capabilities ──────────────────────────────────────────────
  'setup.presets': {
    title: 'What you want Piwi for',
    text: 'The coarse choice of which capability groups this instance uses. Unchecking a group declines its capabilities everywhere — the pages, panels, settings and MCP tools they own stop showing until you reconsider on this page. Seeing why tests fail is always on.',
    doc: 'guide/getting-started',
  },
  'project.capabilities': {
    title: 'Capabilities',
    text: 'Override the instance default for this project. Leave a capability on the instance default, decline it for this project, or enable it here even when the instance declined it. A declined capability drops its evidence tabs, panels and actions for this project.',
    doc: 'guide/getting-started',
  },
  'cluster.activity': {
    title: 'Activity',
    text: 'The fix attempts reported on this cluster, from the dashboard, an editor or an agent over MCP, each with what the runs made of it: verified when the tests passed on a commit that carried it (its commit, a Piwi-Cluster trailer in a commit message, or its branch), regressed when the cluster failed again. Below them, every write an agent made to this cluster over MCP, with the API key that made it, and what Piwi wrote to the cluster’s tracker issue: the issue it filed, by hand or by a rule, its comments, its moves and its description updates, and a filing a rule left to a person because an open issue already carried the failure’s labels.',
    doc: 'features/agent-skills#what-agents-report-back',
  },
  'fix.toolbox': {
    title: 'More ways to fix',
    text: 'Every other way to fix, verify or reproduce this failure, each folded to one line: the diagnosis, the locator fix, the verify command, the local reproduce-and-bisect recipe, the clusters fixed before, the tests this failure blocked, and the whole fix plan (as Markdown on the cluster page, a link to it on an execution: the same plan `get_fix_plan` returns to an AI agent via the MCP server). The section the next step points at opens with the page: on an execution in this card, on a cluster as a card of its own under the situation block. Open the others as you need them.',
    doc: 'features/fix-plans',
  },
  'case.test-source': {
    title: 'Test source',
    text: 'The source around the failing line and the callers above it — captured from the failure’s call stack — so you can read where it broke, and the code that led there, without opening your editor. When the execution has a trace, this deepens into the complete call stack with the real source of every frame, read from the trace’s embedded files.',
    doc: 'features/evidence#trace-powered-deep-views',
  },
  'case.coverage': {
    title: 'Coverage',
    text: [
      'The code this test ran, as its coverage recorded it: the backend files with their lines, and the browser files.',
      '',
      '- **Server** — files of a backend built with Piwi’s coverage package (ASP.NET Core today), the most lines first. Open one to read its source at the version the test ran, the lines it ran marked in teal, and the executable lines it did not run in slate when the run sent its own coverage.',
      '- **Browser** — the application files whose functions ran in Chromium, by path, or with the functions that ran when the reporter recorded them; such a file opens to its source too.',
      '- **Precision** — by line, by function, or by file, as the reporter’s `coverage` option recorded it.',
      '- **suspect lines** — the changed lines this failing test ran, and **changed** a file changed since the last passing run; both open the cluster’s What changed card.',
    ].join('\n'),
    doc: 'features/code-reach#on-the-execution-page',
  },
  'coverage.areas': {
    title: 'Coverage areas',
    text: 'Name the parts of your code, `front` and `back` for instance, by the patterns of their files. Every suite’s coverage splits the same way, unit and end to end: each area gets its own totals on the coverage page, its own line in the coverage trend, and its share of a pull request’s changed lines. A file belongs to the first area whose patterns match it; a file in none counts only in the totals. The coverage scope, its include and exclude patterns, decides which files count at all.',
    doc: 'features/combined-coverage#areas',
  },
  'coverage.tree': {
    title: 'Files',
    text: 'The repository as a tree, at the commit. Each folder and file carries a bar in the colors of the legend above: the lines both kinds of suite ran, unit tests only, end-to-end tests only, undetermined, and the empty track for lines no suite ran. A folder’s name shows it on the right, with its suites and its least-covered files; its chevron only folds it. **Least covered** sorts each folder by lines no suite ran. Greyed files are tracked in scope but no suite names them.',
    doc: 'features/combined-coverage#find-what-is-not-covered',
  },
  'coverage.least-covered': {
    title: 'Files to cover next',
    text: 'The files of this folder with the most executable lines no suite ran, unit or end to end, the most first, then the lowest share run. Undetermined lines (in a function the browser ran) are not counted. A file opens with each line marked by the suites that ran it, and the next lines no suite ran one click away.',
    doc: 'features/combined-coverage#find-what-is-not-covered',
  },
  'coverage.combined-marks': {
    title: 'Marks by suite',
    text: [
      'With every suite of the commit, the bar at the left of a line says which kinds of suite ran it:',
      '',
      '- **Teal**: unit tests and end-to-end tests both ran it.',
      '- **Blue**: only unit tests ran it. No user path in the end-to-end tests reaches it.',
      '- **Violet**: only the end-to-end tests ran it. Only the Playwright suite protects it.',
      '- **Slate**: no suite ran it. The first place to add a test.',
      '- **Yellow**: undetermined. It sits in a function the browser ran, and the browser records functions, not lines.',
      '',
      'An unmarked line is not code (a blank line, a comment, a brace the compiler does not count).',
    ].join('\n'),
    doc: 'features/combined-coverage#find-what-is-not-covered',
  },
  'coverage.marks': {
    title: 'Coverage marks',
    text: [
      'The bar at the left of a line says what the recorded coverage holds for it:',
      '',
      '- **Teal** — a test ran the line. A file recorded by function marks every line of each function that ran.',
      '- **Slate** — the line is executable and no test ran it, shown when the run recorded the file’s executable lines (server coverage at `lines`).',
      '',
      'An unmarked line ran in no recorded test, or is not code. Your editor marks the file in the same colors, on the file as it stands.',
    ].join('\n'),
    doc: 'features/editor-coverage#the-marks',
  },
  'case.coverage-incomplete': {
    title: 'Incomplete coverage',
    text: 'Part of this test’s coverage is missing: the backend no longer held the coverage of one of its requests when the reporter asked for it, a collection failed, a cap was reached, or part of it is no longer stored. The files listed ran; others may have too.',
    doc: 'features/server-coverage',
  },
  'case.coverage-none': {
    title: 'No coverage for this test',
    text: 'This project records coverage, but this test recorded none. Browser files are recorded in Chromium only, and backend lines only for the requests that reached a backend built for coverage; a run from before coverage was turned on, or with the reporter option off, records none.',
    doc: 'features/code-reach',
  },
  'case.coverage-divergence': {
    title: 'Compared with the last passing run',
    text: [
      'The code this failing execution ran that the test’s last passing execution with coverage did not, and the reverse: the same browser project on the same branch first, else the default branch, else another browser project.',
      '',
      '- **Only in this execution** — an error path, a fallback or a retry branch shows here first.',
      '- **Here / in the pass** — a file both ran at the same version, with the lines only each side ran; open it to see both marked.',
      '- **Another version** — a file whose version differs between the two runs is counted, never compared line by line.',
      '- **Incomplete** — a capture that missed part of what ran never says something did not run.',
    ].join('\n'),
    doc: 'features/coverage-insights#a-failure-s-path-against-its-last-pass',
  },
  'case.coverage-backend-none': {
    title: 'No backend coverage for this test',
    text: 'The run recorded backend coverage, but none for this test. Its requests may not have reached the instrumented backend (a page served from elsewhere, a mocked route, a request that failed), or the backend may no longer have held the coverage when the reporter asked.',
    doc: 'features/server-coverage',
  },
  'coverage.file': {
    title: 'Which tests run this file',
    text: [
      'The tests that run this file, each from its latest run with coverage on the branch.',
      '',
      '- **Counts** — beside each line, how many tests ran it; a slate bar marks an executable line no test runs, when a run recorded the executable lines, and a teal one a line a test ran.',
      '- **Select** — click a line, or Shift-click a range, to list the tests that ran it with their latest outcome. On a line no test runs, the nearest test to copy runs the most of the function around it.',
      '- **Version** — line numbers belong to one version of the file, its git blob; when the tests ran several, pick one.',
      '- **Precision** — a file recorded by function marks its functions, and one recorded by file lists its tests only.',
    ].join('\n'),
    doc: 'features/code-reach#which-tests-run-a-file',
  },
  'coverage.test-map': {
    title: 'In the Test Map',
    text: [
      'Coverage says which lines of the file ran; the Test Map says which user paths reach it, and which tests are still to write on them.',
      '',
      '- **Nodes** — the file’s route handler and the routes it serves, the page or route its file name gives it, and the file itself when a test ran it or it changed unreached.',
      '- **Gaps** — each node’s open scenario gaps, the highest exposure first: tests that do not exist yet. Open a node to see its graph on the Gaps tab.',
    ].join('\n'),
    doc: 'guide/concepts#coverage-and-the-test-map',
  },
  'coverage.combined': {
    title: 'Combined coverage',
    text: [
      'Every suite that ran the code at this commit, counted on one set of executable lines per file version.',
      '',
      '- **Suites** — the reports uploaded with `piwi coverage upload`, and `e2e`, the run coverage of the commit’s complete Playwright runs. A suite the commit lacks comes from the newest commit whose coverage arrived before it, on the commit’s branch then on the default branch, where the file is unchanged.',
      '- **Lines** — the span table’s when a run recorded them, else the reports’. Every suite’s ratio counts on them.',
      '- **Undetermined** — unrun lines inside functions the browser suite ran: its lines are not recorded, so they are shown beside the ratio, never in it.',
      '- **Without data** — tracked files in the coverage scope that no suite names.',
    ].join('\n'),
    doc: 'features/combined-coverage#one-ratio-per-commit',
  },
  'coverage.notes': {
    title: 'What these numbers leave out',
    text: [
      'Where the commit’s numbers come from elsewhere, or miss something:',
      '',
      '- **Totals only** — on a branch, each suite keeps only the report of the commit whose coverage arrived last. An earlier commit keeps its totals, as computed, and no files.',
      '- **Carried** — a suite this commit lacks counts from an earlier commit, for the files whose version is unchanged.',
      '- **Incomplete** — the report was cut at a size limit, or its files disagreed with the checkout.',
      '- **A backend restarted** — a run’s backend restarted or was unreachable: the run still counts, with the lines its tests ran, and e2e is incomplete when no complete run is beside it.',
      '- **No coverage** — a suite the project uploads that neither this commit nor an earlier one has.',
      '- **No inventory** — files no suite names are not counted; upload with the checkout.',
      '- **Earlier scope** — totals kept from before the coverage scope or areas changed are not counted again.',
      '- **Runs that don’t count** — a partial run, a lab run or a probe never counts.',
    ].join('\n'),
    doc: 'features/combined-coverage#what-the-numbers-leave-out',
  },
  'coverage.file-source': {
    title: 'Source not available',
    text: 'Piwi reads a version of a file by its git blob through the project’s source control: a linked clone in the desktop app, GitHub or GitLab with a token, else the file at a run’s commit when its blob matches. Without one, the lines show as numbers.',
    doc: 'features/code-reach#which-tests-run-a-file',
  },
  'export.offline': {
    // Deliberately avoids the word "Export": the hint sits beside a button with
    // that label, and a substring role query would match both.
    title: 'Reading this offline',
    text: 'Takes this investigation out of the dashboard as a file that needs no network and no Piwi server. HTML is one self-contained page with screenshots and video embedded; ZIP adds the raw artifacts — trace archives, full-size video, logs — plus a machine-readable data.json; PDF is a formatted document with screenshots embedded, generated directly with no browser print. Evidence past the size budget is listed in the report as omitted rather than dropped quietly.',
    doc: 'features/offline-export',
    envVars: ['PIWI_EXPORT_MAX_INLINE_BYTES', 'PIWI_EXPORT_MAX_BYTES', 'PIWI_EXPORT_MAX_CASES'],
  },
  'export.replay': {
    title: 'Replaying this failure',
    text: 'A `.piwibug` is the bug report Piwi Picker writes, made from this run: the test’s steps up to the failure, the failing check with what it expected and received, and the failure screenshot. Open it in Piwi Picker’s **Replay** to play the steps in your own browser. What Replay cannot play becomes a step you do by hand; requests, scripts and mocks are listed as not replayed. **Steps (steps.json)** copies the steps alone, to paste into Replay.',
    doc: 'features/offline-export#replay-the-failure-in-a-browser',
  },
  'case.timeline': {
    title: 'Failure timeline',
    text: [
      'One time axis that places this execution’s steps, console entries, network requests and backend log entries on the same clock, with a marker at the moment of failure.',
      '',
      '- **Window** — the default view is the window around the failed step (10s before, 2s after); switch to **Whole test** to see everything.',
      '- **Type chips** hide or show the steps, requests, console entries, dialogs and backend logs in the window. **Only** or Alt-click shows just one type; the failing step and the last shown type always stay. The line beside them says what is hidden, and the choice is remembered in this browser.',
      '- **The table below** reads it in time order: a step with parameters opens them from its title, and a request or console entry opens on its own tab.',
      '- **The failed step** is the one that raised the test’s own error. An error the test caught and went on from (a probe in a try/catch, a retried `toPass` attempt) is greyed out and marked as caught.',
      '- **Paused** — a stop at an editor breakpoint, a band over the lanes. Every timestamp stays on the clock; a step that ran across a stop says how long it stood paused, which its share of the test leaves out.',
      '- **Resources** — when the run sent its resource report, rows under the lanes draw the CPU and memory of the worker that ran the test with the browsers it started, and the pages open in that worker; the pointer reads their values, and the line below says what earlier tests left open and how long the browsers waited for a CPU. Off until you turn it on; the choice is remembered in this browser.',
      '',
      'When a run’s reporter recorded no step start times, positions are estimated from durations and the card says so.',
    ].join('\n'),
    doc: 'features/evidence#one-execution-diagnosis-first',
  },
  'case.resources': {
    title: 'What the test cost',
    text: 'The CPU this test used in its worker and in the browser processes it started, the largest of those processes, how busy the worker’s event loop was, and the pages it found open when it started and left open when it ended. Browser processes are read on Linux only.',
    doc: 'features/cpu-memory-disk#in-the-dashboard',
  },
  'case.web-vitals': {
    title: 'Web Vitals',
    text: 'Core Web Vitals (LCP, CLS, etc.) captured during the test, measuring real loading and responsiveness of the page under test. When empty, the card says which of three things it means: not captured (add the capture fixtures), captured but nothing recorded, or not applicable (Web Vitals need a Chromium browser).',
    doc: 'guide/capture-fixtures',
  },
  'case.console': {
    title: 'Console output',
    text: 'Browser console messages logged while this test ran — often the first clue for a JavaScript error behind a failure. An empty card says which of three things it means: not captured (add the capture fixtures — links to /setup), captured but the page logged nothing, or not applicable. When a trace but no fixtures were present, the entries are recovered from the trace and marked "derived from the trace".',
    doc: 'guide/capture-fixtures',
  },
  'case.network': {
    title: 'Network requests',
    text: [
      'HTTP requests the page made during the test, with timing and status — useful for spotting failed or slow calls. A request that got no response (a reset, a refused connection, an abort) is marked failed, with the error the browser reported.',
      '',
      '- **Full trace** — when the execution has a trace, this view shows every request (all resource types) with headers, timing phases, a waterfall and capped body previews; sensitive header values are masked.',
      '- **An empty card** distinguishes not captured (add the capture fixtures) from captured-but-nothing-happened. With a trace and no fixtures, the list is recovered from the trace and marked “derived from the trace”.',
    ].join('\n'),
    doc: 'features/evidence#trace-powered-deep-views',
  },
  'case.attempts': {
    title: 'Attempts',
    text: 'When a test failed then passed on retry, this compares the failing attempt against the passing one and lists what differed — the error that was there then gone, a request that failed on only one attempt or was much slower on the failing one, a console error, a slower step, a duration or page-state change. Each difference links to the evidence it came from, and a request that is one of the test’s flake suspects links to it. That delta is the flakiness fingerprint, and it feeds the root-cause classifier.',
    doc: 'features/flaky-tests#flaky-test-detection',
  },

  'case.path-variation': {
    title: 'Path variation',
    text: [
      'How this test’s code path varies across its last 30 executions with coverage, in the browser project that ran most of them, compared on the files every execution that ran them ran at one version.',
      '',
      '- **Varying code** — the lines (or functions, or files) some executions ran and others did not, grouped by the executions that ran them, the most evenly split first.',
      '- **Earlier test** — the test whose having finished earlier in the run, or on the same worker, predicts which executions ran the code: at least 90% of them, with 3 executions on each side.',
      '- **Order** — when its failures follow that code too, the test depends on what an earlier test leaves behind, and its flaky root cause is `order`.',
    ].join('\n'),
    doc: 'features/coverage-insights#a-path-that-depends-on-the-tests-before-it',
  },

  'case.flakiness': {
    title: 'Flake suspects',
    text: 'What this test’s failures share and its passes do not, over its last 30 days (at most 200 attempts): a route that is slower or fails, another test running alongside or just before on the same worker, load, a browser. Failures and passes count the attempts showing the factor, out of all. A suspect needs 3 failures and to be at least twice as common among failures as among passes; at most 5 are listed. The condition is what a lab would apply to test it.',
    doc: 'features/flaky-tests#suspects',
  },

  'case.flake-experiments': {
    title: 'Flake Lab experiments',
    text: 'Each `piwi flake` run on this test: a control with no condition, then one arm per suspect, run with retries off on the machine that ran the command. An arm counts only failures with the same error as the test’s failures in history, and stops at 3 of them. It reproduced when at least half its runs failed that way and a one-sided Fisher exact test against the control gives p < 0.05. A verify experiment reruns the reproducing arm after a fix; it holds when enough runs pass under the same condition.',
    doc: 'features/flake-lab',
  },

  // ── Test case across runs ─────────────────────────────────────────────
  'case.history-chart': {
    title: 'Duration trend',
    text: 'This test’s duration across recent runs. Rising times or spikes hint at a slowdown or instability.',
    doc: 'features/flaky-tests#flaky-test-detection',
  },

  // ── Failure clusters ──────────────────────────────────────────────────
  'cluster.concept': {
    title: 'Failure clusters',
    text: 'Failures with the same error fingerprint are grouped into one cluster, so a single root cause shows up once instead of N times.',
    doc: 'features/failure-clusters#how-failures-are-grouped',
    recipe: { question: 'Triage a run gone red', doc: 'recipes/mass-failure' },
  },
  'cluster.owner': {
    title: 'Owner',
    text: 'Who answers for this cluster’s tests. Taken from a `piwi:owner` annotation on the test when present, otherwise derived from the repository’s CODEOWNERS for the spec’s file path. The link filters this project’s test cases to that owner.',
  },
  'cluster.known-issue': {
    title: 'Known issue',
    text: 'Every link pinned to this cluster, also listed in the Details of each of its executions. The newest Jira issue, or issue on a connected tracker, is the cluster’s known issue and travels with it wherever it is listed; earlier issues and other links, such as a GitHub issue or a pull request, stay listed here.',
  },
  'cluster.scm': {
    title: 'What changed',
    text: 'Recent commits and diffs around when this failure started, so you can connect the break to the change that caused it.',
    doc: 'features/ai-diagnosis#scm-grounded-context',
  },
  'cluster.suspect-lines': {
    title: 'Suspect lines',
    text: 'The changed lines the failing tests ran, read from their coverage, most suspect first: the fewer passing tests of the same run ran a hunk, the higher it ranks. The diff below marks them.\n\n- **lines it ran**: the executed changed lines\n- **a function it ran**: the changed lines inside a function that ran\n- **file reached**: code of the file ran, so every changed line of the hunk counts',
    doc: 'guide/concepts#suspect-lines',
  },
  'cluster.suspect-lines-coverage': {
    title: 'Suspect lines need coverage',
    text: 'This project records coverage, but the failing tests of this run recorded none, so the changes are not narrowed to the lines they ran. A test records browser files in Chromium only, and backend lines only when its requests reach a backend built for coverage; the run may also predate coverage being turned on.',
    doc: 'features/server-coverage',
  },
  'cluster.baseline': {
    title: 'Baseline commit',
    text: 'The last known-good commit. Diffs are computed from here forward to scope the search for the offending change.',
    doc: 'features/ai-diagnosis#scm-grounded-context',
  },
  'cluster.commit-browser': {
    title: 'Commit browser',
    text: 'Browse the repository’s recent commits and inspect each diff to pick a baseline or find the suspect change.',
    doc: 'features/ai-diagnosis#scm-grounded-context',
  },
  'cluster.context-input': {
    title: 'Additional context',
    text: 'Extra notes, files or screenshots you add to steer the diagnosis — anything the model can’t infer from the captured evidence.',
    doc: 'features/ai-diagnosis#custom-instructions',
  },
  'cluster.context-preview': {
    title: 'Context preview',
    text: 'Exactly what will be sent to the AI, including how much was trimmed to fit the token budget. Review it before spending tokens.',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
  },
  'cluster.result': {
    title: 'Diagnosis',
    text: 'The AI’s proposed root cause, fix and confidence. Treat it as a lead to verify, not proof — confirm against the evidence before acting.',
    doc: 'features/ai-diagnosis#what-a-diagnosis-contains',
  },
  'cluster.ai-setup': {
    title: 'AI not configured',
    text: 'Diagnosis needs an AI provider and API key. Configure one in Settings → AI to enable automatic and on-demand analysis.',
    doc: 'guide/ai-provider',
  },
  'cluster.coverage': {
    title: 'Data coverage',
    text: 'Which evidence sections were present, truncated or absent for this diagnosis — the same map the model sees. Absent or trimmed evidence lowers confidence; the quote icon marks sections the diagnosis cited.',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
  },

  // ── Notifications / subscribe ─────────────────────────────────────────
  'notifications.subscribe': {
    title: 'Project notifications',
    text: 'Get notified about this project’s runs through your channels. Choose which events trigger an alert, and optionally the branches and environments to hear about — `*` matches any characters, as in `release/*`.',
    doc: 'features/notifications#branches-and-environments',
  },

  // ── Settings ──────────────────────────────────────────────────────────
  'settings.storage-stats': {
    title: 'Storage analysis',
    text: 'How much disk your reports, traces, screenshots and videos use — broken down by project, by file kind and over time, so you can see what to clean up.',
    doc: 'operate/storage#storage-management',
  },
  'settings.cleanup': {
    title: 'Cleanup old runs',
    text: 'Delete runs (and their reports, traces and attachments) older than a chosen age to reclaim storage. Kept runs, and the newest runs of each project when a floor is set, are skipped. This cannot be undone.',
    doc: 'operate/storage#storage-management',
    envVars: ['PIWI_RETENTION_DAYS', 'PIWI_RETENTION_MIN_RUNS'],
  },
  'account.email': {
    title: 'Email & verification',
    text: 'Your account email is used for password resets and notifications. Verifying it confirms you own the address.',
    doc: 'operate/authentication#user-management',
  },
  'settings.smtp': {
    title: 'SMTP status',
    text: 'Outbound email (resets, invites, notifications) is configured through environment variables and shown here read-only.',
    doc: 'features/notifications#smtp-configuration',
    envVars: [
      'PIWI_SMTP_HOST',
      'PIWI_SMTP_PORT',
      'PIWI_SMTP_USER',
      'PIWI_SMTP_PASS',
      'PIWI_SMTP_FROM',
      'PIWI_SMTP_FROM_NAME',
      'PIWI_SMTP_SECURE',
    ],
  },
  'notifications.channels': {
    title: 'Channels',
    text: 'Destinations an alert can go to — browser, email, Slack (an incoming webhook, or a bot token posting through the Web API), Microsoft Teams or webhook. Create a channel (the form shows where to get each URL, and can send a test first: a channel whose test went through is saved verified), then subscribe events to it. Administrators can make a channel global (usable by everyone); without authentication every channel is global.',
    doc: 'features/notifications#channels',
  },
  'notifications.subscriptions': {
    title: 'Subscriptions',
    text: 'Which events (run failed, new cluster, etc.) notify which channel, optionally scoped to one project and filtered. Global subscriptions deliver instance-wide and are managed by administrators.',
    doc: 'features/notifications#subscriptions',
  },
  'settings.ai-provider': {
    title: 'AI provider',
    text: 'Configure the model providers behind the four AI roles — diagnosis, research, embedding and assistant. Each role has its own provider config, or reuses another role’s provider and credentials. Keys are stored encrypted and never returned by the API.',
    doc: 'guide/ai-provider',
    envVars: ['PIWI_AI_PROVIDER', 'PIWI_AI_MODEL', 'PIWI_AI_API_KEY', 'PIWI_AI_BASE_URL', 'PIWI_AI_TEMPERATURE'],
  },
  'settings.ai-instructions': {
    title: 'Global analysis instructions',
    text: 'Guidance applied to every diagnosis across all projects — house style, terminology, or things to always check. Per-project instructions add to this.',
    doc: 'features/ai-diagnosis#custom-instructions',
  },
  'settings.ai-research': {
    title: 'Research model',
    text: 'An optional cheaper/faster model that pre-analyzes the failure (on a lean view) before the main model writes the final diagnosis. It can use its own provider, and the costly SCM diff is only fetched when it flags a likely regression. It also handles cluster naming and merge adjudication, so configuring a cheap research model routes those utility calls away from the expensive diagnosis model.',
    doc: 'guide/ai-provider#model-roles',
    envVars: [
      'PIWI_AI_RESEARCH_PROVIDER',
      'PIWI_AI_RESEARCH_MODEL',
      'PIWI_AI_RESEARCH_BASE_URL',
      'PIWI_AI_RESEARCH_API_KEY',
      'PIWI_AI_RESEARCH_TEMPERATURE',
    ],
  },
  'settings.ai-assistant': {
    title: 'Assistant model',
    text: 'The model the in-app assistant answers questions with. Unset, it uses the diagnosis model; set it to point the assistant at a faster, cheaper model while diagnosis keeps the strong one. Like research, it can reuse another role’s provider and key with a model of its own.',
    doc: 'features/assistant#the-model',
    envVars: [
      'PIWI_AI_ASSISTANT_PROVIDER',
      'PIWI_AI_ASSISTANT_MODEL',
      'PIWI_AI_ASSISTANT_BASE_URL',
      'PIWI_AI_ASSISTANT_API_KEY',
      'PIWI_AI_ASSISTANT_TEMPERATURE',
    ],
  },
  'settings.ai-limits': {
    title: 'Diagnosis context limits',
    text: 'Caps on how much evidence (and how many tokens) go into each diagnosis. Higher limits give the model more to work with but cost more. Each field can be pinned individually by its env var.',
    doc: 'guide/ai-provider#context-limits-and-token-cost',
    envVars: [
      'PIWI_AI_MAX_SAMPLE_ERROR_CHARS',
      'PIWI_AI_MAX_SCM_PATCH_BUDGET',
      'PIWI_AI_MAX_AFFECTED_TESTS',
      'PIWI_AI_MAX_STEPS',
      'PIWI_AI_MAX_CONSOLE_ENTRIES',
      'PIWI_AI_MAX_CONSOLE_ENTRY_CHARS',
      'PIWI_AI_MAX_NETWORK_REQUESTS',
      'PIWI_AI_MAX_ARIA_SNAPSHOT_CHARS',
      'PIWI_AI_MAX_TEST_SOURCE_CHARS',
      'PIWI_AI_MAX_SERVER_LOG_ENTRIES',
      'PIWI_AI_MAX_SERVER_LOG_ENTRY_CHARS',
      'PIWI_AI_MAX_IMAGES',
      'PIWI_AI_MAX_PASSED_PEERS',
      'PIWI_AI_MAX_CONSOLE_WINDOW',
      'PIWI_AI_SLOW_REQUEST_MS',
      'PIWI_AI_MAX_TRACE_STACK_FRAMES',
      'PIWI_AI_MAX_TRACE_NETWORK_REQUESTS',
    ],
  },
  'settings.localization': {
    title: 'Localization',
    text: 'Set how dates and times are formatted and which time zone they show in. Each viewer can pick their own format for their browser; administrators set the instance default everyone else gets.',
    doc: 'operate/localization',
  },
  'settings.locale': {
    title: 'Date & time format',
    text: 'The locale that decides how dates and times read: day/month order and 12-hour vs 24-hour time (for example fr-FR shows 22/09/2026 14:30). "Automatic" follows the browser.',
    doc: 'operate/localization#date-and-time-format',
    envVars: ['PIWI_LOCALE'],
  },
  'settings.time-zone': {
    title: 'Time zone',
    text: 'The time zone absolute times are shown in. "Automatic" uses each viewer\'s own browser time zone, which is the default.',
    doc: 'operate/localization#time-zone',
    envVars: ['PIWI_TIME_ZONE'],
  },
  'settings.users': {
    title: 'Users & roles',
    text: 'Accounts and their instance role. An Administrator can do everything on every project; a Member only what the project roles granted to them or to their groups allow.',
    doc: 'operate/authentication#roles',
  },
  'settings.groups': {
    title: 'Groups',
    text: 'Named sets of users, such as QA or Product owners. A group receives project roles the way a user does, and its members hold them; rights add up, and groups do not nest. A group never makes anyone an Administrator.',
    doc: 'operate/project-access#groups',
  },
  'settings.roles': {
    title: 'What each role can do',
    text: 'The five project roles and what each one allows, read from the same definitions the server enforces. The roles are fixed: to give someone rights, grant them a role on the permission grid or in a project’s Members.',
    doc: 'operate/project-access#what-each-role-can-do',
  },
  'settings.permissions': {
    title: 'Permission grid',
    text: 'Every group and user against every project: pick a role in a cell to grant it there, or none to remove it. Each change saves at once. All projects also covers projects created later, and a role held only through a group or All projects shows faint.',
    doc: 'operate/project-access#permission-grid',
  },
  'settings.api-keys': {
    title: 'API keys',
    text: 'Tokens (prefixed pd_) that let the reporter or scripts authenticate without a password. Shown once at creation; revoke anytime.',
    doc: 'operate/api-keys',
  },
  'settings.tags': {
    text: 'Reusable labels you can attach to projects for grouping and filtering across the dashboard.',
  },
  'settings.wasted-time': {
    title: 'Wasted-time patterns',
    text: 'Define which wait steps count as wasted time. A wait is wasted when any pattern matches its step title or source location. Patterns are case-insensitive and support `*` and `?` wildcards. Changes apply to existing runs immediately.',
    doc: 'features/slow-tests',
    envVars: ['PIWI_WASTED_WAIT_PATTERNS'],
  },
  'settings.ci-cost': {
    title: 'Cost of a CI minute',
    text: 'What one CI minute costs you. When set, wasted CI time is also shown as money in the analytics widgets and quality reports; leave it empty to show minutes only.',
    doc: 'features/quality-reports#cost-of-a-ci-minute',
    envVars: ['PIWI_CI_MINUTE_COST'],
  },
  'settings.timeout-hygiene': {
    title: 'Timeout hygiene',
    text: 'Thresholds for flagging oversized per-test timeouts and stale test.slow() marks. Opportunities are recomputed at read time, so changes apply to existing runs immediately.',
    doc: 'features/slow-tests',
  },
  'settings.pr-feedback': {
    title: 'Pull-request feedback',
    text: 'When a run finishes on a branch with an open pull request, Piwi can post a summary comment — new failures separated from pre-existing ones, with suggested locators — and set a commit status. Needs PIWI_SITE_URL and an SCM token with write access.',
    doc: 'features/pr-feedback',
    envVars: ['PIWI_SITE_URL'],
  },
  'settings.auto-heal': {
    title: 'Auto-heal pull requests',
    text: 'When a locator breaks on the default branch and healing has high-confidence evidence, Piwi opens the fix pull request itself — a deterministic one-line locator edit per broken call site. Off by default, with an explicit per-project allowlist. Needs PIWI_SITE_URL and an SCM token with write access.',
    doc: 'features/auto-heal',
    envVars: ['PIWI_SITE_URL'],
  },
  'settings.integrations': {
    title: 'Integrations',
    text: 'Connect an issue tracker so pinned links unfurl with a title and status and stay in sync. Jira Cloud connects with an account email and an API token, classic or scoped; set the connection once and every project uses it.',
    doc: 'operate/integrations',
    envVars: ['PIWI_JIRA_BASE_URL', 'PIWI_JIRA_EMAIL', 'PIWI_JIRA_API_TOKEN'],
  },
  'settings.integrations.connection': {
    title: 'Connect a system',
    text: 'Paste the address of any Jira page: Piwi reads the site from it (https://your-team.atlassian.net) and checks it is Jira Cloud. Create a classic or a scoped API token as the account Piwi acts as, then check sign-in: it shows the account, the token kind and the projects the account reaches, before anything is saved. Credentials are encrypted at rest and never shown again.',
    doc: 'operate/integrations#connecting-jira-cloud',
  },
  'settings.integrations.private-host': {
    title: 'Private hosts',
    text: 'A connection base URL is administrator-supplied and trusted, so a self-hosted tracker on a private network works. Links a non-administrator pins are still fetched through the SSRF guard.',
    doc: 'operate/integrations#trusted-base-urls-and-private-hosts',
  },
  'settings.auto-diagnose': {
    title: 'Auto-diagnose',
    text: 'When a run finishes, up to 3 new failure clusters are diagnosed automatically — each diagnosis is one research call (when a research model is configured) plus one diagnosis call — and new clusters get human-readable titles in one batched call. Requires the diagnosis model to be configured.',
    doc: 'guide/ai-provider#enabling-ai-diagnosis',
    envVars: ['PIWI_AI_AUTO_DIAGNOSE'],
  },
  'settings.ai-notifications': {
    title: 'Diagnosis notifications',
    text: 'Show a browser notification when a diagnosis finishes. This is a per-browser preference stored on this device only — it is not shared with other users or saved on the server, and it needs the browser’s notification permission.',
  },
  'settings.embedding-model': {
    title: 'Embedding model',
    text: 'Embeds failures so semantically-similar errors group together (used by failure clustering). Can reuse another role’s provider or configure its own.',
    doc: 'guide/ai-provider#model-roles',
    envVars: [
      'PIWI_AI_EMBEDDING_PROVIDER',
      'PIWI_AI_EMBEDDING_MODEL',
      'PIWI_AI_EMBEDDING_BASE_URL',
      'PIWI_AI_EMBEDDING_API_KEY',
    ],
  },
  'settings.privacy': {
    title: 'Privacy notice',
    text: 'What data is sent to the configured LLM provider when diagnosing a failure, and how secrets are stored. API keys are encrypted at rest; env vars keep them out of the DB entirely.',
    doc: 'features/ai-diagnosis#what-a-diagnosis-contains',
  },
  'settings.storage-backend': {
    title: 'Storage backend',
    text: 'Where test artifacts (HTML reports, traces, attachments) are stored — local disk or S3. Configured entirely through environment variables; shown here read-only.',
    doc: 'operate/storage#storage-architecture',
    envVars: [
      'PIWI_STORAGE_TYPE',
      'PIWI_STORAGE_PATH',
      'PIWI_S3_BUCKET',
      'PIWI_S3_REGION',
      'PIWI_S3_ACCESS_KEY_ID',
      'PIWI_S3_SECRET_ACCESS_KEY',
      'PIWI_S3_ENDPOINT',
      'PIWI_S3_FORCE_PATH_STYLE',
    ],
  },
  'settings.auth-toggle': {
    title: 'Authentication',
    text: 'Role-based access control and API keys. Off by default — when disabled, every endpoint behaves as a single virtual administrator.',
    doc: 'operate/authentication',
    envVars: ['PIWI_AUTH_ENABLED', 'PIWI_AUTH_SECRET'],
  },
  'account.display-name': {
    title: 'Display name',
    text: 'A friendly name shown alongside your account. Optional, and visible only within the dashboard.',
  },
  'account.connected-accounts': {
    title: 'Connected accounts',
    text: 'Sign in with an OAuth provider (Google or GitHub). Providers are configured by an operator through environment variables; one provider can be linked per account.',
    doc: 'operate/authentication#oauth-google-github',
    envVars: [
      'PIWI_OAUTH_GOOGLE_CLIENT_ID',
      'PIWI_OAUTH_GOOGLE_CLIENT_SECRET',
      'PIWI_OAUTH_GITHUB_CLIENT_ID',
      'PIWI_OAUTH_GITHUB_CLIENT_SECRET',
      'PIWI_OAUTH_ALLOWED_DOMAINS',
      'PIWI_OAUTH_GITHUB_ALLOWED_ORGS',
    ],
  },
  'account.password': {
    title: 'Password',
    text: 'Change the password you sign in with. OAuth-only accounts manage their password through their provider.',
    doc: 'operate/authentication#user-management',
  },
  'notifications.test-email': {
    title: 'Send test email',
    text: 'Send a test message through the configured SMTP server to verify delivery. Uses the environment-configured SMTP connection.',
    doc: 'features/notifications#smtp-configuration',
  },

  // ── MCP ───────────────────────────────────────────────────────────────
  'mcp.tools': {
    title: 'What it provides',
    text: 'The tools this MCP server exposes to AI agents, letting them query your projects, runs and failures directly.',
    doc: 'features/mcp#what-it-provides',
  },
  'mcp.auth': {
    title: 'Authentication',
    text: 'A client signs in through OAuth: it opens this instance in the browser and you allow it. It can also send an API key (`pd_`), the same keys as the rest of the dashboard.',
    doc: 'features/mcp#authentication',
  },
  'mcp.client-setup': {
    title: 'Client setup',
    text: 'Copy-paste configuration to connect Claude Code, Cursor, VS Code and other MCP clients to this server.',
    doc: 'features/mcp#client-setup',
  },
  'mcp.skills': {
    title: 'Agent skills',
    text: 'Portable SKILL.md workflow instructions for AI coding agents — investigate a failure, apply a healed locator, stabilize flaky tests. Installed into your test project by the reporter CLI; each one prefers this MCP server and falls back to the dashboard UI.',
    doc: 'features/agent-skills',
  },

  // ── Shared ────────────────────────────────────────────────────────────
  'shared.entity-links': {
    title: 'Entity links',
    text: 'Links to external systems (Jira, GitHub, etc.) attached to this item. The provider is detected automatically from the URL.',
  },
  'ide.open': {
    title: 'Open in IDE',
    text: [
      'Click a source path to open it in your local editor.',
      '',
      '- **JetBrains IDE with the Piwi plugin** (Rider, WebStorm, IntelliJ IDEA) whose project is connected to this instance — nothing to set: the IDE finds the file in its open projects, opens it at the line and confirms.',
      '- **VS Code with the Piwi extension** — nothing to set: the extension finds the file in the window focused last.',
      '- **Otherwise** set your local workspace folder (so VS Code gets an absolute path) or a JetBrains project name, then pick a method and hit **Test** to check it works.',
      '- **Desktop app** — also opens files through your IDE’s command-line launcher (`code`, `rider`, …).',
      '- **Browser** — **Auto** falls back to the JetBrains local server, then to a `vscode://` or `jetbrains://` launch, which cannot confirm.',
      '',
      'These preferences live in this browser only.',
    ].join('\n'),
    doc: 'features/ide-integration',
  },

  // ── Locator healing ────────────────────────────────────────────────────
  'locator-healing': {
    title: 'Locator fix',
    text: [
      'When a locator breaks after a UI change, Piwi suggests pre-captured alternatives from the last passing run — or from another test in the project that uses the same locator.',
      '',
      '- **Ranking** — each alternative is ranked by stability score: prefer `data-testid` (100) over CSS classes (10–40).',
      '- **Recommended fix** — the exact one-line edit for the failing test, with **Copy fix prompt** for an AI coding agent.',
      '- **Your pick** marks a replacement you confirmed on the failing page. **Pick from snapshot** opens the failure-time DOM and lets you click the intended element; **Pick from trace** opens the failure trace in the trace viewer, whose Pick locator tool works on the recorded page snapshots.',
    ].join('\n'),
    doc: 'features/locator-healing',
    recipe: { question: 'Fix a broken locator', doc: 'recipes/broken-locator' },
  },

  // ── Locator index ──────────────────────────────────────────────────────
  'project.locator-check': {
    title: 'Check locators',
    text: 'Paste locators, one per line as the Piwi Picker extension copies them, or lines of test code. Each one is looked up among the chains the project’s tests used: exactly, through the same last call inside other containers, through another call that finds the same element (a shorter name, a regex), or as a container other chains search inside. The tests reaching any of them are listed once at the end.',
    doc: 'features/locator-usage#the-locators-page',
  },
  'project.bug-reports': {
    title: 'Bug reports',
    text: 'Bugs reported from Piwi Picker: the steps recorded on the page, the assertion that states what should have happened, with the value the page showed instead, and the evidence the reporter chose to send (screenshots, console errors, failed requests, an outline of the page). Each report renders a failing test to commit with test.fail() and the piwi:bug annotation; the runs of that test then move the report along: test committed, looks fixed when the test passes while still marked to fail, closed once it passes as an ordinary test.',
    doc: 'features/bug-reports',
  },
  'bug-report.spec': {
    title: 'The failing test',
    text: 'The steps written as a Playwright spec with this project’s settings (the test import and the folder for bug specs, in the project’s Generated specs settings), its page objects and the locators its tests already use. To commit: marked test.fail() so the suite stays green while the bug exists, with @bug and piwi:bug so its runs follow the report. To run: the same test without test.fail(), which fails on the expected assertion while the bug is there.',
    doc: 'features/bug-reports#the-failing-test',
  },
  'project.locator-index': {
    title: 'Locator index',
    text: [
      'Every locator chain recorded in the steps of the project’s runs, with the tests that use it and the actions they perform through it. New runs update it as they arrive.',
      '',
      '- **Branch** picks what a branch’s tests use: the tests that ran on it with what they did there, the others with what they do on the default branch.',
      '- **Matching** is by chain text: to see which elements of a live page these chains reach, use Tested elements in the Piwi Picker extension.',
      '- **Stability** — a chain the locator stability rules flag says why: brittle ones break on changes unrelated to what the test checks, such as a position, a styling class or the page structure. The Stability select lists only those.',
    ].join('\n'),
    doc: 'features/locator-usage#branches',
  },

  // ── Environment diff ────────────────────────────────────────────────────
  'environment-diff': {
    title: 'Environment diff',
    text: 'Compares this execution’s environment (Playwright version, browser config, locale, viewport, CI provider, …) against the same test’s last passing run on the same browser — from the same environment when one exists, then the same branch, then the most recent; the subtitle says when the baseline had to come from another environment. Only changed keys are shown — an empty diff rules out environment drift as the cause.',
  },

  // ── Visual diff ──────────────────────────────────────────────────────────
  'visual-diff': {
    title: 'Visual diff',
    text: 'Pixel-compares the failing screenshot against the same test’s last passing screenshot (same browser, preferring the same environment and then the same branch). Red pixels in the overlay mark what changed. When the two screenshots have different dimensions the ratio is flagged as unreliable.',
  },

  // ── Page diff ────────────────────────────────────────────────────────────
  'case.page-diff': {
    title: 'Page diff',
    text: 'Compares the failing page’s ARIA structure against the same test’s last passing (green) sample — same browser, preferring the same environment then branch. Shows what was added, removed, renamed, changed or moved, with unchanged subtrees collapsed and the failing locator’s element highlighted. A green sample is captured about once a day per test, so a baseline appears after the next passing run.',
  },

  // ── Page state ───────────────────────────────────────────────────────────
  'page-state': {
    title: 'App state at test end',
    text: 'URL, history state, storage key names + value lengths, and cookie names + flags captured when the test ended. Values are never captured. Disable with the reporter’s capturePageState option.',
    doc: 'guide/capture-fixtures',
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicKey = keyof typeof HELP_TOPICS;

/**
 * Env var(s) attached to a help topic (typed as `PiwiEnvVarName[]`). Returns an
 * empty array when the topic has none. Use this instead of indexing
 * `HELP_TOPICS[key].envVars` directly — the `as const` registry narrows each
 * entry to its literal shape, so direct indexing errors on entries that omit
 * `envVars`; this helper widens through `HelpTopic`.
 */
export function helpEnvVars(key: HelpTopicKey): PiwiEnvVarName[] {
  return (HELP_TOPICS[key] as HelpTopic).envVars ?? [];
}
