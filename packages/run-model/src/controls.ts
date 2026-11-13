/**
 * The controls a worker of a run takes, as a surface offers them: each one's words, icon and tone (`CONTROLS`), which
 * ones a worker takes now (`controlsOf`), and how a surface groups them: the controls that steer the test on their own
 * row (`STEERING`), Resume, Step and Finish joined (`JOINED`), and the code a stop can write that folds under More
 * once the row holds `FOLD_FROM` of it (`FOLDED`). A run of several workers has its own, Pause all and Resume all
 * (`runLevelControls`).
 */
import type {
  HubCodeIntent,
  HubControlAction,
  HubIntent,
  HubSession,
  HubStop,
  HubWindowAction,
  HubWorker,
} from '@piwitests/core/run-hub';
import { IN_WINDOW, stopIntents } from './stop';
import type { RunWordKey } from './words';

/** A control of a worker: the run controls, the actions in the test's window, Show the browser and Mock a request. */
export type Control = HubControlAction | HubIntent | HubCodeIntent | HubWindowAction | 'mock';

/**
 * The icon of a control, by its meaning, as the editors draw it: Finish steps out, End the test is blocked, and the square
 * is left to stopping the run.
 */
export type ControlIcon =
  | 'play'
  | 'skip'
  | 'step-out'
  | 'blocked'
  | 'browser'
  | 'pick'
  | 'record'
  | 'check-circle'
  | 'layers'
  | 'network'
  | 'pause';

/** How a control's button looks: the main action, one that removes, a quiet one; neutral without a tone. */
export type ControlTone = 'primary' | 'remove' | 'ghost';

/** A control's words (its label and its title), its icon and its tone. */
export interface ControlLook {
  label: RunWordKey;
  title: RunWordKey;
  icon: ControlIcon;
  tone?: ControlTone;
}

/** Each control's label, title, icon and tone. */
export const CONTROLS = {
  resume: { label: 'runs_resume', title: 'runs_resumeTitle', icon: 'play', tone: 'primary' },
  step: { label: 'runs_step', title: 'runs_stepTitle', icon: 'skip' },
  finish: { label: 'runs_finish', title: 'runs_finishTitle', icon: 'step-out' },
  end: { label: 'runs_end', title: 'runs_endTitle', icon: 'blocked', tone: 'remove' },
  'give-up': { label: 'runs_end', title: 'runs_giveUpTitle', icon: 'blocked', tone: 'remove' },
  front: { label: 'runs_front', title: 'runs_frontTitle', icon: 'browser', tone: 'ghost' },
  pick: { label: 'runs_pick', title: 'runs_pickTitle', icon: 'pick', tone: 'ghost' },
  record: { label: 'runs_record', title: 'runs_recordTitle', icon: 'record', tone: 'ghost' },
  assert: { label: 'runs_assert', title: 'runs_assertTitle', icon: 'check-circle', tone: 'ghost' },
  'assert-region': { label: 'runs_assertRegion', title: 'runs_assertRegionTitle', icon: 'layers', tone: 'ghost' },
  mock: { label: 'runs_mock', title: 'runs_mockTitle', icon: 'network', tone: 'ghost' },
  pause: { label: 'runs_pause', title: 'runs_pauseTitle', icon: 'pause' },
} as const satisfies Record<Control, ControlLook>;

/** A control's title at a stop: Resume at a failure lets the test end as it failed. */
export function controlTitle(what: Control, stop: Pick<HubStop, 'reason'> | null): RunWordKey {
  return what === 'resume' && stop?.reason === 'failure' ? 'runs_resumeFailureTitle' : CONTROLS[what].title;
}

/** The controls that steer the test, on a row of their own above the code a stop can write. */
export const STEERING: ReadonlySet<Control> = new Set(['resume', 'step', 'finish', 'front', 'end', 'give-up', 'pause']);

/** The controls that move a stopped test on, joined in one group at the start of the steering row. */
export const JOINED: ReadonlySet<Control> = new Set(['resume', 'step', 'finish']);

/**
 * The code a stop can write that folds under More, where the row holds all five actions, shown while More is open or
 * its list of requests is.
 */
export const FOLDED: ReadonlySet<Control> = new Set(['assert-region', 'mock']);

/** How many of the code a stop can write show before More folds some: fewer stay on the row. */
export const FOLD_FROM = 5;

/**
 * The controls a worker takes now: at a stop, Resume, Step and Finish (Resume alone where the test failed, which ends
 * it as it failed), Show the browser at a stop its pause bar shows, and End the test where the stop takes it; then the
 * actions the stop takes from the surface (`stopIntents`): Pick, Record, Assert and Assert a region, which start in
 * the test's window where the pause bar shows, or through the live view the surface watches at a headless stop, those
 * it takes once watched (`held`) among them, and Mock a request. While it runs, Pause.
 */
export function controlsOf(
  worker: Pick<HubWorker, 'intents' | 'pausing' | 'waiting'>,
  stop: HubStop | null,
  held: readonly Control[],
): Control[] {
  // While a Pause waits for the call the test runs, End the test there, where its worker takes it.
  if (!stop)
    return worker.pausing ? (worker.waiting && worker.intents.includes('give-up') ? ['give-up'] : []) : ['pause'];
  const controls: Control[] = stop.reason === 'failure' ? ['resume'] : ['resume', 'step', 'finish'];
  const intents = stopIntents(worker, stop);
  // Show the browser, at a stop its pause bar shows, where its worker takes it.
  if (intents.includes('front')) controls.push('front');
  if (intents.includes('end')) controls.push('end');
  controls.push(...IN_WINDOW.filter((what) => intents.includes(what) || held.includes(what)));
  if (intents.includes('mock')) controls.push('mock');
  return controls;
}

/** A stopped worker Resume all answers, at the stop it stands at (`since`). */
export interface StopAnswer {
  worker: number;
  since: string;
}

/**
 * A run's own controls, for a live run of several workers: Pause all while a worker runs a test it can stop in and no
 * Pause reached it, and Resume all while two tests or more are stopped, each stopped worker at its own stop.
 */
export function runLevelControls(session: Pick<HubSession, 'ended' | 'workers'>): {
  pauseAll: boolean;
  resumeAll: StopAnswer[];
} {
  if (session.ended || session.workers.length < 2) return { pauseAll: false, resumeAll: [] };
  const resumeAll = session.workers.flatMap((worker): StopAnswer[] =>
    worker.state === 'stopped' && worker.stop ? [{ worker: worker.worker, since: worker.stop.since }] : [],
  );
  const pauseAll = session.workers.some(
    (worker) => worker.state === 'running' && !worker.pausing && !worker.test?.cannotPause,
  );
  return { pauseAll, resumeAll: resumeAll.length > 1 ? resumeAll : [] };
}
