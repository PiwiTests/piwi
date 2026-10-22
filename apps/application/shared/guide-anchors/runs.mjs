/** The guide anchors of a test run's page (`/test-runs/[id]`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const RUNS_ANCHORS = [
  {
    id: 'run-timeline',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'workers' } }],
    describes:
      'The Workers tab’s timeline: each worker’s tests in time, under the CPU, memory and open pages of the machine that ran them.',
    shownWhen: 'When the run’s tests reported when they started and on which worker.',
    doc: 'features/cpu-memory-disk',
    sample: { route: '/test-runs/63?tab=workers', expect: { run: { id: 63, project: 'web-dashboard' } } },
  },
  {
    id: 'run-leaks',
    pages: ['/test-runs/[id]'],
    reveal: [{ query: { tab: 'resources' } }],
    describes:
      'The Findings of the Resources tab: what the run’s tests left open past their scope, such as a browser context, with the line that opened it.',
    shownWhen: 'When the run’s resource report names a leak.',
    requires: { capability: 'resources' },
    doc: 'features/resource-leaks',
    sample: {
      route: '/test-runs/62?tab=resources',
      expect: { run: { id: 62, project: 'web-dashboard' }, resources: 'leaky' },
    },
  },
  {
    id: 'run-incident',
    pages: ['/test-runs/[id]'],
    describes:
      'The line saying the run is an environment incident, why Piwi flagged it, and that verdicts comparing runs leave it out.',
    shownWhen: 'When the run is flagged as an environment incident.',
    doc: 'features/environment-incidents',
    sample: { route: '/test-runs/14', expect: { run: { id: 14, project: 'e2e-checkout' }, incident: true } },
  },
];
