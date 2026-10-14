/**
 * What the demo answers for the suspect lines of cluster 5 (the modal story,
 * whose newest failing run carries browser coverage) and of its failing
 * execution 496, and the canned changes its What changed card diffs. A dev
 * server seeded with the demo data cannot read the demo's repositories, so the
 * screenshot scenes of suspect lines serve these through route interception;
 * `tests/unit/demo-suspect-lines.test.ts` checks that the demo's own handlers
 * answer exactly these, so the scenes show what the live demo shows.
 */
import { SCM_REPOS } from '../../shared/demo/failure-stories.mjs';

const commits = SCM_REPOS[3].commits;
const newest = commits[0];
const oldest = commits[commits.length - 1];

/** The demo's default range for project 3: its oldest commit to its newest. */
export const SUSPECT_SCENE_RANGE = { from: oldest.sha, to: newest.sha };

const suspect = (failing) => ({
  path: 'src/components/modal-controller.ts',
  runtime: 'browser',
  hunk: [4, 5],
  lines: [[4, 5]],
  granularity: 'files',
  failing,
  passing: 0,
  score: 1,
});

const summary = (failingWithCoverage) => ({
  changedFiles: 2,
  changedLines: 4,
  hunks: 2,
  executedHunks: 1,
  executedLines: 0,
  failingWithCoverage,
  passingWithCoverage: 3,
});

/** `GET /api/failure-clusters/5/suspect-lines` in the demo. */
export const SUSPECT_SCENE_CLUSTER = {
  id: 5,
  answer: { available: true, range: SUSPECT_SCENE_RANGE, summary: summary(2), suspects: [suspect(2)], runId: 39 },
};

/** `GET /api/test-run-cases/496/suspect-lines` in the demo. */
export const SUSPECT_SCENE_EXECUTION = {
  id: 496,
  answer: { available: true, range: SUSPECT_SCENE_RANGE, summary: summary(1), suspects: [suspect(1)] },
};

/**
 * The cluster's diagnosis context with the demo's What changed: the commits
 * newer than the oldest, their files with the suspect's first, and the range.
 */
export function withSceneChanges(context) {
  const newer = commits.slice(0, -1);
  const files = newer.flatMap((c) => c.files);
  files.sort((a, b) => Number(b.filename === suspect(0).path) - Number(a.filename === suspect(0).path));
  return {
    ...context,
    scmChanges: { commits: newer.map((c) => ({ sha: c.sha, message: c.message })), files, patchesOmitted: false },
    coverage: {
      ...context.coverage,
      scm: {
        ...context.coverage?.scm,
        hasLastGreen: true,
        hasCommitRange: true,
        baseCommitUsed: null,
        provider: 'github',
        commitsCount: newer.length,
        filesCount: files.length,
        patchedFilesCount: files.filter((f) => f.patch).length,
        patchesOmitted: false,
        patchesTruncated: false,
        baselineKind: 'run-green',
        error: null,
        range: { from: oldest.sha.slice(0, 7), to: newest.sha.slice(0, 7) },
      },
    },
  };
}
