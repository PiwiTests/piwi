/**
 * The desktop app window's view of the Playwright runs its shell starts, the pure half: which run of the Local runs
 * tray a hub session is (`desktopRunRef`), what a worker says and which controls it takes, where a stop stands, and
 * what a code made at a stop or a locator picked reads as, to copy. The hub's shapes are `@piwitests/core/run-hub`'s;
 * the stop's place and error, a test's name and what a stop takes come from the Runs window's own pure half
 * (`apps/extension/src/shared/runs.ts`), which both surfaces share, as they share its live view's input
 * (`view-input.ts`).
 */
import type { HubAction, HubCodeAction, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import type { DesktopRunPick } from '#shared/desktop-runs';
import { runFile, stopError, stopIntents, stopPlace, testName } from '../../../extension/src/shared/runs';

/** The name a run the shell started gives the bundled server on its run channel (`PIWI_RUN_REF`, `hub_env.rs`). */
export function desktopRunRef(shellId: number): string {
  return `desktop-${shellId}`;
}

/** Names a worker of a run, for what the window keeps of it (its answer, its image, its view). */
export function desktopWorkerKey(ref: string, worker: number): string {
  return `${ref}|${worker}`;
}

/** Names a stop's live view: its frames come under this key. */
export function desktopViewKey(ref: string, worker: number, since: string): string {
  return `${ref}|${worker}|${since}`;
}

/** The stopped worker's stop, while it stands there; null otherwise. */
export function desktopRunStop(worker: HubWorker): HubStop | null {
  return worker.state === 'stopped' ? worker.stop : null;
}

/** What a stop's state line says, by its reason; a failure's names where it failed. */
const STOP_WORDS: Record<Exclude<HubStop['reason'], 'failure'>, string> = {
  breakpoint: 'Stopped at a breakpoint',
  step: 'Stopped after a step',
  pause: 'Paused',
  'run-to': 'Stopped at the line it ran to',
  'page-pause': 'Stopped at page.pause()',
  other: 'Stopped',
};

/** A worker's state line: where it stopped and why, or whether it runs. */
export function desktopWorkerState(worker: HubWorker, root: string | null): string {
  const stop = desktopRunStop(worker);
  if (stop?.reason === 'failure') return `Failed at ${stopPlace(stop, root)}`;
  if (stop) return STOP_WORDS[stop.reason];
  if (worker.pausing) return 'Pausing before its next call…';
  if (worker.state === 'running') return 'Running';
  return 'Between tests';
}

/** A worker's test, its `describe` blocks' titles then its own; null between tests. */
export function desktopWorkerTest(worker: HubWorker): string | null {
  return worker.test ? testName(worker.test) : null;
}

/** What a worker's test runs under: its Playwright project and its attempt. */
export function desktopWorkerMeta(worker: HubWorker): string | null {
  const test = worker.test;
  if (!test) return null;
  return [test.project, `attempt ${test.retry + 1}`].filter(Boolean).join(' · ');
}

/** Where a stop stands, relative to the run's folder: `tests/checkout.spec.ts:5`. */
export function desktopStopPlace(stop: Pick<HubStop, 'uri' | 'line'>, root: string | null): string {
  return stopPlace(stop, root);
}

/** The error a failure's stop names, its lines kept. */
export function desktopStopError(stop: Pick<HubStop, 'error' | 'title'>): string {
  return stopError(stop);
}

/** The controls that steer a worker: Pause while it runs, Resume, Step and Finish at a stop, Resume alone at a failure. */
export type DesktopSteer = 'pause' | 'resume' | 'step' | 'finish';

export function desktopSteering(worker: HubWorker): DesktopSteer[] {
  const stop = desktopRunStop(worker);
  if (!stop) return worker.pausing || worker.state === 'between' ? [] : ['pause'];
  return stop.reason === 'failure' ? ['resume'] : ['resume', 'step', 'finish'];
}

/**
 * What a stop takes from the window (`stop.intents`): its live view, the input on it while the window watches it, a
 * pick on its image, and the code actions the desktop app makes, Assert a region and Mock a request. Pick, Record and
 * Assert in the test's window end in an editor, and the server refuses them, so they are never offered.
 */
export function desktopStopTakes(worker: HubWorker, stop: HubStop): HubAction[] {
  return stopIntents(worker, stop);
}

/** The code actions a stop offers, in the window's order. */
export function desktopCodeActions(worker: HubWorker, stop: HubStop): Array<'assert-region' | 'mock'> {
  const takes = desktopStopTakes(worker, stop);
  return (['assert-region', 'mock'] as const).filter((what) => takes.includes(what));
}

/** A run's name: its Piwi project, else its folder. */
export function desktopRunName(session: Pick<HubSession, 'project' | 'label'>): string {
  return session.project ?? session.label ?? 'Run';
}

/** What a code made at a stop is, as its heading in the window says. */
const CODE_TITLES: Record<HubCodeAction | 'assert', string> = {
  assert: 'Assert',
  'assert-region': 'Assert a region',
  mock: 'Mock a request',
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
 * lines its edits add or change, apart, so each is copied where it goes. `root` is its run's folder, when known.
 */
export function desktopCodeItem(code: StopCode, root: string | null, key: string): DesktopCopyItem {
  const block = `${code.code}\n`;
  const imports = code.edits
    .filter((edit) => edit.newText !== block)
    .map((edit) => edit.newText.replace(/\n+$/, ''))
    .filter((text) => text.trim() !== '');
  return {
    key,
    title: CODE_TITLES[code.action],
    place: `${runFile(code.uri, root)}:${code.line + 1}`,
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
