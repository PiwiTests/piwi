/**
 * Values from the wire as the database can store them, on PostgreSQL as on SQLite: PostgreSQL's text and jsonb
 * refuse a NUL character, its `integer` holds 32 bits, and a btree index entry holds at most 2,704 bytes. A run
 * case passes through `storableRunCase` before anything of it is stored, so one such value never fails the batch it
 * came in. Shared by `persistRunCases`, the demo's ingest and the lookups that match a stored test.
 */
import { resolveBrowserName } from '#shared/browser-name';
import { sha256Hex } from '#shared/utils/hash';
import { joinSuitePath } from '#shared/utils/suites';

/** The largest value a 32-bit integer column (PostgreSQL's `integer`) holds. */
export const MAX_INT32 = 2_147_483_647;

/** A number as a 32-bit integer column stores it: rounded and held within the column's range; null for anything else. */
export function int32(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), -MAX_INT32 - 1), MAX_INT32);
}

/** A number as a 64-bit integer column (a time in epoch milliseconds) stores it: rounded; null for anything else. */
export function int64(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), Number.MIN_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
}

/**
 * `value` without the NUL characters of its strings and of its keys, at any depth. A value that holds none comes back
 * as it is.
 */
export function withoutNul<T>(value: T): T {
  if (typeof value === 'string') return (value.includes('\0') ? value.replaceAll('\0', '') : value) as T;
  if (Array.isArray(value)) {
    const kept = value.map(withoutNul);
    return (kept.some((item, index) => item !== value[index]) ? kept : value) as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const kept = entries.map(([key, item]) => [withoutNul(key), withoutNul(item)] as const);
    const changed = kept.some(([key, item], index) => key !== entries[index]![0] || item !== entries[index]![1]);
    return (changed ? Object.fromEntries(kept) : value) as T;
  }
  return value;
}

/**
 * The longest identity string stored whole, in UTF-8 bytes. A test's file, describe path and title share one index
 * entry, and the three together stay under the 2,704 bytes PostgreSQL holds in one.
 */
export const MAX_IDENTITY_BYTES = 800;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** The longest head of `value` that holds in `maxBytes` UTF-8 bytes, or null when the whole value does. */
function headWithin(value: string, maxBytes: number): string | null {
  let bytes = 0;
  let head = 0;
  for (const char of value) {
    bytes += utf8Length(char.codePointAt(0)!);
    if (bytes > maxBytes) return value.slice(0, head);
    head += char.length;
  }
  return null;
}

/** Hex digits of the whole value's SHA-256 that end a shortened identity, after `…` (3 bytes in UTF-8). */
const IDENTITY_HASH_CHARS = 16;

/**
 * An identity string as it is stored: a test's file, describe path or title, a Playwright project's name. NUL
 * characters are dropped, and a value longer than `MAX_IDENTITY_BYTES` keeps its head, followed by `…` and the
 * SHA-256 of the whole value, so two long identities stay apart and one is stored alike on every run.
 */
export async function storedIdentity(value: string): Promise<string> {
  if (typeof value !== 'string') return value;
  const text = withoutNul(value);
  if (headWithin(text, MAX_IDENTITY_BYTES) === null) return text;
  const head = headWithin(text, MAX_IDENTITY_BYTES - 3 - IDENTITY_HASH_CHARS)!;
  return `${head}…${(await sha256Hex(text)).slice(0, IDENTITY_HASH_CHARS)}`;
}

/**
 * A test's describe path as it is stored: each title without NUL characters and, when the whole path is longer than
 * `MAX_IDENTITY_BYTES`, one level holding the path as `storedIdentity` keeps it.
 */
export async function storableSuitePath(path: string[] | null | undefined): Promise<string[] | null> {
  if (!path?.length) return path ?? null;
  const titles = withoutNul(path);
  const joined = joinSuitePath(titles);
  const stored = await storedIdentity(joined);
  return stored === joined ? titles : [stored];
}

/** The fields of a run case that identify its test. */
interface CaseIdentity {
  filePath: string;
  title: string;
  suitePath?: string[] | null;
  browser?: unknown;
}

/**
 * A run case as it is stored: no NUL character anywhere in it, and its file, title, describe path and Playwright
 * project held to what an index entry takes (`storedIdentity`).
 */
export async function storableRunCase<T extends CaseIdentity>(input: T): Promise<T> {
  const c = withoutNul(input);
  const projectName = resolveBrowserName(c.browser);
  const storedProject = projectName === null ? null : await storedIdentity(projectName);
  return {
    ...c,
    filePath: await storedIdentity(c.filePath),
    title: await storedIdentity(c.title),
    suitePath: await storableSuitePath(c.suitePath),
    browser:
      storedProject === projectName
        ? c.browser
        : typeof c.browser === 'string'
          ? storedProject
          : { ...(c.browser as Record<string, unknown>), projectName: storedProject },
  };
}
