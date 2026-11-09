import { getDatabase } from '../../../database';
import { requireProjectAccess, requireRouteId } from '../../../utils/project-access';
import { getProjectLatestRun, parseLatestRunNames } from '#shared/handlers/test-runs';
import { isRunOriginKind } from '@piwitests/core/wire';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: 'Get latest run info for a project',
    description:
      'Returns the id and status of the most recent test run for the project. With `origin` and `ref`, the most recent run whose launcher stamped that origin and reference (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`), or null, with the name its launcher gave the run (`PIWI_RUN_REF`) as `name`, null when the reporter recorded none. With `run` too (repeatable), a run whose launcher also named it (`PIWI_RUN_REF`) matches only under one of those names. 404 for a project that does not exist.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'origin', in: 'query', required: false, schema: { type: 'string' }, description: 'A run origin kind' },
      { name: 'ref', in: 'query', required: false, schema: { type: 'string' }, description: 'The origin reference' },
      {
        name: 'run',
        in: 'query',
        required: false,
        schema: { type: 'array', items: { type: 'string' } },
        description: "The launcher's names for the run (up to 64), with origin",
      },
    ],
    'x-required-permission': 'project:read',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');

  const viewer = await requireProjectAccess(event, id);

  const { origin, ref, run } = getQuery(event);
  if (origin !== undefined && (!isRunOriginKind(origin) || typeof ref !== 'string')) {
    throw apiError({ statusCode: 400, message: 'origin needs a known run origin and a ref' });
  }
  const runs = parseLatestRunNames(run);
  if (runs === null) throw apiError({ statusCode: 400, message: 'run needs up to 64 valid run names' });

  const db = await getDatabase();
  try {
    return await getProjectLatestRun(
      db,
      id,
      isRunOriginKind(origin) ? { kind: origin, ref: String(ref), runs } : null,
      viewer.id,
    );
  } catch (e) {
    if ((e as Error)?.message === 'Project not found')
      throw apiError({ statusCode: 404, message: 'Project not found' });
    throw e;
  }
});
