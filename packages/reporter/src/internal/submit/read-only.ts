import type { HttpClient } from '../transport/http-client.js';
import { requestedRunTarget } from '../config/env.js';
import { Logger } from '../support/logger.js';

const NOT_AFFECTED = "The tests and the run's exit code are not affected.";

/** Said once a run, as the dashboard first refuses a request of the run as read-only. */
const READ_ONLY_WARNING = `The dashboard is read-only, so it takes no results for now. ${NOT_AFFECTED}`;

/** Said instead for a requested run, which keeps no copy for a later run. */
const REQUESTED_RUN_READ_ONLY_WARNING =
  "The dashboard is read-only, so it takes no results for now. The tests and the run's exit code are not affected, and nothing of this run is sent.";

/** Said instead once the dashboard holds the run's results, as it refuses what was left to send of the run. */
const RESULTS_HELD_READ_ONLY_WARNING = `The dashboard is read-only, so it takes nothing more for now: it holds this run's results, and what was left to send of the run (traces, videos, screenshots, reports or coverage) was not sent. ${NOT_AFFECTED}`;

/** Said once the run's copy is saved on this machine, as the dashboard took none of its results. */
export const READ_ONLY_COPY_SAVED =
  "This run's results are saved on this machine: a later run sends them once the dashboard is writable again.";

/**
 * Say once, as the dashboard first refuses a request of `httpClient` as read-only (`HttpClient.onReadOnly`), that it
 * takes nothing for now: that it holds the run's results when `resultsHeld` says it took them, else that it takes no
 * results. The run's copy, when one is saved, is said apart (`READ_ONLY_COPY_SAVED`).
 */
export function sayWhenReadOnly(
  httpClient: HttpClient,
  logger: Logger = new Logger(),
  resultsHeld: () => boolean = () => false,
): void {
  httpClient.onReadOnly = () => {
    if (resultsHeld()) logger.warn(RESULTS_HELD_READ_ONLY_WARNING);
    else logger.warn(requestedRunTarget() !== null ? REQUESTED_RUN_READ_ONLY_WARNING : READ_ONLY_WARNING);
  };
}
