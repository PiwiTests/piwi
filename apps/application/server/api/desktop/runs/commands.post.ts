// Desktop-only: the window's commands to the runs the desktop shell starts,
// each naming the stream it comes from (`viewer`): the hub's own commands,
// checked field by field as the hub checks Piwi Picker's, and `show`, which says
// the window shows a run live, so a failure no pause bar shows is held in it.
// Responds 404 on the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Steer the desktop app’s runs from its window (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body: one of the hub’s commands (`runControl`, `pausedPage`, `view`, `input`, `pick-at`, `assert-region`, `requests`, `mock`, `follow`, `subscribe`, with an `id`), or `{ type: "show", id, ref, on }`, with `viewer`, the id the stream’s `hello` gave. Answers as the hub answers a command: `{ type: "answer", id, ok, message }`, with `image`, `requests` or `locator` for the commands that carry one. 404 for a stream that is not open; 400 for a body that is no command.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const runs = await desktopRuns();
  if (!runs) throw apiError({ statusCode: 503, message: 'The desktop runs’ hub is not listening' });
  const body = await readBody(event).catch(() => null);
  const answer = await runs.command(body);
  if (!answer) throw apiError({ statusCode: 404, message: 'The run stream is not open' });
  if (answer.id === 0) throw apiError({ statusCode: 400, message: answer.message });
  return answer;
});
