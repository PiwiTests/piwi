import type { LiveAskView, LiveViewRunState } from '#shared/live-view';

export interface RunLiveViewReadiness {
  desktop: boolean;
  demo: boolean;
  connected: boolean;
  /** The run's stream has not opened for `STREAM_STALL_MS`, or opened again for `STREAM_RECONNECT_STALL_MS` after a drop. */
  stalled?: boolean;
  state: LiveViewRunState | null;
  ci: boolean;
  workers: number;
  /** Tests ran for `NO_WORKER_GRACE_MS` and no worker of the run's view connected since the page opened. */
  testsWithoutWorkers: boolean;
  /** Someone turned the project's live view on from this page, after the run had started without it. */
  turnedOn?: boolean;
}

/** How long tests run before the page says no worker opened the view: workers open it before their first test. */
export const NO_WORKER_GRACE_MS = 10_000;

/**
 * What the run page can tell about watching a running run's tests: a connected worker makes them watchable whatever
 * else the stream said last, then the project's setting, the run's key, and whether the run is one a developer shares.
 */
export function runLiveViewStatus(run: RunLiveViewReadiness) {
  if (run.desktop) return { kind: 'desktop', label: 'Local preview' };
  if (run.demo) return { kind: 'demo', label: 'Demo progress' };
  if (!run.connected && run.stalled) return { kind: 'stalled', label: 'Live updates stalled' };
  if (!run.connected || !run.state) return { kind: 'checking', label: 'Live view connecting' };
  if (!run.state.enabled) return { kind: 'disabled', label: 'Live view off' };
  if (run.workers > 0) return { kind: 'available', label: 'Live view available' };
  // A run registers for the live view as it starts: one that started without it gets none, the next run does.
  if (!run.state.keyed && run.turnedOn) return { kind: 'next-run', label: 'Live view on from the next run' };
  if (!run.state.keyed) return { kind: 'unavailable', label: 'Live view unavailable' };
  if (!run.ci) return { kind: 'unshared', label: 'Not shared live' };
  // A worker opens the view from the capture fixtures, before its first test: tests without one mean none did.
  if (run.testsWithoutWorkers) return { kind: 'no-workers', label: 'No worker connected' };
  return { kind: 'waiting', label: 'Live view waiting' };
}

/** What the toolbar offers beside **Not shared live** to a viewer who may ask the developer to share the run. */
export interface AskToWatchView {
  /** What it says of the viewer's latest ask: it waits for the developer's answer, or they answered Not now. */
  note: 'asked' | 'not-now' | null;
  /** The button: **Ask to watch**, **Ask again** after an ask, or none while the viewer waits to ask again. */
  action: 'ask' | 'ask-again' | null;
  /** The minutes before the viewer may ask again, while they may not. */
  waitMinutes: number | null;
}

export interface AskToWatchInput {
  /** The toolbar's status (`runLiveViewStatus`): asking is offered only on a run that is not shared live. */
  status: string;
  /** The run's stream says this viewer may ask (`canAsk`). */
  canAsk: boolean;
  /** The viewer's latest ask, null for none. */
  ask: LiveAskView | null;
  /** When the viewer may ask again, by this browser's clock; null when they may. */
  askAgainAt: number | null;
  now: number;
}

/**
 * **Ask to watch** on a run nobody shares: offered to a viewer who may ask, then what came of their ask (waiting, Not
 * now) and, once the wait between two asks passed, **Ask again**. A shared run shows its live view instead: nothing.
 */
export function askToWatchView(input: AskToWatchInput): AskToWatchView | null {
  if (input.status !== 'unshared' || !input.canAsk) return null;
  const waiting = input.askAgainAt !== null && input.askAgainAt > input.now;
  const waitMinutes = waiting ? Math.ceil((input.askAgainAt! - input.now) / 60_000) : null;
  const answer = input.ask?.answer;
  const note = !input.ask ? null : answer === null ? 'asked' : answer === 'not-now' ? 'not-now' : null;
  if (waiting) return { note, action: null, waitMinutes };
  return { note, action: input.ask ? 'ask-again' : 'ask', waitMinutes };
}
