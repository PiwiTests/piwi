import { z } from 'zod';
import { getDatabase } from '../../../database';
import { isAuthEnabled, requireAuth } from '../../../utils/auth';
import { decideDeviceConnect, CONNECT_RATE_LIMITS } from '../../../utils/extension-connect';
import { limitLookupMisses, rateLimitClientIp } from '../../../utils/rate-limit';

defineRouteMeta({
  openAPI: {
    tags: ['Extension'],
    summary: 'Allow or deny a browser-extension connect request',
    description:
      'Body: `{ userCode, allow }`. Allowing lets the extension that started the request receive an API key for the signed-in user, with their role and project access; the key is named after the browser and listed with their other keys. Answers the new `status`. 404 for an unknown code, 409 when the request was already decided, 410 when it expired.',
    'x-required-permission': 'signed-in',
  },
});

const bodySchema = z.object({ userCode: z.string().min(1).max(20), allow: z.boolean() });

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const missKey = `extension-connect:miss:${user.id}:${rateLimitClientIp(event)}`;
  const parsed = bodySchema.safeParse(await readBody(event));
  if (!parsed.success) throw apiError({ statusCode: 400, message: 'Invalid request body', data: parsed.error.issues });

  const db = await getDatabase();
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
      }),
    (outcome) => outcome === 'not-found',
  );
  if (result === 'not-found') throw apiError({ statusCode: 404, message: 'No connect request has this code' });
  if (result === 'already-decided') throw apiError({ statusCode: 409, message: 'This request was already answered' });
  if (result === 'expired') throw apiError({ statusCode: 410, message: 'This request has expired' });
  return { status: result };
});
