/**
 * The runs the editor started, as their workers tell them (`piwi/runSessionChanged`), shown and steered from the
 * editor with Piwi's own commands, no debug session: **Pause** and **Stop** while a run is live, **Resume**, **Step**,
 * **Run to cursor** and **Finish** while a worker is stopped, in the status bar beside the run's progress, in the
 * palette and with keys that apply only then (the `piwi.runActive`, `piwi.runPausable` and `piwi.runStopped` context
 * keys). A stop opens its file at its line, marked as the execution point (an arrow in the gutter and the line's
 * background), with a CodeLens above it saying what is about to run and offering the controls, which its hover offers
 * too; a stop no pause bar shows (a headless run's) shows an image of its page in a webview beside the editor. The
 * editor's breakpoints go to each live run as they change (`piwi/setRunBreakpoints`). The pure half is
 * `run-control.ts`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  PAUSED_PAGE_REQUEST,
  RUN_CONTROL_REQUEST,
  SET_RUN_BREAKPOINTS_NOTIFICATION,
  type EditorBreakpoint,
  type PausedPageParams,
  type PausedPageResult,
  type RunControlAction,
  type RunControlParams,
  type RunControlResult,
  type RunPlace,
  type RunSession,
} from '@piwitests/editor/protocol';
import {
  RUN_COMMANDS,
  breakpointUpdates,
  controlItems,
  controlState,
  pausedPageHtml,
  pausedText,
  remember,
  runTargetArg,
  spelledSession,
  stopKey,
  stopPick,
  stopsFor,
  stopsOf,
  withSession,
  type PausedPageView,
  type RunTarget,
  type ShownStop,
} from './run-control';

/** What the run controls need of the rest of the extension. */
export interface RunControlOptions {
  /** The editor's breakpoints a run pauses at, as a run's start reads them. */
  breakpoints(): EditorBreakpoint[];
  /** Ends the process of the run of `ref`; false when no task of this window runs it. */
  terminate(ref: string): boolean;
}

export interface RunControl extends vscode.Disposable {
  /** A session heard from the service. */
  heard(session: RunSession): void;
  /** A run started with these breakpoints: they are not sent to it again. */
  started(ref: string, breakpoints: readonly EditorBreakpoint[]): void;
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
  /** The breakpoints each run has, by ref, as `breakpointUpdates` reads and records them. */
  const sent = new Map<string, string>();
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

  const stops = () => stopsOf(sessions);
  const say = (message: string) => void vscode.window.showInformationMessage(`Piwi: ${message}`);

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

  /** A stop's controls as links, for its hover. */
  const hoverOf = (stop: ShownStop) => {
    const target = encodeURIComponent(JSON.stringify([{ ref: stop.ref, worker: stop.worker } satisfies RunTarget]));
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

  /** The editor's breakpoints to each live run whose breakpoints differ. */
  const sendBreakpoints = () => {
    for (const update of breakpointUpdates(sessions, options.breakpoints(), sent)) {
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

  /** The stop a control acts on: the command's own, else the one at the caret's line, else the one chosen. */
  const chooseStop = async (arg: unknown): Promise<ShownStop | null> => {
    const all = stops();
    const target = runTargetArg(arg);
    if (target) {
      return (
        all.find((s) => s.ref === target.ref && (target.worker === undefined || s.worker === target.worker)) ?? null
      );
    }
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
  };

  /** Answer a stop: the command's, the caret's or the one chosen. */
  const answerStop = async (action: Exclude<RunControlAction, 'pause'>, arg: unknown, place?: RunPlace) => {
    const stop = await chooseStop(arg);
    if (!stop) {
      if (!stops().length) say('no test is stopped.');
      return;
    }
    await control({ ref: stop.ref, worker: stop.worker, action, ...(place ? { place } : {}) });
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
              const target = [{ ref: s.ref, worker: s.worker } satisfies RunTarget];
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
      await answerStop('run-to', arg, { uri: editor.document.uri.toString(), line: editor.selection.active.line });
    }),
    vscode.commands.registerCommand(RUN_COMMANDS.showPage, async (arg?: unknown) => {
      const stop = await chooseStop(arg);
      if (stop) await openPage(stop);
      else say('no test is stopped.');
    }),
    {
      dispose: () => {
        items.forEach((i) => i.dispose());
        panel?.dispose();
      },
    },
  ];
  drawControls();

  return {
    heard(session) {
      const fresh = !session.ended && !sessions.has(session.ref);
      sessions = withSession(
        sessions,
        spelledSession(session, (uri) => vscode.Uri.parse(uri).toString()),
      );
      if (session.ended) sent.delete(session.ref);
      changed();
      // Breakpoints changed between the run's start and its first worker.
      if (fresh) sendBreakpoints();
    },
    started(ref, breakpoints) {
      remember(sent, ref, JSON.stringify(breakpoints));
    },
    clear() {
      sessions = new Map();
      changed();
    },
    sessions: () => [...sessions.values()],
    executionPoints: (uri) => drawn.get(uri) ?? [],
    pausedPage: () => (panel ? page : null),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
