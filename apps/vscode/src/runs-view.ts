/**
 * The **Runs** view of the Piwi panel (`piwi.liveRuns`), shown while a run is in progress: each run with how far it is,
 * each of its workers with its test and whether it stands stopped, and the run's page on the dashboard. A row names its
 * run and worker, so the run commands of its menus (Watch, Pause and watch, Resume, Step, Stop the run, Hold failures)
 * act on it. What
 * it lists comes from `runNodes` (`run-control.ts`), tested without an editor.
 */
import { setContextKey } from './context-keys';
import * as vscode from 'vscode';
import type { RunSession } from '@piwitests/editor/protocol';
import { runNodes, type RunNode } from './run-control';

export interface RunsView extends vscode.Disposable {
  /** The run sessions changed: the view is drawn again. */
  changed(sessions: ReadonlyMap<string, RunSession>): void;
}

export function registerRunsView(): RunsView {
  let nodes: RunNode[] = [];
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.TreeDataProvider<RunNode> = {
    onDidChangeTreeData: changed.event,
    getChildren: (node) => (node ? node.children : nodes),
    getTreeItem: (node) => {
      const item = new vscode.TreeItem(
        node.label,
        node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = node.key;
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      // A run that holds failures or can is `run hold`, so its menu offers Hold failures.
      item.contextValue = node.hold === undefined ? node.kind : `${node.kind} hold`;
      const open = node.open;
      if (open && 'url' in open) {
        item.command = { command: 'piwi.openInDashboard', title: node.label, arguments: [open.url] };
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
  const view = vscode.window.createTreeView('piwi.liveRuns', { treeDataProvider: provider });
  return {
    changed(sessions) {
      nodes = runNodes(sessions);
      setContextKey('piwi.liveRuns', nodes.length > 0);
      changed.fire();
    },
    dispose() {
      setContextKey('piwi.liveRuns', false);
      view.dispose();
      changed.dispose();
    },
  };
}
