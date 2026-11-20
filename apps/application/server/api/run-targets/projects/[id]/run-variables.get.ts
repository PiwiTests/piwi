import { can } from '#shared/permissions';
import { parseRouteId } from '#shared/route-id';
import { requireRouteId } from '../../../../utils/project-access';
import { requireRunTarget, runSettingsForTarget } from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: "Get a project's run variables for a connected app",
    description:
      'What a run of the project gets, as `GET /api/projects/:id/run-variables` answers it: `{ runVariables, environment }`, with `?environment=<id>` the project’s and that environment’s merged. The desktop app reads it at each local run of a folder also linked to this project, for an environment of the team project, checks it again and runs nothing when it fails. A protected environment answers 403 unless the app’s owner manages the project. Authenticated with the target’s key alone; refused (403) on a project where **Run on my machine** is off or the owner lacks `run:receive`.',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environment', in: 'query', required: false, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The run variables, and the environment' },
      403: { description: 'Not a run target’s key, the project does not allow it, or the environment is protected' },
      404: { description: 'No such environment of the project' },
      409: { description: 'The merged list or the environment no longer pass the rules' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRouteId(event, 'id', 'project ID');
  if (!can(caller.access, 'run:receive', id)) {
    throw apiError({ statusCode: 403, message: 'This app’s owner cannot receive runs of this project' });
  }
  const raw = getQuery(event).environment;
  let environmentId: number | null = null;
  if (raw !== undefined && raw !== '') {
    environmentId = parseRouteId(String(raw));
    if (environmentId === null) throw apiError({ statusCode: 400, message: 'Invalid environment ID' });
  }
  const answered = await runSettingsForTarget(caller, id, environmentId);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  return { runVariables: answered.runVariables, environment: answered.environment };
});
