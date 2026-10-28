/**
 * The runs the editor started, as the extension shows and steers them, with no VS Code API, so it is tested without
 * an editor: the sessions kept from `piwi/runSessionChanged` (the latest of each ref, one that ended dropped), where
 * each stopped worker stands, what the controls and the code actions offer in each state, the line shown above a
 * stop, the stop a control acts on, the breakpoints sent to each run as they change, the page a stop shows as an
 * image, the responses Mock a request lists, the count of the locator at the cursor, the code a stop sends to write,
 * and the edits of the documents since a run started, which map a line of the run's code to the document as it stands
 * and back.
 */
import type {
  EditorBreakpoint,
  LocatorAtCaretParams,
  LocatorAtCaretResult,
  PausedImage,
  RunSession,
  RunStop,
  RunTake,
  RunTest,
  SetRunBreakpointsParams,
  StopActionKind,
  StopCode,
  StopRequest,
} from '@piwitests/editor/protocol';

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

/** A worker stopped: its run, the worker, where it stands, the test it runs and what its reporter takes there. */
export interface ShownStop {
  ref: string;
  worker: number;
  stop: RunStop;
  test: RunTest | null;
  takes: readonly RunTake[];
}

/** Every stopped worker of the sessions, in their order. */
export function stopsOf(sessions: Sessions): ShownStop[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers.flatMap((w) =>
      w.stop ? [{ ref: s.ref, worker: w.worker, stop: w.stop, test: w.test, takes: w.takes ?? [] }] : [],
    ),
  );
}

/** What tells a stop from another: its run, its worker and when it stopped. */
export function stopKey(stop: ShownStop): string {
  return `${stop.ref}\0${stop.worker}\0${stop.stop.since}`;
}

/**
 * The line above a stop: what is about to run, `Paused · Fill "MORNING10" getByLabel('Coupon code') · attempt 2`, or,
 * at a failure, how the test failed, `Failed · Timed out 5000ms waiting for getByRole('button') · attempt 2`, in plain
 * text. The lens and the choice among several draw the stop's icon before it (`stopIcon`).
 */
export function pausedText(stop: RunStop, test: RunTest | null): string {
  const attempt = test && test.retry > 0 ? ` · attempt ${test.retry + 1}` : '';
  if (stop.reason === 'failure') return `Failed · ${stop.title.replace(/^Failed:\s*/, '')}${attempt}`;
  return `Paused · ${stop.title}${attempt}`;
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
  showPage: 'piwi.showPausedPage',
  pick: 'piwi.pickAtStop',
  record: 'piwi.recordAtStop',
  assert: 'piwi.assertAtStop',
  assertRegion: 'piwi.assertRegionAtStop',
  mock: 'piwi.mockAtStop',
  code: 'piwi.codeAtStop',
} as const;

/** A control or a code action offered at a stop: its title above the stopped line, and its command. */
export interface StopControl {
  title: string;
  command: string;
}

/**
 * The controls offered at a stop, as its lens and its hover name them: Resume, Step, Run to cursor and Finish; at a
 * failure, Resume alone, which lets the test end as it failed (Step and Finish do the same).
 */
export function stopControls(stop: RunStop): StopControl[] {
  const resume = { title: 'Resume', command: RUN_COMMANDS.resume };
  if (stop.reason === 'failure') return [resume];
  return [
    resume,
    { title: 'Step', command: RUN_COMMANDS.step },
    { title: 'Run to cursor', command: RUN_COMMANDS.runTo },
    { title: 'Finish', command: RUN_COMMANDS.finish },
  ];
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
  /** A run is live: Stop. */
  active: boolean;
  /** A worker runs a test or is between tests, no Pause reached it, and its test can stop: Pause. */
  pausable: boolean;
  /** A Pause reached a worker that has not stopped yet. */
  pausing: boolean;
  /** A worker is stopped: Resume, Step, Run to cursor, Finish. */
  stopped: boolean;
  /** The code actions a stop offers, any stop. */
  actions: StopActionKind[];
}

