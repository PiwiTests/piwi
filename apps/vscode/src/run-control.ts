/**
 * The runs the editor started, as the extension shows and steers them, with no VS Code API, so it is tested without
 * an editor: the sessions kept from `piwi/runSessionChanged` (the latest of each ref, one that ended dropped), where
 * each stopped worker stands, what a new stop opens and where (its file, with the focus or without, and its page), what
 * the controls and the code actions offer in each state, the line shown above a stop, the stop a control acts on, the
 * breakpoints sent to each run as they change, the page a stop shows as an image, the responses Mock a request lists,
 * the count of the locator at the cursor, the code a stop sends to write, a run shared live on the team instance
 * (Share live: what it sends, how it stands), the workers a panel can watch while their test runs and what the panel
 * says of one, and the edits of the documents since a run started, which map a line of the run's code to the document
 * as it stands and back.
 */
import type {
  EditorBreakpoint,
  LocatorAtCaretParams,
  LocatorAtCaretResult,
  PausedImage,
  RunControlAction,
  RunLive,
  RunSession,
  RunStop,
  RunTake,
  RunTest,
  RunWaiting,
  RunWorker,
  SetRunBreakpointsParams,
  StopActionKind,
  StopBindResult,
  StopCode,
  StopRequest,
} from '@piwitests/editor/protocol';
import type { ViewInput } from '@piwitests/core/run-view';
import { RUN_STOP_WORDS } from '@piwitests/editor/protocol';

/**
 * A change of a document's lines: its old lines `start` to `oldEnd` became the lines `start` to `newEnd`. `first`
 * says the new first line goes on the old first one (text before the change stayed on it), `last` that the new last
 * line goes on the old last one (text after the change stayed on it).
 */
export interface LineEdit {
  start: number;
  oldEnd: number;
  newEnd: number;
  first: boolean;
  last: boolean;
}

/** A document change as the editor reports it: the range it replaced, in the text before, and the text put there. */
export interface TextChange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

/**
 * The lines a change moves; null for a change within one line, which moves none. `lineAfter` reads a line of the
 * document after the change, when it is the only change of its event: the text that stayed around the change tells
 * which old lines go on. Without it, the lines the change touched are unclear.
 */
export function lineEditOf(change: TextChange, lineAfter?: (line: number) => string | undefined): LineEdit | null {
  const parts = change.text.split(/\r\n|\r|\n/);
  const added = parts.length - 1;
  const { start, end } = change.range;
  if (!added && start.line === end.line) return null;
  const newEnd = start.line + added;
  // Where the text after the change starts on the new last line.
  const after = added ? parts[added]!.length : start.character + change.text.length;
  return {
    start: start.line,
    oldEnd: end.line,
    newEnd,
    first: !!lineAfter?.(start.line)?.slice(0, start.character).trim(),
    last: !!lineAfter?.(newEnd)?.slice(after).trim(),
  };
}

/**
 * Of an event's changes, all placed in the text before it, how many lines those wholly above `change` add (fewer
 * than none for lines removed): a line of the document after `change` alone stands that many lines lower once the
 * event applied. Null when another change shares one of its lines, which leaves the text around it unclear.
 */
export function linesAbove(change: TextChange, changes: readonly TextChange[]): number | null {
  let shift = 0;
  for (const other of changes) {
    if (other === change) continue;
    if (other.range.end.line < change.range.start.line) {
      shift += other.text.split(/\r\n|\r|\n/).length - 1 - (other.range.end.line - other.range.start.line);
    } else if (other.range.start.line <= change.range.end.line) {
      return null;
    }
  }
  return shift;
}

function forwardLine(edit: LineEdit, line: number): number {
  if (line < edit.start) return line;
  if (line > edit.oldEnd) return line + edit.newEnd - edit.oldEnd;
  if (line === edit.start && edit.first) return edit.start;
  if (line === edit.oldEnd && edit.last) return edit.newEnd;
  return edit.start;
}

function backLine(edit: LineEdit, line: number): number | null {
  if (line < edit.start) return line;
  if (line > edit.newEnd) return line - edit.newEnd + edit.oldEnd;
  if (line === edit.start && edit.first) return edit.start;
  if (line === edit.newEnd && edit.last) return edit.oldEnd;
  return null;
}

/**
 * The edits that moved the documents' lines, in order, while a run is live: a run's code is the documents as they
 * stood when it started (`now`), and a line goes between it and a document as it stands through the edits since.
 */
export class EditLog {
  private at = 0;
  private readonly edits = new Map<string, Array<{ at: number; edit: LineEdit }>>();

  /** Where the log stands: a run that starts now maps its lines from here. */
  now(): number {
    return this.at;
  }

  add(uri: string, edit: LineEdit): void {
    const list = this.edits.get(uri) ?? [];
    list.push({ at: ++this.at, edit });
    this.edits.set(uri, list);
  }

  /** A line of the document as it stood at `since`, as it stands now: where its text went, when it was removed. */
  forward(uri: string, line: number, since: number): number {
    for (const { at, edit } of this.edits.get(uri) ?? []) if (at > since) line = forwardLine(edit, line);
    return line;
  }

  /** A line of the document as it stands, as it stood at `since`; null for a line made since or an edit leaves unclear. */
  back(uri: string, line: number, since: number): number | null {
    const list = this.edits.get(uri) ?? [];
    let found: number | null = line;
    for (let i = list.length - 1; found !== null && i >= 0 && list[i]!.at > since; i--) {
      found = backLine(list[i]!.edit, found);
    }
    return found;
  }

  /** Drop the edits made before `since`, the start of the oldest run kept; all of them with no run. */
  forget(since: number): void {
    for (const [uri, list] of this.edits) {
      const kept = list.filter((e) => e.at > since);
      if (kept.length) this.edits.set(uri, kept);
      else this.edits.delete(uri);
    }
  }
}

/** The sessions kept, by ref: the latest of each run that has not ended. */
export type Sessions = ReadonlyMap<string, RunSession>;

/**
 * A session heard, with what the runs were given (`runs`, by ref): the sessions kept with it (`withSession`), and
 * whether it is new to them (`fresh`). A run new to them that was not started here, or a rerun of a command under the
 * ref of a run that ended (VS Code's **Tasks: Rerun Last Task**), maps its lines from `now`, the edits since its start;
 * a run that ended is forgotten.
 */
export function heardSession(
  sessions: Sessions,
  runs: Map<string, RunBreakpoints>,
  session: RunSession,
  now: number,
): { sessions: Map<string, RunSession>; fresh: boolean } {
  const fresh = !session.ended && !sessions.has(session.ref);
  if (fresh && !runs.has(session.ref)) remember(runs, session.ref, runStarted(now, null));
  if (session.ended) runs.delete(session.ref);
  return { sessions: withSession(sessions, session), fresh };
}

/** `sessions` with the session heard: the latest of its ref kept, one that ended dropped. */
export function withSession(sessions: Sessions, session: RunSession): Map<string, RunSession> {
  const next = new Map(sessions);
  if (session.ended) next.delete(session.ref);
  else next.set(session.ref, session);
  return next;
}

/** A session whose stops and tests name their files as `spell` spells a document's URI, which they are compared with. */
export function spelledSession(session: RunSession, spell: (uri: string) => string): RunSession {
  return {
    ...session,
    workers: session.workers.map((w) => ({
      ...w,
      test: w.test && { ...w.test, uri: spell(w.test.uri) },
      stop: w.stop && { ...w.stop, uri: spell(w.stop.uri) },
    })),
  };
}

/**
 * A worker stopped: its run, the worker and its slot (`RunWorker.parallelIndex`, which the worker Playwright starts in
 * its place after a failure keeps), where it stands, the test it runs, what its reporter takes there, and whether its
 * run was started in a terminal (`RunSession.terminal`), and of those by the editor's own test runner
 * (`RunSession.runner`).
 */
export interface ShownStop {
  ref: string;
  worker: number;
  slot: number;
  stop: RunStop;
  test: RunTest | null;
  takes: readonly RunTake[];
  terminal?: boolean;
  runner?: boolean;
}

