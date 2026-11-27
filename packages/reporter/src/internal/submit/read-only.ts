import type { HttpClient } from '../transport/http-client.js';
import { requestedRunTarget } from '../config/env.js';
import { Logger } from '../support/logger.js';

/** Said once a run, as the dashboard first refuses a request of the run as read-only. */
const READ_ONLY_WARNING =
  "The dashboard is read-only, so it takes no results for now. The tests and the run's exit code are not affected: this run's results are saved on this machine, and a later run sends them once the dashboard is writable again.";

/** Said instead for a requested run, which keeps no copy for a later run. */
const REQUESTED_RUN_READ_ONLY_WARNING =
  "The dashboard is read-only, so it takes no results for now. The tests and the run's exit code are not affected, and nothing of this run is sent.";

/**
 * Say once, as the dashboard first refuses a request of `httpClient` as read-only (`HttpClient.onReadOnly`), that it
 * takes no results for now: nothing more is sent, and the run is saved for a later run, unless it is a requested run.
 */
export function sayWhenReadOnly(httpClient: HttpClient, logger: Logger = new Logger()): void {
  httpClient.onReadOnly = () =>
    logger.warn(requestedRunTarget() !== null ? REQUESTED_RUN_READ_ONLY_WARNING : READ_ONLY_WARNING);
}
