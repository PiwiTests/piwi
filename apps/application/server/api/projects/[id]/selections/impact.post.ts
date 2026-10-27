import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { parseImpactChanges, resolveImpact } from '../../../../utils/selection-impact';
import { parseRankBy, parseShard, type SelectionFormat } from '#shared/selection';

const FORMATS: SelectionFormat[] = ['args', 'grep', 'files', 'json'];

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'Resolve which tests a set of changed files impacts',
    description:
      'Maps changed files (computed by the client from a git diff) to the tests they affect — directly when a changed file is a test file, by reach when a test’s captured source frames ran through it, and by code reach when a test’s coverage ran the file or it handles a route the test called. With `changes`, a modified file’s tests that reach it through coverage are narrowed to those whose recorded coverage of its base version ran the changed lines, or a function around them; a test the coverage cannot rule out (another version, no ranges, an incomplete capture, a change outside every function) stays. Returns the impacted tests, a `playwright test` command and, in `impact.files`, what each changed file selects and why. A changed source file that maps to no test widens the result to the full suite (with a warning) rather than silently skipping it. This is what `piwi run impact --base <ref>` calls.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              changedFiles: { type: 'array', items: { type: 'string' } },
              changes: {
                type: 'array',
                description:
                  'Modified files read on the base side of the diff: the path, the base blob id (`git diff --full-index`, or abbreviated to 7+ characters) and the changed base lines as [start, end] pairs, 1-based and inclusive',
                items: {
                  type: 'object',
                  properties: {
                    filePath: { type: 'string' },
                    blob: { type: 'string' },
                    lines: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
                  },
                  required: ['filePath', 'blob', 'lines'],
                },
              },
              format: { type: 'string', enum: FORMATS },
              shard: { type: 'string', description: 'Keep only shard i of n (e.g. "2/4")' },
              order: {
                type: 'string',
                enum: ['failureLikelihood', 'recentFailure', 'priority', 'slowest', 'fastest'],
                description: 'Emit tests in this rank order (fail-fast)',
              },
            },
            required: ['changedFiles'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const body = (await readBody(event)) as {
    changedFiles?: unknown;
    changes?: unknown;
    format?: unknown;
    shard?: unknown;
    order?: unknown;
  };
  const changedFiles = Array.isArray(body.changedFiles)
    ? body.changedFiles.filter((f): f is string => typeof f === 'string')
    : [];
  const format = FORMATS.includes(body.format as SelectionFormat) ? (body.format as SelectionFormat) : 'args';

  const db = await getDatabase();
  return resolveImpact(db, projectId, changedFiles, {
    format,
    shard: parseShard(body.shard) ?? undefined,
    order: parseRankBy(body.order) ?? undefined,
    changes: parseImpactChanges(body.changes),
  });
});