/** Every stopped worker of the sessions, in their order. */
export function stopsOf(sessions: Sessions): ShownStop[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers.flatMap((w) =>
      w.stop
        ? [
            {
              ref: s.ref,
              worker: w.worker,
              slot: w.parallelIndex,
              stop: w.stop,
              test: w.test,
              takes: w.takes ?? [],
              ...(s.terminal ? { terminal: true } : {}),
              ...(s.terminal && s.runner ? { runner: true } : {}),
            },
          ]
        : [],
    ),
  );
}

/** What tells a stop from another: its run, its worker and when it stopped. */
export function stopKey(stop: ShownStop): string {
  return `${stop.ref}\0${stop.worker}\0${stop.stop.since}`;
}

/** What tells a worker's slot from another: its run and its slot. */
function slotKey(stop: { ref: string; slot: number }): string {
  return `${stop.ref}\0${stop.slot}`;
}

/** How long the paused page view and the focus wait for the next stop of a slot stepped or run to the cursor. */
export const RESERVED_MS = 10_000;

/**
 * How long after a control from the editor answered a stop, until another stop of that slot opens or no worker of the
 * run holds the slot, a run key acts on no other slot's stop, nor starts a debug session (`piwi.runResumed`).
 */
export const RESUMED_KEY_MS = 2_000;

/** What a change of the stops shows: the stops new to the editor, and a page. */
export interface StopsChange {
  /** The stops new to the editor, in order: each opens its file at its line in its turn (`focusFor`, `opened`). */
  open: ShownStop[];
  /** The stop whose page the paused page view opens; null leaves the view as it is. */
  page: ShownStop | null;
}

/**
 * Whether input sent to a stop's page is the person acting on it: a press, a click, a key, text or the wheel; a pointer
 * moving, or a button or key let go, is not.
 */
export function actsOnPage(events: readonly ViewInput[]): boolean {
  return events.some((e) => e.type === 'text' || e.type === 'wheel' || (e.action !== 'move' && e.action !== 'up'));
}

/** What a control from the editor records: the slot the person is on, a wait for a slot's next stop, and the answer. */
interface Recorded {
  followed: string | null;
  reserved: { slot: string; key: string; until: number } | null;
  answer: { slot: string; key: string; at: number } | null;
}

/** When each of `Recorded` last changed, by a count of the changes. */
type Stamps = Record<keyof Recorded, number>;

const RECORDED: readonly (keyof Recorded)[] = ['followed', 'reserved', 'answer'];

/**
 * What the editor shows of the stops as they change, each stop once, and which stop a run key acts on.
 *
 * - A new stop opens its file at its line. It takes the focus, decided as it opens (`focusFor`), only as a stop of the
 *   slot the person is on, or while no other stop held had its file opened (`opened`, a tab closed since included).
 *   The slot the person is on is the one whose stop last took the focus, or that they last acted on: a control from
 *   the editor (`answered`), a code action, or a press, a key, text, the wheel or a pick on a page (`acted`,
 *   `actsOnPage`). Watching a slot in the worker panel does not make it theirs.
 * - After a Step or a Run to the cursor from the editor, until another stop of that slot opens, `RESERVED_MS` at most
 *   and while a worker of the run holds the slot, no stop of another slot takes the focus, and the paused page view,
 *   once its own stop of that slot went on, waits for it (`waitsUntil`, when the editor asks again). An answer the run
 *   refuses undoes what it recorded that nothing changed since (`refused`).
 * - The paused page view shows the stops the worker panel does not (`watched`); a held stop the panel showed is offered
 *   again as a new one once the panel no longer shows it. The view keeps the stop it shows (`view`) while that stop is
 *   held; otherwise it opens the first new stop no pause bar shows, else the first such stop held. A view that is
 *   closed opens the first new such stop.
 */
export class StopsShown {
  /**
   * The stops heard, those whose file opened, those the person was shown (their file in sight), and the headless ones
   * the worker panel shows, by `stopKey`.
   */
  private readonly heard = new Set<string>();
  private readonly files = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly panel = new Set<string>();
  private held = new Set<string>();
  /** The stop the paused page view shows, or showed last; null while it is closed. */
  private viewed: ShownStop | null = null;
  /**
   * What the controls and the person's acts recorded, each stamped as it changes: the slot the person is on
   * (`followed`), the slot stepped or run to the cursor whose next stop (a stop of the slot other than the one stepped,
   * `key`) the focus and the view wait for (`reserved`), and the slot a control answered last, until another of its
   * stops opens (`answer`); all by `slotKey`.
   */
  private readonly recorded: Recorded = { followed: null, reserved: null, answer: null };
  private readonly stamps: Stamps = { followed: 0, reserved: 0, answer: 0 };
  private changes = 0;
  /** The answers sent and not settled, by token: what each replaced and what it set, for a refusal to undo. */
  private readonly answers = new Map<number, { was: Recorded; wasStamps: Stamps; stamps: Stamps }>();

  private get followed() {
    return this.recorded.followed;
  }
  private set followed(value: Recorded['followed']) {
    this.record('followed', value);
  }
  private get reserved() {
    return this.recorded.reserved;
  }
  private set reserved(value: Recorded['reserved']) {
    this.record('reserved', value);
  }
  private get answer() {
    return this.recorded.answer;
  }
  private set answer(value: Recorded['answer']) {
    this.record('answer', value);
  }
  private record<K extends keyof Recorded>(field: K, value: Recorded[K]): void {
    this.recorded[field] = value;
    this.stamps[field] = ++this.changes;
  }

  /**
   * The sessions changed, with their stops held now at the lines they stand on (`stops`, in order); `watched` tells a
   * stop the worker panel shows.
   */
  changed(
    sessions: Sessions,
    stops: readonly ShownStop[],
    { watched = () => false, now = Date.now() }: { watched?: (stop: ShownStop) => boolean; now?: number } = {},
  ): StopsChange {
    const slots = new Set(
      [...sessions.values()].flatMap((s) => s.workers.map((w) => slotKey({ ref: s.ref, slot: w.parallelIndex }))),
    );
    if (this.reserved && (this.reserved.until <= now || !slots.has(this.reserved.slot))) this.reserved = null;
    if (this.answer && !slots.has(this.answer.slot)) this.answer = null;
    this.held = new Set(stops.map(stopKey));
    for (const set of [this.heard, this.files, this.seen, this.panel])
      for (const key of set) if (!this.held.has(key)) set.delete(key);
    const open = stops.filter((s) => !this.heard.has(stopKey(s)));
    for (const stop of open) this.heard.add(stopKey(stop));
    const paged = (s: ShownStop) => !s.stop.bar && !watched(s);
    // The stops new to the page: those heard now, and those the panel showed until now.
    const offered = stops.filter((s) => open.includes(s) || (this.panel.has(stopKey(s)) && !watched(s)));
    for (const s of stops) {
      if (!s.stop.bar && watched(s)) this.panel.add(stopKey(s));
      else this.panel.delete(stopKey(s));
    }
    const viewed = this.viewed;
    if (!viewed) return { open, page: offered.find(paged) ?? null };
    if (this.held.has(stopKey(viewed))) return { open, page: null };
    const reserved = this.reserved?.slot === slotKey(viewed) ? this.reserved : null;
    if (reserved) {
      const next = stops.find((s) => slotKey(s) === reserved.slot && stopKey(s) !== reserved.key);
      if (!next) return { open, page: null };
      if (paged(next)) return { open, page: next };
    }
    return { open, page: offered.find(paged) ?? stops.find(paged) ?? null };
  }

  /** The paused page view shows `stop`'s page; null once it is closed. */
  view(stop: ShownStop | null): void {
    this.viewed = stop;
  }

  /** When the view stops waiting for a slot's next stop, for `changed` to run then; null while it waits for none. */
  waitsUntil(): number | null {
    return this.reserved?.until ?? null;
  }

  /** Whether `stop`'s file, opening now, takes the focus. */
  focusFor(stop: ShownStop, now = Date.now()): boolean {
    const slot = slotKey(stop);
    if (this.reserved && this.reserved.until > now && this.reserved.slot !== slot) return false;
    return slot === this.followed || [...this.files].every((key) => key === stopKey(stop));
  }

