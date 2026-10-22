/**
 * The guide anchors of a test execution's page (`/test-run-cases/[id]`), most
 * of which the failure cluster's page shows too, for the execution it selects.
 */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const EXECUTIONS_ANCHORS = [
  {
    id: 'situation',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]', '/bug-reports/[id]'],
    describes:
      'The situation block that opens a failure: the headline of what broke, Most likely for the cause, Next for the step to take, and the cluster.',
    doc: 'guide/first-failure',
    sample: {
      route: '/test-run-cases/37',
      expect: { execution: { id: 37, title: 'should complete checkout with credit card' } },
    },
  },
  {
    id: 'evidence',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The Evidence card’s heading and tabs: everything the run captured for the execution, one view per tab, from the timeline to the source.',
    shownWhen: 'When the test ran.',
    doc: 'features/evidence',
    sample: {
      route: '/test-run-cases/37',
      expect: { execution: { id: 37, title: 'should complete checkout with credit card' } },
    },
  },
  {
    id: 'execution-coverage',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    reveal: [{ query: { evidence: 'source' } }],
    describes:
      'The Coverage section of the Source tab: the server and browser files the test ran, the suspect lines first, each opening on the lines it ran.',
    shownWhen: 'When the project records coverage.',
    requires: { capability: 'coverage' },
    doc: 'features/code-reach#on-the-execution-page',
    sample: {
      route: '/test-run-cases/711?evidence=source',
      expect: {
        execution: { id: 711, title: 'Users table paginates 25 rows per page' },
        coverage: { serverFiles: 5, browserFiles: 3, runCoverage: true },
      },
    },
  },
  {
    id: 'locator-fix',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    describes:
      'The failing locator and the replacements locator healing ranks from the last run where the test passed, the recommended one first.',
    shownWhen: 'When a locator broke and healing has a replacement, in More ways to fix, open when Next points at it.',
    requires: { capability: 'locator-healing' },
    doc: 'features/locator-healing',
    sample: {
      route: '/test-run-cases/533',
      expect: { execution: { id: 533, title: 'Button primary variant renders correctly' } },
    },
  },
];
