import { eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { users } from '../../database/schema';
import { requireSessionAuth, hashPassword, verifyPassword, revokeUserSessions, setUserSession } from '../../utils/auth';
import { rateLimitClientIp, releaseRateLimit, takeRateLimitSlots } from '../../utils/rate-limit';
import { z } from 'zod';

const WINDOW_MS = 15 * 60 * 1000;

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Change password',
    description:
      'Allows a signed-in user to change their own password by verifying their current password first. Takes a signed-in session: a request with an API key is refused (403). Wrong current passwords are limited to 5 per account and 20 per client address in 15 minutes (429 with `Retry-After`).',
    'x-required-permission': 'signed-in',
  },
});

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export default eventHandler(async (event) => {
  const currentUser = await requireSessionAuth(event);

  const body = await readBody(event);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'currentPassword and newPassword (min 8 chars) are required' });
  }

  const { currentPassword, newPassword } = parsed.data;

  const db = await getDatabase();
  const userRows = await db.select().from(users).where(eq(users.id, currentUser.id));
  const user = userRows[0];

  if (!user || !user.password) {
    throw apiError({ statusCode: 400, message: 'Cannot change password for OAuth-only accounts' });
  }

  // Throttle wrong current passwords, per source and per account. Every attempt
  // takes its slots before the password is checked and holds them until its new
  // password is hashed, so one account never has more than its limit of checks
  // running or waiting. Only a wrong current password keeps its slots.
  const taken = takeRateLimitSlots(
    event,
    [
      [`change-password:ip:${rateLimitClientIp(event)}`, 20],
      [`change-password:user:${currentUser.id}`, 5],
    ],
    WINDOW_MS,
    'Too many failed attempts. Please wait before trying again.',
  );
  const giveBack = () => {
    for (const slot of taken) releaseRateLimit(slot);
  };

  const valid = await verifyPassword(event, currentPassword, user.password).catch((error: unknown) => {
    giveBack();
    throw error;
  });
  if (!valid) {
    throw apiError({ statusCode: 400, message: 'Current password is incorrect' });
  }

  const hashed = await hashPassword(event, newPassword).finally(giveBack);
  await db.update(users).set({ password: hashed, updatedAt: new Date() }).where(eq(users.id, user.id));

  // Revoke every existing session, then re-issue one for the current device so
  // the password change signs out other devices without signing out this one.
  const epoch = await revokeUserSessions(user.id);
  await setUserSession(event, {
    userId: user.id,
    sessionEpoch: epoch,
  });

  console.info('[auth/change-password] Password changed for user %d', user.id);
  return { success: true };
});
