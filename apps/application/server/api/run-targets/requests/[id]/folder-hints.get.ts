import { folderHintsForTarget, requireRunRequestId, requireRunTarget } from '../../../../utils/run-requests';

defineRouteMeta({
  openAPI: {
    tags: ['Run requests'],
    summary: 'Get what helps this connected app find a request’s folder',
    description:
      'For a request this app claimed: the project’s repository (`repositoryUrl`, null when the instance knows none) and the folders the requester’s own runs of the project were reported from (`folders`, absolute paths on the machines that ran them, newest first, at most 5), so the app can find the folder to run in on this machine. Refused (403) on a project where **Run on my machine** is off or the owner lacks `run:receive`. Authenticated with the target’s key alone.',
    'x-required-permission': 'run:receive',
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: 'The repository and the folders' },
      403: { description: 'Not a run target’s key, or the project does not allow it' },
      404: { description: 'No request this app claimed has this id' },
    },
  },
});

export default eventHandler(async (event) => {
  const caller = await requireRunTarget(event);
  const id = requireRunRequestId(event);
  const answered = await folderHintsForTarget(caller, id);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  return answered.hints;
});
