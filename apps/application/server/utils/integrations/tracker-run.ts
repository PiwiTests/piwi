/**
 * The run facts the automatic tracker writes read: whether the run may drive
 * them at all (the `tracker` use: no lab or investigation run, no editor run,
 * no environment incident, a developer's own run only when it covered the
 * suite) and where it ran — its branch, environment, whether that branch is the
 * project's default branch, and its commit — for the binding's run scope.
 */
import { eq } from 'drizzle-orm';
import { projects, testRuns } from '../../database/schema';
import type { DbClient } from '../../database';
import { isEligibleRun, type RunUse } from '#shared/run-eligibility';
import { runInScope, type ScopedRun, type TrackerRunScope } from '#shared/integrations/automation';
import { resolveRunBranch } from '../run-branch';
import { resolveDefaultBranch } from '../scm/default-branch';
import type { RunMetadata } from '../run-json-types';

export interface TrackerRun extends ScopedRun {
  id: number;
  projectId: number;
  /** The run may drive the writes of the use it was loaded for. */
  eligible: boolean;
  /** The project's default branch, as resolved for this run. */
  defaultBranch: string | null;
  commit: string | null;
  /** When the run started, epoch ms. */
  startedAt: number | null;
}

/** The run's facts, with whether the run may drive the writes of `use`; null when the run is gone. */
export async function loadTrackerRun(db: DbClient, runId: number, use: RunUse = 'tracker'): Promise<TrackerRun | null> {
  const [run] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      metadata: testRuns.metadata,
      isFullRun: testRuns.isFullRun,
      status: testRuns.status,
      branch: testRuns.branch,
      environment: testRuns.environment,
      startTime: testRuns.startTime,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return null;
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const defaultBranch = project ? await resolveDefaultBranch(db, project, run.metadata).catch(() => null) : null;
  return {
    id: run.id,
    projectId: run.projectId,
    eligible: isEligibleRun(run, use),
    branch,
    environment: run.environment ?? null,
    isDefaultBranch: branch != null && branch === defaultBranch,
    defaultBranch,
    commit: (run.metadata as RunMetadata | null)?.scm?.commit ?? null,
    startedAt: run.startTime instanceof Date ? run.startTime.getTime() : null,
  };
}

/** Whether a run may drive the writes a scope governs: eligible, and in the scope. */
export function runDrivesWrites(run: TrackerRun | null, scope: TrackerRunScope): run is TrackerRun {
  return !!run && run.eligible && runInScope(scope, run);
}
