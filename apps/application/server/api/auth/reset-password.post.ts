import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { users } from '../../database/schema';
import { claimAccountToken, releaseAccountToken } from '../../utils/account-tokens';
import { hashPassword, revokeUserSessions } from '../../utils/auth';
import { clearUserSession } from '../../utils/auth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError, releaseRateLimit } from '../../utils/rate-limit';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Reset password using token',
    description:
      'Validates a single-use reset/invite token, sets the new password, and invalidates existing sessions. A token sent to an address the account no longer holds is refused (400).',
    security: [],
  },
});

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export default eventHandler(async (event) => {
  const rateKey = `reset:${rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, 10, 15 * 60 * 1000)) {
    throw rateLimitedError(event, [rateKey]);
  }

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Token and password (min 8 chars) are required' });
  }

  const { token, password } = parsed.data;
  const db = await getDatabase();

  // A reset or an invite token, used up before the slow hashing: a second request with it finds it used.
  const validated = await claimAccountToken(db, token, ['reset', 'invite']);
  if (!validated) {
    throw apiError({ statusCode: 400, message: 'Invalid or expired token' });
  }

  // A hash refused or failed (the server busy, 503) sets nothing: the token stays usable, and the request gives
  // back its rate-limit slot.
  const hashedPassword = await hashPassword(event, password).catch(async (error: unknown) => {
    releaseRateLimit(rateKey);
    await releaseAccountToken(db, validated.tokenId);
    throw error;
  });
  const extraFields = validated.purpose === 'invite' ? { emailVerified: true } : {};
  // The write matches the address again: one changed since the validation sets nothing.
  const updated = await db
    .update(users)
    .set({ password: hashedPassword, updatedAt: new Date(), ...extraFields })
    .where(and(eq(users.id, validated.userId), eq(users.email, validated.email)))
    .returning({ id: users.id });
  if (!updated.length) throw apiError({ statusCode: 400, message: 'Invalid or expired token' });

  // Revoke every existing session for this account so a stolen session cannot
  // outlive the reset, then clear the current cookie for good measure.
  await revokeUserSessions(validated.userId);
  await clearUserSession(event).catch(() => {});

  console.info('[auth/reset-password] Password reset for user %d', validated.userId);
  return { success: true };
});
