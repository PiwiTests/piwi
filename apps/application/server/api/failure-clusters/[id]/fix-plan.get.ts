import { eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { failureClusters } from '../../../database/schema';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { buildFixPlan } from '../../../utils/fix-plan';
import { enrichFixPlanOwnership } from '../../../utils/scm/ownership';
import { withFixPlanSuspectLines } from '../../../utils/suspect-lines';
import { fixPlanToMarkdown } from '#shared/fix-plan-markdown';

defineRouteMeta({
  openAPI: {
    tags: ['Failure Clusters'],
    summary: 'Everything needed to fix a cluster, in one answer',
    description:
      'Assembles the diagnosis, its validated patch, the ranked locator replacements with the exact file and line to edit, the failing tests, the changed lines they executed (`suspectLines`, the top five suspect lines, as `GET /api/failure-clusters/{id}/suspect-lines` answers them), and the command that verifies the work — the pieces an agent would otherwise gather from four separate calls and stitch together badly. `verify.expectation` states what the dashboard does once those tests pass, so the loop closes without a human deciding whether the fix worked. Every section degrades independently: a cluster with no diagnosis still returns its failing tests and verification command. `?format=markdown` returns the same plan as plain-text Markdown for a ticket or an agent.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'markdown'] } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const clusterId = requireRouteId(event, 'id', 'cluster ID');
  const db = await getDatabase();

  const [cluster] = await db
    .select({ projectId: failureClusters.projectId })
    .from(failureClusters)
    .where(eq(failureClusters.id, clusterId));
  if (!cluster) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });

  await requireProjectAccess(event, cluster.projectId);

  const plan = await buildFixPlan(db, clusterId);
  if (!plan) throw apiError({ statusCode: 404, message: 'Failure cluster not found' });
  const enriched = await withFixPlanSuspectLines(
    db,
    clusterId,
    await enrichFixPlanOwnership(db, cluster.projectId, plan),
  );

  if (getQuery(event).format === 'markdown') {
    setResponseHeader(event, 'Content-Type', 'text/markdown; charset=utf-8');
    const origin = getRequestURL(event).origin;
    return fixPlanToMarkdown(enriched, { url: `${origin}/failure-clusters/${clusterId}` });
  }

  return enriched;
});
