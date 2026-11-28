import { and, asc, eq, isNull } from 'drizzle-orm';
import { accountTokens, users } from '../../server/database/schema';
import { InstanceRole } from '../permissions';
import type { DrizzleDB } from './db';

/** An administrator invitation whoever runs the instance sent, that nobody took yet. */
export type OperatorInvitation = { userId: number; email: string; invitedAt: Date; expiresAt: Date };

/**
 * The invitations the operator sent that nobody took yet: the link unused and still for the account's address, and the
 * account still an administrator without a password or a sign-in provider. Ended ones too: the Users page says so,
 * the banner leaves them out.
 */
export async function pendingOperatorInvitations(db: DrizzleDB): Promise<OperatorInvitation[]> {
  const rows = await db
    .select({
      userId: accountTokens.userId,
      email: accountTokens.email,
      invitedAt: accountTokens.createdAt,
      expiresAt: accountTokens.expiresAt,
    })
    .from(accountTokens)
    .innerJoin(users, eq(users.id, accountTokens.userId))
    .where(
      and(
        eq(accountTokens.purpose, 'invite'),
        eq(accountTokens.issuedBy, 'operator'),
        isNull(accountTokens.usedAt),
        eq(accountTokens.email, users.email),
        eq(users.role, InstanceRole.ADMINISTRATOR),
        eq(users.password, ''),
        isNull(users.oauthProvider),
      ),
    )
    .orderBy(asc(accountTokens.createdAt));
  return rows.flatMap((row) => (row.email ? [{ ...row, email: row.email }] : []));
}

/** The invitations the banner names to a viewer: none to anyone but an administrator, and none that has ended. */
export async function invitationsShownTo(
  db: DrizzleDB,
  viewer: { administrator: boolean; now: Date },
): Promise<{ userId: number; email: string; expiresAt: string }[]> {
  if (!viewer.administrator) return [];
  return (await pendingOperatorInvitations(db))
    .filter((invitation) => invitation.expiresAt > viewer.now)
    .map(({ userId, email, expiresAt }) => ({ userId, email, expiresAt: expiresAt.toISOString() }));
}
