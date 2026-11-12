/**
 * The CI runs of the branch while they run (`piwi/ciSessionChanged`), read-only: the **CI Runs** view of the Piwi
 * panel, shown while one runs (`piwi.ciRuns`), and a plain mark at the end of the line each of their running tests is
 * at, a CI position: no gutter icon, no background and no control, since nothing waits there. A running test's
 * **Watch** opens its lane in the worker panel (`piwi.watchWorker` with the lane), read-only. What the view lists and
 * what a line says come from `run-control.ts`, tested without an editor.
 */
import * as vscode from 'vscode';
import type { CiSession } from '@piwitests/editor/protocol';
import {
  RUN_COMMANDS,
  ciNodes,
  ciPositionFiles,
  ciPositionsIn,
  withCiSession,
  type CiNode,
  type CiSessions,
} from './run-control';

export interface CiRuns extends vscode.Disposable {
  /** A session heard from the service: the view and the marks drawn again. */
  heard(session: CiSession): void;
  /** The sessions kept, the latest of each run. */
  sessions(): CiSessions;
  /** The service stopped: its sessions go. */
  clear(): void;
}

/** A session with its files spelled as VS Code spells a document's URI (`file:///c%3A/…` on Windows). */
function asEditorUris(session: CiSession): CiSession {
  const spelled = (uri: string) => vscode.Uri.parse(uri).toString();
  return {
    ...session,
    tests: session.tests.map((t) => ({
      ...t,
      uri: t.uri ? spelled(t.uri) : null,
      at: t.at ? { ...t.at, uri: spelled(t.at.uri) } : null,
    })),
  };
}

export function registerCiRuns(): CiRuns {
  let sessions: CiSessions = new Map();
  let nodes: CiNode[] = [];
  /** The files marked now, to clear as their positions go. */
  let marked = new Set<string>();
  const changed = new vscode.EventEmitter<void>();
  // A plain mark after the line's text, in CodeLens's color: none of the gutter icon and background a stop's line has.
  const mark = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  const provider: vscode.TreeDataProvider<CiNode> = {
    onDidChangeTreeData: changed.event,
    getChildren: (node) => (node ? node.children : nodes),
    getTreeItem: (node) => {
      const state = !node.children.length
        ? vscode.TreeItemCollapsibleState.None
        : node.open
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(node.label, state);
      item.id = node.key;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      const open = node.open;
      if (open && 'url' in open) {
        item.command = { command: 'piwi.openInDashboard', title: node.label, arguments: [open.url] };
      } else if (open && 'lane' in open) {
        item.command = { command: RUN_COMMANDS.watch, title: node.label, arguments: [{ ci: open.lane }] };
      } else if (open) {
        const at = new vscode.Position(open.line, open.character);
        item.command = {
          command: 'vscode.open',
          title: node.label,
          arguments: [vscode.Uri.parse(open.uri), { selection: new vscode.Range(at, at), preview: true }],
        };
      }
      return item;
    },
  };
  const view = vscode.window.createTreeView('piwi.ciRuns', { treeDataProvider: provider });

  /** Mark the CI positions of the editors in sight, and clear the files no position is in any more. */
  const draw = () => {
    const now = ciPositionFiles(sessions);
    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      if (!now.has(uri) && !marked.has(uri)) continue;
      const lines = editor.document.lineCount;
      editor.setDecorations(
        mark,
        ciPositionsIn(sessions, uri)
          .filter((p) => p.line < lines)
          .map((p) => {
            const end = editor.document.lineAt(p.line).range.end;
            const hover = new vscode.MarkdownString();
            hover.appendText(`${p.text}\n\nA CI position: a test of a CI run runs this line now. Nothing waits here.`);
            return {
              range: new vscode.Range(end, end),
              hoverMessage: hover,
              renderOptions: { after: { contentText: `  ${p.text}` } },
            };
          }),
      );
    }
    marked = now;
  };

  const show = () => {
    nodes = ciNodes(sessions);
    changed.fire();
    void vscode.commands.executeCommand('setContext', 'piwi.ciRuns', sessions.size > 0);
    view.description = sessions.size > 1 ? `${sessions.size} running` : undefined;
    draw();
  };

  const disposables: vscode.Disposable[] = [
    changed,
    mark,
    view,
    vscode.window.onDidChangeVisibleTextEditors(() => draw()),
  ];

  return {
    heard(session) {
      sessions = withCiSession(sessions, asEditorUris(session));
      show();
    },
    sessions: () => sessions,
    clear() {
      if (!sessions.size) return;
      sessions = new Map();
      show();
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
