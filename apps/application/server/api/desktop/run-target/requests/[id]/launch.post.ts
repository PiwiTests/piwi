import { requireAuth } from '../../../../../utils/auth';
import { apiError } from '../../../../../utils/api-error';
import { isBrowserRequest } from '../../../../../utils/desktop-access';
import { isRequestId, launchOf } from '../../../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: what the shell starts (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. After **Run**, answers `{ instance, token, projectId, args }` once: the instance and the request token the reporter uploads the run with, the project whose linked folder it runs in, and the arguments after `playwright test`. 404 for a request with no run to start, or asked a second time.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event)) throw apiError({ statusCode: 403, message: 'The desktop shell alone calls this route' });
  setResponseHeader(event, 'cache-control', 'no-store');
  const id = getRouterParam(event, 'id');
  if (!isRequestId(id)) throw apiError({ statusCode: 400, message: 'Invalid request id' });
  const launch = launchOf(id);
  if (!launch) throw apiError({ statusCode: 404, message: 'No run to start for this request' });
  return launch;
});
