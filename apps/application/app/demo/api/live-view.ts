/**
 * The demo's side of a live run's view. A simulated CI worker posts its held failure and its end (`POST
 * /api/test-runs/:id/live-view`, `apiPostDemoLiveStop`), which the run page hears as the instance's relay tells it
 * (`live-worker`), and **Let it go** (`apiDemoLetGo`) reaches the simulator that holds it over the demo's channel. A
 * simulated CI worker that can pause says so as it starts (`pauses`), its paused stop and its end the same way, and
 * **Pause**, **Resume** and **End the test** (`apiDemoControl`) reach the simulator that runs it over the same channel.
 *
 * The page of a demo worker at a call, for Inspect (`GET /api/test-runs/:id/live-view/watch/:watch/snapshot`). The demo
 * runs no browser: the pages its simulated workers name are moments of the committed checkout trace
 * (`DEMO_INSPECT_TRACE`, `DEMO_TRACE_CALLS`), rendered as the server renders a stored trace's (`dom-snapshot.ts`), and
 * served as the server serves a live page: the read-only render or the picker's, as a sandboxed document
 * (`snapshot-frame-html.ts`), or its viewport (`format=json`). The demo's watch lives in the page, so any watch of a
 * live run may read them.
 */
import { eq } from 'drizzle-orm';
import { liveWorkerKey, readWorkerToInstance, type LiveWorkerId } from '@piwitests/core/live-view';
import { isLiveControlCommand } from '@piwitests/core/live-view';
import {
  CONTROL_CANNOT_PAUSE,
  CONTROL_DONE,
  CONTROL_NOT_PAUSED,
  CONTROL_STOPPED,
  LET_GO_DONE,
  LET_GO_NOT_HELD,
  LET_GO_SETTING_OFF,
  PAUSE_SETTING_OFF,
  type LiveWorkerState,
} from '#shared/live-view';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { projects, testRuns } from '~~/server/database/schema.sqlite';
import {
  snapshotFrameHeaders,
  snapshotFrameHtml,
  snapshotFrameInlineHtml,
  snapshotFrameMode,
  snapshotFrameNonce,
} from '~~/server/utils/snapshot-frame-html';
import { DEMO_INSPECT_TRACE, DEMO_TRACE_CALLS, demoTraceCall, type DemoTracePhase } from '../live-calls';
import { readLiveSnapshotQuery } from '~~/server/utils/live-snapshot-query';
import { getDemoDb } from '../db.client';
import { getDemoTraceMoment } from './dom-snapshot';
import { demoHttpError } from './http-error';
import { publishDemoControl, publishDemoLetGo, publishDemoRunEvent } from '../run-events';

export async function apiGetDemoLiveSnapshot(runId: number, query: URLSearchParams): Promise<unknown> {
  const params = Object.fromEntries(query);
  const read = readLiveSnapshotQuery(params);
  if (typeof read === 'string') throw demoHttpError(400, read);
  const { call, phase } = read;
  const db = await getDemoDb();
  const [run] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) throw demoHttpError(404, 'No such watch of this run.');
  if (!(UNFINISHED_RUN_STATUSES as readonly string[]).includes(run.status)) {
    throw demoHttpError(410, 'The run is no longer live.');
  }
  const traced = Object.values(DEMO_TRACE_CALLS).find((one) => one.call === demoTraceCall(call));
  const page = traced?.phases.includes(phase as DemoTracePhase)
    ? await getDemoTraceMoment(DEMO_INSPECT_TRACE, { callId: traced.call, phase: phase as DemoTracePhase })
    : null;
  if (!page?.html) throw demoHttpError(404, 'The demo has no page of this call at that moment.');
  if (params.format === 'json') return { viewport: page.viewport ?? null };
  const nonce = snapshotFrameNonce();
  // The demo's frames take the document inline (`srcdoc`), which no header reaches: it carries its policy itself.
  return new Response(snapshotFrameInlineHtml(snapshotFrameHtml(page.html, snapshotFrameMode(params), nonce), nonce), {
    status: 200,
    headers: snapshotFrameHeaders(nonce),
  });
}

