import { eq } from 'drizzle-orm';
import { users } from '../../database/schema';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = LibSQLDatabase<any>;

/** The fields of a channel row its email verification depends on. */
export interface EmailChannelRef {
  type: string;
  userId: number | null;
  verified?: boolean | null;
}

/**
 * Whether a channel may receive notification email: an `email` channel once a
 * test reached its address, a `personal_email` channel once its owner verified
 * their account email. Any other channel type sends no email and passes.
 */
export async function emailDestinationVerified(db: Db, channel: EmailChannelRef): Promise<boolean> {
  if (channel.type === 'email') return Boolean(channel.verified);
  if (channel.type !== 'personal_email') return true;
  if (channel.userId == null) return false;
  const [owner] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, channel.userId));
  return Boolean(owner?.emailVerified);
}
