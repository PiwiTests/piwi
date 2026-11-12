// Desktop-only: where the runs the desktop shell starts send the locators
// their tests pick (`PIWI_EDITOR_SEND` names it, as an editor's Send to
// editor pairing names its endpoint): the pause bar's Pick a locator and a
// pick on the image of a stop. The runs post with the token minted for this
// route alone (`desktopPicksToken`), which opens no other; each locator goes
// to the window, to copy. Responds 404 on the normal server build.
import { answerRunPick, messageOf } from '@piwitests/editor/shell-runs-routes';
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'A locator a desktop run picked, for the window to copy (desktop app)',
    description:
      'Desktop build only — 404 on the server build. The body is Send to editor’s: `{ kind: "locator", text, at? }`, the locator a test of a run the desktop shell started picked (its pause bar’s Pick a locator, or a pick on an image of its stop), with the file and 1-based line of the call it was picked for. The desktop app’s window shows it, to copy. 400 for another body, 503 while the desktop runs’ hub does not listen.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const answer = answerRunPick(await desktopRuns(), await readBody(event).catch(() => null));
  if (answer.status !== 200) throw apiError({ statusCode: answer.status, message: messageOf(answer) });
  return { ok: true };
});
