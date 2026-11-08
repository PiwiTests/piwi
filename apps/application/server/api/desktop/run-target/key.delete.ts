import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { isBrowserRequest } from '../../../utils/desktop-access';
import { disconnectRunTarget } from '@piwitests/editor/run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: disconnect (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Stops taking run requests and forgets the key, after the shell deleted it from the keychain. The key stays listed in the instance’s Connected apps until it is revoked there.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event)) throw apiError({ statusCode: 403, message: 'The desktop shell alone calls this route' });
  setResponseHeader(event, 'cache-control', 'no-store');
  disconnectRunTarget();
  return { ok: true };
});
