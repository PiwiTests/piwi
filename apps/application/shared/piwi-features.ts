/**
 * The product feature catalog — one entry per user-facing feature, grouped by
 * the four jobs Piwi serves (keep the history, explain the failures, hand back
 * a fix, find what the tests miss), then the routes that carry them to people
 * (trends and reports, other tools) and the operator surface.
 *
 * It is the one grouping of the product. The docs render three things from it:
 * the All features page (`apps/docs/reference/features.md`, built at
 * `docs:gen`), the Features sidebar (`apps/docs/.vitepress/navigation.ts`) and the
 * landing page's cards. An entry's `title` is also its page's H1 and sidebar
 * label, so a feature has one name everywhere.
 *
 * Kept dependency-free in `shared/` so the docs generator can import it with no
 * app/runtime deps, exactly like `piwi-env-vars.ts`. `docs-drift.test.ts`
 * resolves every `doc` target here against a real page + heading, so a renamed
 * page or moved anchor fails the test.
 */

/**
 * What a feature needs beyond a running reporter. The reporter is the baseline
 * every feature builds on, so an empty list renders as "reporter" — anything
 * listed is the extra a reader must switch on.
 */
export type FeatureNeed =
  | 'fixtures' // the capture fixtures
  | 'llm' // a configured AI provider key
  | 'scm' // a source-control access token
  | 'backend' // a backend instrumentation package in the app under test
  | 'desktop' // the desktop app
  | 'extension' // the browser extension
  | 'admin'; // an administrator (or auth disabled)

/** Human labels for the need chips, used by the All features generator. */
export const FEATURE_NEED_LABELS: Record<FeatureNeed, string> = {
  fixtures: 'capture fixtures',
  llm: 'an AI key',
  scm: 'an SCM token',
  backend: 'a backend integration',
  desktop: 'the desktop app',
  extension: 'the browser extension',
  admin: 'an administrator',
};

/**
 * The docs page that switches each prerequisite on. The `<Needs>` chips on the
 * docs pages link here, and `docs-drift.test.ts` resolves every target.
 */
export const FEATURE_NEED_DOCS: Record<FeatureNeed, string> = {
  fixtures: 'guide/capture-fixtures',
  llm: 'guide/ai-provider',
  scm: 'guide/source-control',
  backend: 'guide/backend-logs',
  desktop: 'features/desktop',
  extension: 'features/extension',
  admin: 'operate/authentication#roles',
};

export interface PiwiFeature {
  /** The feature, in the words a reader would type; also its page's H1 and sidebar label. */
  title: string;
  /** One line: what it does. */
  summary: string;
  /** Extra prerequisites beyond the reporter; empty means reporter only. */
  needs: FeatureNeed[];
  /** Where it lives in the dashboard — a short route/tab hint. */
  where: string;
  /** Docs page (+ optional `#anchor`), resolved by `docs-drift.test.ts`. */
  doc: string;
}

export interface FeatureGroup {
  /** The job, or the delivery route, this group of features serves. */
  title: string;
  /** One line describing it; the landing page shows it on the group's card. */
  intro: string;
  features: PiwiFeature[];
}

