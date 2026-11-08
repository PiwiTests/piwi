import { requireAuth } from '../../../../../utils/auth';
import { apiError } from '../../../../../utils/api-error';
import { isBrowserRequest } from '../../../../../utils/desktop-access';
import { isRequestId, requestedRunFailed, requestedRunStarted } from '../../../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: a requested run started (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. The shell started the run of a request, which the server reports to the instance as `running`; with `{ error }` it could not start it, reported as an error with those words.',
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
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { error?: unknown };
  if (typeof body.error === 'string' && body.error) await requestedRunFailed(id, body.error);
  else await requestedRunStarted(id);
  return { ok: true };
});
