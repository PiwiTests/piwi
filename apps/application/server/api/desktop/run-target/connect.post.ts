import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { connectRunTarget, instanceUrlOf } from '@piwitests/editor/run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: connect to a team instance (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body `{ instance }`, an http or https URL. Starts the device flow on that instance for a run target (`POST /api/extension/connect` with `target: "desktop"`), disconnecting any instance connected before, and answers the connection with the code the instance’s page shows and the page to open, where the person allows the app. Once allowed, the app connects, and the shell keeps its key in the OS keychain. 400 for a value that is not such a URL.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { instance?: unknown };
  const instance = instanceUrlOf(body.instance);
  if (!instance) throw apiError({ statusCode: 400, message: 'The instance is an http or https URL' });
  return connectRunTarget(instance);
});
