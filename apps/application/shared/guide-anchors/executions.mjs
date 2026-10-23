/**
 * The guide anchors of a test execution's page (`/test-run-cases/[id]`), most
 * of which the failure cluster's page shows too, for the execution it selects.
 */

/** What the seed holds at the executions the samples open. */
const CHECKOUT_FAILURE = { execution: { id: 37, title: 'should complete checkout with credit card' } };
const USERS_TABLE_FAILURE = { execution: { id: 711, title: 'Users table paginates 25 rows per page' } };

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const EXECUTIONS_ANCHORS = [
  {
    id: 'situation',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]', '/bug-reports/[id]'],
    describes:
      'The situation block that opens a failure: the headline of what broke, Most likely for the cause, Next for the step to take, and the cluster.',
    help: 'case.situation',
    doc: 'guide/first-failure',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The Evidence card’s heading and tabs: everything the run captured for the execution, one view per tab, from the timeline to the source.',
    shownWhen: 'When the test ran.',
    help: 'case.evidence',
    doc: 'features/evidence',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'execution-coverage',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'source' } }],
    describes:
      'The Coverage section of the Source tab: the server and browser files the test ran, the suspect lines first, each opening on the lines it ran.',
    shownWhen: 'When the project records coverage.',
    requires: { capability: 'coverage' },
    help: 'case.coverage',
    doc: 'features/code-reach#on-the-execution-page',
    sample: {
      route: '/test-run-cases/711?evidence=source',
      expect: { ...USERS_TABLE_FAILURE, coverage: { serverFiles: 5, browserFiles: 3, runCoverage: true } },
    },
  },
  {
    id: 'locator-fix',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ unfold: 'fix-section-locator-fix' }],
    describes:
      'The failing locator and the replacements locator healing ranks from the last run where the test passed, the recommended one first.',
    shownWhen: 'When a locator broke and healing has a replacement.',
    requires: { capability: 'locator-healing' },
    help: 'locator-healing',
    doc: 'features/locator-healing',
    sample: {
      route: '/test-run-cases/533',
      expect: { execution: { id: 533, title: 'Button primary variant renders correctly' } },
    },
  },
  {
    id: 'execution-heading',
    kind: 'page',
    pages: ['/test-run-cases/[id]'],
    describes:
      'The heading line of an execution’s page: the outcome of one test in one run, its title path from the spec file down, its marks and quarantine.',
    doc: 'features/evidence#one-execution-diagnosis-first',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'next-step-action',
    kind: 'action',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The Next line’s primary button: the one step the page recommends for the failure, such as copying the diagnosed patch’s apply command.',
    shownWhen: 'When the failure has a next step.',
    doc: 'features/fix-plans#the-next-step',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'open-trace',
    kind: 'action',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The Evidence card’s Open trace button, which opens the execution’s Playwright trace in the trace viewer.',
    shownWhen: 'When the run kept a trace of the execution.',
    doc: 'features/evidence#trace-viewer',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'execution-test-history',
    kind: 'action',
    pages: ['/test-run-cases/[id]'],
    describes:
      'The Test history link, which opens the test’s own page: its results, durations and flakiness across runs.',
    doc: 'features/evidence#the-test-case-page',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'execution-more-actions',
    kind: 'action',
    pages: ['/test-run-cases/[id]'],
    describes:
      'The More actions menu of an execution: the cluster’s issue, quarantining the test, Copy failure and the command that runs it again.',
    doc: 'guide/first-failure',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'quarantine-test',
    kind: 'action',
    pages: ['/test-run-cases/[id]'],
    reveal: [{ open: 'execution-more-actions' }],
    describes:
      'The More actions menu’s Quarantine this test: the test keeps running and reporting, but no longer counts in the CI gate’s verdict.',
    shownWhen: 'When the viewer can quarantine the project’s tests and the test is not quarantined.',
    requires: { capability: 'quarantine', permission: 'quarantine:write' },
    doc: 'features/flaky-tests#quarantine-with-a-way-out',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'copy-retry-command',
    kind: 'action',
    pages: ['/test-run-cases/[id]'],
    reveal: [{ open: 'execution-more-actions' }],
    describes:
      'The More actions menu’s Copy retry command: the Playwright command that runs this one test again, on the browser project it ran on.',
    shownWhen: 'Outside the desktop app, which runs the test itself.',
    doc: 'features/fix-plans#the-next-step',
    sample: { route: '/test-run-cases/37', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-timeline',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'timeline' } }],
    describes:
      'The Timeline tab: the test’s steps, requests, console entries and backend logs on one time axis, the failure marked, over a table of each.',
    help: 'case.timeline',
    doc: 'features/evidence#one-execution-diagnosis-first',
    sample: { route: '/test-run-cases/37?evidence=timeline', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-attempts',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'attempts' } }],
    describes:
      'The Attempts tab: every attempt of a test that ran more than once, then what differed between the failing attempt and the passing one.',
    shownWhen: 'When the test ran more than once in the run.',
    help: 'case.attempts',
    doc: 'features/evidence#attempts',
    sample: {
      route: '/test-run-cases/768?evidence=attempts',
      expect: { execution: { id: 768, title: 'toggles dark mode' } },
    },
  },
  {
    id: 'evidence-screen',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'screen' } }],
    describes:
      'The Screen tab: the page at the failure as views, its screenshot, DOM and accessibility tree, then the visual diff, the page diff and the video.',
    doc: 'features/evidence#one-execution-diagnosis-first',
    sample: { route: '/test-run-cases/37?evidence=screen', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-source',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'source' } }],
    describes:
      'The Source tab: the test source as a call stack, the line that threw and its callers, then what the test ran where the project records coverage.',
    help: 'case.test-source',
    doc: 'features/evidence#trace-powered-deep-views',
    sample: { route: '/test-run-cases/37?evidence=source', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-locators',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'locators' } }],
    describes:
      'The Locators tab: every locator the test used, in order, with how many tests of the project use the same chain.',
    shownWhen: 'When the test’s steps used a locator.',
    doc: 'features/locator-usage#the-locators-tab',
    sample: { route: '/test-run-cases/37?evidence=locators', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-network',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'network' } }],
    describes:
      'The Network tab: the requests the page made during the test with their status, timing and backend logs, the failed and slow ones marked.',
    shownWhen: 'When the capture fixtures or a trace recorded the test’s requests.',
    help: 'case.network',
    doc: 'features/evidence#trace-powered-deep-views',
    sample: { route: '/test-run-cases/37?evidence=network', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-console',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'console' } }],
    describes:
      'The Console tab: the browser console output logged while the test ran, often the first clue to a JavaScript error behind a failure.',
    shownWhen: 'When the capture fixtures or a trace recorded the console.',
    help: 'case.console',
    doc: 'guide/capture-fixtures',
    sample: { route: '/test-run-cases/37?evidence=console', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-state',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'state' } }],
    describes:
      'The State tab: the app state when the test ended, its URL, storage key names and cookies, then the environment diff against the last pass.',
    shownWhen: 'When the capture fixtures ran for the test.',
    help: 'page-state',
    doc: 'guide/capture-fixtures',
    sample: { route: '/test-run-cases/37?evidence=state', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'evidence-performance',
    kind: 'tab',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'performance' } }],
    describes:
      'The Performance tab: performance hints, what the test cost in CPU and memory, and the Web Vitals of the page under test.',
    shownWhen: 'When the capture fixtures ran for the test.',
    help: 'case.web-vitals',
    doc: 'guide/capture-fixtures',
    sample: { route: '/test-run-cases/37?evidence=performance', expect: CHECKOUT_FAILURE },
  },
  {
    id: 'execution-coverage-none',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'source' } }],
    describes:
      'The Coverage section’s note that the execution recorded no coverage, in a project that records it, with why a test can record none.',
    shownWhen: 'When the project records coverage and the test recorded none.',
    requires: { capability: 'coverage' },
    help: 'case.coverage-none',
    doc: 'features/code-reach',
    sample: {
      route: '/test-run-cases/709?evidence=source',
      expect: { execution: { id: 709, title: 'signs in with SSO redirect' } },
    },
  },
  {
    id: 'coverage-divergence',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'source' } }],
    describes:
      'What a failing execution ran that the test’s last passing execution with coverage did not, and the reverse, file by file.',
    shownWhen: 'When the execution failed and an earlier pass of its test recorded coverage that differs.',
    requires: { capability: 'coverage' },
    help: 'case.coverage-divergence',
    doc: 'features/coverage-insights#a-failure-s-path-against-its-last-pass',
    sample: {
      route: '/test-run-cases/830?evidence=source',
      expect: {
        execution: { id: 830, title: 'toggles dark mode' },
        coverage: { serverFiles: 5, browserFiles: 0 },
        insight: 'divergence',
      },
    },
  },
  {
    id: 'execution-resources',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'performance' } }],
    describes:
      'The What the test cost card: the CPU the test used in its worker and browsers, its largest browser process, event loop load and pages left open.',
    shownWhen: 'When the reporter measured the test’s resources.',
    requires: { capability: 'resources' },
    help: 'case.resources',
    doc: 'features/cpu-memory-disk#in-the-dashboard',
    sample: { route: '/test-run-cases/711?evidence=performance', expect: USERS_TABLE_FAILURE },
  },
  {
    id: 'environment-diff',
    kind: 'block',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'state' } }],
    describes:
      'The Environment diff card: what differs from the same test’s last passing run in the Playwright version, browser, locale, viewport or CI.',
    shownWhen: 'When the test has an earlier passing run to compare with.',
    help: 'environment-diff',
    doc: 'features/evidence#one-execution-diagnosis-first',
    sample: { route: '/test-run-cases/37?evidence=state', expect: CHECKOUT_FAILURE },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const EXECUTIONS_EXEMPTIONS = [
  {
    rule: 'help',
    key: 'visual-diff',
    reason:
      'The Visual diff is a view of the Screen tab chosen in the component’s state, with no URL or opener to reveal it; the evidence-screen anchor names it.',
  },
  {
    rule: 'help',
    key: 'case.page-diff',
    reason:
      'The Page diff is a view of the Screen tab chosen in the component’s state, with no URL or opener to reveal it; the evidence-screen anchor names it.',
  },
  {
    rule: 'help',
    key: 'case.coverage-incomplete',
    reason: 'No seeded execution has an incomplete coverage capture, so the note never shows in the demo.',
  },
  {
    rule: 'help',
    key: 'case.coverage-backend-none',
    reason:
      'The note shows only for a test with browser coverage alone in a run with backend coverage, which the seed has none of.',
  },
];
