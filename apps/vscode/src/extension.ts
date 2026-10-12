/**
 * The Piwi extension for VS Code: a thin client of the editor service. The
 * service (bundled beside this file) computes the diagnostics, quick fixes,
 * hover and summary lines; this file starts it, draws the summary lines as
 * CodeLens and the latest run in the status bar, runs the commands those
 * lines name, lists the failures in the Piwi view (`failures-view.ts`), keeps
 * the API key in the secret store, hands Piwi's MCP server to the editor's
 * agent, inserts what Piwi Picker sends, and records tests (`recording.ts`).
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import {
  AGENT_CONTEXT_REQUEST,
  APPLY_PICK_REQUEST,
  COMMAND_ENDED_NOTIFICATION,
  COMMAND_STARTED_NOTIFICATION,
  DESKTOP_JOB_NOTIFICATION,
  DESKTOP_JOB_REQUEST,
  FAILURES_NOTIFICATION,
  NOTICE_NOTIFICATION,
  PAGE_CANDIDATES_REQUEST,
  RUN_ENDED_NOTIFICATION,
  SHARE_DESKTOP_JOB_REQUEST,
  type AgentContextParams,
  type AgentContextResult,
  type ApplyPickParams,
  type ApplyPickResult,
  type CommandEndedParams,
  type CommandStartedParams,
  type DesktopJobParams,
  type DesktopJobResult,
  type DesktopJobUpdate,
  type FailuresResult,
  type Notice,
  type PageCandidatesParams,
  type PageCandidatesResult,
  type RenderStepsParams,
  type RunEnded,
  type ShareDesktopJobResult,
} from '@piwitests/editor/protocol';
import {
  FILE_SUMMARY_REQUEST,
  MCP_REQUEST,
  REFRESH_REQUEST,
  REFRESH_RUN_REQUEST,
  RENDER_STEPS_REQUEST,
  RUN_ARGS_REQUEST,
  RUN_STATUS_NOTIFICATION,
  RUN_STATUS_REQUEST,
  DESKTOP_REQUEST,
  RUN_SELECTION_REQUEST,
  SELECTIONS_REQUEST,
  SET_BASELINE_NOTIFICATION,
  SET_CREDENTIALS_NOTIFICATION,
  STATUS_NOTIFICATION,
  STATUS_REQUEST,
  TESTS_FOR_FILE_REQUEST,
  SCREENSHOT_REQUEST,
  TRACE_REQUEST,
  type DesktopResult,
  type BaselineChoice,
  type EditorCredentials,
  type SetBaselineParams,
  type FileSummary,
  type McpServersResult,
  type RenderStepsResult,
  type RunCommand,
  type RunCommandArgs,
  type RunStatusResult,
  type RunTestsArgs,
  type SelectionsResult,
  type StatusResult,
  type SummaryLine,
  type TestsForFile,
  type ScreenshotParams,
  type ScreenshotResult,
  type TraceParams,
  type TraceResult,
} from '@piwitests/editor/protocol';
import type { EditorSendPayload } from '@piwitests/core/editor-send';
import { formatPairing } from '@piwitests/core/editor-send';
import {
  API_KEY_SECRET_PREFIX,
  InstanceError,
  apiKeySecret,
  listProjects,
  needsKey,
  normalizeServerUrl,
  startSignIn,
  waitForSignIn,
  type ProjectItem,
} from './connect';
import {
  DOCUMENT_PATTERN,
  connectChoices,
  desktopJobNotice,
  testDecorations,
  disconnectQuestion,
  filesRedraw,
  importInsertion,
  indentBlock,
  mcpConfiguration,
  ownLiveRun,
  refreshingText,
  rerunFailingArgs,
  runVerdict,
  VERDICT_ACTIONS,
  type RunNotifications,
  sourceLabel,
  STATUS_TOOLTIP_COMMANDS,
  pickNotice,
  statusBarView,
  baselinePicks,
  runIdOf,
  withBaseline,
  type FailureNode,
} from './glue';
import { isUnder, runBreakpoints, terminalEnvKey } from './breakpoints';
import { FailuresView } from './failures-view';
import { registerRecording, type Recording } from './recording';
import { startSendListener, type SendListener, type SendResult } from './send-listener';

/** How often the status bar item's tooltip is written again, for the time since the latest run was read. */
const STATUS_TICK_MS = 30_000;
/** How often, at most, the gutter is drawn again for the tests the run in progress begins and ends. */
const LIVE_TESTS_DRAW_MS = 1_000;
/** A terminal whose shell has not activated shell integration this long after it opened never will. */
const SHELL_INTEGRATION_WAIT_MS = 10_000;
/** The one key slot shared by every instance; `forgetSharedKey` deletes it once. */
const SHARED_SECRET_KEY = 'piwi.apiKey';
const SHARED_KEY_FORGOTTEN = 'piwi.sharedKeyForgotten';
const MCP_OFFERED = 'piwi.mcpOffered';
const SEND_TOKEN = 'piwi.sendToken';
const SEND_PORT = 'piwi.sendPort';
/**
 * The desktop app chosen with Connect, its project, and whether it was offered:
 * workspace state, on this machine only, never in a file the team shares.
 */
const DESKTOP_CHOSEN = 'piwi.desktop';
const DESKTOP_PROJECT = 'piwi.desktopProject';
const DESKTOP_OFFERED = 'piwi.desktopOffered';
/** The baseline chosen with Compare with… for each context, by its root: workspace state, on this machine only. */
const BASELINES = 'piwi.baseline';

/** The MCP provider API (VS Code 1.101 and later), read at runtime so older editors still load the extension. */
interface McpApi {
  registerMcpServerDefinitionProvider(
    id: string,
    provider: {
      onDidChangeMcpServerDefinitions: vscode.Event<void>;
      provideMcpServerDefinitions(): Promise<unknown[]>;
    },
  ): vscode.Disposable;
}
type McpHttpServerDefinitionClass = new (label: string, uri: vscode.Uri, headers?: Record<string, string>) => unknown;

/** A command's start and end in a terminal, from shell integration (VS Code 1.93 and later), read at runtime. */
interface ShellExecutionEvent {
  terminal: vscode.Terminal;
  execution?: { commandLine?: { value?: string } };
  /** Set on the end; undefined when the shell does not report it. */
  exitCode?: number;
}
interface ShellIntegrationApi {
  onDidStartTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
  onDidEndTerminalShellExecution?: vscode.Event<ShellExecutionEvent>;
}

let client: LanguageClient | null = null;
let sendListener: SendListener | null = null;
let recording: Recording | null = null;

