import { getEnvironmentActivity } from '#shared/handlers/environment-activity';
import { getDatabase } from '../../../../../database';
import { requireProjectAccess, requireRouteId } from '../../../../../utils/project-access';

defineRouteMeta({
  openAPI: {
    tags: ['Projects'],
    summary: "Read an environment's activity",
    description:
      'What the environment’s details show: `lastRun` (its latest run), `lastIncident` (the latest run flagged as an environment incident, or incident marker, with its `reason`), `deploys` (its deploy markers, newest first, with the `commit` each deployed; `moreDeploys` when there are older ones), and for a deployed environment (`appFromCheckout` false) `versions`: the application’s commits and versions its recent runs ran against, newest first, one entry per stretch of runs that saw the same (`commit` and its `source`, `server` or `marker`, `appVersions` the servers under test reported, `lastRunId`, `runs`).',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      { name: 'environmentId', in: 'path', required: true, schema: { type: 'integer' } },
    ],
    'x-required-permission': 'project:read',
    responses: {
      200: { description: 'The environment’s activity' },
      404: { description: 'No such environment of the project' },
    },
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'project ID');
  const environmentId = requireRouteId(event, 'environmentId', 'environment ID');
  await requireProjectAccess(event, id);
  const activity = await getEnvironmentActivity(await getDatabase(), id, environmentId);
  if (!activity) throw apiError({ statusCode: 404, message: 'No such environment in this project' });
  return activity;
});
