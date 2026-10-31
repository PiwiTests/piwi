import { eq } from 'drizzle-orm';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { projects } from '../../../../database/schema';
import { rebuildProjectGraph } from '../../../../utils/graph-ingest';
import { refreshOpenApiSurface } from '../../../../utils/openapi-surface';
import { withProjectGraphLock } from '../../../../utils/project-graph-lock';
import { computeScenarioGaps } from '#shared/handlers/scenario-gaps';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'Rebuild the feature graph and recompute gaps',
    description:
      'Rebuilds the project’s route and page nodes and reaches edges from its whole history, then recomputes the project-wide scenario gaps (success-only, single-covering-test, surface-drift). Idempotent. Change-time gaps are computed when a pull-request-stamped run finishes.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'triage:write',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const db = await getDatabase();

  // Only one rebuild+recompute runs per project at a time: both walk the whole
  // history and upsert the same rows, so overlapping calls race and waste work.
  return withProjectGraphLock(projectId, async () => {
    const graph = await rebuildProjectGraph(db, projectId);
    const [project] = await db
      .select({ openApiUrl: projects.openApiUrl })
      .from(projects)
      .where(eq(projects.id, projectId));

    // Refresh the declared surface from the project's OpenAPI URL before detectors
    // run, so a documented-but-unreached route surfaces as a declared-never-hit gap.
    if (project?.openApiUrl) await refreshOpenApiSurface(db, projectId, project.openApiUrl);

    // The project-wide gaps are the default branch's, whatever branch ran last.
    const gaps = await computeScenarioGaps(db, projectId);
    return { success: true, runsProcessed: graph.runsProcessed, gapsUpserted: gaps.upserted, gapsClosed: gaps.closed };
  });
});