/** The extension's API, which its integration suite reads: answers of the editor service, and the failures view. */
export interface PiwiApi {
  /** `piwi/pageCandidates`: the page expressions the steps written at a position could run on. */
  pageCandidates(params: PageCandidatesParams): Promise<PageCandidatesResult>;
  /** The failures view's nodes under `node`, or its roots, once the failures are read again. */
  failureChildren(node?: FailureNode): Promise<FailureNode[]>;
  /** The command of the latest test run started from the editor, as sent to its terminal; null before the first. */
  lastRun(): RunCommand | null;
}

/** A failures view node, or what a command names it by. */
function failureOf(target: unknown): FailureNode['failure'] | null {
  return (target as FailureNode | undefined)?.failure ?? null;
}

/**
 * The connection saved in the editor: the workspace's instance and project, that instance's key,
 * and whether this machine reads the desktop app first.
 */
async function credentials(context: vscode.ExtensionContext): Promise<EditorCredentials> {
  const settings = vscode.workspace.getConfiguration('piwi');
  const serverUrl = normalizeServerUrl(settings.get<string>('serverUrl')) ?? null;
  return {
    serverUrl,
    project: settings.get<string>('project') || null,
    apiKey: serverUrl ? ((await context.secrets.get(apiKeySecret(serverUrl))) ?? null) : null,
    desktop: context.workspaceState.get<boolean>(DESKTOP_CHOSEN) ?? false,
    desktopProject: context.workspaceState.get<string>(DESKTOP_PROJECT) ?? null,
    baselines: context.workspaceState.get<Record<string, BaselineChoice>>(BASELINES) ?? {},
  };
}

/** Hand the saved connection to the service and have it read everything again. */
async function applyCredentials(context: vscode.ExtensionContext, lc: LanguageClient): Promise<void> {
  await lc.sendNotification(SET_CREDENTIALS_NOTIFICATION, await credentials(context));
  await lc.sendRequest(REFRESH_REQUEST).catch(() => null);
}

/**
 * Deletes the key shared by every instance, once: a workspace naming another
 * instance would send it there. Connect again to save a key per instance.
 */
async function forgetSharedKey(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get(SHARED_KEY_FORGOTTEN)) return;
  await context.secrets.delete(SHARED_SECRET_KEY);
  await context.globalState.update(SHARED_KEY_FORGOTTEN, true);
}