  /**
   * `stop`'s file opened, with the focus or without it, in sight (`shown`) or not. Another stop of the slot waited for
   * ends the wait, as does a stop of another slot that took the focus; another stop of the slot answered ends the
   * moments after the answer.
   */
  opened(stop: ShownStop, focus: boolean, shown = true): void {
    const key = stopKey(stop);
    if (!this.held.has(key)) return;
    this.files.add(key);
    if (shown) this.seen.add(key);
    const { reserved, answer } = this;
    if (reserved && reserved.key !== key && (focus || reserved.slot === slotKey(stop))) this.reserved = null;
    if (answer && answer.key !== key && answer.slot === slotKey(stop)) this.answer = null;
    if (focus) this.followed = slotKey(stop);
  }

  /**
   * A control from the editor answers `stop` (`action`), as it is sent: the person is on its slot, and after a Step or
   * a Run to the cursor the focus and the view wait for its next stop. The token to settle the answer with (`refused`,
   * `taken`).
   */
  answered(stop: ShownStop, action: RunControlAction, now = Date.now()): number {
    const slot = slotKey(stop);
    const was = { ...this.recorded };
    const wasStamps = { ...this.stamps };
    this.followed = slot;
    this.answer = { slot, key: stopKey(stop), at: now };
    this.reserved =
      action === 'step' || action === 'run-to' ? { slot, key: stopKey(stop), until: now + RESERVED_MS } : null;
    const token = ++this.changes;
    this.answers.set(token, { was, wasStamps, stamps: { ...this.stamps } });
    return token;
  }

  /**
   * The run refused the answer `token` names (`ok: false`): of what it recorded, what nothing changed since goes back
   * to what it was, and what a later answer replaced is what that one puts back if refused. Whether anything went
   * back.
   */
  refused(token: number): boolean {
    const refused = this.answers.get(token);
    if (!refused) return false;
    this.answers.delete(token);
    let undone = false;
    const undo = <K extends keyof Recorded>(field: K) => {
      if (this.stamps[field] === refused.stamps[field]) {
        this.recorded[field] = refused.was[field];
        this.stamps[field] = refused.wasStamps[field];
        undone = true;
        return;
      }
      for (const later of this.answers.values()) {
        if (later.wasStamps[field] !== refused.stamps[field]) continue;
        later.was[field] = refused.was[field];
        later.wasStamps[field] = refused.wasStamps[field];
      }
    };
    for (const field of RECORDED) undo(field);
    return undone;
  }

  /** The run took the answer `token` names, or its answer is unknown: what it recorded stays. */
  taken(token: number): void {
    this.answers.delete(token);
  }

  /**
   * The person acted on `stop` (a code action, or a press, a key, text, the wheel or a pick on its page): they are on
   * its slot, and a wait for another slot's next stop ends. Whether it ended one.
   */
  acted(stop: ShownStop): boolean {
    this.followed = slotKey(stop);
    if (!this.reserved || this.reserved.slot === slotKey(stop)) return false;
    this.reserved = null;
    return true;
  }

  /**
   * The stop a key, or a command naming none, acts on among `candidates` (those `stopsFor` gives for `caret`). For a
   * control (`control`) within `RESUMED_KEY_MS` of an answer, until another stop of that slot opens, only a stop of
   * that slot, whatever the caret says. Else the one at the caret's line, else the only one when the person was shown
   * its file or its page. `ask` has the person choose among them; null acts on none.
   */
  choose(
    candidates: readonly ShownStop[],
    caret: { uri: string; line: number } | null,
    control: boolean,
    now = Date.now(),
  ): ShownStop | 'ask' | null {
    const answer = control && this.answer && now - this.answer.at < RESUMED_KEY_MS ? this.answer : null;
    if (answer) return candidates.find((s) => slotKey(s) === answer.slot) ?? null;
    const here = candidates.filter((s) => caret && s.stop.uri === caret.uri && s.stop.line === caret.line);
    if (here.length) return here.length === 1 ? here[0]! : 'ask';
    if (!candidates.length) return null;
    const only = candidates.length === 1 ? candidates[0]! : null;
    return only && (this.seen.has(stopKey(only)) || (this.viewed && stopKey(this.viewed) === stopKey(only)))
      ? only
      : 'ask';
  }
}

/**
 * The column a stop's file opens in beside the editor in use: the first group that is neither the active one nor one a
 * panel shows in (`panels`: the paused page view's, the worker panel's), else a new group at the right, the ninth at
 * most.
 */
export function asideColumn(
  groups: readonly { viewColumn: number; isActive: boolean }[],
  panels: readonly number[] = [],
): number {
  const free = groups.find((g) => !g.isActive && !panels.includes(g.viewColumn));
  return free?.viewColumn ?? Math.min(9, Math.max(0, ...groups.map((g) => g.viewColumn)) + 1);
}

/**
 * The line above a stop: what is about to run, `Paused · Fill "MORNING10" getByLabel('Coupon code') · attempt 2`, or,
 * at a failure, how the test failed, `Failed · Timed out 5000ms waiting for getByRole('button') · attempt 2`, in plain
 * text. The lens and the choice among several draw the stop's icon before it (`stopIcon`).
 */
export function pausedText(stop: RunStop, test: RunTest | null, terminal = false, runner = false): string {
  const attempt = test && test.retry > 0 ? ` · attempt ${test.retry + 1}` : '';
  // A run started in a terminal, or by the editor's own test runner, says so: its process is theirs.
  const where = !terminal ? '' : runner ? " · run by the editor's test runner" : ' · run in a terminal';
  if (stop.reason === 'failure') return `Failed · ${stop.title.replace(/^Failed:\s*/, '')}${attempt}${where}`;
  // A stop an agent asked for (its Pause, Step or Run to) says so, for the person watching; else why it stopped.
  const reason = stop.reason as Exclude<RunStop['reason'], 'failure'>;
  const why = stop.by === 'agent' ? 'Paused by the agent' : (RUN_STOP_WORDS[reason] ?? RUN_STOP_WORDS.other);
  return `${why} · ${stop.title}${attempt}${where}`;
}

/** Whether a stop's browser can be shared with Playwright's own tools: its reporter takes `bind`. */
export function canShare(stop: ShownStop): boolean {
  return stop.takes.includes('bind');
}

/** What sharing a stopped browser with Playwright's own tools risks, asked before it is shared. */
export const SHARE_WARNING =
  "Share the stopped test's browser with Playwright tools? Until the test ends, any process of yours can then drive it, read its pages and run code in them (playwright-cli attach, Playwright's dashboard).";

/** What a shared browser's answer says, with the command that joins it. */
export function sharedText(result: StopBindResult): string {
  if (!result.ok || !result.name) return result.message;
  return `${result.message} Join it with: ${result.command}`;
}

/** The icon before a stop's line: a failure's, else the pause's. */
export function stopIcon(stop: RunStop): string {
  return stop.reason === 'failure' ? '$(error)' : '$(debug-pause)';
}

/** The commands of the run controls and of the code actions at a stop, as `package.json` contributes them. */
export const RUN_COMMANDS = {
  pause: 'piwi.pauseRun',
  stop: 'piwi.stopRun',
  resume: 'piwi.resumeRun',
  step: 'piwi.stepRun',
  runTo: 'piwi.runToCursor',
  finish: 'piwi.finishRun',
  end: 'piwi.endTest',
  showPage: 'piwi.showPausedPage',
  pick: 'piwi.pickAtStop',
  record: 'piwi.recordAtStop',
  assert: 'piwi.assertAtStop',
  assertRegion: 'piwi.assertRegionAtStop',
  mock: 'piwi.mockAtStop',
  code: 'piwi.codeAtStop',
  watch: 'piwi.watchWorker',
  pauseAndWatch: 'piwi.pauseAndWatch',
  share: 'piwi.shareWithPlaywright',
  shareLive: 'piwi.shareRunLive',
  stopSharing: 'piwi.stopSharingRun',
  openPage: 'piwi.openRunPage',
} as const;

