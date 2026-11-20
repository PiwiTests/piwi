import { readLiveWorkerId, type LiveWorkerId } from '@piwitests/core/live-view';
import { isLayerCallId } from '@piwitests/core/live-layers';
import type { SnapshotPhase } from '@piwitests/core/live-inspect';

const PHASES: readonly string[] = ['before', 'action', 'after'];

/** The page a request for Inspect names: the worker, its call and the moment. */
export interface LiveSnapshotQuery {
  worker: LiveWorkerId;
  call: string;
  phase: SnapshotPhase;
}

/**
 * The worker, call and moment a request for a live page of Inspect names (`worker`, `shard`, `call`, `phase`), or the
 * sentence a 400 says when one is named wrongly. The server's route and the demo's read it alike.
 */
export function readLiveSnapshotQuery(query: Record<string, unknown>): LiveSnapshotQuery | string {
  const worker = readLiveWorkerId(query.shard, query.worker);
  if (!worker) return 'Name the worker: worker from 0, and shard from 1';
  const { call, phase } = query;
  if (!isLayerCallId(call) || typeof phase !== 'string' || !PHASES.includes(phase)) {
    return 'Name the call by its id, and the moment: before, action or after';
  }
  return { worker, call, phase: phase as SnapshotPhase };
}