export async function activate(context: vscode.ExtensionContext): Promise<PiwiApi> {
  await forgetSharedKey(context);
  const serverModule = vscode.Uri.joinPath(context.extensionUri, 'dist', 'piwi-language-server.cjs').fsPath;
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', pattern: DOCUMENT_PATTERN }],
    initializationOptions: { credentials: await credentials(context) },
  };
  const lc = new LanguageClient('piwi', 'Piwi', serverOptions, clientOptions);
  client = lc;

  // Each test's latest result on the test: a gutter icon with a hover, and a background while it fails, stronger on
  // the line it failed at (the service's hover there says why).
  const gutterIcons = new Map(
    (['failed', 'flaky', 'passed', 'skipped', 'running'] as const).map((status) => [
      status,
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `test-${status}.svg`),
        gutterIconSize: 'contain',
      }),
    ]),
  );
  const failingBackground = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('piwi.failingTestBackground'),
    overviewRulerColor: new vscode.ThemeColor('piwi.failingTestBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const failingLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('piwi.failingLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('piwi.failingLineBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  context.subscriptions.push(failingBackground, failingLine, ...gutterIcons.values());
  const decorateTests = (document: vscode.TextDocument, lines: SummaryLine[]) => {
    const tests = testDecorations(lines);
    for (const editor of vscode.window.visibleTextEditors.filter((e) => e.document === document)) {
      for (const [status, type] of gutterIcons) {
        editor.setDecorations(
          type,
          tests
            .filter((t) => t.status === status && t.line < document.lineCount)
            .map((t) => {
              const hover = new vscode.MarkdownString(
                t.dashboardUrl
                  ? `${t.hover}\n\n[Open in dashboard](command:piwi.openInDashboard?${encodeURIComponent(JSON.stringify([t.dashboardUrl]))})`
                  : t.hover,
              );
              hover.isTrusted = { enabledCommands: ['piwi.openInDashboard'] };
              return { range: document.lineAt(t.line).range, hoverMessage: hover };
            }),
        );
      }
      editor.setDecorations(
        failingBackground,
        tests
          .filter((t) => t.failingUntil !== null && t.line < document.lineCount)
          .map((t) => new vscode.Range(t.line, 0, Math.min(t.failingUntil!, document.lineCount - 1), 0)),
      );
      editor.setDecorations(
        failingLine,
        tests
          .filter((t) => t.failingLine !== null && t.failingLine < document.lineCount)
          .map((t) => document.lineAt(t.failingLine!).range),
      );
    }
  };

  const lensesChanged = new vscode.EventEmitter<void>();
  const mcpChanged = new vscode.EventEmitter<void>();
  const statusItem = vscode.window.createStatusBarItem('piwi.status', vscode.StatusBarAlignment.Left, 50);
  statusItem.name = 'Piwi';
  let statusUrl: string | null = null;
  let lastServers = '';
  context.subscriptions.push(lensesChanged, mcpChanged, statusItem);

  /** The service's last answers the status bar item renders, and whether a click is reading the run again. */
  let status: StatusResult | null = null;
  let runs: RunStatusResult | null = null;
  /** The runs the CodeLens and the gutter were last drawn with, and when the run in progress's tests were. */
  let runsShown: RunStatusResult | null = null;
  let testsDrawnAt = 0;
  let testsDraw: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  context.subscriptions.push({ dispose: () => testsDraw && clearTimeout(testsDraw) });

  /**
   * Draw the CodeLens and the gutter again as far as the runs they show changed (`filesRedraw`): at once for another
   * run, at most once a second for the tests the run in progress begins and ends.
   */
  const drawFiles = () => {
    const change = filesRedraw(runsShown, runs);
    if (change === 'none') return;
    if (change === 'tests') {
      const wait = testsDrawnAt + LIVE_TESTS_DRAW_MS - Date.now();
      if (wait > 0) {
        testsDraw ??= setTimeout(() => {
          testsDraw = null;
          drawFiles();
        }, wait);
        return;
      }
      testsDrawnAt = Date.now();
    }
    runsShown = runs;
    lensesChanged.fire();
  };
  const render = () => {
    const view = statusBarView(status, runs, !!context.workspaceState.get<boolean>(DESKTOP_CHOSEN));
    statusItem.text = refreshing ? refreshingText(view.text) : view.text;
    const tooltip = new vscode.MarkdownString(view.tooltip);
    tooltip.isTrusted = { enabledCommands: STATUS_TOOLTIP_COMMANDS };
    statusItem.tooltip = tooltip;
    statusUrl = view.url;
    statusItem.command =
      view.action === 'refresh' ? 'piwi.refreshRun' : view.action === 'connect' ? 'piwi.connect' : undefined;
    statusItem.backgroundColor = view.error ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    statusItem.show();
  };

  /**
   * Render the runs a `piwi/runStatusChanged` brought; without them, read the connection, the runs and the failures
   * again. The CodeLens and the gutter are drawn again after a full read, and as far as the runs as the files show them
   * changed (`drawFiles`): a run in progress moves the status bar item alone, and the failures view's first node while
   * it is the editor's own. The failures come with `piwi/failuresChanged`.
   */
  const updateStatus = async (next?: RunStatusResult) => {
    const full = !next || !status;
    if (full) status = await lc.sendRequest<StatusResult>(STATUS_REQUEST).catch(() => null);
    const before = runs;
    runs = next ?? (await lc.sendRequest<RunStatusResult>(RUN_STATUS_REQUEST).catch(() => null));
    render();
    if (full) {
      failuresView.refresh();
      runsShown = runs;
      lensesChanged.fire();
    } else {
      if (ownLiveRun(runs) !== ownLiveRun(before)) failuresView.render();
      drawFiles();
    }
    if (!full) return;
    void vscode.commands.executeCommand('setContext', 'piwi.active', !!status?.contexts.some((c) => c.connected));
    if (status) void offerDesktop(context, lc, status);
    const servers = await lc.sendRequest<McpServersResult>(MCP_REQUEST).catch(() => null);
    const serialized = JSON.stringify(servers?.servers ?? []);
    if (serialized !== lastServers) {
      lastServers = serialized;
      mcpChanged.fire();
      if (servers?.servers.length) void offerMcp(context, servers);
    }
  };

  const failuresView = new FailuresView(
    context,
    lc,
    () => status,
    () => runs,
  );
  context.subscriptions.push(failuresView);

  // The terminal of each directory and environment commands run in, reused while it is open. A test run carries the
  // ref of its own run in its environment. Where shell integration reports the commands of the directory's run
  // terminal, a test run opens a terminal of its own, which replaces the previous run's once that run's command ended.
  // Without shell integration, or in a shell that never activates it, the test runs of a directory share one terminal,
  // whose environment keeps the first run's ref: the service is told so (`piwi/commandStarted`), and recognizes the
  // later runs as the editor's own by that ref, through the instance's event stream. A run terminal whose command has
  // not ended is never reused while its shell may still activate integration and report that end.
  const terminals = new Map<string, vscode.Terminal>();
  const runTerminals = new Map<string, vscode.Terminal>();
  /** The ref of each run terminal's environment: the ref of the first command sent to it. */
  const terminalRefs = new Map<vscode.Terminal, string>();
  /** The rest of each run terminal's environment (`terminalEnvKey`): a run with other breakpoints needs another. */
  const terminalEnvs = new Map<vscode.Terminal, string>();
  /** The command of a test run sent to a terminal, until shell integration sees it end: `piwi/commandEnded` names it. */
  const running = new Map<vscode.Terminal, { ref: string; command: string }>();
  /** The terminals whose last command ended. */
  const idle = new WeakSet<vscode.Terminal>();
  /** When each run terminal opened. */
  const openedAt = new WeakMap<vscode.Terminal, number>();
  const shell = vscode.window as unknown as ShellIntegrationApi;
  const shellIntegration = !!shell.onDidStartTerminalShellExecution && !!shell.onDidEndTerminalShellExecution;
  /** Whether a terminal's shell activated shell integration (VS Code 1.93 and later, read at runtime). */
  const integrated = (t: vscode.Terminal) =>
    (t as unknown as { shellIntegration?: unknown }).shellIntegration !== undefined;
  const runInTerminal = (cwd: string, command: string, env?: Record<string, string>, ref?: string) => {
    let terminal: vscode.Terminal | undefined;
    if (ref) {
      const previous = runTerminals.get(cwd);
      const envKey = terminalEnvKey(env);
      // A shell that has not activated integration this long after its terminal opened never reports the end of the
      // command sent to it.
      if (
        previous &&
        running.has(previous) &&
        !integrated(previous) &&
        Date.now() - (openedAt.get(previous) ?? 0) >= SHELL_INTEGRATION_WAIT_MS
      ) {
        running.delete(previous);
      }
      if (
        previous &&
        !previous.exitStatus &&
        !running.has(previous) &&
        (!shellIntegration || !integrated(previous)) &&
        terminalEnvs.get(previous) === envKey
      ) {
        terminal = previous;
      } else {
        if (previous && idle.has(previous)) previous.dispose();
        terminal = vscode.window.createTerminal({ name: 'Piwi', cwd, env });
        runTerminals.set(cwd, terminal);
        openedAt.set(terminal, Date.now());
        terminalRefs.set(terminal, ref);
        terminalEnvs.set(terminal, envKey);
        if (shellIntegration) running.set(terminal, { ref, command });
      }
    } else {
      const key = `${cwd}\0${JSON.stringify(env ?? {})}`;
      terminal = terminals.get(key);
      if (!terminal || terminal.exitStatus) {
        terminal = vscode.window.createTerminal({ name: 'Piwi', cwd, env });
        terminals.set(key, terminal);
      }
    }
    terminal.show();
    terminal.sendText(command);
    if (ref) {
      const terminalRef = terminalRefs.get(terminal);
      void lc.sendNotification(COMMAND_STARTED_NOTIFICATION, {
        ref,
        ...(terminalRef && terminalRef !== ref ? { terminalRef } : {}),
      } satisfies CommandStartedParams);
    }
  };
  if (shell.onDidStartTerminalShellExecution && shell.onDidEndTerminalShellExecution) {
    context.subscriptions.push(
      shell.onDidStartTerminalShellExecution((e) => idle.delete(e.terminal)),
      shell.onDidEndTerminalShellExecution((e) => {
        idle.add(e.terminal);
        const sent = running.get(e.terminal);
        const line = e.execution?.commandLine?.value;
        if (!sent || (line && !line.includes(sent.command))) return;
        running.delete(e.terminal);
        void lc.sendNotification(COMMAND_ENDED_NOTIFICATION, {
          ref: sent.ref,
          exitCode: e.exitCode ?? null,
        } satisfies CommandEndedParams);
      }),
    );
  }
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      for (const [key, terminal] of terminals) if (terminal === t) terminals.delete(key);
      for (const [cwd, terminal] of runTerminals) if (terminal === t) runTerminals.delete(cwd);
      terminalRefs.delete(t);
      terminalEnvs.delete(t);
      running.delete(t);
    }),
  );

  // Send to editor: the token lives in the secret store, the port in global state, so a pairing survives restarts.
  let sendToken = (await context.secrets.get(SEND_TOKEN)) ?? '';
  const listen = async (port: number) => {
    sendListener = await startSendListener({
      port,
      token: () => sendToken,
      onPayload: (payload) => insertFromPicker(lc, payload),
    });
    return sendListener;
  };
  const pairedPort = context.globalState.get<number>(SEND_PORT);
  // Another window may hold the port: that window keeps the pairing.
  if (pairedPort && sendToken) await listen(pairedPort).catch(() => null);
  /** The pairing address, the listener started and the token minted first when they are not. */
  const pairing = async (): Promise<string> => {
    if (!sendToken) {
      sendToken = randomBytes(24).toString('base64url');
      await context.secrets.store(SEND_TOKEN, sendToken);
    }
    const listener = sendListener ?? (await listen(pairedPort ?? 0).catch(() => listen(0)));
    await context.globalState.update(SEND_PORT, listener.port);
    return formatPairing({ url: listener.url, token: sendToken });
  };

  /** The enabled breakpoints a run pauses at, as `piwi.breakpoints` allows; none outside the Playwright configs. */
  const breakpointsForRun = () =>
    vscode.workspace.getConfiguration('piwi').get<boolean>('breakpoints', true)
      ? runBreakpoints(vscode.debug.breakpoints, status?.contexts.map((c) => c.root) ?? [])
      : [];

  /** The notices of `RunCommand.notice` already shown: each is shown once. */
  const noticesShown = new Set<string>();
  let lastRun: RunCommand | null = null;

  /**
   * Run a test command: its notice shown once, and, with breakpoints (`PIWI_PAUSE_AT`), the Send to editor pairing
   * the picker posts a pick to (`PIWI_EDITOR_SEND`).
   */
  const startRun = async (command: RunCommand) => {
    if (command.notice && !noticesShown.has(command.notice)) {
      noticesShown.add(command.notice);
      void vscode.window.showWarningMessage(`Piwi: ${command.notice}`);
    }
    let env = command.env;
    if (env?.PIWI_PAUSE_AT) {
      const address = await pairing().catch(() => null);
      if (address) env = { ...env, PIWI_EDITOR_SEND: address };
    }
    lastRun = { ...command, env };
    runInTerminal(command.cwd, command.command, env, command.ref);
  };

  const runTests = async (args: RunTestsArgs) => {
    const breakpoints = breakpointsForRun();
    const command = await lc.sendRequest<RunCommand | null>(
      RUN_ARGS_REQUEST,
      breakpoints.length ? { ...args, breakpoints } : args,
    );
    if (!command) {
      void vscode.window.showWarningMessage('Piwi: no command to run these tests (not connected?).');
      return;
    }
    await startRun(command);
  };

  const activeUri = () => vscode.window.activeTextEditor?.document.uri.toString() ?? null;

  /** The execution a trace or a screenshot command names: its arguments, or a failure of the failures view. */
  const evidenceParams = (target: TraceParams | FailureNode): TraceParams => {
    const failure = failureOf(target);
    return failure ? { uri: failure.uri, executionId: failure.executionId } : (target as TraceParams);
  };

  /** Pass a failure of the failures view to the desktop app. */
  const desktopJobOf = async (target: FailureNode, kind: 'reproduce' | 'bisect') => {
    const failure = failureOf(target);
    const inside = (root: string) => !!failure && failure.uri.startsWith(`${vscode.Uri.file(root).toString()}/`);
    const root =
      status?.contexts.filter((c) => inside(c.root)).sort((a, b) => b.root.length - a.root.length)[0] ??
      status?.contexts.find((c) => c.connected);
    if (!failure || !root) return;
    await vscode.commands.executeCommand('piwi.desktopJob', {
      root: root.root,
      executionId: failure.executionId,
      kind,
    } satisfies DesktopJobParams);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('piwi.connect', async () => {
      if (await connect(context, lc)) await updateStatus();
    }),
    vscode.commands.registerCommand('piwi.disconnect', async () => {
      if (await disconnect(context, lc)) await updateStatus();
    }),
    vscode.commands.registerCommand('piwi.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:piwitests.piwi'),
    ),
    vscode.commands.registerCommand('piwi.refresh', async () => {
      await lc.sendRequest(REFRESH_REQUEST);
      await updateStatus();
    }),
    // The status bar item's click: the latest run and its failures alone, not the indexes Refresh reads.
    vscode.commands.registerCommand('piwi.refreshRun', async () => {
      if (refreshing) return;
      refreshing = true;
      render();
      const answer = await lc.sendRequest<RunStatusResult>(REFRESH_RUN_REQUEST).catch(() => null);
      refreshing = false;
      await updateStatus(answer ?? undefined);
    }),
    vscode.commands.registerCommand('piwi.runTests', (args: RunTestsArgs) => runTests(args)),
    // From the failures view, a failure; from elsewhere, the tests to run.
    vscode.commands.registerCommand('piwi.runTest', async (target: FailureNode | RunTestsArgs) => {
      const failure = failureOf(target);
      if (failure?.testCaseId !== undefined) await runTests({ uri: failure.uri, testIds: [failure.testCaseId] });
      else if ((target as RunTestsArgs)?.testIds) await runTests(target as RunTestsArgs);
    }),
    vscode.commands.registerCommand('piwi.rerunFailing', async () => {
      const args = rerunFailingArgs(await failuresView.read());
      if (!args) {
        void vscode.window.showInformationMessage('Piwi: no failing test to re-run.');
        return;
      }
      await runTests(args);
    }),
    vscode.commands.registerCommand('piwi.groupFailuresBy', () => failuresView.pickGrouping()),
    vscode.commands.registerCommand('piwi.compareWith', async () => {
      const contexts = runs?.contexts ?? [];
      const file = vscode.window.activeTextEditor?.document.uri.fsPath;
      // The context of the active file: the deepest config folder holding it.
      const inFile = file
        ? contexts.filter((c) => isUnder(c.root, file)).sort((a, b) => b.root.length - a.root.length)
        : [];
      const target =
        inFile[0] ??
        (contexts.length > 1
          ? await vscode.window
              .showQuickPick(
                contexts.map((c) => ({ label: c.root, c })),
                { placeHolder: 'Compare which Playwright config?' },
              )
              .then((p) => p?.c)
          : contexts[0]);
      if (!target) {
        if (!contexts.length) void vscode.window.showInformationMessage('Piwi: connect to an instance first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(baselinePicks(target), {
        placeHolder: `Compare with… (now: ${target.baseline?.label || 'the latest run'})`,
        matchOnDetail: true,
      });
      if (!picked) return;
      let choice: BaselineChoice;
      if (picked.choice === 'run-by-id') {
        const typed = await vscode.window.showInputBox({
          prompt: 'The id of the run to compare with (its page in the dashboard shows it)',
          placeHolder: '118',
          validateInput: (text) => (runIdOf(text) ? null : 'A run id: a positive number, such as 118'),
        });
        const runId = typed === undefined ? null : runIdOf(typed);
        if (!runId) return;
        choice = { kind: 'run', runId };
      } else {
        choice = picked.choice;
      }
      const kept = context.workspaceState.get<Record<string, BaselineChoice>>(BASELINES);
      await context.workspaceState.update(BASELINES, withBaseline(kept, target.root, choice));
      await lc.sendNotification(SET_BASELINE_NOTIFICATION, { root: target.root, choice } satisfies SetBaselineParams);
    }),
    vscode.commands.registerCommand('piwi.toggleFollowEditor', () => failuresView.toggleFollow()),
    vscode.commands.registerCommand('piwi.stopFollowingEditor', () => failuresView.toggleFollow()),
    vscode.commands.registerCommand('piwi.copyAgentContext', async (target: FailureNode) => {
      const failure = failureOf(target);
      if (!failure) return;
      const answer = await lc
        .sendRequest<AgentContextResult | null>(AGENT_CONTEXT_REQUEST, {
          uri: failure.uri,
          executionId: failure.executionId,
        } satisfies AgentContextParams)
        .catch(() => null);
      if (!answer) {
        void vscode.window.showWarningMessage('Piwi: this failure is no longer in the latest run.');
        return;
      }
      await vscode.commands.executeCommand('piwi.copyText', answer.text);
    }),
    vscode.commands.registerCommand('piwi.reproduceInDesktop', (target: FailureNode) =>
      desktopJobOf(target, 'reproduce'),
    ),
    vscode.commands.registerCommand('piwi.bisectInDesktop', (target: FailureNode) => desktopJobOf(target, 'bisect')),
    vscode.commands.registerCommand('piwi.runTestsForFile', async (target?: vscode.Uri) => {
      const uri = target?.toString() ?? activeUri();
      if (!uri) return;
      const found = await lc.sendRequest<TestsForFile>(TESTS_FOR_FILE_REQUEST, { uri });
      if (!found.tests.length) {
        void vscode.window.showInformationMessage('Piwi: no test reaches this file yet.');
        return;
      }
      await runTests({ uri, testIds: found.tests.map((t) => t.id) });
    }),
    vscode.commands.registerCommand('piwi.openInDashboard', async (target?: string | FailureNode) => {
      const url = typeof target === 'string' ? target : target?.url;
      if (typeof url === 'string' && url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }
      const uri = activeUri();
      const found = uri ? await lc.sendRequest<TestsForFile>(TESTS_FOR_FILE_REQUEST, { uri }) : null;
      if (!found?.tests.length) {
        if (statusUrl) await vscode.env.openExternal(vscode.Uri.parse(statusUrl));
        return;
      }
      const picked =
        found.tests.length === 1
          ? found.tests[0]
          : await vscode.window
              .showQuickPick(
                found.tests.map((t) => ({ label: t.title, description: t.file, detail: t.status ?? undefined, t })),
                { placeHolder: 'Open which test in the dashboard?' },
              )
              .then((p) => p?.t);
      if (picked) await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }),
    vscode.commands.registerCommand('piwi.runCommand', (args: RunCommandArgs) =>
      runInTerminal(args.cwd, args.command, args.env),
    ),
    vscode.commands.registerCommand('piwi.copyText', async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Piwi: copied. Paste it to your agent.');
    }),
    vscode.commands.registerCommand('piwi.runSelection', async () => {
      const uri = activeUri() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
      const { items } = await lc.sendRequest<SelectionsResult>(SELECTIONS_REQUEST, { uri });
      if (!items.length) {
        void vscode.window.showInformationMessage('Piwi: this project has no selection yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        items.map((i) => ({
          label: i.name,
          description: `${i.count} ${i.count === 1 ? 'test' : 'tests'}`,
          detail: i.includesFile ? 'Includes a test of this file' : undefined,
          key: i.key,
        })),
        { placeHolder: 'Run which selection?' },
      );
      if (!picked) return;
      const breakpoints = breakpointsForRun();
      const command = await lc.sendRequest<RunCommand | null>(RUN_SELECTION_REQUEST, {
        uri,
        key: picked.key,
        ...(breakpoints.length ? { breakpoints } : {}),
      });
      if (command) await startRun(command);
    }),
    vscode.commands.registerCommand('piwi.openRun', async () => {
      if (statusUrl) await vscode.env.openExternal(vscode.Uri.parse(statusUrl));
    }),
    vscode.commands.registerCommand('piwi.openTrace', async (target: TraceParams | FailureNode) => {
      const params = evidenceParams(target);
      const trace = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Piwi: downloading the trace…' },
        () => lc.sendRequest<TraceResult | null>(TRACE_REQUEST, params),
      );
      if (!trace) {
        void vscode.window.showWarningMessage('Piwi: this failure has no trace to open.');
        return;
      }
      runInTerminal(trace.cwd, trace.command);
    }),
    vscode.commands.registerCommand('piwi.openScreenshot', async (target: ScreenshotParams | FailureNode) => {
      const params = evidenceParams(target);
      const shot = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Piwi: downloading the screenshot…' },
        () => lc.sendRequest<ScreenshotResult | null>(SCREENSHOT_REQUEST, params),
      );
      if (!shot) {
        void vscode.window.showWarningMessage('Piwi: this failure has no screenshot to open.');
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(shot.path), {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),
    vscode.commands.registerCommand('piwi.copyMcpConfiguration', async () => {
      const servers = await lc.sendRequest<McpServersResult>(MCP_REQUEST);
      if (!servers.servers.length) {
        void vscode.window.showWarningMessage('Piwi: connect to an instance first.');
        return;
      }
      await vscode.env.clipboard.writeText(mcpConfiguration(servers.servers));
      void vscode.window.showInformationMessage(
        'Piwi: the MCP configuration is on the clipboard. It holds your API key: paste it in your user settings, not in the repository.',
      );
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: DOCUMENT_PATTERN },
      {
        onDidChangeCodeLenses: lensesChanged.event,
        async provideCodeLenses(document) {
          const summary = await lc
            .sendRequest<FileSummary>(FILE_SUMMARY_REQUEST, { uri: document.uri.toString() })
            .catch(() => null);
          decorateTests(document, summary?.lines ?? []);
          if (!summary) return [];
          // A test's line is drawn in the gutter and its hover, not as a lens above it.
          return [...(summary.file ? [summary.file] : []), ...summary.lines.filter((l) => !l.status)].map((line) => {
            const range = new vscode.Range(line.line, 0, line.line, 0);
            return new vscode.CodeLens(range, {
              title: line.title,
              command: line.command?.command ?? '',
              arguments: line.command?.arguments ?? [],
            });
          });
        },
      },
    ),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('piwi'))
        await lc.sendNotification(SET_CREDENTIALS_NOTIFICATION, await credentials(context));
    }),
    context.secrets.onDidChange(async (e) => {
      if (e.key.startsWith(API_KEY_SECRET_PREFIX))
        await lc.sendNotification(SET_CREDENTIALS_NOTIFICATION, await credentials(context));
    }),
  );

  const lm = (vscode as unknown as { lm?: Partial<McpApi> }).lm;
  const McpHttpServerDefinition = (vscode as unknown as { McpHttpServerDefinition?: McpHttpServerDefinitionClass })
    .McpHttpServerDefinition;
  if (lm?.registerMcpServerDefinitionProvider && McpHttpServerDefinition) {
    context.subscriptions.push(
      lm.registerMcpServerDefinitionProvider('piwi.mcp', {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        async provideMcpServerDefinitions() {
          const servers = await lc.sendRequest<McpServersResult>(MCP_REQUEST).catch(() => null);
          return (servers?.servers ?? []).map(
            (s) => new McpHttpServerDefinition(s.label, vscode.Uri.parse(s.url), s.headers),
          );
        },
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('piwi.pairPicker', async () => {
      await vscode.env.clipboard.writeText(await pairing());
      void vscode.window.showInformationMessage(
        "Piwi: the pairing address is on the clipboard. Paste it in Piwi Picker's options, under Send to editor.",
      );
    }),
    { dispose: () => void sendListener?.close() },
  );

  context.subscriptions.push(
    lc.onNotification(RUN_STATUS_NOTIFICATION, (next: RunStatusResult) => void updateStatus(next)),
    lc.onNotification(STATUS_NOTIFICATION, () => void updateStatus()),
    // A failure moved with an edit, or its line changed since the run: the lenses, the decorations and the view again.
    lc.onNotification(FAILURES_NOTIFICATION, (failures: FailuresResult) => {
      lensesChanged.fire();
      failuresView.show(failures);
    }),
    // A run started here ended and was read: what it changed, as `piwi.runNotifications` allows.
    lc.onNotification(RUN_ENDED_NOTIFICATION, async (ended: RunEnded) => {
      const setting = vscode.workspace.getConfiguration('piwi').get<RunNotifications>('runNotifications');
      const verdict = runVerdict(ended, setting);
      if (!verdict) return;
      const picked = await (verdict.severity === 'warning'
        ? vscode.window.showWarningMessage(verdict.text, ...verdict.actions)
        : vscode.window.showInformationMessage(verdict.text, ...verdict.actions));
      if (picked === VERDICT_ACTIONS.failures) await vscode.commands.executeCommand('piwi.failures.focus');
      else if (picked === VERDICT_ACTIONS.dashboard) await vscode.env.openExternal(vscode.Uri.parse(ended.url));
      else if (picked === VERDICT_ACTIONS.rerun) await vscode.commands.executeCommand('piwi.rerunFailing');
    }),
    lc.onNotification(NOTICE_NOTIFICATION, (notice: Notice) => {
      const text = `Piwi: ${notice.message}`;
      void (notice.severity === 'warning'
        ? vscode.window.showWarningMessage(text)
        : vscode.window.showInformationMessage(text));
    }),
  );
  context.subscriptions.push(...registerDesktopJobs(lc));
  recording = registerRecording(context, lc);
  context.subscriptions.push(recording);
  await lc.start();
  await updateStatus();
  const tick = setInterval(render, STATUS_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });
  return {
    pageCandidates: (params) => lc.sendRequest<PageCandidatesResult>(PAGE_CANDIDATES_REQUEST, params),
    failureChildren: async (node) => {
      if (!node) await failuresView.read();
      return failuresView.getChildren(node);
    },
    lastRun: () => lastRun,
  };
}

/**
 * Jobs passed to the desktop app: `piwi.desktopJob` (a quick fix on a failure from the team instance, or a flaky
 * test's lens) sends one, each update of it shows as a notification, and its share button records the verdict on the
 * instance.
 */
function registerDesktopJobs(lc: LanguageClient): vscode.Disposable[] {
  const show = (severity: 'information' | 'warning', text: string, ...actions: string[]) =>
    severity === 'warning'
      ? vscode.window.showWarningMessage(text, ...actions)
      : vscode.window.showInformationMessage(text, ...actions);
  return [
    vscode.commands.registerCommand('piwi.desktopJob', async (params: DesktopJobParams) => {
      const result = await lc.sendRequest<DesktopJobResult>(DESKTOP_JOB_REQUEST, params);
      void show(result.ok ? 'information' : 'warning', `Piwi: ${result.message}`);
    }),
    lc.onNotification(DESKTOP_JOB_NOTIFICATION, async (update: DesktopJobUpdate) => {
      const notice = desktopJobNotice(update);
      const picked = await show(notice.severity, notice.text, ...notice.actions);
      if (!picked) return;
      const shared = await lc.sendRequest<ShareDesktopJobResult>(SHARE_DESKTOP_JOB_REQUEST, { jobId: update.jobId });
      const open = 'Open in the dashboard';
      const next = await show(
        shared.ok ? 'information' : 'warning',
        `Piwi: ${shared.message}`,
        ...(shared.url ? [open] : []),
      );
      if (next === open && shared.url) await vscode.env.openExternal(vscode.Uri.parse(shared.url));
    }),
  ];
}

/**
 * Insert what Piwi Picker sent at the cursor of the active editor, or in a new editor when none is open. A recorded
 * flow is rendered for the cursor's place, and the import lines it needs that the file lacks go after the file's
 * imports, in the same edit.
 */
async function insertFromPicker(lc: LanguageClient, payload: EditorSendPayload): Promise<SendResult> {
  let notice: string | null = null;
  if (payload.kind === 'locator' && payload.at) {
    const at = payload.at;
    const answer = await lc
      .sendRequest<ApplyPickResult>(APPLY_PICK_REQUEST, {
        file: at.file,
        line: at.line - 1,
        locator: payload.text,
      } satisfies ApplyPickParams)
      .catch(() => null);
    if (answer?.uri && answer.edit) {
      const uri = vscode.Uri.parse(answer.uri);
      const { start, end } = answer.edit.range;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(start.line, start.character, end.line, end.character), answer.edit.newText);
      if (await vscode.workspace.applyEdit(edit)) {
        void vscode.window.showInformationMessage(pickNotice(at, 'replaced'));
        return { inserted: true, file: uri.scheme === 'file' ? uri.fsPath : null };
      }
    }
    notice = pickNotice(at, answer?.uri ? 'no-locator' : 'no-file');
  }
  const active = vscode.window.activeTextEditor;
  let text: string;
  let imports: string[] = [];
  if (payload.kind === 'locator') {
    text = payload.text;
  } else {
    const caret = active?.selection.active;
    const rendered = await lc.sendRequest<RenderStepsResult>(RENDER_STEPS_REQUEST, {
      uri: active?.document.uri.toString() ?? '',
      steps: payload.steps,
      line: caret?.line ?? null,
      character: caret?.character ?? null,
      imports: 'separate',
    } satisfies RenderStepsParams);
    if (!rendered.code) throw new Error(rendered.warnings.join('; ') || 'nothing to insert');
    text = rendered.code;
    imports = rendered.imports ?? [];
  }
  if (!active) {
    const content = imports.length ? `${imports.join('\n')}\n\n${text}` : text;
    const document = await vscode.workspace.openTextDocument({ language: 'typescript', content });
    await vscode.window.showTextDocument(document);
    return { inserted: true, file: null };
  }
  const { document, selection } = active;
  const line = document.lineAt(selection.active.line).text;
  const indent = line.slice(0, line.length - line.trimStart().length);
  const lines = Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);
  const insertion = importInsertion(lines, imports);
  const inserted = await active.edit((edit) => {
    if (insertion) {
      const at = new vscode.Position(insertion.range.start.line, insertion.range.start.character);
      // Inside the selection the code replaces, the imports go at the start of its first line.
      const within = selection.start.isBefore(at) && at.isBefore(selection.end);
      edit.insert(within ? new vscode.Position(selection.start.line, 0) : at, insertion.text);
    }
    edit.replace(selection, indentBlock(text, indent));
  });
  if (inserted) {
    void vscode.window.showInformationMessage(
      notice ??
        (payload.kind === 'locator'
          ? 'Piwi: inserted the locator from Piwi Picker.'
          : 'Piwi: inserted the recorded steps from Piwi Picker.'),
    );
  }
  return { inserted, file: active.document.uri.scheme === 'file' ? active.document.uri.fsPath : null };
}

