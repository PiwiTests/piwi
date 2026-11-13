// Desktop-only: the run channel of the runs the desktop shell starts, which the
// shell names in each one's environment (`PIWI_RUN_CHANNEL`). Behind the desktop
// token like every other route, and for the shell alone: a request a browser
// sends (Piwi Picker's, a page's) is refused, so the channel's token never
// reaches one, nor an editor's run channel the answer names. Responds 404 on the normal server build.
import { requireAuth } from '../../utils/auth';
import { apiError } from '../../utils/api-error';
import { desktopRuns } from '../../utils/desktop-runs';
import { hostRequestOf } from '../../utils/desktop-access';
import { answerRunChannel, messageOf } from '@piwitests/editor/shell-runs-routes';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The run channel of the runs the shell starts (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Answers `{ runChannel, picks, hub }`: the socket the desktop shell names in each Playwright run it starts as `PIWI_RUN_CHANNEL` (`<path>#<token>`), the bundled server being the hub of those runs, the address the shell names as `PIWI_EDITOR_SEND` (`<url>#<token>`), where the runs’ tests send the locators they pick, for the window to copy, with a token that opens that route alone, never the desktop token, and the hub’s WebSocket (`{ url, token }`, the desktop token), which the shell writes into its discovery file for a run started in a terminal in a linked folder; each null while it does not listen. With `folder` (a linked folder, absolute) and `attended` (`1`, or `0` for a job nobody attends), it also names `editor`: the live editor whose workspace holds the folder (`{ runChannel, client }`, its run channel as `<path>#<token>`), which a job the shell runs in a throwaway checkout of that folder runs on, null for none. Refused (403) to a request a browser sends (one carrying `Origin` or `Sec-Fetch-Site`): the shell alone asks.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  setResponseHeader(event, 'cache-control', 'no-store');
  const port = process.env.NITRO_PORT || process.env.PORT || '3000';
  const runs = await desktopRuns();
  const answer = answerRunChannel(runs, { headers: hostRequestOf(event).headers }, port);
  if (answer.status !== 200) throw apiError({ statusCode: answer.status, message: messageOf(answer) });
  const { folder, attended } = getQuery(event);
  if (typeof folder !== 'string') return answer.body;
  // A job in a throwaway checkout of a linked folder runs on the editor whose workspace holds the folder, if one does.
  return { ...(answer.body as object), editor: runs?.editorHubFor(folder, attended !== '0') ?? null };
});
