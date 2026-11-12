// Desktop-only: the window's answer to a run an agent asked it to start
// (`agent-run` on the desktop event stream): the ref the shell gave the run,
// or why the window did not start it. Responds 404 on the normal server build.
import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { answerAgentRun } from '../../../utils/desktop-agent-runs';
import { desktopAgentRunAnswerOf } from '#shared/desktop-agent-runs';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'The window started a run an agent asked for (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Body: `{ id, ref }`, the id of the `agent-run` the desktop event stream sent and the name the shell gave the run it started (`desktop-<id>`, ending in `-unattended` for a run nobody attends), or `{ id, error }`, why the window did not start it. The agent’s `run_start` answers with it. 400 for another body, 404 for a run no longer waiting for its answer.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const answer = desktopAgentRunAnswerOf(await readBody(event).catch(() => null));
  if (!answer) throw apiError({ statusCode: 400, message: 'The body is no answer to an agent’s run' });
  if (!answerAgentRun(answer)) throw apiError({ statusCode: 404, message: 'No agent’s run waits for this answer' });
  return { ok: true };
});
