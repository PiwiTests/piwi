/**
 * Suspect lines in the demo, through the same shared reads and join the
 * server uses: the failing executions' coverage, joined with the changes of
 * the demo's canned history over the range its What changed card reads by
 * default (`getDemoDefaultRange`), and scored against the run's passing
 * executions. Only the source of the changes differs from the server's. A run
 * of a deployed environment names it and its deployed commit, as the server's
 * answer does.
 */
import {
  clusterSuspectTarget,
  executionSuspectTarget,
  joinSuspectChanges,
  type SuspectRun,
} from '#shared/handlers/suspect-lines';
import {
  unavailableSuspectLines,
  type ClusterSuspectLinesAnswer,
  type SuspectLinesAnswer,
  type SuspectLinesDeployed,
} from '#shared/suspect-lines';
import type { DrizzleDB } from '#shared/handlers/db';
import { deployedEnvironmentOf } from '#shared/handlers/deployed-changes';
import { runDeployedCommit } from '#shared/handlers/deployed-commit';
import { getDemoChangesSince, getDemoDefaultRange } from '../demo-scm';

/** The deployed environment a run tested and its deployed commit; undefined for one built from the checkout. */
async function demoDeployed(db: DrizzleDB, run: SuspectRun): Promise<SuspectLinesDeployed | undefined> {
  const environment = await deployedEnvironmentOf(db, run.environmentId);
  if (!environment) return undefined;
  const commit = await runDeployedCommit(db, {
    id: run.id,
    environmentId: run.environmentId,
    startTime: run.startTime,
  });
  return { environment: environment.name, commit: commit?.commit ?? null };
}

/** The suspect lines of failing executions of one run, over the project's default demo range. */
async function joinDemoChanges(db: DrizzleDB, run: SuspectRun, failingIds: number[]): Promise<SuspectLinesAnswer> {
  const range = getDemoDefaultRange(run.projectId);
  const changes = range ? getDemoChangesSince(run.projectId, range.from) : null;
  const deployed = await demoDeployed(db, run);
  if (!range || !changes) return unavailableSuspectLines('no-scm', deployed ? { deployed } : {});
  return joinSuspectChanges(db, run, failingIds, changes, { range, ...(deployed ? { deployed } : {}) });
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