/** Once per machine: tell where Piwi's MCP server went, or offer its configuration where the editor has no provider API. */
async function offerMcp(context: vscode.ExtensionContext, servers: McpServersResult): Promise<void> {
  if (context.globalState.get(MCP_OFFERED) || !servers.servers.length) return;
  await context.globalState.update(MCP_OFFERED, true);
  const hasApi = !!(vscode as unknown as { lm?: Partial<McpApi> }).lm?.registerMcpServerDefinitionProvider;
  if (hasApi) {
    void vscode.window.showInformationMessage(
      "Piwi's MCP server is listed for the editor's agent: it can read your suite's failures, flaky tests and healings.",
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "Add Piwi's MCP server to your agent? It can read your suite's failures, flaky tests and healings.",
    'Copy the configuration',
  );
  if (choice) await vscode.commands.executeCommand('piwi.copyMcpConfiguration');
}

/**
 * Piwi: Connect — the instance, a key for it (signed in with the browser, or pasted; kept in
 * the secret store under that instance), and the project. Returns whether it saved a connection.
 */
async function connect(context: vscode.ExtensionContext, lc: LanguageClient): Promise<boolean> {
  const settings = vscode.workspace.getConfiguration('piwi');
  await context.workspaceState.update(DESKTOP_OFFERED, true);
  // The desktop app running on this machine needs no address or sign-in: offer it first,
  // beside the instance the workspace names, so either is one pick away.
  const desktop = await lc
    .sendRequest<DesktopResult>(DESKTOP_REQUEST)
    .then((d) => (d.url ? d : null))
    .catch(() => null);
  if (desktop) {
    const status = await lc.sendRequest<StatusResult>(STATUS_REQUEST).catch(() => null);
    const choice = await vscode.window.showQuickPick(
      connectChoices(status, desktop, normalizeServerUrl(settings.get<string>('serverUrl')) ?? null),
      { title: 'Piwi: Connect', placeHolder: 'Read this workspace from', ignoreFocusOut: true },
    );
    if (!choice) return false;
    if (choice.target === 'desktop') return useDesktop(context, lc, desktop);
    if (choice.target === 'instance' && choice.serverUrl) return useInstance(context, lc, choice.serverUrl);
  }
  const input = await vscode.window.showInputBox({
    title: 'Piwi: Connect',
    prompt: "The Piwi instance's address",
    value: settings.get<string>('serverUrl') || 'http://localhost:3000',
    ignoreFocusOut: true,
    validateInput: (v) => (normalizeServerUrl(v) ? null : 'An http(s) URL, such as https://piwi.example.com'),
  });
  const base = normalizeServerUrl(input);
  if (!base) return false;
  if (desktop && base === desktop.url) return useDesktop(context, lc, desktop);
  let apiKey: string | null = null;
  let projects: ProjectItem[];
  try {
    const asks = await progress(`Piwi: reaching ${base}…`, () => needsKey(base));
    if (asks) {
      const how = await vscode.window.showQuickPick(
        [
          {
            label: '$(globe) Sign in with the browser',
            detail: 'Allow this editor on the instance; it creates an API key named after it.',
            how: 'browser' as const,
          },
          {
            label: '$(key) Paste an API key',
            detail: "From the dashboard's Settings → API keys.",
            how: 'paste' as const,
          },
        ],
        { title: 'Piwi: Connect', placeHolder: `${base} asks for an API key`, ignoreFocusOut: true },
      );
      if (!how) return false;
      apiKey = how.how === 'browser' ? await signIn(base) : await pasteKey();
      if (!apiKey) return false;
    }
    projects = await progress(`Piwi: listing the projects of ${base}…`, () => listProjects(base, apiKey));
  } catch (e) {
    const reason =
      e instanceof InstanceError && (e.status === 401 || e.status === 403)
        ? `the instance refused the key (${e.status})`
        : (e as Error).message;
    void vscode.window.showErrorMessage(`Piwi: could not connect to ${base}: ${reason}`);
    return false;
  }
  let project = '';
  if (projects.length) {
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, description: `#${p.id}` })),
      { title: 'Piwi: Connect', placeHolder: 'The project this workspace reports to', ignoreFocusOut: true },
    );
    if (!picked) return false;
    project = picked.label;
  }
  await settings.update('serverUrl', base, vscode.ConfigurationTarget.Workspace);
  await settings.update('project', project || undefined, vscode.ConfigurationTarget.Workspace);
  if (apiKey) await context.secrets.store(apiKeySecret(base), apiKey);
  else await context.secrets.delete(apiKeySecret(base));
  await context.workspaceState.update(DESKTOP_CHOSEN, undefined);
  await applyCredentials(context, lc);
  const status = await lc.sendRequest<StatusResult>(STATUS_REQUEST).catch(() => null);
  // The environment and a workspace `.env` come before the settings.
  const first = status?.contexts.find(
    (c) => (c.source === 'environment' || c.source === 'dotenv') && c.serverUrl !== base,
  );
  if (first) {
    void vscode.window.showWarningMessage(
      `Piwi: saved, but ${sourceLabel(first.source)} names ${first.serverUrl}, which comes before the settings.`,
    );
  } else if (!project) {
    void vscode.window.showInformationMessage(
      `Piwi: ${base} has no project yet. Send a run with the Piwi reporter, then run Piwi: Connect again.`,
    );
  } else {
    void vscode.window.showInformationMessage(`Piwi: connected to ${project} on ${base}.`);
  }
  return true;
}

