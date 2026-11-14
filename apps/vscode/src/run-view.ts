/**
 * The runs the editor started, and those started in a terminal that follow this window's service, as their workers tell
 * them (`piwi/runSessionChanged`), shown and steered from the editor with Piwi's own commands, no debug session:
 * **Pause** while a run is live and **Stop** while one this window started is, **Resume**, **Step**, **Run to cursor**,
 * **Finish** and **End the test** while a worker is stopped, in the status bar beside the run's progress, in the
 * palette and with keys that apply only then (the `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped` context
 * keys; End the test has no key). A stop opens its file at its line, taking the focus only as the first stop shown or
 * one of the worker slot the person is on, else beside the editor in use (`StopsShown`), marked as the execution point
 * (an arrow in the gutter and the line's background), with a CodeLens above it saying what is about to run, or how the
 * test failed, and offering the controls and the code actions its worker takes there (Pick a locator, Record,
 * Assert, Assert a region, Mock a request: `piwi/stopAction`, each in the palette while a stop offers it, the
 * `piwi.runCan…` context keys), which its hover offers too; a stop no pause bar shows (a headless run's) shows an image
 * of its page in a webview beside the editor, which keeps the stop it shows while that stop is held, and where a click
 * picks the element under it (`piwi/pickAt`) when its worker takes it, unless the worker panel ("Piwi: worker N",
 * `worker-panel.ts`) watches that worker's slot: **Watch a worker** and **Pause and watch** open it on a worker whose
 * reporter shows its running test, as does the run's progress in the status bar, and **Watch a worker** on a CI run's
 * lane the **CI Runs** view names, read-only. The code a stop makes
 * (`piwi/stopCode`) is written as one workspace edit in its document, opened when it is not; while a test is stopped,
 * the end of the cursor's line in its file says how many elements the locator there matches on the stopped page
 * (`piwi/locatorAtCaret`). The editor's breakpoints go to each live run as they change (`piwi/setRunBreakpoints`), and
 * to the service as they stand, which a run a terminal starts takes (`piwi/setBreakpoints`). A run's lines are those of
 * the documents as they stood when it started: the edits since (`EditLog`) bring a stop to the line it stands on now,
 * and a breakpoint or the cursor's line back to the run's. A stop's browser is shared with Playwright's own tools only
 * when asked, each time, after a warning (`piwi/stopBind`). **Share live** shares a run on the team instance its
 * reporter reports to (`piwi/shareRun`), after a warning the first time in this window, and **Stop sharing** ends it;
 * the status bar says how a shared run stands and offers it to a run that can be shared, its click opening a menu
 * whose Stop sharing asks to confirm. While the worker panel watches a slot, the line of the call its test is in is
 * dimmed, the call after it (`piwi/runningLine`, `RunningLines`). The pure half is `run-control.ts`.
 */
import { setContextKey } from './context-keys';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import { isViewFrameData, readViewInput } from '@piwitests/core/run-view';
import {
  LOCATOR_AT_CARET_REQUEST,
  PAUSED_PAGE_REQUEST,
  PAGE_VIEW_REQUEST,
  PAGE_INPUT_REQUEST,
  DRIVE_STOP_REQUEST,
  PAGE_FRAME_NOTIFICATION,
  type PageFrame,
  type PageViewParams,
  PICK_AT_REQUEST,
  RUN_CONTROL_REQUEST,
  SET_BREAKPOINTS_NOTIFICATION,
  SHARE_RUN_REQUEST,
  SHARE_WINDOW_NOTIFICATION,
  RUNNING_LINE_NOTIFICATION,
  ASK_TO_WATCH_NOTIFICATION,
  ANSWER_ASK_REQUEST,
  HOLD_RUN_REQUEST,
  SET_RUN_BREAKPOINTS_NOTIFICATION,
  STOP_ACTION_REQUEST,
  STOP_BIND_REQUEST,
  STOP_REQUESTS_REQUEST,
  type LocatorAtCaretResult,
  type PausedPageParams,
  type PausedPageResult,
  type PickAtParams,
  type PickAtResult,
  type RunControlAction,
  type RunControlParams,
  type RunControlResult,
  type RunPlace,
  type RunSession,
  type SetBreakpointsParams,
  type ShareRunParams,
  type ShareWindowParams,
  type RunningLine,
  type AskToWatchParams,
  type AnswerAskParams,
  type HoldRunParams,
  type StopActionParams,
  type StopActionResult,
  type StopBindParams,
  type StopBindResult,
  type StopCode,
  type StopRequestsParams,
  type StopRequestsResult,
} from '@piwitests/editor/protocol';
import {
  CaretCounts,
  EditLog,
  RUN_COMMANDS,
  SHARE_WARNING,
  RESUMED_KEY_MS,
  STOP_ACTIONS,
  StopsShown,
  actsOnPage,
  asideColumn,
  stoppableRuns,
  breakpointUpdates,
  canEnd,
  canShare,
  canShowBrowser,
  type CodeActionKind,
  accessibleLabel,
  controlItems,
  controlState,
  giveBackParams,
  heardSession,
  imageClickOf,
  keepsInteract,
  lineEditOf,
  linesAbove,
  liveItem,
  liveMenu,
  RunningLines,
  progressItem,
  liveTarget,
  pagePoint,
  pausedPageHtml,
  pausedPageViewChange,
  pausedText,
  picksOnImage,
  stopCaption,
  stopPresence,
  remember,
  requestPicks,
  runStarted,
  ciLaneArg,
  runTargetArg,
  shareLiveWarning,
  STOP_SHARING,
  askToWatchText,
  holdTarget,
  holdText,
  runLabel,
  sharedText,
  spelledSession,
  stopActions,
  stopCodeNotice,
  stopControls,
  stopLensControls,
  stopIcon,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  attentionStops,
  targetStop,
  endChoice,
  watchTargetsFor,
  watchableWorkers,
  workerName,
  writtenLines,
  type CaretShown,
  type CiSessions,
  type PausedPageView,
  type RunBreakpoint,
  type RunBreakpoints,
  type RunTarget,
  type ShownStop,
  runName,
  runPagesOf,
  runPageTarget,
} from './run-control';
import { placesOf } from './breakpoints';
import { createWorkerPanel } from './worker-panel';

/** What the run controls need of the rest of the extension. */
export interface RunControlOptions {
  /** The editor's breakpoints a run pauses at, as a run's start reads them. */
  breakpoints(): RunBreakpoint[];
  /** Ends the process of the run of `ref`; false when no task of this window runs it. */
  terminate(ref: string): boolean;
  /** The sessions changed, once their controls are drawn: the status item says what they hold. */
  changed?(): void;
}

/** How long a run started here is waited for, its edits kept, before its first worker connects. */
const STARTING_MS = 120_000;

/** How long a stop's file is waited for as it opens, before the next stop's turn. */
const OPEN_MS = 5_000;

export interface RunControl extends vscode.Disposable {
  /** A session heard from the service. */
  heard(session: RunSession): void;
  /** A run started with these breakpoints: they are not sent to it again, and its lines are the documents' now. */
  started(ref: string, breakpoints: readonly RunBreakpoint[]): void;
  /**
   * The breakpoints may read otherwise (the service started, the Playwright configs changed): the service hears them,
   * as each live run does where they differ.
   */
  breakpointsChanged(): void;
  /** The service stopped: its runs' sessions with it. */
  clear(): void;
  /** The sessions kept, which the integration suite reads. */
  sessions(): RunSession[];
  /** The lines of a file drawn as an execution point, by its URI. */
  executionPoints(uri: string): number[];
  /** The lines of a file marked as a watched lane's running call, by its URI. */
  runningLines(uri: string): number[];
  /** What the paused page view shows; null while it is closed. */
  pausedPage(): PausedPageView | null;
  /** What the worker panel ("Piwi: worker N") shows; null while it is closed. */
  workerView(): PausedPageView | null;
  /** A message of the worker panel's script, as it posts it, which the integration suite sends. */
  workerMessage(message: unknown): Promise<void>;
  /** A message of the paused page's script, as it posts it, which the integration suite sends. */
  pageMessage(message: unknown): Promise<void>;
  /** A click on the paused page's image, as the view's script posts it: the pick there, once answered. */
  pickOnPage(message: unknown): Promise<void>;
  /** Write the code a stop made (`piwi/stopCode`). */
  write(code: StopCode): Promise<void>;
  /** The CI sessions changed (`piwi/ciSessionChanged`): what the worker panel says of a CI lane follows. */
  ciChanged(sessions: CiSessions): void;
  /** What the end of the cursor's line says of the locator there; null while it says nothing. */
  caretCount(): CaretShown | null;
}

