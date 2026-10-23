/** The guide anchors of the demo banner's controls, on every page of the demo. */

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const DEMO_ANCHORS = [
  {
    id: 'demo-personas',
    kind: 'action',
    pages: ['*'],
    describes:
      'The demo banner’s Acting as menu, which reloads the demo as one of its seeded people to show what each role sees.',
    requires: { demo: true },
    doc: 'operate/project-access',
    sample: { route: '/' },
  },
  {
    id: 'demo-simulator',
    kind: 'action',
    pages: ['*'],
    describes:
      'The demo banner’s Simulate a test run control, which streams a new run into the demo the way the reporter does from CI.',
    requires: { demo: true },
    doc: 'features/ui-overview#live-demo',
    sample: { route: '/' },
  },
];

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const DEMO_EXEMPTIONS = [];