/**
 * Use the desktop app on this machine: it comes first while it runs, and the instance the
 * workspace names stays saved for when it does not. The project is the one linked there to
 * this folder, else the one picked.
 */
async function useDesktop(
  context: vscode.ExtensionContext,
  lc: LanguageClient,
  desktop: DesktopResult,
): Promise<boolean> {
  let project: string | undefined;
  if (!desktop.linked && desktop.projects.length) {
    const picked = await vscode.window.showQuickPick(
      desktop.projects.map((p) => ({ label: p.name, description: `#${p.id}` })),
      {
        title: 'Piwi: Connect',
        placeHolder: 'The project this workspace reports to (link this folder in the desktop app to skip this step)',
        ignoreFocusOut: true,
      },
    );
    if (!picked) return false;
    project = picked.label;
  }
  await context.workspaceState.update(DESKTOP_CHOSEN, true);
  await context.workspaceState.update(DESKTOP_PROJECT, project);
  await context.workspaceState.update(DESKTOP_OFFERED, true);
  await applyCredentials(context, lc);
  const name = desktop.linked?.name ?? project;
  void vscode.window.showInformationMessage(
    name
      ? `Piwi: connected to the desktop app, project ${name}${desktop.linked ? ' (linked to this folder)' : ''}.`
      : "Piwi: the desktop app has no project yet. Import or send a run to it, then link this folder on the project's page there.",
  );
  return true;
}

