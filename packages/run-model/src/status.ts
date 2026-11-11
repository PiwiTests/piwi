/**
 * Where a worker stands, as a surface shows it: its tone, an icon by its meaning and the message that says it, on its
 * status card (`workerStatus`) and on its tab (`tabStatus`). Rich text, such as the call a Pause waits in as code, is
 * the surface's to render.
 */
import type { HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { RunMessage, RunWordKey } from './words';

/** The tone of a worker's status: its color and its edge. */
export type WorkerTone = 'failed' | 'stopped' | 'pausing' | 'between' | 'running';

/** The icon of a worker's state, by its meaning: failed, stopped, pausing, running, between tests. */
export type WorkerIcon = 'x-circle' | 'pause' | 'clock' | 'play' | 'dot';

/** The words of a stop, by its reason; a failure's name where it failed instead (`runs_failedAt`). */
const STOP_WORDS = {
  breakpoint: 'runs_stoppedBreakpoint',
  step: 'runs_stoppedStep',
  pause: 'runs_stoppedPause',
  'run-to': 'runs_stoppedRunTo',
  'page-pause': 'runs_stoppedPagePause',
  other: 'runs_stoppedOther',
} as const satisfies Record<Exclude<HubStop['reason'], 'failure'>, RunWordKey>;

/** The words of a stop an agent asked for, by its reason: its Pause, its Step, its Run to; another reads as any stop. */
const AGENT_STOP_WORDS: Partial<Record<HubStop['reason'], RunWordKey>> = {
  pause: 'runs_stoppedByAgent',
  step: 'runs_stoppedByAgentStep',
  'run-to': 'runs_stoppedByAgentRunTo',
};

/** The words of a stop that is no failure, an agent's by its own. */
function stopWords(reason: Exclude<HubStop['reason'], 'failure'>, by: HubStop['by']): RunWordKey {
  return (by === 'agent' ? AGENT_STOP_WORDS[reason] : undefined) ?? STOP_WORDS[reason];
}

type StatusWorker = Pick<HubWorker, 'state' | 'stop' | 'pausing' | 'waiting'>;

/** A worker's state on its tab: its tone, its icon and the words of its state. */
export interface TabStatus {
  tone: WorkerTone;
  icon: WorkerIcon;
  message: RunMessage;
}

/** The tone of a worker standing at `stop`, or at none. */
function toneOf(worker: StatusWorker, stop: HubStop | null): WorkerTone {
  if (stop) return stop.reason === 'failure' ? 'failed' : 'stopped';
  if (worker.pausing) return 'pausing';
  return worker.state === 'between' ? 'between' : 'running';
}

/** A worker's state on its tab: failed, stopped and why, pausing, running, or between tests. */
export function tabStatus(worker: StatusWorker): TabStatus {
  const stop = worker.state === 'stopped' ? worker.stop : null;
  const tone = toneOf(worker, stop);
  if (stop?.reason === 'failure') return { tone, icon: 'x-circle', message: { key: 'runs_stateFailed' } };
  if (stop) return { tone, icon: 'pause', message: { key: stopWords(stop.reason, stop.by) } };
  if (worker.pausing) return { tone, icon: 'clock', message: { key: 'runs_statePausing' } };
  if (worker.state === 'running' || worker.state === 'other') {
    return { tone, icon: 'play', message: { key: 'runs_stateRunning' } };
  }
  return { tone, icon: 'dot', message: { key: 'runs_stateBetween' } };
}

/**
 * A worker's status, on the card of where it stands: as on its tab, but for a failure, which names where it failed
 * (`place`), and a Pause waiting in a call, which names the call (`waiting`: its title, and since when it runs, by the
 * hub's clock; null when its worker cannot tell).
 */
export type WorkerStatus =
  | (TabStatus & { waiting: null })
  | {
      tone: 'pausing';
      icon: 'clock';
      message: { key: 'runs_statePausingIn'; args: { call: string } };
      waiting: { title: string; since: string | null };
    };

/** A worker's status card: its tone, its icon, what it says, and the call a Pause waits in. */
export function workerStatus(worker: StatusWorker, place: string | null): WorkerStatus {
  const stop = worker.state === 'stopped' ? worker.stop : null;
  const tab = tabStatus(worker);
  if (stop?.reason === 'failure') {
    return { ...tab, message: { key: 'runs_failedAt', args: { place: place ?? '' } }, waiting: null };
  }
  if (!stop && worker.pausing && worker.waiting) {
    const { title, since } = worker.waiting;
    return {
      tone: 'pausing',
      icon: 'clock',
      message: { key: 'runs_statePausingIn', args: { call: title } },
      waiting: { title, since },
    };
  }
  return { ...tab, waiting: null };
}
