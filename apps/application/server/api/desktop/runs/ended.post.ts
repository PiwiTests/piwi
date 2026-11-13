// Desktop-only: the window that started a run of the shell says its process
// ended (`{ ref, exitCode }`), so an agent's run whose workers never connected
// ends too, its follower hearing it. Responds 404 on the normal server build.
import { answerRunEnded, messageOf } from '@piwitests/editor/shell-runs-routes';
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'A run the shell started ended (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body: `{ ref, exitCode }`, the name the desktop shell gave a Playwright run it started (`desktop-<id>`, `PIWI_RUN_REF`, with or without its `-unattended` mark) and the exit code of its process (null when it has none). The window that started the run says it once the process ended: a run an agent started (`run_start` on `/mcp`) whose workers never connected ends with it, its follower hearing it, and no longer counts among the runs agents started. 400 for another ref or exit code, 503 while the desktop runs’ hub does not listen.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const answer = answerRunEnded(await desktopRuns(), await readBody(event).catch(() => null));
  if (answer.status !== 200) throw apiError({ statusCode: answer.status, message: messageOf(answer) });
  return { ok: true };
});
