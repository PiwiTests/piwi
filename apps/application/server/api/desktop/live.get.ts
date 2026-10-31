// Desktop-only: the hub of the runs the desktop shell starts, for Piwi Picker,
// which holds the desktop token since the developer allowed its pairing. The
// answer has the shape of an editor's `GET …/live`, so the extension reads both
// alike; its token is the desktop token the request carries. Responds 404 on the
// normal server build.
import { requireAuth } from '../../utils/auth';
import { apiError } from '../../utils/api-error';
import { desktopRuns } from '../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The hub of the desktop app’s runs, for Piwi Picker (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Answers `{ hubs }` as an editor’s `GET /piwi/live` does: the WebSocket (`ws://127.0.0.1:<port>/piwi/hub`) through which Piwi Picker follows and steers the Playwright runs the desktop shell starts, with the token its `hello` carries (the desktop token), the server’s pid and version, `client` (`Piwi desktop app`), the linked folders (`roots`) and when it started. Empty while the hub does not listen.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  setResponseHeader(event, 'cache-control', 'no-store');
  const runs = await desktopRuns();
  return { hubs: runs?.live() ?? [] };
});
