import { eq } from 'drizzle-orm';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { runTargets, users, type RunRequestRow } from '../database/schema';
import type { DbClient } from '../database';
import { getUserAccessCached } from './auth';
import { mayReceiveOn, runRequestOfferOf } from './run-requests';

/**
 * What a connected target hears on its stream (`GET /api/run-targets/stream`): the requests and stops it would read
 * from `GET /api/run-targets/requests` on connecting, then each new request sent to it, each stop of a request it
 * holds, each request it was offered that no longer waits for it (`withdrawn`: stopped, or claimed by another of its
 * owner's apps), and its own disconnection. A request can arrive twice (in the snapshot and as it is made): the target
 * keys them by id. Held in memory, as the run event bus is: an instance runs one replica.
 */
export type RunTargetEvent =
  | { type: 'snapshot'; requests: RunRequestOffer[]; stops: string[] }
  | { type: 'request'; request: RunRequestOffer }
  | { type: 'stop'; id: string }
  | { type: 'withdrawn'; id: string }
  | { type: 'revoked' };

/** How often an open stream checks its target's key again. */
export const RUN_TARGET_RECHECK_MS = 60_000;

/**
 * How recently a target with an open stream must have called the instance to show as online: its app calls a target
 * route (`GET /api/run-targets/requests`) every minute while its stream is open, since a connection a sleeping laptop
 * dropped can look open for minutes.
 */
export const RUN_TARGET_ONLINE_MS = 2 * 60_000;

/** The streams one target may hold open at once. */
export const MAX_STREAMS_PER_TARGET = 3;

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

/** How many streams a target holds open now. */
export function runTargetStreamCount(targetId: number): number {
  return listeners.get(targetId)?.size ?? 0;
}

/**
 * Whether a target is online, as **Connected apps** shows it: it holds its stream open and called the instance within
 * `RUN_TARGET_ONLINE_MS`.
 */
export function isRunTargetOnline(targetId: number, lastSeenAt: Date | null, now = Date.now()): boolean {
  return runTargetStreamCount(targetId) > 0 && lastSeenAt !== null && now - lastSeenAt.getTime() < RUN_TARGET_ONLINE_MS;
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
  const online = owned.filter(
    (t) => runTargetStreamCount(t.id) > 0 && (row.targetId === null || row.targetId === t.id),
  );
  if (!online.length) return;
  const request = runRequestOfferOf(row);
  const [owner] = await db.select().from(users).where(eq(users.id, row.requesterId));
  if (!request || !owner) return;
  if (!(await mayReceiveOn(db, await getUserAccessCached(db, owner), row.projectId))) return;
  for (const target of online) publishToRunTarget(target.id, { type: 'request', request });
}

/**
 * Tell a requester's targets that a request they were offered no longer waits for them: it was stopped, or `except`
 * claimed it. Each target drops it by id, and one that was never offered it ignores it.
 */
export async function publishWithdrawn(db: DbClient, requesterId: number, id: string, except?: number): Promise<void> {
  const owned = await db.select({ id: runTargets.id }).from(runTargets).where(eq(runTargets.userId, requesterId));
  for (const target of owned) if (target.id !== except) publishToRunTarget(target.id, { type: 'withdrawn', id });
}

/** Forget every listener; for tests. */
export function resetRunTargetEvents(): void {
  listeners.clear();
}
