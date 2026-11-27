import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleDB } from '#shared/handlers/db';
import { createUserRecord, deleteUserRecord, findUserByEmail } from '#shared/handlers/users';
import { isPlainLine } from '#shared/operator-notice';
import { InstanceRole } from '#shared/permissions';
import { USERNAME_MAX_LENGTH } from '#shared/project-access';
import type { ErrorCode } from '#shared/utils/error-codes';
import { accountTokens, users } from '../database/schema';
import { mintAccountToken } from './account-tokens';

/**
 * An administrator invited by whoever runs the instance (`POST /api/operator/admin-invite`), for an address the
 * account's owner confirmed: the account is made without a password, and the one-time link goes to that address only,
 * never to the operator. Every other administrator is told by email, the Users page marks the account and a banner
 * names it to administrators until the invitation is taken (a password set, or a sign-in provider linked) or ends.
 */

export const adminInviteSchema = z
  .object({
    email: z.string().trim().max(254).email(),
    name: z.string().trim().min(1).max(200).refine(isPlainLine, { message: 'one line of plain text' }).optional(),
  })
  .strict();

/** Why an invitation was refused: a status and a code the operator's client can act on. */
export class AdminInviteRefused extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorCode: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The username an invited address gets: its part before the `@`, reduced to letters, digits, `.`, `_` and `-`. */
export function usernameBase(email: string): string {
  const local = email.split('@')[0] ?? '';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, USERNAME_MAX_LENGTH - 8);
  if (base.length >= 3) return base;
  return base ? `${base}-admin` : 'admin';
}

async function freeUsername(db: DrizzleDB, base: string): Promise<string> {
  for (let attempt = 1; attempt <= 100; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate));
    if (!taken) return candidate;
  }
  throw new AdminInviteRefused(409, 'USERNAME_TAKEN', 'No free username was found for that address');
}

export type AdminInviteMail = {
  /** Sends the one-time link to the invited address. */
  sendInvite(to: string, token: string, username: string): Promise<void>;
  /** Tells another administrator who was invited. */
  tellAdministrator(to: string, invited: string): Promise<void>;
};

/**
 * Makes the administrator and sends their link; the account is removed again when the link cannot be sent. Answers when
 * the link ends. The other administrators are told after, and a message that fails is only logged.
 */
export async function inviteAdministrator(
  db: DrizzleDB,
  input: z.infer<typeof adminInviteSchema>,
  mail: AdminInviteMail,
): Promise<{ expiresAt: Date }> {
  if (await findUserByEmail(db, input.email)) {
    throw new AdminInviteRefused(409, 'EMAIL_TAKEN', 'An account already holds that address');
  }
  const username = await freeUsername(db, usernameBase(input.email));
  const created = await createUserRecord(db, {
    username,
    password: '',
    role: InstanceRole.ADMINISTRATOR,
    name: input.name,
    email: input.email,
  });
  if (!created) throw new Error('Failed to create the invited administrator');
  const token = await mintAccountToken(db, created.id, 'invite', input.email, { issuedBy: 'operator' });
  try {
    await mail.sendInvite(input.email, token, username);
  } catch (error) {
    await deleteUserRecord(db, created.id);
    console.error('[operator/admin-invite] The invitation could not be sent:', (error as Error).message);
    throw new AdminInviteRefused(502, 'INVITE_NOT_SENT', 'The invitation email could not be sent: nothing was kept');
  }
  const [row] = await db
    .select({ expiresAt: accountTokens.expiresAt })
    .from(accountTokens)
    .where(and(eq(accountTokens.userId, created.id), eq(accountTokens.purpose, 'invite')));

  const administrators = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.role, InstanceRole.ADMINISTRATOR), ne(users.id, created.id)))
    .orderBy(asc(users.id));
  const results = await Promise.allSettled(
    administrators.flatMap(({ email }) => (email ? [mail.tellAdministrator(email, input.email)] : [])),
  );
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) console.error(`[operator/admin-invite] ${failed} administrator(s) could not be told by email`);
  return { expiresAt: row!.expiresAt };
}
