/**
 * Values from the wire as the database can store them, on PostgreSQL as on SQLite: PostgreSQL's text and jsonb
 * refuse a NUL character, its `integer` holds 32 bits, and a btree index entry holds at most 2,704 bytes. A run
 * case passes through `storableRunCase` before anything of it is stored, so one such value never fails the batch it
 * came in. A test's file, describe path and title are stored as they came while together they fit one index entry,
 * and shortened only past it (`storedTestIdentity`); a lookup by the names a client sends finds the test through
 * `storedTestIdentity`, or `storedIdentityForms` when it lacks the describe path. Shared by `persistRunCases`, the
 * demo's ingest and those lookups.
 */
import { sanitizeRunErrors } from '@piwitests/core/run-errors';
import type { WireRunError } from '@piwitests/core/wire';
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
 * The most UTF-8 bytes a test's file, describe path and title take together and stay whole. They share one index
 * entry, which holds 2,704 bytes on PostgreSQL, the project id and the entry's own overhead included.
 */
export const MAX_TEST_IDENTITY_BYTES = 2600;

/**
 * The longest identity string a shortened identity keeps whole, in UTF-8 bytes: a Playwright project's name, and each
 * of a test's file, describe path and title once the three together pass `MAX_TEST_IDENTITY_BYTES`.
 */
export const MAX_IDENTITY_BYTES = 800;

function utf8Length(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** The UTF-8 bytes of a string; 0 for anything else. */
function utf8Bytes(value: unknown): number {
  if (typeof value !== 'string') return 0;
  let bytes = 0;
  for (const char of value) bytes += utf8Length(char.codePointAt(0)!);
  return bytes;
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
 * An identity string as a shortened identity stores it: NUL characters dropped, and a value longer than
 * `MAX_IDENTITY_BYTES` keeps its head, followed by `…` and the SHA-256 of the whole value, so two long identities stay
 * apart and one is stored alike on every run. A Playwright project's name is always stored so; a test's file,
 * describe path and title only once they are too long together (`storedTestIdentity`).
 */
export async function storedIdentity(value: string): Promise<string> {
  if (typeof value !== 'string') return value;
  const text = withoutNul(value);
  if (headWithin(text, MAX_IDENTITY_BYTES) === null) return text;
  const head = headWithin(text, MAX_IDENTITY_BYTES - 3 - IDENTITY_HASH_CHARS)!;
  return `${head}…${(await sha256Hex(text)).slice(0, IDENTITY_HASH_CHARS)}`;
}

/** The fields that identify a test: its file, describe path and title. */
interface TestIdentity {
  filePath: string;
  suitePath?: string[] | null;
  title: string;
}

/**
 * A test's file, describe path and title as they are stored: without NUL characters, and whole while the three take
 * at most `MAX_TEST_IDENTITY_BYTES` together. Past it, each longer than `MAX_IDENTITY_BYTES` is shortened
 * (`storedIdentity`), a describe path into one level holding the whole path shortened.
 */
export async function storedTestIdentity(
  test: TestIdentity,
): Promise<{ filePath: string; suitePath: string[] | null; title: string }> {
  const filePath = withoutNul(test.filePath);
  const title = withoutNul(test.title);
  const suitePath = test.suitePath?.length ? withoutNul(test.suitePath) : (test.suitePath ?? null);
  const joined = joinSuitePath(suitePath);
  if (utf8Bytes(filePath) + utf8Bytes(joined) + utf8Bytes(title) <= MAX_TEST_IDENTITY_BYTES) {
    return { filePath, suitePath, title };
  }
  const storedPath = await storedIdentity(joined);
  return {
    filePath: await storedIdentity(filePath),
    suitePath: storedPath === joined ? suitePath : [storedPath],
    title: await storedIdentity(title),
  };
}

/**
 * The names a test's file or title can be stored under, for a lookup that lacks the rest of the test's identity: the
 * name whole, and shortened (`storedIdentity`) when it is longer than `MAX_IDENTITY_BYTES`.
 */
export async function storedIdentityForms(value: string): Promise<string[]> {
  const whole = withoutNul(value);
  const shortened = await storedIdentity(whole);
  return shortened === whole ? [whole] : [whole, shortened];
}

/** The fields of a run case that identify its test and its Playwright project. */
interface CaseIdentity extends TestIdentity {
  browser?: unknown;
}

/**
 * A run case as it is stored: no NUL character anywhere in it, its file, describe path and title as
 * `storedTestIdentity` keeps them, and its Playwright project's name as `storedIdentity` does.
 */
export async function storableRunCase<T extends CaseIdentity>(input: T): Promise<T> {
  const c = withoutNul(input);
  const projectName = resolveBrowserName(c.browser);
  const storedProject = projectName === null ? null : await storedIdentity(projectName);
  return {
    ...c,
    ...(await storedTestIdentity(c)),
    browser:
      storedProject === projectName
        ? c.browser
        : typeof c.browser === 'string'
          ? storedProject
          : { ...(c.browser as Record<string, unknown>), projectName: storedProject },
  };
}

/**
 * A run's errors outside any test as the run stores them: read through `sanitizeRunErrors` (the first
 * `MAX_RUN_ERRORS`, their texts hidden and cut), with no NUL character; null for none.
 */
export function storableRunErrors(value: unknown): WireRunError[] | null {
  return withoutNul(sanitizeRunErrors(value));
}
