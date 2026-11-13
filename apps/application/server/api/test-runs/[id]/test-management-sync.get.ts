import { getRunSync } from '#shared/handlers/test-management-sync';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Test Runs'],
    summary: "How a run's results sync to the test management tool stands",
    description:
      "The run's latest results sync as `{ sync }`, or `{ sync: null }` when none was queued: its `status` (`done`, `pending` while a retry is scheduled, `failed`, `skipped`), the `error` or skip reason, `dryRun` (nothing was sent: the counts are what a live sync would send), `outcomeUnknown` (the upload may have reached the tool), the test run's name and `runKey`, the number of results, their `counts`, the keys the catalog does not hold (`unknownKeys`, up to 20, and `unknownKeyCount`) and how many tests carry no key. Reads the stored sync only; never calls the tool. Read-only.",
    'x-required-permission': 'project:read',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  return { sync: await getRunSync(db, id) };
});
