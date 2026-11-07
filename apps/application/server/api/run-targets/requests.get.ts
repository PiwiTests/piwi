import { requestsForTarget, requireRunTarget } from '../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'List the run requests a connected app should act on',
    description:
      'For a run target (the desktop app, Piwi Runner), authenticated with the key the device flow gave it, which holds `run:receive` alone; any other credential is refused. Answers `requests`, those of its owner still waiting for a claim, sent to this target or to any, on projects where **Run on my machine** is on and the owner holds `run:receive`; and `stops`, the ids of the requests this target holds whose requester asked to stop them. Each call records that the target was seen.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: '`{ requests, stops }`' },
      401: { description: 'No key, or an unknown one' },
      403: { description: 'The key is not a connected run target’s, or the app was disconnected' },
    },
  },
});

export default eventHandler(async (event) => {
  return requestsForTarget(await requireRunTarget(event));
});
