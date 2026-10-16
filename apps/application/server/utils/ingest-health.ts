import { and, eq, isNull } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { runCommit, runOrigin } from '#shared/run-eligibility';
import { addIngestHealth, INGEST_HEALTH_COUNTS, readIngestHealth, type IngestHealth } from '#shared/ingest-health';

/** True when the delta holds nothing to record. */
function isEmpty(delta: IngestHealth): boolean {
  return !delta.submitFallback && INGEST_HEALTH_COUNTS.every((key) => !delta[key]);
}

/** Attempts at the conditional write before the last one is made unconditionally. */
const RECORD_ATTEMPTS = 5;

/**
 * Add what ingest dropped or rebuilt to the run's `metadata.ingestHealth`.
 * Each write applies only while the metadata is still the one it was computed
 * from, and is recomputed otherwise, so concurrent batches of one run add up
 * instead of overwriting each other.
 */
export async function recordIngestHealth(db: DrizzleDB, runId: number, delta: IngestHealth): Promise<void> {
  if (isEmpty(delta)) return;
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    const [run] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));
    if (!run) return;
    const metadata =
      run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
        ? (run.metadata as Record<string, unknown>)
        : {};
    const health = addIngestHealth(readIngestHealth(metadata), delta);
    const unchanged = run.metadata == null ? isNull(testRuns.metadata) : eq(testRuns.metadata, run.metadata);
    const written = await db
      .update(testRuns)
      .set({
        metadata: { ...metadata, ...(health ? { ingestHealth: health } : {}) },
        origin: runOrigin(metadata),
        commit: runCommit(metadata),
      })
      .where(attempt < RECORD_ATTEMPTS ? and(eq(testRuns.id, runId), unchanged) : eq(testRuns.id, runId))
      .returning({ id: testRuns.id });
    if (written.length > 0) return;
  }
}

/** What the caps left out of one execution. */
export interface ExecutionDrops {
  steps: number;
  consoleEntries: number;
}

/** What the caps left out of a batch's stored executions, given the index of each stored row. */
export function storedDrops(perRow: ExecutionDrops[], storedRowIndices: Iterable<number>): IngestHealth {
  let stepsDropped = 0;
  let consoleEntriesDropped = 0;
  for (const i of storedRowIndices) {
    stepsDropped += perRow[i]?.steps ?? 0;
    consoleEntriesDropped += perRow[i]?.consoleEntries ?? 0;
  }
  return { stepsDropped, consoleEntriesDropped };
}
