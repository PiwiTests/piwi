/** The guide anchors of a test's page (`/test-cases/[id]`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const TEST_CASES_ANCHORS = [
  {
    id: 'test-case-header',
    kind: 'page',
    pages: ['/test-cases/[id]'],
    describes:
      'The test’s header: its title, file and project, how many times it ran, its pass rate, failures, average duration, flaky runs and last run.',
    doc: 'features/evidence#the-test-case-page',
    sample: { route: '/test-cases/9', expect: { testCase: { id: 9, title: 'should apply discount code' } } },
  },
  {
    id: 'test-reproduce-locally',
    kind: 'action',
    pages: ['/test-cases/[id]'],
    describes:
      'The desktop app’s Reproduce locally button: runs the test 20 times with a trace in the project’s linked folder, to catch a failure that comes and goes.',
    requires: { desktop: true },
    doc: 'features/desktop#running-tests-from-the-app',
    sample: {
      route: '/test-cases/9',
      expect: { testCase: { id: 9, title: 'should apply discount code' } },
      surface: 'desktop',
    },
  },
  {
    id: 'test-merge',
    kind: 'action',
    pages: ['/test-cases/[id]'],
    describes:
      'The Merge button: moves the history of another test of the project into this one, to join a test renamed or moved that Piwi did not match.',
    requires: { permission: 'project:manage' },
    doc: 'reference/test-metadata#external-test-ids',
    sample: { route: '/test-cases/9', expect: { testCase: { id: 9, title: 'should apply discount code' } } },
  },
  {
    id: 'test-latest-execution',
    kind: 'action',
    pages: ['/test-cases/[id]'],
    describes: 'The Latest execution button, which opens the test’s most recent execution with its evidence.',
    doc: 'features/evidence#the-test-case-page',
    sample: { route: '/test-cases/9', expect: { testCase: { id: 9, title: 'should apply discount code' } } },
  },
  {
    id: 'test-overview',
    kind: 'tab',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'overview' } }],
    describes:
      'The Overview tab: the duration trend, the recent executions, how the test’s code path varies, its locators, failure clusters and links.',
    doc: 'features/evidence#the-test-case-page',
    sample: {
      route: '/test-cases/9?tab=overview',
      expect: { testCase: { id: 9, title: 'should apply discount code' } },
    },
  },
  {
    id: 'test-duration-trend',
    kind: 'block',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'overview' } }],
    describes:
      'The Duration trend card: the test’s duration across its recent runs, with the project’s markers, and the status of each run beneath it.',
    shownWhen: 'When the test has run.',
    help: 'case.history-chart',
    doc: 'features/evidence#the-test-case-page',
    sample: {
      route: '/test-cases/9?tab=overview',
      expect: { testCase: { id: 9, title: 'should apply discount code' } },
    },
  },
  {
    id: 'test-path-variation',
    kind: 'block',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'overview' } }],
    describes:
      'The Path variation card: the code some of the test’s executions ran and others did not, and the earlier test whose order predicts it.',
    shownWhen: 'When the project records coverage and the test has enough executions with it.',
    requires: { capability: 'coverage' },
    help: 'case.path-variation',
    doc: 'features/coverage-insights#a-path-that-depends-on-the-tests-before-it',
    sample: {
      route: '/test-cases/53?tab=overview',
      expect: { testCase: { id: 53, title: 'toggles dark mode' }, insight: 'path-variation' },
    },
  },
  {
    id: 'test-links',
    kind: 'block',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'overview' } }],
    describes: 'The Links card: the issues and other pages linked to the test, each with its provider and status.',
    shownWhen: 'When a link is pinned to the test.',
    help: 'shared.entity-links',
    doc: 'features/evidence#the-test-case-page',
    sample: {
      route: '/test-cases/1?tab=overview',
      expect: { testCase: { id: 1, title: 'should complete checkout with credit card' } },
    },
  },
  {
    id: 'test-trend',
    kind: 'tab',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'trend' } }],
    describes:
      'The Trend tab: the test’s pass rate, flaky rate and average duration per day, week or month, with the project’s markers.',
    help: 'case.stability-trend',
    doc: 'features/flaky-tests#per-test-stability-trend',
    sample: { route: '/test-cases/9?tab=trend', expect: { testCase: { id: 9, title: 'should apply discount code' } } },
  },
  {
    id: 'test-flakiness',
    kind: 'tab',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'flakiness' } }],
    describes:
      'The Flakiness tab: what sets the flaky test’s failures apart from its passes, then the Flake Lab experiments run on it and the command to run one.',
    shownWhen: 'When the test flaked in its recent runs.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flake-lab#where-results-show',
    sample: {
      route: '/test-cases/9?tab=flakiness',
      expect: { testCase: { id: 9, title: 'should apply discount code' } },
    },
  },
  {
    id: 'flake-suspects',
    kind: 'block',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'flakiness' } }],
    describes:
      'The Suspects card of the Flakiness tab: what sets a flaky test’s failing executions apart from its passing ones, most telling first.',
    shownWhen: 'When the test flaked in its recent runs.',
    requires: { capability: 'flake-lab' },
    help: 'case.flakiness',
    doc: 'features/flaky-tests#suspects',
    sample: {
      route: '/test-cases/9?tab=flakiness',
      expect: { testCase: { id: 9, title: 'should apply discount code' }, lab: 'reproduced' },
    },
  },
  {
    id: 'flake-lab-reproduce',
    kind: 'action',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'flakiness' } }],
    describes:
      'The desktop app’s Reproduce this flake button: runs the Flake Lab at the commit of the latest failure, in a throwaway worktree of the linked folder.',
    shownWhen: 'In the desktop app, once the project’s folder is linked.',
    requires: { capability: 'flake-lab', desktop: true },
    doc: 'features/desktop#reproducing-a-flake',
    sample: {
      route: '/test-cases/9?tab=flakiness',
      expect: { testCase: { id: 9, title: 'should apply discount code' } },
      surface: 'desktop',
    },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const TEST_CASES_EXEMPTIONS = [];