export const PIWI_FEATURE_GROUPS: FeatureGroup[] = [
  {
    title: 'Keep the history',
    intro:
      'CI deletes every report it makes. Piwi keeps every run, trace and report, so "has this always been flaky?" and "did my fix hold?" are answerable at all.',
    features: [
      {
        title: 'UI overview',
        summary: 'Every run, trace and HTML report kept and browsable, live-updating as runs start and finish.',
        needs: [],
        where: 'Home; Project → Runs',
        doc: 'features/ui-overview',
      },
      {
        title: 'Branches',
        summary: 'Branch as a first-class dimension: filter by it, and compare against a baseline computed per branch.',
        needs: [],
        where: 'Project → filter bar',
        doc: 'features/branches',
      },
      {
        title: 'What changed in a run',
        summary: 'Compare two runs — newly failing, newly passing, still red — against a chosen baseline.',
        needs: [],
        where: 'Test run → Changes',
        doc: 'features/run-changes',
      },
      {
        title: 'Import past runs',
        summary: 'Backfill history from existing Playwright JSON/blob reports so trends start with a past, not empty.',
        needs: ['admin'],
        where: 'Setup; ingest API',
        doc: 'guide/importing-runs',
      },
      {
        title: 'Offline export',
        summary:
          'A run or execution exported as a self-contained bundle (and a Perfetto trace) that outlives retention.',
        needs: [],
        where: 'Run / execution → Export',
        doc: 'features/offline-export',
      },
      {
        title: 'Share links',
        summary:
          'A signed, read-only link to a failure, a quality report or a live dashboard for someone without an account, and a status badge for a README.',
        needs: [],
        where: 'Execution → Share',
        doc: 'features/share-links',
      },
    ],
  },
  {
    title: 'Explain the failures',
    intro:
      'Group forty red tests into the three problems behind them, score the flaky ones by the CI minutes they waste, and — optionally — have an LLM explain a cluster against your real git diff.',
    features: [
      {
        title: 'Failure evidence',
        summary:
          'One failing execution, diagnosis-first: error, clues, attempts, trace-powered views and (with fixtures) console, network and ARIA.',
        needs: [],
        where: 'Test case → execution',
        doc: 'features/evidence',
      },
      {
        title: 'Failure clusters & the inbox',
        summary:
          'Failures sharing an error fingerprint collapsed into one cluster, triaged once with an owner and known-issue link.',
        needs: [],
        where: 'Test run → Failures; Home',
        doc: 'features/failure-clusters',
      },
      {
        title: 'Environment incidents',
        summary:
          'A run that failed because the app under test was down, recognized and kept out of flaky scores, baselines, fix verification and the gate.',
        needs: [],
        where: 'Test run header; Home inbox; Project → Timeline',
        doc: 'features/environment-incidents',
      },
      {
        title: 'Flaky tests & quarantine',
        summary:
          'Flaky detection and cost scoring, the suspects each flaky test’s history points at, and quarantine that keeps a known-bad test running but off the merge gate.',
        needs: [],
        where: 'Project → Failures → Flaky',
        doc: 'features/flaky-tests',
      },
      {
        title: 'Flake Lab',
        summary:
          'Make a flaky test fail on demand: `piwi flake` replays each suspect as a condition next to a control, and `piwi flake verify` proves the fix under the same condition.',
        needs: ['fixtures'],
        where: 'Project → Flake Lab; Test case → Flakiness; reporter (`piwi flake`)',
        doc: 'features/flake-lab',
      },
      {
        title: 'Slow tests & wasted time',
        summary:
          'Slowest tests, timeout headroom, stale `test.slow()`, slow endpoints and Web Vitals — the time your suite costs.',
        needs: ['fixtures'],
        where: 'Project → Performance; Analytics',
        doc: 'features/slow-tests',
      },
      {
        title: 'Resource leaks',
        summary:
          'Browsers, contexts and pages your tests leave open or open for nothing, listed with the line that opened them.',
        needs: ['fixtures'],
        where: 'Run → Resources; Execution → Performance; reporter output',
        doc: 'features/resource-leaks',
      },
      {
        title: 'CPU, memory & disk',
        summary:
          'What a run cost the machine: CPU by process, time spent waiting for a CPU, peak memory and disk, after every run.',
        needs: [],
        where: 'Run → Resources; reporter output; GitHub job summary',
        doc: 'features/cpu-memory-disk',
      },
      {
        title: 'AI diagnosis',
        summary:
          'An LLM explains a cluster against your actual diff, with a suggested patch validated against your source first.',
        needs: ['llm'],
        where: 'Cluster → Diagnosis',
        doc: 'features/ai-diagnosis',
      },
      {
        title: 'Backend logs',
        summary:
          'Server-side warnings, errors and spans captured per test and shown next to the request that triggered them.',
        needs: ['backend'],
        where: 'Execution → network',
        doc: 'guide/backend-logs',
      },
    ],
  },
  {
    title: 'Hand back a fix',
    intro:
      'The point is to leave with something to do, not just something to read: a ranked replacement locator, a validated patch, an owner, and the command that verifies the work.',
    features: [
      {
        title: 'Locator healing',
        summary:
          'When a selector breaks, ranked replacement locators captured from the last passing run, with a recommended fix.',
        needs: ['fixtures'],
        where: 'Execution → Locator fix',
        doc: 'features/locator-healing',
      },
      {
        title: 'Who uses a locator',
        summary:
          'Before changing an element, the tests whose steps reach it and the lines they reach it from, or check pasted locators against every run.',
        needs: [],
        where: 'Execution → Locators; Project → Locators',
        doc: 'features/locator-usage',
      },
      {
        title: 'Locator preflight',
        summary:
          'Before a push, the test locators your diff breaks — a renamed label, a removed test id, a changed translation — with the rewrite applied in place.',
        needs: [],
        where: 'piwi preflight',
        doc: 'features/preflight',
      },
      {
        title: 'Fix plans, reproduce & bisect',
        summary: 'A plan to reproduce a failure locally and bisect to the commit that introduced it.',
        needs: [],
        where: 'Cluster / execution → Fix plan',
        doc: 'features/fix-plans',
      },
      {
        title: 'Auto-heal PRs',
        summary:
          'A pull request that swaps a broken locator for its healed replacement — you review and merge, Piwi never does.',
        needs: ['fixtures', 'scm', 'admin'],
        where: 'Settings → Auto-heal',
        doc: 'features/auto-heal',
      },
      {
        title: 'Issue tracking (Jira)',
        summary:
          'A Jira issue filed from a failure with the fix plan as its body, linked back as the known issue and kept in sync with the cluster.',
        needs: ['admin'],
        where: 'Cluster, execution or inbox row → Create issue',
        doc: 'features/issue-tracking',
      },
      {
        title: 'Issue automation',
        summary:
          'Rules that file an issue for a failure that keeps failing on the branches and environments you choose, and keep its comments and description current.',
        needs: ['admin'],
        where: 'Project → Settings → Issue tracker',
        doc: 'features/issue-automation',
      },
      {
        title: 'Pull-request feedback & re-run',
        summary: 'A summary of the failures on the branch posted to the PR, and a re-run triggered from the dashboard.',
        needs: ['scm'],
        where: 'Settings → Pull requests',
        doc: 'features/pr-feedback',
      },
      {
        title: 'CI merge gate',
        summary:
          'A `piwi gate` command that blocks a merge on new failures or flakiness, with the run URL in the CI log.',
        needs: [],
        where: 'CI (`piwi gate`)',
        doc: 'reference/cli',
      },
      {
        title: 'Test selections',
        summary:
          'Run only the tests that matter — changed files, a subset, balanced shards — from the CLI or the dashboard.',
        needs: [],
        where: 'Project → Selections; CLI',
        doc: 'features/test-selection',
      },
      {
        title: 'AI steps',
        summary: 'Author and replay natural-language test steps an LLM turns into Playwright actions.',
        needs: ['llm'],
        where: 'Reporter config',
        doc: 'features/ai-steps',
      },
    ],
  },
  {
    title: 'Find what your tests miss',
    intro:
      'The runs you already have show which routes, pages and controls no test reaches, and which ones a test reaches without noticing when they break; each gap comes with a skeleton to start the missing test from.',
    features: [
      {
        title: 'Scenario gaps & the Test Map',
        summary:
          'Routes and pages your runs reach but no test checks, ranked by exposure, each with a skeleton to start from.',
        needs: ['fixtures'],
        where: 'Project → Gaps',
        doc: 'features/scenario-gaps',
      },
      {
        title: 'Uncovered changes in pull requests',
        summary:
          'The files a pull request changed that no test observably reaches, posted back to the PR with a commit status.',
        needs: ['scm'],
        where: 'Pull request comment',
        doc: 'features/uncovered-changes',
      },
      {
        title: 'Code reach',
        summary:
          'Which tests execute each application source file, from JavaScript coverage on a scheduled run, by file or by function: feeds impact-from-diff, uncovered changes and preflight.',
        needs: ['fixtures'],
        where: 'Reporter options captureCodeReach and coverage.browser; Execution → Source; a file’s coverage page',
        doc: 'features/code-reach',
      },
      {
        title: 'Server coverage',
        summary:
          'The backend files, functions and lines each test ran, per test, from an ASP.NET Core build instrumented for coverage.',
        needs: ['fixtures', 'backend'],
        where: 'Reporter option coverage.server; Execution → Source; a file’s coverage page',
        doc: 'features/server-coverage',
      },
      {
        title: 'Combined coverage',
        summary:
          'The coverage reports of your unit tests (Vitest, coverlet, Microsoft code coverage), uploaded per commit and suite, next to the coverage the Playwright suite records.',
        needs: [],
        where: 'CLI (`piwi coverage upload`)',
        doc: 'features/combined-coverage',
      },
      {
        title: 'Coverage insights',
        summary:
          'From the coverage tests record: the code a failure ran that its last pass did not, a path that depends on which tests ran first, the code only some tests run before you quarantine them, and whether a new test reaches its target lines.',
        needs: ['fixtures', 'backend'],
        where: 'API and MCP tools; the AI diagnosis',
        doc: 'features/coverage-insights',
      },
      {
        title: 'Probes',
        summary:
          'Whether a passing test would notice a fault behind a request: client probes run through the capture fixtures; server probes inject the fault inside the server, needing a backend package.',
        needs: ['fixtures'],
        where: 'Project → Gaps; reporter (`piwi probe`)',
        doc: 'features/probes',
      },
    ],
  },
  {
    title: 'Trends and reports',
    intro:
      'The same numbers over weeks and months, and in front of people who never open the dashboard: dashboards, scheduled quality reports, markers for what you changed, and alerts.',
    features: [
      {
        title: 'Analytics',
        summary:
          'Cross-project trends (portfolio health, wasted CI time, pass-rate heatmap, browser matrix, insights feed) over any period against any other, from daily rollups that outlive retention.',
        needs: [],
        where: 'Analytics',
        doc: 'features/analytics',
      },
      {
        title: 'Dashboards',
        summary:
          'Your own arrangement of widgets with its own filters and period, private or shared, refreshed live and shown in TV mode on a wall screen; a shared dashboard shows nobody a project they cannot open.',
        needs: [],
        where: 'Analytics → dashboard switcher, Edit, Duplicate; Analytics → Manage dashboards',
        doc: 'features/dashboards',
      },
      {
        title: 'Quality reports',
        summary:
          'The analytics page as a document for stakeholders: a rule-based verdict, headline numbers, the trend, what is being done and the risks, as PDF, HTML, Markdown or Excel, sent on a schedule by email, Slack or webhook and kept as snapshots.',
        needs: [],
        where: 'Analytics → Export, Schedule…; Project → Export; Quality reports',
        doc: 'features/quality-reports',
      },
      {
        title: 'Timeline markers',
        summary: 'Your deploys and infra changes overlaid on the trend charts, so a step change has a cause.',
        needs: [],
        where: 'Project → Runs chart → Markers',
        doc: 'features/timeline-markers',
      },
      {
        title: 'Notifications & alerts',
        summary: 'Email, Slack, webhook and browser channels with per-project subscriptions, digests and mute.',
        needs: [],
        where: 'Settings → Notifications',
        doc: 'features/notifications',
      },
    ],
  },
  {
    title: 'Use it from elsewhere',
    intro: 'Reach your results and act on them from wherever you already work.',
    features: [
      {
        title: 'MCP server',
        summary:
          'A Model Context Protocol server that gives coding agents read access to your runs, failures and diagnoses.',
        needs: [],
        where: 'MCP server (`/mcp`)',
        doc: 'features/mcp',
      },
      {
        title: 'Agent skills',
        summary: 'Installable skills that teach a coding agent the Piwi failure-fixing workflow end to end.',
        needs: [],
        where: 'reporter CLI (`piwi skills`)',
        doc: 'features/agent-skills',
      },
      {
        title: 'Desktop app',
        summary: 'A local instance in a desktop shell — run tests, reproduce and bisect, with one-click MCP wiring.',
        needs: ['desktop'],
        where: 'Desktop app',
        doc: 'features/desktop',
      },
      {
        title: 'Browser extension',
        summary: 'Record actions, build and lint locators, and copy context for an agent, straight from the page.',
        needs: ['extension'],
        where: 'Browser extension',
        doc: 'features/extension',
      },
      {
        title: 'Extension connection',
        summary:
          'Connect Piwi Picker to your instance in one click, and keep the URL patterns that tell it which project a page belongs to on the instance, for the whole team.',
        needs: ['extension'],
        where: 'Browser extension → Settings; Project → Settings → Browser extension URLs',
        doc: 'features/extension-connection',
      },
      {
        title: 'Tested elements',
        summary:
          'On a live page, the elements your tests reach and through which tests, the buttons, links and fields none reaches, and the brittle locators to replace.',
        needs: ['extension'],
        where: 'Browser extension → Tested elements',
        doc: 'features/tested-elements',
      },
      {
        title: 'Report a bug',
        summary:
          'Record the steps to a bug, mark what the page should show, and get a failing Playwright test, a Markdown report and the evidence, from the browser.',
        needs: ['extension'],
        where: 'Browser extension → Report a bug',
        doc: 'features/report-a-bug',
      },
      {
        title: 'Replay a bug report',
        summary:
          'Play a bug report again in a tab, on your own dev server, and see whether the bug shows there; or run its steps with Playwright in the desktop app.',
        needs: ['extension'],
        where: 'Browser extension → Replay a bug report',
        doc: 'features/replay-a-bug-report',
      },
      {
        title: 'Bug reports',
        summary:
          'Reports sent from Piwi Picker kept with their steps and evidence, each rendered as a failing test for your project and followed through its runs until the fix holds.',
        needs: ['extension'],
        where: 'Project → More → Bug reports',
        doc: 'features/bug-reports',
      },
      {
        title: 'Developer tools',
        summary:
          "Beside the browser's DevTools: the ranked, verified locators of the element selected in the Elements panel.",
        needs: ['extension'],
        where: 'DevTools → Elements → Piwi',
        doc: 'features/devtools',
      },
      {
        title: 'Test functions catalog',
        summary: 'The reusable helpers and page-object methods your suite calls, catalogued with their parameters.',
        needs: [],
        where: 'Project → Test functions',
        doc: 'features/test-functions',
      },
      {
        title: 'Open in IDE',
        summary: 'Every source path in the dashboard jumps to that file and line in VS Code or JetBrains.',
        needs: [],
        where: 'any source path',
        doc: 'features/ide-integration',
      },
      {
        title: 'Editor extensions',
        summary:
          'In VS Code and the JetBrains IDEs: the latest CI failures at their lines with the heal as a quick fix, the tests behind each locator and file, and the locators an unsaved change breaks.',
        needs: [],
        where: 'VS Code extension, JetBrains plugin',
        doc: 'features/editors',
      },
      {
        title: 'Runs from the editor',
        summary:
          "Run tests from VS Code or a JetBrains IDE, follow the run in the status bar, and see its results laid over the latest CI run's failures within a second of its end.",
        needs: [],
        where: 'Piwi: Run the tests that reach this file, Piwi: Run selection…; the status bar',
        doc: 'features/editor-runs',
      },
      {
        title: 'Coverage in the editor',
        summary:
          'The lines your tests ran, marked in VS Code and the JetBrains IDEs, Rider included: the lines run and not run, the tests behind each function and line, and the lines changed since the coverage run.',
        needs: ['fixtures', 'backend'],
        where: 'Application files in the editor; Piwi: Toggle the coverage marks, Tools → Piwi → Show Coverage Marks',
        doc: 'features/editor-coverage',
      },
      {
        title: 'Breakpoints in the browser',
        summary:
          "Set a breakpoint in VS Code or a JetBrains IDE: the next run Piwi starts pauses there in a headed browser, with Piwi's bar to resume, step, or pick a locator that replaces the one on that line.",
        needs: ['fixtures'],
        where: "The editor's breakpoints; piwi.breakpoints, or Settings → Tools → Piwi in a JetBrains IDE",
        doc: 'features/editor-breakpoints',
      },
      {
        title: 'Record tests from the editor',
        summary:
          "A browser your project's own Playwright opens from VS Code or a JetBrains IDE, and each step you take there written at the cursor as you go, with verified locators and calls to your page objects.",
        needs: [],
        where: 'Piwi: Record here; Tools → Piwi → Record Here in a JetBrains IDE',
        doc: 'features/editor-recording',
      },
      {
        title: 'Editor connection',
        summary:
          'Connect the editor extensions to your instance: the connection the reporter uses, or a browser sign-in that creates a key for the editor, saved for that instance only.',
        needs: [],
        where: 'Piwi: Connect; Settings → Tools → Piwi in a JetBrains IDE',
        doc: 'features/editor-connection',
      },
    ],
  },
  {
    title: 'Self-hosting',
    intro: 'Operate a shared, self-hosted instance for a team.',
    features: [
      {
        title: 'Authentication & roles',
        summary:
          'Optional sign-in with Google/GitHub OAuth, the Administrator and Member instance roles, and five project roles granted to users or groups.',
        needs: ['admin'],
        where: 'Settings → Users',
        doc: 'operate/authentication',
      },
      {
        title: 'Access, roles and groups',
        summary:
          'Give each person the rights their job needs, project by project, through five project roles granted to users or groups; a Project admin manages the members of their own projects.',
        needs: ['admin'],
        where: 'Settings → Permissions, Settings → Groups; project Settings → Members',
        doc: 'operate/project-access',
      },
      {
        title: 'API keys',
        summary:
          'Long-lived tokens that let the reporter, CI and scripts sign in, shown once and revocable at any time.',
        needs: [],
        where: 'Settings → Account; Settings → Users',
        doc: 'operate/api-keys',
      },
      {
        title: 'Data retention & cleanup',
        summary: 'Cap how much run history you keep, with a nightly sweep and manual bulk cleanup.',
        needs: ['admin'],
        where: 'Settings → Storage',
        doc: 'operate/storage#data-retention',
      },
      {
        title: 'Backup & restore',
        summary: 'What to copy for a safe backup of the database and file storage, and how to restore it.',
        needs: ['admin'],
        where: 'operator (filesystem)',
        doc: 'operate/backup-restore',
      },
      {
        title: 'Metrics and rollup export',
        summary:
          'The metric catalog as OpenMetrics for Prometheus and Grafana, and the daily rollups as JSON or CSV for BI tools; both pulled by your tools, never pushed.',
        needs: ['admin'],
        where: '`/api/metrics`; rollup export',
        doc: 'operate/metrics',
      },
    ],
  },
];
