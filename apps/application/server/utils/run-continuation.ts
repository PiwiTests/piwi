import { and, eq, isNotNull, isNull, lt, notInArray, type SQL } from 'drizzle-orm';
import type { RunOriginKind } from '@piwitests/core/wire';
import type { DbClient } from '../database';
import { testRuns } from '../database/schema';
import {
  isPrivateRunOrigin,
  notPrivateRun,
  runOriginIn,
  LOCAL_RUN_ORIGINS,
  PRIVATE_RUN_ORIGINS,
} from '#shared/run-eligibility';
import { runEventBus } from './run-events';

/** The run a worker's live view stream comes from, as the stream route reads it. */
export interface ContinuingRun {
  id: number;
  projectId: number;
  origin: string | null;
  requesterId: number | null;
  /** The reporter's instance: one machine's runs of a project share it. */
  instanceId: string | null;
}

/** The statuses of a run still under way, which no run continues yet. */
const UNDER_WAY: string[] = ['initializing', 'running', 'finalizing'];

/** The origins of the runs one editor window shares one after the other: a developer's own, and a private request. */
const CONTINUABLE: readonly RunOriginKind[] = [...LOCAL_RUN_ORIGINS, ...PRIVATE_RUN_ORIGINS];

/**
 * A worker of `run` names the run it continues (`after`, `LIVE_VIEW_AFTER_PARAM`): the run of the same editor window
 * shared before it. That earlier run, of the same project, with a lower id, run on a developer's machine as `run` is
 * (`LOCAL_RUN_ORIGINS`, or a private request), from the same machine (the reporter's `instanceId`), keyed for the live
 * view, ended, seen by the same people (both private runs of one requester, or neither private), and continued by no
 * run yet, is continued by `run` from now on (`test_runs.continued_in_id`), once; a run continues one run at most. Its
 * page hears it, on the run's stream (`continued`, while it streams) and on the global one (`run-continued`, once it
 * ended), and follows. Returns whether the earlier run was linked.
 */
export async function continueRun(db: DbClient, run: ContinuingRun, after: number): Promise<boolean> {
  if (!Number.isSafeInteger(after) || after < 1 || after >= run.id) return false;
  if (!run.instanceId || !CONTINUABLE.includes(run.origin as RunOriginKind)) return false;
  const [already] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.continuedInId, run.id))
    .limit(1);
  if (already) return false;
  const sameViewers: SQL = isPrivateRunOrigin(run.origin)
    ? and(runOriginIn(testRuns.origin, PRIVATE_RUN_ORIGINS), eq(testRuns.requesterId, run.requesterId ?? -1))!
    : notPrivateRun(testRuns.origin);
  const linked = await db
    .update(testRuns)
    .set({ continuedInId: run.id })
    .where(
      and(
        eq(testRuns.id, after),
        lt(testRuns.id, run.id),
        eq(testRuns.projectId, run.projectId),
        isNull(testRuns.continuedInId),
        eq(testRuns.instanceId, run.instanceId),
        runOriginIn(testRuns.origin, CONTINUABLE),
        isNotNull(testRuns.liveViewKeyDigests),
        notInArray(testRuns.status, UNDER_WAY),
        sameViewers,
      ),
    )
    .returning({ id: testRuns.id });
  if (!linked.length) return false;
  // Published to a page that holds the run's stream alone: an ended run keeps no state on the bus.
  if (runEventBus.isWatched(after)) runEventBus.publish(after, { type: 'continued', data: { runId: run.id } });
  runEventBus.publishGlobal({ type: 'run-continued', runId: after, projectId: run.projectId, continuedInId: run.id });
  return true;
}