/** The order of the run controls in the status bar, left to right, by command (`pausing` for the item without one). */
const ITEM_ORDER = [
  RUN_COMMANDS.resume,
  RUN_COMMANDS.step,
  RUN_COMMANDS.finish,
  RUN_COMMANDS.end,
  RUN_COMMANDS.code,
  RUN_COMMANDS.pause,
  'pausing',
  'give-up',
  RUN_COMMANDS.stop,
  'live',
  'progress',
];

/** The commands the lens's and the hover's links run. */
const STOP_COMMANDS = [
  RUN_COMMANDS.resume,
  RUN_COMMANDS.step,
  RUN_COMMANDS.runTo,
  RUN_COMMANDS.finish,
  RUN_COMMANDS.end,
  RUN_COMMANDS.showPage,
  RUN_COMMANDS.showBrowser,
  RUN_COMMANDS.share,
  ...STOP_ACTIONS.map((a) => a.command),
];

function markdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&');
}

export function registerRunControl(
  context: vscode.ExtensionContext,
  lc: LanguageClient,
  options: RunControlOptions,
): RunControl {
  let sessions = new Map<string, RunSession>();
  /** What each run was given of the breakpoints, and where the edits are mapped from for it, by ref. */
  const runs = new Map<string, RunBreakpoints>();
  /** The runs started here that no worker connected for yet, until they do or a while passes. */
  const starting = new Map<string, ReturnType<typeof setTimeout>>();
  /** The edits of the documents while a run is live or starting. */
  const edits = new EditLog();
  /** A stop was answered moments ago: `F5` waits for the next one (`piwi.runResumed`). */
  let resumed: ReturnType<typeof setTimeout> | null = null;
  /** What the editor shows of the stops, each once; their files open one after the other (`revealing`). */
  const stopsShown = new StopsShown();
  let revealing: Promise<void> = Promise.resolve();
  /** The lines drawn as an execution point, by file. */
  const drawn = new Map<string, number[]>();
  const lensesChanged = new vscode.EventEmitter<void>();
  const items = new Map<string, vscode.StatusBarItem>();
  const executionPoint = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('piwi.executionPointBackground'),
    overviewRulerColor: new vscode.ThemeColor('piwi.executionPointBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'execution-point.svg'),
    gutterIconSize: 'contain',
  });
  /** The line of the call a watched lane's test is in: dim, the call after the line, one per lane (`RunningLines`). */
  const runningLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    after: { margin: '0 0 0 3ch', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
  });
  const running = new RunningLines();
  /** The lines marked as running, by file, for the API `activate` returns. */
  const runningDrawn = new Map<string, number[]>();
  /** A held failure's line: the execution point in the dashboard's failure red. */
  const failurePoint = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('piwi.failurePointBackground'),
    overviewRulerColor: new vscode.ThemeColor('piwi.failurePointBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'failure-point.svg'),
    gutterIconSize: 'contain',
  });
  let panel: vscode.WebviewPanel | null = null;
  /**
   * The person acted on a stop: a code action, or a press, a key, text, the wheel or a pick on its page
   * (`StopsShown.acted`). A wait it ended shows the stops again.
   */
  const acted = (stop: ShownStop) => {
    if (stopsShown.acted(stop)) changed();
  };
  const workerPanel = createWorkerPanel(context, lc, { acted, changed: () => changed() });
  let page: PausedPageView | null = null;
  /** The stop the paused page view shows, and its key. */
  let pageStop: string | null = null;
  let pageShows: ShownStop | null = null;
  /** The paused page's caption of its stop as last drawn (`stopCaption`), which a note may follow. */
  let pageCaption = '';
  /** The images the view showed that a click picks on, counted: a click names the one it was on. */
  let pickable = 0;
  let wantLive = false;
  let watchingPage: PageViewParams | null = null;
  /** The watch the service accepted: the paused page offers Interact, and sends input, only for it. */
  let acceptedPage: PageViewParams | null = null;
  /**
   * The stop Interact was last on for, while it is on: the paused page keeps it on for the next stops of that stop's
   * worker slot while Watch stays on and the run goes on, and their input goes to each once its watch is
   * accepted. Null while Interact is off.
   */
  let interactOn: ShownStop | null = null;

  const stopPageView = () => {
    const previous = watchingPage;
    watchingPage = null;
    acceptedPage = null;
    if (previous) void lc.sendRequest(PAGE_VIEW_REQUEST, { ...previous, on: false }).catch(() => undefined);
  };
  /** Share live said what it sends in this window: it asks no more. */
  let liveWarned = false;
  /** This window's runs are shared live, as the service says (`piwi/shareWindowChanged`). */
  let windowShared = false;
  /** The person said yes to what sharing the window's runs sends, once in the window. */
  let windowWarned = false;

  /** Where the edits are mapped from for a run: its start, else when it was first heard. */
  const sinceOf = (ref: string) => runs.get(ref)?.since ?? edits.now();
  /** Every stop, at the line it stands on in its document now. */
  const stops = (): ShownStop[] =>
    stopsOf(sessions).map((s) => ({
      ...s,
      stop: { ...s.stop, line: edits.forward(s.stop.uri, s.stop.line, sinceOf(s.ref)) },
    }));
  const say = (message: string) => void vscode.window.showInformationMessage(`Piwi: ${message}`);

  /** The edits no live or starting run maps through go. */
  const forgetEdits = () => {
    let oldest = Infinity;
    for (const [ref, run] of runs) if (sessions.has(ref) || starting.has(ref)) oldest = Math.min(oldest, run.since);
    edits.forget(oldest);
  };

  /**
   * A document's edit, kept while a run may map its lines through it; a stop in it is drawn where it stands now. Of an
   * event of several changes (a workspace edit, an undo), each is read in the document after them all, below the lines
   * the changes above it add.
   */
  const edited = (e: vscode.TextDocumentChangeEvent) => {
    if (!sessions.size && !starting.size) return;
    const uri = e.document.uri.toString();
    const text = (line: number) => (line < e.document.lineCount ? e.document.lineAt(line).text : undefined);
    for (const change of e.contentChanges) {
      const shift = linesAbove(change, e.contentChanges);
      const edit = lineEditOf(change, shift === null ? undefined : (line) => text(line + shift));
      if (edit) edits.add(uri, edit);
    }
    if (stopsOf(sessions).some((s) => s.stop.uri === uri)) drawStops();
    if (running.tells(uri)) drawRunning();
  };

  const item = (key: string) => {
    let found = items.get(key);
    if (!found) {
      found = vscode.window.createStatusBarItem(
        `piwi.runControl.${key}`,
        vscode.StatusBarAlignment.Left,
        49.99 - ITEM_ORDER.indexOf(key) * 0.001,
      );
      items.set(key, found);
    }
    return found;
  };

  /** The context keys of the menus and keys, and the status bar items, for the sessions kept. */
  /** Draws the controls again each second while a pausing test waits in a call, for how long it has. */
  let ticking: ReturnType<typeof setInterval> | null = null;

  const drawControls = () => {
    const state = controlState(sessions);
    if (state.waiting?.waiting.since && !ticking) ticking = setInterval(drawControls, 1000);
    if (!state.waiting?.waiting.since && ticking) {
      clearInterval(ticking);
      ticking = null;
    }
    setContextKey('piwi.runActive', state.active);
    setContextKey('piwi.runStoppable', state.stoppable);
    setContextKey('piwi.runPausable', state.pausable);
    setContextKey('piwi.runStopped', state.stopped);
    setContextKey('piwi.runFailed', state.failed);
    setContextKey('piwi.runCanEnd', state.endable || !!state.waiting);
    setContextKey('piwi.runPage', runPagesOf(sessions).length > 0);
    for (const a of STOP_ACTIONS) {
      setContextKey(a.key, state.actions.includes(a.action));
    }
    setContextKey('piwi.runCanShare', state.shareable);
    setContextKey('piwi.runCanShowBrowser', state.browserShowable);
    setContextKey('piwi.runHoldable', state.holdable);
    setContextKey('piwi.runSharedLive', state.liveShared);
    setContextKey('piwi.runWatchable', state.watchable);
    const shown = new Set<string>();
    const live = liveItem(sessions, windowShared);
    const progress = progressItem(sessions);
    for (const control of [
      ...controlItems(state),
      ...(live ? [{ ...live, key: 'live' }] : []),
      ...(progress ? [{ ...progress, key: 'progress' }] : []),
    ]) {
      const key = control.key ?? control.command ?? 'pausing';
      shown.add(key);
      const i = item(key);
      i.name = control.name;
      i.accessibilityInformation = { label: accessibleLabel(control) };
      i.text = control.text;
      if (control.markdown) {
        const tooltip = new vscode.MarkdownString(control.tooltip);
        tooltip.isTrusted = {
          enabledCommands: [RUN_COMMANDS.openPage, RUN_COMMANDS.watch, RUN_COMMANDS.holdFailures],
        };
        i.tooltip = tooltip;
      } else i.tooltip = control.tooltip;
      i.command = control.command ?? undefined;
      i.show();
    }
    for (const [key, i] of items) if (!shown.has(key)) i.hide();
    options.changed?.();
  };

  /** What a stop's lens and hover name: its run, its worker and the stop itself. */
  const targetOf = (stop: ShownStop): RunTarget => ({ ref: stop.ref, worker: stop.worker, since: stop.stop.since });

  /** A stop's controls and code actions as links, for its hover. */
  const hoverOf = (stop: ShownStop) => {
    const target = encodeURIComponent(JSON.stringify([targetOf(stop)]));
    const link = (c: { title: string; command: string }) => `[${c.title}](command:${c.command}?${target})`;
    const controls = [
      ...stopControls(stop),
      ...(stop.stop.bar ? [] : [{ title: 'Show the page', command: RUN_COMMANDS.showPage }]),
      ...(canShowBrowser(stop) ? [{ title: 'Show the browser', command: RUN_COMMANDS.showBrowser }] : []),
    ].map(link);
    const actions = stopActions(stop).map(link);
    const share = canShare(stop) ? [link({ title: 'Share with Playwright tools', command: RUN_COMMANDS.share })] : [];
    const present = stopPresence(stop, sessions);
    const hover = new vscode.MarkdownString(
      [
        markdown(pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)),
        ...(present ? [markdown(present)] : []),
        controls.join(' · '),
        ...(actions.length ? [actions.join(' · ')] : []),
        ...share,
      ].join('\n\n'),
    );
    hover.isTrusted = { enabledCommands: STOP_COMMANDS };
    return hover;
  };

  /** The running line of each watched lane in the visible editors of its file, at its line now. */
  const drawRunning = () => {
    runningDrawn.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const marks = running.marks(uri, editor.document.lineCount, (file, line, ref) =>
        edits.forward(file, line, sinceOf(ref)),
      );
      editor.setDecorations(
        runningLine,
        marks.map((mark) => {
          const end = editor.document.lineAt(mark.line).range.end;
          return {
            range: new vscode.Range(mark.line, 0, mark.line, end.character),
            renderOptions: { after: { contentText: mark.text } },
          };
        }),
      );
      if (marks.length)
        runningDrawn.set(
          uri,
          marks.map((mark) => mark.line),
        );
    }
  };

  /** The execution point of each stop in the visible editors of its file. */
  const drawStops = () => {
    const all = stops();
    drawn.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const here = all.filter((s) => s.stop.uri === uri && s.stop.line < editor.document.lineCount);
      const marked = (failure: boolean) =>
        here
          .filter((s) => (s.stop.reason === 'failure') === failure)
          .map((s) => ({ range: editor.document.lineAt(s.stop.line).range, hoverMessage: hoverOf(s) }));
      editor.setDecorations(executionPoint, marked(false));
      editor.setDecorations(failurePoint, marked(true));
      if (here.length)
        drawn.set(
          uri,
          here.map((s) => s.stop.line),
        );
    }
    lensesChanged.fire();
  };

  /**
   * Show a stop's file at its line, with the focus when `focus` asks for it and its wait is not over (`late`); whether
   * it took the focus, once it shows. Never over a panel in sight (the paused page view, the worker panel). With the
   * focus, as a debugger does: where the file shows already, else in the active group. Without it, the editor in use is
   * left alone: a file that shows already keeps its selection, the stop drawn there, and another opens in a group that
   * is neither the active one nor a panel's (`asideColumn`).
   */
  const reveal = async (stop: ShownStop, focus: boolean, late: () => boolean): Promise<boolean> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(stop.stop.uri));
    const focused = focus && !late();
    const showing = vscode.window.visibleTextEditors.find((e) => e.document === document);
    if (showing && !focused) return false;
    const at = document.validatePosition(new vscode.Position(stop.stop.line, stop.stop.character ?? 0));
    const panels = [panel?.visible ? panel.viewColumn : undefined, workerPanel.column()].filter(
      (c): c is vscode.ViewColumn => c !== undefined,
    );
    const onPanel = panels.includes(vscode.window.tabGroups.activeTabGroup.viewColumn);
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(at, at),
      preview: false,
      preserveFocus: !focused,
      viewColumn:
        showing?.viewColumn ?? (focused && !onPanel ? undefined : asideColumn(vscode.window.tabGroups.all, panels)),
    });
    return focused;
  };

  /**
   * Open a stop's file in its turn, unless it went on meanwhile, with the focus as `StopsShown` decides then. The next
   * stop's turn comes once the file shows, or after `OPEN_MS`: a file that shows later takes no focus, and counts as
   * open once it shows.
   */
  /** The stops already called attention to (`attentionStops`). */
  const attended = new Set<string>();
  /** A notification for a stop that waits while the window is in the background: Resume, or go to its line. */
  const callAttention = async (stop: ShownStop) => {
    const resume = 'Resume';
    const go = 'Go to the stopped line';
    const said = pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout ?? null);
    const picked = await vscode.window.showWarningMessage(`Piwi: ${said}`, resume, go);
    if (picked === resume) await answerStop('resume', targetOf(stop));
    else if (picked === go) await openStop(stop);
  };
  const openStop = async (heard: ShownStop) => {
    const stop = stops().find((s) => stopKey(s) === stopKey(heard));
    if (!stop) return;
    const started = Date.now();
    const shown = reveal(stop, stopsShown.focusFor(stop), () => Date.now() - started >= OPEN_MS)
      .then((focused) => stopsShown.opened(stop, focused))
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, OPEN_MS);
    });
    await Promise.race([shown, waited]);
    clearTimeout(timer);
  };

  /** Whether an action runs in the test's window at the stop the paused page shows: its Escape is the page's. */
  const actingOnPage = () => !!pageStop && !!stops().find((s) => stopKey(s) === pageStop)?.stop.acting;

  const showPage = (shown: PausedPageView) => {
    const view = { ...shown, acting: actingOnPage() };
    const same = view.live && page?.live?.shown === view.live.shown;
    page = view;
    if (!panel) return;
    if (same) void panel.webview.postMessage({ type: 'state', view });
    else
      panel.webview.html = pausedPageHtml(
        view,
        randomBytes(16).toString('base64'),
        panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'paused-page.js')).toString(),
      );
  };

  /** The service accepted the watch the paused page asked last. */
  const accepted = () => !!watchingPage && watchingPage === acceptedPage;
  /** Whether the paused page offers Interact (`live.input`): its stop takes input, and a watch on was accepted. */
  const offersInput = (on: boolean) => !!pageShows?.takes.includes('input') && (!on || accepted());

  const watchPage = async (on: boolean) => {
    if (!on) interactOff();
    stopPageView();
    const stop = pageShows;
    const current = page;
    if (!stop || !current?.live || !panel?.visible) return;
    const shown = current.live.shown;
    showPage({ ...current, live: { ...current.live, on, input: offersInput(on), interacting: false }, note: null });
    if (!on) return;
    const params: PageViewParams = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, on: true };
    watchingPage = params;
    const answer = await lc.sendRequest<RunControlResult>(PAGE_VIEW_REQUEST, params).catch(() => null);
    if (page?.live?.shown !== shown || watchingPage !== params) return;
    if (!answer?.ok) {
      interactOff();
      stopPageView();
      showPage({
        ...page,
        live: { ...page.live, on: false, input: offersInput(false), interacting: false },
        note: answer?.message ?? 'The editor service did not answer.',
      });
      return;
    }
    acceptedPage = params;
    // Accepted, the watch offers Interact, and Interact kept for the slot sends the new stop's input at once.
    showPage({
      ...page,
      live: { ...page.live, input: offersInput(true), interacting: keepsInteract(interactOn, stop) },
    });
  };

  /**
   * Interact goes off: when it was on, the stop it was last on for is given back (`piwi/driveStop`, `on: false`), a
   * refusal said under the caption while the page shows that stop.
   */
  const interactOff = () => {
    const stop = interactOn;
    interactOn = null;
    if (!stop) return;
    void lc
      .sendRequest<RunControlResult>(DRIVE_STOP_REQUEST, giveBackParams(stop))
      .catch(() => null)
      .then((answer) => {
        if (answer?.ok || !page || pageStop !== stopKey(stop)) return;
        showPage({ ...page, note: answer?.message ?? 'The editor service did not answer.' });
      });
  };

  const pageMessage = async (message: unknown) => {
    const m = message as Record<string, unknown> | null;
    if (!m || !page?.live || m.shown !== page.live.shown) return void pickOnPage(message);
    if (m.type === 'ready') return void panel?.webview.postMessage({ type: 'state', view: page });
    if (m.type === 'view' && typeof m.on === 'boolean') {
      wantLive = m.on;
      return watchPage(m.on);
    }
    if (m.type === 'interact' && typeof m.on === 'boolean' && page.live.on) {
      const stop = pageShows;
      // Interact is offered once the service accepted the watch: until then, turning it on changes nothing.
      if (m.on && (!stop || !page.live.input || !accepted())) return void showPage(page);
      showPage({ ...page, live: { ...page.live, interacting: m.on } });
      // Interact on only routes the page's input: the person's first click, key, wheel or pick drives the stop.
      if (m.on) interactOn = stop;
      else interactOff();
      return;
    }
    if (m.type === 'pick') return pickOnPage(message);
    const refused = () => {
      if (m.type === 'input') void panel?.webview.postMessage({ type: 'input-result', id: m.id, ok: false });
    };
    if (!watchingPage || !accepted() || !page.live.on || !panel?.visible) return refused();
    const events =
      m.type === 'release' ? [] : m.type === 'input' && page.live.interacting ? readViewInput(m.events) : null;
    if (!events || typeof events === 'string') return refused();
    if (m.type === 'input' && pageShows && actsOnPage(events)) acted(pageShows);
    const answer = await lc
      .sendRequest<RunControlResult>(PAGE_INPUT_REQUEST, { ...watchingPage, events, release: m.type === 'release' })
      .catch(() => null);
    if (m.type === 'input')
      void panel?.webview.postMessage({ type: 'input-result', id: m.id, ok: answer?.ok === true });
    // A refused batch may have held the `up` of a button sent down before it: what the page holds is let go.
    if (m.type === 'input' && !answer?.ok && watchingPage) {
      void lc.sendRequest(PAGE_INPUT_REQUEST, { ...watchingPage, events: [], release: true }).catch(() => undefined);
    }
    if (!answer?.ok && page?.live?.shown === m.shown)
      showPage({ ...page, note: answer?.message ?? 'The editor service did not answer.' });
  };

  /**
   * The page of a stop in the paused page view, opened beside the editor without focus, asked of its worker. The view
   * uses the stop's live-view capability when offered, with a still image for every reporter.
   */
  const openPage = async (stop: ShownStop) => {
    const key = stopKey(stop);
    // Another slot's stop, or one that takes no input, turns Interact off before the watch ends; the same slot's keeps
    // it.
    if (keepsInteract(interactOn, stop)) interactOn = stop;
    else interactOff();
    stopPageView();
    pageStop = key;
    pageShows = stop;
    stopsShown.view(stop);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'piwi.pausedPage',
        'Piwi: paused page',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] },
      );
      panel.webview.onDidReceiveMessage((message: unknown) => void pageMessage(message));
      let visible = panel.visible;
      panel.onDidChangeViewState(() => {
        if (!panel) return;
        const change = pausedPageViewChange(visible, panel.visible, wantLive);
        visible = panel.visible;
        if (change === 'end') {
          interactOff();
          stopPageView();
          if (page?.live)
            showPage({ ...page, live: { ...page.live, on: false, input: offersInput(false), interacting: false } });
        } else if (change === 'watch') void watchPage(true);
      });
      panel.onDidDispose(() => {
        interactOff();
        stopPageView();
        wantLive = false;
        panel = null;
        page = null;
        pageStop = null;
        pageShows = null;
        stopsShown.view(null);
      });
    } else if (!panel.visible) {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    pageCaption = stopCaption(stop, sessions);
    const shown = ++pickable;
    const live = stop.takes.includes('view')
      ? {
          shown,
          on: false,
          input: stop.takes.includes('input'),
          interacting: false,
          clickCounts: stop.takes.includes('input-clicks'),
        }
      : undefined;
    showPage({ image: null, caption: `${pageCaption} · asking the test for its page…`, live });
    const answer = await lc
      .sendRequest<PausedPageResult>(PAUSED_PAGE_REQUEST, {
        ref: stop.ref,
        worker: stop.worker,
        what: 'image',
      } satisfies PausedPageParams)
      .catch(() => null);
    if (pageStop !== key) return;
    if (watchingPage && page?.live?.shown === shown) {
      showPage({ ...page, caption: pageCaption });
      return;
    }
    const currentLive = page?.live?.shown === shown ? page.live : live;
    showPage(
      answer?.image
        ? {
            image: answer.image,
            caption: pageCaption,
            pick: picksOnImage(stop.takes, answer.image) ? { shown } : null,
            live: currentLive,
          }
        : { image: null, caption: `${pageCaption} · the test sent no image of its page`, live: currentLive },
    );
    if (live && wantLive && !watchingPage) void watchPage(true);
  };

  /**
   * A click on the image the view shows: the element under it picked on the stopped page (`piwi/pickAt`, in CSS pixels
   * of its viewport), its locator going to the editor in place of the one on the stopped line, as the pause bar's pick
   * does; the answer said under the caption. A click on an image the view no longer shows picks nothing.
   */
  const pickOnPage = async (message: unknown) => {
    const click = imageClickOf(message);
    const view = page;
    const stop = pageShows;
    if (!click || !view?.pick || click.shown !== view.pick.shown || !stop) return;
    const point = pagePoint(click, view.image);
    if (!point) return;
    showPage({ ...view, note: 'Picking the element under the click…' });
    acted(stop);
    const params: PickAtParams = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, ...point };
    const answer = await lc.sendRequest<PickAtResult>(PICK_AT_REQUEST, params).catch(() => null);
    if (page?.pick?.shown !== click.shown) return;
    showPage({ ...page, note: answer?.message ?? 'The editor service did not answer.' });
  };

  /** The editor's breakpoints as last sent to the service (`piwi/setBreakpoints`), as text. */
  let editorSent = '';
  /**
   * The editor's breakpoints to each live run whose breakpoints differ, as lines of its code, and to the service as
   * they stand, for a run a terminal starts.
   */
  const sendBreakpoints = () => {
    const breakpoints = options.breakpoints();
    for (const update of breakpointUpdates(sessions, breakpoints, runs, edits)) {
      void lc.sendNotification(SET_RUN_BREAKPOINTS_NOTIFICATION, update);
    }
    const editor: SetBreakpointsParams = { places: placesOf(breakpoints) };
    const text = JSON.stringify(editor);
    if (text === editorSent) return;
    editorSent = text;
    // A service that did not hear them (stopped meanwhile) hears them as it runs again.
    lc.sendNotification(SET_BREAKPOINTS_NOTIFICATION, editor).catch(() => {
      if (editorSent === text) editorSent = '';
    });
  };

  /** The stops shown once the paused page view stops waiting for a slot's next stop (`StopsShown.waitsUntil`). */
  let waking: ReturnType<typeof setTimeout> | null = null;
  const wakeWhenWaited = () => {
    if (waking) clearTimeout(waking);
    const until = stopsShown.waitsUntil();
    waking = until === null ? null : setTimeout(changed, Math.max(0, until - Date.now()));
  };

  /**
   * The stops changed, or the paused page view's wait is over: each new stop opens its file at its line in its turn
   * (`openStop`), and the view opens the page `StopsShown` gives, else says its stop went on. The worker panel in sight
   * shows the stops of the slot it watches.
   */
  const changed = () => {
    // The run Interact was on for ended or went away: a rerun under its ref starts with Interact off.
    if (interactOn && !sessions.has(interactOn.ref)) interactOff();
    const now = stops();
    const keys = new Set(now.map(stopKey));
    drawControls();
    drawStops();
    running.sessionsChanged(sessions);
    drawRunning();
    caretMoved();
    const show = stopsShown.changed(sessions, now, { watched: (s) => workerPanel.watches(s.ref, s.slot) });
    wakeWhenWaited();
    for (const stop of show.open) revealing = revealing.then(() => openStop(stop)).catch(() => undefined);
    workerPanel.changed(sessions, now);
    if (show.page) void openPage(show.page);
    else if (panel && pageStop && !keys.has(pageStop)) {
      stopPageView();
      pageStop = null;
      pageShows = null;
      showPage({ image: null, caption: 'The test went on.' });
    } else if (panel && pageStop && page?.caption.startsWith(pageCaption)) {
      // Who drives the stop and who watches its page, as they change.
      const current = now.find((s) => stopKey(s) === pageStop);
      const caption = current ? stopCaption(current, sessions) : pageCaption;
      if (caption !== pageCaption) {
        showPage({ ...page, caption: caption + page.caption.slice(pageCaption.length) });
        pageCaption = caption;
      }
    }
    if (panel && !pageStop && !sessions.size) showPage({ image: null, caption: 'The run ended.' });
    // An action that starts or ends in the test's window there decides where Escape on the view goes.
    if (panel && page && pageStop && !!page.acting !== actingOnPage()) showPage(page);
  };

  /**
   * The stop a command acts on: its own (`went-on` when that stop ended), else the one `StopsShown.choose` gives for the
   * caret (for a `control` in the moments after an answer, one of the slot answered or none), else the one chosen;
   * among those `offers` keeps, when it keeps any.
   */
  const chooseStop = async (
    arg: unknown,
    offers?: (stop: ShownStop) => boolean,
    control = false,
  ): Promise<ShownStop | 'went-on' | null> => {
    const all = stops();
    const target = runTargetArg(arg);
    if (target) return targetStop(all, target) ?? 'went-on';
    const editor = vscode.window.activeTextEditor;
    const caret = editor ? { uri: editor.document.uri.toString(), line: editor.selection.active.line } : null;
    const offering = offers ? all.filter(offers) : all;
    const candidates = stopsFor(offering.length ? offering : all, caret);
    const chosen = stopsShown.choose(candidates, caret, control);
    if (chosen !== 'ask') return chosen;
    const picked = await vscode.window.showQuickPick(
      candidates.map((s) => ({ ...stopPick(s), s })),
      { placeHolder: 'Which stopped test?' },
    );
    return picked?.s ?? null;
  };

  /** Send a control, saying why it was not taken; the run's answer, null when the service did not answer. */
  const control = async (params: RunControlParams) => {
    const answer = await lc.sendRequest<RunControlResult>(RUN_CONTROL_REQUEST, params).catch(() => null);
    if (!answer) say('the editor service did not answer.');
    else if (!answer.ok) say(answer.message);
    return answer;
  };

  /** `F5` stays Piwi's for a moment after a stop was answered (`piwi.runResumed`). */
  const answered = () => {
    if (resumed) clearTimeout(resumed);
    setContextKey('piwi.runResumed', true);
    resumed = setTimeout(() => {
      resumed = null;
      setContextKey('piwi.runResumed', false);
    }, RESUMED_KEY_MS);
  };

  /**
   * Answer a stop: the command's, the caret's or the one chosen, naming the stop it answers. `placeOf` gives `run-to`
   * its line of the run's code, or why there is none.
   */
  const answerStop = async (
    action: Exclude<RunControlAction, 'pause'>,
    arg: unknown,
    placeOf?: (stop: ShownStop) => RunPlace | string,
  ) => {
    const stop = await chooseStop(arg, action === 'end' ? canEnd : undefined, true);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) {
      // A key pressed again after an answer, before the next stop: nothing to do.
      if (!stops().length && !resumed) say('no test is stopped.');
      return;
    }
    const place = placeOf?.(stop);
    if (typeof place === 'string') return say(place);
    const params: RunControlParams = { ref: stop.ref, worker: stop.worker, action, since: stop.stop.since };
    const token = stopsShown.answered(stop, action);
    wakeWhenWaited();
    const answer = await control(place ? { ...params, place } : params);
    if (answer && !answer.ok) {
      if (stopsShown.refused(token)) changed();
      return;
    }
    // Taken, or no answer: the run may have taken it, and what the answer recorded stays.
    stopsShown.taken(token);
    if (answer) answered();
  };

  /**
   * End the test: at a stop (the command's, the caret's or the one chosen), else, while no stop can end and the
   * command names none, where a Pause waits for the call a test runs (`give-up`): the command's worker, the only one,
   * or the one chosen.
   */
  const endTest = async (arg: unknown) => {
    const waiting = endChoice(sessions, stops().some(canEnd), runTargetArg(arg));
    if (waiting === 'stop' || !waiting.length) return answerStop('end', arg);
    const chosen =
      waiting.length === 1
        ? waiting[0]
        : await vscode.window
            .showQuickPick(
              waiting.map((w) => ({ label: w.waiting.title, description: workerName(w.slot), w })),
              { placeHolder: 'End which waiting test?' },
            )
            .then((picked) => picked?.w);
    if (chosen) await control({ ref: chosen.ref, worker: chosen.worker, action: 'give-up' });
  };

  /**
   * Start a code action at a stop: the command's, the caret's or the one chosen among those offering it. Mock a
   * request lists the responses the test kept first, to choose the one to mock. The code comes in `piwi/stopCode`,
   * which says what it wrote; the other answers are said here.
   */
  const startAction = async (action: CodeActionKind, arg: unknown) => {
    const stop = await chooseStop(arg, (s) => stopActions(s).some((a) => a.action === action));
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
    acted(stop);
    const params: StopActionParams = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, action };
    if (action === 'mock') {
      const listed = await lc
        .sendRequest<StopRequestsResult>(STOP_REQUESTS_REQUEST, {
          ref: stop.ref,
          worker: stop.worker,
          since: stop.stop.since,
        } satisfies StopRequestsParams)
        .catch(() => null);
      if (!listed) return say('the editor service did not answer.');
      if (!listed.ok || !listed.requests.length) return say(listed.message);
      const picked = await vscode.window.showQuickPick(requestPicks(listed.requests), {
        placeHolder: `Mock which response? ${listed.message} Type to filter by URL.`,
      });
      if (!picked) return;
      params.request = picked.id;
    }
    const answer = await lc.sendRequest<StopActionResult>(STOP_ACTION_REQUEST, params).catch(() => null);
    if (!answer) say('the editor service did not answer.');
    else if (!answer.ok || action !== 'mock') say(answer.message);
  };

  /**
   * Share a stop's browser with Playwright's own tools until its test ends: the command's stop, the caret's or the one
   * chosen, once the person said yes to the warning. The answer names the command that joins it, to copy, and offers
   * to stop sharing.
   */
  const share = async (arg: unknown) => {
    const stop = await chooseStop(arg, canShare);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
    if (!canShare(stop))
      return say('the stopped test’s reporter cannot share its browser: update @piwitests/reporter.');
    const yes = 'Share';
    if ((await vscode.window.showWarningMessage(`Piwi: ${SHARE_WARNING}`, { modal: true }, yes)) !== yes) return;
    const bind = (on: boolean) =>
      lc
        .sendRequest<StopBindResult>(STOP_BIND_REQUEST, {
          ref: stop.ref,
          worker: stop.worker,
          since: stop.stop.since,
          on,
        } satisfies StopBindParams)
        .catch(() => null);
    const shared = await bind(true);
    if (!shared) return say('the editor service did not answer.');
    if (!shared.ok || !shared.command) return say(shared.message);
    const copy = 'Copy the command';
    const unshare = 'Stop sharing';
    const picked = await vscode.window.showWarningMessage(`Piwi: ${sharedText(shared)}`, copy, unshare);
    if (picked === copy) await vscode.env.clipboard.writeText(shared.command);
    if (picked === unshare) {
      const stopped = await bind(false);
      say(stopped?.message ?? 'the editor service did not answer.');
    }
  };

  /**
   * Show the browser: the window of the command's stop, the caret's or the one chosen comes to the front. Only a refusal
   * is said: the window itself shows it worked.
   */
  const showBrowser = async (arg: unknown) => {
    const stop = await chooseStop(arg, canShowBrowser);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
    if (!stop.stop.bar) {
      return say("the test's window cannot be shown: it runs headless, or its stop names no page. Run it headed.");
    }
    acted(stop);
    const params: StopActionParams = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, action: 'front' };
    const answer = await lc.sendRequest<StopActionResult>(STOP_ACTION_REQUEST, params).catch(() => null);
    if (!answer) say('the editor service did not answer.');
    else if (!answer.ok) say(answer.message);
  };

  /**
   * Turn a run's **Hold failures** over, or set it as the command names (`{ ref, on }`): the only live run that has
   * one, else the one chosen. The service answers what it does now.
   */
  const holdFailures = async (arg: unknown) => {
    const target = holdTarget(sessions, arg);
    if ('none' in target) return say(target.none);
    let chosen = 'ref' in target ? target : null;
    if (!chosen && 'candidates' in target) {
      const picked = await vscode.window.showQuickPick(
        target.candidates.map((ref) => {
          const session = sessions.get(ref);
          return {
            label: session ? runLabel(session) : ref,
            description: session?.root ?? undefined,
            detail: session?.hold ? holdText(session.hold) : undefined,
            ref,
            on: !session?.hold?.on,
          };
        }),
        { placeHolder: 'Turn Hold failures over for which run?' },
      );
      chosen = picked ? { ref: picked.ref, on: picked.on } : null;
    }
    if (!chosen) return;
    const answer = await lc
      .sendRequest<RunControlResult>(HOLD_RUN_REQUEST, chosen satisfies HoldRunParams)
      .catch(() => null);
    say(answer?.message ?? 'the editor service did not answer.');
  };

  /**
   * Share a run live on the team instance (`on`), or stop sharing it: the command's run, else the only one it fits,
   * else the one chosen. The first share in this window says what goes out and to whom, and waits for a yes; a run
   * that cannot be shared is asked anyway, and the service says why. Shared, the answer offers the run page's link.
   */
  const shareLive = async (arg: unknown, on: boolean) => {
    const named = runTargetArg(arg);
    const target = named ? { ref: named.ref } : liveTarget(sessions, on);
    if ('none' in target) return say(target.none);
    let ref = 'ref' in target ? target.ref : null;
    if (!ref && 'candidates' in target) {
      const picked = await vscode.window.showQuickPick(
        target.candidates.map((candidate) => ({
          label: sessions.get(candidate)?.root ?? candidate,
          description: candidate,
          ref: candidate,
        })),
        { placeHolder: on ? 'Share which run live?' : 'Stop sharing which run?' },
      );
      ref = picked?.ref ?? null;
    }
    if (!ref) return;
    const live = sessions.get(ref)?.live;
    if (on && !live?.refused && !liveWarned) {
      // The first share of the window chooses its scope too: this run, or the window's runs until stopped.
      const yes = 'Share this run';
      const all = "Share this window's runs";
      const picked = await vscode.window.showWarningMessage(
        `Piwi: ${shareLiveWarning(live)}`,
        { modal: true },
        yes,
        all,
      );
      if (picked === all) return shareWindow(ref, true);
      if (picked !== yes) return;
      liveWarned = true;
    }
    const answer = await lc
      .sendRequest<RunControlResult>(SHARE_RUN_REQUEST, { ref, on } satisfies ShareRunParams)
      .catch(() => null);
    if (!answer) return say('the editor service did not answer.');
    if (!answer.ok || !on || !live?.page) return say(answer.message);
    const open = 'Open the run page';
    const copy = "Copy the run page's link";
    const stop = 'Stop sharing';
    const picked = await vscode.window.showInformationMessage(`Piwi: ${answer.message}`, open, copy, stop);
    if (picked === open) await vscode.env.openExternal(vscode.Uri.parse(live.page));
    if (picked === copy) await vscode.env.clipboard.writeText(live.page);
    if (picked === stop) await shareLive({ ref }, false);
  };

  /**
   * Share this window's runs live until the person stops or the window closes (`on`), the run of `ref` too when one is
   * named, or stop sharing them all: the first share of the window says what goes out and waits for a yes.
   */
  const shareWindow = async (ref: string | null, on: boolean) => {
    if (on && !windowWarned) {
      const yes = "Share this window's runs";
      const live = ref ? sessions.get(ref)?.live : undefined;
      const picked = await vscode.window.showWarningMessage(
        `Piwi: ${shareLiveWarning(live, true)}`,
        { modal: true },
        yes,
      );
      if (picked !== yes) return;
      windowWarned = true;
    }
    const params: ShareRunParams = { on, scope: 'window', ...(ref ? { ref } : {}) };
    const answer = await lc.sendRequest<RunControlResult>(SHARE_RUN_REQUEST, params).catch(() => null);
    say(answer ? answer.message : 'the editor service did not answer.');
  };

  /** Whether the person confirms **Stop sharing** with `question`, asked of what the Live item's menu showed. */
  const stopSharingConfirmed = async (question: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(question, { modal: true }, STOP_SHARING)) === STOP_SHARING;

  /**
   * The Live item's menu (`liveMenu`): open a shared run's page, copy its link, or stop sharing it, or this window's
   * runs, once the person confirms; the palette's Stop sharing commands, named for what they do, ask nothing.
   */
  const openLiveMenu = async () => {
    const items = liveMenu(sessions, windowShared);
    if (!items.length) return say('no run is shared live.');
    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({ label: item.label, ...(item.detail ? { detail: item.detail } : {}), item })),
      { placeHolder: 'Piwi: the run shared live' },
    );
    if (!picked) return;
    const { action, ref, url, question } = picked.item;
    if (action === 'open' && url) await vscode.env.openExternal(vscode.Uri.parse(url));
    if (action === 'copy' && url) {
      await vscode.env.clipboard.writeText(url);
      say("the run page's link is copied.");
    }
    if (action === 'stop' && ref && question && (await stopSharingConfirmed(question))) {
      await shareLive({ ref }, false);
    }
    if (action === 'stop-window' && question && (await stopSharingConfirmed(question))) await shareWindow(null, false);
  };

  /** A teammate asks to watch a run of this window: Share live shares it, Not now tells them. */
  const askedToWatch = async (ask: AskToWatchParams) => {
    const share = 'Share live';
    const notNow = 'Not now';
    const picked = await vscode.window.showInformationMessage(`Piwi: ${askToWatchText(ask)}`, share, notNow);
    if (picked === share) return shareLive({ ref: ask.ref }, true);
    if (picked !== notNow) return;
    const answer = await lc
      .sendRequest<RunControlResult>(ANSWER_ASK_REQUEST, {
        ref: ask.ref,
        id: ask.id,
        answer: 'not-now',
      } satisfies AnswerAskParams)
      .catch(() => null);
    if (answer && !answer.ok) say(answer.message);
  };

  /** Opens a run's page on the instance: the one the command names, the only one known, or the one chosen. */
  const openRunPage = async (arg: unknown) => {
    let target = runPageTarget(sessions, arg);
    if (!target) {
      const pages = runPagesOf(sessions);
      if (!pages.length) return say('no run named its page on the instance yet.');
      const picked = await vscode.window.showQuickPick(
        pages.map((page) => ({ label: runName(page), description: sessions.get(page.ref)?.root ?? page.ref, page })),
        { placeHolder: 'Open which run?' },
      );
      target = picked?.page ?? null;
    }
    if (target) await vscode.env.openExternal(vscode.Uri.parse(target.url));
  };

  /** The code actions of a stop, to choose one: the command's stop, the caret's or the one chosen. */
  const chooseAction = async (arg: unknown) => {
    const stop = await chooseStop(arg, (s) => stopActions(s).length > 0);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
    const offered = stopActions(stop);
    if (!offered.length) return say('no code can be written from this stop.');
    const picked = await vscode.window.showQuickPick(
      offered.map((a) => ({ label: `${a.icon} ${a.title}`, detail: a.detail, action: a.action })),
      { placeHolder: `${pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)}: write what?` },
    );
    if (picked) await startAction(picked.action, targetOf(stop));
  };

  /** Why the code a stop made was not written, with the code to copy. */
  const notWritten = async (code: StopCode, why: string) => {
    const copy = 'Copy the code';
    const picked = await vscode.window.showWarningMessage(`Piwi: ${why}`, copy);
    if (picked === copy) await vscode.env.clipboard.writeText(code.code);
  };

  /**
   * Write the code a stop made, as one workspace edit (one undo step) in its document, opened when it is not, so the
   * service follows it as it follows every edit; only into the text the service placed it in (the version it names,
   * else the file as saved). The block is shown without taking the focus, and the sentence and warnings said.
   */
  const write = async (code: StopCode) => {
    // Code of a desktop app's throwaway checkout is offered to copy, its sentence saying why; no file is edited.
    if (code.copy) {
      const copy = 'Copy the code';
      const notice = stopCodeNotice(code);
      const picked = await (notice.severity === 'warning'
        ? vscode.window.showWarningMessage(`Piwi: ${notice.text}`, copy)
        : vscode.window.showInformationMessage(`Piwi: ${notice.text}`, copy));
      if (picked === copy) await vscode.env.clipboard.writeText(code.code);
      return;
    }
    const uri = vscode.Uri.parse(code.uri);
    const name = decodeURIComponent(code.uri.slice(code.uri.lastIndexOf('/') + 1));
    const document = await Promise.resolve(vscode.workspace.openTextDocument(uri)).catch(() => null);
    if (!document) return notWritten(code, `${name} could not be opened, so the code was not written.`);
    const placed = code.version === null ? !document.isDirty : document.version === code.version;
    if (!placed) {
      return notWritten(code, `${name} changed while the code was made, so it was not written: run the action again.`);
    }
    const edit = new vscode.WorkspaceEdit();
    for (const e of code.edits) {
      const { start, end } = e.range;
      edit.replace(uri, new vscode.Range(start.line, start.character, end.line, end.character), e.newText);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      return notWritten(code, `${name} could not be edited, so the code was not written.`);
    }
    const { start, end } = writtenLines(code);
    const editor =
      vscode.window.visibleTextEditors.find((e) => e.document === document) ??
      (await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true }));
    editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const notice = stopCodeNotice(code);
    void (notice.severity === 'warning'
      ? vscode.window.showWarningMessage(notice.text)
      : vscode.window.showInformationMessage(notice.text));
  };

  /** The count at the end of the cursor's line, in the visible editors of its file. */
  const caretDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3ch', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
  });
  let caretShown: CaretShown | null = null;
  const drawCaret = () => {
    const shown = caretShown;
    for (const editor of vscode.window.visibleTextEditors) {
      const { document } = editor;
      if (!shown || document.uri.toString() !== shown.uri || shown.line >= document.lineCount) {
        editor.setDecorations(caretDecoration, []);
        continue;
      }
      const end = document.lineAt(shown.line).range.end;
      const after = { contentText: `Piwi: ${shown.text}` };
      editor.setDecorations(caretDecoration, [{ range: new vscode.Range(end, end), renderOptions: { after } }]);
    }
  };
  const counts = new CaretCounts(
    (query) => lc.sendRequest<LocatorAtCaretResult>(LOCATOR_AT_CARET_REQUEST, query),
    (shown) => {
      caretShown = shown;
      drawCaret();
    },
  );
  /** The stop the count asked about last: the cursor leaving its file takes its outline down. */
  let counted: ShownStop | null = null;
  /**
   * The cursor moved, or the stops or a line changed: the count asks about the stop in the active editor's file (the
   * one on the cursor's line, else the first), for the cursor's line; outside the stopped files, it takes the outline
   * of the stop it counted on down; with no stop whose reporter counts, it asks nothing.
   */
  const caretMoved = () => {
    const all = stops().filter((s) => s.takes.includes('locator'));
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri.toString();
    const line = editor?.selection.active.line ?? 0;
    const here = all.filter((s) => s.stop.uri === uri);
    const stop = here.find((s) => s.stop.line === line) ?? here[0];
    if (stop && editor && uri) {
      counted = stop;
      const query = { ref: stop.ref, worker: stop.worker, since: stop.stop.since, uri, line };
      return counts.moved(query, editor.document.lineAt(line).text);
    }
    const last = counted && all.find((s) => stopKey(s) === stopKey(counted!));
    if (!last) counted = null;
    counts.moved(last ? { ref: last.ref, worker: last.worker, since: last.stop.since, uri: null, line: null } : null);
  };

  /** The run a Stop names, else the only one it stops (`stoppableRuns`), else the one chosen. */
  const chooseRun = async (arg: unknown): Promise<string | null> => {
    const target = runTargetArg(arg);
    if (target) return target.ref;
    const live = stoppableRuns(sessions);
    if (live.length < 2) return live[0]?.ref ?? null;
    const picked = await vscode.window.showQuickPick(
      live.map((s) => ({
        label:
          s.workers
            .map((w) => w.test?.title.join(' › '))
            .filter(Boolean)
            .join(', ') || s.ref,
        description: s.root ?? undefined,
        ref: s.ref,
      })),
      { placeHolder: 'Stop which run?' },
    );
    return picked?.ref ?? null;
  };

  /**
   * Watch a worker's test in the worker panel: the command's worker, the only one that can be watched, or the one
   * chosen; `pause` pauses it there too (Pause and watch).
   */
  const watchWorker = async (arg: unknown, pause: boolean) => {
    // A CI run's lane, from the CI Runs view: read-only, and on the dashboard where the editor cannot show it.
    const ci = pause ? null : ciLaneArg(arg);
    if (ci) {
      const answer = await workerPanel.openCi(ci);
      if (answer.ok) return;
      if (!ci.dashboard) return say(answer.message);
      const choice = await vscode.window.showWarningMessage(`Piwi: ${answer.message}`, 'Watch on the dashboard');
      if (choice) await vscode.commands.executeCommand('piwi.openInDashboard', ci.dashboard);
      return;
    }
    const targets = watchTargetsFor(watchableWorkers(sessions, pause), runTargetArg(arg));
    if (!targets.length) {
      say(
        pause
          ? 'no running test can be paused and watched.'
          : 'no running test can be watched: its reporter shows a stopped test alone, or no test runs.',
      );
      return;
    }
    const chosen =
      targets.length === 1
        ? targets[0]
        : await vscode.window.showQuickPick(targets, {
            placeHolder: pause ? 'Pause and watch which worker?' : 'Watch which worker?',
          });
    if (!chosen) return;
    const answer = await workerPanel.open(chosen.ref, chosen.lane);
    if (!answer.ok) say(answer.message);
    else if (pause) await control({ ref: chosen.ref, worker: chosen.worker, action: 'pause' });
  };

  const disposables: vscode.Disposable[] = [
    {
      dispose: () => {
        stopPageView();
        panel?.dispose();
      },
    },
    lc.onNotification(PAGE_FRAME_NOTIFICATION, (frame: PageFrame) => {
      const stop = pageShows;
      if (
        !stop ||
        !page?.live?.on ||
        !panel?.visible ||
        frame.ref !== stop.ref ||
        frame.worker !== stop.worker ||
        frame.since !== stop.stop.since
      )
        return;
      if ('refused' in frame) return showPage({ ...page, note: frame.refused });
      if (!isViewFrameData(frame.data)) return;
      const image = { mime: 'image/jpeg' as const, data: frame.data, width: frame.width, height: frame.height };
      showPage({
        ...page,
        image,
        pick: picksOnImage(stop.takes, image) ? { shown: page.live.shown } : null,
      });
    }),
    executionPoint,
    failurePoint,
    runningLine,
    lensesChanged,
    caretDecoration,
    { dispose: () => counts.dispose() },
    vscode.window.onDidChangeVisibleTextEditors(() => {
      drawStops();
      drawRunning();
      drawCaret();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => caretMoved()),
    vscode.window.onDidChangeTextEditorSelection(() => caretMoved()),
    vscode.workspace.onDidChangeTextDocument(edited),
    vscode.debug.onDidChangeBreakpoints(() => sendBreakpoints()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('piwi.breakpoints')) sendBreakpoints();
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: lensesChanged.event,
        provideCodeLenses(document) {
          const uri = document.uri.toString();
          return stops()
            .filter((s) => s.stop.uri === uri && s.stop.line < document.lineCount)
            .flatMap((s) => {
              const range = new vscode.Range(s.stop.line, 0, s.stop.line, 0);
              const target = [targetOf(s)];
              return [
                new vscode.CodeLens(range, {
                  title: `${stopIcon(s.stop)} ${pausedText(s.stop, s.test, s.terminal, s.runner, s.checkout)}`,
                  command: s.stop.bar ? '' : RUN_COMMANDS.showPage,
                  arguments: target,
                }),
                ...stopLensControls(s).map(
                  (c) => new vscode.CodeLens(range, { title: c.title, command: c.command, arguments: target }),
                ),
              ];
            });
        },
      },
    ),
    vscode.commands.registerCommand(RUN_COMMANDS.pause, async (arg?: unknown) => {
      const target = runTargetArg(arg);
      const refs = target ? [target.ref] : [...sessions.keys()];
      if (!refs.length) return say('no run started from the editor is running.');
      for (const ref of refs) await control({ ref, action: 'pause' });
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.stop, async (arg?: unknown) => {
      const ref = await chooseRun(arg);
      const elsewhere = (session: RunSession | undefined) =>
        say(
          session?.checkout
            ? 'the desktop app runs this reproduction: stop it there.'
            : 'the run was not started in this window: stop it in its terminal.',
        );
      if (!ref) {
        if (!sessions.size) say('no run started from the editor is running.');
        // Only runs another tool stops are live: the first says where.
        else if (!stoppableRuns(sessions).length) elsewhere(sessions.values().next().value);
        return;
      }
      if (options.terminate(ref)) return;
      elsewhere(sessions.get(ref));
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.end, (arg?: unknown) => endTest(arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.resume, (arg?: unknown) => answerStop('resume', arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.step, (arg?: unknown) => answerStop('step', arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.finish, (arg?: unknown) => answerStop('finish', arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.runTo, async (arg?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return say('place the cursor on the line to run to.');
      const uri = editor.document.uri.toString();
      const caret = editor.selection.active.line;
      // The cursor's line in the run's code, which the edits since its start may have moved.
      await answerStop('run-to', arg, (stop) => {
        const line = edits.back(uri, caret, sinceOf(stop.ref));
        return line === null
          ? 'the cursor’s line changed since the run started, so the running test has no line to stop at there.'
          : { uri, line };
      });
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.showPage, async (arg?: unknown) => {
      const stop = await chooseStop(arg);
      if (stop === 'went-on') say('the test went on.');
      else if (stop) await openPage(stop);
      else say('no test is stopped.');
    }),
    ...STOP_ACTIONS.map((a) =>
      vscode.commands.registerCommand(a.command, (arg?: unknown) => startAction(a.action, arg)),
    ),
    vscode.commands.registerCommand(RUN_COMMANDS.code, (arg?: unknown) => chooseAction(arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.watch, (arg?: unknown) => watchWorker(arg, false)),
    vscode.commands.registerCommand(RUN_COMMANDS.pauseAndWatch, (arg?: unknown) => watchWorker(arg, true)),
    vscode.commands.registerCommand(RUN_COMMANDS.openTrace, () => workerPanel.openTrace()),
    workerPanel,
    vscode.commands.registerCommand(RUN_COMMANDS.share, (arg?: unknown) => share(arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.showBrowser, (arg?: unknown) => showBrowser(arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.shareLive, (arg?: unknown) => shareLive(arg, true)),
    vscode.commands.registerCommand(RUN_COMMANDS.stopSharing, (arg?: unknown) => shareLive(arg, false)),
    vscode.commands.registerCommand(RUN_COMMANDS.shareWindow, (arg?: unknown) =>
      shareWindow(runTargetArg(arg)?.ref ?? null, true),
    ),
    vscode.commands.registerCommand(RUN_COMMANDS.stopSharingWindow, () => shareWindow(null, false)),
    vscode.commands.registerCommand(RUN_COMMANDS.liveMenu, () => openLiveMenu()),
    lc.onNotification(RUNNING_LINE_NOTIFICATION, (told: RunningLine) => {
      // Spelled as VS Code spells a document's URI, as a stop's is.
      const call = told?.call ? { ...told.call, uri: vscode.Uri.parse(told.call.uri).toString() } : null;
      if (told && running.heard({ ...told, call })) drawRunning();
    }),
    lc.onNotification(SHARE_WINDOW_NOTIFICATION, (changed: ShareWindowParams) => {
      windowShared = changed?.on === true;
      setContextKey('piwi.windowSharedLive', windowShared);
      drawControls();
    }),
    lc.onNotification(ASK_TO_WATCH_NOTIFICATION, (ask: AskToWatchParams) => void askedToWatch(ask)),
    // A service started again shares this window's runs as the person left them: the window has not closed.
    lc.onDidChangeState((e) => {
      if (e.newState !== State.Running || !windowShared) return;
      void lc
        .sendRequest<RunControlResult>(SHARE_RUN_REQUEST, { on: true, scope: 'window' } satisfies ShareRunParams)
        .catch(() => null);
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.openPage, (arg?: unknown) => openRunPage(arg)),
    vscode.commands.registerCommand(RUN_COMMANDS.holdFailures, (arg?: unknown) => holdFailures(arg)),
    {
      dispose: () => {
        items.forEach((i) => i.dispose());
        if (ticking) clearInterval(ticking);
        panel?.dispose();
        if (resumed) clearTimeout(resumed);
        if (waking) clearTimeout(waking);
        starting.forEach((timer) => clearTimeout(timer));
      },
    },
  ];
  drawControls();

  return {
    heard(session) {
      clearTimeout(starting.get(session.ref));
      starting.delete(session.ref);
      // A run not started here, or a rerun under the ref of one that ended, maps its lines from when it is first heard.
      const spelled = spelledSession(session, (uri) => vscode.Uri.parse(uri).toString());
      const heardNow = heardSession(sessions, runs, spelled, edits.now());
      const { fresh } = heardNow;
      sessions = heardNow.sessions;
      if (session.ended) forgetEdits();
      changed();
      // A test held at its failure or at page.pause() while the window is in the background calls once.
      const due = attentionStops(stopsOf(sessions), attended);
      if (!vscode.window.state.focused) for (const stop of due) void callAttention(stop);
      // Breakpoints changed between the run's start and its first worker.
      if (fresh) sendBreakpoints();
    },
    started(ref, breakpoints) {
      remember(runs, ref, runStarted(edits.now(), breakpoints));
      clearTimeout(starting.get(ref));
      const timer = setTimeout(() => {
        starting.delete(ref);
        forgetEdits();
      }, STARTING_MS);
      starting.set(ref, timer);
    },
    clear() {
      sessions = new Map();
      running.clear();
      // A service started again holds none of the editor's breakpoints.
      editorSent = '';
      forgetEdits();
      changed();
    },
    breakpointsChanged: () => sendBreakpoints(),
    sessions: () => [...sessions.values()],
    executionPoints: (uri) => drawn.get(uri) ?? [],
    runningLines: (uri) => runningDrawn.get(uri) ?? [],
    pausedPage: () => (panel ? page : null),
    workerView: () => workerPanel.view(),
    workerMessage: (message) => workerPanel.message(message),
    pageMessage,
    pickOnPage,
    write,
    caretCount: () => caretShown,
    ciChanged: (now) => workerPanel.ciChanged(now),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
