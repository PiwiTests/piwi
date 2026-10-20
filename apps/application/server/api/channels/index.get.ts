import { eq, or, isNull } from 'drizzle-orm';
import { getDatabase } from '../../database';
import { notificationChannels, users } from '../../database/schema';
import { getRequestAccess, requireAuth } from '../../utils/auth';
import { channelConfigFor } from '../../utils/channels';
import { canEncryptSecrets } from '../../utils/crypto';
import { isAdministrator } from '#shared/permissions';

defineRouteMeta({
  openAPI: {
    tags: ['Notifications'],
    summary: 'List notification channels',
    description:
      'Returns channels owned by the current user and global (admin-managed) channels. Auto-creates a personal email channel if the user has an account email set. A webhook `url` shows in full to the channel owner and to administrators; anyone else reads its origin. With authentication disabled every channel is global. `canStoreSecrets` is false when `PIWI_SECRET_KEY` is unset, in which case a webhook channel cannot store a signing secret.',
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  const isAdmin = isAdministrator(await getRequestAccess(event));
  const db = await getDatabase();

  // Fetch live user record for email / emailVerified (session may be stale)
  const [dbUser] = await db
    .select({ email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, user.id));

  const rows = await db
    .select()
    .from(notificationChannels)
    .where(or(isNull(notificationChannels.userId), eq(notificationChannels.userId, user.id)));

  // Auto-create a personal_email channel for users who have an account email but no channel yet
  if (dbUser?.email) {
    const hasPersonal = rows.some((c) => c.type === 'personal_email' && c.userId === user.id);
    if (!hasPersonal) {
      const [created] = await db
        .insert(notificationChannels)
        .values({
          name: 'Account email',
          type: 'personal_email',
          config: {},
          userId: user.id,
          verified: Boolean(dbUser.emailVerified),
        })
        .returning();
      if (created) rows.push(created);
    }
  }

  return {
    canStoreSecrets: canEncryptSecrets(),
    items: rows.map((c) => {
      // For the user's own personal_email channel: always reflect live account state
      const isOwnPersonal = c.type === 'personal_email' && c.userId === user.id;
      const config = isOwnPersonal
        ? { address: dbUser?.email ?? '' }
        : channelConfigFor((c.config ?? {}) as Record<string, unknown>, { ownsChannel: c.userId === user.id, isAdmin });
      const verified = isOwnPersonal ? Boolean(dbUser?.emailVerified) : Boolean(c.verified);

      return {
        id: c.id,
        name: c.name,
        type: c.type,
        userId: c.userId,
        verified,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        config,
      };
    }),
  };
});
