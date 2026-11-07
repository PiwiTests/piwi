import { requireAuth } from '../../../../../utils/auth';
import { apiError } from '../../../../../utils/api-error';
import { answerRunRequest, isRequestId } from '../../../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: answer a run request (desktop app)',
    description:
      'Desktop build only — 404 on the server build. The person’s answer in the window to a request the app claimed: `{ decision: "run" }` after **Run** (refused, 409, while a check fails), or `{ decision: "not-now" }`, which declines it, or refuses it with the checks that failed. Answers `{ launch }`: true after **Run**, when the window asks the shell to start the run (`desktop_run_requested_tests`), which takes the request token from the server itself. 404 for a request no longer asked about.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const id = getRouterParam(event, 'id');
  if (!isRequestId(id)) throw apiError({ statusCode: 400, message: 'Invalid request id' });
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { decision?: unknown };
  if (body.decision !== 'run' && body.decision !== 'not-now') {
    throw apiError({ statusCode: 400, message: 'The decision is run or not-now' });
  }
  const answered = await answerRunRequest(id, body.decision);
  if (!answered.ok) throw apiError({ statusCode: answered.statusCode, message: answered.message });
  return { launch: answered.launch };
});