/** The held failures of the simulated workers of each live run, by `liveWorkerKey`. */
const heldWorkers = new Map<number, Map<string, LiveWorkerState>>();

/**
 * The simulated workers of each live run that can pause, while their project lets its controllers pause, by
 * `liveWorkerKey`: each one's state as the run page hears it, and who asked its latest Pause (`asked`, the empty string
 * for nobody named; absent while none was asked).
 */
const pausingWorkers = new Map<number, Map<string, { state: LiveWorkerState; asked?: string }>>();

/** The run's live state and its project's settings; null for a run that is no longer live. */
async function demoLiveRun(runId: number): Promise<{ hold: boolean; pause: boolean } | null> {
  const db = await getDemoDb();
  const [run] = await db
    .select({ status: testRuns.status, hold: projects.liveViewHold, pause: projects.liveViewPause })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, runId));
  if (!run || !(UNFINISHED_RUN_STATUSES as readonly string[]).includes(run.status)) return null;
  return { hold: run.hold, pause: run.hold && run.pause };
}

/**
 * A simulated CI worker of run `runId` posts its held failure, its paused stop or its end (a `stop`), the simulator
 * having seen the demo's view show the worker in full: the run page hears it as the instance tells it, held for
 * `heldFor`. A held failure is taken (`held: true`) only while the run's project holds failing CI tests and the person
 * acting may control the run (`controls`), as the instance holds one only for a controller; a paused stop only after a
 * Pause the demo took (`apiDemoControl`), named by who asked it; otherwise the worker goes on at once, and nothing
 * reaches the page. A worker that can pause says so with its first post (`pauses: true` beside a stop of none), which
 * the run page hears while the project lets its controllers pause (`pauses: false` forgets it).
 */
export async function apiPostDemoLiveStop(
  runId: number,
  body: unknown,
  who: { controls: boolean; heldFor: string[] },
): Promise<{ success: true; held: boolean }> {
  const message = readWorkerToInstance(body);
  if (typeof message === 'string') throw demoHttpError(400, message);
  if (message.type !== 'stop') throw demoHttpError(400, 'A simulated worker posts its stops alone.');
  const run = await demoLiveRun(runId);
  if (!run) throw demoHttpError(410, 'The run is no longer live.');
  const { type: _type, stop, ...id } = message;
  const key = liveWorkerKey(id);
  const pausing = pausingWorkers.get(runId) ?? new Map<string, { state: LiveWorkerState; asked?: string }>();
  const says = (body as { pauses?: unknown }).pauses;
  if (says === false) pausing.delete(key);
  if (says === true && !stop && run.pause && !pausing.has(key)) {
    const state: LiveWorkerState = { ...id, connected: true, paused: null, holds: true, heldFor: [], pauses: true };
    pausing.set(key, { state });
    pausingWorkers.set(runId, pausing);
    publishDemoRunEvent(runId, { type: 'live-worker', data: { ...state } });
    return { success: true, held: false };
  }
  if (!pausing.size) pausingWorkers.delete(runId);
  const paused = pausing.get(key);
  if (stop?.reason === 'pause') {
    if (!run.pause || !paused || paused.asked === undefined || paused.state.paused) {
      return { success: true, held: false };
    }
    const by = paused.asked ? { pausedBy: paused.asked } : {};
    paused.state = { ...id, connected: true, paused: stop, holds: true, heldFor: [], pauses: true, ...by };
    publishDemoRunEvent(runId, { type: 'live-worker', data: { ...paused.state } });
    return { success: true, held: true };
  }
  // The worker went on, or dropped a Pause no call took.
  if (!stop && paused && (paused.state.paused || paused.asked !== undefined)) {
    delete paused.asked;
    if (!paused.state.paused) return { success: true, held: false };
    paused.state = { ...id, connected: true, paused: null, holds: true, heldFor: [], pauses: true };
    publishDemoRunEvent(runId, { type: 'live-worker', data: { ...paused.state } });
    return { success: true, held: false };
  }
  const holding = heldWorkers.get(runId) ?? new Map<string, LiveWorkerState>();
  if (stop?.reason === 'held' && (!run.hold || !who.controls)) return { success: true, held: false };
  // The end of a hold the demo never took reaches nothing.
  if (!stop && !holding.has(key)) return { success: true, held: false };
  const state: LiveWorkerState = {
    ...id,
    connected: true,
    paused: stop,
    holds: true,
    heldFor: stop?.reason === 'held' ? who.heldFor : [],
    ...(paused ? { pauses: true } : {}),
  };
  if (stop?.reason === 'held') holding.set(key, state);
  else holding.delete(key);
  if (holding.size) heldWorkers.set(runId, holding);
  else heldWorkers.delete(runId);
  publishDemoRunEvent(runId, { type: 'live-worker', data: { ...state } });
  return { success: true, held: stop?.reason === 'held' };
}

