import {
  users,
  apiKeys,
  oauthGrants,
  scenarioGaps,
  testRuns,
  roleBindings,
  groupMembers,
} from '../../server/database/schema';
import { eq, and, ne, sql } from 'drizzle-orm';

import { deleteAssistantConversationsOf } from './assistant';
import type { DrizzleDB } from './db';

export async function listUsers(db: DrizzleDB) {
  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      oauthProvider: users.oauthProvider,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users);
  return { users: allUsers };
}

/**
 * The account, other than `exceptUserId`, whose email is `email` ignoring
 * letter case. `idx_users_email` (on `lower(email)`) keeps one account per
 * address, so at most one matches.
 */
export async function findUserByEmail(db: DrizzleDB, email: string, exceptUserId?: number) {
  const [owner] = await db
    .select()
    .from(users)
    .where(
      and(
        sql`lower(${users.email}) = lower(${email})`,
        exceptUserId === undefined ? undefined : ne(users.id, exceptUserId),
      ),
    )
    .limit(1);
  return owner;
}

export async function createUserRecord(
  db: DrizzleDB,
  data: { username: string; password: string; role: string; name?: string; email?: string | null },
) {
  const existing = await db.select().from(users).where(eq(users.username, data.username));
  if (existing.length > 0) throw new Error('Username already exists');
  if (data.email && (await findUserByEmail(db, data.email))) throw new Error('Email already in use');
  const [created] = await db
    .insert(users)
    .values({
      username: data.username,
      password: data.password,
      role: data.role,
      name: data.name ?? null,
      email: data.email ?? null,
      avatarUrl: null,
      oauthProvider: null,
      oauthProviderId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return created ?? null;
}

export async function deleteUserRecord(db: DrizzleDB, id: number) {
  const userResults = await db.select().from(users).where(eq(users.id, id));
  if (!userResults[0]) throw new Error('User not found');
  await db.delete(apiKeys).where(eq(apiKeys.userId, id));
  // A kept run outlives the user who kept it. The SQLite `kept_by` column has no
  // ON DELETE action, so the reference is cleared before the user row goes.
  await db.update(testRuns).set({ keptBy: null }).where(eq(testRuns.keptBy, id));
  // `scenario_gaps.triaged_by` was added by ALTER TABLE, which cannot carry the
  // schema's ON DELETE SET NULL on SQLite — clear it by hand or the delete
  // fails the FK check.
  await db.update(scenarioGaps).set({ triagedBy: null }).where(eq(scenarioGaps.triagedBy, id));
  // Deleted explicitly rather than through the foreign keys' cascade, which the demo's database does not enforce.
  await db.delete(roleBindings).where(eq(roleBindings.userId, id));
  await db.delete(groupMembers).where(eq(groupMembers.userId, id));
  // A user's assistant conversations are theirs alone, so they go with them.
  await deleteAssistantConversationsOf(db, id);
  await db.delete(users).where(eq(users.id, id));
  return { success: true };
}

export async function listUserApiKeys(db: DrizzleDB, userId: number) {
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      oauthGrantId: oauthGrants.id,
    })
    .from(apiKeys)
    .leftJoin(oauthGrants, eq(oauthGrants.apiKeyId, apiKeys.id))
    .where(eq(apiKeys.userId, userId));
  // A key that belongs to an OAuth grant is an MCP client's connection: its own value was never shown.
  return { apiKeys: keys.map(({ oauthGrantId, ...key }) => ({ ...key, oauth: oauthGrantId != null })) };
}

export async function createUserApiKeyRecord(
  db: DrizzleDB,
  userId: number,
  data: { name: string; hash: string; prefix: string; expiresAt?: Date | null },
) {
  await db.insert(apiKeys).values({
    userId,
    name: data.name,
    keyHash: data.hash,
    keyPrefix: data.prefix,
    expiresAt: data.expiresAt ?? null,
  });
  return { success: true };
}

export async function updateUserRecord(
  db: DrizzleDB,
  id: number,
  data: { name?: string | null; email?: string | null; role?: string },
) {
  const userResults = await db.select().from(users).where(eq(users.id, id));
  if (!userResults[0]) throw new Error('User not found');
  const emailChanged = data.email !== undefined && data.email !== userResults[0].email;
  if (emailChanged && data.email && (await findUserByEmail(db, data.email, id))) {
    throw new Error('Email already in use');
  }
  // A new address has not been proven yet: drop the verified flag so it is not
  // carried over from the old one (the personal email channel and OAuth
  // linking read it).
  await db
    .update(users)
    .set({ ...data, ...(emailChanged ? { emailVerified: false } : {}), updatedAt: new Date() })
    .where(eq(users.id, id));
  const updated = await db.select().from(users).where(eq(users.id, id));
  return updated[0] ?? null;
}

export async function deleteUserApiKeyRecord(db: DrizzleDB, userId: number, keyId: number) {
  const keyResults = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)));
  if (!keyResults[0]) throw new Error('API key not found');
  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return { success: true };
}
