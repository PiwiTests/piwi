/**
 * A person's own token for a per-user credential, as their routes reach it:
 * only from a signed-in session, never an API key, and only for a per-user
 * credential their Account page lists (shared with a project where they hold
 * `run:control`, or one they hold a token for). The token is tested before it
 * is saved, at most {@link USER_TOKEN_TEST_LIMIT} times per person and
 * credential in a window, and the test says only whether it was taken.
 */
import type { H3Event } from 'h3';
import { getDatabase, type DbClient } from '../database';
import { getRequestAccess, requireSessionAuth } from './auth';
import { checkRateLimit, rateLimitedError } from './rate-limit';
import { requireRouteId } from './project-access';
import { loadCredentialRecord, myCredential, type CredentialRecord } from '#shared/handlers/credentials';
import { USER_TOKEN_TEST_LIMIT, USER_TOKEN_TEST_WINDOW_MS, type MyCredentialEntry } from '#shared/credentials';
import type { AccessSummary } from '#shared/permissions';

/** The caller and the per-user credential a token route names. */
export interface UserTokenRoute {
  db: DbClient;
  viewer: { access: AccessSummary; userId: number };
  record: CredentialRecord;
  entry: MyCredentialEntry;
}

/**
 * The signed-in person and the per-user credential the route's `:id` names:
 * 400 without sign-in (the virtual administrator has no account to hold a
 * token), 404 for a credential that is not per-user or that their Account
 * page does not list.
 */
export async function requireUserTokenRoute(event: H3Event): Promise<UserTokenRoute> {
  const user = await requireSessionAuth(event);
  const id = requireRouteId(event, 'id', 'credential ID');
  // The virtual administrator of an instance without sign-in is id 0, no user row.
  if (!user.id) {
    throw apiError({ statusCode: 400, message: 'A per-user credential holds the tokens of signed-in people only.' });
  }
  const viewer = { access: await getRequestAccess(event), userId: user.id };
  const db = await getDatabase();
  const record = await loadCredentialRecord(db, id);
  const entry = record?.perUser ? await myCredential(db, viewer, id) : null;
  if (!record || !entry) throw apiError({ statusCode: 404, message: 'Credential not found' });
  return { db, viewer, record, entry };
}

/** Refuse a test past the limit for this person and credential (429). */
export function limitUserTokenTests(event: H3Event, userId: number, credentialId: number): void {
  const key = `user-token-test:${userId}:${credentialId}`;
  if (!checkRateLimit(key, USER_TOKEN_TEST_LIMIT, USER_TOKEN_TEST_WINDOW_MS)) {
    throw rateLimitedError(event, [key], 'Too many token tests: wait a few minutes before you test again.');
  }
}
