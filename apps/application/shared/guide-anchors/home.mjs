/** The guide anchors of Home (`/`). */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const HOME_ANCHORS = [
  {
    id: 'failure-inbox-row',
    pages: ['/'],
    describes:
      'A row of the Failure inbox: one open failure cluster across the projects, however many tests it breaks, triaged from the keyboard.',
    shownWhen: 'When at least one failure cluster is open.',
    doc: 'features/failure-clusters#the-failure-inbox',
    sample: { route: '/' },
  },
  {
    id: 'project-health',
    pages: ['/'],
    describes:
      'The Project health table: each project’s last 20 runs, its tendency and the pass rate of its latest run, failing projects first.',
    shownWhen: 'When the instance has at least one project.',
    doc: 'features/ui-overview#home',
    sample: { route: '/' },
  },
];
