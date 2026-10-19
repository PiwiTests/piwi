import type { DrizzleDB } from '#shared/handlers/db';
import { addIngestHealth, INGEST_HEALTH_COUNTS, readIngestHealth, type IngestHealth } from '#shared/ingest-health';
import { updateRunMetadata } from './run-metadata';

/** True when the delta holds nothing to record. */
function isEmpty(delta: IngestHealth): boolean {
  return !delta.submitFallback && INGEST_HEALTH_COUNTS.every((key) => !delta[key]);
}

/**
 * Add what ingest dropped or rebuilt to the run's `metadata.ingestHealth`, so
 * concurrent batches of one run add up instead of overwriting each other.
 */
export async function recordIngestHealth(db: DrizzleDB, runId: number, delta: IngestHealth): Promise<void> {
  if (isEmpty(delta)) return;
  await updateRunMetadata(db, runId, (metadata) => {
    const health = addIngestHealth(readIngestHealth(metadata), delta);
    return { ...metadata, ...(health ? { ingestHealth: health } : {}) };
  });
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
