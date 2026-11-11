/**
 * The desktop app window's view of the Playwright runs its shell starts, the pure half: which run of the Local runs
 * tray a hub session is (`desktopRunRef`, `desktopRunOf`), which live runs report a run's page and which worker runs
 * each running row of it (`desktopSessionsOfRun`, `desktopRowWorker`), where a stop stands, and what a code made at a
 * stop or a locator picked reads as, to copy. The hub's shapes are `@piwitests/core/run-hub`'s. What a worker says,
 * the controls it takes, who is present, the worker a run's tabs show and which frame is the page now are the run
 * model's, which the tray shares with Piwi Picker's Runs window (`@piwitests/run-model`), said in its English words
 * (`desktopSay`), its icons mapped once to the app's (`DESKTOP_RUN_ICONS`).
 */
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';
import type { HubCodeAction, HubLive, HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import type { ControlIcon } from '@piwitests/run-model/controls';
import type { WorkerIcon, WorkerTone } from '@piwitests/run-model/status';
import { pagePoint, runFile, runName, stopSaid } from '@piwitests/run-model/stop';
import { englishRunSpeaker, type RunWordArgs, type RunWordKey } from '@piwitests/run-model/words';
import { UNATTENDED_RUN_SUFFIX, isUnattendedDesktopRun, type DesktopRunPick } from '#shared/desktop-runs';
import { parseLocation } from '#shared/parse-location';
import type { LocalRunKind } from '~/composables/useDesktopLocalRuns';
import { localRunOriginKind } from '~/utils/desktop-job';

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

/** The shell's id of the run a hub's run names (`desktopRunRef`), null for a name the shell did not give. */
export function desktopShellIdOf(ref: string): number | null {
  const match = /^desktop-(\d+)$/.exec(desktopRunOf(ref));
  return match ? Number(match[1]) : null;
}

/**
 * Whether a person attends a `playwright test` run with these arguments, as the shell reads them (`attended_args`,
 * `hub_env.rs`): not one in UI mode (`--ui`), nor one that repeats each test (`--repeat-each` above 1) unless it ends
 * at its first failure (`--max-failures=1`).
 */
export function desktopArgsAttended(args: readonly string[]): boolean {
  let repeats = false;
  let stopsAtFirstFailure = false;
  for (const [index, arg] of args.entries()) {
    if (arg === '--ui' || arg.startsWith('--ui=')) return false;
    const repeat = optionValue(args, index, '--repeat-each');
    if (repeat !== undefined && !(/^\d+$/.test(repeat) && Number(repeat) <= 1)) repeats = true;
    if (optionValue(args, index, '--max-failures') === '1') stopsAtFirstFailure = true;
  }
  return !repeats || stopsAtFirstFailure;
}

/** The value of `--name` at `args[index]`, given as `--name=value` or `--name value`; undefined for another arg. */
function optionValue(args: readonly string[], index: number, name: string): string | undefined {
  const arg = args[index]!;
  if (arg === name) return args[index + 1] ?? '';
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
}

/** A run of the Local runs tray, as far as holding its failures goes: what it is and what its steps run. */
export interface DesktopHoldRun {
  kind: LocalRunKind;
  steps: ReadonlyArray<{ args: readonly string[] }>;
  /** How the run was started: with **Hold failures** on, or not. */
  options?: { holdFailures?: boolean };
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
    return 'A run that repeats its tests goes on past each failure, unless it stops at the first one.';
  }
  return null;
}

/**
 * Whether a run holds its failures until the person says otherwise (**Hold failures** on from its start): a
 * reproduction, which runs to see its failure at its line, and a run started with the option on; every other run
 * starts with it off.
 */
export function desktopHoldsByDefault(run: Pick<DesktopHoldRun, 'kind' | 'options'>): boolean {
  return run.kind === 'reproduce' || !!run.options?.holdFailures;
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

/** Whether the person has a run of the tray hold its failures: their choice (`chosen`), else its kind's, when it can. */
export function desktopRunChosenHolds(
  run: DesktopShownRun,
  chosen: boolean | undefined,
  sessions: readonly HubSession[],
): boolean {
  return !desktopRunHoldRefusal(run, sessions) && (chosen ?? desktopHoldsByDefault(run));
}

/**
 * Whether a run of the tray holds its failures, as its switch shows it: the run's own Hold failures as its latest live
 * step says it (whoever set it: this window, Piwi Picker or an agent), else the person's choice, when it can.
 */
export function desktopRunHolds(
  run: DesktopShownRun,
  chosen: boolean | undefined,
  sessions: readonly HubSession[],
): boolean {
  if (desktopRunHoldRefusal(run, sessions)) return false;
  const held = desktopHeldSessions(run, sessions);
  const latest = held[held.length - 1];
  return latest?.hold ? latest.hold.on : desktopRunChosenHolds(run, chosen, sessions);
}

/** The live hub sessions of a run of the tray that have a Hold failures, in the hub's order. */
export function desktopHeldSessions(run: DesktopShownRun, sessions: readonly HubSession[]): HubSession[] {
  return sessions.filter((session) => !!session.hold && run.hubRefs.includes(desktopRunOf(session.ref)));
}

/**
 * The runs the window shows live, so a failure no pause bar shows is held in them: the running ones whose Hold
 * failures the person has on (`holds`, each run's choice by its key), by each step's name as the step starts, before its workers
 * connect, so a failure right after they do waits too. Opening or closing the tray, or a run's part of it, changes
 * nothing.
 */
export function desktopShownRefs(
  runs: readonly DesktopShownRun[],
  holds: Readonly<Record<number, boolean>>,
  sessions: readonly HubSession[],
): string[] {
  const held = runs.filter((run) => run.status === 'running' && desktopRunChosenHolds(run, holds[run.key], sessions));
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
  next: 'i-lucide-skip-forward',
  stop: 'i-lucide-square',
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

/** A Local runs entry, as far as finding the runs it reports goes. */
interface DesktopLinkedRun {
  kind: LocalRunKind;
  status: string;
  originRef: string | null;
  /** The Piwi run it was linked to first (**Open run #N**). */
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

/**
 * Whether an editor's run reports to the run `runId` of the server at `origin`: its page (`HubSession.page`) is that
 * run's on that server, never a run of the same number on the team instance.
 */
export function desktopEditorRunOf(
  session: Pick<HubSession, 'page' | 'ended'>,
  runId: number,
  origin: string,
): boolean {
  if (session.ended || session.page?.id !== runId) return false;
  try {
    return new URL(session.page.url).origin === origin;
  } catch {
    return false;
  }
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
 * folder, whose place shows as text (`stopPlace`).
 */
export function desktopStopLink(
  stop: Pick<HubStop, 'uri' | 'line'>,
  root: string | null,
): { file: string; line: number } | null {
  if (!root) return null;
  const file = runFile(stop.uri, root);
  return /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(file) ? null : { file, line: stop.line + 1 };
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
