// Desktop-only: the window's commands to the runs the desktop shell starts,
// each naming the stream it comes from (`viewer`): the hub's own commands,
// checked field by field as the hub checks Piwi Picker's, and `show`, which says
// the window shows a run live, so a failure no pause bar shows is held in it.
// Responds 404 on the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import type { HubAnswer } from '@piwitests/core/run-hub';
import { answerRunCommand, messageOf } from '@piwitests/editor/shell-runs-routes';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Steer the desktop app’s runs from its window (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body: one of the hub’s commands (`runControl`, `pausedPage`, `view`, `watch` (with the `layers` of the lane the window takes beside its frames: `calls`, `events`, `text`, `filmstrip`), `input`, `pick-at`, `assert-region`, `front`, `requests`, `mock`, `share`, `hold`, `stop`, `drive`, `openTrace` (a lane’s running test’s trace so far in Playwright’s trace viewer, on this machine: the answer never names the file), `follow`, `subscribe`, with an `id`), or `{ type: "show", id, ref, on }`, with `viewer`, the id the stream’s `hello` gave. Answers as the hub answers a command: `{ type: "answer", id, ok, message }`, with `image`, `requests` or `locator` for the commands that carry one. 404 for a stream that is not open; 400 for a body that is no command.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const answer = await answerRunCommand(await desktopRuns(), await readBody(event).catch(() => null));
  if (answer.status !== 200) throw apiError({ statusCode: answer.status, message: messageOf(answer) });
  return answer.body as HubAnswer;
});
