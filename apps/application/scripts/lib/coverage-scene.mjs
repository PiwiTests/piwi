/**
 * What the demo answers for the Coverage section of execution 711 (the users
 * story's failing test, whose run carries server coverage of the web
 * dashboard's ASP.NET Core API): its suspect lines, which mark the files they
 * name, and the source of each covered server file at its blob. A dev server
 * seeded with the demo data cannot read the demo's repositories, so the
 * screenshot scenes and the E2E spec of the section serve these through route
 * interception; `tests/unit/demo-suspect-lines.test.ts` checks that the demo's
 * own handlers answer exactly these, so the scenes show what the live demo
 * shows.
 */
import { FAILURE_STORIES, SCM_REPOS, sourceText } from '../../shared/demo/failure-stories.mjs';

const story = FAILURE_STORIES.find((s) => s.key === 'users-table-page-size');
const commits = SCM_REPOS[story.projectId].commits;
const newer = commits.slice(0, -1);

/** The execution the scenes open: the users story's failing test in its covered run. */
export const COVERAGE_SCENE_EXECUTION = 711;

/** The project the execution belongs to. */
export const COVERAGE_SCENE_PROJECT = story.projectId;

/** `GET /api/test-run-cases/711/suspect-lines` in the demo. */
export const COVERAGE_SCENE_SUSPECT_LINES = {
  available: true,
  range: { from: commits[commits.length - 1].sha, to: commits[0].sha },
  summary: {
    changedFiles: 2,
    changedLines: 13,
    hunks: 4,
    executedHunks: 1,
    executedLines: 3,
    failingWithCoverage: 1,
    passingWithCoverage: 4,
  },
  unreadFiles: 2,
  suspects: [
    {
      path: 'api/Users/UsersEndpoints.cs',
      runtime: 'server',
      hunk: [40, 42],
      lines: [[40, 42]],
      granularity: 'lines',
      failing: 1,
      passing: 2,
      score: 0.577,
    },
  ],
  changedPaths: [
    ...new Set(
      newer
        .flatMap((c) => c.files)
        .filter((f) => f.status !== 'removed' && f.status !== 'deleted')
        .map((f) => f.filename),
    ),
  ],
};

/**
 * `GET /api/projects/5/source?path=&blob=` in the demo: the covered server
 * file's content when the blob is the one its run's coverage names, else null.
 */
export function coverageSceneSource(path, blob) {
  const file = story.runCoverage.find((f) => f.path === path && f.blob === blob);
  return file ? { path, blob, content: sourceText(path) } : null;
}
