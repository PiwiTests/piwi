import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { testCases, testRuns, testRunsCases } from '../../../database/schema';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { readProjectRepositoryUrl } from '../../../utils/scm/project-repository';
import { notPrivateRun } from '#shared/run-eligibility';

/** How many of the latest runs the folders are read from. */
const RECENT_RUNS = 20;
/** How many folders the answer names at most. */
const MAX_WORKING_DIRS = 5;
/** How many spec paths the answer names at most. */
const MAX_SPEC_FILES = 50;

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get what identifies the folder of a project',
    description:
      'What the desktop app checks a folder against before linking it to the project. `specFiles`: the spec paths of the latest run (up to 50), relative to the folder of the Playwright config, which is the folder to link. `workingDirs`: the folders the latest runs were reported from (their `metadata.workingDir`, newest first, up to 5), absolute paths on the machines that ran them. `repositoryUrl`: the project’s repository. Empty lists and null for a project with no run.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, id);

  const db = await getDatabase();
  const runs = await db
    .select({ id: testRuns.id, metadata: testRuns.metadata })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, id), notPrivateRun(testRuns.origin)))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(RECENT_RUNS);

  const workingDirs = [
    ...new Set(runs.map((run) => workingDirOf(run.metadata)).filter((dir): dir is string => dir !== null)),
  ].slice(0, MAX_WORKING_DIRS);

  const latest = runs[0];
  const specFiles = latest
    ? (
        await db
          .selectDistinct({ filePath: testCases.filePath })
          .from(testRunsCases)
          .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
          .where(eq(testRunsCases.testRunId, latest.id))
          .orderBy(testCases.filePath)
          .limit(MAX_SPEC_FILES)
      ).map((row) => row.filePath)
    : [];

  return { specFiles, workingDirs, repositoryUrl: await readProjectRepositoryUrl(db, id) };
});

/** The folder a run was reported from: its Playwright config's, as the reporter records it. */
function workingDirOf(metadata: unknown): string | null {
  const dir = (metadata as { workingDir?: unknown } | null)?.workingDir;
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}
