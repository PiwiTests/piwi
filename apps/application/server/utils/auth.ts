import type { H3Event } from 'h3';
import { apiError } from './api-error';
import { useSession, updateSession, clearSession as h3ClearSession } from 'h3';
import { getDatabase } from '../database';
import { users, apiKeys, appSettings } from '../database/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { User } from '../database/schema';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ADMIN_ACCESS,
  InstanceRole,
  passesEarlyCheck,
  routePermissionList,
  type AccessSummary,
  type RoutePermission,
} from '#shared/permissions';
import type { DrizzleDB } from '#shared/handlers/db';
import { getUserAccess } from '#shared/handlers/role-bindings';
import { getRouteRequiredPermissions } from './route-required-permission';
import { hashToken } from './token-hash';

declare module 'h3' {
  interface H3EventContext {
    /** The signed-in user's access, loaded once per request by `requireAuth` (`getRequestAccess` reads it). */
    access?: AccessSummary;
  }
}

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** The scrypt cost of a password hash: N = 2^log2N, block size r, parallelization p. */
interface ScryptCost {
  log2N: number;
  r: number;
  p: number;
}

/** The cost new password hashes use. */
const SCRYPT_COST: ScryptCost = { log2N: 17, r: 8, p: 1 };
/** The cost of a hash in the `salt:key` form, which carries no parameters: Node's scrypt defaults. */
const UNENCODED_SCRYPT_COST: ScryptCost = { log2N: 14, r: 8, p: 1 };
const SCRYPT_KEY_LENGTH = 64;

interface PasswordHash extends ScryptCost {
  salt: string;
  key: Buffer;
}

const HEX = /^[0-9a-f]+$/;

/**
 * Read a stored password hash: `scrypt$<log2N>$<r>$<p>$<salt>$<key>`, or the
 * `<salt>:<key>` form hashed at {@link UNENCODED_SCRYPT_COST}. Null for anything
 * else, including a cost outside the bounds a sign-in may spend.
 */
function parsePasswordHash(hash: string): PasswordHash | null {
  const parts = hash.split('$');
  let cost: ScryptCost;
  let salt: string | undefined;
  let key: string | undefined;
  if (parts.length === 6 && parts[0] === 'scrypt') {
    cost = { log2N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
    [salt, key] = [parts[4], parts[5]];
  } else {
    const pair = hash.split(':');
    if (pair.length !== 2) return null;
    cost = UNENCODED_SCRYPT_COST;
    [salt, key] = pair;
  }
  const { log2N, r, p } = cost;
  const inBounds = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!inBounds(log2N, 10, 20) || !inBounds(r, 1, 32) || !inBounds(p, 1, 16)) return null;
  if (!salt || !key || key.length % 2 !== 0 || !HEX.test(key) || !inBounds(key.length / 2, 16, 128)) return null;
  return { ...cost, salt, key: Buffer.from(key, 'hex') };
}

/** scrypt's derived key of `password` at `cost`, with the memory bound the cost needs. */
function deriveKey(password: string, salt: string, cost: ScryptCost, keyLength: number): Promise<Buffer> {
  const N = 2 ** cost.log2N;
  return scryptAsync(password, salt, keyLength, { N, r: cost.r, p: cost.p, maxmem: 256 * N * cost.r });
}

/** Hash a password with scrypt at {@link SCRYPT_COST}, the cost encoded in the result. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, SCRYPT_COST, SCRYPT_KEY_LENGTH);
  const { log2N, r, p } = SCRYPT_COST;
  return `scrypt$${log2N}$${r}$${p}$${salt}$${key.toString('hex')}`;
}

/** Whether `password` matches `hash`, in either stored form. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const key = await deriveKey(password, parsed.salt, parsed, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash is in another form or at another cost than {@link hashPassword} writes. */
export function passwordNeedsRehash(hash: string): boolean {
  const parsed = parsePasswordHash(hash);
  return (
    !hash.startsWith('scrypt$') ||
    !parsed ||
    parsed.log2N !== SCRYPT_COST.log2N ||
    parsed.r !== SCRYPT_COST.r ||
    parsed.p !== SCRYPT_COST.p
  );
}

