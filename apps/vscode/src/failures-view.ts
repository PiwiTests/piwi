/**
 * The Piwi view in the Panel: the latest run's failures as a tree (`failureTree` in `glue.ts`), as
 * `piwi/failuresChanged` pushes them, read from `piwi/failures` when the extension starts and when the connection
 * changes. A failure's click opens its line; its
 * inline actions and context menu run the commands `package.json` binds to its `contextValue`. The grouping and
 * whether the view follows the active editor are kept in `workspaceState`.
 */
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  FAILURES_REQUEST,
  type FailuresResult,
  type RunStatusResult,
  type StatusResult,
} from '@piwitests/editor/protocol';
import { FAILURES_GROUPINGS, failingCount, failureTree, type FailureNode, type FailuresGrouping } from './glue';

const GROUPING = 'piwi.failuresGrouping';
const FOLLOW = 'piwi.followEditor';
/** The pause after a change before the failures are read: a run's end and its failures come together. */
const DEBOUNCE_MS = 200;

/** What the view's welcome says while the tree is empty: `piwi.failuresView` in `package.json`'s `viewsWelcome`. */
type ViewState = 'disconnected' | 'clear' | 'unavailable' | 'failures';

const ICON_COLORS: Record<string, string> = {
  error: 'problemsErrorIcon.foreground',
  check: 'testing.iconPassed',
  pass: 'testing.iconPassed',
  edit: 'problemsInfoIcon.foreground',
};

/** The tree items' `contextValue`: `piwi.failure` and the actions it offers, which the menus' `when` clauses read. */
function contextValue(node: FailureNode, desktop: boolean): string {
  if (node.kind !== 'failure' || !node.failure) return `piwi.${node.kind}`;
  const f = node.failure;
  return [
    'piwi.failure',
    f.state ?? 'failing',
    f.hasTrace ? 'trace' : null,
    f.hasScreenshot ? 'screenshot' : null,
    f.state !== 'fixed-locally' ? 'agent' : null,
    desktop && f.source === 'ci' && f.state !== 'fixed-locally' ? 'desktop' : null,
  ]
    .filter(Boolean)
    .join('.');
}

