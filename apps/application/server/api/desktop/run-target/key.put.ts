import { requireAuth } from '../../../utils/auth';
import { apiError } from '../../../utils/api-error';
import { isBrowserRequest } from '../../../utils/desktop-access';
import { instanceUrlOf, linksOf, useKeptKey } from '../../../utils/desktop-run-target';
defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Run on my machine: use the kept key (desktop shell)',
    description:
      'Desktop build only — 404 on the server build. For the shell alone: refused (403) to a request a browser sends. Body `{ instance, key, links }`: the instance and the key the shell keeps in the OS keychain, and the folders linked on this machine (`links`, project id of the instance to folder). The server takes run requests from that instance with that key until the shell disconnects it or the instance revokes it. Sent after each start of the server and once the shell kept a new key.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  if (isBrowserRequest(event)) throw apiError({ statusCode: 403, message: 'The desktop shell alone calls this route' });
  setResponseHeader(event, 'cache-control', 'no-store');
  const body = ((await readBody(event).catch(() => null)) ?? {}) as {
    instance?: unknown;
    key?: unknown;
    links?: unknown;
  };
  const instance = instanceUrlOf(body.instance);
  const links = linksOf(body.links ?? {});
  if (!instance || typeof body.key !== 'string' || !/^pd_[0-9a-f]{16,128}$/.test(body.key) || !links) {
    throw apiError({ statusCode: 400, message: 'Invalid instance, key or links' });
  }
  useKeptKey(instance, body.key, links);
  return { ok: true };
});
