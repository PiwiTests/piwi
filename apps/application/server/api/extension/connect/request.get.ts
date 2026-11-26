import { getDatabase } from '../../../database';
import { getRequestAccess, isAuthEnabled, requireAuth } from '../../../utils/auth';
import { describeConnectRequest, CONNECT_RATE_LIMITS, targetAbilitiesOf } from '../../../utils/extension-connect';
import { limitLookupMisses, rateLimitClientIp } from '../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Extension'],
    summary: 'Describe a browser-extension connect request',
    description:
      'What the page at `/extension/connect` shows before the user allows or denies: the connecting client, the code, the expiry, the status (`pending`, `approved`, `denied`, `consumed` or `expired`), and, for a run target, what it will do for the signed-in user here: `receives` their run requests (Run on my machine on, and theirs to use), `compares` a test with a project’s CI (the desktop app, where they read a project and the instance does not decline it). Query: `code`, the user code. Failed lookups are rate-limited.',
    parameters: [{ name: 'code', in: 'query', required: true, schema: { type: 'string' } }],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const missKey = `extension-connect:miss:${user.id}:${rateLimitClientIp(event)}`;
  const db = await getDatabase();
  const view = await limitLookupMisses(
    event,
    missKey,
    CONNECT_RATE_LIMITS.lookupMiss,
    async () =>
      describeConnectRequest(
        db,
        getQuery(event).code,
        new Date(),
        await targetAbilitiesOf(db, await getRequestAccess(event), isAuthEnabled()),
      ),
    (found) => !found,
  );
  if (!view) throw apiError({ statusCode: 404, message: 'No connect request has this code' });
  return view;
});