export class FailuresView implements vscode.TreeDataProvider<FailureNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<FailureNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private result: FailuresResult | null = null;
  private roots: FailureNode[] = [];
  private readonly parents = new Map<string, FailureNode | undefined>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly view: vscode.TreeView<FailureNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly lc: LanguageClient,
    private readonly status: () => StatusResult | null,
    private readonly runs: () => RunStatusResult | null,
  ) {
    this.view = vscode.window.createTreeView('piwi.failures', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      this.changed,
      vscode.window.onDidChangeActiveTextEditor((editor) => void this.follow(editor)),
    );
    void vscode.commands.executeCommand('setContext', FOLLOW, this.following);
  }

  get grouping(): FailuresGrouping {
    return this.context.workspaceState.get<FailuresGrouping>(GROUPING) ?? 'file';
  }

  get following(): boolean {
    return this.context.workspaceState.get<boolean>(FOLLOW) ?? false;
  }

  /** The failures the view shows; null before the first answer. */
  get failures(): FailuresResult | null {
    return this.result;
  }

  /** Read the failures again, once the changes that come together are in. */
  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, DEBOUNCE_MS);
  }

  /** Read the failures now and draw them. */
  async read(): Promise<FailuresResult | null> {
    try {
      this.show(await this.lc.sendRequest<FailuresResult>(FAILURES_REQUEST));
    } catch {
      this.result = null;
      this.render();
      void vscode.commands.executeCommand('setContext', 'piwi.failuresView', 'unavailable' satisfies ViewState);
    }
    return this.result;
  }

  /** Draw the failures as the service answered or pushed them (`piwi/failuresChanged`). */
  show(result: FailuresResult): void {
    this.result = result;
    const connected = !!this.status()?.contexts.some((c) => c.connected);
    const state: ViewState = result.items.length ? 'failures' : connected ? 'clear' : 'disconnected';
    this.render();
    void vscode.commands.executeCommand('setContext', 'piwi.failuresView', state);
  }

  /** Draw the failures as they were read last, for a new grouping or the run in progress. */
  render(): void {
    const live = this.runs()?.contexts.find((c) => c.live?.own)?.live ?? null;
    this.roots = failureTree(this.result, this.grouping, { live });
    this.parents.clear();
    const walk = (nodes: FailureNode[], parent: FailureNode | undefined) => {
      for (const node of nodes) {
        this.parents.set(node.key, parent);
        walk(node.children, node);
      }
    };
    walk(this.roots, undefined);
    const failing = failingCount(this.result);
    this.view.badge = failing
      ? { value: failing, tooltip: `${failing} failing ${failing === 1 ? 'test' : 'tests'}` }
      : undefined;
    this.view.description = `by ${FAILURES_GROUPINGS.find((g) => g.grouping === this.grouping)!.label.toLowerCase()}`;
    const run = this.result?.run;
    this.view.message =
      run && !this.result?.items.length
        ? `No failure in run #${run.id}${run.branch ? ` of ${run.branch}` : ''}.`
        : undefined;
    this.changed.fire(undefined);
  }

  getTreeItem(node: FailureNode): vscode.TreeItem {
    const collapsible =
      node.state === 'expanded'
        ? vscode.TreeItemCollapsibleState.Expanded
        : node.state === 'collapsed'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.id = node.key;
    item.description = node.description;
    const tooltip = new vscode.MarkdownString(node.tooltip);
    item.tooltip = tooltip;
    const color = ICON_COLORS[node.icon];
    item.iconPath = new vscode.ThemeIcon(node.icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = contextValue(node, !!this.status()?.desktopUrl);
    const f = node.failure;
    if (f) {
      item.command = {
        title: 'Open the failing line',
        command: 'vscode.open',
        arguments: [vscode.Uri.parse(f.uri), { selection: new vscode.Range(f.line, 0, f.line, 0), preview: true }],
      };
    } else if (node.kind === 'overlay' && node.url) {
      item.command = { title: 'Open the run in the dashboard', command: 'piwi.openInDashboard', arguments: [node.url] };
    }
    return item;
  }

  getChildren(node?: FailureNode): FailureNode[] {
    return node ? node.children : this.roots;
  }

  getParent(node: FailureNode): FailureNode | undefined {
    return this.parents.get(node.key);
  }

  /** Ask how to group the failures, and keep the answer for this workspace. */
  async pickGrouping(): Promise<void> {
    const current = this.grouping;
    const picked = await vscode.window.showQuickPick(
      FAILURES_GROUPINGS.map((g) => ({
        label: g.label,
        description: g.grouping === current ? 'current' : '',
        detail: g.detail,
        grouping: g.grouping,
      })),
      { placeHolder: 'Group the failures by…' },
    );
    if (!picked) return;
    await this.context.workspaceState.update(GROUPING, picked.grouping);
    this.render();
  }

  /** Turn following the active editor on or off, and keep the choice for this workspace. */
  async toggleFollow(): Promise<void> {
    await this.context.workspaceState.update(FOLLOW, !this.following);
    void vscode.commands.executeCommand('setContext', FOLLOW, this.following);
    if (this.following) await this.follow(vscode.window.activeTextEditor);
  }

  /** While following, select the first failure of the active editor's file. */
  private async follow(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!this.following || !editor || !this.view.visible) return;
    const uri = editor.document.uri.toString();
    const leaves: FailureNode[] = [];
    const walk = (nodes: FailureNode[]) => {
      for (const node of nodes) {
        if (node.failure && vscode.Uri.parse(node.failure.uri).toString() === uri) leaves.push(node);
        walk(node.children);
      }
    };
    walk(this.roots);
    if (leaves[0]) await this.view.reveal(leaves[0], { select: true, focus: false, expand: true });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
