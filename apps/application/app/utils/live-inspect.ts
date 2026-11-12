import { liveWorkerKey, type LiveViewerMessage, type LiveWorkerId } from '@piwitests/core/live-view';
import type { SnapshotPhase } from '@piwitests/core/live-inspect';

/**
 * The lane panel's **Inspect**, as a model the panel renders: the snapshots of the worker's page its watch heard of
 * (`@piwitests/core/live-inspect`), each call they are of with the moments heard (before it, at its action, after it),
 * the call and moment shown (the latest call while the view follows it, else the one the reader chose), and the address
 * of its page on the instance. Nothing here holds a page: the instance renders each one.
 */

/** What a watch hears of a snapshot of its worker's page, without its JSON. */
export type HeardSnapshot = Extract<LiveViewerMessage, { type: 'snapshot'; call: string }>;

/** The most snapshots the panel lists: past them, the oldest go. */
export const MAX_HEARD_SNAPSHOTS = 600;

/** The moments of a call, in the order Playwright takes them, with the words the panel names each by. */
export const SNAPSHOT_PHASES: ReadonlyArray<{ key: SnapshotPhase; label: string; words: string }> = [
  { key: 'before', label: 'Before', words: 'before it' },
  { key: 'action', label: 'Action', words: 'at its action' },
  { key: 'after', label: 'After', words: 'after it' },
];

/** A call whose page the worker sent: its worker, its id and title, and the moments heard, in the order they came. */
export interface InspectCall {
  key: string;
  worker: LiveWorkerId;
  call: string;
  title: string;
  phases: SnapshotPhase[];
}

/** A call's moment the panel shows. */
export interface InspectMoment {
  worker: LiveWorkerId;
  call: string;
  title: string;
  phase: SnapshotPhase;
}

/** The key of a call of a worker, which the panel picks it by. */
export function inspectCallKey(worker: LiveWorkerId, call: string): string {
  return `${liveWorkerKey(worker)}#${call}`;
}

function workerOf(message: HeardSnapshot): LiveWorkerId {
  return {
    shard: message.shard,
    worker: message.worker,
    ...(message.slot === undefined ? {} : { slot: message.slot }),
  };
}

/**
 * The snapshots heard, with `message`: one of a call's moment heard already (the instance tells a watch what it keeps
 * as Inspect opens) changes nothing; past `MAX_HEARD_SNAPSHOTS`, the oldest go.
 */
export function addHeardSnapshot(heard: readonly HeardSnapshot[], message: HeardSnapshot): HeardSnapshot[] {
  const key = inspectCallKey(workerOf(message), message.call);
  if (heard.some((s) => s.phase === message.phase && inspectCallKey(workerOf(s), s.call) === key)) {
    return heard as HeardSnapshot[];
  }
  return [...heard, message].slice(-MAX_HEARD_SNAPSHOTS);
}

/** The calls the snapshots heard are of, in the order their first snapshot came. */
export function inspectCalls(heard: readonly HeardSnapshot[]): InspectCall[] {
  const calls = new Map<string, InspectCall>();
  for (const message of heard) {
    const worker = workerOf(message);
    const key = inspectCallKey(worker, message.call);
    const known = calls.get(key);
    if (known) known.phases.push(message.phase);
    else calls.set(key, { key, worker, call: message.call, title: message.title, phases: [message.phase] });
  }
  return [...calls.values()];
}

/**
 * The moment the panel shows: of the latest call while it follows (`pinned` null), else of the call pinned while the
 * list still holds it; at the moment chosen (`phase`) when that call has it, else at its latest heard. Null for none.
 */
export function shownMoment(
  calls: readonly InspectCall[],
  pinned: string | null,
  phase: SnapshotPhase | null,
): InspectMoment | null {
  const call = pinned === null ? calls.at(-1) : calls.find((c) => c.key === pinned);
  if (!call) return null;
  const shown = phase && call.phases.includes(phase) ? phase : call.phases.at(-1)!;
  return { worker: call.worker, call: call.call, title: call.title, phase: shown };
}

/**
 * The address of the page at a moment, as the watch `watch` of run `runId` reads it: the read-only render, the
 * picker's (`mode` left for the picker to add) or its viewport (`json`).
 */
export function inspectPageUrl(
  base: string,
  runId: number,
  watch: string,
  moment: InspectMoment,
  as: 'readonly' | 'picker' | 'json',
): string {
  const query = new URLSearchParams({ worker: String(moment.worker.worker) });
  if (moment.worker.shard !== null) query.set('shard', String(moment.worker.shard));
  query.set('call', moment.call);
  query.set('phase', moment.phase);
  if (as === 'readonly') query.set('mode', 'readonly');
  if (as === 'json') query.set('format', 'json');
  const path = `/api/test-runs/${runId}/live-view/watch/${encodeURIComponent(watch)}/snapshot`;
  return `${base.replace(/\/$/, '')}${path}?${query}`;
}
