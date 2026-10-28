/**
 * The runs the editor started, and those started in a terminal that follow this window's service, as their workers tell
 * them (`piwi/runSessionChanged`), shown and steered from the editor with Piwi's own commands, no debug session:
 * **Pause** while a run is live and **Stop** while one this window started is, **Resume**, **Step**, **Run to cursor**,
 * **Finish** and **End the test** while a worker is stopped, in the status bar beside the run's progress, in the
 * palette and with keys that apply only then (the `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped` context
 * keys; End the test has no key). A stop opens its file at its line, marked as the execution point (an arrow in the
 * gutter and the line's background), with a CodeLens above it saying what is about to run, or how the test failed, and
 * offering the controls and the code actions its worker takes there (Pick a locator, Record here, Assert, Assert a
 * region, Mock a request: `piwi/stopAction`, each in the palette while a stop offers it, the `piwi.runCan…` context
 * keys), which its hover offers too; a stop no pause bar shows (a headless run's) shows an image of its page in a
 * webview beside the editor, where a click picks the element under it (`piwi/pickAt`) when its worker takes it. The
 * code a stop makes (`piwi/stopCode`) is written as one workspace edit in its document, opened when it is not; while a
 * test is stopped, the end of the cursor's line in its file says how many elements the locator there matches on the
 * stopped page (`piwi/locatorAtCaret`). The editor's breakpoints go to each live run as they change
 * (`piwi/setRunBreakpoints`), and to the service as they stand, which a run a terminal starts takes
 * (`piwi/setBreakpoints`). A run's lines are those of the documents as they stood when it started: the edits since
 * (`EditLog`) bring a stop to the line it stands on now, and a breakpoint or the cursor's line back to the run's. A
 * stop's browser is shared with Playwright's own tools only when asked, each time, after a warning (`piwi/stopBind`).
 * The pure half is `run-control.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  LOCATOR_AT_CARET_REQUEST,
  PAUSED_PAGE_REQUEST,
  PICK_AT_REQUEST,
  RUN_CONTROL_REQUEST,
  SET_BREAKPOINTS_NOTIFICATION,
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
  type StopActionKind,
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
  STOP_ACTIONS,
  breakpointUpdates,
  canEnd,
  canShare,
  controlItems,
  controlState,
  heardSession,
  imageClickOf,
  lineEditOf,
  linesAbove,
  pagePoint,
  pausedPageHtml,
  pausedText,
  picksOnImage,
  remember,
  requestPicks,
  runStarted,
  runTargetArg,
  sharedText,
  spelledSession,
  stopActions,
  stopCodeNotice,
  stopControls,
  stopIcon,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  targetStop,
  writtenLines,
  type CaretShown,
  type PausedPageView,
  type RunBreakpoint,
  type RunBreakpoints,
  type RunTarget,
  type ShownStop,
} from './run-control';
import { placesOf } from './breakpoints';

/** What the run controls need of the rest of the extension. */
export interface RunControlOptions {
  /** The editor's breakpoints a run pauses at, as a run's start reads them. */
  breakpoints(): RunBreakpoint[];
  /** Ends the process of the run of `ref`; false when no task of this window runs it. */
  terminate(ref: string): boolean;
}

/** How long a run started here is waited for, its edits kept, before its first worker connects. */
const STARTING_MS = 120_000;

/**
 * How long `F5` stays Piwi's after a stop is answered: it does nothing until the next stop, rather than start a debug
 * session.
 */
const RESUMED_KEY_MS = 2_000;

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
  /** What the paused page view shows; null while it is closed. */
  pausedPage(): PausedPageView | null;
  /** A click on the paused page's image, as the view's script posts it: the pick there, once answered. */
  pickOnPage(message: unknown): Promise<void>;
  /** Write the code a stop made (`piwi/stopCode`). */
  write(code: StopCode): Promise<void>;
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
  RUN_COMMANDS.stop,
];

