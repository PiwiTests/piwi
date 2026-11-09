import { createHash } from 'node:crypto';
import type { DbClient as DB } from '../database';
import { timingSafeEqualStr } from './timing-safe';
import { updateRunMetadata, type MetadataObject } from './run-metadata';

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
 * The shards of a sharded run still in their global setup, from its metadata: the digests of the setup tokens
 * `/setup` handed them, which their `/begin` has not spent yet. Each is one of the run's shard tokens too.
 */
export function readShardSetupTokens(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const tokens = (metadata as Record<string, unknown>).shardSetupTokens;
  return Array.isArray(tokens) ? tokens.filter((t): t is string => typeof t === 'string') : [];
}

/** A copy of a run's metadata whose shards still in their global setup are those of `digests`, every other key kept. */
export function withShardSetupTokens(metadata: unknown, digests: string[]): Record<string, unknown> {
  const meta = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {};
  if (digests.length > 0) meta.shardSetupTokens = digests;
  else delete meta.shardSetupTokens;
  return meta;
}

/**
 * Add a shard token's digest to a test run's stored metadata. A setup token's (`setup: true`) also counts its shard
 * among those still in their global setup (`readShardSetupTokens`).
 */
export async function persistShardToken(db: DB, runId: number, token: string, { setup = false } = {}): Promise<void> {
  const digest = shardTokenDigest(token);
  await updateRunMetadata(
    db,
    runId,
    (metadata) => {
      const tokens = Array.isArray(metadata.shardTokens) ? (metadata.shardTokens as string[]) : [];
      if (tokens.includes(digest)) return null;
      const next = { ...metadata, shardTokens: [...tokens, digest] };
      return setup ? withShardSetupTokens(next, [...readShardSetupTokens(metadata), digest]) : next;
    },
    { updatedAt: new Date() },
  );
}

/**
 * A copy of a run's metadata without the shard token `token` (its digest, or a
 * plain entry kept by an older build), or null when the metadata does not hold it.
 */
export function withoutShardToken(metadata: MetadataObject, token: string): MetadataObject | null {
  const tokens: unknown[] = Array.isArray(metadata.shardTokens) ? metadata.shardTokens : [];
  const digest = shardTokenDigest(token);
  const kept = tokens.filter((t) => t !== token && t !== digest);
  if (kept.length === tokens.length) return null;
  const next = { ...metadata };
  if (kept.length > 0) next.shardTokens = kept;
  else delete next.shardTokens;
  return next;
}
