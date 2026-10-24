/**
 * Recording a test from the editor. **Piwi: Record here** and **Piwi: Record a new test file** ask the editor service
 * to open a browser (`piwi/record`); each `piwi/recordingChanged` then rewrites the recorded block in the file, with
 * the import lines it needs in the same edit. While it records, the block is tinted, its controls are a CodeLens
 * above it and the recording is in the status bar; its warnings are diagnostics on their lines, which offer, once it
 * stopped, the other locators the recorder verified for their step as quick fixes. The block is followed
 * through the edits around it (`followBlock` in `glue.ts`), and typing inside it pauses the recording. A test paused in
 * a run started here can ask to record from there (`piwi/recordRequested`): the recording then starts in its file, in
 * the test's own page, without a question.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { State, type LanguageClient } from 'vscode-languageclient/node';
import {
  PAGE_CANDIDATES_REQUEST,
  RECORD_REQUEST,
  RECORD_REQUESTED_NOTIFICATION,
  DECLINE_RECORD_NOTIFICATION,
  type DeclineRecordParams,
  RECORDING_COMMAND_REQUEST,
  RECORDING_NOTIFICATION,
  STOP_RECORDING_REQUEST,
  TEST_AT_REQUEST,
  type FileEdit,
  type PageCandidatesParams,
  type PageCandidatesResult,
  type PiwiCommand,
  type RecordInto,
  type RecordParams,
  type RecordRequested,
  type RecordResult,
  type RecordingCommandParams,
  type RecordingPlacement,
  type RecordingUpdate,
  type RecordingStep,
  type RecordingWarning,
  type StopRecordingParams,
  type TestAtResult,
} from '@piwitests/editor/protocol';
import {
  DOCUMENT_PATTERN,
  RECORDED_ACTIONS,
  TEST_FILE,
  configTestDir,
  followBlock,
  newTestFileName,
  placedBlock,
  recordInto,
  recordedBlockText,
  recordingSummary,
  recordingView,
  writeBlock,
  editedLine,
  followEdit,
  locatorChoices,
  type RecordedBlock,
  type TextChange,
  type TextSpan,
} from './glue';

/** The choices of the last recording: workspace state, on this machine only. */
const LAST_PROJECT = 'piwi.recordProject';
const LAST_START_URL = 'piwi.recordStartUrl';
const LAST_PAGE = 'piwi.recordPage';

/** How many times a write is made again when the document changed while it was applied. */
const WRITE_ATTEMPTS = 5;

/** One recording, as this window follows it. */
interface Session {
  id: string;
  document: vscode.TextDocument;
  uri: string;
  indent: string;
  block: RecordedBlock;
  written: boolean;
  state: RecordingUpdate['state'];
  steps: number;
  warnings: RecordingWarning[];
  /** The steps of the update whose warnings show: the locators a warning's quick fixes offer. */
  recorded: RecordingStep[];
  /** Paused because the block was edited: nothing is written until Resume. */
  edited: boolean;
  /** Keep my edits was chosen, or the window closes: nothing more is written. */
  keep: boolean;
  /** Stopped or failed: the controls are gone, and each warning stays until its line is edited. */
  finished: boolean;
  /** The document's version after the last write; another version means something else edited it since. */
  writtenVersion: number | null;
  /** While a write is applied: the document's changes meanwhile, followed once it resolves. */
  applying: Array<{ version: number; changes: TextChange[] }> | null;
  /** The update to write next: each one holds the whole block, so a newer one replaces it. */
  next: RecordingUpdate | null;
  /** The last message of an update shown, so that one repeated by the next updates shows once. */
  told: string | null;
  writing: boolean;
}

export interface Recording extends vscode.Disposable {
  /** Stop every recording of this window, before the editor service stops. */
  stopAll(): Promise<void>;
}

const toRange = (span: TextSpan) =>
  new vscode.Range(span.start.line, span.start.character, span.end.line, span.end.character);

const documentLines = (document: vscode.TextDocument) =>
  Array.from({ length: document.lineCount }, (_, i) => document.lineAt(i).text);

const exists = (uri: vscode.Uri) =>
  vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );

/**
 * Applies changes to a document in one edit: through an editor that shows it, which leaves the undo stops to
 * `options`, else as a workspace edit, which is an undo step of its own.
 */
async function applyChanges(
  document: vscode.TextDocument,
  changes: TextChange[],
  options: { undoStopBefore: boolean; undoStopAfter: boolean },
): Promise<boolean> {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  if (editor) {
    return editor.edit((builder) => {
      for (const change of changes) builder.replace(toRange(change.range), change.text);
    }, options);
  }
  const edit = new vscode.WorkspaceEdit();
  for (const change of changes) edit.replace(document.uri, toRange(change.range), change.text);
  return vscode.workspace.applyEdit(edit);
}

export function registerRecording(context: vscode.ExtensionContext, lc: LanguageClient): Recording {
  const sessions = new Map<string, Session>();
  /** Updates of a session whose `piwi/record` answer has not arrived yet. */
  const early = new Map<string, RecordingUpdate>();
  /** Sessions whose updates are no longer read. */
  const ended = new Set<string>();
  /** The changes of a document while a `piwi/record` for it is pending, followed once its placement arrives. */
  const starting = new Map<string, TextChange[][]>();
  const lensesChanged = new vscode.EventEmitter<void>();
  const diagnostics = vscode.languages.createDiagnosticCollection('piwi-recording');
  const statusItem = vscode.window.createStatusBarItem('piwi.recording', vscode.StatusBarAlignment.Left, 49);
  statusItem.name = 'Piwi recording';
  const blockBackground = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('piwi.recordingBlockBackground'),
    overviewRulerColor: new vscode.ThemeColor('piwi.recordingBlockBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  const running = () => [...sessions.values()].filter((s) => !s.finished);
  const runningIn = (uri: string) => running().find((s) => s.uri === uri);
  /** The recording a command without an id acts on: the active editor's, else the last one started. */
  const current = () => {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const all = running();
    return all.find((s) => s.uri === active) ?? all[all.length - 1] ?? null;
  };
  const target = (id: unknown) => (typeof id === 'string' ? running().find((s) => s.id === id) : current()) ?? null;
  const nothingRecorded = () => void vscode.window.showInformationMessage('Piwi: nothing is being recorded.');

  /** The status bar item and the context keys of the menus, for the current recording. */
  const refresh = () => {
    const s = current();
    void vscode.commands.executeCommand('setContext', 'piwi.recording', !!s);
    void vscode.commands.executeCommand(
      'setContext',
      'piwi.recordingPaused',
      !!s && (s.edited || s.state === 'paused'),
    );
    lensesChanged.fire();
    if (!s) {
      statusItem.hide();
      return;
    }
    const view = recordingView(s.state, s.steps, s.edited, path.basename(s.document.uri.fsPath));
    statusItem.text = view.status;
    statusItem.tooltip = view.tooltip;
    statusItem.command = { title: 'Stop recording', command: 'piwi.stopRecording', arguments: [s.id] };
    statusItem.show();
  };

  /** The tint over the block of a recording, in each editor that shows its file. */
  const decorate = (uri: string) => {
    const s = runningIn(uri);
    const ranges = s?.written ? [new vscode.Range(s.block.range.start.line, 0, s.block.range.end.line, 0)] : [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) editor.setDecorations(blockBackground, ranges);
    }
  };

  const showWarnings = (s: Session) => {
    const { document } = s;
    diagnostics.set(
      document.uri,
      s.warnings.flatMap((warning) => {
        const line = s.block.range.start.line + warning.line;
        if (line < 0 || line >= document.lineCount) return [];
        const text = document.lineAt(line);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, text.firstNonWhitespaceCharacterIndex, line, text.text.length),
          warning.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'Piwi';
        return [diagnostic];
      }),
    );
  };

  /**
   * The quick fixes on the warnings among `shown` of a recording into `document` that stopped: for each step warned
   * about, one per other locator the recorder verified for it, which replaces the written one on its line.
   */
  const locatorFixes = (document: vscode.TextDocument, shown: readonly vscode.Diagnostic[]): vscode.CodeAction[] => {
    const s = [...sessions.values()].find((session) => session.finished && session.uri === document.uri.toString());
    if (!s) return [];
    const warned = new Map<string, { line: number; step: RecordingStep; diagnostics: vscode.Diagnostic[] }>();
    for (const diagnostic of shown) {
      const line = diagnostic.range.start.line;
      const warning =
        diagnostic.source === 'Piwi'
          ? s.warnings.find((w) => s.block.range.start.line + w.line === line && w.message === diagnostic.message)
          : undefined;
      const step = warning ? s.recorded[warning.step] : undefined;
      if (!warning || !step || line >= document.lineCount) continue;
      const key = `${line} ${warning.step}`;
      const entry = warned.get(key) ?? { line, step, diagnostics: [] };
      entry.diagnostics.push(diagnostic);
      warned.set(key, entry);
    }
    return [...warned.values()].flatMap(({ line, step, diagnostics: fixed }) =>
      locatorChoices(document.lineAt(line).text, step).map((choice) => {
        const action = new vscode.CodeAction(choice.title, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, new vscode.Range(line, choice.start, line, choice.end), choice.locator);
        action.diagnostics = fixed;
        return action;
      }),
    );
  };

  const forget = (s: Session) => {
    sessions.delete(s.id);
    diagnostics.delete(s.document.uri);
  };

  /** Sends a pause or a resume; false when the service did not take it. */
  const send = (s: Session, command: RecordingCommandParams['command']) =>
    lc.sendRequest(RECORDING_COMMAND_REQUEST, { sessionId: s.id, command } satisfies RecordingCommandParams).then(
      () => true,
      (e: Error) => {
        void vscode.window.showWarningMessage(`Piwi: could not ${command} the recording: ${e.message}`);
        return false;
      },
    );

  /** Shows a message of the service, with the command it offers as a button that runs it. */
  const tell = async (message: string, command: PiwiCommand | null | undefined, error: boolean) => {
    const actions = command ? [command.title] : [];
    const picked = error
      ? await vscode.window.showErrorMessage(`Piwi: ${message}`, ...actions)
      : await vscode.window.showInformationMessage(`Piwi: ${message}`, ...actions);
    if (picked && command) await vscode.commands.executeCommand(command.command, ...command.arguments);
  };

  /**
   * The notification after a recording stopped: what was written, with **Run** and **Verify ×3** for the test that
   * holds the block when there is one (`piwi/testAt` at the line the block ends on), which run that test as the block
   * stands when clicked.
   */
  const stopped = async (s: Session, update: RecordingUpdate) => {
    const text = recordingSummary(update, s.keep, path.basename(s.document.uri.fsPath));
    const at = () => ({ uri: s.uri, line: s.block.range.end.line });
    const found = s.written
      ? await lc.sendRequest<TestAtResult>(TEST_AT_REQUEST, { ...at(), character: 0 }).catch(() => null)
      : null;
    const actions = found?.location ? [RECORDED_ACTIONS.run, RECORDED_ACTIONS.verify] : [];
    const picked = await vscode.window.showInformationMessage(text, ...actions);
    if (picked === RECORDED_ACTIONS.run) await vscode.commands.executeCommand('piwi.runTestAtCursor', at());
    else if (picked === RECORDED_ACTIONS.verify) await vscode.commands.executeCommand('piwi.verifyTestAtCursor', at());
  };

  /** The recording ended: its controls go, its warnings stay; `update` is its last one, null when ended here. */
  const finish = (s: Session, update: RecordingUpdate | null) => {
    s.finished = true;
    ended.add(s.id);
    if (!s.written) forget(s);
    decorate(s.uri);
    refresh();
    if (update?.state === 'failed') void tell(update.message || 'the recording stopped.', update.command, true);
    else if (update) void stopped(s, update);
  };

  /** Ends the recordings of a file that is no longer open: nothing more is written there. */
  const close = (uri: string) => {
    for (const s of sessions.values()) {
      if (s.uri !== uri) continue;
      if (!s.finished) {
        s.keep = true;
        s.finished = true;
        ended.add(s.id);
        void lc.sendRequest(STOP_RECORDING_REQUEST, { sessionId: s.id }).catch(() => undefined);
      }
      forget(s);
    }
    decorate(uri);
    refresh();
  };

  const stop = async (id?: unknown) => {
    const s = target(id);
    if (!s) return nothingRecorded();
    if (s.edited) s.keep = true;
    try {
      await lc.sendRequest(STOP_RECORDING_REQUEST, { sessionId: s.id } satisfies StopRecordingParams);
    } catch (e) {
      finish(s, null);
      void vscode.window.showWarningMessage(`Piwi: could not stop the recording: ${(e as Error).message}`);
    }
  };

  /** Pause: the recording shows as paused here once the service took it, before its update says so. */
  const pause = async (id?: unknown) => {
    const s = target(id);
    if (!s) return nothingRecorded();
    if (s.edited || s.state !== 'recording') return;
    if ((await send(s, 'pause')) && !s.finished && s.state === 'recording') {
      s.state = 'paused';
      refresh();
    }
  };

  /** Resume: the service sends its latest update again, which rewrites the block, edits included. */
  const resume = async (id?: unknown) => {
    const s = target(id);
    if (!s) return nothingRecorded();
    s.edited = false;
    refresh();
    await send(s, 'resume');
  };

  const onEdited = async (s: Session) => {
    s.edited = true;
    refresh();
    if (s.state === 'starting' || s.state === 'recording') void send(s, 'pause');
    const picked = await vscode.window.showInformationMessage(
      'Piwi: you edited the recorded block, so the recording is paused. Resume writes the block again from the ' +
        'recorded steps; Keep my edits stops the recording and keeps the code as it is.',
      'Resume',
      'Keep my edits',
    );
    if (s.finished || !s.edited) return;
    if (picked === 'Resume') await resume(s.id);
    else if (picked === 'Keep my edits') await stop(s.id);
  };

  /**
   * Follows a recording's block through a change of its file. An edit inside a written block pauses the recording;
   * after the recording, it removes the warnings of the lines it edits, which no longer describe them, and all of
   * them when it adds or removes a line of the block.
   */
  const follow = (s: Session, changes: TextChange[]) => {
    let inside = false;
    let moved = false;
    let reshaped = false;
    /** The lines of the block edited in place, counted from its first line. */
    const lines = new Set<number>();
    for (const change of changes) {
      const next = followBlock(s.block.range, change);
      if (next.where === 'inside') {
        const line = editedLine(change);
        if (line === null) reshaped = true;
        else lines.add(line - s.block.range.start.line);
      }
      s.block = { ...s.block, range: next.block };
      inside ||= next.where === 'inside';
      moved ||= next.where === 'above';
    }
    if (s.finished) {
      if (inside) s.warnings = reshaped ? [] : s.warnings.filter((warning) => !lines.has(warning.line));
      if (inside && !s.warnings.length) forget(s);
      else if (inside || moved) showWarnings(s);
      return;
    }
    if (!s.written) return;
    if (moved) showWarnings(s);
    if (inside && !s.edited && !s.keep) void onEdited(s);
    if (inside || moved) {
      decorate(s.uri);
      lensesChanged.fire();
    }
  };

  /**
   * Writes the block's new text, with the service's import edit, as one edit. Every write joins the undo stop the first
   * one opened, so that one undo removes the whole recording; a write starts a new undo stop only when something
   * else edited the file since the last one. A write the editor refuses because the file changed meanwhile is made
   * again from the block's new place.
   */
  const write = async (s: Session, text: string, importEdit: FileEdit | null, last: boolean): Promise<boolean> => {
    let edit = importEdit;
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const { document } = s;
      if (s.edited || s.keep || document.isClosed) return false;
      const plan = writeBlock(documentLines(document), s.block, text, edit);
      const unchanged =
        s.written &&
        plan.changes.length === 1 &&
        document.getText(toRange(s.block.range)).replace(/\r\n/g, '\n') === text;
      if (unchanged) return true;
      const fromVersion = document.version;
      const seen: Array<{ version: number; changes: TextChange[] }> = [];
      s.applying = seen;
      let applied = false;
      try {
        applied = await applyChanges(document, plan.changes, {
          undoStopBefore: !s.written || fromVersion !== s.writtenVersion,
          undoStopAfter: last,
        });
      } catch {
        applied = false;
      } finally {
        s.applying = null;
      }
      if (!applied) {
        for (const change of seen) follow(s, change.changes);
        if (edit)
          edit = followEdit(
            edit,
            seen.flatMap((change) => change.changes),
          );
        continue;
      }
      // The change that made the document's next version is this write; any other one came after it.
      const own = seen.findIndex((change) => change.version === fromVersion + 1);
      s.block = { range: plan.block, first: null };
      s.written = true;
      s.writtenVersion = own === -1 ? fromVersion : fromVersion + 1;
      for (const [i, change] of seen.entries()) if (i !== own) follow(s, change.changes);
      return true;
    }
    return false;
  };

  const take = async (s: Session, update: RecordingUpdate) => {
    s.state = update.state;
    s.steps = update.steps.length;
    const ending = update.state === 'stopped' || update.state === 'failed';
    const writes = update.state !== 'failed' && !s.edited && !s.keep && (s.written || !!update.code || !ending);
    if (writes && (await write(s, recordedBlockText(update.code, s.indent), update.importEdit, ending))) {
      s.warnings = update.warnings;
      s.recorded = update.steps;
      showWarnings(s);
    }
    if (ending) {
      finish(s, update);
      return;
    }
    if (update.message && update.message !== s.told) void tell(update.message, update.command, false);
    s.told = update.message ?? s.told;
    decorate(s.uri);
    refresh();
  };

  /** Writes a session's updates one at a time, the newest only when several arrived during a write. */
  const drain = async (s: Session) => {
    if (s.writing) return;
    s.writing = true;
    try {
      while (s.next && !s.finished) {
        const update = s.next;
        s.next = null;
        await take(s, update).catch(
          (e: Error) => void vscode.window.showWarningMessage(`Piwi: could not write the recorded block: ${e.message}`),
        );
      }
    } finally {
      s.writing = false;
    }
  };

  const receive = (update: RecordingUpdate) => {
    if (ended.has(update.sessionId)) return;
    const s = sessions.get(update.sessionId);
    if (!s) {
      early.set(update.sessionId, update);
      return;
    }
    s.next = update;
    void drain(s);
  };

  const begin = (document: vscode.TextDocument, id: string, placement: RecordingPlacement, since: TextChange[][]) => {
    const uri = document.uri.toString();
    close(uri);
    const s: Session = {
      id,
      document,
      uri,
      indent: placement.indent,
      block: placedBlock(placement),
      written: false,
      state: 'starting',
      steps: 0,
      warnings: [],
      recorded: [],
      edited: false,
      keep: false,
      finished: false,
      writtenVersion: null,
      applying: null,
      next: null,
      told: null,
      writing: false,
    };
    sessions.set(id, s);
    for (const changes of since) follow(s, changes);
    if (document.isClosed) {
      close(uri);
      return;
    }
    refresh();
    const update = early.get(id);
    early.delete(id);
    if (update) receive(update);
  };

  const askPage = (candidates: PageCandidatesResult, title: string): Promise<string | undefined> => {
    const first = candidates.candidates.find((c) => c.expression === candidates.default) ?? {
      expression: candidates.default,
      reason: '',
    };
    const items: vscode.QuickPickItem[] = [
      first,
      ...candidates.candidates.filter((c) => c.expression !== candidates.default),
    ].map((c) => ({ label: c.expression, description: c.reason }));
    if (items.length === 1) return Promise.resolve(candidates.default);
    return new Promise((resolve) => {
      const pick = vscode.window.createQuickPick();
      pick.title = title;
      pick.placeholder = 'The page the steps run on: pick one, or type another expression';
      pick.ignoreFocusOut = true;
      pick.items = items;
      const last = items.find((item) => item.label === context.workspaceState.get<string>(LAST_PAGE));
      if (last) pick.activeItems = [last];
      pick.onDidChangeValue((value) => {
        const typed = value.trim();
        pick.items =
          typed && !items.some((item) => item.label === typed)
            ? [...items, { label: typed, description: 'Another expression' }]
            : items;
      });
      pick.onDidAccept(() => {
        resolve(pick.selectedItems[0]?.label ?? (pick.value.trim() || undefined));
        pick.hide();
      });
      pick.onDidHide(() => {
        resolve(undefined);
        pick.dispose();
      });
      pick.show();
    });
  };

  const askProject = (projects: string[], title: string) => {
    const last = context.workspaceState.get<string>(LAST_PROJECT);
    const ordered = last && projects.includes(last) ? [last, ...projects.filter((p) => p !== last)] : projects;
    return vscode.window.showQuickPick(ordered, {
      title,
      placeHolder: 'The Playwright project whose use options the browser gets (baseURL, storageState, viewport…)',
      ignoreFocusOut: true,
    });
  };

  /** `piwi/record`, with the changes of the file while it is pending. Null when the request failed. */
  const requestRecord = async (params: RecordParams) => {
    const since: TextChange[][] = [];
    starting.set(params.uri, since);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Piwi: starting the recording…' },
        () => lc.sendRequest<RecordResult>(RECORD_REQUEST, params),
      );
      return { result, since };
    } catch (e) {
      void vscode.window.showErrorMessage(`Piwi: could not start the recording: ${(e as Error).message}`);
      return null;
    } finally {
      starting.delete(params.uri);
    }
  };

  /** The files a recording is being started in: its questions are open, or `piwi/record` is pending. */
  const opening = new Set<string>();

  /**
   * Starts a recording into `document` at `at`, unless one is being started in that file already: into the steps of
   * the test there, or a new test, unless `into` says.
   */
  const start = async (document: vscode.TextDocument, at: vscode.Position, into: RecordInto | null, title: string) => {
    const uri = document.uri.toString();
    if (opening.has(uri)) {
      void vscode.window.showInformationMessage('Piwi: a recording is being started in this file already.');
      return;
    }
    opening.add(uri);
    try {
      await open(document, at, into, title);
    } finally {
      opening.delete(uri);
    }
  };

  /**
   * The start of a recording: the start page and the page expression are asked first, the Playwright project only
   * when the service lists them.
   */
  const open = async (document: vscode.TextDocument, at: vscode.Position, into: RecordInto | null, title: string) => {
    const uri = document.uri.toString();
    const already = runningIn(uri);
    if (already) {
      const choice = await vscode.window.showInformationMessage(
        'Piwi: this file is being recorded into already.',
        'Stop',
      );
      if (choice) await stop(already.id);
      return;
    }
    const position: PageCandidatesParams = { uri, line: at.line, character: at.character };
    let candidates: PageCandidatesResult;
    try {
      candidates = await lc.sendRequest<PageCandidatesResult>(PAGE_CANDIDATES_REQUEST, position);
    } catch (e) {
      void vscode.window.showErrorMessage(`Piwi: could not start the recording: ${(e as Error).message}`);
      return;
    }
    const startUrl = await vscode.window.showInputBox({
      title,
      prompt: 'The page the browser opens: a path on the baseURL, or an address. Leave it empty for the baseURL.',
      placeHolder: '/',
      value: context.workspaceState.get<string>(LAST_START_URL) ?? '',
      ignoreFocusOut: true,
    });
    if (startUrl === undefined) return;
    await context.workspaceState.update(LAST_START_URL, startUrl.trim());
    const page = await askPage(candidates, title);
    if (!page) return;
    await context.workspaceState.update(LAST_PAGE, page);
    const params: RecordParams = {
      ...position,
      into: into ?? recordInto(candidates.context),
      project: context.workspaceState.get<string>(LAST_PROJECT) || null,
      startUrl: startUrl.trim() || null,
      page,
      language: vscode.env.language,
    };
    let answer = await requestRecord(params);
    if (answer && !answer.result.ok && answer.result.projects?.length) {
      const project = await askProject(answer.result.projects, title);
      if (!project) return;
      await context.workspaceState.update(LAST_PROJECT, project);
      answer = await requestRecord({ ...params, project });
    }
    if (!answer) return;
    const { result, since } = answer;
    if (!result.ok || !result.sessionId || !result.placement) {
      void vscode.window.showWarningMessage(`Piwi: ${result.message}`);
      return;
    }
    begin(document, result.sessionId, result.placement, since);
  };

  /**
   * A test paused in a run started here asks to record from there: its file is shown at the paused line, and the
   * recording starts as one at the caret does, in the test's page, with nothing asked. One that cannot start says
   * why; the test goes on.
   */
  const recordFromTest = async (asked: RecordRequested) => {
    /** The test hears at once why no recording starts, and goes on. */
    const decline = (message: string) =>
      void lc
        .sendNotification(DECLINE_RECORD_NOTIFICATION, {
          handoff: asked.handoff,
          message,
        } satisfies DeclineRecordParams)
        .catch(() => {});
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.parse(asked.uri));
    } catch (e) {
      void vscode.window.showWarningMessage(`Piwi: could not open the file to record into: ${(e as Error).message}`);
      decline(`the editor could not open the file: ${(e as Error).message}`);
      return;
    }
    const at = new vscode.Position(asked.line, 0);
    await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(at, at) });
    const uri = document.uri.toString();
    if (opening.has(uri) || runningIn(uri)) {
      void vscode.window.showInformationMessage('Piwi: this file is being recorded into already.');
      decline(`${path.basename(document.uri.fsPath)} is being recorded into already.`);
      return;
    }
    opening.add(uri);
    try {
      const answer = await requestRecord({
        uri,
        line: asked.line,
        character: 0,
        into: 'steps',
        handoff: asked.handoff,
        language: vscode.env.language,
      });
      if (!answer) {
        decline('the editor could not start the recording.');
        return;
      }
      const { result, since } = answer;
      if (!result.ok || !result.sessionId || !result.placement) {
        void vscode.window.showWarningMessage(`Piwi: ${result.message}`);
        return;
      }
      void vscode.window.showInformationMessage(`Piwi: ${result.message}`);
      begin(document, result.sessionId, result.placement, since);
    } finally {
      opening.delete(uri);
    }
  };

  const recordHere = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Piwi: open a test file to record into.');
      return;
    }
    await start(editor.document, editor.selection.active, null, 'Piwi: Record here');
  };

  /**
   * The folder a new test file goes in: next to `file` (the active file) when it is a test file, else the test
   * folder of the workspace's Playwright config; with the file whose suffix the new name takes.
   */
  const newFileFolder = async (file: vscode.Uri | undefined) => {
    if (file?.scheme === 'file' && TEST_FILE.test(file.fsPath)) {
      return { folder: vscode.Uri.file(path.dirname(file.fsPath)), sample: file.fsPath };
    }
    const [config] = await vscode.workspace.findFiles(
      '**/playwright.config.{ts,js,mjs,cjs,mts,cts}',
      '**/node_modules/**',
      1,
    );
    if (config) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(config)).toString('utf-8');
      const folder = path.resolve(path.dirname(config.fsPath), configTestDir(text) ?? '.');
      return { folder: vscode.Uri.file(folder), sample: config.fsPath };
    }
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    return workspace ? { folder: workspace, sample: null } : null;
  };

  /** The new test file's path, asked relative to its workspace folder; null when cancelled. */
  const askNewFile = async (file: vscode.Uri | undefined): Promise<vscode.Uri | null> => {
    const where = await newFileFolder(file);
    if (!where) {
      void vscode.window.showInformationMessage('Piwi: open a folder to create the test file in.');
      return null;
    }
    const root = (vscode.workspace.getWorkspaceFolder(where.folder)?.uri ?? where.folder).fsPath;
    const offered = newTestFileName(where.sample);
    const dot = offered.indexOf('.');
    let name = offered;
    for (let n = 2; n < 100 && (await exists(vscode.Uri.joinPath(where.folder, name))); n++) {
      name = `${offered.slice(0, dot)}-${n}${offered.slice(dot)}`;
    }
    const value = path.relative(root, path.join(where.folder.fsPath, name));
    const nameAt = value.length - name.length;
    const answer = await vscode.window.showInputBox({
      title: 'Piwi: Record a new test file',
      prompt: `The new test file, relative to ${path.basename(root)}`,
      value,
      valueSelection: [nameAt, nameAt + name.indexOf('.')],
      ignoreFocusOut: true,
      validateInput: async (input) => {
        if (!/\.[cm]?[jt]sx?$/.test(input.trim())) return 'A JavaScript or TypeScript file, such as checkout.spec.ts';
        return (await exists(vscode.Uri.file(path.resolve(root, input.trim())))) ? 'This file exists already.' : null;
      },
    });
    return answer?.trim() ? vscode.Uri.file(path.resolve(root, answer.trim())) : null;
  };

  /** Creates a test file, opens it, and records a whole spec into it. */
  const recordNewFile = async (file: vscode.Uri | undefined) => {
    const created = await askNewFile(file ?? vscode.window.activeTextEditor?.document.uri);
    if (!created) return;
    try {
      await vscode.workspace.fs.writeFile(created, new Uint8Array());
    } catch (e) {
      void vscode.window.showErrorMessage(`Piwi: could not create ${created.fsPath}: ${(e as Error).message}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(created);
    await vscode.window.showTextDocument(document, { preview: false });
    await start(document, new vscode.Position(0, 0), 'file', 'Piwi: Record a new test file');
  };

  const disposables: vscode.Disposable[] = [
    lensesChanged,
    diagnostics,
    statusItem,
    blockBackground,
    vscode.commands.registerCommand('piwi.record', () => recordHere()),
    vscode.commands.registerCommand('piwi.recordFile', (file?: unknown) =>
      recordNewFile(file instanceof vscode.Uri ? file : undefined),
    ),
    vscode.commands.registerCommand('piwi.stopRecording', (id?: unknown) => stop(id)),
    vscode.commands.registerCommand('piwi.pauseRecording', (id?: unknown) => pause(id)),
    vscode.commands.registerCommand('piwi.resumeRecording', (id?: unknown) => resume(id)),
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file', pattern: DOCUMENT_PATTERN },
      {
        onDidChangeCodeLenses: lensesChanged.event,
        provideCodeLenses(document) {
          const s = runningIn(document.uri.toString());
          if (!s?.written) return [];
          const line = s.block.range.start.line;
          const range = new vscode.Range(line, 0, line, 0);
          const view = recordingView(s.state, s.steps, s.edited, path.basename(document.uri.fsPath));
          return [
            new vscode.CodeLens(range, { title: view.title, command: '' }),
            ...view.actions.map(
              (action) =>
                new vscode.CodeLens(range, { title: action.title, command: action.command, arguments: [s.id] }),
            ),
          ];
        },
      },
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', pattern: DOCUMENT_PATTERN },
      { provideCodeActions: (document, _range, { diagnostics: shown }) => locatorFixes(document, shown) },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    lc.onNotification(RECORDING_NOTIFICATION, (update: RecordingUpdate) => receive(update)),
    lc.onNotification(RECORD_REQUESTED_NOTIFICATION, (asked: RecordRequested) => void recordFromTest(asked)),
    lc.onDidChangeState((e) => {
      if (e.newState !== State.Stopped) return;
      for (const s of running()) {
        s.keep = true;
        finish(s, null);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length || (!sessions.size && !starting.size)) return;
      const uri = e.document.uri.toString();
      const changes: TextChange[] = e.contentChanges.map((c) => ({
        range: {
          start: { line: c.range.start.line, character: c.range.start.character },
          end: { line: c.range.end.line, character: c.range.end.character },
        },
        text: c.text,
      }));
      starting.get(uri)?.push(changes);
      for (const s of sessions.values()) {
        if (s.uri !== uri) continue;
        if (s.applying) s.applying.push({ version: e.document.version, changes });
        else follow(s, changes);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => close(document.uri.toString())),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      const open = new Set(
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .flatMap((tab) =>
            tab.input instanceof vscode.TabInputText
              ? [tab.input.uri.toString()]
              : tab.input instanceof vscode.TabInputTextDiff
                ? [tab.input.modified.toString()]
                : [],
          ),
      );
      for (const s of running()) if (!open.has(s.uri)) close(s.uri);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const uri of new Set(editors.map((editor) => editor.document.uri.toString()))) decorate(uri);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => refresh()),
  ];

  return {
    async stopAll() {
      const all = running();
      for (const s of all) {
        s.keep = true;
        finish(s, null);
      }
      await Promise.race([
        Promise.allSettled(all.map((s) => lc.sendRequest(STOP_RECORDING_REQUEST, { sessionId: s.id }))),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
