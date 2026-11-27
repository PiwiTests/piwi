import { and, asc, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleDB } from '#shared/handlers/db';
import { deleteUserRecord, findUserByEmail } from '#shared/handlers/users';
import { isPlainLine } from '#shared/operator-notice';
import { InstanceRole } from '#shared/permissions';
import { USERNAME_MAX_LENGTH } from '#shared/project-access';
import type { ErrorCode } from '#shared/utils/error-codes';
import { getDialect } from '../database';
import { accountTokens, users } from '../database/schema';
import { newAccountToken } from './account-tokens';

/**
 * An administrator invited by whoever runs the instance (`POST /api/operator/admin-invite`), for an address the
 * operator was given: the account is made without a password, and the one-time link goes to that address only, never
 * to the operator. Every other administrator who can sign in is told by email, the Users page marks the account and a
 * banner names it to administrators until the invitation is taken (a password set) or ends. The same address invited
 * again, while its invitation is still the operator's and untaken, gets a new link.
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

const emailTaken = () => new AdminInviteRefused(409, 'EMAIL_TAKEN', 'An account already holds that address');

/** The username an invited address gets: its part before the `@`, reduced to letters, digits, `.`, `_` and `-`. */
export function usernameBase(email: string): string {
  const local = email.split('@')[0] ?? '';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, USERNAME_MAX_LENGTH - 8)
    .replace(/^[-.]+|[-.]+$/g, '');
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

/** Whether the account is an administrator the operator invited that nobody took yet: its link unused, ended or not. */
async function isOperatorInvitee(db: DrizzleDB, user: { id: number; email: string | null }): Promise<boolean> {
  const [row] = await db
    .select({ id: accountTokens.id })
    .from(accountTokens)
    .innerJoin(users, eq(users.id, accountTokens.userId))
    .where(
      and(
        eq(accountTokens.userId, user.id),
        eq(accountTokens.purpose, 'invite'),
        eq(accountTokens.issuedBy, 'operator'),
        isNull(accountTokens.usedAt),
        eq(accountTokens.email, users.email),
        eq(users.role, InstanceRole.ADMINISTRATOR),
        eq(users.password, ''),
        isNull(users.oauthProvider),
      ),
    );
  return Boolean(row);
}

export type AdminInviteMail = {
  /** Sends the one-time link to the invited address. */
  sendInvite(to: string, token: string, username: string): Promise<void>;
  /** Tells another administrator who was invited. */
  tellAdministrator(to: string, invited: string): Promise<void>;
};

/** Makes the account and its link in one transaction, trying another username when a concurrent invitation took it. */
async function createInvitee(
  db: DrizzleDB,
  input: z.infer<typeof adminInviteSchema>,
  link: { tokenHash: string; expiresAt: Date },
): Promise<{ userId: number; username: string }> {
  const base = usernameBase(input.email);
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = await freeUsername(db, base);
    try {
      const userId = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({
            username,
            password: '',
            role: InstanceRole.ADMINISTRATOR,
            name: input.name ?? null,
            email: input.email,
          })
          .returning({ id: users.id });
        await tx.insert(accountTokens).values({
          userId: created!.id,
          purpose: 'invite',
          tokenHash: link.tokenHash,
          email: input.email,
          expiresAt: link.expiresAt,
          issuedBy: 'operator',
        });
        return created!.id;
      });
      return { userId, username };
    } catch (error) {
      // A concurrent invitation took the address, or the username: the first ends here, the second tries another.
      if (await findUserByEmail(db, input.email)) throw emailTaken();
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
      if (!taken) throw error;
    }
  }
  throw new AdminInviteRefused(409, 'USERNAME_TAKEN', 'No free username was found for that address');
}

/**
 * Removes the account an invitation made once its link could not be sent, unless another invitation of the address
 * gave the account a link of its own meanwhile: that link went out, and the account is its. On PostgreSQL the
 * account's row is locked first, which waits for such an invitation to commit, so the check reads what it wrote.
 * Answers whether the account was removed.
 */
async function removeUnsentInvitee(db: DrizzleDB, userId: number, tokenHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (getDialect() === 'postgres') {
      // The client is typed as SQLite's; on PostgreSQL its transaction runs raw SQL with `execute`.
      await (tx as unknown as { execute(query: SQL): Promise<unknown> }).execute(
        sql`SELECT ${users.id} FROM ${users} WHERE ${users.id} = ${userId} FOR UPDATE`,
      );
    }
    const [own] = await tx
      .select({ id: accountTokens.id })
      .from(accountTokens)
      .where(and(eq(accountTokens.userId, userId), eq(accountTokens.tokenHash, tokenHash)));
    if (!own) return false;
    await deleteUserRecord(tx as unknown as DrizzleDB, userId);
    return true;
  });
}

/**
 * Makes the administrator, or gives a still-untaken operator invitation a new link, and sends it; a new account is
 * removed again when its link cannot be sent. Answers when the link ends. The other administrators are told after,
 * and a message that fails is only logged.
 */
export async function inviteAdministrator(
  db: DrizzleDB,
  input: z.infer<typeof adminInviteSchema>,
  mail: AdminInviteMail,
): Promise<{ expiresAt: Date }> {
  const link = newAccountToken('invite');
  const existing = await findUserByEmail(db, input.email);
  let invitee: { userId: number; username: string; email: string };
  if (existing) {
    if (!existing.email || !(await isOperatorInvitee(db, existing))) throw emailTaken();
    const email = existing.email;
    await db.transaction(async (tx) => {
      await tx
        .delete(accountTokens)
        .where(and(eq(accountTokens.userId, existing.id), eq(accountTokens.purpose, 'invite')));
      await tx.insert(accountTokens).values({
        userId: existing.id,
        purpose: 'invite',
        tokenHash: link.tokenHash,
        email,
        expiresAt: link.expiresAt,
        issuedBy: 'operator',
      });
    });
    invitee = { userId: existing.id, username: existing.username, email };
  } else {
    invitee = { ...(await createInvitee(db, input, link)), email: input.email };
  }

  try {
    await mail.sendInvite(invitee.email, link.token, invitee.username);
  } catch (error) {
    console.error('[operator/admin-invite] The invitation could not be sent:', (error as Error).message);
    const removed =
      !existing &&
      (await removeUnsentInvitee(db, invitee.userId, link.tokenHash).catch((cleanup: unknown) => {
        console.error(
          '[operator/admin-invite] The unsent invitation could not be removed:',
          (cleanup as Error).message,
        );
        return false;
      }));
    throw new AdminInviteRefused(
      502,
      'INVITE_NOT_SENT',
      removed
        ? 'The invitation email could not be sent: nothing was kept'
        : 'The invitation email could not be sent: invite the address again',
    );
  }

  // Told: the administrators who can sign in, never another invitee who has not.
  const administrators = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.role, InstanceRole.ADMINISTRATOR),
        ne(users.id, invitee.userId),
        isNotNull(users.email),
        or(ne(users.password, ''), isNotNull(users.oauthProvider)),
      ),
    )
    .orderBy(asc(users.id));
  const results = await Promise.allSettled(
    administrators.map(({ email }) => mail.tellAdministrator(email!, invitee.email)),
  );
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed) console.error(`[operator/admin-invite] ${failed} administrator(s) could not be told by email`);
  return { expiresAt: link.expiresAt };
}