/** The commands the lens's and the hover's links run. */
const STOP_COMMANDS = [
  RUN_COMMANDS.resume,
  RUN_COMMANDS.step,
  RUN_COMMANDS.runTo,
  RUN_COMMANDS.finish,
  RUN_COMMANDS.end,
  RUN_COMMANDS.showPage,
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
  /** The stops whose file was opened at their line: each is revealed once. */
  const revealed = new Set<string>();
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
  let panel: vscode.WebviewPanel | null = null;
  let page: PausedPageView | null = null;
  /** The stop the paused page view shows, and its key. */
  let pageStop: string | null = null;
  let pageShows: ShownStop | null = null;
  /** The images the view showed that a click picks on, counted: a click names the one it was on. */
  let pickable = 0;

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
  };

  const item = (key: string) => {
    let found = items.get(key);
    if (!found) {
      found = vscode.window.createStatusBarItem(
        `piwi.runControl.${key}`,
        vscode.StatusBarAlignment.Left,
        49.99 - ITEM_ORDER.indexOf(key) * 0.001,
      );
      found.name = 'Piwi run control';
      items.set(key, found);
    }
    return found;
  };

  /** The context keys of the menus and keys, and the status bar items, for the sessions kept. */
  const drawControls = () => {
    const state = controlState(sessions);
    void vscode.commands.executeCommand('setContext', 'piwi.runActive', state.active);
    void vscode.commands.executeCommand('setContext', 'piwi.runPausable', state.pausable);
    void vscode.commands.executeCommand('setContext', 'piwi.runStopped', state.stopped);
    void vscode.commands.executeCommand('setContext', 'piwi.runCanEnd', state.endable);
    for (const a of STOP_ACTIONS) {
      void vscode.commands.executeCommand('setContext', a.key, state.actions.includes(a.action));
    }
    void vscode.commands.executeCommand('setContext', 'piwi.runCanShare', state.shareable);
    const shown = new Set<string>();
    for (const control of controlItems(state)) {
      const key = control.command ?? 'pausing';
      shown.add(key);
      const i = item(key);
      i.text = control.text;
      i.tooltip = control.tooltip;
      i.command = control.command ?? undefined;
      i.show();
    }
    for (const [key, i] of items) if (!shown.has(key)) i.hide();
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
    ].map(link);
    const actions = stopActions(stop).map(link);
    const share = canShare(stop) ? [link({ title: 'Share with Playwright tools', command: RUN_COMMANDS.share })] : [];
    const hover = new vscode.MarkdownString(
      [
        markdown(pausedText(stop.stop, stop.test, stop.terminal)),
        controls.join(' · '),
        ...(actions.length ? [actions.join(' · ')] : []),
        ...share,
      ].join('\n\n'),
    );
    hover.isTrusted = { enabledCommands: STOP_COMMANDS };
    return hover;
  };

  /** The execution point of each stop in the visible editors of its file. */
  const drawStops = () => {
    const all = stops();
    drawn.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      const here = all.filter((s) => s.stop.uri === uri && s.stop.line < editor.document.lineCount);
      editor.setDecorations(
        executionPoint,
        here.map((s) => ({ range: editor.document.lineAt(s.stop.line).range, hoverMessage: hoverOf(s) })),
      );
      if (here.length)
        drawn.set(
          uri,
          here.map((s) => s.stop.line),
        );
    }
    lensesChanged.fire();
  };

  /** Open a stop's file at its line, once per stop. */
  const reveal = async (stop: ShownStop) => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(stop.stop.uri));
    const at = document.validatePosition(new vscode.Position(stop.stop.line, stop.stop.character ?? 0));
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(at, at), preview: false });
  };

  const showPage = (view: PausedPageView) => {
    page = view;
    if (panel) panel.webview.html = pausedPageHtml(view, randomBytes(16).toString('base64'));
  };

  /**
   * The page of a stop in the paused page view, opened beside the editor without focus, asked of its worker. The view
   * runs a script only where a click on the image picks (`pausedPageHtml`), which posts the click (`pickOnPage`).
   */
  const openPage = async (stop: ShownStop) => {
    const key = stopKey(stop);
    pageStop = key;
    pageShows = stop;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'piwi.pausedPage',
        'Piwi: paused page',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [] },
      );
      panel.webview.onDidReceiveMessage((message: unknown) => void pickOnPage(message));
      panel.onDidDispose(() => {
        panel = null;
        page = null;
        pageStop = null;
        pageShows = null;
      });
    } else {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    const file = decodeURIComponent(stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1));
    const caption = `${pausedText(stop.stop, stop.test, stop.terminal)} · ${file}:${stop.stop.line + 1}`;
    showPage({ image: null, caption: `${caption} · asking the test for its page…` });
    const answer = await lc
      .sendRequest<PausedPageResult>(PAUSED_PAGE_REQUEST, {
        ref: stop.ref,
        worker: stop.worker,
        what: 'image',
      } satisfies PausedPageParams)
      .catch(() => null);
    if (pageStop !== key) return;
    showPage(
      answer?.image
        ? {
            image: answer.image,
            caption,
            pick: picksOnImage(stop.takes, answer.image) ? { shown: ++pickable } : null,
          }
        : { image: null, caption: `${caption} · the test sent no image of its page` },
    );
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

  const changed = () => {
    const now = stops();
    const keys = new Set(now.map(stopKey));
    for (const key of revealed) if (!keys.has(key)) revealed.delete(key);
    drawControls();
    drawStops();
    caretMoved();
    for (const stop of now) {
      const key = stopKey(stop);
      if (revealed.has(key)) continue;
      revealed.add(key);
      void reveal(stop).catch(() => undefined);
      if (!stop.stop.bar) void openPage(stop);
    }
    if (panel && pageStop && !keys.has(pageStop)) {
      pageStop = null;
      pageShows = null;
      showPage({ image: null, caption: 'The test went on.' });
    }
    if (panel && !pageStop && !sessions.size) showPage({ image: null, caption: 'The run ended.' });
  };

  /**
   * The stop a control acts on: the command's own (`went-on` when that stop ended), else the one at the caret's line,
   * else the one chosen; among those `offers` keeps, when it keeps any.
   */
  const chooseStop = async (
    arg: unknown,
    offers?: (stop: ShownStop) => boolean,
  ): Promise<ShownStop | 'went-on' | null> => {
    const all = stops();
    const target = runTargetArg(arg);
    if (target) return targetStop(all, target) ?? 'went-on';
    const editor = vscode.window.activeTextEditor;
    const caret = editor ? { uri: editor.document.uri.toString(), line: editor.selection.active.line } : null;
    const offering = offers ? all.filter(offers) : all;
    const candidates = stopsFor(offering.length ? offering : all, caret);
    if (candidates.length < 2) return candidates[0] ?? null;
    const picked = await vscode.window.showQuickPick(
      candidates.map((s) => ({ ...stopPick(s), s })),
      { placeHolder: 'Which stopped test?' },
    );
    return picked?.s ?? null;
  };

  const control = async (params: RunControlParams) => {
    const answer = await lc.sendRequest<RunControlResult>(RUN_CONTROL_REQUEST, params).catch(() => null);
    if (!answer) say('the editor service did not answer.');
    else if (!answer.ok) say(answer.message);
    return answer?.ok === true;
  };

  /** `F5` stays Piwi's for a moment after a stop was answered (`piwi.runResumed`). */
  const answered = () => {
    if (resumed) clearTimeout(resumed);
    void vscode.commands.executeCommand('setContext', 'piwi.runResumed', true);
    resumed = setTimeout(() => {
      resumed = null;
      void vscode.commands.executeCommand('setContext', 'piwi.runResumed', false);
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
    const stop = await chooseStop(arg, action === 'end' ? canEnd : undefined);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) {
      // A key pressed again after an answer, before the next stop: nothing to do.
      if (!stops().length && !resumed) say('no test is stopped.');
      return;
    }
    const place = placeOf?.(stop);
    if (typeof place === 'string') return say(place);
    const params: RunControlParams = { ref: stop.ref, worker: stop.worker, action, since: stop.stop.since };
    if (await control(place ? { ...params, place } : params)) answered();
  };

  /**
   * Start a code action at a stop: the command's, the caret's or the one chosen among those offering it. Mock a
   * request lists the responses the test kept first, to choose the one to mock. The code comes in `piwi/stopCode`,
   * which says what it wrote; the other answers are said here.
   */
  const startAction = async (action: StopActionKind, arg: unknown) => {
    const stop = await chooseStop(arg, (s) => stopActions(s).some((a) => a.action === action));
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
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

  /** The code actions of a stop, to choose one: the command's stop, the caret's or the one chosen. */
  const chooseAction = async (arg: unknown) => {
    const stop = await chooseStop(arg, (s) => stopActions(s).length > 0);
    if (stop === 'went-on') return say('the test went on.');
    if (!stop) return say('no test is stopped.');
    const offered = stopActions(stop);
    if (!offered.length) return say('no code can be written from this stop.');
    const picked = await vscode.window.showQuickPick(
      offered.map((a) => ({ label: a.title, detail: a.detail, action: a.action })),
      { placeHolder: `${pausedText(stop.stop, stop.test, stop.terminal)}: write what?` },
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

  /** The run a Stop names, else the only one live, else the one chosen. */
  const chooseRun = async (arg: unknown): Promise<string | null> => {
    const target = runTargetArg(arg);
    if (target) return target.ref;
    const live = [...sessions.values()];
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

  const disposables: vscode.Disposable[] = [
    executionPoint,
    lensesChanged,
    caretDecoration,
    { dispose: () => counts.dispose() },
    vscode.window.onDidChangeVisibleTextEditors(() => {
      drawStops();
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
                  title: `${stopIcon(s.stop)} ${pausedText(s.stop, s.test, s.terminal)}`,
                  command: s.stop.bar ? '' : RUN_COMMANDS.showPage,
                  arguments: target,
                }),
                ...[...stopControls(s), ...stopActions(s).map((a) => ({ ...a, title: a.lens }))].map(
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
      if (!ref) {
        if (!sessions.size) say('no run started from the editor is running.');
        return;
      }
      if (!options.terminate(ref)) say('the run was not started in this window: stop it in its terminal.');
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.end, (arg?: unknown) => answerStop('end', arg)),
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
    vscode.commands.registerCommand(RUN_COMMANDS.share, (arg?: unknown) => share(arg)),
    {
      dispose: () => {
        items.forEach((i) => i.dispose());
        panel?.dispose();
        if (resumed) clearTimeout(resumed);
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
      // A service started again holds none of the editor's breakpoints.
      editorSent = '';
      forgetEdits();
      changed();
    },
    breakpointsChanged: () => sendBreakpoints(),
    sessions: () => [...sessions.values()],
    executionPoints: (uri) => drawn.get(uri) ?? [],
    pausedPage: () => (panel ? page : null),
    pickOnPage,
    write,
    caretCount: () => caretShown,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
