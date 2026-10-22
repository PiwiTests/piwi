/**
 * The guide anchor registry: every element a guide can point at, each named by
 * the static `data-tour` attribute it carries in exactly one component. A
 * guide's stop names an anchor by id, and nothing else can be pointed at.
 *
 * One file per area of the dashboard, joined below in the sidebar's order: an
 * area file is one import and one spread in `GUIDE_ANCHORS`. Plain ESM so the
 * app, the tests and plain Node scripts read the same file; the entry shape is
 * in `index.d.mts`.
 *
 * Three checks hold every entry: `tests/unit/guide-anchors.test.ts` against the
 * source (the `data-tour` attribute, the pages, the reveal, the sample route),
 * `tests/unit/demo-seed-consistency.test.ts` the sample's `expect` against the
 * generated seed, and `scripts/check-demo-runtime.mjs` the sample in the built
 * demo: opened as its persona, revealed, then found visible.
 */
import { HOME_ANCHORS } from './home.mjs';
import { ANALYTICS_ANCHORS } from './analytics.mjs';
import { PROJECTS_ANCHORS } from './projects.mjs';
import { RUNS_ANCHORS } from './runs.mjs';
import { EXECUTIONS_ANCHORS } from './executions.mjs';
import { CLUSTERS_ANCHORS } from './clusters.mjs';
import { TEST_CASES_ANCHORS } from './test-cases.mjs';
import { SETUP_ANCHORS } from './setup.mjs';
import { SETTINGS_ANCHORS } from './settings.mjs';
import { DEMO_ANCHORS } from './demo.mjs';

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const GUIDE_ANCHORS = [
  ...HOME_ANCHORS,
  ...ANALYTICS_ANCHORS,
  ...PROJECTS_ANCHORS,
  ...RUNS_ANCHORS,
  ...EXECUTIONS_ANCHORS,
  ...CLUSTERS_ANCHORS,
  ...TEST_CASES_ANCHORS,
  ...SETUP_ANCHORS,
  ...SETTINGS_ANCHORS,
  ...DEMO_ANCHORS,
];

/** @type {ReadonlyMap<string, import('./index.d.mts').GuideAnchor>} */
export const GUIDE_ANCHOR_BY_ID = new Map(GUIDE_ANCHORS.map((anchor) => [anchor.id, anchor]));

/**
 * @param {string} id
 * @returns {import('./index.d.mts').GuideAnchor | undefined}
 */
export function findGuideAnchor(id) {
  return GUIDE_ANCHOR_BY_ID.get(id);
}
