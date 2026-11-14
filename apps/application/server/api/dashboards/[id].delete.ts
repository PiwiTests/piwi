import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { dashboardActor, dashboardRoute } from '../../utils/dashboards';
import { deleteDashboard } from '#shared/handlers/dashboards';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Delete a saved dashboard',
    description:
      'Deletes a saved dashboard. The report schedules rendering it are deactivated and returned in `deactivatedSchedules`; the Quality reports page shows them inactive until their owner picks another dashboard. Its owner or an administrator.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  return dashboardRoute(async () =>
    deleteDashboard(db as any, getRouterParam(event, 'id'), await dashboardActor(event, user as any)),
  );
});
