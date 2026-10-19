import { eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { users } from '../../database/schema';
import { requireAuth, hashPassword, verifyPassword, revokeUserSessions, setUserSession } from '../../utils/auth';
import { z } from 'zod';

defineRouteMeta({
  openAPI: {
    tags: ['Auth'],
    summary: 'Change password',
    description: 'Allows an authenticated user to change their own password by verifying their current password first.',
    'x-required-permission': 'signed-in',
  },
});

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export default eventHandler(async (event) => {
  const currentUser = await requireAuth(event);

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

  const valid = await verifyPassword(currentPassword, user.password);
  if (!valid) {
    throw apiError({ statusCode: 400, message: 'Current password is incorrect' });
  }

  const hashed = await hashPassword(newPassword);
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
