import { randomBytes } from 'node:crypto';
import { eq, and, exists, gt, inArray, isNull } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { accountTokens, users } from '../database/schema';
import { hashToken } from './token-hash';

export type TokenPurpose = 'reset' | 'verify' | 'invite';

const TTL_MS: Record<TokenPurpose, number> = {
  reset: 60 * 60 * 1000, // 1 hour
  verify: 24 * 60 * 60 * 1000, // 24 hours
  invite: 72 * 60 * 60 * 1000, // 72 hours
};

/**
 * Mint a new single-use token for a user, to email to `email`. Returns the
 * plaintext token. The token acts only while the account still holds `email`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mintAccountToken(
  db: LibSQLDatabase<any>,
  userId: number,
  purpose: TokenPurpose,
  email: string,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TTL_MS[purpose]);

  // Invalidate any unused tokens of the same purpose for this user
  await db.delete(accountTokens).where(and(eq(accountTokens.userId, userId), eq(accountTokens.purpose, purpose)));

  await db.insert(accountTokens).values({ userId, purpose, tokenHash, email, expiresAt });
  return token;
}

export interface ValidatedToken {
  userId: number;
  purpose: TokenPurpose;
  tokenId: number;
  /** The address the token was sent to, which the account still holds. */
  email: string;
}

/**
 * Validate a token. Returns the validated token info, or null when it is
 * unknown, expired or used, or when the account no longer holds the address
 * it was sent to.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function validateAccountToken(
  db: LibSQLDatabase<any>,
  token: string,
  purpose: TokenPurpose,
): Promise<ValidatedToken | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select({
      id: accountTokens.id,
      userId: accountTokens.userId,
      purpose: accountTokens.purpose,
      usedAt: accountTokens.usedAt,
      email: accountTokens.email,
      accountEmail: users.email,
    })
    .from(accountTokens)
    .innerJoin(users, eq(users.id, accountTokens.userId))
    .where(
      and(eq(accountTokens.tokenHash, tokenHash), eq(accountTokens.purpose, purpose), gt(accountTokens.expiresAt, now)),
    );

  if (!row || row.usedAt || !row.email || row.email !== row.accountEmail) return null;

  return { userId: row.userId, purpose: row.purpose as TokenPurpose, tokenId: row.id, email: row.email };
}

/**
 * Validate a token of one of `purposes` and mark it used, in one conditional
 * statement: of several requests holding the same token, only one gets it.
 * Returns null when the token is unknown, expired or used, or when the account
 * no longer holds the address it was sent to, which leaves the token unused.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function claimAccountToken(
  db: LibSQLDatabase<any>,
  token: string,
  purposes: TokenPurpose[],
): Promise<ValidatedToken | null> {
  const now = new Date();
  const [row] = await db
    .update(accountTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(accountTokens.tokenHash, hashToken(token)),
        inArray(accountTokens.purpose, purposes),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, now),
        exists(
          db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, accountTokens.userId), eq(users.email, accountTokens.email))),
        ),
      ),
    )
    .returning({
      id: accountTokens.id,
      userId: accountTokens.userId,
      purpose: accountTokens.purpose,
      email: accountTokens.email,
    });

  if (!row?.email) return null;

  return { userId: row.userId, purpose: row.purpose as TokenPurpose, tokenId: row.id, email: row.email };
}

/** Give back a token `claimAccountToken` took, for a request that failed before it set anything. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function releaseAccountToken(db: LibSQLDatabase<any>, tokenId: number): Promise<void> {
  await db.update(accountTokens).set({ usedAt: null }).where(eq(accountTokens.id, tokenId));
}

/** Mark a token as used (single-use enforcement). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function consumeAccountToken(db: LibSQLDatabase<any>, tokenId: number): Promise<void> {
  await db.update(accountTokens).set({ usedAt: new Date() }).where(eq(accountTokens.id, tokenId));
}
