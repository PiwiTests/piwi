import { updateEnvironment } from '#shared/handlers/environments';
import { environmentPatchSchema } from '#shared/environments';
import { getDatabase } from '../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Change a project's environment",
    description:
      'Body: any field of `POST /api/projects/:id/environments`, and `archived`. The fields given replace the environment’s own, and it stops being `discovered`. A changed key keeps the old one as an alias, so the runs that reported it stay with it. An archived environment leaves the pickers, and no run starts for it; its runs keep it. The project’s runs are resolved again after the change.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environmentId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:manage',
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const environmentId = requireRouteId(event, 'environmentId', 'environment ID');
  await requireProjectAccess(event, id);
  const parsed = environmentPatchSchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });
  const result = await updateEnvironment(await getDatabase(), id, environmentId, parsed.data);
  if (!result.ok) throw apiError({ statusCode: result.statusCode, message: result.problems.join(' ') });
  return { environment: result.environment };
});
