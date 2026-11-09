import { z } from 'zod';
import { getDatabase } from '../../../database';
import { getRequestAccess, isAuthEnabled, requireSessionAuth } from '../../../utils/auth';
import { holdsAnywhere } from '#shared/permissions';
import { getInstanceDecisions } from '#shared/handlers/setup-status';
import { decideDeviceConnect, CONNECT_RATE_LIMITS } from '../../../utils/extension-connect';
import { limitLookupMisses, rateLimitClientIp } from '../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Extension'],
    summary: 'Allow or deny a browser-extension connect request',
    description:
      'Body: `{ userCode, allow }`. Allowing lets the extension that started the request receive an API key for the signed-in user, with their role and project access; the key is named after the browser and listed with their other keys. A run target (the desktop app, Piwi Runner) gets a key that holds `run:receive` alone, and is allowed only when the user holds `run:receive` on some project and an administrator turned **Run on my machine** on (403 otherwise). Answers the new `status`. 404 for an unknown code, 409 when the request was already decided, 410 when it expired. Takes a signed-in session: a request with an API key is refused (403).',
    'x-required-permission': 'signed-in',
  },
});

const bodySchema = z.object({ userCode: z.string().min(1).max(20), allow: z.boolean() });

export default eventHandler(async (event) => {
  const user = await requireSessionAuth(event);
  const missKey = `extension-connect:miss:${user.id}:${rateLimitClientIp(event)}`;
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });

  const db = await getDatabase();
  const mayConnectTarget =
    isAuthEnabled(event) &&
    holdsAnywhere(await getRequestAccess(event), 'run:receive') &&
    (await getInstanceDecisions(db))['machine-runs'] === 'enabled';
  const result = await limitLookupMisses(
    event,
    missKey,
    CONNECT_RATE_LIMITS.lookupMiss,
    () =>
      decideDeviceConnect(db, {
        userCode: parsed.data.userCode,
        // With authentication off there is no account to own a key.
        userId: isAuthEnabled(event) ? user.id : null,
        allow: parsed.data.allow,
        mayConnectTarget,
      }),
    (outcome) => outcome === 'not-found',
  );
  if (result === 'not-found') throw apiError({ statusCode: 404, message: 'No connect request has this code' });
  if (result === 'already-decided') throw apiError({ statusCode: 409, message: 'This request was already answered' });
  if (result === 'expired') throw apiError({ statusCode: 410, message: 'This request has expired' });
  if (result === 'target-not-allowed') {
    throw apiError({
      statusCode: 403,
      message:
        'Connecting an app that runs tests needs Run on my machine turned on and the right to run tests on your machine',
    });
  }
  return { status: result };
});
