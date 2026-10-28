/**
 * **Debug in my editor**: the dashboard's open link with `debug=1`. The link is checked field by field and its files
 * found in this window (`debug-link.ts`); the failing line opens, and a notification asks before anything runs. Only
 * a yes runs the test, as every run Piwi starts here does (`runTests`, the editor's breakpoints included), with
 * `RunTestsArgs.debug`: the service finds the test in its spec by its title, runs it headed with one worker, and stops
 * once at the failing line, a breakpoint of that run alone, so the editor's own breakpoints are left as they are. At
 * the stop, the service outlines the failure's suggested locator on the page and says so.
 */
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { RunCommand, RunTestsArgs } from '@piwitests/editor/protocol';
import { debugFiles, debugLink, debugPrompt, debugRefusal, type DebugLink } from './debug-link';

/** What the prompt's button says. */
export const DEBUG_ANSWER = 'Debug';

/** What a debug link needs of the rest of the extension. */
export interface DebugLinkOptions {
  /** The Playwright configs' folders of this window. */
  configRoots(): string[];
  /**
   * Runs tests as every run Piwi starts here does; the command started, or null, saying nothing of it: the service
   * says why it builds no debug run.
   */
  runTests(args: RunTestsArgs): Promise<RunCommand | null>;
}

/**
 * Asks before a link runs anything: a notification, never modal, which the person may leave; the button chosen, if
 * any. The integration suite answers it through the API `activate` returns.
 */
export type DebugAsk = (prompt: string, answer: string) => Thenable<string | undefined>;

const disk = {
  isFile: (file: string) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  realpath: (file: string) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return null;
    }
  },
};

/** Saves the open document of `uri` when it has unsaved changes: the run reads the spec as saved. */
async function saved(uri: vscode.Uri): Promise<boolean> {
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  return !document?.isDirty || document.save();
}

/**
 * Open a debug link's failing line, ask, and on a yes run its test to stop there. A link refused, or naming a file of
 * no folder of this window, says so and opens and runs nothing.
 */
export async function openDebugLink(
  query: string,
  options: DebugLinkOptions,
  ask: DebugAsk = (prompt, answer) => vscode.window.showInformationMessage(prompt, answer),
): Promise<void> {
  const link: DebugLink | { refused: string } = debugLink(query);
  if ('refused' in link) {
    void vscode.window.showWarningMessage(debugRefusal(link.refused));
    return;
  }
  const places = {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    configRoots: options.configRoots(),
  };
  const files = debugFiles(link, places, disk);
  if ('refused' in files) {
    void vscode.window.showWarningMessage(debugRefusal(files.refused));
    return;
  }
  const failing = vscode.Uri.file(files.file);
  const document = await vscode.workspace.openTextDocument(failing);
  const at = document.validatePosition(new vscode.Position(link.line - 1, link.column - 1));
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(at, at), preview: false });
  if ((await ask(debugPrompt(link), DEBUG_ANSWER)) !== DEBUG_ANSWER) return;
  const spec = vscode.Uri.file(files.spec);
  if (!(await saved(spec))) return;
  await options
    .runTests({
      uri: spec.toString(),
      testIds: [],
      debug: {
        stop: { uri: failing.toString(), line: link.line - 1 },
        title: link.title,
        project: link.project,
        execution: link.execution,
      },
    })
    .catch(() => vscode.window.showWarningMessage('Piwi: the editor service did not answer, so nothing runs.'));
}