/** A worker a panel can watch while its test runs: its run, Playwright's worker index, its slot (`lane`), and its words. */
export interface WatchTarget {
  ref: string;
  worker: number;
  lane: number;
  label: string;
  description: string;
}

/** What the worker in a slot is called: `Worker 2` for parallel index 1, as the service says it. */
export function workerName(lane: number): string {
  return `Worker ${lane + 1}`;
}

/**
 * The workers of the live runs whose reporter shows their page while their test runs (`RunWorker.watchable`), in
 * their order; `pausable` keeps those a Pause can stop now (Pause and watch).
 */
export function watchableWorkers(sessions: Sessions, pausable = false): WatchTarget[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers
      .filter((w) => w.watchable && (!pausable || canPauseWorker(w)))
      .map((w) => ({
        ref: s.ref,
        worker: w.worker,
        lane: w.parallelIndex,
        label: workerName(w.parallelIndex),
        description: !w.test
          ? 'between tests'
          : `${w.state === 'stopped' ? 'stopped in' : 'running'} ${w.test.title.join(' › ')}`,
      })),
  );
}

/** Whether a Pause can stop a worker now: it runs or is between tests, no Pause reached it, and its test can stop. */
function canPauseWorker(worker: RunWorker): boolean {
  return worker.state !== 'stopped' && !worker.pausing && !worker.test?.cannotPause;
}

/** The workers a command's target names (a status bar item, a quick pick), or every one it may take. */
export function watchTargetsFor(targets: readonly WatchTarget[], arg: RunTarget | null): WatchTarget[] {
  if (!arg) return [...targets];
  return targets.filter((t) => t.ref === arg.ref && (arg.worker === undefined || t.worker === arg.worker));
}

/** What the worker panel says of its slot, from its run's session: the worker there now, its stop, and a caption. */
export interface LaneShown {
  /** The worker in the slot now; null while Playwright starts the next one, and once the run ended. */
  worker: RunWorker | null;
  /** The stop it stands at, at its line in the document now; null while it runs. */
  stop: ShownStop | null;
  caption: string;
}

/**
 * What the worker panel watching the slot `lane` of a run shows above the image: the run ended, the slot's worker is
 * starting or between tests, its test runs (or a Pause reached it), or where it stopped, from `stops` (the stops at
 * their lines now).
 */
export function laneShown(session: RunSession | undefined, lane: number, stops: readonly ShownStop[]): LaneShown {
  const name = workerName(lane);
  if (!session || session.ended) return { worker: null, stop: null, caption: `${name} · the run ended.` };
  const worker = session.workers.find((w) => w.parallelIndex === lane) ?? null;
  if (!worker) return { worker: null, stop: null, caption: `${name} · starting…` };
  if (!worker.test) return { worker, stop: null, caption: `${name} · between tests` };
  const title = worker.test.title.join(' › ');
  const stop = stops.find((s) => s.ref === session.ref && s.worker === worker.worker) ?? null;
  if (!stop && worker.pausing && worker.waiting) {
    return { worker, stop: null, caption: `${name} · Pausing · waits in ${worker.waiting.title} · ${title}` };
  }
  if (!stop) return { worker, stop: null, caption: `${name} · ${worker.pausing ? 'Pausing' : 'Running'} · ${title}` };
  const file = decodeURIComponent(stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1));
  const said = pausedText(stop.stop, stop.test, stop.terminal, stop.runner);
  return { worker, stop, caption: `${name} · ${said} · ${file}:${stop.stop.line + 1}` };
}

/**
 * Whether a frame of a slot shows what its worker does now: the same worker, its running test, and the stop it stands
 * at (none while it runs). A frame that does not stays shown, dimmed, until the next one comes.
 */
export function frameIsCurrent(
  frame: { worker: number; test: string | null; since: string | null },
  worker: RunWorker | null,
): boolean {
  return (
    !!worker &&
    frame.worker === worker.worker &&
    frame.test === (worker.test?.id ?? null) &&
    frame.since === (worker.stop?.since ?? null)
  );
}

/** A run of the sessions that its reporter can share live on the team instance, and how it stands there. */
export interface LiveRun {
  ref: string;
  live: RunLive;
}

/** A run of the sessions whose own process named its page on the instance: `#78`, and the address. */
export interface RunPageOf {
  ref: string;
  id: number;
  url: string;
}

/** The runs of the sessions whose page is known, in their order. */
export function runPagesOf(sessions: Sessions): RunPageOf[] {
  return [...sessions.values()].flatMap((s) => (s.page ? [{ ref: s.ref, ...s.page }] : []));
}

/** How a run is named beside its page's link: `Run #78`, else `Run`. */
export function runName(page: { id: number } | null | undefined): string {
  return page ? `Run #${page.id}` : 'Run';
}

/**
 * The run whose page `piwi.openRunPage` opens: the one it names (`{ ref }`), else the only one with a page, else null
 * to choose among them.
 */
export function runPageTarget(sessions: Sessions, arg: unknown): RunPageOf | null {
  const pages = runPagesOf(sessions);
  const ref =
    arg && typeof arg === 'object' && typeof (arg as { ref?: unknown }).ref === 'string'
      ? (arg as { ref: string }).ref
      : null;
  if (ref) return pages.find((p) => p.ref === ref) ?? null;
  return pages.length === 1 ? pages[0]! : null;
}

/** The runs of the sessions whose reporter shares them live, in their order. */
export function liveRunsOf(sessions: Sessions): LiveRun[] {
  return [...sessions.values()].flatMap((s) => (s.live ? [{ ref: s.ref, live: s.live }] : []));
}

/** The instance a run's page is on, as a sentence names it (its host); null without a page. */
export function liveInstance(live: Pick<RunLive, 'page'>): string | null {
  if (!live.page) return null;
  try {
    return new URL(live.page).host || null;
  } catch {
    return null;
  }
}

/** What Share live sends, and who sees it, asked before the window shares a run for the first time. */
export function shareLiveWarning(live: Pick<RunLive, 'page'> | null | undefined): string {
  const instance = (live && liveInstance(live)) ?? 'the Piwi instance it reports to';
  return (
    `Share this run live on ${instance}? While it is shared, anyone with its page open there sees each stop of its ` +
    "tests: the call, its file and line, and the test's title, even while nobody watches. While someone watches a " +
    "worker, images of its test's page go there too, each with its call and the test's title. Anyone who can open " +
    'the run there can watch, and on an instance with authentication off, anyone who can reach it. Nothing is ' +
    'stored, and Stop sharing ends it within seconds.'
  );
}

/** How many views are open, counted as views: one person may hold several. */
export function viewsText(count: number): string {
  return count === 1 ? '1 view' : `${count} views`;
}

/** How a run shared live stands, as the status bar and the answers say it: where, and how many views are open. */
export function liveText(live: RunLive): string {
  const instance = liveInstance(live);
  const where = instance ? `Shared live on ${instance}` : 'Shared live';
  return live.viewers === 0 ? `${where}: nobody watches yet` : `${where}: ${viewsText(live.viewers)} open`;
}

/**
 * The status bar item of how far the runs are, as their own processes say: how many of their tests ended out of how
 * many they hold, and how many of them failed, for every run kept that says so (none from a reporter that predates
 * it), with the run's number on the instance once one run names it. Its tooltip links to the runs' pages and to a
 * worker's test; a click watches a worker while one can be, else opens the run's page. None while no run says.
 */
