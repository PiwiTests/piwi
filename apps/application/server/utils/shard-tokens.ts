import { createHash } from 'node:crypto';
import { testRuns } from '../database/schema';
import { eq } from 'drizzle-orm';
import type { DbClient as DB } from '../database';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { timingSafeEqualStr } from './timing-safe';

/**
 * How a shard token is kept, in run metadata (which every project member can
 * read) and in memory: its SHA-256 digest, never the token itself.
 */
export function shardTokenDigest(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

/**
 * How a run's main stream or setup token is kept, in `test_runs.stream_token`
 * and in the in-memory run state: its digest, like a shard token.
 */
export function streamTokenDigest(token: string): string {
  return shardTokenDigest(token);
}

/**
 * Whether `token` is the run's main stream or setup token, given the stored
 * value. A plain stored token still matches, but a presented digest never
 * matches a stored digest: reading the stored value back must not yield a
 * usable token.
 */
export function matchesStreamToken(stored: string | null | undefined, token: string | null | undefined): boolean {
  if (!stored || !token || typeof token !== 'string') return false;
  if (stored.startsWith('sha256:')) return timingSafeEqualStr(stored, streamTokenDigest(token));
  return !token.startsWith('sha256:') && timingSafeEqualStr(stored, token);
}

/**
 * Whether `token` is one of a run's stored shard tokens. A plain entry kept by an
 * older build still matches, but a presented digest never does: reading the
 * stored value back must not yield a usable token.
 */
export function matchesShardToken(stored: Set<string> | undefined, token: string | null | undefined): boolean {
  if (!stored || !token) return false;
  if (stored.has(shardTokenDigest(token))) return true;
  return !token.startsWith('sha256:') && stored.has(token);
}

/**
 * Read the stored shard tokens (digests) from a test run's metadata JSON column.
 * Returns undefined when the run has no stored shard tokens.
 */
export function readShardTokensFromMeta(metadata: unknown): Set<string> | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const meta = metadata as Record<string, unknown>;
  const tokens = meta.shardTokens;
  if (!Array.isArray(tokens)) return undefined;
  const strTokens = tokens.filter((t): t is string => typeof t === 'string');
  return strTokens.length > 0 ? new Set(strTokens) : undefined;
}

/**
 * Every shard token a run holds: the digests cached in memory together with the
 * ones stored in its metadata. A new set, so the caller may change it freely.
 */
export function knownShardTokens(cached: Set<string> | undefined, metadata: unknown): Set<string> {
  return new Set([...(cached ?? []), ...(readShardTokensFromMeta(metadata) ?? [])]);
}

/** A copy of a run's metadata whose stored shard tokens are `tokens`, every other key kept. */
export function withShardTokens(metadata: unknown, tokens: Set<string>): Record<string, unknown> {
  const meta = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {};
  if (tokens.size > 0) meta.shardTokens = [...tokens];
  else delete meta.shardTokens;
  return meta;
}

/**
 * Append a shard token's digest to a test run's stored metadata in the database.
 * Reads current metadata, appends the token, writes back via Drizzle JSON serialization.
 */
export async function persistShardToken(
  db: DB,
  runId: number,
  token: string,
  existingMetadata?: Record<string, unknown> | null,
): Promise<void> {
  let meta: Record<string, unknown>;
  if (existingMetadata) {
    meta = { ...existingMetadata };
  } else {
    const row = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));
    meta = (row[0]?.metadata as Record<string, unknown>) ?? {};
  }

  const tokens: string[] = Array.isArray(meta.shardTokens) ? [...meta.shardTokens] : [];
  const digest = shardTokenDigest(token);
  if (tokens.includes(digest)) return;
  tokens.push(digest);
  meta.shardTokens = tokens;

  await db
    .update(testRuns)
    .set({ metadata: meta, origin: runOrigin(meta), commit: runCommit(meta), updatedAt: new Date() })
    .where(eq(testRuns.id, runId));
}

/**
 * Remove a shard token from a test run's stored metadata in the database.
 */
export async function removeStoredShardToken(db: DB, runId: number, token: string): Promise<void> {
  const row = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));

  const meta = (row[0]?.metadata as Record<string, unknown>) ?? {};
  const tokens: string[] = Array.isArray(meta.shardTokens) ? meta.shardTokens : [];
  const digest = shardTokenDigest(token);
  const filtered = tokens.filter((t) => t !== token && t !== digest);
  if (filtered.length === tokens.length) return;

  if (filtered.length > 0) {
    meta.shardTokens = filtered;
  } else {
    delete meta.shardTokens;
  }

  await db
    .update(testRuns)
    .set({ metadata: meta, origin: runOrigin(meta), commit: runCommit(meta), updatedAt: new Date() })
    .where(eq(testRuns.id, runId));
}
