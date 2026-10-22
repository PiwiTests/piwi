/** The guide anchors of a test's page (`/test-cases/[id]`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const TEST_CASES_ANCHORS = [
  {
    id: 'flake-suspects',
    pages: ['/test-cases/[id]'],
    reveal: [{ query: { tab: 'flakiness' } }],
    describes:
      'The Suspects card of the Flakiness tab: what sets a flaky test’s failing executions apart from its passing ones, most telling first.',
    shownWhen: 'When the test flaked in its recent runs.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flaky-tests#suspects',
    sample: {
      route: '/test-cases/9?tab=flakiness',
      expect: { testCase: { id: 9, title: 'should apply discount code' }, lab: 'reproduced' },
    },
  },
];
