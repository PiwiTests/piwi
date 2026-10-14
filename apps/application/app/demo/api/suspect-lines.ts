/**
 * Suspect lines in the demo, through the same shared reads and join the
 * server uses: the failing executions' coverage, joined with the changes of
 * the demo's canned history over the range its What changed card reads by
 * default (`getDemoDefaultRange`), and scored against the run's passing
 * executions. Only the source of the changes differs from the server's.
 */
import {
  clusterSuspectTarget,
  executionSuspectTarget,
  joinSuspectChanges,
  readFailingCaptures,
  type SuspectRun,
} from '#shared/handlers/suspect-lines';
import {
  unavailableSuspectLines,
  type ClusterSuspectLinesAnswer,
  type SuspectLinesAnswer,
} from '#shared/suspect-lines';
import type { DrizzleDB } from '#shared/handlers/db';
import { getDemoChangesSince, getDemoDefaultRange } from '../demo-scm';

/** The suspect lines of failing executions of one run, over the project's default demo range. */
async function joinDemoChanges(db: DrizzleDB, run: SuspectRun, failingIds: number[]): Promise<SuspectLinesAnswer> {
  const range = getDemoDefaultRange(run.projectId);
  const changes = range ? getDemoChangesSince(run.projectId, range.from) : null;
  if (!range || !changes) return unavailableSuspectLines('no-scm');
  const failing = await readFailingCaptures(db, failingIds);
  if (!failing.some((capture) => capture.files.length > 0)) return unavailableSuspectLines('no-coverage', { range });
  return joinSuspectChanges(db, run, failing, changes, { range });
}

/** An execution's suspect lines; null when there is no such execution. */
export async function demoExecutionSuspectLines(
  db: DrizzleDB,
  executionId: number,
): Promise<SuspectLinesAnswer | null> {
  const target = await executionSuspectTarget(db, executionId);
  if (!target) return null;
  if (target.reason) return unavailableSuspectLines(target.reason);
  return joinDemoChanges(db, target.run, target.failingIds);
}

/** A failure cluster's suspect lines. */
export async function demoClusterSuspectLines(db: DrizzleDB, clusterId: number): Promise<ClusterSuspectLinesAnswer> {
  const target = await clusterSuspectTarget(db, clusterId);
  if (target.reason) return { ...unavailableSuspectLines(target.reason), runId: target.runId };
  return { ...(await joinDemoChanges(db, target.run, target.failingIds)), runId: target.run.id };
}
