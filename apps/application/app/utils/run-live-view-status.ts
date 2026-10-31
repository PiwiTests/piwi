import type { LiveViewRunState } from '#shared/live-view';

export interface RunLiveViewReadiness {
  desktop: boolean;
  demo: boolean;
  connected: boolean;
  state: LiveViewRunState | null;
  ci: boolean;
  workers: number;
  /** Tests ran for `NO_WORKER_GRACE_MS` and no worker of the run's view connected since the page opened. */
  testsWithoutWorkers: boolean;
}

/** How long tests run before the page says no worker opened the view: workers open it before their first test. */
export const NO_WORKER_GRACE_MS = 10_000;

/**
 * What the run page can tell about watching a running run's tests: a connected worker makes them watchable whatever
 * else the stream said last, then the project's setting, the run's key, and whether the run is one a developer shares.
 */
export function runLiveViewStatus(run: RunLiveViewReadiness) {
  if (run.desktop) return { kind: 'desktop', label: 'Local preview at a pause' };
  if (run.demo) return { kind: 'demo', label: 'Demo progress' };
  if (!run.connected || !run.state) return { kind: 'checking', label: 'Live view connecting' };
  if (!run.state.enabled) return { kind: 'disabled', label: 'Live view off' };
  if (run.workers > 0) return { kind: 'available', label: 'Live view available' };
  if (!run.state.keyed) return { kind: 'unavailable', label: 'Live view unavailable' };
  if (!run.ci) return { kind: 'unshared', label: 'Not shared live' };
  // A worker opens the view from the capture fixtures, before its first test: tests without one mean none did.
  if (run.testsWithoutWorkers) return { kind: 'no-workers', label: 'No worker connected' };
  return { kind: 'waiting', label: 'Live view waiting' };
}