// Session management using encrypted cookies
export interface SessionData {
  userId: number;
  username: string;
  role: InstanceRole;
  // The user's session epoch at sign-in. A later bump (password/role change,
  // unlink) makes this stale, which invalidates the session server-side.
  sessionEpoch?: number;
}

// The key h3 uses to seal/unseal the session cookie. `PIWI_AUTH_SECRET` from the
// runtime environment wins over the build-time-baked config value, so the
// prebuilt image honors a secret supplied at run time (see isAuthEnabled).
function getSessionPassword(config: ReturnType<typeof useRuntimeConfig>): string {
  return process.env.PIWI_AUTH_SECRET || config.authSecret;
}

const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days

/**
 * Name of the sealed session cookie. It names Piwi, not the framework (h3's
 * default is `h3`), and is part of the public contract documented in the
 * OpenAPI `sessionCookie` scheme in nuxt.config.ts.
 */
export const SESSION_COOKIE_NAME = 'piwi_session';

/**
 * Config for the sealed session cookie, shared by every session operation so its
 * attributes stay consistent (including on clear).
 *
 * `httpOnly` and `secure` keep the cookie out of reach of page scripts and off
 * plaintext connections. `sameSite: 'lax'` withholds the cookie from cross-site
 * subrequests — a CSRF defense for the cookie-authenticated API — while still
 * sending it on top-level navigations, which OAuth callbacks and ordinary links
 * into the dashboard depend on. Every attribute is set here, so neither the
 * browser's nor h3's defaults apply.
 */
function sessionOptions(config: ReturnType<typeof useRuntimeConfig>) {
  return {
    name: SESSION_COOKIE_NAME,
    password: getSessionPassword(config),
    maxAge: SESSION_MAX_AGE_SEC,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax' as const,
      path: '/',
    },
  };
}

// Get session from cookie
export async function getUserSession(event: H3Event): Promise<SessionData | null> {
  const config = useRuntimeConfig(event);
  if (!isAuthEnabled(event)) {
    return null;
  }

  try {
    const session = await useSession<SessionData>(event, sessionOptions(config));

    if (!session.data || !session.data.userId) {
      return null;
    }

    return session.data;
  } catch {
    // Invalid or expired session
    return null;
  }
}

// Set session in cookie
export async function setUserSession(event: H3Event, sessionData: SessionData): Promise<void> {
  const config = useRuntimeConfig(event);
  await updateSession<SessionData>(event, sessionOptions(config), sessionData);
}

// Clear session cookie
export async function clearUserSession(event: H3Event): Promise<void> {
  const config = useRuntimeConfig(event);
  await h3ClearSession(event, sessionOptions(config));
}

// Get current user from session
export async function getCurrentUser(event: H3Event): Promise<User | null> {
  const session = await getUserSession(event);
  if (!session) {
    return null;
  }

  const db = await getDatabase();
  const userResults = await db.select().from(users).where(eq(users.id, session.userId));
  const user = userResults[0];
  if (!user) {
    return null;
  }

  // A session minted before the user's epoch was last bumped is revoked.
  if ((session.sessionEpoch ?? 0) !== (user.sessionEpoch ?? 0)) {
    return null;
  }

  return user;
}

/**
 * Revoke every existing session for a user by advancing their session epoch.
 * Sessions carry the epoch they were minted with; `getCurrentUser` rejects any
 * whose epoch no longer matches. Returns the new epoch so the caller can
 * immediately re-issue the current device a valid session if desired.
 */
export async function revokeUserSessions(userId: number): Promise<number> {
  const db = await getDatabase();
  const rows = await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionEpoch: users.sessionEpoch });
  return rows[0]?.sessionEpoch ?? 0;
}

