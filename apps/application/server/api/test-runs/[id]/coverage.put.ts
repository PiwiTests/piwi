import { MAX_RUN_COVERAGE_BYTES, parseRunCoverage, storeRunCoverage } from '../../../utils/coverage';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';
import { invalidateCommitCoverage } from '../../../utils/coverage-summary';
import { scheduleCommitTotals } from '../../../utils/coverage-totals';
import { refreshCommitPrFeedback } from '../../../utils/scm/pr-feedback';
import { getDatabase } from '../../../database';
import { readJsonBodyWithin } from '../../../utils/body-limit';
import { testRuns } from '../../../database/schema';
import { eq } from 'drizzle-orm';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: 'Add to a run’s coverage',
    description:
      'Stores the coverage of a whole run, attributed to no test: per repository-relative file and runtime (`browser` or `server`), the functions and lines that ran and, for server files, the executable lines. Each file merges into what the run already holds (the union of its ranges), so every shard of a sharded run sends its own; a `blob` that disagrees with the stored one is dropped. Paths are cleaned as for a test’s coverage (repository-relative, no `node_modules`), ranges are normalized, and a file’s ranges of one kind past 10000 are dropped. At most 20000 files and 16 MB per request. The run’s commit’s combined coverage is recomputed a few seconds later, and the pull-request feedback of its newest posted run is posted again with the new patch coverage. Returns `files`, how many files the request stored.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['v', 'files'],
            properties: {
              v: { type: 'integer', enum: [1] },
              files: {
                type: 'array',
                maxItems: 20000,
                items: {
                  type: 'object',
                  required: ['path', 'runtime'],
                  properties: {
                    path: { type: 'string', description: 'Repository-relative POSIX path.' },
                    runtime: { type: 'string', enum: ['browser', 'server'] },
                    blob: {
                      type: 'string',
                      description: 'Git blob id of the file version the line numbers refer to.',
                    },
                    functions: {
                      type: 'array',
                      items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
                      description:
                        'The start and end line of each function that ran, `[start, end]`, 1-based and inclusive.',
                    },
                    lines: {
                      type: 'array',
                      items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
                      description: 'The executed line ranges, `[start, end]`, 1-based and inclusive.',
                    },
                    executable: {
                      type: 'array',
                      items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
                      description: 'The executable line ranges (server files), `[start, end]`, 1-based and inclusive.',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The files stored',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { files: { type: 'integer' } } },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const tooLarge = `Coverage too large (max ${MAX_RUN_COVERAGE_BYTES / 1024 / 1024} MB)`;
  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > MAX_RUN_COVERAGE_BYTES) throw apiError({ statusCode: 413, message: tooLarge });
  const { db, projectId } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const files = parseRunCoverage(await readJsonBodyWithin(event, MAX_RUN_COVERAGE_BYTES, tooLarge));
  if (typeof files === 'string') throw apiError({ statusCode: 400, message: files });
  const stored = await storeRunCoverage(db, id, projectId, files);
  // The run's commit's combined coverage counts the run coverage of its complete runs.
  const [run] = await db.select({ commit: testRuns.commit }).from(testRuns).where(eq(testRuns.id, id));
  if (run?.commit) {
    invalidateCommitCoverage(projectId, run.commit);
    scheduleCommitTotals(getDatabase, projectId, run.commit, refreshCommitPrFeedback);
  }
  return { files: stored };
});
