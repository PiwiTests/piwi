/**
 * The **Piwi Picker** view of the Piwi panel (`piwi.picker`): the pairing with Piwi Picker, the browser extension. A
 * request Piwi Picker makes shows there, with Allow and Deny, beside the notification that asks; once paired, it shows
 * since when, when Piwi Picker was last heard from and where this window listens. Not paired, its welcome says how to
 * pair. What it lists comes from `pickerRows` (`picker-pairing.ts`), tested without an editor.
 */
import * as vscode from 'vscode';
import { setContextKey } from './context-keys';
import { pickerPaired, pickerRows, pickerViewKind, type PickerRow, type PickerViewState } from './picker-pairing';

/** How often the view is drawn again while it shows, for "Last heard 2 min ago". */
const REDRAW_MS = 30_000;

export interface PickerView extends vscode.Disposable {
  /** The pairing changed: the view is drawn again. */
  changed(): void;
  /** Opens the Piwi panel on the view. */
  reveal(): Promise<void>;
}

export function registerPickerView(state: () => PickerViewState): PickerView {
  let rows: PickerRow[] = [];
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.TreeDataProvider<PickerRow> = {
    onDidChangeTreeData: changed.event,
    getChildren: (row) => (row ? [] : rows),
    getTreeItem: (row) => {
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
      item.id = row.key;
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.iconPath = new vscode.ThemeIcon(row.icon);
      if (row.contextValue) item.contextValue = row.contextValue;
      return item;
    },
  };
  const view = vscode.window.createTreeView('piwi.picker', { treeDataProvider: provider });
  const draw = () => {
    const now = state();
    rows = pickerRows(now, Date.now());
    setContextKey('piwi.pickerView', pickerViewKind(now));
    setContextKey('piwi.pickerPaired', pickerPaired(now));
    view.badge = now.waiting.length
      ? { value: now.waiting.length, tooltip: 'Piwi Picker asks to pair with this editor' }
      : undefined;
    changed.fire();
  };
  const timer = setInterval(() => {
    if (view.visible) draw();
  }, REDRAW_MS);
  draw();
  return {
    changed: draw,
    reveal: async () => {
      await vscode.commands.executeCommand('piwi.picker.focus');
    },
    dispose() {
      clearInterval(timer);
      view.dispose();
      changed.dispose();
    },
  };
}
