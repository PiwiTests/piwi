import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { apiKeys, extensionDeviceCodes, runTargets, users, type ExtensionDeviceCode } from '../database/schema';
import type { DbClient } from '../database';
import { generateApiKey } from './auth';
import { hashToken } from './token-hash';
import { cleanClientLabel } from './client-label';

/**
 * Connecting the browser extension, the VS Code extension and JetBrains
 * plugin, or a run target (the desktop app, Piwi Runner): an RFC 8628 device
 * authorization grant. The client starts a
 * request, the user allows it on a signed-in page of this instance, and the
 * client's next poll receives an API key created
 * for that user at that moment. Both codes are stored hashed; the key's
 * plaintext is never stored.
 */

export const DEVICE_CODE_PREFIX = 'pdc_';
const DEVICE_CODE_RE = /^pdc_[0-9a-f]{64}$/;

/** How long a request waits for a decision and its collection. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** Seconds the extension waits between polls; `slow_down` adds {@link SLOW_DOWN_STEP_SECONDS}. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const SLOW_DOWN_STEP_SECONDS = 5;
/** Expired rows older than this are deleted on the next start. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Twenty consonants with no look-alikes: a user code cannot spell a word or be misread. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

/** Per client address and window: request starts, token polls, and failed code lookups on the verification page. */
export const CONNECT_RATE_LIMITS = {
  start: { limit: 10, windowMs: 10 * 60 * 1000 },
  token: { limit: 120, windowMs: 10 * 60 * 1000 },
  lookupMiss: { limit: 20, windowMs: 10 * 60 * 1000 },
} as const;

export type DeviceCodeStatus = 'pending' | 'approved' | 'denied' | 'consumed';

/** A new user code, `ABCD-EFGH`. */
export function generateUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A typed or linked user code in its stored form (eight letters, upper case,
 * no separator), or null when it cannot be one.
 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const letters = input.toUpperCase().replace(/[\s-]/g, '');
  if (letters.length !== USER_CODE_LENGTH) return null;
  for (const ch of letters) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return letters;
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** One word of the client description, at most 40 characters. */
const clientWord = (value: unknown, fallback: string) => cleanClientLabel(value, fallback, 40);

const EDITOR_CLIENT_PREFIX = 'Piwi in ';

/** What connects: Piwi Picker, an editor's extension, or a run target. */
export type ConnectClientKind = 'picker' | 'editor' | 'desktop' | 'runner';

/** The clients that take run requests: their key holds `run:receive` alone. */
export const RUN_TARGET_KINDS: ReadonlySet<ConnectClientKind> = new Set(['desktop', 'runner']);

/** The only permissions the key of a run target holds. */
export const RUN_TARGET_KEY_PERMISSIONS = ['run:receive'] as const;

export interface ConnectClient {
  browser?: unknown;
  editor?: unknown;
  /** `desktop` or `runner`: a run target, named by its `device`. */
  target?: unknown;
  device?: unknown;
  os?: unknown;
}

/** Which kind of client a start body describes. */
export function connectClientKindOf(client: ConnectClient): ConnectClientKind {
  if (client.target === 'desktop' || client.target === 'runner') return client.target;
  return client.editor !== undefined && client.editor !== null ? 'editor' : 'picker';
}

/**
 * "Piwi Picker in Chrome on Windows", "Piwi in WebStorm on macOS" when an
 * editor connects, or "Piwi Desktop on LAPTOP-42 (macOS)" for a run target:
 * the name the verification page shows and the created key carries.
 */
export function extensionClientName(client: ConnectClient): string {
  const os = clientWord(client.os, '');
  const kind = connectClientKindOf(client);
  if (RUN_TARGET_KINDS.has(kind)) {
    const app = kind === 'desktop' ? 'Piwi Desktop' : 'Piwi Runner';
    return `${app} on ${clientWord(client.device, 'a computer')}${os ? ` (${os})` : ''}`;
  }
  const on = os ? ` on ${os}` : '';
  if (kind === 'editor') return `${EDITOR_CLIENT_PREFIX}${clientWord(client.editor, 'an editor')}${on}`;
  return `Piwi Picker in ${clientWord(client.browser, 'a browser')}${on}`;
}