// A syntactically-valid scrypt hash at the current cost, used only to spend the
// same verification work for a nonexistent or password-less account as for a
// real one. Its value is irrelevant — the comparison always fails; it exists
// solely so login response timing can't be used to tell whether a username exists.
const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_COST.log2N}$${SCRYPT_COST.r}$${SCRYPT_COST.p}$${'0'.repeat(32)}$${'0'.repeat(128)}`;

// Verify user credentials and return user
export async function verifyUser(username: string, password: string): Promise<User | null> {
  const db = await getDatabase();
  const userResults = await db.select().from(users).where(eq(users.username, username));
  const user = userResults[0];

  // Equalize response time whether or not the account exists and has a
  // password: a missing or OAuth-only (password-less) account still spends one
  // scrypt verification against a dummy hash, so login timing can't be used to
  // enumerate which usernames are registered.
  if (!user || !user.password) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return null;
  }

  const valid = await verifyPassword(password, user.password);
  if (!valid) {
    return null;
  }

  if (passwordNeedsRehash(user.password)) {
    // Rewrite the hash at the current cost, unless the password changed meanwhile.
    const rehashed = await hashPassword(password);
    await db
      .update(users)
      .set({ password: rehashed })
      .where(and(eq(users.id, user.id), eq(users.password, user.password)));
  }

  return user;
}

// Create a new user
/**
 * Whether no administrator exists, so first-admin setup (`POST /api/auth/setup`)
 * is open: on a new instance, and on one whose only accounts are members (the
 * first OAuth sign-ins create members).
 */
export async function needsInitialSetup(): Promise<boolean> {
  const db = await getDatabase();
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, InstanceRole.ADMINISTRATOR))
    .limit(1);
  return admin.length === 0;
}

/** Whether an account already uses `username`. */
export async function usernameTaken(username: string): Promise<boolean> {
  const db = await getDatabase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  return existing.length > 0;
}

export async function createUser(username: string, password: string, role: InstanceRole, name?: string): Promise<User> {
  const db = await getDatabase();
  const hashedPassword = await hashPassword(password);

  const result = await db
    .insert(users)
    .values({
      username,
      password: hashedPassword,
      role,
      name: name || null,
    })
    .returning();

  const user = result[0];
  if (!user) {
    throw new Error('Failed to create user');
  }

  return user;
}

/** Whether `PIWI_SETUP_TOKEN` is set, so first-admin setup asks for it. */
export function setupTokenRequired(): boolean {
  return Boolean(process.env.PIWI_SETUP_TOKEN?.trim());
}

/** Whether `given` is the setup token (always true when none is set), compared in constant time. */
export function setupTokenMatches(given: unknown): boolean {
  const expected = process.env.PIWI_SETUP_TOKEN?.trim();
  if (!expected) return true;
  if (typeof given !== 'string') return false;
  return timingSafeEqual(Buffer.from(hashToken(given.trim()), 'hex'), Buffer.from(hashToken(expected), 'hex'));
}

/** The setup record: `claimed` while a setup creates the administrator, anything else once one did. */
const INITIAL_SETUP_KEY = 'initial_setup_completed';
const SETUP_CLAIMED = 'claimed';

/**
 * Atomically claim first-admin setup, returning true for exactly one caller.
 *
 * `needsInitialSetup` (a SELECT) and `createUser` (a later INSERT) are separate
 * statements, so two concurrent `POST /api/auth/setup` requests could both see
 * no administrator and each create one. The first claim inserts the setup
 * record with `INSERT ... ON CONFLICT DO NOTHING`, which SQLite and PostgreSQL
 * resolve atomically, so the other callers conflict and get false. A record
 * left by an earlier, finished setup (its administrator since gone) is taken
 * over by one caller, with an UPDATE that only changes a record not claimed
 * yet. Callers gate on `needsInitialSetup()` first, so a finished setup is only
 * taken over while no administrator exists.
 */
export async function claimInitialSetup(db?: DrizzleDB): Promise<boolean> {
  const database = db ?? (await getDatabase());
  const now = new Date();
  const inserted = await database
    .insert(appSettings)
    .values({ key: INITIAL_SETUP_KEY, value: SETUP_CLAIMED, updatedAt: now })
    .onConflictDoNothing({ target: appSettings.key })
    .returning({ key: appSettings.key });
  if (inserted.length > 0) return true;

  const taken = await database
    .update(appSettings)
    .set({ value: SETUP_CLAIMED, updatedAt: now })
    .where(and(eq(appSettings.key, INITIAL_SETUP_KEY), ne(appSettings.value, SETUP_CLAIMED)))
    .returning({ key: appSettings.key });
  return taken.length > 0;
}

/** Record that the claimed setup created its administrator. */
export async function completeInitialSetup(db?: DrizzleDB): Promise<void> {
  const database = db ?? (await getDatabase());
  await database
    .update(appSettings)
    .set({ value: true, updatedAt: new Date() })
    .where(eq(appSettings.key, INITIAL_SETUP_KEY));
}

/**
 * Release a claim made by `claimInitialSetup` so setup can be retried. Only the
 * claim winner calls this, and only when admin creation failed after the claim —
 * the losing callers were already rejected, so there is no window for a second
 * admin to slip through.
 */
export async function releaseInitialSetup(db?: DrizzleDB): Promise<void> {
  const database = db ?? (await getDatabase());
  await database.delete(appSettings).where(eq(appSettings.key, INITIAL_SETUP_KEY));
}

// Check if authentication is enabled.
//
// `PIWI_AUTH_ENABLED` is read from the runtime environment first: on the
// prebuilt image the config value is baked at build time (when the variable is
// unset), so the env check is what lets an operator turn auth on at run time.
// The baked `config.authEnabled` remains the fallback for source builds and for
// the `NUXT_AUTH_ENABLED` runtime override.
export function isAuthEnabled(event?: H3Event): boolean {
  if (process.env.PIWI_AUTH_ENABLED === 'true') {
    return true;
  }
  const config = event ? useRuntimeConfig(event) : useRuntimeConfig();
  return String(config.authEnabled) === 'true';
}

// ---------------------------------------------------------------------------
// API key helpers
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = 'pd_';
const API_KEY_BYTES = 32; // 256 bits of entropy → 64-char hex string

/**
 * Generate a new API key.
 * Returns the plaintext key (shown ONCE to the user) and the data to persist.
 */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const raw = randomBytes(API_KEY_BYTES).toString('hex');
  const plaintext = `${API_KEY_PREFIX}${raw}`;
  const prefix = raw.slice(0, 8);
  return { plaintext, hash: hashToken(plaintext), prefix };
}

/**
 * Look up a user by a plaintext API key value.
 * Updates `last_used_at` on a successful match.
 * Returns null if the key does not exist, is expired, or belongs to no user.
 */
export async function getUserByApiKey(plaintext: string): Promise<User | null> {
  return (await resolveApiKey(plaintext))?.user ?? null;
}

/**
 * Look up the user and the key id of a plaintext API key value, under the same
 * rules as {@link getUserByApiKey}.
 */
export async function resolveApiKey(plaintext: string): Promise<{ user: User; keyId: number } | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const hash = hashToken(plaintext);
  const db = await getDatabase();

  const keyResults = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  const key = keyResults[0];

  if (!key) {
    return null;
  }

  // Check expiry
  if (key.expiresAt && key.expiresAt < new Date()) {
    return null;
  }

  // Update last used at most once per hour to avoid excessive write load
  const ONE_HOUR_MS = 60 * 60 * 1000;
  if (!key.lastUsedAt || new Date().getTime() - key.lastUsedAt.getTime() > ONE_HOUR_MS) {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  }

  const userResults = await db.select().from(users).where(eq(users.id, key.userId));
  return userResults[0] ? { user: userResults[0], keyId: key.id } : null;
}

/** The value of an `Authorization: Bearer` header, whatever kind of token it is; null without one. */
export function bearerToken(event: H3Event): string | null {
  return getRequestHeader(event, 'authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

/**
 * Extract the Bearer token from the Authorization header, or the value of the
 * X-API-Key header.  Returns null if neither is present or if the value does
 * not start with the API key prefix.
 */
export function extractApiKey(event: H3Event): string | null {
  const bearer = bearerToken(event);
  if (bearer?.startsWith(API_KEY_PREFIX)) {
    return bearer;
  }

  const xApiKey = getRequestHeader(event, 'x-api-key');
  if (xApiKey?.startsWith(API_KEY_PREFIX)) {
    return xApiKey;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** The user every request acts as when authentication is off: an administrator. */
function virtualAdministrator(): User {
  return {
    id: 0,
    username: 'system',
    password: '',
    role: InstanceRole.ADMINISTRATOR,
    name: 'System',
    avatarUrl: null,
    oauthProvider: null,
    oauthProviderId: null,
    email: null,
    emailVerified: false,
    sessionEpoch: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const accessByUser = new WeakMap<User, Promise<AccessSummary>>();

/**
 * A user's access (instance role and role bindings, own and through groups),
 * loaded once per `User` object: `requireAuth` followed by
 * `getProjectScope(db, user)` reads the bindings once.
 */
export function getUserAccessCached(db: DrizzleDB, user: User): Promise<AccessSummary> {
  let access = accessByUser.get(user);
  if (!access) {
    access = getUserAccess(db, user);
    accessByUser.set(user, access);
    access.catch(() => accessByUser.delete(user));
  }
  return access;
}

/**
 * What the current request must hold, any one being enough: `override` when
 * given, else the route's `x-required-permission` meta. Empty means sign-in only.
 */
export function requiredPermissionsFor(
  event: H3Event,
  override?: RoutePermission | RoutePermission[],
): RoutePermission[] {
  return override === undefined ? getRouteRequiredPermissions(event) : routePermissionList(override);
}

/**
 * Identify the caller (API key first, then session cookie), load their access
 * into `event.context.access`, and refuse with 403 unless they pass the early
 * check of the permissions the route declares in `x-required-permission`. The
 * route meta is the single source of truth, also shown in /docs; `permission`
 * overrides it for the rare handler computing its own authorization. A project
 * permission is held on some project at this point; the handler checks it on
 * the project it acts on (`requireProjectAccess`).
 */
export async function requireAuth(event: H3Event, permission?: RoutePermission | RoutePermission[]): Promise<User> {
  if (!isAuthEnabled(event)) {
    event.context.access = ADMIN_ACCESS;
    return virtualAdministrator();
  }

  const required = requiredPermissionsFor(event, permission);
  let user: User;

  // 1. Try API key authentication (preferred for CI/reporter usage)
  const apiKeyValue = extractApiKey(event);
  if (apiKeyValue) {
    const resolved = await resolveApiKey(apiKeyValue);
    if (!resolved) {
      throw apiError({
        statusCode: 401,
        message: 'Invalid or expired API key',
      });
    }
    user = resolved.user;
    // The key a request was made with, for the records that name who acted (the agents' write log).
    event.context.apiKeyId = resolved.keyId;
  } else {
    // 2. Fall back to session cookie
    const sessionUser = await getCurrentUser(event);
    if (!sessionUser) {
      throw apiError({
        statusCode: 401,
        message: 'Authentication required',
      });
    }
    user = sessionUser;
  }

  const access = await getUserAccessCached(await getDatabase(), user);
  event.context.access = access;
  if (!passesEarlyCheck(access, required)) {
    throw apiError({
      statusCode: 403,
      message: 'Insufficient permissions',
    });
  }

  return user;
}

/** The signed-in user as `GET /api/auth/me` and `POST /api/auth/login` return them (`AuthUser`). */
export async function authUserView(db: DrizzleDB, user: User) {
  const access = await getUserAccessCached(db, user);
  return {
    id: user.id,
    username: user.username,
    role: access.instanceRole,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
    emailVerified: user.emailVerified,
    oauthProvider: user.oauthProvider,
    hasPassword: Boolean(user.password),
    access,
  };
}

/**
 * The current request's access: the one `requireAuth` loaded, else loaded now
 * (401 when nobody is signed in). Every permission with authentication off.
 */
export async function getRequestAccess(event: H3Event): Promise<AccessSummary> {
  if (!isAuthEnabled(event)) return ADMIN_ACCESS;
  if (event.context.access) return event.context.access;
  const user = await requireAuth(event, []);
  return getUserAccessCached(await getDatabase(), user);
}
