/**
 * The runs the editor started, as their workers tell them (`piwi/runSessionChanged`), shown and steered from the
 * editor with Piwi's own commands, no debug session: **Pause** and **Stop** while a run is live, **Resume**, **Step**,
 * **Run to cursor** and **Finish** while a worker is stopped, in the status bar beside the run's progress, in the
 * palette and with keys that apply only then (the `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped` context
 * keys). A stop opens its file at its line, marked as the execution point (an arrow in the gutter and the line's
 * background), with a CodeLens above it saying what is about to run and offering the controls, which its hover offers
 * too; a stop no pause bar shows (a headless run's) shows an image of its page in a webview beside the editor. The
 * editor's breakpoints go to each live run as they change (`piwi/setRunBreakpoints`). A run's lines are those of the
 * documents as they stood when it started: the edits since (`EditLog`) bring a stop to the line it stands on now, and
 * a breakpoint or the cursor's line back to the run's. The pure half is `run-control.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  PAUSED_PAGE_REQUEST,
  RUN_CONTROL_REQUEST,
  SET_RUN_BREAKPOINTS_NOTIFICATION,
  type PausedPageParams,
  type PausedPageResult,
  type RunControlAction,
  type RunControlParams,
  type RunControlResult,
  type RunPlace,
  type RunSession,
} from '@piwitests/editor/protocol';
import {
  EditLog,
  RUN_COMMANDS,
  breakpointUpdates,
  controlItems,
  controlState,
  lineEditOf,
  pausedPageHtml,
  pausedText,
  remember,
  runStarted,
  runTargetArg,
  spelledSession,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  targetStop,
  withSession,
  type PausedPageView,
  type RunBreakpoint,
  type RunBreakpoints,
  type RunTarget,
  type ShownStop,
} from './run-control';

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
  /** The service stopped: its runs' sessions with it. */
  clear(): void;
  /** The sessions kept, which the integration suite reads. */
  sessions(): RunSession[];
  /** The lines of a file drawn as an execution point, by its URI. */
  executionPoints(uri: string): number[];
  /** What the paused page view shows; null while it is closed. */
  pausedPage(): PausedPageView | null;
}

/** The order of the run controls in the status bar, left to right, by command (`pausing` for the item without one). */
const ITEM_ORDER = [
  RUN_COMMANDS.resume,
  RUN_COMMANDS.step,
  RUN_COMMANDS.finish,
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
  RUN_COMMANDS.showPage,
];

/** The controls offered at a stop, as the lens and the hover name them. */
const STOP_CONTROLS = [
  { title: 'Resume', command: RUN_COMMANDS.resume },
  { title: 'Step', command: RUN_COMMANDS.step },
  { title: 'Run to cursor', command: RUN_COMMANDS.runTo },
  { title: 'Finish', command: RUN_COMMANDS.finish },
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
  /** The stop the paused page view shows. */
  let pageStop: string | null = null;

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

  /** A document's edit, kept while a run may map its lines through it; a stop in it is drawn where it stands now. */
  const edited = (e: vscode.TextDocumentChangeEvent) => {
    if (!sessions.size && !starting.size) return;
    const uri = e.document.uri.toString();
    const alone = e.contentChanges.length === 1;
    const lineAfter = (line: number) => (line < e.document.lineCount ? e.document.lineAt(line).text : undefined);
    for (const change of e.contentChanges) {
      const edit = lineEditOf(change, alone ? lineAfter : undefined);
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

  /** A stop's controls as links, for its hover. */
  const hoverOf = (stop: ShownStop) => {
    const target = encodeURIComponent(JSON.stringify([targetOf(stop)]));
    const links = [
      ...STOP_CONTROLS,
      ...(stop.stop.bar ? [] : [{ title: 'Show the page', command: RUN_COMMANDS.showPage }]),
    ].map((c) => `[${c.title}](command:${c.command}?${target})`);
    const hover = new vscode.MarkdownString(`${markdown(pausedText(stop.stop, stop.test))}\n\n${links.join(' · ')}`);
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

  /** The page of a stop in the paused page view, opened beside the editor without focus, asked of its worker. */
  const openPage = async (stop: ShownStop) => {
    const key = stopKey(stop);
    pageStop = key;
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'piwi.pausedPage',
        'Piwi: paused page',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false, localResourceRoots: [] },
      );
      panel.onDidDispose(() => {
        panel = null;
        page = null;
        pageStop = null;
      });
    } else {
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    const file = decodeURIComponent(stop.stop.uri.slice(stop.stop.uri.lastIndexOf('/') + 1));
    const caption = `${pausedText(stop.stop, stop.test)} · ${file}:${stop.stop.line + 1}`;
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
        ? { image: answer.image, caption }
        : { image: null, caption: `${caption} · the test sent no image of its page` },
    );
  };

  /** The editor's breakpoints to each live run whose breakpoints differ, as lines of its code. */
  const sendBreakpoints = () => {
    for (const update of breakpointUpdates(sessions, options.breakpoints(), runs, edits)) {
      void lc.sendNotification(SET_RUN_BREAKPOINTS_NOTIFICATION, update);
    }
  };

  const changed = () => {
    const now = stops();
    const keys = new Set(now.map(stopKey));
    for (const key of revealed) if (!keys.has(key)) revealed.delete(key);
    drawControls();
    drawStops();
    for (const stop of now) {
      const key = stopKey(stop);
      if (revealed.has(key)) continue;
      revealed.add(key);
      void reveal(stop).catch(() => undefined);
      if (!stop.stop.bar) void openPage(stop);
    }
    if (panel && pageStop && !keys.has(pageStop)) {
      pageStop = null;
      showPage({ image: null, caption: 'The test went on.' });
    }
    if (panel && !pageStop && !sessions.size) showPage({ image: null, caption: 'The run ended.' });
  };

  /**
   * The stop a control acts on: the command's own (`went-on` when that stop ended), else the one at the caret's line,
   * else the one chosen.
   */
  const chooseStop = async (arg: unknown): Promise<ShownStop | 'went-on' | null> => {
    const all = stops();
    const target = runTargetArg(arg);
    if (target) return targetStop(all, target) ?? 'went-on';
    const editor = vscode.window.activeTextEditor;
    const caret = editor ? { uri: editor.document.uri.toString(), line: editor.selection.active.line } : null;
    const candidates = stopsFor(all, caret);
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
    const stop = await chooseStop(arg);
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
    vscode.window.onDidChangeVisibleTextEditors(() => drawStops()),
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
                  title: pausedText(s.stop, s.test),
                  command: s.stop.bar ? '' : RUN_COMMANDS.showPage,
                  arguments: target,
                }),
                ...STOP_CONTROLS.map((c) => new vscode.CodeLens(range, { ...c, arguments: target })),
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
      const fresh = !session.ended && !sessions.has(session.ref);
      clearTimeout(starting.get(session.ref));
      starting.delete(session.ref);
      // A run not started here maps its lines from when it is first heard.
      if (fresh && !runs.has(session.ref)) remember(runs, session.ref, runStarted(edits.now(), null));
      sessions = withSession(
        sessions,
        spelledSession(session, (uri) => vscode.Uri.parse(uri).toString()),
      );
      if (session.ended) {
        runs.delete(session.ref);
        forgetEdits();
      }
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
      forgetEdits();
      changed();
    },
    sessions: () => [...sessions.values()],
    executionPoints: (uri) => drawn.get(uri) ?? [],
    pausedPage: () => (panel ? page : null),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
