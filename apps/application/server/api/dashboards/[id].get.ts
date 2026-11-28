import { getDatabase } from '../../database';
import { requireAuth } from '../../utils/auth';
import { isReadOnly } from '../../utils/operator-limits';
import { getProjectScope } from '../../utils/project-access';
import { dashboardActor, dashboardRoute } from '../../utils/dashboards';
import { getDashboard, loadDashboardDefinition, viewerScope } from '#shared/handlers/dashboards';

defineRouteMeta({
  openAPI: {
    tags: ['Analytics'],
    summary: 'Read a dashboard',
    description:
      'One dashboard (`id` is a built-in key such as `overview`, or a saved dashboard id) with its definition and its bands resolved against the widget registry: options defaulted, and a widget a later release removed returned as `available: false` with the notice to show. `hiddenProjects` counts the projects of the scope the caller cannot open (a dashboard grants no access); the scope is the one the query carries, with the same keys as `GET /api/widgets/[widget]`, else the dashboard’s default. The owner and administrators also get the report schedules rendering it. Opening a saved dashboard records the view, at most once an hour and never while the instance is read-only.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const db = await getDatabase();
  const actor = await dashboardActor(event, user as any);
  const id = getRouterParam(event, 'id');
  return dashboardRoute(async () => {
    const { definition } = await loadDashboardDefinition(db as any, id, actor);
    return getDashboard(db as any, id, actor, await getProjectScope(db, user as any), {
      scope: viewerScope(definition, getQuery(event)),
      touch: !isReadOnly(),
    });
  });
});
