import type { DrizzleDB } from '#shared/handlers/db';
import { collectTagsTruncated } from '@piwitests/core/test-meta';
import { addRunTagsTruncated } from '#shared/tags-truncated';
import { updateRunMetadata } from './run-metadata';

/**
 * Add the tests of a batch whose raw tags pass the limit to the run's `metadata.tagsTruncated`, so a payload sent
 * without the reporter, which cuts and records them itself, shows them on the run page too. A batch whose tests all
 * fit writes nothing.
 */
export async function recordTagsTruncated(
  db: DrizzleDB,
  runId: number,
  cases: Parameters<typeof collectTagsTruncated>[0],
): Promise<void> {
  const found = collectTagsTruncated(cases);
  if (!found) return;
  await updateRunMetadata(db, runId, (metadata) => addRunTagsTruncated(metadata, { tagsTruncated: found }));
}
