/**
 * The page of a demo worker at a call, for Inspect (`GET /api/test-runs/:id/live-view/watch/:watch/snapshot`). The demo
 * runs no browser: the pages its simulated workers name are moments of the committed checkout trace
 * (`DEMO_INSPECT_TRACE`, `DEMO_TRACE_CALLS`), rendered as the server renders a stored trace's (`dom-snapshot.ts`), and
 * served as the server serves a live page: the read-only render or the picker's, as a sandboxed document
 * (`snapshot-frame-html.ts`), or its viewport (`format=json`). The demo's watch lives in the page, so any watch of a
 * live run may read them.
 */
import { eq } from 'drizzle-orm';
import { readLiveWorkerId } from '@piwitests/core/live-view';
import { isLayerCallId } from '@piwitests/core/live-layers';
import { UNFINISHED_RUN_STATUSES } from '#shared/run-eligibility';
import { testRuns } from '~~/server/database/schema.sqlite';
import { snapshotFrameHeaders, snapshotFrameHtml, snapshotFrameMode } from '~~/server/utils/snapshot-frame-html';
import { DEMO_INSPECT_TRACE, DEMO_TRACE_CALLS, type DemoTracePhase } from '../live-calls';
import { getDemoDb } from '../db.client';
import { getDemoTraceMoment } from './dom-snapshot';
import { demoHttpError } from './http-error';

const PHASES: readonly string[] = ['before', 'action', 'after'];

/** A nonce for the frame's script, as the server makes one for each document. */
function frameNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

export async function apiGetDemoLiveSnapshot(runId: number, query: URLSearchParams): Promise<unknown> {
  const params = Object.fromEntries(query);
  if (!readLiveWorkerId(params.shard, params.worker)) {
    throw demoHttpError(400, 'Name the worker: worker from 0, and shard from 1');
  }
  const { call, phase } = params;
  if (!isLayerCallId(call) || typeof phase !== 'string' || !PHASES.includes(phase)) {
    throw demoHttpError(400, 'Name the call by its id, and the moment: before, action or after');
  }
  const db = await getDemoDb();
  const [run] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, runId));
  if (!run) throw demoHttpError(404, 'No such watch of this run.');
  if (!(UNFINISHED_RUN_STATUSES as readonly string[]).includes(run.status)) {
    throw demoHttpError(410, 'The run is no longer live.');
  }
  const traced = Object.values(DEMO_TRACE_CALLS).find((one) => one.call === call);
  const page = traced?.phases.includes(phase as DemoTracePhase)
    ? await getDemoTraceMoment(DEMO_INSPECT_TRACE, { callId: call, phase: phase as DemoTracePhase })
    : null;
  if (!page?.html) throw demoHttpError(404, 'The demo has no page of this call at that moment.');
  if (params.format === 'json') return { viewport: page.viewport ?? null };
  const nonce = frameNonce();
  return new Response(snapshotFrameHtml(page.html, snapshotFrameMode(params), nonce), {
    status: 200,
    headers: snapshotFrameHeaders(nonce),
  });
}
