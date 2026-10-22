/** The guide anchors of a project's pages (`/projects/[id]` and its sub-pages). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const PROJECTS_ANCHORS = [
  {
    id: 'flaky-test-row',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flaky-tests' } }],
    describes:
      'A row of the project’s flaky tests, ranked by the CI time their retries waste, with its 0–100 flaky score and its top suspect.',
    shownWhen: 'When a test of the project flaked in its recent runs.',
    doc: 'features/flaky-tests',
    sample: { route: '/projects/1?tab=flaky-tests', expect: { project: { id: 1, name: 'e2e-checkout' } } },
  },
  {
    id: 'slowest-tests',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'performance' } }],
    describes:
      'The heading of Slowest tests on the Performance tab: the project’s 20 slowest tests by average duration over recent runs.',
    doc: 'features/slow-tests',
    sample: { route: '/projects/1?tab=performance', expect: { project: { id: 1, name: 'e2e-checkout' } } },
  },
  {
    id: 'flake-lab-tests',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'flake-lab' } }],
    describes:
      'The Flake Lab tab’s list of the project’s flaky tests, each with the state its experiments reached, such as Reproduced or Verified fixed.',
    shownWhen: 'When a test of the project flaked in its recent runs or has an experiment.',
    requires: { capability: 'flake-lab' },
    doc: 'features/flake-lab',
    sample: { route: '/projects/3?tab=flake-lab', expect: { project: { id: 3, name: 'ui-components' } } },
  },
  {
    id: 'feature-map',
    pages: ['/projects/[id]'],
    reveal: [{ query: { tab: 'gaps' } }],
    describes:
      'The feature map of the Gaps tab: the features the Test Map draws from the routes and pages each feature’s tests reach.',
    shownWhen: 'When tests of the project are tagged with piwi:feature.',
    requires: { capability: 'test-map' },
    doc: 'features/scenario-gaps',
    sample: { route: '/projects/1?tab=gaps', expect: { project: { id: 1, name: 'e2e-checkout' } } },
  },
  {
    id: 'coverage-overview',
    pages: ['/projects/[id]/coverage'],
    describes:
      'The Combined coverage card: the share of lines the unit suites and the Playwright run of one commit ran together, then each suite’s share.',
    shownWhen: 'When a suite uploaded a coverage report or a run recorded run coverage for the project.',
    requires: { capability: 'coverage' },
    doc: 'features/combined-coverage',
    sample: {
      route: '/projects/5/coverage',
      expect: { project: { id: 5, name: 'web-dashboard' }, combinedCoverage: { suites: 3, filesWithoutData: 2 } },
    },
  },
];
