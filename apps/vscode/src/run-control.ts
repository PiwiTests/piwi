/**
 * The runs the editor started, as the extension shows and steers them, with no VS Code API, so it is tested without
 * an editor: the sessions kept from `piwi/runSessionChanged` (the latest of each ref, one that ended dropped), where
 * each stopped worker stands, what a new stop opens and where (its file, with the focus or without, and its page), what
 * the controls and the code actions offer in each state, the line shown above a stop, the stop a control acts on, the
 * breakpoints sent to each run as they change, the page a stop shows as an image, the responses Mock a request lists,
 * the count of the locator at the cursor, the code a stop sends to write, a run shared live on the team instance
 * (Share live: what it sends, how it stands), the workers a panel can watch while their test runs and what the panel
 * says of one, and the edits of the documents since a run started, which map a line of the run's code to the document
 * as it stands and back. And the CI runs of the branch (`piwi/ciSessionChanged`), read-only: the **CI Runs** view's
 * nodes, the CI positions marked at a line, and what the worker panel says of a CI run's lane it watches.
 */
import type {
  CiSession,
  CiTest,
  DriveStopParams,
  EditorBreakpoint,
  LocatorAtCaretParams,
  LocatorAtCaretResult,
  PausedImage,
  RunControlAction,
  RunControlResult,
  LaneViewLayer,
  RunLive,
  AskToWatchParams,
  RunningLine,
  RunPresence,
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
import { LANE_LAYERS, MAX_FILMSTRIP, MAX_LANE_TEXT, type LaneLayer } from '@piwitests/core/live-layer-bounds';
import type { PageEvent } from '@piwitests/core/live-layers';
import type { LiveCallLog } from '@piwitests/core/live-view';
import type { LaneLayerData } from '@piwitests/core/run-channel';
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
  /** Its reporter brings the test's window to the front (`RunWorker.showsWindow`). */
  showsWindow?: boolean;
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
              ...(w.showsWindow ? { showsWindow: true } : {}),
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

/** A line the Testing view writes in the output of the test run that follows a run (`sessionLines`). */
export interface SessionLine {
  /** The line, without its line break. */
  text: string;
  /** The test it is of: its spec and the 0-based line of its `test(…)` call. */
  test: { uri: string; line: number } | null;
  /** Where the stop it tells of stands; null for any other line. */
  at: { uri: string; line: number } | null;
}

/**
 * The tests a run's change begins, each attempt once, by its spec and the line of its `test(…)` call: the Testing view
 * shows them running from the run's own events, whether an instance follows the run or not.
 */
export function testsBegun(before: RunSession | undefined, now: RunSession): Array<{ uri: string; line: number }> {
  return now.workers.flatMap((worker) => {
    const was = before?.workers.find((w) => w.worker === worker.worker);
    const test = worker.test;
    if (!test || (test.id === was?.test?.id && test.retry === was.test.retry)) return [];
    return [{ uri: test.uri, line: test.line }];
  });
}

/**
 * What a run's change writes in the output of the Testing view's test run that follows it, each line naming the
 * worker's lane: a test a worker starts (`Worker 2 · cart › adds a mug · attempt 2`), a stop and why (`pausedText`),
 * and a stop answered (`Worker 2 · goes on`). Nothing for a session it already wrote.
 */
export function sessionLines(before: RunSession | undefined, now: RunSession): SessionLine[] {
  const lines: SessionLine[] = [];
  for (const worker of now.workers) {
    const was = before?.workers.find((w) => w.worker === worker.worker);
    const who = workerName(worker.parallelIndex);
    const test = worker.test ? { uri: worker.test.uri, line: worker.test.line } : null;
    const started = worker.test && (worker.test.id !== was?.test?.id || worker.test.retry !== was?.test?.retry);
    if (started) {
      const attempt = worker.test!.retry > 0 ? ` · attempt ${worker.test!.retry + 1}` : '';
      lines.push({ text: `${who} · ${testTitle(worker.test!)}${attempt}`, test, at: null });
    }
    if (worker.stop && worker.stop.since !== was?.stop?.since) {
      const text = `${who} · ${pausedText(worker.stop, worker.test, !!now.terminal, !!now.runner)}`.replace(
        /\s+/g,
        ' ',
      );
      lines.push({ text, test, at: { uri: worker.stop.uri, line: worker.stop.line } });
    } else if (!worker.stop && was?.stop && !started) {
      lines.push({ text: `${who} · goes on`, test, at: null });
    }
  }
  return lines;
}

/**
 * Whether a stop's window can come to the front (**Show the browser**): its pause bar shows, so the browser has a
 * window, and its reporter brings it forward.
 */
export function canShowBrowser(stop: ShownStop): boolean {
  return stop.stop.bar && !!stop.showsWindow;
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

/**
 * What the extension answers another tool that asks it to stop a run (`piwi/stopRun`, from Piwi Picker or the desktop
 * app through the hub): whether it ended the run's task, a run started in another window or a terminal refused.
 */
export function stopRunAnswer(stopped: boolean): RunControlResult {
  return stopped
    ? { ok: true, message: 'VS Code stops the run.' }
    : { ok: false, message: 'The run was not started in this VS Code window: stop it where it was started.' };
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
  showBrowser: 'piwi.showBrowser',
  pick: 'piwi.pickAtStop',
  record: 'piwi.recordAtStop',
  assert: 'piwi.assertAtStop',
  assertRegion: 'piwi.assertRegionAtStop',
  mock: 'piwi.mockAtStop',
  code: 'piwi.codeAtStop',
  watch: 'piwi.watchWorker',
  pauseAndWatch: 'piwi.pauseAndWatch',
  openTrace: 'piwi.openTraceSoFar',
  share: 'piwi.shareWithPlaywright',
  shareLive: 'piwi.shareRunLive',
  stopSharing: 'piwi.stopSharingRun',
  shareWindow: 'piwi.shareWindowLive',
  stopSharingWindow: 'piwi.stopSharingWindowLive',
  liveMenu: 'piwi.liveMenu',
  openPage: 'piwi.openRunPage',
  holdFailures: 'piwi.holdFailures',
} as const;

/**
 * The run whose **Hold failures** `piwi.holdFailures` turns over: the one it names (`{ ref, on }`, `on` to set), else
 * the only live run that has one, else null to choose among `candidates`; `none` says why there is none.
 */
export function holdTarget(
  sessions: Sessions,
  arg: unknown,
): { ref: string; on: boolean } | { candidates: string[] } | { none: string } {
  const named = typeof arg === 'object' && arg !== null ? (arg as { ref?: unknown; on?: unknown }) : {};
  const held = holdableRuns(sessions);
  if (typeof named.ref === 'string') {
    const session = sessions.get(named.ref);
    if (!session || session.ended) return { none: 'that run has ended.' };
    if (!session.hold) return { none: 'that run holds no failure: nobody attends it.' };
    return { ref: named.ref, on: typeof named.on === 'boolean' ? named.on : !session.hold.on };
  }
  if (!held.length) return { none: 'no run of this window can hold its failures now.' };
  if (held.length === 1) return { ref: held[0]!.ref, on: !held[0]!.hold!.on };
  return { candidates: held.map((s) => s.ref) };
}

/** The live runs that have a **Hold failures** to turn over, in their order. */
export function holdableRuns(sessions: Sessions): RunSession[] {
  return [...sessions.values()].filter((s) => !s.ended && s.hold);
}

/** A run named apart from the others in a list: its page when it has one, else its folder's name, else its ref. */
export function runLabel(session: RunSession): string {
  if (session.page) return runName(session.page);
  const folder = session.root?.split(/[\\/]/).filter(Boolean).pop();
  return folder ? `Run in ${folder} (${session.ref})` : `Run ${session.ref}`;
}

/** A run's **Hold failures** in words: whether a failed test waits at its line, and who said so when not its start. */
export function holdText(hold: NonNullable<RunSession['hold']>): string {
  const by = hold.by === 'agent' ? ', as an agent set it' : '';
  return hold.on ? `Hold failures on: a failed test waits at its line${by}` : `Hold failures off${by}`;
}

/** Text shown as itself in a Markdown tooltip: a folder's or a tool's name is never a link nor emphasis. */
function escapedMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

/** Names in a sentence: `A`, `A and B`, `A, B and C`. */
function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Each name once, in its first place. */
function once(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Who else has a run open, in words: `Also open in Piwi Picker and the desktop app · An agent follows this run`; null
 * while no other tool has it open. This editor's own entries (`self`) are left out.
 */
export function presenceText(session: RunSession): string | null {
  const others = (session.presence ?? []).filter((p) => !p.self);
  const open = once(others.filter((p) => p.kind !== 'agent').map((p) => p.name));
  const parts = [
    ...(open.length ? [`Also open in ${listed(open)}`] : []),
    ...(others.some((p) => p.kind === 'agent') ? ['An agent follows this run'] : []),
  ];
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Who watches a worker's page now (`RunWorker.watchers`), in words: `Watched by Piwi Picker and you`, this editor
 * named last as `you`; null while no other tool watches it.
 */
export function watchersText(watchers: readonly RunPresence[] | undefined): string | null {
  const others = once((watchers ?? []).filter((p) => !p.self).map((p) => p.name));
  if (!others.length) return null;
  return `Watched by ${listed([...others, ...((watchers ?? []).some((p) => p.self) ? ['you'] : [])])}`;
}

/**
 * Who drives a stop now (`RunStop.driver`), in words: `You drive this stop`, `Piwi Picker drives this stop`, `An agent
 * drives this stop`; with `interact` (the stop takes input), the agent's says that the person's input takes control. Null while
 * nobody drives it.
 */
export function driverText(stop: RunStop, interact = false): string | null {
  const driver = stop.driver;
  if (!driver) return null;
  if (driver.self) return 'You drive this stop';
  const text = `${capitalized(driver.name)} drives this stop`;
  return driver.kind === 'agent' && interact ? `${text}: your input takes control` : text;
}

/** Who drives a stop and who else watches its worker's page, in words, or nothing; each part led by ` · `. */
function presentAt(stop: RunStop, takes: readonly RunTake[], worker: RunWorker | null | undefined): string {
  return [driverText(stop, takes.includes('input')), watchersText(worker?.watchers)]
    .flatMap((part) => (part ? [` · ${part}`] : []))
    .join('');
}

/**
 * Who drives a stop and who else watches its worker's page, in words (`An agent drives this stop: your input takes
 * control · Watched by Piwi Picker and you`); null when nobody does.
 */
export function stopPresence(stop: ShownStop, sessions: Sessions): string | null {
  const worker = sessions.get(stop.ref)?.workers.find((w) => w.worker === stop.worker);
  return presentAt(stop.stop, stop.takes, worker).slice(3) || null;
}

/**
 * The paused page's caption of a stop: what it runs, its file and line, then who drives it and who else watches its
 * worker's page (`Paused · Click getByRole('button') · cart.spec.ts:12 · An agent drives this stop: your input takes
 * control · Watched by Piwi Picker and you`).
 */
export function stopCaption(stop: ShownStop, sessions: Sessions): string {
  const file = decodeURIComponent(stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1));
  const said = pausedText(stop.stop, stop.test, stop.terminal, stop.runner);
  const present = stopPresence(stop, sessions);
  return `${said} · ${file}:${stop.stop.line + 1}${present ? ` · ${present}` : ''}`;
}

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
 * their lines now); then who drives its stop and who else watches its page.
 */
export function laneShown(session: RunSession | undefined, lane: number, stops: readonly ShownStop[]): LaneShown {
  const name = workerName(lane);
  if (!session || session.ended) return { worker: null, stop: null, caption: `${name} · the run ended.` };
  const worker = session.workers.find((w) => w.parallelIndex === lane) ?? null;
  if (!worker) return { worker: null, stop: null, caption: `${name} · starting…` };
  const watched = watchersText(worker.watchers);
  const seen = watched ? ` · ${watched}` : '';
  if (!worker.test) return { worker, stop: null, caption: `${name} · between tests${seen}` };
  const title = worker.test.title.join(' › ');
  const stop = stops.find((s) => s.ref === session.ref && s.worker === worker.worker) ?? null;
  if (!stop && worker.pausing && worker.waiting) {
    return { worker, stop: null, caption: `${name} · Pausing · waits in ${worker.waiting.title} · ${title}${seen}` };
  }
  if (!stop) {
    return { worker, stop: null, caption: `${name} · ${worker.pausing ? 'Pausing' : 'Running'} · ${title}${seen}` };
  }
  const file = decodeURIComponent(stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1));
  const said = pausedText(stop.stop, stop.test, stop.terminal, stop.runner);
  const present = presentAt(stop.stop, stop.takes, worker);
  return { worker, stop, caption: `${name} · ${said} · ${file}:${stop.stop.line + 1}${present}` };
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

/**
 * What Share live sends, and who sees it, asked before the window shares a run for the first time: the run, or this
 * window's runs until the person stops (`window`).
 */
export function shareLiveWarning(live: Pick<RunLive, 'page'> | null | undefined, window = false): string {
  const instance = (live && liveInstance(live)) ?? 'the Piwi instance it reports to';
  const what = window
    ? "Share this window's runs live, each run this window follows from now on (those you start here, and those of a terminal it follows) until you stop or close the window,"
    : 'Share this run live';
  return (
    `${what} on ${instance}? While it is shared, anyone with its page open there sees each stop of its ` +
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
 * What each worker of the live runs runs now, one line each, by its lane: its test (`Worker 2 · cart › adds a mug`),
 * stopped there (`· stopped`), or between tests; each run's name before them when several run.
 */
export function workersNow(sessions: Sessions): string[] {
  const live = [...sessions.values()].filter((s) => !s.ended && s.workers.length > 0);
  const lines = live.flatMap((s) =>
    [...s.workers]
      .sort((a, b) => a.parallelIndex - b.parallelIndex)
      .map((w) => {
        const run = live.length > 1 ? `${runLabel(s)} · ` : '';
        const what = w.test ? `${testTitle(w.test)}${w.state === 'stopped' ? ' · stopped' : ''}` : 'between tests';
        return `${run}${workerName(w.parallelIndex)} · ${what}`;
      }),
  );
  return lines.length > MAX_WORKER_LINES
    ? [...lines.slice(0, MAX_WORKER_LINES - 1), `and ${lines.length - MAX_WORKER_LINES + 1} more workers`]
    : lines;
}

/** How many workers the tooltip lists, the last line counting the others. */
const MAX_WORKER_LINES = 8;

/** A test's titles on one line: `cart › adds a mug`, a title's own line breaks as spaces. */
function testTitle(test: RunTest): string {
  return test.title.join(' › ').replace(/\s+/g, ' ');
}

/**
 * The status bar item of how far the runs are, as their own processes say: how many of their tests ended out of how
 * many they hold, and how many of them failed, were flaky or were ended at a stop (End the test), for every run kept
 * that says so (none from a reporter that predates it), with the run's number on the instance once one run names it.
 * Its tooltip says what each worker runs now
 * (`workersNow`), links to the runs' pages and to a worker's test, and says who else has each run open; a click watches a worker while one can be, else opens the run's
 * page. None while no run says.
 */
export function progressItem(sessions: Sessions): ControlItem | null {
  const told = [...sessions.values()].flatMap((s) => (s.progress ? [s.progress] : []));
  if (!told.length) return null;
  const sum = (count: (p: NonNullable<RunSession['progress']>) => number) => told.reduce((n, p) => n + count(p), 0);
  const [done, total, failed, flaky, endedAtStop] = [
    sum((p) => p.done),
    sum((p) => p.total),
    sum((p) => p.failed),
    sum((p) => p.flaky),
    sum((p) => p.endedAtStop ?? 0),
  ];
  const tests = total === 1 ? 'test' : 'tests';
  const outcomes = [
    failed ? `${failed} failed` : '',
    flaky ? `${flaky} flaky` : '',
    endedAtStop ? `${endedAtStop} ended at a stop` : '',
  ]
    .filter(Boolean)
    .join(', ');
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
  // Each live run's Hold failures, with the link that turns it over.
  const held = holdableRuns(sessions);
  const holds = held.flatMap((s) => {
    if (!s.hold) return [];
    const arg = encodeURIComponent(JSON.stringify([{ ref: s.ref, on: !s.hold.on }]));
    const name = held.length > 1 ? `${escapedMarkdown(runLabel(s))}: ` : '';
    return [
      `${name}${holdText(s.hold)} · [Turn ${s.hold.on ? 'off' : 'on'}](command:${RUN_COMMANDS.holdFailures}?${arg})`,
    ];
  });
  const workers = workersNow(sessions).map(escapedMarkdown);
  // Who else has each run open.
  const kept = [...sessions.values()];
  const present = kept.flatMap((s) => {
    const text = presenceText(s);
    return text ? [escapedMarkdown(`${kept.length > 1 ? `${runLabel(s)}: ` : ''}${text}`)] : [];
  });
  return {
    name: 'Piwi: Run progress',
    text: `$(beaker) ${one ? `#${one.id} · ` : ''}${done} of ${total}${failed ? ` · $(error) ${failed}` : ''}`,
    tooltip:
      `Piwi: ${one ? `run #${one.id}` : told.length === 1 ? 'the run' : `${told.length} runs`} ran ` +
      `${done} of ${total} ${tests}${outcomes ? `: ${outcomes}` : ''}.` +
      `${workers.length ? `\n\n${workers.join('\n\n')}` : ''}${links.length ? `\n\n${links.join(' · ')}` : ''}` +
      `${holds.length ? `\n\n${holds.join('\n\n')}` : ''}` +
      `${present.length ? `\n\n${present.join('\n\n')}` : ''}`,
    markdown: true,
    command: watchable ? RUN_COMMANDS.watch : pages.length ? RUN_COMMANDS.openPage : null,
  };
}

/**
 * The status bar item of Share live while a run is live: the shared runs say where and the views open of them all,
 * and open the Live menu on a click (`liveMenu`); else a run that can be shared offers it, saying why its sharing stopped when it
 * stopped though nobody asked. None while no run can be shared: the command says why.
 */
export function liveItem(sessions: Sessions, windowShared = false): ControlItem | null {
  const runs = liveRunsOf(sessions);
  const shared = runs.filter((r) => r.live.shared);
  // While this window's runs are shared, the item says so, with or without a run, and stops it on a click.
  if (windowShared) {
    const viewers = shared.reduce((sum, r) => sum + r.live.viewers, 0);
    return {
      name: 'Piwi: Share live',
      text: viewers > 0 ? `$(broadcast) Live · this window · ${viewsText(viewers)}` : '$(broadcast) Live · this window',
      tooltip:
        "Piwi: this window's runs are shared live, each run you start, until you stop or close the window" +
        `${viewers > 0 ? ` (${viewsText(viewers)} open)` : ''}. Click to open a run page, copy its link or stop sharing.`,
      command: RUN_COMMANDS.liveMenu,
    };
  }
  if (shared.length) {
    const viewers = shared.reduce((sum, r) => sum + r.live.viewers, 0);
    const what =
      shared.length === 1
        ? liveText(shared[0]!.live)
        : `${shared.length} runs shared live: ${viewers ? `${viewsText(viewers)} open` : 'nobody watches yet'}`;
    return {
      name: 'Piwi: Share live',
      text: viewers > 0 ? `$(broadcast) Live · ${viewsText(viewers)}` : '$(broadcast) Live',
      tooltip: `Piwi: ${what}. Click to open ${shared.length === 1 ? 'the' : 'a'} run page, copy its link or stop sharing.`,
      command: RUN_COMMANDS.liveMenu,
    };
  }
  const shareable = runs.find((r) => !r.live.refused);
  if (!shareable) return null;
  const instance = liveInstance(shareable.live);
  const offer = `Share the run live${instance ? ` on ${instance}` : ''}, for a teammate to watch from its page`;
  return {
    name: 'Piwi: Share live',
    text: '$(broadcast)',
    tooltip: `Piwi: ${shareable.live.stopped ? `${shareable.live.stopped} ${offer}.` : offer}`,
    command: RUN_COMMANDS.shareLive,
  };
}

/** The line of the call a watched lane's test runs, as the editor marks it: its 0-based line now and its words. */
export interface RunningMark {
  line: number;
  text: string;
}

/**
 * The running lines the service tells (`piwi/runningLine`), one per lane of a run, each a line of the run's code, kept
 * until the service says it goes (the test ended or stopped, the watch ended) or its run ends.
 */
export class RunningLines {
  private readonly lines = new Map<string, RunningLine>();

  /** A running line told: kept, or gone for a null `call`; whether what the editor marks changed. */
  heard(told: RunningLine): boolean {
    const key = `${told.ref}\n${told.lane}`;
    const before = this.lines.get(key);
    if (!told.call) return this.lines.delete(key);
    if (before && before.worker === told.worker && JSON.stringify(before.call) === JSON.stringify(told.call)) {
      return false;
    }
    this.lines.set(key, told);
    return true;
  }

  /** The runs changed: the lines of a run that ended, or that the sessions no longer hold, go; whether any went. */
  sessionsChanged(sessions: Sessions): boolean {
    let gone = false;
    for (const [key, line] of this.lines) {
      if (sessions.has(line.ref)) continue;
      this.lines.delete(key);
      gone = true;
    }
    return gone;
  }

  /** Every line goes (a service started again holds none); whether any did. */
  clear(): boolean {
    const any = this.lines.size > 0;
    this.lines.clear();
    return any;
  }

  /** Whether a line told is in the document `uri`, drawn or not (past its end now): an edit there draws them again. */
  tells(uri: string): boolean {
    return [...this.lines.values()].some((told) => told.call?.uri === uri);
  }

  /**
   * The marks in the document `uri` of `lineCount` lines, each at its line now (`forward` maps a line of the run `ref`'s
   * code through the edits since it started), by lane: `Worker 1 · Click getByRole('button')`.
   */
  marks(uri: string, lineCount: number, forward: (uri: string, line: number, ref: string) => number): RunningMark[] {
    return [...this.lines.values()]
      .filter((told) => told.call?.uri === uri)
      .sort((a, b) => a.ref.localeCompare(b.ref) || a.lane - b.lane)
      .flatMap((told) => {
        const line = forward(uri, told.call!.line, told.ref);
        return line >= 0 && line < lineCount ? [{ line, text: `${workerName(told.lane)} · ${told.call!.title}` }] : [];
      });
  }
}

/** A line of the **Piwi: Page** output, and how it reads. */
export interface PageLine {
  text: string;
  level: 'error' | 'warning' | 'info';
}

/** The most requests **Piwi: Page** keeps as said pending: past them, the oldest go. */
export const MAX_PAGE_PENDING = 200;

/**
 * What **Piwi: Page** writes of the lane the worker panel watches: the test its worker begins, named once per attempt
 * (`── Worker 1 · checkout › pays`), then each thing its page says, one line each, in the worker panel's words
 * (`eventLine`), a request pending said once until it is answered, its test ends, or `MAX_PAGE_PENDING` newer ones are
 * said.
 */
export class PageLog {
  /** The test last named: its run, worker, id and attempt. */
  private named: string | null = null;
  /** The requests said pending, by their run, worker, test and id, until they are answered or their test ends. */
  private readonly pending = new Set<string>();

  /** How many requests are kept as said pending. */
  get waiting(): number {
    return this.pending.size;
  }

  /** The watched lane `lane` of the run `ref` as the sessions hold it: the test its worker began, named once. */
  lane(sessions: Sessions, ref: string, lane: number): PageLine[] {
    const worker = sessions.get(ref)?.workers.find((w) => w.parallelIndex === lane);
    // A request of a test the watched lane no longer runs goes: nobody tells it answered.
    const current = worker?.test ? `${ref}:${worker.worker}:${worker.test.id}:` : null;
    for (const key of this.pending) if (!current || !key.startsWith(current)) this.pending.delete(key);
    return worker?.test ? this.name(ref, worker, worker.test) : [];
  }

  /** A page event of the watched lane: its test named first when it was not, then its line. */
  event(layer: Extract<LaneViewLayer, { layer: 'events' }>, sessions: Sessions): PageLine[] {
    const worker = sessions.get(layer.ref)?.workers.find((w) => w.worker === layer.worker);
    const test = worker?.test && worker.test.id === layer.test ? worker.test : null;
    const header = worker && test ? this.name(layer.ref, worker, test) : [];
    const { event } = layer;
    if (event.kind === 'request-pending') {
      const key = `${layer.ref}:${layer.worker}:${layer.test ?? ''}:${event.id}`;
      if (!event.done && this.pending.has(key)) return header;
      if (event.done) this.pending.delete(key);
      else this.pending.add(key);
      for (const oldest of this.pending) {
        if (this.pending.size <= MAX_PAGE_PENDING) break;
        this.pending.delete(oldest);
      }
    }
    const said = eventLine(event, layer.at, layer.worker, 0);
    return [...header, { text: said.text, level: said.level }];
  }

  private name(ref: string, worker: RunWorker, test: RunTest): PageLine[] {
    const key = `${ref}:${worker.worker}:${test.id}:${test.retry}`;
    if (key === this.named) return [];
    this.named = key;
    const attempt = test.retry > 0 ? ` (attempt ${test.retry + 1})` : '';
    return [{ text: `── ${workerName(worker.parallelIndex)} · ${testTitle(test)}${attempt}`, level: 'info' }];
  }
}

/** How a line of **Piwi: Page** reads in the output: a warning's and an error's level before it. */
export function pageText(line: PageLine): string {
  return line.level === 'info' ? line.text : `[${line.level}] ${line.text}`;
}

/** The most lines **Piwi: Page** keeps. */
export const MAX_PAGE_LINES = 2000;

/**
 * The lines **Piwi: Page** holds: each one written is appended, until they are half again as many as it keeps
 * (`max`); then the output is replaced by the last `max`.
 */
export class PageOutputLines {
  private kept: string[] = [];

  constructor(private readonly max = MAX_PAGE_LINES) {}

  /** `lines` written: what to append, or the whole text to replace the output with. */
  add(lines: PageLine[]): { append: string[] } | { replace: string } {
    const texts = lines.map(pageText);
    this.kept.push(...texts);
    if (this.kept.length <= this.max + Math.floor(this.max / 2)) return { append: texts };
    this.kept = this.kept.slice(-this.max);
    return { replace: `${this.kept.join('\n')}\n` };
  }
}

/** An entry of the Live item's menu: open a shared run's page, copy its link, or stop sharing it or the window's runs. */
export interface LiveMenuItem {
  label: string;
  detail: string | null;
  action: 'open' | 'copy' | 'stop' | 'stop-window';
  /** The run it acts on; null for the window's share. */
  ref: string | null;
  /** The run's page on the team instance, for `open` and `copy`; null otherwise. */
  url: string | null;
  /**
   * What `stop` and `stop-window` ask before they stop sharing (`stopSharingQuestion`), of the run as the menu showed it,
   * whatever became of it since; null otherwise.
   */
  question: string | null;
}

/**
 * The Live item's menu: for each run shared live, **Open the run page** and **Copy the run page's link** while it has
 * a page on the team instance, and **Stop sharing…**, which asks to confirm; each run named by its number when several
 * are shared. While this window's runs are shared, **Stop sharing this window's runs…** in place of each run's.
 */
export function liveMenu(sessions: Sessions, windowShared = false): LiveMenuItem[] {
  const shared = liveRunsOf(sessions).filter((r) => r.live.shared);
  const several = shared.length > 1;
  const items = shared.flatMap(({ ref, live }): LiveMenuItem[] => {
    const id = sessions.get(ref)?.page?.id;
    const run = id ? `run #${id}` : 'the run';
    const pageItems: LiveMenuItem[] = live.page
      ? [
          {
            label: several ? `Open ${run}’s page` : 'Open the run page',
            detail: live.page,
            action: 'open',
            ref,
            url: live.page,
            question: null,
          },
          {
            label: several ? `Copy ${run}’s link` : "Copy the run page's link",
            detail: null,
            action: 'copy',
            ref,
            url: live.page,
            question: null,
          },
        ]
      : [];
    const stop: LiveMenuItem[] = windowShared
      ? []
      : [
          {
            label: several ? `Stop sharing ${run}…` : 'Stop sharing…',
            detail: liveText(live),
            action: 'stop',
            ref,
            url: null,
            question: stopSharingQuestion(sessions.get(ref) ?? null),
          },
        ];
    return [...pageItems, ...stop];
  });
  if (windowShared) {
    items.push({
      label: "Stop sharing this window's runs…",
      detail: null,
      action: 'stop-window',
      ref: null,
      url: null,
      question: stopSharingQuestion(null),
    });
  }
  return items;
}

/** The button that confirms **Stop sharing**. */
export const STOP_SHARING = 'Stop sharing';

/**
 * What **Stop sharing** asks before it stops sharing a run live (`session`), or this window's runs (null): what closes,
 * and that nothing more goes to the team instance.
 */
export function stopSharingQuestion(session: Pick<RunSession, 'page' | 'live'> | null): string {
  if (!session) {
    return "Piwi: stop sharing this window's runs live? Their views on the team instance close, and the runs you start next stay on this machine.";
  }
  const instance = (session.live && liveInstance(session.live)) ?? 'the team instance';
  const viewers = session.live?.viewers ?? 0;
  if (session.page && viewers > 0) {
    const views =
      viewers === 1 ? `The view open on ${instance} closes` : `The ${viewsText(viewers)} open on ${instance} close`;
    return `Piwi: stop sharing run #${session.page.id} live? ${views}, and nothing more of the run goes there.`;
  }
  const run = session.page ? `run #${session.page.id}` : 'the run';
  return `Piwi: stop sharing ${run} live? Nothing more of it goes to ${instance}.`;
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
 * The entries of the lens row above a stop, after its paused text: Resume, Step and Finish (Resume alone at a
 * failure), then **Write code…** while the stop offers a code action. Run to cursor, End test and each code action are
 * in the stop's hover, its keys and the palette, so the row fits beside the line's own lenses.
 */
export function stopLensControls(stop: ShownStop): StopControl[] {
  const lens = stopControls(stop).filter((c) => c.command !== RUN_COMMANDS.runTo && c.command !== RUN_COMMANDS.end);
  return [...lens, ...(stopActions(stop).length ? [{ title: 'Write code…', command: RUN_COMMANDS.code }] : [])];
}

/**
 * Whether a stop can end its test (End the test, `end`): its reporter takes it, and it is no failure, which Resume ends
 * as it failed.
 */
export function canEnd(stop: ShownStop): boolean {
  return stop.stop.reason !== 'failure' && stop.takes.includes('end');
}

/**
 * A code action at a stop: what it starts (`piwi/stopAction`), its title, its command and its context key. The lens
 * above the stopped line offers them together, as **Write code…** (`stopLensControls`).
 */
export interface StopAction extends StopControl {
  action: CodeActionKind;
  /** The context key set while a stop offers it, which its palette entry follows. */
  key: string;
  /** The words of the choice among the actions. */
  detail: string;
  /** Its glyph, the one its command has in the manifest, before its title in the choice. */
  icon: string;
}

/**
 * The code actions, in the order a stop offers them: the pause bar's Pick a locator and Record here, and Assert and
 * Assert a region, in the test's window, so at a stop the bar shows; Mock a request at any stop. Each is offered only
 * when the stopped worker's reporter takes it (`RunWorker.takes`).
 */
export const STOP_ACTIONS: readonly StopAction[] = [
  {
    action: 'pick',
    icon: '$(target)',
    title: 'Pick a locator',
    command: RUN_COMMANDS.pick,
    key: 'piwi.runCanPick',
    detail: "Pick an element in the test's window: its locator replaces the one on the stopped line",
  },
  {
    action: 'record',
    icon: '$(record)',
    title: 'Record here',
    command: RUN_COMMANDS.record,
    key: 'piwi.runCanRecord',
    detail: "Record what you do in the test's window above the stopped line",
  },
  {
    action: 'assert',
    icon: '$(pass)',
    title: 'Assert',
    command: RUN_COMMANDS.assert,
    key: 'piwi.runCanAssert',
    detail: "Check an element in the test's window: the expect() goes above the stopped line",
  },
  {
    action: 'assert-region',
    icon: '$(screen-full)',
    title: 'Assert a region',
    command: RUN_COMMANDS.assertRegion,
    key: 'piwi.runCanAssertRegion',
    detail: "Pick a region in the test's window: its ARIA snapshot goes above the stopped line",
  },
  {
    action: 'mock',
    icon: '$(arrow-swap)',
    title: 'Mock a request',
    command: RUN_COMMANDS.mock,
    key: 'piwi.runCanMock',
    detail: 'Answer a request the test made as the server did: page.route() goes above the stopped line',
  },
];

/** The code actions a stop offers, of `piwi/stopAction`'s: every one but Show the browser (`front`). */
export type CodeActionKind = Exclude<StopActionKind, 'front'>;

/** What a reporter must take for each code action. */
const ACTION_TAKES: Record<CodeActionKind, readonly RunTake[]> = {
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
  actions: CodeActionKind[];
  /** A stop's browser can be shared with Playwright's own tools. */
  shareable: boolean;
  /** A stop's window can come to the front: Show the browser. */
  browserShowable: boolean;
  /** A run is shared live on the team instance: Stop sharing. */
  liveShared: boolean;
  /** A live run has a Hold failures to turn over. */
  holdable: boolean;
  /** A worker's reporter shows its page while its test runs: Watch a worker. */
  watchable: boolean;
  /** The call a pausing worker's test waits in before it can stop (the first such worker's): End the test there. */
  waiting: WaitingWorker | null;
  /** Every stop held is a failure: it goes on with Resume alone, as Step and Finish have no call to run. */
  failed: boolean;
}

/**
 * A pausing worker whose test waits in a call: its run, its worker, its slot (`RunWorker.parallelIndex`, which names
 * it to the person) and the call (`RunWorker.waiting`).
 */
export interface WaitingWorker {
  ref: string;
  worker: number;
  slot: number;
  waiting: RunWaiting;
}

/** The pausing workers whose test waits in a call, in their order; of the run and worker `target` names, when given. */
export function waitingWorkers(sessions: Sessions, target: RunTarget | null = null): WaitingWorker[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers.flatMap((w) =>
      w.pausing &&
      w.waiting &&
      (!target || (target.ref === s.ref && (target.worker === undefined || target.worker === w.worker)))
        ? [{ ref: s.ref, worker: w.worker, slot: w.parallelIndex, waiting: w.waiting }]
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
    browserShowable: stopsOf(sessions).some(canShowBrowser),
    liveShared: liveRunsOf(sessions).some((r) => r.live.shared),
    holdable: holdableRuns(sessions).length > 0,
    watchable: watchableWorkers(sessions).length > 0,
    waiting: waitingWorkers(sessions)[0] ?? null,
    failed: stopsOf(sessions).length > 0 && stopsOf(sessions).every((s) => s.stop.reason === 'failure'),
  };
}

/**
 * A status bar item of the run controls: its name, its icon, its tooltip, and its command (none while pausing). No
 * tooltip names a key: the person's keybindings decide them.
 */
export interface ControlItem {
  /** Its place among the items, where its command does not name it (`ITEM_ORDER` in `run-view.ts`). */
  key?: string;
  /** What the status bar's menu and a screen reader call it: `Piwi: Resume`. */
  name: string;
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
    ? [{ name: 'Piwi: Stop', text: '$(debug-stop)', tooltip: 'Piwi: Stop the run', command: RUN_COMMANDS.stop }]
    : [];
  // The call a pausing worker's test waits in, how long it has, and End the test there.
  const waits: ControlItem[] = [];
  if (state.pausing && state.waiting) {
    const { title, since, endable } = state.waiting.waiting;
    const waited = waitedFor(since, now);
    waits.push(
      {
        name: 'Piwi: Pausing',
        text: `$(loading~spin) Pausing…${waited ? ` ${waited}` : ''}`,
        tooltip: `Piwi: the test waits in ${title}${waited ? ` for ${waited}` : ''}, and stops once it returns`,
        command: null,
      },
      {
        key: 'give-up',
        name: 'Piwi: End the test',
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
      { name: 'Piwi: Resume', text: '$(debug-continue)', tooltip: 'Piwi: Resume', command: RUN_COMMANDS.resume },
      // A held failure has no call to step into or finish: it goes on with Resume.
      ...(state.failed
        ? []
        : [
            {
              name: 'Piwi: Step',
              text: '$(debug-step-over)',
              tooltip: 'Piwi: Step to the next call',
              command: RUN_COMMANDS.step,
            },
            {
              name: 'Piwi: Finish',
              text: '$(debug-step-out)',
              tooltip: 'Piwi: Finish the test without stopping at a breakpoint again',
              command: RUN_COMMANDS.finish,
            },
          ]),
      // End the test answers a stop that can end, else a call a Pause waits in.
      ...(state.endable
        ? [
            {
              name: 'Piwi: End the test',
              text: '$(circle-slash)',
              tooltip: 'Piwi: End the test here: the rest of it is skipped',
              command: RUN_COMMANDS.end,
            },
          ]
        : waits),
      ...(titles.length
        ? [
            {
              name: 'Piwi: Write code at the stop',
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
      {
        name: 'Piwi: Pause',
        text: '$(debug-pause)',
        tooltip: 'Piwi: Pause the run at its next call',
        command: RUN_COMMANDS.pause,
      },
      ...waits,
      ...stop,
    ];
  }
  if (waits.length) return [...waits, ...stop];
  if (state.pausing) {
    return [
      {
        name: 'Piwi: Pausing',
        text: '$(loading~spin) Pausing…',
        tooltip: 'Piwi: the run stops at its next call',
        command: null,
      },
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
    description: `${test}${decodeURIComponent(file)}:${stop.stop.line + 1} · ${workerName(stop.slot)}`,
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
  /** The slot is a CI run's lane, read-only: Watch alone, no Interact and no pick. */
  ci?: boolean;
  /** The image shows what the worker did before: a test or a stop it left, until the next image comes. */
  stale?: boolean;
  /**
   * An action runs in the test's window at the stop shown (a pick, a check: the stop's `acting`): Escape
   * on the view goes to the page, whose Escape it is, rather than giving the stop back.
   */
  acting?: boolean;
  /**
   * The worker panel's sections beside the image (Why it waits, Events, Text, Filmstrip): which of the two that ask
   * for their layer while open are open, why the lane shows none (`note`: a reporter that sends its images alone), and
   * whether the page's text asked again waits for its answer (`textAsking`), Take the text again off meanwhile.
   */
  layers?: LaneSections & { note: string | null; textAsking?: boolean };
  /**
   * The worker panel's **Open the trace so far**: shown while its slot's worker can open its running test's trace
   * (`canOpenTrace`), off while an ask waits for the service's answer (`asking`); null or absent otherwise.
   */
  trace?: { asking: boolean } | null;
}

/** What **Open the trace so far** says it does, as its tooltip. */
export const OPEN_TRACE_TITLE =
  'Open this test’s trace up to now in Playwright’s trace viewer, on the machine the run runs on';

/**
 * What `piwi/openTrace` asks for the worker panel's slot (`slot`); `none` says why there is nothing to ask: no slot
 * shown, or a CI run's lane (`ci`), whose trace is on the machine that runs it.
 */
export function openTraceParams(
  slot: { ref: string; lane: number } | null,
  ci: boolean,
): { ref: string; lane: number } | { none: string } {
  if (ci) return { none: 'a CI run’s trace is on the machine that runs it, not on this one.' };
  if (!slot) return { none: "no worker panel is open: watch a worker's test first." };
  return { ref: slot.ref, lane: slot.lane };
}

/** A worker slot of a run, as Open the trace so far asks for it: the run's ref and the worker's lane. */
export interface TraceSlot {
  ref: string;
  lane: number;
}

/**
 * The worker panel's **Open the trace so far** asks, one per slot at a time: a slot's button is off while its own ask
 * waits for the service's answer, never while another slot's does, and a second ask of a slot gets the answer of the
 * one that waits.
 */
export class TraceAsks {
  private readonly waiting = new Map<string, Promise<RunControlResult>>();

  /** The answer the ask of `slot` waits for; undefined while none waits. */
  waitingFor(slot: TraceSlot | null): Promise<RunControlResult> | undefined {
    return slot ? this.waiting.get(traceSlotKey(slot)) : undefined;
  }

  /** Whether the ask of `slot` waits for the service's answer. */
  asking(slot: TraceSlot | null): boolean {
    return this.waitingFor(slot) !== undefined;
  }

  /** Ask for `slot` with `send`, or, while its ask waits, give that ask's answer. */
  ask(slot: TraceSlot, send: () => Promise<RunControlResult>): Promise<RunControlResult> {
    const waiting = this.waitingFor(slot);
    if (waiting) return waiting;
    const key = traceSlotKey(slot);
    const asked = send().finally(() => this.waiting.delete(key));
    this.waiting.set(key, asked);
    return asked;
  }
}

function traceSlotKey(slot: TraceSlot): string {
  return `${slot.ref}\n${slot.lane}`;
}

/**
 * What the answer to an ask of `asked` says: as it is while the panel shows that slot (`shown`), else with the name of
 * the worker it is for in front.
 */
export function traceAnswerText(asked: TraceSlot, shown: TraceSlot | null, message: string): string {
  return shown?.ref === asked.ref && shown.lane === asked.lane ? message : `${workerName(asked.lane)}: ${message}`;
}

/**
 * Whether **Piwi: Open the trace so far** is offered (`piwi.runCanOpenTrace`): the worker panel shows a slot whose worker
 * can open its running test's trace (`trace`), and no ask of that slot waits.
 */
export function openTraceOffered(view: PausedPageView | null): boolean {
  return !!view?.trace && !view.trace.asking && !view.ci;
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

/** The worker slot a view's Interact is on for: a run's ref and its worker's parallel index (`ShownStop.slot`). */
export interface InteractSlot {
  ref: string;
  slot: number;
}

/**
 * Whether the paused page keeps Interact on as it shows `stop`: Interact is on for the stops of its worker slot
 * (`on`), and the new stop takes input on a live view. Interact goes off with Watch live and with its run, so the
 * caller keeps `on` only while both go on.
 */
export function keepsInteract(on: InteractSlot | null, stop: ShownStop): boolean {
  return (
    !!on && on.ref === stop.ref && on.slot === stop.slot && stop.takes.includes('view') && stop.takes.includes('input')
  );
}

/**
 * Whether the worker panel keeps Interact as what its slot does changes: through a new stop that takes input, and
 * while the worker runs between two stops; off at a stop that takes none.
 */
export function laneKeepsInteract(interacting: boolean, stop: ShownStop | null): boolean {
  return interacting && (!stop || stop.takes.includes('input'));
}

/**
 * `piwi/driveStop` as Interact goes off: the stop it was last on for given back (`on: false`), whichever of the
 * editor's views drove it. Interact itself takes no stop: the person's first click, key, wheel or pick does.
 */
export function giveBackParams(stop: ShownStop): DriveStopParams {
  return { ref: stop.ref, worker: stop.worker, since: stop.stop.since, on: false };
}

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
  const layers = live && view.lane ? (view.layers ?? { text: false, filmstrip: false, note: null }) : null;
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'${pick || live ? `; script-src 'nonce-${nonce}'` : ''}`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style nonce="${nonce}">body{margin:0;padding:8px 12px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}p{margin:0 0 8px}.hint,.note{color:var(--vscode-descriptionForeground)}img{max-width:100%;border:1px solid var(--vscode-panel-border)}img.pick{cursor:crosshair}img.stale{opacity:.5}img:focus{outline:2px solid var(--vscode-focusBorder)}.tools{display:flex;gap:12px;margin-bottom:8px}details{margin:8px 0;color:var(--vscode-descriptionForeground)}${layers ? LAYERS_STYLE : ''}[hidden]{display:none!important}</style>`,
    '</head>',
    '<body>',
    `<p${live ? ' id="caption"' : ''}>${escapeHtml(view.caption)}</p>`,
    live
      ? view.ci
        ? `<div class="tools"><label><input id="live" type="checkbox"> Watch</label><label hidden><input id="interact" type="checkbox" disabled> Interact</label></div><details><summary>How the view works</summary><p>Watch shows the page of the test this worker of the CI run runs, a few images a second, through its tests, as the team instance relays it with the editor's key: the worker hid the secret fields before it sent them. It is read-only: nothing here clicks, types, picks or pauses on CI. Nothing is stored.</p></details>`
        : view.lane
          ? `<div class="tools"><label><input id="live" type="checkbox"> Watch</label><label><input id="interact" type="checkbox" disabled> Interact</label><button id="trace" type="button" title="${escapeHtml(OPEN_TRACE_TITLE)}"${view.trace ? '' : ' hidden'}${view.trace?.asking ? ' disabled' : ''}>Open the trace so far</button></div><details><summary>How the view works</summary><p>Watch shows the page of the test this worker runs, a few images a second, through its tests and stops. At a stop, Interact sends clicks, scrolling and typing to the page; your first one drives the stop. It stays on for the worker's next stops while Watch is on; Escape turns it off and gives the stop back, but goes to the page while a pick or a check runs there. Shift+click picks a locator. Nothing is stored or shared with the team.</p></details>`
          : `<div class="tools"><label><input id="live" type="checkbox"> Watch live</label><label${live.input ? '' : ' hidden'}><input id="interact" type="checkbox" disabled> Interact</label></div><details><summary>How the preview works</summary><p>Watch live updates the page while this test is paused. Interact sends clicks, scrolling and typing to the page; your first one drives the stop. It stays on for this worker's next stops while Watch live is on; Escape turns it off and gives the stop back, but goes to the page while a pick or a check runs there. Shift+click picks a locator. Nothing is stored or shared with the team.</p></details>`
      : '',
    pick && !live ? `<p class="hint">${escapeHtml(PICK_HINT)}</p>` : '',
    live
      ? '<p id="note" class="note" role="status"></p>'
      : view.note
        ? `<p class="note" role="status">${escapeHtml(view.note)}</p>`
        : '',
    live
      ? `<img id="page" tabindex="0"${src ? ` src="${src}"` : ' hidden'}${view.stale ? ' class="stale"' : ''} alt="${view.ci ? "The page of the CI worker's test" : view.lane ? "The page of the worker's test" : 'The page of the paused test'}" data-shown="${live.shown}" data-click-counts="${live.clickCounts}">`
      : src
        ? `<img${pick ? ' class="pick" id="page"' : ''} src="${src}" alt="The page of the paused test">`
        : '',
    layers ? layersHtml(layers) : '',
    live
      ? `<script nonce="${nonce}" src="${escapeHtml(scriptUri!)}"></script>`
      : pick
        ? `<script nonce="${nonce}">const vscode=acquireVsCodeApi();const page=document.getElementById('page');page.addEventListener('click',(e)=>vscode.postMessage({type:'pick',shown:${pick.shown},x:e.offsetX,y:e.offsetY,width:page.clientWidth,height:page.clientHeight}));</script>`
        : '',
    '</body>',
    '</html>',
  ].join('\n');
}

/** The style of the worker panel's sections beside the image. */
const LAYERS_STYLE =
  'details.layer{color:var(--vscode-foreground)}summary{cursor:pointer}.waits{border:1px solid var(--vscode-panel-border);padding:4px 8px;margin:8px 0}.waits.failed{border-color:var(--vscode-errorForeground)}.waits p{margin:0 0 4px}pre{margin:4px 0;white-space:pre-wrap;word-break:break-word;font:12px var(--vscode-editor-font-family)}.events{list-style:none;padding:0;margin:4px 0;max-height:240px;overflow:auto}.events li{padding:1px 0;white-space:pre-wrap;word-break:break-word}.events li.error{color:var(--vscode-errorForeground)}.events li.warning{color:var(--vscode-editorWarning-foreground)}pre.text{max-height:480px;overflow:auto}.strip{display:flex;gap:4px;overflow-x:auto;padding-bottom:4px}.strip button{padding:0;border:1px solid var(--vscode-panel-border);background:none;cursor:pointer}.strip button[aria-pressed=true]{outline:2px solid var(--vscode-focusBorder)}.strip img{height:60px;display:block;border:0}figure{margin:8px 0}';

/**
 * The worker panel's sections under its image, empty: the view's script fills them from the lane's layers, every text
 * of the run set as text. Why it waits shows while a call log came; Events is open; Text and Filmstrip ask for their
 * layer while open.
 */
function layersHtml(layers: LaneSections & { note: string | null; textAsking?: boolean }): string {
  return [
    `<p id="layers-note" class="note"${layers.note ? '' : ' hidden'}>${escapeHtml(layers.note ?? '')}</p>`,
    '<section id="layers" aria-label="Beside the image">',
    '<div id="waits" class="waits" role="status" hidden><p><strong>Why it waits</strong></p><p id="waits-head"></p><p id="waits-target" class="hint"></p><pre id="waits-lines"></pre></div>',
    '<details id="events-section" class="layer" open><summary>Events <span id="events-count" class="hint"></span></summary><p id="events-empty" class="hint">Nothing yet: console errors, the page’s uncaught errors, failed and slow requests, and the errors its backend logged show here, the newest first.</p><ol id="events" class="events"></ol></details>',
    `<details id="text-section" class="layer"${layers.text ? ' open' : ''}><summary>Text</summary><p class="hint">The page as roles and names, the secret fields hidden: Find (Ctrl+F) searches it.</p><button id="text-again" type="button"${layers.textAsking ? ' disabled' : ''}>Take the text again</button><p id="text-note" class="note"></p><pre id="text" class="text"></pre></details>`,
    `<details id="strip-section" class="layer"${layers.filmstrip ? ' open' : ''}><summary>Filmstrip</summary><p id="strip-empty" class="hint">One image for each call of the test that ended: click one to see it larger.</p><div id="strip" class="strip"></div><figure id="thumb" hidden><img id="thumb-image" alt=""><figcaption id="thumb-title"></figcaption></figure></details>`,
    '</section>',
  ].join('');
}

/**
 * What a screen reader says of a run control item: its tooltip's first paragraph as plain text (in a Markdown tooltip,
 * a link's words kept and its target dropped), never a codicon id.
 */
export function accessibleLabel(item: ControlItem): string {
  const first = item.tooltip.split('\n\n')[0] ?? item.name;
  // Only a Markdown tooltip has links and escapes to read through; a plain one holds the test's own words as they are.
  const plain = item.markdown
    ? first.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_[\]<>|])/g, '$1')
    : first;
  return plain.replace(/\$\([a-z0-9-~]+\)\s*/g, '').trim();
}

/** What the developer reads as a teammate asks to watch a run that is not shared live (`piwi/askToWatch`). */
export function askToWatchText(ask: Pick<AskToWatchParams, 'by' | 'run'>): string {
  return `${ask.by} asks to watch ${ask.run === null ? 'this run' : `run #${ask.run}`} live.`;
}

/** The CI runs of the branch kept from `piwi/ciSessionChanged`, by `ciKey`: the latest of each, one that ended dropped. */
export type CiSessions = Map<string, CiSession>;

/** A CI session's key: its context's folder and its run. */
export function ciKey(session: Pick<CiSession, 'root' | 'runId'>): string {
  return `${session.root}\n${session.runId}`;
}

/** The sessions with `session` heard: kept as the latest of its run, or dropped once it ended. */
export function withCiSession(sessions: CiSessions, session: CiSession): CiSessions {
  const next = new Map(sessions);
  if (session.ended) next.delete(ciKey(session));
  else next.set(ciKey(session), session);
  return next;
}

/**
 * The CI positions of a file, as the editor marks them at the end of a line: the call each running test of a CI run
 * is at in it, one mark per line, the words of several tests on one line joined. Never a stop: nothing waits there.
 */
export function ciPositionsIn(sessions: CiSessions, uri: string): Array<{ line: number; text: string }> {
  const lines = new Map<number, string[]>();
  for (const session of sessions.values()) {
    for (const test of session.tests) {
      if (test.status !== 'running' || test.at?.uri !== uri) continue;
      const texts = lines.get(test.at.line) ?? [];
      if (!texts.includes(test.at.text)) texts.push(test.at.text);
      lines.set(test.at.line, texts);
    }
  }
  return [...lines].sort(([a], [b]) => a - b).map(([line, texts]) => ({ line, text: texts.join(' · ') }));
}

/** The files a CI position is in now, to draw again as they change. */
export function ciPositionFiles(sessions: CiSessions): Set<string> {
  return new Set([...sessions.values()].flatMap((s) => s.tests.flatMap((t) => (t.at ? [t.at.uri] : []))));
}

/**
 * A lane of a CI run the worker panel watches (`piwi/ciWatch`), as its `CiTest` names it, and its view on the dashboard,
 * the second choice where the editor cannot show it.
 */
export interface CiLane {
  root: string;
  runId: number;
  shard: number | null;
  lane: number;
  dashboard: string | null;
}

/** What a node of the **CI Runs** view opens: a file at a line, a page of the instance, a lane in the worker panel. */
export type CiOpen = { uri: string; line: number; character: number } | { url: string } | { lane: CiLane } | null;

/** The CI lane a command's argument names (`{ ci: CiLane }`, from the **CI Runs** view); null for anything else. */
export function ciLaneArg(arg: unknown): CiLane | null {
  const ci = (arg as { ci?: Partial<CiLane> } | null | undefined)?.ci;
  if (!ci || typeof ci !== 'object' || typeof ci.root !== 'string') return null;
  const whole = (n: unknown, min: number) => typeof n === 'number' && Number.isInteger(n) && n >= min;
  if (!whole(ci.runId, 1) || !whole(ci.lane, 1) || !(ci.shard === null || whole(ci.shard, 1))) return null;
  const dashboard = typeof ci.dashboard === 'string' && /^https?:\/\//.test(ci.dashboard) ? ci.dashboard : null;
  return { root: ci.root, runId: ci.runId!, shard: ci.shard!, lane: ci.lane!, dashboard };
}

/** `worker 2`, or `shard 1, worker 2`: a CI lane in words. */
function ciLaneName(lane: Pick<CiTest, 'lane' | 'shard'>): string {
  if (lane.lane === null) return '';
  return lane.shard !== null ? `shard ${lane.shard}, worker ${lane.lane}` : `worker ${lane.lane}`;
}

/** The worker panel's title while it watches a CI lane: `Piwi: CI run #78 · worker 2`. */
export function ciLaneTitle(lane: CiLane): string {
  return `Piwi: CI run #${lane.runId} · ${ciLaneName(lane)}`;
}

/**
 * What the worker panel says above a CI lane it watches, from the run's session: the test running in the lane and the
 * call it is at, else that the lane is between tests, else that the run ended; always read-only.
 */
export function ciLaneCaption(sessions: CiSessions, lane: CiLane): string {
  const name = `CI run #${lane.runId} · ${ciLaneName(lane)}`;
  const session = sessions.get(ciKey(lane));
  if (!session) return `${name} · the run ended.`;
  const test = session.tests.find(
    (t) => t.status === 'running' && t.lane === lane.lane && (t.shard ?? null) === lane.shard,
  );
  if (!test) return `${name} · between tests · read-only`;
  const at = test.at ? ` · ${test.at.title}` : '';
  return `${name} · Running ${ciTestName(test)}${at} · read-only`;
}

/**
 * Whether the worker panel takes a message of its script while it shows a CI run's lane, read-only: its `ready`, Watch
 * (`view`), the sections it opens (`layers`) and the page's text asked again (`text`) alone, never Interact, a pick,
 * input or a release.
 */
export function ciLaneTakes(message: Readonly<Record<string, unknown>>): boolean {
  return message.type === 'ready' || message.type === 'view' || message.type === 'layers' || message.type === 'text';
}

/**
 * Whether the worker panel draws a CI lane again as the CI sessions change: only when its caption or whether it watches
 * changed, so a push of another run, or of nothing the panel says, posts nothing to it.
 */
export function ciLaneRedraws(
  view: Pick<PausedPageView, 'caption' | 'live'> | null,
  caption: string,
  watching: boolean,
): boolean {
  return !view || view.caption !== caption || (view.live?.on ?? false) !== watching;
}

/** A node of the **CI Runs** view: a run, the link to its page, a test, or a test's Watch. */
export interface CiNode {
  key: string;
  label: string;
  description: string;
  tooltip: string;
  /** A codicon id. */
  icon: string;
  open: CiOpen;
  children: CiNode[];
}

const CI_TEST_ICONS: Record<CiTest['status'], string> = {
  running: 'sync~spin',
  passed: 'pass',
  failed: 'error',
  flaky: 'warning',
  skipped: 'debug-step-over',
};

/** A test's name in the view: its describe blocks, then its title, a title's own line breaks as spaces. */
function ciTestName(test: CiTest): string {
  return test.title.join(' › ').replace(/\s+/g, ' ');
}

/** A CI test's words beside its name: its Playwright project and attempt, then where it runs and its call, or its result. */
function ciTestDescription(test: CiTest): string {
  const running = test.status === 'running';
  const parts = [
    test.project,
    test.retry ? `retry ${test.retry}` : '',
    running ? ciLaneName(test) : test.status,
    running ? (test.at?.title ?? '') : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * The **CI Runs** view: each CI run of the branch in progress, named as other runs are (`CI run #78`) with its
 * progress, then **Open** on its page and its tests: a running one opens the call it is at, else its spec, and offers
 * **Watch** in the worker panel and **Watch on the dashboard** while its run can be watched; one that ended opens its
 * spec. Read-only: nothing here steers the run.
 */
export function ciNodes(sessions: CiSessions): CiNode[] {
  return [...sessions.values()]
    .sort((a, b) => b.runId - a.runId)
    .map((session) => {
      const key = ciKey(session);
      const open: CiNode = {
        key: `${key}\nopen`,
        label: `Open run #${session.runId}`,
        description: 'on the dashboard',
        tooltip: `Open CI run #${session.runId} on the dashboard: ${session.url}`,
        icon: 'link-external',
        open: { url: session.url },
        children: [],
      };
      // A test's node keeps its key as the list moves, so the view keeps what the person expanded.
      const keys = new Set<string>();
      const tests = session.tests.map((test, index): CiNode => {
        let testKey = `${key}\n${test.uri ?? ''}\n${test.title.join('\x1f')}\n${test.project}`;
        if (keys.has(testKey)) testKey = `${testKey}\n${index}`;
        keys.add(testKey);
        const spec = test.uri && test.line !== null ? { uri: test.uri, line: test.line, character: 0 } : null;
        const place = test.at ? { uri: test.at.uri, line: test.at.line, character: test.at.character ?? 0 } : spec;
        const lane: CiLane | null =
          test.watch && test.lane !== null
            ? { root: session.root, runId: session.runId, shard: test.shard, lane: test.lane, dashboard: test.watch }
            : null;
        const watch: CiNode[] = test.watch
          ? [
              ...(lane
                ? [
                    {
                      key: `${testKey}\nwatch-here`,
                      label: 'Watch',
                      description: ciLaneName(test),
                      tooltip: `Watch the page of the test ${ciLaneName(test)} runs, in the editor, read-only, as the team instance relays it.`,
                      icon: 'eye',
                      open: { lane },
                      children: [],
                    },
                  ]
                : []),
              {
                key: `${testKey}\nwatch`,
                label: 'Watch on the dashboard',
                description: '',
                tooltip: `Watch this test’s page live on the dashboard, read-only: ${test.watch}`,
                icon: 'link-external',
                open: { url: test.watch },
                children: [],
              },
            ]
          : [];
        const where = test.at ? `\n\nAt ${test.at.title}, line ${test.at.line + 1} as the run’s commit has it.` : '';
        return {
          key: testKey,
          label: ciTestName(test),
          description: ciTestDescription(test),
          tooltip:
            `${ciTestName(test)}${test.project ? ` (${test.project})` : ''}: ` +
            `${test.status === 'running' ? 'running on CI, read-only' : test.status}.${where}`,
          icon: CI_TEST_ICONS[test.status],
          open: place,
          children: watch,
        };
      });
      return {
        key,
        label: session.name,
        description: `${session.branch ? `${session.branch} · ` : ''}${session.summary}`,
        tooltip:
          `${session.name}${session.branch ? ` on ${session.branch}` : ''}: ${session.summary}. ` +
          'Read-only: it runs on CI, so nothing here pauses or steers it.' +
          (session.watchable ? ' Its running tests can be watched, here or on the dashboard.' : ''),
        icon: 'cloud',
        open: null,
        children: [open, ...tests],
      };
    });
}

/** The most events the worker panel lists, the newest first. */
export const MAX_LANE_EVENTS = 50;
/** The call log's last lines the worker panel shows under its image. */
export const WAITS_LINES = 3;

/** The sections of the worker panel that ask for their layer while open: the page's text and the filmstrip. */
export interface LaneSections {
  text: boolean;
  filmstrip: boolean;
}

/**
 * The layers the worker panel asks for (`piwi/laneView`'s and `piwi/ciWatch`'s `layers`): the call log and the page's
 * events always, the page's text and the filmstrip while their section is open.
 */
export function laneLayersAsked(open: LaneSections): LaneLayer[] {
  return LANE_LAYERS.filter((layer) => layer === 'calls' || layer === 'events' || open[layer]);
}

/** A time as the worker panel says it: `120 ms`, `4.2 s`, `17 s`. */
export function laneDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** An address as an event line shows it: its path and query on a web address, else as it came. */
export function eventAddress(url: string): string {
  const match = /^https?:\/\/[^/?#]+([^#]*)/i.exec(url);
  return match ? match[1] || '/' : url;
}

/** Why the call the lane's test is in waits, as the worker panel shows it under the image. */
export interface WaitsView {
  /** The call and how it stands: `Click getByRole('button') · waiting 4.2 s`. */
  head: string;
  /** What its locator matches and in which state, while it waits on one; null otherwise. */
  target: string | null;
  /** The call log's last lines, oldest first, then the error it ended with. */
  lines: string[];
  failed: boolean;
}

/** What a call's locator matches as it waits: none yet, one, or several, and whether the first is enabled. */
function targetWords(target: LiveCallLog['target']): string | null {
  if (!target) return null;
  if (target.count === 0) return 'No element matches yet';
  const state = target.enabled === false ? 'disabled' : target.enabled === true ? 'enabled' : null;
  if (target.count === 1) return `1 element matches${state ? `, ${state}` : ''}`;
  return `${target.count} elements match${state ? `, the first ${state}` : ''}`;
}

/** Why it waits: the call, how long it ran, what its locator matches, and the call log's last lines. */
export function waitsView(log: LiveCallLog): WaitsView {
  const time = laneDuration(log.ms);
  const how =
    log.status === 'running' ? `waiting ${time}` : log.status === 'passed' ? `done in ${time}` : `failed after ${time}`;
  const lines = log.lines.slice(-WAITS_LINES);
  return {
    head: `${log.call.title} · ${how}`,
    target: log.status === 'running' ? targetWords(log.target) : null,
    lines: log.error ? [...lines, log.error] : lines,
    failed: log.status === 'failed',
  };
}

/** A line of the worker panel's events: its words, how it reads (`error`, `warning`, `info`) and its full address. */
export interface EventLine {
  /** The same request's lines share it, so its pending time replaces the line before. */
  key: string;
  text: string;
  level: 'error' | 'warning' | 'info';
  /** The request's whole address, for a tooltip; null for an event without one. */
  url: string | null;
  at: number;
}

/** What a page event says, as the worker panel lists it; `n` keys a line no other replaces. */
export function eventLine(event: PageEvent, at: number, worker: number, n: number): EventLine {
  const line = (text: string, level: EventLine['level'], url: string | null = null, key = `${n}`): EventLine => ({
    key,
    text,
    level,
    url,
    at,
  });
  switch (event.kind) {
    case 'console':
      return line(`Console error: ${event.text}`, 'error');
    case 'page-error':
      return line(`Uncaught error: ${event.text}`, 'error');
    case 'request-failed': {
      const what = `${event.method} ${eventAddress(event.url)}`;
      const why = event.status !== null ? `answered ${event.status}` : `failed: ${event.failure ?? 'no answer'}`;
      return line(`${what} ${why}`, 'error', event.url);
    }
    case 'request-pending': {
      const what = `${event.method} ${eventAddress(event.url)}`;
      const text = event.done
        ? `${what} answered after ${laneDuration(event.ms)}`
        : `${what} pending ${laneDuration(event.ms)}`;
      return line(text, event.done ? 'info' : 'warning', event.url, `pending ${worker}:${event.id}`);
    }
    case 'backend': {
      const status = event.status !== null ? ` (${event.status})` : '';
      return line(
        `Backend ${event.level} on ${event.method} ${eventAddress(event.url)}${status}: ${event.text}`,
        event.level,
        event.url,
      );
    }
    case 'api': {
      const what = `API ${event.method} ${eventAddress(event.url)}`;
      if (event.failure !== null || event.status === null) {
        return line(`${what} failed: ${event.failure ?? 'no answer'}`, 'error', event.url);
      }
      return line(
        `${what} answered ${event.status} in ${laneDuration(event.ms)}`,
        event.status >= 400 ? 'error' : 'info',
        event.url,
      );
    }
    case 'dropped':
      return line(`${event.count} more events were not sent: too many at once.`, 'warning');
  }
}

/** An image of the lane's filmstrip: the call it ended, its title and its place in the strip, its JPEG in base64. */
export interface StripImage {
  call: string;
  title: string;
  index: number;
  data: string;
}

/** The page's text as the worker panel shows it, or why none goes. */
export type LaneTextShown =
  | { text: string; cut: boolean; source: 'trace' | 'snapshot'; at: number }
  | { refused: string };

/** The layers the worker panel shows of its lane, as they came. */
export interface LaneLayersShown {
  /**
   * The test they are of (its id, or its title on a CI lane) and the worker that runs it: another test's call log and
   * filmstrip start anew, and so do those of another worker, a retry of the same test.
   */
  test: string | null;
  worker: number | null;
  waits: WaitsView | null;
  /** The newest first, {@link MAX_LANE_EVENTS} at most. */
  events: EventLine[];
  /** How many events were heard, which keys each line. */
  heard: number;
  text: LaneTextShown | null;
  /** In the order of the test's calls, one image per call, `MAX_FILMSTRIP` at most. */
  strip: StripImage[];
}

export const NO_LANE_LAYERS: LaneLayersShown = {
  test: null,
  worker: null,
  waits: null,
  events: [],
  heard: 0,
  text: null,
  strip: [],
};

/** A part of the worker panel a layer changes. */
export type LaneLayerPart = 'waits' | 'events' | 'text' | 'strip';

/** A JPEG in base64, as a filmstrip image comes. */
const THUMB_DATA = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/;

/**
 * The layers shown with `layer` heard, and the parts it changed (none for an image of a call the strip holds, as the
 * worker sends the filmstrip again when the layers change). A layer of another test than the one shown, or of another
 * worker (a retry runs in a new one), starts the call log and the filmstrip anew; so does an image placed at or before
 * the strip's last of a call it does not hold, another attempt's. The events and the text stay until newer ones come.
 * A request's pending time replaces its line, which comes first again.
 */
export function withLaneLayer(
  shown: LaneLayersShown,
  layer: LaneLayerData & { test: string | null; worker?: number },
): { shown: LaneLayersShown; changed: LaneLayerPart[] } {
  const changed = new Set<LaneLayerPart>();
  let next = shown;
  const worker = layer.worker ?? shown.worker;
  if ((layer.test !== null && layer.test !== shown.test) || worker !== shown.worker) {
    if (shown.waits) changed.add('waits');
    if (shown.strip.length) changed.add('strip');
    next = { ...next, test: layer.test ?? shown.test, worker, waits: null, strip: [] };
  }
  switch (layer.layer) {
    case 'calls':
      next = { ...next, waits: waitsView(layer.log) };
      changed.add('waits');
      break;
    case 'events': {
      const line = eventLine(layer.event, layer.at, layer.worker ?? 0, next.heard + 1);
      const events = [line, ...next.events.filter((e) => e.key !== line.key)].slice(0, MAX_LANE_EVENTS);
      next = { ...next, events, heard: next.heard + 1 };
      changed.add('events');
      break;
    }
    case 'text':
      next = {
        ...next,
        text:
          'refused' in layer
            ? { refused: layer.refused }
            : { text: layer.text.text, cut: layer.text.cut, source: layer.text.source, at: layer.text.at },
      };
      changed.add('text');
      break;
    case 'filmstrip': {
      if (!THUMB_DATA.test(layer.data) || next.strip.some((image) => image.call === layer.thumb.call)) break;
      const image = { call: layer.thumb.call, title: layer.thumb.title, index: layer.thumb.index, data: layer.data };
      const last = next.strip[next.strip.length - 1];
      const kept = last && image.index <= last.index ? [] : next.strip;
      const strip = [...kept, image].slice(-MAX_FILMSTRIP);
      next = { ...next, strip };
      changed.add('strip');
      break;
    }
  }
  return { shown: next, changed: [...changed] };
}

/** What the page's text section says above the text: where it came from and whether it was cut, or why none came. */
export function laneTextNote(text: LaneTextShown | null): string {
  if (!text) return 'Nothing yet.';
  if ('refused' in text) return text.refused;
  const from = text.source === 'trace' ? 'From the test’s trace.' : 'Read from the page.';
  return text.cut ? `${from} Cut at ${MAX_LANE_TEXT / 1024} K characters.` : from;
}

/**
 * What the worker panel posts its script of the lane's layers: the parts that changed (`parts`), the strip as the order
 * of its images and, of their JPEGs, those not posted to the document yet (`posted`, by call).
 */
export interface LaneLayersMessage {
  type: 'layers';
  shown: number;
  waits?: WaitsView | null;
  events?: EventLine[];
  text?: { text: string | null; note: string };
  strip?: Array<Omit<StripImage, 'data'>>;
  images?: Record<string, string>;
}

/** The message posting `parts` of the layers shown to the view drawn `shown`th, `textNote` said over the text's own. */
export function laneLayersMessage(
  shown: number,
  layers: LaneLayersShown,
  parts: readonly LaneLayerPart[],
  posted: ReadonlySet<string>,
  textNote: string | null = null,
): LaneLayersMessage {
  const message: LaneLayersMessage = { type: 'layers', shown };
  if (parts.includes('waits')) message.waits = layers.waits;
  if (parts.includes('events')) message.events = layers.events;
  if (parts.includes('text')) {
    const text = layers.text && 'text' in layers.text ? layers.text.text : null;
    message.text = { text, note: textNote ?? laneTextNote(layers.text) };
  }
  if (parts.includes('strip')) {
    message.strip = layers.strip.map(({ call, title, index }) => ({ call, title, index }));
    const images = layers.strip.filter((image) => !posted.has(image.call));
    if (images.length) message.images = Object.fromEntries(images.map((image) => [image.call, image.data]));
  }
  return message;
}

/** Every part of the worker panel's layers, posted to a view drawn anew. */
export const LANE_LAYER_PARTS: readonly LaneLayerPart[] = ['waits', 'events', 'text', 'strip'];

/** The note over a lane whose reporter sends no layers; null when it sends them or the panel cannot tell. */
export function laneLayersNote(worker: Pick<RunWorker, 'layers'> | null): string | null {
  return worker && !worker.layers
    ? 'This worker’s reporter sends its images alone: update @piwitests/reporter to see why it waits, the page’s events, its text and the filmstrip.'
    : null;
}

/**
 * The note over a CI lane while none of its page's events, its text or its filmstrip came: neither the team instance
 * nor the CI run's reporter says whether it sends them, and an older one of either sends the images alone. Null once
 * one came.
 */
export function ciLaneLayersNote(layers: Pick<LaneLayersShown, 'heard' | 'text' | 'strip'>): string | null {
  return layers.heard || layers.text || layers.strip.length
    ? null
    : 'The page’s events, its text and the filmstrip show here as the CI run’s worker sends them: a team instance or a @piwitests/reporter older than the editor’s sends the images alone.';
}

/**
 * The layers the worker panel holds as asked once the service answered a change of them (`asked`, as text): those it
 * held, unless the service refused the very change they are, which leaves none held, so the next change asks again.
 */
export function layersAfterAnswer(held: string, asked: string, ok: boolean): string {
  return ok || held !== asked ? held : '';
}
