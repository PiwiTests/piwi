/**
 * The guide anchors of a failure cluster's page (`/failure-clusters/[id]`),
 * which a failed execution's page shows too.
 */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const CLUSTERS_ANCHORS = [
  {
    id: 'more-ways-to-fix',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The More ways to fix card: every other way to fix, verify or reproduce the failure, each section folded to one line.',
    doc: 'guide/first-failure#_6-more-ways-to-fix',
    sample: {
      route: '/failure-clusters/10',
      expect: { cluster: { id: 10, story: 'users-table-page-size' }, diagnosis: 'with-patch', fixLanded: true },
    },
  },
  {
    id: 'diagnosis-fix',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    reveal: [{ unfold: 'more-ways-to-fix' }],
    describes:
      'The patch the cluster’s AI diagnosis suggests, checked against the source, with whether it applies cleanly and how to apply it.',
    shownWhen: 'When the cluster has an AI diagnosis that suggests a fix.',
    requires: { capability: 'ai' },
    doc: 'features/ai-diagnosis',
    sample: {
      route: '/failure-clusters/10',
      expect: { cluster: { id: 10, story: 'users-table-page-size' }, diagnosis: 'with-patch', fixLanded: true },
    },
  },
  {
    id: 'issue-line',
    pages: ['/failure-clusters/[id]', '/test-run-cases/[id]'],
    describes:
      'The Issue line: the ticket the cluster is tracked in with its status, or Create issue and Link an issue when it has none.',
    shownWhen: 'When the cluster is tracked, or is open and the viewer can create or link an issue.',
    requires: { capability: 'integrations' },
    doc: 'features/issue-tracking',
    sample: {
      route: '/failure-clusters/3',
      expect: { cluster: { id: 3, story: 'auth-login-500' }, issue: { key: 'DEMO-42', status: 'In Progress' } },
    },
  },
];
