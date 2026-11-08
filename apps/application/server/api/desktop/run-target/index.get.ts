import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { runTargetConnection, waitingRunRequests } from '@piwitests/editor/run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the connection to a team instance (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Answers `{ connection, requests }`: where the connection to the team instance this app takes run requests from stands (`none`, `signing-in` with the code and the page to allow the app on, `connecting`, `online`, `offline`, `revoked`), and the requests the window still asks the person about, with their checks and command. Never the key nor a request token.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  setResponseHeader(event, 'cache-control', 'no-store');
  return { connection: runTargetConnection(), requests: waitingRunRequests() };
});
