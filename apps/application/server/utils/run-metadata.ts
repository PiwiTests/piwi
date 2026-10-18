import { and, eq, isNull } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { runCommit, runOrigin } from '#shared/run-eligibility';

/** A run's `metadata` column, read as a plain object. */
export type MetadataObject = Record<string, unknown>;

/** Attempts at the conditional write before the last one is made unconditionally. */
const WRITE_ATTEMPTS = 8;

/** A stored metadata value as an object: an empty one when there is none. */
function asMetadata(value: unknown): MetadataObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as MetadataObject) } : {};
}

/**
 * Rewrite a run's `metadata` from its stored value. `change` receives a copy of
 * the stored metadata and returns the metadata to store, or null to leave the
 * run as it is. Each write applies only while the metadata is still the one
 * `change` read, and is recomputed otherwise, so concurrent writers of one run's
 * metadata keep each other's keys. `origin` and `commit` follow the metadata
 * written, and `set` adds other columns to the same write.
 *
 * Returns the metadata written, or null when the run is missing or `change`
 * declined.
 */
export async function updateRunMetadata(
  db: DrizzleDB,
  runId: number,
  change: (metadata: MetadataObject) => MetadataObject | null,
  set: SQLiteUpdateSetSource<typeof testRuns> = {},
): Promise<MetadataObject | null> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));
    if (!run) return null;
    const next = change(asMetadata(run.metadata));
    if (!next) return null;
    const unchanged = run.metadata == null ? isNull(testRuns.metadata) : eq(testRuns.metadata, run.metadata);
    const written = await db
      .update(testRuns)
      .set({ ...set, metadata: next, origin: runOrigin(next), commit: runCommit(next) })
      .where(attempt < WRITE_ATTEMPTS ? and(eq(testRuns.id, runId), unchanged) : eq(testRuns.id, runId))
      .returning({ id: testRuns.id });
    if (written.length > 0) return next;
  }
  return null;
}
