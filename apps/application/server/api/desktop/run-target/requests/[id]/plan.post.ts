import { requireAuth } from '../../../../../utils/auth';
import { apiError } from '../../../../../utils/api-error';
import { isRequestId, planAgain } from '../../../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: check a run request again (desktop app)',
    description:
      'Desktop build only — 404 on the server build. Runs the checks of a request the window asks about again, after the person linked its folder, and answers the request with its new checks and command. 404 for a request no longer asked about.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const id = getRouterParam(event, 'id');
  if (!isRequestId(id)) throw apiError({ statusCode: 400, message: 'Invalid request id' });
  const prompt = await planAgain(id);
  if (!prompt) throw apiError({ statusCode: 404, message: 'This request is no longer asked about' });
  return prompt;
});