/** Whether a request comes from Piwi Picker or from an editor, read from its name, for a row with no stored kind. */
export function connectClientKind(clientName: string): 'picker' | 'editor' {
  return clientName.startsWith(EDITOR_CLIENT_PREFIX) ? 'editor' : 'picker';
}

function storedClientKind(row: Pick<ExtensionDeviceCode, 'clientKind' | 'clientName'>): ConnectClientKind {
  const kind = row.clientKind;
  return kind === 'picker' || kind === 'editor' || kind === 'desktop' || kind === 'runner'
    ? kind
    : connectClientKind(row.clientName);
}

export interface StartedConnect {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

/** Starts a connect request and deletes the ones expired for more than a day. */
export async function startDeviceConnect(
  db: DbClient,
  client: ConnectClient,
  now = new Date(),
): Promise<StartedConnect> {
  await db
    .delete(extensionDeviceCodes)
    .where(lt(extensionDeviceCodes.expiresAt, new Date(now.getTime() - PRUNE_AFTER_MS)));

  const deviceCode = `${DEVICE_CODE_PREFIX}${randomBytes(32).toString('hex')}`;
  // A clash on the unique user-code index is astronomically rare, but a retry costs nothing.
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await db.insert(extensionDeviceCodes).values({
        deviceCodeHash: hashToken(deviceCode),
        userCodeHash: hashToken(normalizeUserCode(userCode)!),
        clientName: extensionClientName(client),
        clientKind: connectClientKindOf(client),
        status: 'pending',
        intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
        expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_MS),
        createdAt: now,
      });
      return {
        deviceCode,
        userCode,
        expiresIn: Math.round(DEVICE_CODE_TTL_MS / 1000),
        interval: DEFAULT_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

async function findByUserCode(db: DbClient, userCode: unknown): Promise<ExtensionDeviceCode | null> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  const [row] = await db
    .select()
    .from(extensionDeviceCodes)
    .where(eq(extensionDeviceCodes.userCodeHash, hashToken(normalized)));
  return row ?? null;
}

export interface ConnectRequestView {
  userCode: string;
  clientName: string;
  /** Who asked: Piwi Picker, the Piwi extension of an editor, or a run target. */
  clientKind: ConnectClientKind;
  createdAt: string;
  expiresAt: string;
  /** `expired` once past its expiry without being collected; `consumed` once the extension received its key. */
  status: DeviceCodeStatus | 'expired';
}

/** What the verification page shows for a user code; null when no request has it. */
export async function describeConnectRequest(
  db: DbClient,
  userCode: unknown,
  now = new Date(),
): Promise<ConnectRequestView | null> {
  const row = await findByUserCode(db, userCode);
  if (!row) return null;
  const status = row.status as DeviceCodeStatus;
  const expired = row.expiresAt.getTime() <= now.getTime() && status !== 'consumed' && status !== 'denied';
  return {
    userCode: formatUserCode(normalizeUserCode(userCode)!),
    clientName: row.clientName,
    clientKind: storedClientKind(row),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: expired ? 'expired' : status,
  };
}

export type ConnectDecisionResult =
  | 'approved'
  | 'denied'
  | 'not-found'
  | 'expired'
  | 'already-decided'
  | 'target-not-allowed';

/**
 * Records the signed-in user's answer. `userId` is null when authentication is
 * off: the request is then allowed without an account, and the extension gets
 * an empty key. A run target is allowed only when `mayConnectTarget` (the user
 * holds `run:receive` and the instance turned run requests on), and never
 * without an account.
 */
export async function decideDeviceConnect(
  db: DbClient,
  opts: { userCode: unknown; userId: number | null; allow: boolean; mayConnectTarget?: boolean },
  now = new Date(),
): Promise<ConnectDecisionResult> {
  const row = await findByUserCode(db, opts.userCode);
  if (!row) return 'not-found';
  if (row.status !== 'pending') return 'already-decided';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (opts.allow && RUN_TARGET_KINDS.has(storedClientKind(row)) && (opts.userId == null || !opts.mayConnectTarget)) {
    return 'target-not-allowed';
  }
  const status = opts.allow ? 'approved' : 'denied';
  const updated = await db
    .update(extensionDeviceCodes)
    .set({ status, userId: opts.userId, decidedAt: now })
    .where(and(eq(extensionDeviceCodes.id, row.id), eq(extensionDeviceCodes.status, 'pending')))
    .returning({ id: extensionDeviceCodes.id });
  return updated.length === 0 ? 'already-decided' : status;
}

export type ConnectPollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; apiKey: string; user: { name: string } | null };