/**
 * **Pause**, **Resume** or **End the test** of run `runId`'s simulated `worker`, asked by `by` (the person acting, empty
 * for nobody named), as the server's route answers it: 400 for a body that names no worker or another command; 409
 * while the project does not let its controllers pause, for a worker that cannot pause, Pause while its test stands at
 * a stop, and Resume or End the test while it is not paused. Each reaches the simulator over the demo's channel.
 */
export async function apiDemoControl(runId: number, body: unknown, by: string): Promise<unknown> {
  const named = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const worker: LiveWorkerId | null =
    named && typeof named.watch === 'string' && typeof named.worker === 'number'
      ? { shard: typeof named.shard === 'number' ? named.shard : null, worker: named.worker }
      : null;
  const command = named?.command;
  if (!worker || !isLiveControlCommand(command)) {
    throw demoHttpError(400, 'Name your watch of the run, the worker it shows, and the command: pause, resume or end');
  }
  const run = await demoLiveRun(runId);
  if (!run) throw demoHttpError(404, 'Test run not found');
  if (!run.pause) throw demoHttpError(409, PAUSE_SETTING_OFF);
  const paused = pausingWorkers.get(runId)?.get(liveWorkerKey(worker));
  if (!paused) throw demoHttpError(409, CONTROL_CANNOT_PAUSE);
  if (command === 'pause') {
    if (paused.state.paused || paused.asked !== undefined) throw demoHttpError(409, CONTROL_STOPPED);
    paused.asked = by;
  } else if (paused.state.paused?.reason !== 'pause') {
    throw demoHttpError(409, CONTROL_NOT_PAUSED);
  }
  const { shard, worker: index, slot } = paused.state;
  publishDemoControl(runId, { shard, worker: index, ...(slot === undefined ? {} : { slot }) }, command);
  return { success: true, message: CONTROL_DONE[command] };
}

/**
 * **Let it go** of run `runId`'s held `worker`, as the server's route answers it: 409 while the project does not hold
 * failing CI tests, or for a worker that holds nothing.
 */
export async function apiDemoLetGo(runId: number, body: unknown): Promise<unknown> {
  const named = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const worker: LiveWorkerId | null =
    named && typeof named.watch === 'string' && typeof named.worker === 'number'
      ? { shard: typeof named.shard === 'number' ? named.shard : null, worker: named.worker }
      : null;
  if (!worker) throw demoHttpError(400, 'Name your watch of the run, and the worker it shows');
  const db = await getDemoDb();
  const [run] = await db
    .select({ hold: projects.liveViewHold })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, runId));
  if (!run) throw demoHttpError(404, 'Test run not found');
  if (!run.hold) throw demoHttpError(409, LET_GO_SETTING_OFF);
  const held = heldWorkers.get(runId)?.get(liveWorkerKey(worker));
  if (!held) throw demoHttpError(409, LET_GO_NOT_HELD);
  publishDemoLetGo(runId, {
    shard: held.shard,
    worker: held.worker,
    ...(held.slot === undefined ? {} : { slot: held.slot }),
  });
  return { success: true, message: LET_GO_DONE };
}