/** Read the instance the environment, the `.env` or the settings name again, rather than the desktop app. */
async function useInstance(context: vscode.ExtensionContext, lc: LanguageClient, serverUrl: string): Promise<boolean> {
  await context.workspaceState.update(DESKTOP_CHOSEN, undefined);
  await applyCredentials(context, lc);
  void vscode.window.showInformationMessage(`Piwi: connected to ${serverUrl}.`);
  return true;
}

let offeringDesktop = false;

/**
 * Once per workspace: when the desktop app runs while another instance is in use, offer to read
 * the workspace from the app. The other instance stays saved, one Piwi: Connect away.
 */
async function offerDesktop(context: vscode.ExtensionContext, lc: LanguageClient, status: StatusResult): Promise<void> {
  if (!status.desktopUrl || offeringDesktop || context.workspaceState.get<boolean>(DESKTOP_OFFERED)) return;
  const current = status.contexts.find((c) => c.connected) ?? status.contexts[0];
  if (!current?.serverUrl || current.source === 'desktop') return;
  offeringDesktop = true;
  try {
    await context.workspaceState.update(DESKTOP_OFFERED, true);
    const choice = await vscode.window.showInformationMessage(
      `Piwi: the desktop app runs on this machine. Read this workspace from it rather than ${current.serverUrl}? ` +
        'Piwi: Connect switches back.',
      'Use the desktop app',
    );
    if (!choice) return;
    const desktop = await lc.sendRequest<DesktopResult>(DESKTOP_REQUEST).catch(() => null);
    if (desktop?.url) await useDesktop(context, lc, desktop);
  } finally {
    offeringDesktop = false;
  }
}

