import type { LiveViewRunState } from '#shared/live-view';

export interface RunLiveViewReadiness {
  desktop: boolean;
  demo: boolean;
  connected: boolean;
  state: LiveViewRunState | null;
  enabled: boolean;
  ci: boolean;
  workers: number;
}

/** What the instance can establish about watching a running run's browser. */
export function runLiveViewStatus(run: RunLiveViewReadiness) {
  if (run.desktop) {
    return {
      kind: 'desktop',
      label: 'Local preview at a pause',
    };
  }
  if (run.demo) {
    return {
      kind: 'demo',
      label: 'Demo progress',
    };
  }
  if (!run.connected || !run.state) {
    return {
      kind: 'checking',
      label: 'Live view connecting',
    };
  }
  if (!(run.state.enabled ?? run.enabled)) {
    return {
      kind: 'disabled',
      label: 'Live view off',
    };
  }
  if (!run.state.keyed) {
    return {
      kind: 'unavailable',
      label: 'Live view unavailable',
    };
  }
  if (run.workers > 0) {
    return {
      kind: 'available',
      label: 'Live view available',
    };
  }
  if (!run.ci) {
    return {
      kind: 'unshared',
      label: 'Not shared live',
    };
  }
  return {
    kind: 'waiting',
    label: 'Live view waiting',
  };
}
