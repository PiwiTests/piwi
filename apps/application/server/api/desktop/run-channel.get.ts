// Desktop-only: the run channel of the runs the desktop shell starts, which the
// shell names in each one's environment (`PIWI_RUN_CHANNEL`). Behind the desktop
// token like every other route, and for the shell alone: a request a browser
// sends (Piwi Picker's, a page's) is refused, so the channel's token never
// reaches one. Responds 404 on the normal server build.
import { requireAuth } from '../../utils/auth';
import { apiError } from '../../utils/api-error';
import { desktopRuns } from '../../utils/desktop-runs';
import { isBrowserRequest } from '../../utils/desktop-access';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The run channel of the runs the shell starts (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Answers `{ runChannel, picks }`: the socket the desktop shell names in each Playwright run it starts as `PIWI_RUN_CHANNEL` (`<path>#<token>`), the bundled server being the hub of those runs, and the address the shell names as `PIWI_EDITOR_SEND` (`<url>#<token>`), where the runs’ tests send the locators they pick, for the window to copy, with a token that opens that route alone, never the desktop token; both null while the channel does not listen. Refused (403) to a request a browser sends (one carrying `Origin` or `Sec-Fetch-Site`): the shell alone asks.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event))
    throw apiError({ statusCode: 403, message: 'The desktop shell alone reads the run channel' });
  setResponseHeader(event, 'cache-control', 'no-store');
  const runs = await desktopRuns();
  const port = process.env.NITRO_PORT || process.env.PORT || '3000';
  return { runChannel: runs?.runChannel ?? null, picks: runs?.picksAddress(port) ?? null };
});