/**
 * Piwi: Disconnect — forget the workspace's instance and project, the key saved for that instance,
 * and the choice of the desktop app.
 */
async function disconnect(context: vscode.ExtensionContext, lc: LanguageClient): Promise<boolean> {
  const settings = vscode.workspace.getConfiguration('piwi');
  const serverUrl = normalizeServerUrl(settings.get<string>('serverUrl'));
  const question = disconnectQuestion(
    serverUrl,
    settings.get<string>('project') || null,
    !!context.workspaceState.get<boolean>(DESKTOP_CHOSEN),
  );
  if (!question) {
    void vscode.window.showInformationMessage('Piwi: nothing is saved in the settings.');
    return false;
  }
  const answer = await vscode.window.showWarningMessage(`Piwi: ${question}`, { modal: true }, 'Disconnect');
  if (answer !== 'Disconnect') return false;
  if (serverUrl) await context.secrets.delete(apiKeySecret(serverUrl));
  await settings.update('serverUrl', undefined, vscode.ConfigurationTarget.Workspace);
  await settings.update('project', undefined, vscode.ConfigurationTarget.Workspace);
  await context.workspaceState.update(DESKTOP_CHOSEN, undefined);
  await context.workspaceState.update(DESKTOP_PROJECT, undefined);
  await applyCredentials(context, lc);
  return true;
}

