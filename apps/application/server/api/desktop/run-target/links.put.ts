import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { isBrowserRequest } from '../../../utils/desktop-access';
import { linksOf, useLinks } from '../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: the linked folders (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ links }`: the folders linked on this machine for the connected instance’s projects (project id to folder), which the checks of each request read and the instance hears as the projects this app has a folder for.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event)) throw apiError({ statusCode: 403, message: 'The desktop shell alone calls this route' });
  setResponseHeader(event, 'cache-control', 'no-store');
  const body = ((await readBody(event).catch(() => null)) ?? {}) as { links?: unknown };
  const links = linksOf(body.links);
  if (!links) throw apiError({ statusCode: 400, message: 'Invalid links' });
  useLinks(links);
  return { ok: true };
});
