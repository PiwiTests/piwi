/**
 * The guide anchor registry: every element a guide can point at, each named by
 * the static `data-tour` attribute it carries in exactly one component. A
 * guide's stop names an anchor by id, and nothing else can be pointed at.
 *
 * One file per area of the dashboard, joined below in the sidebar's order:
 * each area file exports its anchors and its coverage exemptions, and an area
 * is one import and one entry in `GUIDE_AREAS`. Plain ESM so the app, the
 * tests and plain Node scripts read the same file; the entry shape is in
 * `index.d.mts`.
 *
 * Four checks hold every entry: `tests/unit/guide-anchors.test.ts` against the
 * source (the `data-tour` attribute, the pages, the reveal, the sample route),
 * `tests/unit/guide-anchor-coverage.test.ts` that every page, tab, settings
 * field, help-hinted block and sidebar destination has an anchor or an
 * exemption, `tests/unit/demo-seed-consistency.test.ts` the sample's `expect`
 * against the generated seed, and `scripts/check-demo-runtime.mjs` the sample
 * in the built demo: opened as its persona, revealed, then found visible.
 */
import { LAYOUT_ANCHORS, LAYOUT_EXEMPTIONS } from './layout.mjs';
import { HOME_ANCHORS, HOME_EXEMPTIONS } from './home.mjs';
import { ANALYTICS_ANCHORS, ANALYTICS_EXEMPTIONS } from './analytics.mjs';
import { PROJECTS_ANCHORS, PROJECTS_EXEMPTIONS } from './projects.mjs';
import { RUNS_ANCHORS, RUNS_EXEMPTIONS } from './runs.mjs';
import { EXECUTIONS_ANCHORS, EXECUTIONS_EXEMPTIONS } from './executions.mjs';
import { CLUSTERS_ANCHORS, CLUSTERS_EXEMPTIONS } from './clusters.mjs';
import { TEST_CASES_ANCHORS, TEST_CASES_EXEMPTIONS } from './test-cases.mjs';
import { SETUP_ANCHORS, SETUP_EXEMPTIONS } from './setup.mjs';
import { SETTINGS_ANCHORS, SETTINGS_EXEMPTIONS } from './settings.mjs';
import { DEMO_ANCHORS, DEMO_EXEMPTIONS } from './demo.mjs';

/** @type {readonly import('./index.d.mts').GuideAnchorKind[]} */
export const GUIDE_ANCHOR_KINDS = ['page', 'tab', 'block', 'row', 'field', 'action', 'nav'];

/** @type {readonly import('./index.d.mts').GuideArea[]} */
export const GUIDE_AREAS = [
  { id: 'layout', anchors: LAYOUT_ANCHORS, exemptions: LAYOUT_EXEMPTIONS },
  { id: 'home', anchors: HOME_ANCHORS, exemptions: HOME_EXEMPTIONS },
  { id: 'analytics', anchors: ANALYTICS_ANCHORS, exemptions: ANALYTICS_EXEMPTIONS },
  { id: 'projects', anchors: PROJECTS_ANCHORS, exemptions: PROJECTS_EXEMPTIONS },
  { id: 'runs', anchors: RUNS_ANCHORS, exemptions: RUNS_EXEMPTIONS },
  { id: 'executions', anchors: EXECUTIONS_ANCHORS, exemptions: EXECUTIONS_EXEMPTIONS },
  { id: 'clusters', anchors: CLUSTERS_ANCHORS, exemptions: CLUSTERS_EXEMPTIONS },
  { id: 'test-cases', anchors: TEST_CASES_ANCHORS, exemptions: TEST_CASES_EXEMPTIONS },
  { id: 'setup', anchors: SETUP_ANCHORS, exemptions: SETUP_EXEMPTIONS },
  { id: 'settings', anchors: SETTINGS_ANCHORS, exemptions: SETTINGS_EXEMPTIONS },
  { id: 'demo', anchors: DEMO_ANCHORS, exemptions: DEMO_EXEMPTIONS },
];

/** @type {readonly import('./index.d.mts').GuideAnchor[]} */
export const GUIDE_ANCHORS = GUIDE_AREAS.flatMap((area) => area.anchors);

/** @type {readonly import('./index.d.mts').GuideAnchorExemption[]} */
export const GUIDE_ANCHOR_EXEMPTIONS = GUIDE_AREAS.flatMap((area) => area.exemptions);

/** @type {ReadonlyMap<string, import('./index.d.mts').GuideAnchor>} */
export const GUIDE_ANCHOR_BY_ID = new Map(GUIDE_ANCHORS.map((anchor) => [anchor.id, anchor]));

/**
 * @param {string} id
 * @returns {import('./index.d.mts').GuideAnchor | undefined}
 */
export function findGuideAnchor(id) {
  return GUIDE_ANCHOR_BY_ID.get(id);
}
