/** The guide anchors of Analytics: the dashboards and the quality reports. */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const ANALYTICS_ANCHORS = [
  {
    id: 'analytics-headline',
    pages: ['/analytics', '/analytics/d/[id]'],
    describes:
      'The Headline numbers of a dashboard: pass rates, flaky tests, wasted CI minutes, open failure causes and time to fix, against the period before.',
    shownWhen: 'On a saved dashboard, when it holds the Headline numbers widget.',
    doc: 'features/analytics',
    sample: { route: '/analytics' },
  },
  {
    id: 'team-dashboards',
    pages: ['/analytics/dashboards'],
    describes:
      'The saved dashboards of the Dashboards page: the widgets and scope a person or a team keeps beside the built-in dashboards.',
    shownWhen: 'When at least one dashboard is saved.',
    doc: 'features/dashboards',
    sample: { route: '/analytics/dashboards' },
  },
  {
    id: 'report-schedules',
    pages: ['/reports'],
    describes:
      'The Report schedules card: each schedule that builds a quality report every day, week or month and sends it to its channels.',
    requires: { capability: 'quality-reports', permission: 'report:write' },
    doc: 'features/quality-reports#report-schedules',
    sample: { route: '/reports' },
  },
];
