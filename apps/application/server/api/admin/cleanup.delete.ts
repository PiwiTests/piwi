import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { deleteRunsOlderThan, reclaimSpace, retentionMinRuns, sweepOrphans } from '../../utils/retention';

defineRouteMeta({
  openAPI: {
    tags: ['Admin'],
    summary: 'Cleanup old test data',
    description:
      'Deletes test runs older than a specified number of days, including associated files, traces, and reports. Kept runs and the newest PIWI_RETENTION_MIN_RUNS runs of each project are left in place and counted in the response. Optionally runs a full VACUUM (SQLite) to return freed space to the filesystem. Requires `storage:manage` (administrators only).',
    'x-required-permission': 'storage:manage',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              olderThanDays: { type: 'integer', description: 'Delete runs older than this many days' },
              vacuum: {
                type: 'boolean',
                description: 'Run a blocking full VACUUM after cleanup (SQLite only; ignored on PostgreSQL)',
              },
            },
            required: ['olderThanDays'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);

  const body = await readBody<{ olderThanDays?: string | number; vacuum?: boolean }>(event);

  const olderThanDays = parseInt(String(body?.olderThanDays ?? '0'), 10);

  if (!olderThanDays || olderThanDays < 1) {
    throw apiError({
      statusCode: 400,
      message: 'olderThanDays must be a positive integer',
    });
  }

  const db = await getDatabase();

  const { deletedRuns, skippedKept, skippedNewest } = await deleteRunsOlderThan(db, olderThanDays, {
    keepNewestPerProject: retentionMinRuns(),
  });
  await sweepOrphans(db);
  const space = await reclaimSpace(db, { full: body?.vacuum === true });

  return {
    success: true,
    deletedRuns,
    keptRunsSkipped: skippedKept,
    newestRunsSkipped: skippedNewest,
    spaceReclaim: space.note,
  };
});