/**
 * The extension's poll. An approved request is consumed by the first poll
 * that sees it: the conditional update is what makes the key single-use, so
 * two concurrent polls never both receive one.
 */
export async function pollDeviceConnect(
  db: DbClient,
  deviceCode: unknown,
  now = new Date(),
): Promise<ConnectPollResult> {
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) return { status: 'expired' };
  const [row] = await db
    .select()
    .from(extensionDeviceCodes)
    .where(eq(extensionDeviceCodes.deviceCodeHash, hashToken(deviceCode)));
  if (!row || row.status === 'consumed') return { status: 'expired' };
  if (row.status === 'denied') return { status: 'denied' };
  if (row.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };

  if (row.status === 'pending') {
    // A second of grace absorbs timer jitter; a client polling faster than that is told to slow down.
    const early =
      row.lastPolledAt != null && now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1000 - 1000;
    const interval = early ? row.intervalSeconds + SLOW_DOWN_STEP_SECONDS : row.intervalSeconds;
    await db
      .update(extensionDeviceCodes)
      .set({ lastPolledAt: now, intervalSeconds: interval })
      .where(eq(extensionDeviceCodes.id, row.id));
    return early ? { status: 'slow_down', interval } : { status: 'pending' };
  }

  const claimed = await db
    .update(extensionDeviceCodes)
    .set({ status: 'consumed', lastPolledAt: now })
    .where(and(eq(extensionDeviceCodes.id, row.id), eq(extensionDeviceCodes.status, 'approved')))
    .returning({ id: extensionDeviceCodes.id });
  if (claimed.length === 0) return { status: 'expired' };

  const kind = storedClientKind(row);
  const target = RUN_TARGET_KINDS.has(kind);
  // A run target is never connected without an account to own its key.
  if (row.userId == null) return target ? { status: 'denied' } : { status: 'approved', apiKey: '', user: null };

  const [owner] = await db
    .select({ name: users.name, username: users.username })
    .from(users)
    .where(eq(users.id, row.userId));
  if (!owner) return { status: 'expired' };
  const { plaintext, hash, prefix } = generateApiKey();
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: row.userId,
      name: row.clientName,
      keyHash: hash,
      keyPrefix: prefix,
      clientKind: kind,
      permissions: target ? [...RUN_TARGET_KEY_PERMISSIONS] : null,
      createdAt: now,
    })
    .returning({ id: apiKeys.id });
  if (target) {
    await db.insert(runTargets).values({
      userId: row.userId,
      apiKeyId: key!.id,
      kind,
      deviceName: row.clientName,
      lastSeenAt: now,
      createdAt: now,
    });
  }
  await db.update(extensionDeviceCodes).set({ apiKeyId: key!.id }).where(eq(extensionDeviceCodes.id, row.id));
  return { status: 'approved', apiKey: plaintext, user: { name: owner.name || owner.username } };
}
