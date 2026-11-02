import { requireResolvedProjectAccess, requireRouteId, resolveCaseProjectId } from '../../utils/project-access';
import { getTestCase } from '#shared/handlers/test-cases';

defineRouteMeta({
  openAPI: {
    tags: ['Test Cases'],
    summary: 'Get test case detail (stable identity)',
    description:
      'Returns the stable test case identity with aggregated run stats, recent executions, linked failure clusters, and entity links. The stats count runs, one result per run, Playwright project and `--repeat-each` repetition read from its final attempt; `passRate` is the passed runs over the runs that passed or failed, in percent, null when none did.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'test case ID');
  const { db } = await requireResolvedProjectAccess(event, id, resolveCaseProjectId, 'Test case');

  const result = (await getTestCase(db, id)) as any;
  if (!result) {
    throw apiError({
      statusCode: 404,
      message: 'Test case not found',
    });
  }

  return result;
});
