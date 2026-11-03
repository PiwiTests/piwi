import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getProjectLatestRun } from '#shared/handlers/test-runs';
import { isRunOriginKind } from '@piwitests/core/wire';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get latest run info for a project',
    description:
      'Returns the id and status of the most recent test run for the project. With `origin` and `ref`, the most recent run whose launcher stamped that origin and reference (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`), or null. 404 for a project that does not exist.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'origin', in: 'query', required: false, schema: { type: 'string' }, description: 'A run origin kind' },
      { name: 'ref', in: 'query', required: false, schema: { type: 'string' }, description: 'The origin reference' },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  await requireProjectAccess(event, id);

  const { origin, ref } = getQuery(event);
  if (origin !== undefined && (!isRunOriginKind(origin) || typeof ref !== 'string')) {
    throw apiError({ statusCode: 400, message: 'origin needs a known run origin and a ref' });
  }

  const db = await getDatabase();
  try {
    return await getProjectLatestRun(db, id, isRunOriginKind(origin) ? { kind: origin, ref: String(ref) } : null);
  } catch (e) {
    if ((e as Error)?.message === 'Project not found')
      throw apiError({ statusCode: 404, message: 'Project not found' });
    throw e;
  }
});
