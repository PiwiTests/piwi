import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getDatabase } from '../../../database';
import { apiError } from '../../../utils/api-error';
import { getShardSplit, parseShardSplitRequest } from '../../../utils/shard-split';

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'Split a sharded run’s tests between its shards by recorded duration',
    description:
      'What the reporter’s `balanceShards` option asks before Playwright shards a run (Playwright 1.62 and later). The body lists the tests Playwright built, unsharded, in a stable order: each with its Playwright `project`, its `file` (relative to the folder of the Playwright config, as runs report it), `suitePath`, `title`, `repeatEachIndex`, `locks`, `group` (a number it shares with the tests Playwright runs in one worker, in order: a serial describe, a file that is not fully parallel) and `skipped` (a test Playwright skips without running it). The answer’s `shards` gives the shard, from 1, of each listed test in that order, and `durationsMs` the summed recorded durations of each shard’s tests. The split balances the shards by duration and keeps every test that shares a lock or a group in one shard. A test weighs the average duration of its results in its Playwright project (final attempts, of the runs the selection catalog reads), else in every project, else the median of the others; a skipped test weighs nothing. The split is keyed by the project, `commit`, `shardTotal` and a hash of the listing, and kept for 24 hours: the first shard to ask computes and stores it, and every other shard of the run reads the same answer.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:submit',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              commit: { type: 'string', description: 'The commit the shards run; none keys the split without one' },
              shardTotal: { type: 'integer', minimum: 2, maximum: 1000 },
              tests: {
                type: 'array',
                maxItems: 100000,
                items: {
                  type: 'object',
                  properties: {
                    project: { type: 'string' },
                    file: { type: 'string' },
                    suitePath: { type: 'array', items: { type: 'string' } },
                    title: { type: 'string' },
                    repeatEachIndex: { type: 'integer' },
                    locks: { type: 'array', items: { type: 'string' } },
                    group: { type: 'integer' },
                    skipped: { type: 'boolean' },
                  },
                  required: ['file', 'title'],
                },
              },
            },
            required: ['shardTotal', 'tests'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);
  const body = ((await readBody(event)) ?? {}) as Record<string, unknown>;
  const request = parseShardSplitRequest(body);

  const db = await getDatabase();
  const split = await getShardSplit(db, projectId, request);
  if (!split) throw apiError({ statusCode: 404, message: `No project ${projectId}` });
  return { shards: split.shards, durationsMs: split.durationsMs, expiresAt: split.expiresAt.toISOString() };
});
