/**
 * The desktop app window's view of the Playwright runs its shell starts, the pure half: which run of the Local runs
 * tray a hub session is (`desktopRunRef`, `desktopRunOf`), which live runs report a run's page and which worker runs
 * each running row of it (`desktopSessionsOfRun`, `desktopRowWorker`), what a worker says and which controls it takes,
 * where a stop stands, and what a code made at a stop or a locator picked reads as, to copy. The hub's shapes are
 * `@piwitests/core/run-hub`'s; the stop's place and error, a test's name and what a stop takes come from the Runs
 * window's own pure half (`apps/extension/src/shared/runs.ts`), which both surfaces share, as they share its live
 * view's input (`view-input.ts`).
 */
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';
import type { HubAction, HubCodeAction, HubLive, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import { UNATTENDED_RUN_SUFFIX, isUnattendedDesktopRun, type DesktopRunPick } from '#shared/desktop-runs';
import { parseLocation } from '#shared/parse-location';
import type { LocalRunKind } from '~/composables/useDesktopLocalRuns';
import { localRunOriginKind } from '~/utils/desktop-job';
import { pagePoint, runFile, stopError, stopIntents, stopPlace, testName } from '../../../extension/src/shared/runs';
import { stopWords } from '~/utils/stop-words';

/** The name a run the shell started gives the bundled server on its run channel (`PIWI_RUN_REF`, `hub_env.rs`). */
export function desktopRunRef(shellId: number): string {
  return `desktop-${shellId}`;
}

/**
 * The name the window knows a hub's run by (`desktopRunRef`): its own, the mark of a run nobody attends left out (a
 * Flake Lab's `desktop-7-unattended` is the tray's `desktop-7`).
 */
export function desktopRunOf(ref: string): string {
  return isUnattendedDesktopRun(ref) ? ref.slice(0, -UNATTENDED_RUN_SUFFIX.length) : ref;
}

/**
 * Whether a person attends a `playwright test` run with these arguments, as the shell reads them (`attended_args`,
 * `hub_env.rs`): not one in UI mode (`--ui`), nor one that repeats each test (`--repeat-each` above 1).
 */
export function desktopArgsAttended(args: readonly string[]): boolean {
  for (const [index, arg] of args.entries()) {
    if (arg === '--ui' || arg.startsWith('--ui=')) return false;
    const repeat =
      arg === '--repeat-each' ? args[index + 1] : arg.startsWith('--repeat-each=') ? arg.slice(14) : undefined;
    if (repeat !== undefined && !(/^\d+$/.test(repeat) && Number(repeat) <= 1)) return false;
  }
  return true;
}

/** A run of the Local runs tray, as far as holding its failures goes: what it is and what its steps run. */
export interface DesktopHoldRun {
  kind: LocalRunKind;
  steps: ReadonlyArray<{ args: readonly string[] }>;
}

/**
 * Why a run of the tray holds no failure whatever the person chooses, as the shell names it one nobody attends (a
 * bisect, a Flake Lab run or lab job, a run that repeats its tests or runs in UI mode); null for one that can.
 */
export function desktopHoldRefusal(run: DesktopHoldRun): string | null {
  if (run.kind === 'bisect') return 'A bisect goes on past each failure.';
  if (run.kind === 'flake') return 'A Flake Lab run goes on past each failure.';
  if (run.steps.some((step) => step.args.some((arg) => arg === '--ui' || arg.startsWith('--ui=')))) {
    return 'UI mode goes on past each failure.';
  }
  if (!run.steps.every((step) => desktopArgsAttended(step.args))) {
    return 'A run that repeats its tests goes on past each failure.';
  }
  return null;
}

/**
 * Whether a run holds its failures until the person says otherwise (**Hold failures** on from its start): a
 * reproduction, which runs to see its failure at its line; every other run starts with it off.
 */
export function desktopHoldsByDefault(run: Pick<DesktopHoldRun, 'kind'>): boolean {
  return run.kind === 'reproduce';
}

/** A run of the tray, as far as showing it live goes: its hold, its state and its steps' names on the hub. */
export interface DesktopShownRun extends DesktopHoldRun {
  key: number;
  status: string;
  hubRefs: readonly string[];
}

/**
 * Why a run of the tray holds no failure whatever the person chooses: one nobody attends, by its kind
 * (`desktopHoldRefusal`) or as the hub names its steps (`sessions`, the hub's live runs); null for one that can.
 */
export function desktopRunHoldRefusal(run: DesktopShownRun, sessions: readonly HubSession[]): string | null {
  const refused = desktopHoldRefusal(run);
  if (refused) return refused;
  const unattended = sessions.some(
    (session) => isUnattendedDesktopRun(session.ref) && run.hubRefs.includes(desktopRunOf(session.ref)),
  );
  return unattended ? 'Nobody attends a run of this kind: it goes on past each failure.' : null;
}

/** Whether a run of the tray holds its failures: the person's choice (`chosen`), else its kind's, when it can. */
export function desktopRunHolds(
  run: DesktopShownRun,
  chosen: boolean | undefined,
  sessions: readonly HubSession[],
): boolean {
  return !desktopRunHoldRefusal(run, sessions) && (chosen ?? desktopHoldsByDefault(run));
}

/**
 * The runs the window shows live, so a failure no pause bar shows is held in them: the running ones whose Hold
 * failures is on (`holds`, each run's choice by its key), by each step's name as the step starts, before its workers
 * connect, so a failure right after they do waits too. Opening or closing the tray, or a run's part of it, changes
 * nothing.
 */
export function desktopShownRefs(
  runs: readonly DesktopShownRun[],
  holds: Readonly<Record<number, boolean>>,
  sessions: readonly HubSession[],
): string[] {
  const held = runs.filter((run) => run.status === 'running' && desktopRunHolds(run, holds[run.key], sessions));
  return [...new Set(held.flatMap((run) => run.hubRefs))].sort();
}

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

/** What a running worker says in place of **Watch** when its reporter shows a stopped test alone. */
export const DESKTOP_WATCH_NEEDS_UPDATE = 'Update the reporter to watch a running test.';

/** Whether a worker's lane can be watched while its test runs (`watch` among what its reporter takes). */
export function desktopWatchesLane(worker: Pick<HubWorker, 'intents'>): boolean {
  return worker.intents.includes('watch');
}

/** Where a frame of a lane stands: the worker that sent it, its test and the stop it shows (null while it runs). */
export interface DesktopLaneAt {
  worker: number;
  test: string | null;
  since: string | null;
}

/**
 * Whether a lane's frame shows the worker's page as it is now: the stop it stands at, else the test it runs. A frame of
 * a stop it went on from, of an earlier test, between two tests or of the worker Playwright ran in the lane before is
 * the page as it last showed.
 */
export function desktopLaneFrameCurrent(frame: DesktopLaneAt, worker: HubWorker): boolean {
  if (frame.worker !== worker.worker) return false;
  const stop = desktopRunStop(worker);
  if (stop) return frame.since === stop.since;
  return frame.since === null && worker.state !== 'between' && !!worker.test && frame.test === worker.test.id;
}

/** Where the clicks and keys on a live image go: a stop of a worker, and whether its input carries click counts. */
export interface DesktopRunInputTarget {
  ref: string;
  worker: number;
  since: string;
  clickCounts: boolean;
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

/** What the state line says of a stop an agent asked for (its Pause, Step or Run to), for the person watching. */
const AGENT_STOP_WORDS: Partial<Record<HubStop['reason'], string>> = {
  pause: 'Paused by the agent',
  step: 'Stopped after the agent’s step',
  'run-to': 'Stopped at the line the agent ran it to',
};

/** A worker's state line: where it stopped and why, the call a Pause waits in, or whether it runs. */
export function desktopWorkerState(worker: HubWorker, root: string | null): string {
  const stop = desktopRunStop(worker);
  if (stop?.reason === 'failure') return `Failed at ${stopPlace(stop, root)}`;
  if (stop) return (stop.by === 'agent' ? AGENT_STOP_WORDS[stop.reason] : undefined) ?? stopWords(stop.reason);
  if (worker.pausing && worker.waiting) return `Pausing: waits in ${worker.waiting.title}`;
  if (worker.pausing) return 'Pausing before its next call…';
  if (worker.state === 'running' || worker.state === 'other') return 'Running';
  return 'Between tests';
}

/**
 * How long the call a Pause waits in has run at `now` (`for 12 s`, `for 2 min 5 s`); null while no Pause waits in a
 * call, or its worker cannot tell when the call began.
 */
export function desktopWaitedFor(worker: HubWorker, now: number): string | null {
  const since = worker.pausing && !desktopRunStop(worker) ? worker.waiting?.since : null;
  const ms = since ? now - Date.parse(since) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `for ${seconds} s` : `for ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** A Local runs entry, as far as finding the runs it reports goes. */
interface DesktopLinkedRun {
  kind: LocalRunKind;
  status: string;
  originRef: string | null;
  /** The Piwi run it was linked to first (**Live in Piwi**). */
  piwiRunId: number | null;
  /** Its steps' names on the hub. */
  hubRefs: readonly string[];
}

/** A Piwi run, as far as finding the Local runs entry that reports it goes: its id and the origin its metadata records. */
interface DesktopReportedRun {
  id: number;
  kind: string;
  ref: string | null;
}

/**
 * The live runs of the running Local runs entry that reports the Piwi run `run`, by the origin the shell stamps on each
 * run of an entry (`PIWI_ORIGIN`, `PIWI_ORIGIN_REF`): each step of a Re-run in several Playwright projects and each step
 * of a bisect reports a run of its own under it. Of several running entries under one origin (two reproductions of one
 * cluster), the one linked to the run alone, and none until it is linked. None for a run whose origin names no
 * reference.
 */
export function desktopSessionsOfRun(
  run: DesktopReportedRun | null,
  runs: readonly DesktopLinkedRun[],
  sessions: readonly HubSession[],
): HubSession[] {
  if (!run?.ref) return [];
  const running = runs.filter(
    (entry) => entry.status === 'running' && entry.originRef === run.ref && localRunOriginKind(entry.kind) === run.kind,
  );
  const entry = running.find((one) => one.piwiRunId === run.id) ?? (running.length === 1 ? running[0] : undefined);
  if (!entry) return [];
  return sessions.filter((session) => entry.hubRefs.includes(desktopRunOf(session.ref)));
}

/** A running row of a run's page, as far as finding the worker that runs its test goes. */
interface DesktopRunRow {
  status: string;
  /** The test's own title. */
  title: string;
  /** `file:line:column` of its `test(…)` call, the file relative to its Playwright config's folder. */
  location?: string | null;
  /** Playwright's worker index. */
  workerIndex?: number | null;
}

/** A worker of a live run, with its run. */
export interface DesktopRowWorker {
  session: HubSession;
  worker: HubWorker;
}

/**
 * The worker that runs a running row's test now, among the live runs that report to the row's run: the one the row
 * names (Playwright's worker index), whose test is the row's by its own title, its spec and the line of its
 * `test(…)` call. Null for a row that does not run, or whose worker runs another test now (its next one, before the
 * row's end came).
 */
export function desktopRowWorker(sessions: readonly HubSession[], row: DesktopRunRow): DesktopRowWorker | null {
  if (row.status !== 'running' || row.workerIndex == null || !row.location) return null;
  const { filePath, line } = parseLocation(row.location);
  if (line === null) return null;
  // A spec outside the config's folder comes as `../tests/…`: it is matched by its path below that folder's parents.
  const below = filePath.replace(/^(?:\.\.?\/)+/, '');
  for (const session of sessions) {
    for (const worker of session.workers) {
      const test = worker.test;
      if (worker.worker !== row.workerIndex || !test) continue;
      if (test.title.at(-1) !== row.title || test.line + 1 !== line) continue;
      if (runFile(test.uri, null).endsWith(`/${below}`)) return { session, worker };
    }
  }
  return null;
}

/**
 * A stop's file, relative to the run's folder, and its 1-based line, for a link that opens it in the editor; null for
 * a run with no folder of its own (a reproduction or a bisect step, in a throwaway worktree) or a file outside its
 * folder, whose place shows as text (`desktopStopPlace`).
 */
export function desktopStopLink(
  stop: Pick<HubStop, 'uri' | 'line'>,
  root: string | null,
): { file: string; line: number } | null {
  if (!root) return null;
  const file = runFile(stop.uri, root);
  return /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(file) ? null : { file, line: stop.line + 1 };
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

/** What the window says of a stop it hears: the test, and where it failed or stopped. */
export function desktopStopSaid(session: HubSession, worker: HubWorker, stop: HubStop): string {
  const test = desktopWorkerTest(worker) ?? desktopRunName(session);
  const place = desktopStopPlace(stop, session.root);
  return stop.reason === 'failure' ? `${test} failed at ${place}.` : `${test} stopped at ${place}.`;
}

/** The error a failure's stop names, its lines kept. */
export function desktopStopError(stop: Pick<HubStop, 'error' | 'title'>): string {
  return stopError(stop);
}

/**
 * The controls that steer a worker: Pause while it runs, Resume, Step and Finish at a stop, and End the test where the
 * stop takes it (`stop.intents`); Resume alone at a failure, which it ends as it failed. While a Pause waits for the
 * call the test runs, End the test there (`give-up`), where its worker takes it.
 */
export type DesktopSteer = 'pause' | 'resume' | 'step' | 'finish' | 'end' | 'give-up';

export function desktopSteering(worker: HubWorker): DesktopSteer[] {
  const stop = desktopRunStop(worker);
  if (!stop && worker.pausing) return worker.waiting && worker.intents.includes('give-up') ? ['give-up'] : [];
  if (!stop) return worker.state === 'between' ? [] : ['pause'];
  if (stop.reason === 'failure') return ['resume'];
  const steering: DesktopSteer[] = ['resume', 'step', 'finish'];
  if (stopIntents(worker, stop).includes('end')) steering.push('end');
  return steering;
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
