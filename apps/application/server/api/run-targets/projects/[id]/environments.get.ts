import { can } from '#shared/permissions';
import { requireRouteId } from '../../../../utils/project-access';
import { environmentsForTarget, requireRunTarget } from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: "List a project's environments for a connected app",
    description:
      'The environments of a project, as `GET /api/projects/:id/environments` lists them, archived ones left out: what the desktop app offers for the local runs of a folder also linked to this project, read here at each run and never kept. A protected environment’s run variables are listed only when the app’s owner manages the project. Authenticated with the target’s key alone; refused (403) on a project where **Run on my machine** is off or the owner lacks `run:receive`.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The environments' },
      403: { description: 'Not a run target’s key, or the project does not allow it' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRouteId(event, 'id', 'project ID');
  if (!can(caller.access, 'run:receive', id)) {
    throw apiError({ statusCode: 403, message: 'This app’s owner cannot receive runs of this project' });
  }
  const answered = await environmentsForTarget(caller, id);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  return { environments: answered.environments };
});
