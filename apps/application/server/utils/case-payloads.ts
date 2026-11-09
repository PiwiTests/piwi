import { and, eq, inArray } from 'drizzle-orm';
import { casePayloads } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { sha256Hex } from '#shared/utils/hash';

/**
 * Content-addressed storage for the large per-execution text payloads (ARIA
 * snapshots, test source snippets, source-frame JSON, what a test wrote to
 * stdout and stderr). Contents are hashed server-side at ingest, stored once
 * per (project, hash), and referenced from `test_runs_cases` by id — so a test
 * failing identically across many runs (or across browsers within one run)
 * stores each payload a single time.
 *
 * A row may still carry a payload in its inline column instead; readers must
 * coalesce via {@link inlineCasePayloads} (payload content wins, inline column
 * is the fallback).
 */

const ID_BATCH_SIZE = 500;

function* batches<T>(items: T[]): Generator<T[]> {
  for (let i = 0; i < items.length; i += ID_BATCH_SIZE) {
    yield items.slice(i, i + ID_BATCH_SIZE);
  }
}

/**
 * Ensure every distinct content string exists in `case_payloads` for the
 * project and return a content → id map.
 *
 * Concurrency-safe under parallel shards/streaming batches: insert uses
 * ON CONFLICT DO NOTHING on the (project_id, hash) unique index, then
 * re-selects to pick up rows a concurrent writer won (the trace_blobs
 * pattern).
 */
export async function upsertCasePayloads(
  db: DrizzleDB,
  projectId: number,
  contents: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const contentByHash = new Map<string, string>();
  const hashByContent = new Map<string, string>();

  for (const content of contents) {
    if (!content || hashByContent.has(content)) continue;
    const hash = await sha256Hex(content);
    hashByContent.set(content, hash);
    contentByHash.set(hash, content);
  }
  if (contentByHash.size === 0) return result;

  const idByHash = new Map<string, number>();
  const lookup = async (hashes: string[]) => {
    for (const batch of batches(hashes)) {
      const rows = await db
        .select({ id: casePayloads.id, hash: casePayloads.hash })
        .from(casePayloads)
        .where(and(eq(casePayloads.projectId, projectId), inArray(casePayloads.hash, batch)));
      for (const row of rows) idByHash.set(row.hash, row.id);
    }
  };

  const allHashes = [...contentByHash.keys()];
  await lookup(allHashes);

  const missing = allHashes.filter((hash) => !idByHash.has(hash));
  if (missing.length > 0) {
    for (const batch of batches(missing)) {
      await db
        .insert(casePayloads)
        .values(
          batch.map((hash) => {
            const content = contentByHash.get(hash)!;
            return { projectId, hash, content, size: content.length };
          }),
        )
        .onConflictDoNothing();
    }
    await lookup(missing);
  }

  for (const [content, hash] of hashByContent) {
    const id = idByHash.get(hash);
    if (id !== undefined) result.set(content, id);
  }
  return result;
}

/** Batched fetch of payload contents by id. */
export async function resolveCasePayloadContents(
  db: DrizzleDB,
  ids: Array<number | null | undefined>,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const wanted = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
  if (wanted.length === 0) return map;
  for (const batch of batches(wanted)) {
    const rows = await db
      .select({ id: casePayloads.id, content: casePayloads.content })
      .from(casePayloads)
      .where(inArray(casePayloads.id, batch));
    for (const row of rows) map.set(row.id, row.content);
  }
  return map;
}

interface CasePayloadRefFields {
  ariaSnapshot?: string | null;
  ariaSnapshotJson?: string | null;
  testSource?: string | null;
  testSourceFrames?: unknown;
  ariaSnapshotPayloadId?: number | null;
  ariaSnapshotJsonPayloadId?: number | null;
  testSourcePayloadId?: number | null;
  testSourceFramesPayloadId?: number | null;
}

/**
 * Return a copy of the row with `ariaSnapshot`/`ariaSnapshotJson`/`testSource`/
 * `testSourceFrames` coalesced from their content-addressed payloads, falling
 * back to the inline columns for a row without a payload id.
 */
export async function inlineCasePayloads<T extends CasePayloadRefFields>(db: DrizzleDB, row: T): Promise<T> {
  const contents = await resolveCasePayloadContents(db, [
    row.ariaSnapshotPayloadId,
    row.ariaSnapshotJsonPayloadId,
    row.testSourcePayloadId,
    row.testSourceFramesPayloadId,
  ]);
  if (contents.size === 0) return row;

  const resolved: T = { ...row };
  const aria = row.ariaSnapshotPayloadId != null ? contents.get(row.ariaSnapshotPayloadId) : undefined;
  if (aria !== undefined) resolved.ariaSnapshot = aria;
  const ariaJson = row.ariaSnapshotJsonPayloadId != null ? contents.get(row.ariaSnapshotJsonPayloadId) : undefined;
  if (ariaJson !== undefined) resolved.ariaSnapshotJson = ariaJson;
  const source = row.testSourcePayloadId != null ? contents.get(row.testSourcePayloadId) : undefined;
  if (source !== undefined) resolved.testSource = source;
  const framesJson = row.testSourceFramesPayloadId != null ? contents.get(row.testSourceFramesPayloadId) : undefined;
  if (framesJson !== undefined) {
    try {
      resolved.testSourceFrames = JSON.parse(framesJson);
    } catch {
      // Malformed payload content — keep whatever the inline column holds.
    }
  }
  return resolved;
}

/**
 * What an execution wrote to stdout and to stderr, from its content-addressed payloads; null for a stream it wrote
 * nothing to. Read apart from {@link inlineCasePayloads}, so the readers that never show the output never load it.
 */
export async function caseOutput(
  db: DrizzleDB,
  row: { stdoutPayloadId?: number | null; stderrPayloadId?: number | null },
): Promise<{ stdout: string | null; stderr: string | null }> {
  const contents = await resolveCasePayloadContents(db, [row.stdoutPayloadId, row.stderrPayloadId]);
  return {
    stdout: row.stdoutPayloadId != null ? (contents.get(row.stdoutPayloadId) ?? null) : null,
    stderr: row.stderrPayloadId != null ? (contents.get(row.stderrPayloadId) ?? null) : null,
  };
}
