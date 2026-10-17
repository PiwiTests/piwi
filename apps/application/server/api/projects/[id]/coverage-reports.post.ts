import { getDatabase } from '../../../database';
import { readJsonBodyWithin } from '../../../utils/body-limit';
import {
  MAX_REPORT_BYTES,
  PROJECT_NOT_FOUND,
  parseCoverageReportUpload,
  storeCoverageReport,
} from '../../../utils/coverage-reports';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { invalidateCommitCoverage } from '../../../utils/coverage-summary';
import { settleCommitCoverage } from '../../../utils/coverage-totals';
import { refreshCommitPrFeedback } from '../../../utils/scm/pr-feedback';

const RANGES = {
  type: 'array',
  items: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 2, maxItems: 2 },
} as const;

defineRouteMeta({
  openAPI: {
    tags: ['Coverage'],
    summary: 'Upload a coverage report',
    description:
      'Stores one suite’s coverage of one commit, read from another tool’s report (Cobertura or LCOV from Vitest, coverlet or Microsoft code coverage) by `piwi coverage upload`, attributed to no test. A report is keyed by `commit` and `suite`: uploads of the same commit and suite merge, like shards (per file, the union of its lines and functions when the file version agrees; the newer version otherwise, which marks the report incomplete). Each file is repository-relative, with the git `blob` of the version its line numbers refer to, its `executable` lines, the `lines` and `functions` that ran and `allFunctions`, every function the tool knows, run or not; a file with neither executable lines nor functions is dropped. `inventory` is the commit’s tracked files in the project’s coverage scope and their blobs, `[[path, blob], ...]`, merged across parts. No source code, no test names and no hit counts are sent. `branch` is the branch the suite ran on; the project’s default branch, or none, stores it as the default branch’s, and a commit any of whose reports or runs ran on the default branch is the default branch’s. A file’s ranges of one kind past 10000 are dropped, which marks the report incomplete. At most 20000 files, 100000 inventory entries and 16 MB per request. The commit’s combined coverage is recomputed a few seconds later, and the pull-request feedback of its newest posted run is posted again with the new patch coverage. Off the default branch, per suite only the report of the commit whose coverage arrived last is kept: an older commit’s report goes once a newer commit’s report of that suite exists on the branch, and the older commit keeps its totals, final. An upload for such a commit (a CI job run again) is accepted, changes no totals and is pruned again: the answer’s `superseded.by` names the newer commit. Returns the report and `stored`, how many of the request’s files were stored. The suite names `e2e` and `combined` are reserved.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['v', 'commit', 'suite', 'files'],
            properties: {
              v: { type: 'integer', enum: [1] },
              commit: { type: 'string', description: 'The commit the suite ran on, 7 to 64 hexadecimal characters.' },
              branch: { type: 'string', description: 'The branch the suite ran on.' },
              suite: {
                type: 'string',
                description: 'The suite’s name, e.g. `unit-back`: 1 to 64 letters, digits, `.`, `_` or `-`.',
              },
              kind: { type: 'string', enum: ['unit', 'e2e'], description: '`unit` when absent.' },
              tool: { type: 'string', description: 'The report format and writer, e.g. `cobertura`.' },
              incomplete: { type: 'boolean', description: 'The uploader left part of the report out.' },
              inventory: {
                type: 'array',
                maxItems: 100000,
                items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
                description: 'The commit’s tracked files in scope, `[path, blob]`.',
              },
              files: {
                type: 'array',
                maxItems: 20000,
                items: {
                  type: 'object',
                  required: ['path'],
                  properties: {
                    path: { type: 'string', description: 'Repository-relative POSIX path.' },
                    blob: { type: 'string', description: 'Git blob id of the file version the line numbers refer to.' },
                    executable: { ...RANGES, description: 'The lines the tool can mark as run, `[start, end]`.' },
                    lines: { ...RANGES, description: 'The lines that ran, `[start, end]`.' },
                    functions: { ...RANGES, description: 'The start and end line of each function that ran.' },
                    allFunctions: { ...RANGES, description: 'The start and end line of every function, run or not.' },
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
        description: 'The report, merged',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                stored: { type: 'integer' },
                superseded: {
                  type: 'object',
                  description:
                    'Present when a newer commit superseded this one: its totals are final, and the upload is pruned again.',
                  properties: { by: { type: 'string', nullable: true } },
                },
                report: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    commit: { type: 'string' },
                    branch: { type: 'string', nullable: true },
                    suite: { type: 'string' },
                    kind: { type: 'string', enum: ['unit', 'e2e'] },
                    tool: { type: 'string', nullable: true },
                    incomplete: { type: 'boolean' },
                    files: { type: 'integer' },
                    inventoryFiles: { type: 'integer', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
      404: { description: 'Project not found' },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const tooLarge = `Coverage report too large (max ${MAX_REPORT_BYTES / 1024 / 1024} MB)`;
  const contentLength = parseInt(getRequestHeader(event, 'content-length') ?? '0', 10);
  if (contentLength > MAX_REPORT_BYTES) throw apiError({ statusCode: 413, message: tooLarge });
  await requireProjectAccess(event, id);
  const upload = parseCoverageReportUpload(await readJsonBodyWithin(event, MAX_REPORT_BYTES, tooLarge));
  if (typeof upload === 'string') throw apiError({ statusCode: 400, message: upload });
  const stored = await storeCoverageReport(await getDatabase(), id, upload).catch((error: unknown) => {
    if (error instanceof Error && error.message === PROJECT_NOT_FOUND) {
      throw apiError({ statusCode: 404, message: PROJECT_NOT_FOUND });
    }
    throw error;
  });
  invalidateCommitCoverage(id, upload.commit);
  const superseded = await settleCommitCoverage(getDatabase, id, upload.commit, refreshCommitPrFeedback);
  return superseded ? { ...stored, superseded } : stored;
});
