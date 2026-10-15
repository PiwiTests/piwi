/**
 * What the screenshot scenes and the E2E spec of the coverage insights open:
 * the demo seed's order-dependent flake (`ORDER_FLAKE` in the story fixtures),
 * Web Dashboard's `toggles dark mode`, whose first attempt fails when
 * `updates the organization name` has not finished. The execution is its
 * failed attempt in run 68, compared with the test's last passing run. A dev
 * server seeded with the demo data cannot read the demo's repositories, so the
 * scenes serve the source of the files the flake's coverage names through
 * route interception; `tests/unit/demo-coverage-insights.test.ts` checks these
 * ids against the generated seed.
 */
import { ORDER_FLAKE, sourceText } from '../../shared/demo/failure-stories.mjs';

/** The project, the flaky test, the earlier test it depends on, and the failed attempt the scenes open. */
export const ORDER_SCENE = {
  projectId: ORDER_FLAKE.projectId,
  testCaseId: 53,
  earlierTestCaseId: 51,
  executionId: 830,
  /** The file whose lines the failed attempts ran apart. */
  path: ORDER_FLAKE.conflictPath,
};

/**
 * `GET /api/projects/5/source?path=&blob=` in the demo, for the files the
 * flake's coverage names: the file's content when the blob is the one its
 * coverage names, else null.
 */
export function orderSceneSource(path, blob) {
  const file = Object.values(ORDER_FLAKE.coverage)
    .flat()
    .find((f) => f.path === path && f.blob === blob);
  return file ? { path, blob, content: sourceText(path) } : null;
}
