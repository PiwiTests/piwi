/**
 * Suspect lines in the demo. The demo reads no source control, so it answers
 * what the database alone tells, through the same shared reader the server
 * starts from: `not-failing` or `no-coverage` (every seeded execution, since
 * the seed records no coverage), else `no-scm`.
 */
import { clusterSuspectTarget, executionSuspectTarget } from '#shared/handlers/suspect-lines';
import {
  unavailableSuspectLines,
  type ClusterSuspectLinesAnswer,
  type SuspectLinesAnswer,
} from '#shared/suspect-lines';
import type { DrizzleDB } from '#shared/handlers/db';

/** An execution's suspect lines; null when there is no such execution. */
export async function demoExecutionSuspectLines(
  db: DrizzleDB,
  executionId: number,
): Promise<SuspectLinesAnswer | null> {
  const target = await executionSuspectTarget(db, executionId);
  if (!target) return null;
  return unavailableSuspectLines(target.reason ?? 'no-scm');
}

/** A failure cluster's suspect lines. */
export async function demoClusterSuspectLines(db: DrizzleDB, clusterId: number): Promise<ClusterSuspectLinesAnswer> {
  const target = await clusterSuspectTarget(db, clusterId);
  if (target.reason) return { ...unavailableSuspectLines(target.reason), runId: target.runId };
  return { ...unavailableSuspectLines('no-scm'), runId: target.run.id };
}