export function progressItem(sessions: Sessions): ControlItem | null {
  const told = [...sessions.values()].flatMap((s) => (s.progress ? [s.progress] : []));
  if (!told.length) return null;
  const sum = (count: (p: NonNullable<RunSession['progress']>) => number) => told.reduce((n, p) => n + count(p), 0);
  const [done, total, failed, flaky] = [
    sum((p) => p.done),
    sum((p) => p.total),
    sum((p) => p.failed),
    sum((p) => p.flaky),
  ];
  const tests = total === 1 ? 'test' : 'tests';
  const outcomes = [failed ? `${failed} failed` : '', flaky ? `${flaky} flaky` : ''].filter(Boolean).join(', ');
  const watchable = watchableWorkers(sessions).length > 0;
  const pages = runPagesOf(sessions);
  const one = told.length === 1 && pages.length === 1 ? pages[0]! : null;
  const links = [
    ...pages.map(
      (p) =>
        `[Open run #${p.id}](command:${RUN_COMMANDS.openPage}?${encodeURIComponent(JSON.stringify([{ ref: p.ref }]))})`,
    ),
    ...(watchable ? [`[Watch a worker's test](command:${RUN_COMMANDS.watch})`] : []),
  ];
  return {
    text: `$(beaker) ${one ? `#${one.id} · ` : ''}${done} of ${total}${failed ? ` · $(error) ${failed}` : ''}`,
    tooltip:
      `Piwi: ${one ? `run #${one.id}` : told.length === 1 ? 'the run' : `${told.length} runs`} ran ` +
      `${done} of ${total} ${tests}${outcomes ? `: ${outcomes}` : ''}.${links.length ? `\n\n${links.join(' · ')}` : ''}`,
    markdown: true,
    command: watchable ? RUN_COMMANDS.watch : pages.length ? RUN_COMMANDS.openPage : null,
  };
}

/**
 * The status bar item of Share live while a run is live: the shared runs say where and the views open of them all,
 * and stop being shared on a click; else a run that can be shared offers it, saying why its sharing stopped when it
 * stopped though nobody asked. None while no run can be shared: the command says why.
 */
export function liveItem(sessions: Sessions): ControlItem | null {
  const runs = liveRunsOf(sessions);
  const shared = runs.filter((r) => r.live.shared);
  if (shared.length) {
    const viewers = shared.reduce((sum, r) => sum + r.live.viewers, 0);
    const what =
      shared.length === 1
        ? liveText(shared[0]!.live)
        : `${shared.length} runs shared live: ${viewers ? `${viewsText(viewers)} open` : 'nobody watches yet'}`;
    return {
      text: viewers > 0 ? `$(broadcast) Live · ${viewsText(viewers)}` : '$(broadcast) Live',
      tooltip: `Piwi: ${what}. Click to stop sharing ${shared.length === 1 ? 'the run' : 'one'}.`,
      command: RUN_COMMANDS.stopSharing,
    };
  }
  const shareable = runs.find((r) => !r.live.refused);
  if (!shareable) return null;
  const instance = liveInstance(shareable.live);
  const offer = `Share the run live${instance ? ` on ${instance}` : ''}, for a teammate to watch from its page`;
  return {
    text: '$(broadcast)',
    tooltip: `Piwi: ${shareable.live.stopped ? `${shareable.live.stopped} ${offer}.` : offer}`,
    command: RUN_COMMANDS.shareLive,
  };
}

/**
 * The run a Share live command acts on: the one it names, else the only one it can act on, else null to choose among
 * `candidates` (more than one); `none` says why there is nothing to act on.
 */
export function liveTarget(
  sessions: Sessions,
  on: boolean,
): { ref: string } | { candidates: string[] } | { none: string } {
  if (!sessions.size) return { none: 'no run started from the editor is running.' };
  const runs = liveRunsOf(sessions);
  const fit = on ? runs.filter((r) => !r.live.shared && !r.live.refused) : runs.filter((r) => r.live.shared);
  if (!on && !fit.length) return { none: 'no run is shared live.' };
  // None can be shared: the service says why, for the first run.
  const candidates = (fit.length ? fit.map((r) => r.ref) : [...sessions.keys()]).slice(0, fit.length ? undefined : 1);
  return candidates.length === 1 ? { ref: candidates[0]! } : { candidates };
}

/** A control or a code action offered at a stop: its title above the stopped line, and its command. */
export interface StopControl {
  title: string;
  command: string;
}

/**
 * The controls offered at a stop, as its lens and its hover name them: Resume, Step, Run to cursor, Finish, and End
 * test where its reporter takes it; at a failure, Resume alone, which lets the test end as it failed (Step, Finish and
 * End do the same).
 */
export function stopControls(stop: ShownStop): StopControl[] {
  const resume = { title: 'Resume', command: RUN_COMMANDS.resume };
  if (stop.stop.reason === 'failure') return [resume];
  return [
    resume,
    { title: 'Step', command: RUN_COMMANDS.step },
    { title: 'Run to cursor', command: RUN_COMMANDS.runTo },
    { title: 'Finish', command: RUN_COMMANDS.finish },
    ...(canEnd(stop) ? [{ title: 'End test', command: RUN_COMMANDS.end }] : []),
  ];
}

/**
 * Whether a stop can end its test (End the test, `end`): its reporter takes it, and it is no failure, which Resume ends
 * as it failed.
 */
export function canEnd(stop: ShownStop): boolean {
  return stop.stop.reason !== 'failure' && stop.takes.includes('end');
}

/**
 * A code action at a stop: what it starts (`piwi/stopAction`), its title, the shorter one of the lens above the stopped
 * line, which shares its row with the line's own lenses, its command and its context key.
 */
export interface StopAction extends StopControl {
  action: StopActionKind;
  lens: string;
  /** The context key set while a stop offers it, which its palette entry follows. */
  key: string;
  /** The words of the choice among the actions. */
  detail: string;
}

/**
 * The code actions, in the order a stop offers them: the pause bar's Pick a locator and Record here, and Assert and
 * Assert a region, in the test's window, so at a stop the bar shows; Mock a request at any stop. Each is offered only
 * when the stopped worker's reporter takes it (`RunWorker.takes`).
 */
export const STOP_ACTIONS: readonly StopAction[] = [
  {
    action: 'pick',
    lens: 'Pick',
    title: 'Pick a locator',
    command: RUN_COMMANDS.pick,
    key: 'piwi.runCanPick',
    detail: "Pick an element in the test's window: its locator replaces the one on the stopped line",
  },
  {
    action: 'record',
    lens: 'Record',
    title: 'Record here',
    command: RUN_COMMANDS.record,
    key: 'piwi.runCanRecord',
    detail: "Record what you do in the test's window above the stopped line",
  },
  {
    action: 'assert',
    lens: 'Assert',
    title: 'Assert',
    command: RUN_COMMANDS.assert,
    key: 'piwi.runCanAssert',
    detail: "Check an element in the test's window: the expect() goes above the stopped line",
  },
  {
    action: 'assert-region',
    lens: 'Assert region',
    title: 'Assert a region',
    command: RUN_COMMANDS.assertRegion,
    key: 'piwi.runCanAssertRegion',
    detail: "Pick a region in the test's window: its ARIA snapshot goes above the stopped line",
  },
  {
    action: 'mock',
    lens: 'Mock',
    title: 'Mock a request',
    command: RUN_COMMANDS.mock,
    key: 'piwi.runCanMock',
    detail: 'Answer a request the test made as the server did: page.route() goes above the stopped line',
  },
];

/** What a reporter must take for each code action. */
const ACTION_TAKES: Record<StopActionKind, readonly RunTake[]> = {
  pick: ['pick'],
  record: ['record'],
  assert: ['assert'],
  'assert-region': ['assert-region'],
  mock: ['requests', 'mock'],
};

/** The code actions a stop offers: those its reporter takes, the ones in the test's window only where the bar shows. */
export function stopActions(stop: ShownStop): StopAction[] {
  return STOP_ACTIONS.filter(
    (a) => (a.action === 'mock' || stop.stop.bar) && ACTION_TAKES[a.action].every((t) => stop.takes.includes(t)),
  );
}

/** What the controls offer: Stop while a run is live, Pause while a worker runs, the others while one is stopped. */
export interface ControlState {
  /** A run is live. */
  active: boolean;
  /** A run this window started is live: Stop. A run started in a terminal is the terminal's to stop. */
  stoppable: boolean;
  /** A worker runs a test or is between tests, no Pause reached it, and its test can stop: Pause. */
  pausable: boolean;
  /** A Pause reached a worker that has not stopped yet. */
  pausing: boolean;
  /** A worker is stopped: Resume, Step, Run to cursor, Finish. */
  stopped: boolean;
  /** A stopped worker can end its test: End the test. */
  endable: boolean;
  /** The code actions a stop offers, any stop. */
  actions: StopActionKind[];
  /** A stop's browser can be shared with Playwright's own tools. */
  shareable: boolean;
  /** A run is shared live on the team instance: Stop sharing. */
  liveShared: boolean;
  /** A worker's reporter shows its page while its test runs: Watch a worker. */
  watchable: boolean;
  /** The call a pausing worker's test waits in before it can stop (the first such worker's): End the test there. */
  waiting: WaitingWorker | null;
}

