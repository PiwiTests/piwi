import { requireAuth } from '../../../../../utils/auth';
import { apiError } from '../../../../../utils/api-error';
import { isBrowserRequest } from '../../../../../utils/desktop-access';
import { isRequestId, requestedRunEnded } from '../../../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: a requested run ended (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ code, stopped }`, the exit code of the run’s Playwright process (null when it was killed) and whether a stop was asked for it. The server reports the run ended to the instance: `stopped` after a stop from the dashboard or the window, `passed` for 0, `failed` for 1, otherwise `error`.',
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
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { code?: unknown; stopped?: unknown };
  const code = typeof body.code === 'number' && Number.isInteger(body.code) ? body.code : null;
  await requestedRunEnded(id, code, body.stopped === true);
  return { ok: true };
});
