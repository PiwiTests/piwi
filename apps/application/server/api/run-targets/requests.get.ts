import { requestsForTarget, requireRunTarget } from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'List the run requests a connected app should act on',
    description:
      'For a run target (the desktop app, Piwi Runner), authenticated with the key the device flow gave it, which holds `run:receive` alone; any other credential is refused. Answers `requests`, those of its owner still waiting for a claim, sent to this target or to any, on projects where **Run on my machine** is on and the owner holds `run:receive`, each with `expiresAt`, when it stops waiting; and `stops`, the ids of the requests this target holds whose requester asked to stop them; and `held`, the `id` and `state` of each request this target holds, claimed or with its run going, which a target that started again ends unless it still holds it; and `projects`, the `id` and `name` (its label, else its name) of the projects of those requests and of those the target has a folder for, where the owner holds `run:receive`. Each call records that the target was seen: an app with its stream open calls it every minute.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: '`{ requests, stops, held, projects }`' },
      401: { description: 'No key, or an unknown one' },
      403: { description: 'The key is not a connected run target’s, or the app was disconnected' },
    },
  },
});

export default eventHandler(async (event) => {
  return requestsForTarget(await requireRunTarget(event));
});
