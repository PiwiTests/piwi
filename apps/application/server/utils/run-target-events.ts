import { eq } from 'drizzle-orm';
import type { RunRequest } from '@piwitests/core/run-request';
import { runTargets, users, type RunRequestRow } from '../database/schema';
import type { DbClient } from '../database';
import { getUserAccessCached } from './auth';
import { mayReceiveOn, runRequestOf } from './run-requests';

/**
 * What a connected target hears on its stream (`GET /api/run-targets/stream`): the requests and stops it would read
 * from `GET /api/run-targets/requests` on connecting, then each new request sent to it, each stop of a request it
 * holds, and its own disconnection. A request can arrive twice (in the snapshot and as it is made): the target keys
 * them by id. Held in memory, as the run event bus is: an instance runs one replica.
 */
export type RunTargetEvent =
  | { type: 'snapshot'; requests: RunRequest[]; stops: string[] }
  | { type: 'request'; request: RunRequest }
  | { type: 'stop'; id: string }
  | { type: 'revoked' };

/** How often an open stream records that its target was seen, and checks its key again. */
export const RUN_TARGET_RECHECK_MS = 60_000;

type Listener = (event: RunTargetEvent) => void;

const listeners = new Map<number, Set<Listener>>();

/** Listen to one target's events; answers the call that stops listening. */
export function subscribeRunTarget(targetId: number, listener: Listener): () => void {
  let set = listeners.get(targetId);
  if (!set) listeners.set(targetId, (set = new Set()));
  set.add(listener);
  return () => {
    const current = listeners.get(targetId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(targetId);
  };
}

/** Whether a target holds its stream open now: what **Connected apps** shows as online. */
export function isRunTargetOnline(targetId: number): boolean {
  return (listeners.get(targetId)?.size ?? 0) > 0;
}

/** Send an event to every stream a target holds open. */
export function publishToRunTarget(targetId: number, event: RunTargetEvent): void {
  for (const listener of [...(listeners.get(targetId) ?? [])]) {
    try {
      listener(event);
    } catch {
      // One stream's failure never stops the others.
    }
  }
}

/**
 * Send a new request, still waiting for a claim, to the requester's targets that are online and may take it: the one
 * it names, or any of theirs whose owner holds `run:receive` on its project while **Run on my machine** is on there.
 */
export async function publishRunRequest(db: DbClient, row: RunRequestRow): Promise<void> {
  if (row.state !== 'waiting') return;
  const owned = await db.select({ id: runTargets.id }).from(runTargets).where(eq(runTargets.userId, row.requesterId));
  const online = owned.filter((t) => isRunTargetOnline(t.id) && (row.targetId === null || row.targetId === t.id));
  if (!online.length) return;
  const request = runRequestOf(row);
  const [owner] = await db.select().from(users).where(eq(users.id, row.requesterId));
  if (!request || !owner) return;
  if (!(await mayReceiveOn(db, await getUserAccessCached(db, owner), row.projectId))) return;
  for (const target of online) publishToRunTarget(target.id, { type: 'request', request });
}

/** Forget every listener; for tests. */
export function resetRunTargetEvents(): void {
  listeners.clear();
}
