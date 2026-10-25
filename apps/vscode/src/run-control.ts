/**
 * The runs the editor started, as the extension shows and steers them, with no VS Code API, so it is tested without
 * an editor: the sessions kept from `piwi/runSessionChanged` (the latest of each ref, one that ended dropped), where
 * each stopped worker stands, what the controls offer in each state, the line shown above a stop, the stop a control
 * acts on, the breakpoints sent to each run as they change, the page a stop shows as an image, and the edits of the
 * documents since a run started, which map a line of the run's code to the document as it stands and back.
 */
import type {
  EditorBreakpoint,
  PausedImage,
  RunSession,
  RunStop,
  RunTest,
  SetRunBreakpointsParams,
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

/** A worker stopped: its run, the worker, where it stands and the test it runs. */
export interface ShownStop {
  ref: string;
  worker: number;
  stop: RunStop;
  test: RunTest | null;
}

/** Every stopped worker of the sessions, in their order. */
export function stopsOf(sessions: Sessions): ShownStop[] {
  return [...sessions.values()].flatMap((s) =>
    s.workers.flatMap((w) => (w.stop ? [{ ref: s.ref, worker: w.worker, stop: w.stop, test: w.test }] : [])),
  );
}

/** What tells a stop from another: its run, its worker and when it stopped. */
export function stopKey(stop: ShownStop): string {
  return `${stop.ref}\0${stop.worker}\0${stop.stop.since}`;
}

/** The line above a stop: what is about to run, `⏸ Paused · Fill "WELCOME10" getByLabel('Coupon') · attempt 2`. */
export function pausedText(stop: RunStop, test: RunTest | null): string {
  const attempt = test && test.retry > 0 ? ` · attempt ${test.retry + 1}` : '';
  return `⏸ Paused · ${stop.title}${attempt}`;
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
}

export function controlState(sessions: Sessions): ControlState {
  const workers = [...sessions.values()].flatMap((s) => s.workers);
  return {
    active: sessions.size > 0,
    pausable: workers.some((w) => w.state !== 'stopped' && !w.pausing && !w.test?.cannotPause),
    pausing: workers.some((w) => w.pausing),
    stopped: workers.some((w) => w.state === 'stopped'),
  };
}

/** The commands of the run controls, as `package.json` contributes them. */
export const RUN_COMMANDS = {
  pause: 'piwi.pauseRun',
  stop: 'piwi.stopRun',
  resume: 'piwi.resumeRun',
  step: 'piwi.stepRun',
  runTo: 'piwi.runToCursor',
  finish: 'piwi.finishRun',
  showPage: 'piwi.showPausedPage',
} as const;

/** A status bar item of the run controls: its icon, its tooltip with its key, and its command (none while pausing). */
export interface ControlItem {
  text: string;
  tooltip: string;
  command: string | null;
}

/**
 * The status bar items beside the run's progress: Resume, Step and Finish while a worker is stopped, else Pause, or
 * `Pausing…` once asked; and Stop while a run is live. None without one.
 */
export function controlItems(state: ControlState): ControlItem[] {
  if (!state.active) return [];
  const stop = { text: '$(debug-stop)', tooltip: 'Piwi: Stop the run (Shift+F5)', command: RUN_COMMANDS.stop };
  if (state.stopped) {
    return [
      { text: '$(debug-continue)', tooltip: 'Piwi: Resume (F5)', command: RUN_COMMANDS.resume },
      { text: '$(debug-step-over)', tooltip: 'Piwi: Step to the next call (F10)', command: RUN_COMMANDS.step },
      {
        text: '$(debug-step-out)',
        tooltip: 'Piwi: Finish the test without stopping again (Shift+F11)',
        command: RUN_COMMANDS.finish,
      },
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
    label: pausedText(stop.stop, stop.test),
    description: `${test}${decodeURIComponent(file)}:${stop.stop.line + 1} · worker ${stop.worker}`,
  };
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

/**
 * The paused page view's document: no script, images from `data:` only and its one style by `nonce`, the caption
 * above the image.
 */
export function pausedPageHtml(view: PausedPageView, nonce: string): string {
  const src = imageSource(view.image);
  const csp = `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'`;
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `<style nonce="${nonce}">body{margin:0;padding:8px 12px;font:13px var(--vscode-font-family);color:var(--vscode-foreground)}p{margin:0 0 8px}img{max-width:100%;border:1px solid var(--vscode-panel-border)}</style>`,
    '</head>',
    '<body>',
    `<p>${escapeHtml(view.caption)}</p>`,
    src ? `<img src="${src}" alt="The page of the paused test">` : '',
    '</body>',
    '</html>',
  ].join('\n');
}
