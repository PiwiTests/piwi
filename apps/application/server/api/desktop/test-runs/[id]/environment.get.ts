import { eq } from 'drizzle-orm';
import { testRuns } from '../../../../database/schema';
import { requireResolvedProjectAccess, requireRouteId, resolveRunProjectId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The environment a run reported (desktop app)',
    description:
      'Desktop build only — 404 on the server build. `{ label, environmentId }`: the label the run reported (the reporter’s `environment` option, else `PIWI_ENVIRONMENT`), null for none, and the environment of its project the label resolves to, null for none. The Local runs tray compares it with the environment a run the shell started was for.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  const id = requireRouteId(event, 'id', 'test run ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveRunProjectId, 'Test run');
  const [run] = await db
    .select({ label: testRuns.environment, environmentId: testRuns.environmentId })
    .from(testRuns)
    .where(eq(testRuns.id, id));
  if (!run) throw apiError({ statusCode: 404, message: 'Test run not found' });
  return { label: run.label ?? null, environmentId: run.environmentId ?? null };
});