export function controlState(sessions: Sessions): ControlState {
  const workers = [...sessions.values()].flatMap((s) => s.workers);
  const offered = new Set(stopsOf(sessions).flatMap((s) => stopActions(s).map((a) => a.action)));
  return {
    active: sessions.size > 0,
    pausable: workers.some((w) => w.state !== 'stopped' && !w.pausing && !w.test?.cannotPause),
    pausing: workers.some((w) => w.pausing),
    stopped: workers.some((w) => w.state === 'stopped'),
    actions: STOP_ACTIONS.filter((a) => offered.has(a.action)).map((a) => a.action),
  };
}

/** A status bar item of the run controls: its icon, its tooltip with its key, and its command (none while pausing). */
export interface ControlItem {
  text: string;
  tooltip: string;
  command: string | null;
}

/**
 * The status bar items beside the run's progress: Resume, Step and Finish while a worker is stopped, with the code
 * actions' menu while a stop offers one, else Pause, or `Pausing…` once asked; and Stop while a run is live. None
 * without one.
 */
export function controlItems(state: ControlState): ControlItem[] {
  if (!state.active) return [];
  const stop = { text: '$(debug-stop)', tooltip: 'Piwi: Stop the run (Shift+F5)', command: RUN_COMMANDS.stop };
  if (state.stopped) {
    const titles = STOP_ACTIONS.filter((a) => state.actions.includes(a.action)).map((a) => a.title);
    return [
      { text: '$(debug-continue)', tooltip: 'Piwi: Resume (F5)', command: RUN_COMMANDS.resume },
      { text: '$(debug-step-over)', tooltip: 'Piwi: Step to the next call (F10)', command: RUN_COMMANDS.step },
      {
        text: '$(debug-step-out)',
        tooltip: 'Piwi: Finish the test without stopping again (Shift+F11)',
        command: RUN_COMMANDS.finish,
      },
      ...(titles.length
        ? [
            {
              text: '$(code)',
              tooltip: `Piwi: Write code at the stop: ${titles.join(', ')}`,
              command: RUN_COMMANDS.code,
            },
          ]
        : []),
      stop,
    ];
  }
  if (state.pausable) {
    return [
      { text: '$(debug-pause)', tooltip: 'Piwi: Pause the run at its next call', command: RUN_COMMANDS.pause },
      stop,
    ];
  }
  if (state.pausing) {
    return [{ text: '$(loading~spin) Pausing…', tooltip: 'Piwi: the run stops at its next call', command: null }, stop];
  }
  return [stop];
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
    label: `${stopIcon(stop.stop)} ${pausedText(stop.stop, stop.test)}`,
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
 * The paused page view's document: images from `data:` only, its one style by `nonce`, the caption above the image.
 * No script, but where a click on the image picks (`view.pick`): then one script, by the same `nonce`, which posts a
 * click's offset in the image and the size it is shown at, and which image it was on, to the extension; it reaches
 * nothing else (`default-src 'none'`).
 */
export function pausedPageHtml(view: PausedPageView, nonce: string): string {
  const src = imageSource(view.image);
  const pick = src && view.pick ? view.pick : null;
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'${pick ? `; script-src 'nonce-${nonce}'` : ''}`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style nonce="${nonce}">body{margin:0;padding:8px 12px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}p{margin:0 0 8px}.hint,.note{color:var(--vscode-descriptionForeground)}img{max-width:100%;border:1px solid var(--vscode-panel-border)}img.pick{cursor:crosshair}</style>`,
    '</head>',
    '<body>',
    `<p>${escapeHtml(view.caption)}</p>`,
    pick ? `<p class="hint">${escapeHtml(PICK_HINT)}</p>` : '',
    view.note ? `<p class="note" role="status">${escapeHtml(view.note)}</p>` : '',
    src ? `<img${pick ? ' class="pick" id="page"' : ''} src="${src}" alt="The page of the paused test">` : '',
    pick
      ? `<script nonce="${nonce}">const vscode=acquireVsCodeApi();const page=document.getElementById('page');page.addEventListener('click',(e)=>vscode.postMessage({type:'pick',shown:${pick.shown},x:e.offsetX,y:e.offsetY,width:page.clientWidth,height:page.clientHeight}));</script>`
      : '',
    '</body>',
    '</html>',
  ].join('\n');
}