function progress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task));
}

async function pasteKey(): Promise<string | null> {
  const key = await vscode.window.showInputBox({
    title: 'Piwi: Connect',
    prompt: "An API key (pd_…), from the dashboard's Settings → API keys",
    password: true,
    ignoreFocusOut: true,
  });
  return key?.trim() || null;
}

/** The browser sign-in: the instance's page opens, the user allows this editor, and the key comes back. */
async function signIn(base: string): Promise<string | null> {
  let started;
  try {
    started = await progress('Piwi: starting the sign-in…', () =>
      startSignIn(base, { editor: vscode.env.appName, os: osName() }),
    );
  } catch (e) {
    if (!(e instanceof InstanceError && e.status === 404)) throw e;
    void vscode.window.showInformationMessage('Piwi: this instance predates the browser sign-in; paste an API key.');
    return pasteKey();
  }
  await vscode.env.openExternal(vscode.Uri.parse(started.verificationUrl));
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Piwi: allow the request in your browser. It shows the code ${started.userCode}.`,
      cancellable: true,
    },
    async (_progress, token) => {
      const cancel = new AbortController();
      token.onCancellationRequested(() => cancel.abort());
      return waitForSignIn(base, started, cancel.signal).catch((e: unknown) => {
        if (cancel.signal.aborted) return null;
        throw e;
      });
    },
  );
  if (!result) return null;
  if (result.status === 'approved' && result.apiKey) return result.apiKey;
  void vscode.window.showInformationMessage(
    result.status === 'denied'
      ? 'Piwi: the request was denied in the browser.'
      : 'Piwi: the request expired. Run Piwi: Connect again.',
  );
  return null;
}

function osName(): string {
  return process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
        ? 'Linux'
        : process.platform;
}

export async function deactivate(): Promise<void> {
  await sendListener?.close();
  sendListener = null;
  await recording?.stopAll();
  recording = null;
  await client?.stop();
  client = null;
}
