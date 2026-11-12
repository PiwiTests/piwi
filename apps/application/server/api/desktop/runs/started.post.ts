// Desktop-only: the shell says what it started a run with (`{ ref, args }`),
// so the runs' hub names the run's command to Piwi Picker and to agents, as an
// editor names the command of a run it started. For the shell alone: a request
// a browser sends is refused. Responds 404 on the normal server build.
import { answerRunStarted, messageOf } from '@piwitests/editor/shell-runs-routes';
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { hostRequestOf } from '../../../utils/desktop-access';
import { desktopRuns } from '../../../utils/desktop-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'What the shell started a run with (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body: `{ ref, args }`, the name the desktop shell gave a Playwright run it started (`desktop-<id>`, `PIWI_RUN_REF`, ending in `-unattended` for a run nobody attends) and the arguments it runs `playwright test` with. The runs’ hub names the run’s command (`npx playwright test …`) on its sessions, which Piwi Picker reads, and in the agents’ `run_list`. Refused (403) to a request a browser sends (one carrying `Origin` or `Sec-Fetch-Site`): the shell alone says it. 400 for another ref or arguments that are no list of words, 503 while the desktop runs’ hub does not listen.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const answer = answerRunStarted(
    await desktopRuns(),
    { headers: hostRequestOf(event).headers },
    await readBody(event).catch(() => null),
  );
  if (answer.status !== 200) throw apiError({ statusCode: answer.status, message: messageOf(answer) });
  return { ok: true };
});