/** A pausing worker whose test waits in a call: its run, its worker, and the call (`RunWorker.waiting`). */
export interface WaitingWorker {
  ref: string;
  worker: number;
  waiting: RunWaiting;
}

/** The pausing workers whose test waits in a call, in their order; of the run and worker `target` names, when given. */
export function waitingWorkers(sessions: Sessions, target: RunTarget | null = null): WaitingWorker[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers.flatMap((w) =>
      w.pausing &&
      w.waiting &&
      (!target || (target.ref === s.ref && (target.worker === undefined || target.worker === w.worker)))
        ? [{ ref: s.ref, worker: w.worker, waiting: w.waiting }]
        : [],
    ),
  );
}

/**
 * What End the test answers: a stop, when the command names one (`since`, from a lens or a hover) or a stop can end;
 * else the pausing workers whose test waits in a call, of the run and worker the command names, to end there.
 */
export function endChoice(sessions: Sessions, stopCanEnd: boolean, target: RunTarget | null): 'stop' | WaitingWorker[] {
  if (stopCanEnd || target?.since !== undefined) return 'stop';
  return waitingWorkers(sessions, target);
}

/** How long a call has run, from when it began to `now`: `12 s`, `3 min 5 s`; null when its start is not known. */
export function waitedFor(since: string | null, now: number): string | null {
  const began = since === null ? NaN : Date.parse(since);
  if (Number.isNaN(began)) return null;
  const seconds = Math.max(0, Math.floor((now - began) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function controlState(sessions: Sessions): ControlState {
  const workers = [...sessions.values()].flatMap((s) => s.workers);
  const offered = new Set(stopsOf(sessions).flatMap((s) => stopActions(s).map((a) => a.action)));
  return {
    active: sessions.size > 0,
    stoppable: [...sessions.values()].some((s) => !s.terminal),
    pausable: workers.some(canPauseWorker),
    pausing: workers.some((w) => w.pausing),
    stopped: workers.some((w) => w.state === 'stopped'),
    endable: stopsOf(sessions).some(canEnd),
    actions: STOP_ACTIONS.filter((a) => offered.has(a.action)).map((a) => a.action),
    shareable: stopsOf(sessions).some(canShare),
    liveShared: liveRunsOf(sessions).some((r) => r.live.shared),
    watchable: watchableWorkers(sessions).length > 0,
    waiting: waitingWorkers(sessions)[0] ?? null,
  };
}

/** A status bar item of the run controls: its icon, its tooltip with its key, and its command (none while pausing). */
export interface ControlItem {
  /** Its place among the items, where its command does not name it (`ITEM_ORDER` in `run-view.ts`). */
  key?: string;
  text: string;
  tooltip: string;
  /** The tooltip is Markdown whose links run the run controls' commands. */
  markdown?: boolean;
  command: string | null;
}

/**
 * The status bar items beside the run's progress: Resume, Step, Finish and End the test while a worker is stopped,
 * with the code actions' menu while a stop offers one, else Pause, or `Pausing…` once asked; and Stop while a run this
 * window started is live. None without one.
 */
export function controlItems(state: ControlState, now: number = Date.now()): ControlItem[] {
  if (!state.active) return [];
  const stop = state.stoppable
    ? [{ text: '$(debug-stop)', tooltip: 'Piwi: Stop the run (Shift+F5)', command: RUN_COMMANDS.stop }]
    : [];
  // The call a pausing worker's test waits in, how long it has, and End the test there.
  const waits: ControlItem[] = [];
  if (state.pausing && state.waiting) {
    const { title, since, endable } = state.waiting.waiting;
    const waited = waitedFor(since, now);
    waits.push(
      {
        text: `$(loading~spin) Pausing…${waited ? ` ${waited}` : ''}`,
        tooltip: `Piwi: the test waits in ${title}${waited ? ` for ${waited}` : ''}, and stops once it returns`,
        command: null,
      },
      {
        key: 'give-up',
        text: '$(circle-slash)',
        tooltip: endable
          ? `Piwi: End the test now: ${title} is given up, and the rest of the test skipped`
          : `Piwi: End the test as ${title} returns: the rest of it is skipped`,
        command: RUN_COMMANDS.end,
      },
    );
  }
  if (state.stopped) {
    const titles = STOP_ACTIONS.filter((a) => state.actions.includes(a.action)).map((a) => a.title);
    return [
      { text: '$(debug-continue)', tooltip: 'Piwi: Resume (F5)', command: RUN_COMMANDS.resume },
      { text: '$(debug-step-over)', tooltip: 'Piwi: Step to the next call (F10)', command: RUN_COMMANDS.step },
      {
        text: '$(debug-step-out)',
        tooltip: 'Piwi: Finish the test without stopping at a breakpoint again (Shift+F11)',
        command: RUN_COMMANDS.finish,
      },
      // End the test answers a stop that can end, else a call a Pause waits in.
      ...(state.endable
        ? [
            {
              text: '$(circle-slash)',
              tooltip: 'Piwi: End the test here: the rest of it is skipped',
              command: RUN_COMMANDS.end,
            },
          ]
        : waits),
      ...(titles.length
        ? [
            {
              text: '$(code)',
              tooltip: `Piwi: Write code at the stop: ${titles.join(', ')}`,
              command: RUN_COMMANDS.code,
            },
          ]
        : []),
      ...stop,
    ];
  }
  if (state.pausable) {
    return [
      { text: '$(debug-pause)', tooltip: 'Piwi: Pause the run at its next call', command: RUN_COMMANDS.pause },
      ...waits,
      ...stop,
    ];
  }
  if (waits.length) return [...waits, ...stop];
  if (state.pausing) {
    return [
      { text: '$(loading~spin) Pausing…', tooltip: 'Piwi: the run stops at its next call', command: null },
      ...stop,
    ];
  }
  return stop;
}

/** What a control names: a run, one of its workers, and the stop it was shown at (`RunStop.since`). */
export interface RunTarget {
  ref: string;
  worker?: number;
  since?: string;
}

/** The run a command's argument names (a lens, a hover, a status bar item); null for none. */
export function runTargetArg(arg: unknown): RunTarget | null {
  const target = arg as Partial<RunTarget> | null | undefined;
  if (typeof target?.ref !== 'string') return null;
  return {
    ref: target.ref,
    ...(typeof target.worker === 'number' ? { worker: target.worker } : {}),
    ...(typeof target.since === 'string' ? { since: target.since } : {}),
  };
}

/** The stop a command's target names, among those shown; null when it went on. */
export function targetStop(stops: readonly ShownStop[], target: RunTarget): ShownStop | null {
  return (
    stops.find(
      (s) =>
        s.ref === target.ref &&
        (target.worker === undefined || s.worker === target.worker) &&
        (target.since === undefined || s.stop.since === target.since),
    ) ?? null
  );
}

/**
 * The stops a control at the caret may act on: every one when there is one or none; with several, those stopped on the
 * caret's line, else all of them, to choose from.
 */
export function stopsFor(stops: readonly ShownStop[], caret: { uri: string; line: number } | null): ShownStop[] {
  if (stops.length < 2) return [...stops];
  const here = caret ? stops.filter((s) => s.stop.uri === caret.uri && s.stop.line === caret.line) : [];
  return here.length ? here : [...stops];
}

/** A stop as the choice among several names it: what it runs, then its place and worker. */
export function stopPick(stop: ShownStop): { label: string; description: string } {
  const file = stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1);
  const test = stop.test ? `${stop.test.title.join(' › ')} · ` : '';
  return {
    label: `${stopIcon(stop.stop)} ${pausedText(stop.stop, stop.test, stop.terminal, stop.runner)}`,
    description: `${test}${decodeURIComponent(file)}:${stop.stop.line + 1} · worker ${stop.worker}`,
  };
}

/** A body's size as the list of responses names it: `no size` when the response did not say it. */
export function sizeText(size: number | null): string {
  if (size === null) return 'no size';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** When a response finished, after the test began: `840 ms`, `12.4 s`. */
export function timeText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The responses Mock a request offers, the latest first: each by its method and URL, which the list filters on, then
 * its status, type, size and when it finished in the test.
 */
export function requestPicks(
  requests: readonly StopRequest[],
): Array<{ label: string; description: string; id: number }> {
  return [...requests].reverse().map((r) => ({
    label: `${r.method} ${r.url}`,
    description: [r.status, r.type || 'no type', sizeText(r.size), `at ${timeText(r.time)}`].join(' · '),
    id: r.id,
  }));
}

/**
 * What the end of the cursor's line says of the locator there, counted on the stopped page: `3 matches`, `1 match`,
 * `no match`, why it was not counted; null for a line holding no locator Piwi reads.
 */
export function caretText(answer: LocatorAtCaretResult): string | null {
  if (answer.locator === null) return null;
  if (!answer.ok || answer.count === null) return answer.message;
  return answer.count === 0 ? 'no match' : answer.count === 1 ? '1 match' : `${answer.count} matches`;
}

/** What the count at the cursor asks: a stop, and the cursor's line in its file; a null `uri` takes the outline down. */
export type CaretQuery = LocatorAtCaretParams & { worker: number };

/** What the count shows: the line it is at the end of and its words, or nothing. */
export interface CaretShown {
  uri: string;
  line: number;
  text: string;
  /** A refusal goes after a moment; a count stays while the cursor does. */
  brief: boolean;
}

/** How long the count waits for the cursor to settle, and how long a refusal shows. */
export const CARET_WAIT_MS = 200;
export const CARET_REFUSAL_MS = 3_000;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/**
 * The count of the locator at the cursor while a test is stopped: asked `CARET_WAIT_MS` after the cursor settles on a
 * line of the stopped file (`moved`, with `key` telling the line apart from another, its text included, so an edit of
 * the line asks again), one request at a time, a query asked once while the cursor stays on it and again when it comes
 * back; an answer to a query the cursor has left since is dropped, and the latest query asked once it comes. A refusal
 * shows for `CARET_REFUSAL_MS`. `moved(null)` (no stop, or the stop ended) clears it at once and asks nothing; a query
 * with a null `uri` (the cursor left the stopped file) clears it and asks too, which takes the page's outline down.
 */
export class CaretCounts {
  private wanted: { query: CaretQuery; key: string } | null = null;
  private asked: string | null = null;
  private flying: string | null = null;
  private wait: unknown = null;
  private fade: unknown = null;

  constructor(
    private readonly ask: (query: CaretQuery) => Promise<LocatorAtCaretResult | null>,
    private readonly show: (shown: CaretShown | null) => void,
    private readonly timers: Timers = { setTimeout, clearTimeout },
  ) {}

  /** The cursor moved: `query` for where it stands now, `key` naming it; null for no stop. */
  moved(query: CaretQuery | null, key = ''): void {
    const full = query && `${query.ref}\0${query.worker}\0${query.since}\0${query.uri}\0${query.line}\0${key}`;
    if (full === this.wantedKey()) return;
    this.wanted = query && full ? { query, key: full } : null;
    // The cursor left the query asked last: coming back to it asks it again, its count being gone.
    this.asked = null;
    this.timers.clearTimeout(this.wait);
    this.wait = null;
    this.clear();
    if (!query) return;
    this.wait = this.timers.setTimeout(() => {
      this.wait = null;
      this.next();
    }, CARET_WAIT_MS);
  }

  dispose(): void {
    this.timers.clearTimeout(this.wait);
    this.timers.clearTimeout(this.fade);
    this.wanted = null;
  }

  private wantedKey(): string | null {
    return this.wanted?.key ?? null;
  }

  private clear(): void {
    this.timers.clearTimeout(this.fade);
    this.fade = null;
    this.show(null);
  }

  /** Ask the query wanted now, unless a request is on its way or it was just asked. */
  private next(): void {
    const wanted = this.wanted;
    if (!wanted || this.flying || this.asked === wanted.key) return;
    this.flying = wanted.key;
    this.asked = wanted.key;
    void this.ask(wanted.query)
      .catch(() => null)
      .then((answer) => {
        this.flying = null;
        // The cursor moved on: the answer is dropped, and the query it stands at now asked once it settled.
        if (this.wantedKey() !== wanted.key) return this.wait ? undefined : this.next();
        const text = answer ? caretText(answer) : null;
        const { uri, line } = wanted.query;
        if (!text || uri === null || line === null) return;
        const brief = !answer!.ok || answer!.count === null;
        this.show({ uri, line, text, brief });
        if (brief) {
          this.fade = this.timers.setTimeout(() => {
            this.fade = null;
            if (this.wantedKey() === wanted.key) this.show(null);
          }, CARET_REFUSAL_MS);
        }
      });
  }
}

/**
 * The lines the block a stop's code writes stands on once its edits are made: its first line (`StopCode.line`, moved
 * down by the import lines written above it) and its last.
 */
export function writtenLines(code: StopCode): { start: number; end: number } {
  const lines = (text: string) => text.split('\n').length - 1;
  const above = code.edits
    .filter((e) => e.range.start.line < code.line)
    .reduce((sum, e) => sum + lines(e.newText) - (e.range.end.line - e.range.start.line), 0);
  const start = code.line + above;
  return { start, end: start + Math.max(0, lines(`${code.code}\n`) - 1) };
}

/**
 * What a stop's code says once written: its sentence, which names Piwi, and as a warning, with what its reader should
 * check.
 */
export function stopCodeNotice(code: StopCode): { severity: 'information' | 'warning'; text: string } {
  const warnings = code.warnings.filter((w) => w.trim());
  return { severity: warnings.length ? 'warning' : 'information', text: [code.message, ...warnings].join(' ') };
}

/** The runs whose breakpoints the extension remembers, at most: those it started and those it heard of. */
const MAX_SENT = 50;

/** One of the editor's breakpoints a run pauses at, with the editor's id for it, which a move keeps. */
export interface RunBreakpoint extends EditorBreakpoint {
  id: string;
}

/**
 * What a run was given of the editor's breakpoints: where the edit log stood when it started (`since`), the line of
 * each breakpoint in its code by the breakpoint's id, and the places last sent.
 */
export interface RunBreakpoints {
  since: number;
  lines: Map<string, EditorBreakpoint>;
  sent: string;
}

/** A run started at `since` with `breakpoints`; one heard of but not started here was given none Piwi knows. */
export function runStarted(since: number, breakpoints: readonly RunBreakpoint[] | null): RunBreakpoints {
  const places = (breakpoints ?? []).map((b) => ({ uri: b.uri, line: b.line }));
  return {
    since,
    lines: new Map((breakpoints ?? []).map((b, i) => [b.id, places[i]!])),
    sent: breakpoints ? JSON.stringify(places) : '',
  };
}

/**
 * The editor's breakpoints as lines of a run's code: one the run was given keeps its line while it only moved with the
 * edits since (`forward` brings that line to where it stands); another, or one moved otherwise, is its line mapped back
 * through the edits, left out on a line made since, which the run's code lacks.
 */
export function runPlaces(
  run: RunBreakpoints,
  breakpoints: readonly RunBreakpoint[],
  edits: EditLog,
): EditorBreakpoint[] {
  const places: EditorBreakpoint[] = [];
  for (const b of breakpoints) {
    const given = run.lines.get(b.id);
    if (given?.uri === b.uri && edits.forward(b.uri, given.line, run.since) === b.line) {
      places.push(given);
      continue;
    }
    const line = edits.back(b.uri, b.line, run.since);
    if (line === null) continue;
    const place = { uri: b.uri, line };
    run.lines.set(b.id, place);
    places.push(place);
  }
  return places;
}

/**
 * The `piwi/setRunBreakpoints` the live runs need for the editor's `breakpoints`: one per run whose places
 * (`runPlaces`) differ from those it has (`runs`, by ref: the ones its command started with, else the last sent),
 * which `runs` then records. A run heard of without its start maps from now.
 */
export function breakpointUpdates(
  sessions: Sessions,
  breakpoints: readonly RunBreakpoint[],
  runs: Map<string, RunBreakpoints>,
  edits: EditLog,
): SetRunBreakpointsParams[] {
  const updates: SetRunBreakpointsParams[] = [];
  for (const ref of sessions.keys()) {
    let run = runs.get(ref);
    if (!run) {
      run = runStarted(edits.now(), null);
      remember(runs, ref, run);
    }
    const places = runPlaces(run, breakpoints, edits);
    const text = JSON.stringify(places);
    if (run.sent === text) continue;
    run.sent = text;
    updates.push({ ref, places });
  }
  return updates;
}

/** Keep what a run was given, the oldest of more than {@link MAX_SENT} forgotten. */
export function remember<T>(runs: Map<string, T>, ref: string, value: T): void {
  runs.delete(ref);
  runs.set(ref, value);
  for (const oldest of runs.keys()) {
    if (runs.size <= MAX_SENT) break;
    runs.delete(oldest);
  }
}

/** What the paused page view shows: the image of a stop, what it is about to run, or why there is no image. */
export interface PausedPageView {
  image: PausedImage | null;
  caption: string;
  /**
   * A click on the image picks the element under it (`piwi/pickAt`): its worker takes `pick-at` and the image names
   * the viewport its points are in. The image a click was on (`shown`, counted as the view shows each) tells a click
   * on an image the view no longer shows apart.
   */
  pick?: { shown: number } | null;
  /** What the last pick on the image came to: the locator sent to the editor, or why there is none. */
  note?: string | null;
  /** Local live preview controls, bound to this panel's stop, or to its worker's slot (`lane`). */
  live?: { shown: number; on: boolean; input: boolean; interacting: boolean; clickCounts: boolean };
  /** The panel watches a worker's slot, running or stopped, not one stop. */
  lane?: boolean;
  /** The image shows what the worker did before: a test or a stop it left, until the next image comes. */
  stale?: boolean;
}

/** Whether a click on an image of a stop picks there: its worker takes `pick-at`, and the image names its viewport. */
export function picksOnImage(takes: readonly string[], image: PausedImage | null): boolean {
  return takes.includes('pick-at') && !!image?.width && !!image.height;
}

/** A click on the paused page's image, as the view's script posts it: its offset and the size the image is shown at. */
export interface ImageClick {
  shown: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A message of the view's script, read field by field; null for anything else. */
export function imageClickOf(message: unknown): ImageClick | null {
  const m = message as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || m.type !== 'pick') return null;
  const values = [m.shown, m.x, m.y, m.width, m.height];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const [shown, x, y, width, height] = values as number[];
  return { shown: shown!, x: x!, y: y!, width: width!, height: height! };
}

/**
 * The point of the stopped page under a click on its image, in CSS pixels of its viewport (`piwi/pickAt`): the click's
 * offset in the image as shown, scaled by the viewport over the size it is shown at (`x * width / naturalWidth` of the
 * image's own pixels, whatever its size and the page's device scale factor); null for a click outside the image or an
 * image that does not name its viewport.
 */
export function pagePoint(click: ImageClick, image: PausedImage | null): { x: number; y: number } | null {
  const { width, height } = image ?? {};
  if (!width || !height || click.width <= 0 || click.height <= 0) return null;
  if (click.x < 0 || click.y < 0 || click.x > click.width || click.y > click.height) return null;
  return {
    x: Math.min(width - 1, Math.round((click.x * width) / click.width)),
    y: Math.min(height - 1, Math.round((click.y * height) / click.height)),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The longest image the paused page view shows, in base64 characters: 12 MB of JPEG. */
export const MAX_IMAGE_DATA = 16 * 1024 * 1024;

/** A JPEG in base64, as the service hands one, of {@link MAX_IMAGE_DATA} at most; anything else is no image. */
function imageSource(image: PausedImage | null): string | null {
  if (image?.mime !== 'image/jpeg' || typeof image.data !== 'string' || image.data.length > MAX_IMAGE_DATA) return null;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ? `data:image/jpeg;base64,${image.data}` : null;
}

/** The hint above an image a click picks on. */
export const PICK_HINT = 'Click the image to pick a locator: it replaces the one on the stopped line.';

/**
 * What a change of the paused page panel's view state does to its live watch: only a change of visibility ends it
 * (`end`) or starts it again for a panel that wants it (`watch`); focus moving in or out of the panel does nothing.
 */
export function pausedPageViewChange(
  wasVisible: boolean,
  visible: boolean,
  wantLive: boolean,
): 'none' | 'end' | 'watch' {
  if (wasVisible === visible) return 'none';
  if (!visible) return 'end';
  return wantLive ? 'watch' : 'none';
}

/**
 * The paused page view's document: images from `data:` only, its one style by `nonce`, the caption above the image.
 * A script by the same nonce posts image picks; a capable stop instead loads the bundled live preview, whose
 * messages name the shown stop. It reaches nothing else (`default-src 'none'`).
 */
export function pausedPageHtml(view: PausedPageView, nonce: string, scriptUri?: string): string {
  const src = imageSource(view.image);
  const pick = src && view.pick ? view.pick : null;
  const live = view.live && scriptUri ? view.live : null;
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'${pick || live ? `; script-src 'nonce-${nonce}'` : ''}`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style nonce="${nonce}">body{margin:0;padding:8px 12px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}p{margin:0 0 8px}.hint,.note{color:var(--vscode-descriptionForeground)}img{max-width:100%;border:1px solid var(--vscode-panel-border)}img.pick{cursor:crosshair}img.stale{opacity:.5}img:focus{outline:2px solid var(--vscode-focusBorder)}.tools{display:flex;gap:12px;margin-bottom:8px}details{margin:8px 0;color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}</style>`,
    '</head>',
    '<body>',
    `<p${live ? ' id="caption"' : ''}>${escapeHtml(view.caption)}</p>`,
    live
      ? view.lane
        ? `<div class="tools"><label><input id="live" type="checkbox"> Watch</label><label><input id="interact" type="checkbox" disabled> Interact</label></div><details><summary>How the view works</summary><p>Watch shows the page of the test this worker runs, a few images a second, through its tests and stops. At a stop, Interact sends clicks, scrolling and typing to the page. Escape releases the keyboard; Shift+click picks a locator. Nothing is stored or shared with the team.</p></details>`
        : `<div class="tools"><label><input id="live" type="checkbox"> Watch live</label><label${live.input ? '' : ' hidden'}><input id="interact" type="checkbox" disabled> Interact</label></div><details><summary>How the preview works</summary><p>Watch live updates the page while this test is paused. Interact sends clicks, scrolling and typing to the page. Escape releases the keyboard; Shift+click picks a locator. Nothing is stored or shared with the team.</p></details>`
      : '',
    pick && !live ? `<p class="hint">${escapeHtml(PICK_HINT)}</p>` : '',
    live
      ? '<p id="note" class="note" role="status"></p>'
      : view.note
        ? `<p class="note" role="status">${escapeHtml(view.note)}</p>`
        : '',
    live
      ? `<img id="page" tabindex="0"${src ? ` src="${src}"` : ' hidden'}${view.stale ? ' class="stale"' : ''} alt="${view.lane ? "The page of the worker's test" : 'The page of the paused test'}" data-shown="${live.shown}" data-click-counts="${live.clickCounts}">`
      : src
        ? `<img${pick ? ' class="pick" id="page"' : ''} src="${src}" alt="The page of the paused test">`
        : '',
    live
      ? `<script nonce="${nonce}" src="${escapeHtml(scriptUri!)}"></script>`
      : pick
        ? `<script nonce="${nonce}">const vscode=acquireVsCodeApi();const page=document.getElementById('page');page.addEventListener('click',(e)=>vscode.postMessage({type:'pick',shown:${pick.shown},x:e.offsetX,y:e.offsetY,width:page.clientWidth,height:page.clientHeight}));</script>`
        : '',
    '</body>',
    '</html>',
  ].join('\n');
}
