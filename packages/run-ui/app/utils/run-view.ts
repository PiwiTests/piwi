/**
 * A shell window's view of the Playwright runs its host is the hub of (`@piwitests/editor/shell-runs`), the pure half
 * the dashboard's desktop window and Piwi Runner's window share: what the window keeps each worker, view and lane under,
 * where a stop stands, the run model's words in English (`desktopSay`) and its icons mapped once to lucide's
 * (`DESKTOP_RUN_ICONS`), what Share live says, and what a code made at a stop or a locator picked reads as, to copy.
 * The hub's shapes are `@piwitests/core/run-hub`'s; what a worker says, the controls it takes and who is present are
 * the run model's (`@piwitests/run-model`), which Piwi Picker's Runs window shares.
 */
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';
import type { HubCodeAction, HubLive, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import type { DesktopRunPick } from '@piwitests/editor/shell-run-events';
import type { ControlIcon } from '@piwitests/run-model/controls';
import type { WorkerIcon, WorkerTone } from '@piwitests/run-model/status';
import { pagePoint, runFile, runName, stopSaid } from '@piwitests/run-model/stop';
import { englishRunSpeaker, type RunWordArgs, type RunWordKey } from '@piwitests/run-model/words';

/** Names a worker of a run, for what the window keeps of it (its answer, its image, its view). */
export function desktopWorkerKey(ref: string, worker: number): string {
  return `${ref}|${worker}`;
}

/** Names a stop's live view: its frames come under this key. */
export function desktopViewKey(ref: string, worker: number, since: string): string {
  return `${ref}|${worker}|${since}`;
}

/** Names a lane of a run (Playwright's `parallelIndex`), for the window's watch of it and its frames. */
export function desktopLaneKey(ref: string, lane: number): string {
  return `${ref}|lane ${lane}`;
}

/** The run a lane's key names (`desktopLaneKey`). */
export function desktopLaneRun(key: string): string {
  return key.slice(0, key.lastIndexOf('|lane '));
}

/** The desktop app's hub, as the run model reads it (`laneWatchOf`): it shows a worker's lane while its test runs. */
export const DESKTOP_RUN_HUB = { lanes: true } as const;

/** Where a frame of a lane stands: the worker that sent it, its test and the stop it shows (null while it runs). */
export interface DesktopLaneAt {
  worker: number;
  test: string | null;
  since: string | null;
}

/**
 * Where the clicks and keys on a live image go: a stop of a worker, whether its input carries click counts, and whether
 * an action runs in the test's window there (`acting`), whose Escape is the page's.
 */
export interface DesktopRunInputTarget {
  ref: string;
  worker: number;
  since: string;
  clickCounts: boolean;
  acting: boolean;
}

/** The image of a live view as its component exposes it (`DesktopRunLiveImage`). */
export interface DesktopLiveImageHandle {
  /** Shows a JPEG frame once decoded, the latest alone waiting meanwhile; `shown` runs as it shows. */
  draw(frame: { width: number; height: number; data: string }, shown?: () => void): void;
  /** Shows none of the frames waiting or decoding: the image keeps the one it shows. */
  drop(): void;
  /** Shows nothing, and drops the frame waiting. */
  clear(): void;
  /** Gives the image the keyboard. */
  focus(): void;
  /** Takes no more input, what it played ending well: resolves once what waited went out. */
  release(): Promise<void>;
  /** The viewport, in CSS pixels, of the frame shown; null before the first. */
  viewport: { width: number; height: number } | null;
}

/** Where a pointer event is on an image of a page, in CSS pixels of the viewport it shows; null with no size. */
export function desktopImagePoint(
  img: Pick<HTMLElement, 'getBoundingClientRect' | 'clientLeft' | 'clientTop' | 'clientWidth' | 'clientHeight'>,
  event: Pick<MouseEvent, 'clientX' | 'clientY'>,
  viewport: { width: number; height: number },
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  return pagePoint(
    { x: event.clientX - rect.left - img.clientLeft, y: event.clientY - rect.top - img.clientTop },
    { width: img.clientWidth, height: img.clientHeight },
    viewport,
  );
}

/** The stopped worker's stop, while it stands there; null otherwise. */
export function desktopRunStop(worker: HubWorker): HubStop | null {
  return worker.state === 'stopped' ? worker.stop : null;
}

/** The run model's words as the window says them, in English (`englishRunSpeaker`). */
export function desktopSay(key: RunWordKey, args?: RunWordArgs): string {
  return englishRunSpeaker.say(key, args);
}

/**
 * The run model's words around one of their placeholders (`slot`), for a surface that sets its value apart (the call
 * a Pause waits in, as code): the words before it and after it, the other placeholders filled from `args`.
 */
export function desktopSaidAround(key: RunWordKey, slot: string, args: RunWordArgs = {}): [string, string] {
  const mark = '\u0000';
  const [before = '', after = ''] = desktopSay(key, { ...args, [slot]: mark }).split(mark);
  return [before, after];
}

/** The run model's icons (a worker's state, a control) as the app's own (lucide), by their meaning. */
export const DESKTOP_RUN_ICONS: Record<WorkerIcon | ControlIcon, string> = {
  'x-circle': 'i-lucide-circle-x',
  pause: 'i-lucide-pause',
  clock: 'i-lucide-clock',
  play: 'i-lucide-play',
  dot: 'i-lucide-dot',
  skip: 'i-lucide-redo-dot',
  'step-out': 'i-lucide-arrow-up-from-dot',
  blocked: 'i-lucide-ban',
  browser: 'i-lucide-app-window',
  pick: 'i-lucide-crosshair',
  record: 'i-lucide-circle-dot',
  'check-circle': 'i-lucide-circle-check',
  layers: 'i-lucide-layers',
  network: 'i-lucide-arrow-down-up',
};

/**
 * The color of a worker's tone, from the app's tokens: stopped in the warning color, failed in the error color, running
 * (and pausing) in the running status color, between tests muted.
 */
export const DESKTOP_TONE_COLORS: Record<WorkerTone, string> = {
  stopped: 'var(--ui-warning)',
  failed: 'var(--ui-error)',
  pausing: 'var(--color-status-running)',
  running: 'var(--color-status-running)',
  between: 'var(--ui-text-muted)',
};

/**
 * How long the call a Pause waits in has run at `now` (`for 12 s`, `for 2 min 5 s`); null while no Pause waits in a
 * call, or its worker cannot tell when the call began.
 */
export function desktopWaitedFor(worker: HubWorker, now: number): string | null {
  const since = worker.pausing && !desktopRunStop(worker) ? worker.waiting?.since : null;
  const ms = since ? now - Date.parse(since) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const time = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return desktopSay('runs_waitedFor', { time });
}

/** What the window says of a stop it hears: the test, and where it failed or stopped (`stopSaid`). */
export function desktopStopSaid(session: HubSession, worker: HubWorker, stop: HubStop): string {
  return stopSaid(session, worker, stop, englishRunSpeaker);
}

/** A run's name: its Piwi project, else its folder (`runName`). */
export function desktopRunName(session: Pick<HubSession, 'project' | 'label'>): string {
  return runName(session, englishRunSpeaker);
}

/**
 * What Share live sends, and who sees it, asked before the window first shares a run in this session of the app: the
 * instance's name in it when the run's page names one.
 */
export function desktopShareWarning(live: Pick<HubLive, 'page'>): string {
  const instance = desktopLiveInstance(live) ?? 'the Piwi instance this run reports to';
  return (
    `While this run is shared on ${instance}, anyone with its page open there sees each stop of its tests: the ` +
    "call, its file and line, and the test's title, even while nobody watches. While someone watches a worker, " +
    "images of its test's page go there too, each with its call and the test's title. Anyone who can open the run " +
    'there can watch, and on an instance with authentication off, anyone who can reach it. Nothing is stored, and ' +
    'Stop sharing ends it within seconds.'
  );
}

/**
 * Whether the window offers Share live for a run: one that reports to this app itself never is, since no teammate
 * reaches the app; any other is, a refusal said once asked.
 */
export function desktopShareOffered(live: Pick<HubLive, 'refused'> | null | undefined): boolean {
  return !!live && live.refused !== LIVE_SHARE_MISSING.local;
}

/** The instance a run's page is on, as the window names it (its host); null without a page. */
export function desktopLiveInstance(live: Pick<HubLive, 'page'>): string | null {
  if (!live.page) return null;
  try {
    return new URL(live.page).host || null;
  } catch {
    return null;
  }
}

/** What the window says of a run shared live: where, and how many views of it are open there. */
export function desktopLiveText(live: HubLive): string {
  const instance = desktopLiveInstance(live);
  const where = instance ? `Shared live on ${instance}` : 'Shared live';
  if (live.viewers === 0) return `${where} · nobody watches yet`;
  return `${where} · ${live.viewers === 1 ? '1 view open' : `${live.viewers} views open`}`;
}

/**
 * What **Stop sharing** asks before it stops sharing a run live: the run by its number once its process named its page,
 * what closes on the instance, and that nothing more of the run goes there.
 */
export function desktopStopSharingQuestion(session: {
  page?: { id: number } | null;
  live: Pick<HubLive, 'page' | 'viewers'>;
}): { title: string; body: string } {
  const title = `Stop sharing ${session.page ? `run #${session.page.id}` : 'the run'} live?`;
  const instance = desktopLiveInstance(session.live) ?? 'the team instance';
  const viewers = session.live.viewers;
  if (viewers === 0) return { title, body: `Nothing more of it goes to ${instance}.` };
  const views =
    viewers === 1 ? `The view open on ${instance} closes` : `The ${viewers} views open on ${instance} close`;
  return { title, body: `${views}, and nothing more of the run goes there.` };
}

/**
 * What a code made at a stop is, as its heading in the window says. The steps, an assertion and a locator for the
 * stopped line come from an agent alone here (the app takes no Record nor Assert), and say so.
 */
const CODE_TITLES: Record<HubCodeAction | 'assert', string> = {
  assert: 'Assertion the agent made',
  'assert-region': 'Assert a region',
  mock: 'Mock a request',
  steps: 'Steps the agent took',
  locator: 'Locator the agent picked',
};

/** A code made at a stop, or a locator picked, as the window lists it to copy. */
export interface DesktopCopyItem {
  /** Names the item in the list. */
  key: string;
  title: string;
  /** Where it goes: a file relative to its run's folder and the 1-based line; null when the test named none. */
  place: string | null;
  /** What Copy copies: the block, or the locator. */
  text: string;
  /** The import lines the block needs, at the top of its file: none for a locator or a file that has them. */
  imports: string[];
  /** The block is code, the locator a locator. */
  kind: 'code' | 'locator';
  /** The sentence that came with the code: what to check in it. */
  warnings: string[];
}

/**
 * A code made at a stop as the window lists it: the block written above the stopped statement, and the import
 * lines its edits add or change, apart, so each is copied where it goes; or a locator for the stopped line's, with
 * that line's place. `root` is its run's folder, when known.
 */
export function desktopCodeItem(code: StopCode, root: string | null, key: string): DesktopCopyItem {
  const place = `${runFile(code.uri, root)}:${code.line + 1}`;
  if (code.action === 'locator') {
    return { key, title: CODE_TITLES.locator, place, text: code.code, imports: [], kind: 'locator', warnings: [] };
  }
  const block = `${code.code}\n`;
  const imports = code.edits
    .filter((edit) => edit.newText !== block)
    .map((edit) => edit.newText.replace(/\n+$/, ''))
    .filter((text) => text.trim() !== '');
  return {
    key,
    title: CODE_TITLES[code.action],
    place,
    text: code.code,
    imports,
    kind: 'code',
    warnings: code.warnings,
  };
}

/** A locator a test picked, as the window lists it: the call's place, when the test named it. */
export function desktopPickItem(pick: DesktopRunPick, key: string): DesktopCopyItem {
  return {
    key,
    title: 'Locator picked',
    place: pick.file && pick.line ? `${pick.file}:${pick.line}` : null,
    text: pick.locator,
    imports: [],
    kind: 'locator',
    warnings: [],
  };
}

/** A JPEG in base64 the window may put in an image's address: its alphabet checked again, whatever sent it. */
export function isDesktopRunImage(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}
