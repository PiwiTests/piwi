import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { isBrowserRequest } from '../../../utils/desktop-access';
import { keyToKeep } from '../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the key to keep (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Answers `{ instance, key }`, the key the device flow just gave, for the shell to keep in the OS keychain; 404 once it is kept, or with none. The window never reads it.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event)) throw apiError({ statusCode: 403, message: 'The desktop shell alone calls this route' });
  setResponseHeader(event, 'cache-control', 'no-store');
  const kept = keyToKeep();
  if (!kept) throw apiError({ statusCode: 404, message: 'No key to keep' });
  return kept;
});
