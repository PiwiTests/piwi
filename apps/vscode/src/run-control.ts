/**
 * The runs the editor started, as the extension shows and steers them, with no VS Code API, so it is tested without
 * an editor: the sessions kept from `piwi/runSessionChanged` (the latest of each ref, one that ended dropped), where
 * each stopped worker stands, what the controls offer in each state, the line shown above a stop, the stop a control
 * acts on, the breakpoints sent to each run as they change, and the page a stop shows as an image.
 */
import type {
  EditorBreakpoint,
  PausedImage,
  RunSession,
  RunStop,
  RunTest,
  SetRunBreakpointsParams,
} from '@piwitests/editor/protocol';

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
      { text: '$(debug-pause)', tooltip: 'Piwi: Pause the run at its next call (F6)', command: RUN_COMMANDS.pause },
      stop,
    ];
  }
  if (state.pausing) {
    return [{ text: '$(loading~spin) Pausing…', tooltip: 'Piwi: the run stops at its next call', command: null }, stop];
  }
  return [stop];
}

/** What a control names: a run, and one of its workers. */
export interface RunTarget {
  ref: string;
  worker?: number;
}

/** The run a command's argument names (a lens, a hover, a status bar item); null for none. */
export function runTargetArg(arg: unknown): RunTarget | null {
  const target = arg as Partial<RunTarget> | null | undefined;
  if (typeof target?.ref !== 'string') return null;
  return typeof target.worker === 'number' ? { ref: target.ref, worker: target.worker } : { ref: target.ref };
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

/**
 * The `piwi/setRunBreakpoints` the live runs need for the editor's breakpoints `places`: one per run whose breakpoints
 * differ from those it has (`sent`, by ref: the ones its command started with, else the last sent), which `sent` then
 * records.
 */
export function breakpointUpdates(
  sessions: Sessions,
  places: readonly EditorBreakpoint[],
  sent: Map<string, string>,
): SetRunBreakpointsParams[] {
  const text = JSON.stringify(places);
  const updates: SetRunBreakpointsParams[] = [];
  for (const ref of sessions.keys()) {
    if (sent.get(ref) === text) continue;
    remember(sent, ref, text);
    updates.push({ ref, places: [...places] });
  }
  return updates;
}

/** Keep what a run was sent, the oldest of more than {@link MAX_SENT} forgotten. */
export function remember(sent: Map<string, string>, ref: string, text: string): void {
  sent.delete(ref);
  sent.set(ref, text);
  for (const oldest of sent.keys()) {
    if (sent.size <= MAX_SENT) break;
    sent.delete(oldest);
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

/** A JPEG in base64, as the service hands one; anything else is no image. */
function imageSource(image: PausedImage | null): string | null {
  if (image?.mime !== 'image/jpeg' || typeof image.data !== 'string') return null;
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
