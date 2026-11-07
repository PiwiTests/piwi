import { claimRequest, requireRunRequestId, requireRunTarget, runRequestOf } from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Claim a run request for this connected app',
    description:
      'Claims a waiting request of the target’s owner, once: a second claim, from another target or a reconnect, answers 409, as does an expired request. Answers the request, which the target shows and runs only after the person clicks **Run**. Refused (403) on a project where **Run on my machine** is off or the owner lacks `run:receive`. Authenticated with the target’s key alone.',
    'x-required-permission': 'run:receive',
    responses: {
      200: { description: 'The claimed request' },
      403: { description: 'Not a run target’s key, or the project does not allow it' },
      404: { description: 'No request of the owner has this id' },
      409: { description: 'Already claimed, or expired' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRunRequestId(event);
  const claimed = await claimRequest(caller, id);
  if (!claimed.ok) throw apiError({ statusCode: claimed.statusCode, message: claimed.message });
  const request = runRequestOf(claimed.row);
  if (!request)
    throw apiError({ statusCode: 422, message: 'This request no longer passes the checks of a run request' });
  return request;
});
