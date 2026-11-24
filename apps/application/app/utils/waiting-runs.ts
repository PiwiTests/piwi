/**
 * The waiting rows of a project's runs list, each a follow-up view (`#shared/run-follow-up`) with the words its row
 * leads with: the CI dispatches no run has answered yet, or whose run goes on, which everyone who reads the project
 * sees, and the viewer's own run requests still going on, which only they see. A dispatch's row stays while its run
 * goes on, since the list's scope may leave that run out (a re-run or a Flake Lab run is partial); a request's run is
 * private and never in the list, so its row stays until the request ends.
 */
import type { CiDispatchView } from '#shared/ci-dispatches';
import type { RunRequestView } from '#shared/handlers/run-requests';
import { ciDispatchFollowUp, runFollowUpFacts, runRequestFollowUp, type RunFollowUpView } from '#shared/run-follow-up';

/** One waiting row: where it stands, first, then what it runs, through what and on which branch. */
export interface WaitingRunRow extends RunFollowUpView {
  /** `Waiting for CI`, `No run reported yet`, `Running`, or a request's own sentence. */
  lead: string;
  /** `3 tests · Smoke · staging on main` (`runFollowUpFacts`). */
  facts: string;
}

/** How many rows show before **Show all**. */
export const WAITING_ROWS_SHOWN = 5;

/** How many open dispatches the list reads. */
export const WAITING_DISPATCHES_READ = 20;

/**
 * A dispatch's row: waiting for its run, until it has waited long enough that the likely causes show, or with its
 * run while that run goes on. Null once it is final, or once its run stopped going on.
 */
export function waitingDispatchRow(dispatch: CiDispatchView, now = Date.now()): WaitingRunRow | null {
  const view = ciDispatchFollowUp(dispatch, now);
  if (view.final || (view.run && view.status !== 'running')) return null;
  const lead = view.run ? 'Running' : view.causes.length > 0 ? 'No run reported yet' : 'Waiting for CI';
  return { ...view, lead, facts: runFollowUpFacts(view) };
}

/** A request's row, led by where it stands, or null once it ended. */
export function waitingRequestRow(request: RunRequestView): WaitingRunRow | null {
  const view = runRequestFollowUp(request);
  return view.final ? null : { ...view, lead: view.sentence, facts: runFollowUpFacts(view) };
}

/** The rows of a project's open dispatches and of the viewer's requests, newest first. */
export function waitingRunRows(
  dispatches: readonly CiDispatchView[],
  requests: readonly RunRequestView[],
  now = Date.now(),
): WaitingRunRow[] {
  const rows = [...dispatches.map((d) => waitingDispatchRow(d, now)), ...requests.map(waitingRequestRow)].filter(
    (row): row is WaitingRunRow => row !== null,
  );
  return rows.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/**
 * How many ms until the rows of one kind are read again, null when none of that kind shows: a request's every 5 s
 * until its run starts, as its app moves it on in seconds, then every 30 s; a dispatch's every 30 s. A run event of
 * the project reads them too.
 */
export function waitingRunsPollMs(
  rows: readonly Pick<WaitingRunRow, 'kind' | 'run'>[],
  kind: WaitingRunRow['kind'],
): number | null {
  const shown = rows.filter((row) => row.kind === kind);
  if (shown.length === 0) return null;
  return kind === 'request' && shown.some((row) => row.run == null) ? 5_000 : 30_000;
}
