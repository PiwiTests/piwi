import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';
import { getDatabase } from '../../../../database';
import { listScenarioGaps } from '#shared/handlers/scenario-gaps';

defineRouteMeta({
  openAPI: {
    tags: ['Scenario gaps'],
    summary: 'List a project’s scenario gaps',
    description:
      'Returns the project’s ranked scenario gaps — proposed tests that do not exist yet — with their evidence, exposure factors and score. Filter by `kind`, `class`, `detector`, `status` and `pr`. A muted detector’s gaps come after every other one. Reach is observed reach, never instrumented coverage.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'kind', in: 'query', required: false, schema: { type: 'string', enum: ['gap', 'finding'] } },
      {
        name: 'class',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['blind-spot', 'false-comfort', 'fragile', 'unhandled', 'degraded'] },
      },
      { name: 'detector', in: 'query', required: false, schema: { type: 'string' } },
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['open', 'snoozed', 'dismissed', 'accepted', 'closed', 'all'] },
      },
      { name: 'pr', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const projectId = requireRouteId(event, 'id', 'project ID');
  await requireProjectAccess(event, projectId);

  const query = getQuery(event);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const db = await getDatabase();
  return {
    items: await listScenarioGaps(db, projectId, {
      kind: str(query.kind),
      class: str(query.class),
      detector: str(query.detector),
      status: str(query.status),
      prNumber: num(query.pr),
      limit: num(query.limit),
      mutedLast: true,
    }),
  };
});
