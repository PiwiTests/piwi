/**
 * The waiting rows of a project's runs list: the CI dispatches no run has answered yet, which everyone who reads the
 * project sees, and the viewer's own run requests still going on, which only they see. A dispatch's row leaves once a
 * run is matched to it, since that run then shows in the list. A request's run is private and never in the list, so
 * its row stays while that run goes on, linking it, and leaves once the request ends.
 */
import type { StatusPaletteKey } from '@piwitests/run-ui/status-palette';
import { isOpenCiDispatch, type CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';
import {
  CI_DISPATCH_LIKELY_CAUSES,
  CI_DISPATCH_WAIT_HINT_MS,
  ciDispatchTargetName,
  runRequestIsFinal,
  runRequestSentence,
  runRequestStatusKey,
} from '#shared/run-follow-up';

/** One waiting row. */
export interface WaitingRunRow {
  kind: 'dispatch' | 'request';
  /** The dispatch's or the request's id. */
  id: string;
  /** The palette entry of its dot. */
  status: StatusPaletteKey;
  /** Where it stands: `Waiting for CI`, `Running in Piwi Desktop`. */
  lead: string;
  /** What it runs, through what and on which branch: `Smoke · staging on main`, `3 tests`. */
  facts: string;
  /** Epoch ms of the dispatch or the request. */
  at: number;
  /** Who dispatched it; null for a request, which is the viewer's own. */
  by: string | null;
  /** The CI's page for a dispatch: its run once known, else its runs list. */
  ciUrl: string | null;
  /** A request's run, once it started one. */
  runId: number | null;
  /** Why a dispatch's run has not reported, once it has waited long. */
  causes: string[];
}

/** How many rows show before **Show all**. */
export const WAITING_ROWS_SHOWN = 5;

/** How many open dispatches the list reads. */
export const WAITING_DISPATCHES_READ = 20;

const testCount = (n: number) => `${n} test${n === 1 ? '' : 's'}`;

/** What a dispatch runs: its tests, a Flake Lab experiment, or the action's whole suite (named by the action alone). */
function dispatchWhat(dispatch: Pick<CiDispatchView, 'kind' | 'tests'>): string | null {
  if (dispatch.kind === 'flakeLab') return 'Flake Lab';
  if (dispatch.kind === 'tests' && dispatch.tests) return testCount(dispatch.tests);
  return null;
}

/** A dispatch's row, or null once a run answered it, or it can no longer be answered. */
export function waitingDispatchRow(dispatch: CiDispatchView, now = Date.now()): WaitingRunRow | null {
  if (!isOpenCiDispatch(dispatch)) return null;
  const through = dispatch.actionName ?? ciDispatchTargetName(dispatch);
  const waitedLong = now - dispatch.at >= CI_DISPATCH_WAIT_HINT_MS;
  return {
    kind: 'dispatch',
    id: dispatch.id,
    status: 'interrupted',
    lead: waitedLong ? 'No run reported yet' : 'Waiting for CI',
    facts: [dispatchWhat(dispatch), dispatch.ref ? `${through} on ${dispatch.ref}` : through]
      .filter(Boolean)
      .join(' · '),
    at: dispatch.at,
    by: dispatch.byName,
    ciUrl: dispatch.url,
    runId: null,
    causes: waitedLong ? CI_DISPATCH_LIKELY_CAUSES : [],
  };
}

/** A request's row, or null once it ended. */
export function waitingRequestRow(request: RunRequestView): WaitingRunRow | null {
  if (runRequestIsFinal(request)) return null;
  const only = request.tests.length === 1 ? request.tests[0] : undefined;
  return {
    kind: 'request',
    id: request.id,
    status: runRequestStatusKey(request),
    lead: runRequestSentence(request),
    facts: only ? only.title : testCount(request.tests.length),
    at: Date.parse(request.createdAt),
    by: null,
    ciUrl: null,
    runId: request.runId,
    causes: [],
  };
}

/** The rows of a project's open dispatches and of the viewer's requests, newest first. */
export function waitingRunRows(
  dispatches: readonly CiDispatchView[],
  requests: readonly RunRequestView[],
  now = Date.now(),
): WaitingRunRow[] {
  const rows = [
    ...dispatches.map((d) => waitingDispatchRow(d, now)),
    ...requests.map((r) => waitingRequestRow(r)),
  ].filter((row): row is WaitingRunRow => row !== null);
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/**
 * How many ms until the rows are read again: every 5 s while a request's row shows, since its app moves it on in
 * seconds; every 30 s while only dispatches wait, since a run's start also reads them again; null with no row.
 */
export function waitingRunsPollMs(rows: readonly Pick<WaitingRunRow, 'kind'>[]): number | null {
  if (rows.some((row) => row.kind === 'request')) return 5_000;
  return rows.length > 0 ? 30_000 : null;
}
