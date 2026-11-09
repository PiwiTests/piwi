import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { apiError } from '../../../../utils/api-error';
import { getRunPlan, materializePlan } from '../../../../utils/pass-reuse';
import { planSummary, requirePassReuseOn } from '../../../../utils/pass-reuse-route';
import { parseRankBy, parseShard, type SelectionFormat } from '#shared/selection';

const FORMATS: SelectionFormat[] = ['args', 'grep', 'files', 'json'];

defineRouteMeta({
  openAPI: {
    tags: ['Selections'],
    summary: 'A stored pass reuse plan, with the Playwright arguments of the tests it runs',
    description:
      'What `piwi run --plan <id>` reads: the plan’s counts and reasons, the reused tests with the pass each one reuses, and `resolution`, the tests the run executes materialized as `playwright test` arguments (null when the plan runs none). With `shard=i/n`, only that shard of them, balanced by duration and lock-aware, so every job of a matrix reads one plan. A plan expires 24 hours after it was made. Needs the experimental pass reuse capability. Read-only.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'planId', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'format', in: 'query', schema: { type: 'string', enum: FORMATS } },
      { name: 'shard', in: 'query', schema: { type: 'string' }, description: 'Keep only shard i of n (e.g. "2/4")' },
      {
        name: 'order',
        in: 'query',
        schema: { type: 'string', enum: ['failureLikelihood', 'recentFailure', 'priority', 'slowest', 'fastest'] },
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  const planId = requireRouteId(event, 'planId', 'plan ID');
  await requireProjectAccess(event, projectId);
  const query = getQuery(event);

  const db = await getDatabase();
  await requirePassReuseOn(db, projectId);
  const stored = await getRunPlan(db, projectId, planId);
  if (!stored) throw apiError({ statusCode: 404, message: `No plan ${planId} in this project, or it has expired` });

  const format = FORMATS.includes(query.format as SelectionFormat) ? (query.format as SelectionFormat) : 'args';
  const resolution = await materializePlan(db, projectId, stored.plan, {
    format,
    shard: parseShard(query.shard) ?? undefined,
    order: parseRankBy(query.order) ?? undefined,
  });
  return {
    id: stored.id,
    commit: stored.commit,
    expiresAt: stored.expiresAt.toISOString(),
    ...planSummary(stored.plan),
    reused: stored.plan.reused,
    resolution,
  };
});
