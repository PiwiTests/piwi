/**
 * Desktop build: the run events of the window's event stream (`GET /api/desktop/events`), which the window's OS
 * progress reads (`app/plugins/desktop-run-progress.client.ts`). Each run of the snapshot and each run lifecycle event
 * carries what launched the run, read from the stored run (`DesktopRunOrigin`): the window ends a run nobody attends (a
 * bisect's step, a lab run) without a flash, and finds the runs a stopped local run produced. The events go out in the
 * order they came, the snapshot first, however long each lookup takes.
 */
import { inArray } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { runLauncherRef, runOriginRef } from '#shared/run-eligibility';
import type { GlobalRunEvent, RunProgressBroadcast } from './run-events';

/** What launched a run, as the window's run events carry it. */
export interface DesktopRunOrigin {
  /** What launched the run (`test_runs.origin`: `desktop`, `bisect`, `ci`…). */
  origin: string;
  /** What the run was launched for (`PIWI_ORIGIN_REF`), when its origin names it. */
  originRef: string | null;
  /** The launcher's name for the run (`PIWI_RUN_REF`), when the reporter recorded one. */
  runName: string | null;
}

/** The origin of each of these runs that exists. */
export async function desktopRunOrigins(db: DrizzleDB, ids: readonly number[]): Promise<Map<number, DesktopRunOrigin>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: testRuns.id, origin: testRuns.origin, metadata: testRuns.metadata })
    .from(testRuns)
    .where(inArray(testRuns.id, [...ids]));
  return new Map(
    rows.map((row) => [
      row.id,
      { origin: row.origin, originRef: runOriginRef(row.metadata), runName: runLauncherRef(row.metadata) },
    ]),
  );
}

/**
 * The window's run events, each passed to `send` in the order it came: the snapshot of the runs in flight, then each
 * run's lifecycle event with its origin, and its progress tallies. An event whose lookup fails goes without its
 * origin; a snapshot that cannot be read sends nothing.
 */
export function desktopRunEvents(db: DrizzleDB, send: (payload: unknown) => void) {
  let queue: Promise<void> = Promise.resolve();
  const inOrder = (next: () => Promise<unknown>) => {
    queue = queue
      .then(next)
      .then(send)
      .catch(() => {});
  };
  const withOrigin = async (event: GlobalRunEvent) => {
    try {
      return { ...event, ...(await desktopRunOrigins(db, [event.runId])).get(event.runId) };
    } catch {
      return event;
    }
  };
  return {
    snapshot(read: () => Promise<ReadonlyArray<{ id: number }>>): void {
      inOrder(async () => {
        const runs = await read();
        const origins = await desktopRunOrigins(
          db,
          runs.map((run) => run.id),
        ).catch(() => new Map<number, DesktopRunOrigin>());
        return { type: 'snapshot', runs: runs.map((run) => ({ ...run, ...origins.get(run.id) })) };
      });
    },
    lifecycle(event: GlobalRunEvent): void {
      inOrder(() => withOrigin(event));
    },
    progress(progress: RunProgressBroadcast): void {
      inOrder(async () => ({ type: 'run-progress', ...progress }));
    },
  };
}
