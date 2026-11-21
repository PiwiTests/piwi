// The developer's editor: VS Code, as `@vscode/test-electron` downloads it, with the built Piwi extension, opened on
// the shop's checkout and placed at its tile. Driven through the workbench's DOM as the extension's nightly suite
// drives it (`apps/vscode/scripts/lib/vscode-window.mjs`), and read through the files on disk.
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { command, launchVSCode } from '../../vscode/scripts/lib/vscode-window.mjs';
import { REPO_ROOT } from './workspace.mjs';

const EXTENSION = path.join(REPO_ROOT, 'apps', 'vscode');

/** The signals that stop a take, which `showcase.mjs` handles. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Where VS Code is downloaded and cached: the extension's own `.vscode-test/`, which the nightly job caches. */
const VSCODE_CACHE = process.env.SHOWCASE_VSCODE_CACHE || path.join(EXTENSION, '.vscode-test');

/** The editor's settings over the extension suite's quiet ones: the workbench as a person keeps it for this. */
const SETTINGS = {
  'window.newWindowDimensions': 'default',
  'workbench.editor.enablePreview': false,
  'files.autoSave': 'off',
  'explorer.autoReveal': false,
  'notebook.experimental.generate': false,
  'testing.automaticallyOpenTestResults': 'neverOpen',
  'terminal.integrated.tabs.enabled': false,
  // Piwi's links open without VS Code's question, as once a person ticked "Do not ask me again" for the extension.
  'extensions.confirmedUriHandlerExtensionIds': ['piwitests.piwi'],
  // The editor service's traffic in the Piwi log, which a failed take keeps.
  'piwi.trace.server': 'messages',
  // A modal question (Share live's) drawn in the window, where a gesture answers it and the take films it.
  'window.dialogStyle': 'custom',
  // The code and Piwi's marks, little else: no activity bar, menu bar, navigation arrows, breadcrumbs, sticky lines,
  // indent guides, lightbulb or panel labels, and Piwi's lenses on a failure alone.
  'workbench.activityBar.location': 'hidden',
  'window.menuBarVisibility': 'hidden',
  'workbench.navigationControl.enabled': false,
  'breadcrumbs.enabled': false,
  'editor.stickyScroll.enabled': false,
  'editor.guides.indentation': false,
  'editor.lightbulb.enabled': 'off',
  'workbench.panel.showLabels': false,
  'piwi.codeLens': 'problems',
  'piwi.coverageMarks': false,
  // The code's problems out of sight, still kept: no squiggle, no mark in the scrollbar, no color or count on a tab, and
  // no word of them in the status bar.
  'problems.decorations.enabled': false,
  // The count badges on the panel's views go too.
  'workbench.colorCustomizations': Object.fromEntries([
    ...['Error', 'Warning', 'Info'].flatMap((kind) => [
      [`editor${kind}.foreground`, '#00000000'],
      [`editor${kind}.border`, '#00000000'],
      [`editorOverviewRuler.${kind.toLowerCase()}Foreground`, '#00000000'],
    ]),
    ...['panelTitleBadge', 'activityBarBadge'].flatMap((badge) => [
      [`${badge}.background`, '#00000000'],
      [`${badge}.foreground`, '#00000000'],
    ]),
  ]),
};

/**
 * No notification shows as a toast but the one a beat answers, **Debug in my editor**'s question: the others still
 * reach the notification center, out of sight. A rule of the window's style, which no setting holds.
 */
const TOASTS_HIDDEN = `.notification-toast-container:not(:has([aria-label*="Debug this test here?"])) {
  display: none !important;
}`;

/** The status bar's entries hidden, Piwi's alone shown: the workbench's state, seeded as hiding them leaves it. */
const STORAGE = {
  'workbench.statusbar.hidden': [
    'status.host',
    'status.problems',
    'status.notifications',
    'status.runningTasks',
    'status.forwardedPorts',
    'status.progress',
    'status.editor.mode',
    'status.languageStatus',
    'status.editor.eol',
    'status.editor.encoding',
    'status.editor.indentation',
    'status.editor.selection',
    'chat.statusBarEntry',
  ],
};

/** The terminal a run opens, at most this tall (CSS pixels): its tabs and its last lines. */
const PANEL_HEIGHT = 110;

export class Editor {
  constructor(window, logDir) {
    this.app = window.app;
    this.page = window.page;
    this.codePath = window.codePath;
    this.userDataDir = window.userDataDir;
    this.window = window;
    this.logDir = logDir;
  }

  /** Raises the window over the others on the screen. */
  raise() {
    return this.app.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      win.moveTop();
      win.focus();
    });
  }

  /** Runs a command by its palette title. */
  command(title) {
    return command(this.page, title);
  }

  /** What VS Code's clipboard holds, read in its main process. */
  clipboard() {
    return this.app.evaluate(({ clipboard }) => clipboard.readText());
  }

  /** Puts `text` on the clipboard, as a person copies it from elsewhere. */
  copy(text) {
    return this.app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  }

  /**
   * Hands a `vscode://` link to the running window, as the system's handler of the scheme does: the VS Code command
   * line with the window's profile, which passes it to that window and exits.
   */
  openUrl(url) {
    return new Promise((resolve, reject) => {
      execFile(
        this.codePath,
        ['--no-sandbox', '--user-data-dir', this.userDataDir, '--open-url', url],
        { env: process.env, timeout: 60_000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }

  /** Copies the extension host's and the Piwi output's logs from the profile into `dir`. */
  keepLogs(dir) {
    const logs = path.join(this.userDataDir, 'logs');
    if (fs.existsSync(logs)) fs.cpSync(logs, path.join(dir, 'vscode-logs'), { recursive: true });
  }

  /**
   * Leaves the terminal panel a run opens at its tabs and last lines: opened once, the editor grown over it to
   * `PANEL_HEIGHT` at most, closed. The workbench keeps that height for each run's terminal.
   */
  async shrinkPanel() {
    const panel = this.page.locator('.part.panel');
    await this.command('View: Toggle Panel Visibility');
    await panel.waitFor();
    await this.page.locator('.editor-group-container.active').click();
    const height = () => panel.evaluate((el) => el.getBoundingClientRect().height);
    for (let step = 0; step < 10 && (await height()) > PANEL_HEIGHT; step++) {
      await this.command('Increase Editor Height');
    }
    await this.command('View: Toggle Panel Visibility');
    await panel.waitFor({ state: 'hidden' });
  }

  /** Hides every notification toast but the debug question (`TOASTS_HIDDEN`). */
  async hideToasts() {
    await this.page.addStyleTag({ content: TOASTS_HIDDEN });
  }

  async close() {
    await this.window.close();
  }
}

/** Packages the built extension into `dir` as the Marketplace's would be (`vsce package`), and gives its path. */
function packageExtension(dir) {
  const vsix = path.join(dir, 'piwi.vsix');
  execFileSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'vsce'), ['package', '--no-dependencies', '--out', vsix], {
    cwd: EXTENSION,
    stdio: 'ignore',
    timeout: 120_000,
  });
  return vsix;
}

/**
 * Opens `workspace` in VS Code at `tile` (CSS pixels), at device scale `scale`, with `env` for its runs: the built
 * extension packaged into `dir` and installed, as a person has it. When the window does not come up, the error carries
 * it as `error.editor`, still open, for the caller to close.
 */
export async function launchEditor({ workspace, env, tile, scale, dir }) {
  if (!fs.existsSync(path.join(EXTENSION, 'dist', 'extension.cjs'))) {
    throw new Error('The VS Code extension is not built: run `npm run vscode:build` in apps/vscode first.');
  }
  const vsix = packageExtension(dir);
  // Playwright's Electron launch closes the app on a signal, and exits on SIGINT: the showcase's own handlers keep
  // the screen and the logs first, then close the set, so Playwright's leave.
  const ours = Object.fromEntries(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
  const window = await launchVSCode({
    extensionPath: EXTENSION,
    workspace,
    env,
    scale,
    cachePath: VSCODE_CACHE,
    settings: SETTINGS,
    storage: STORAGE,
    vsix,
    keepOnFailure: true,
  })
    .catch((error) => {
      // A window that did not come up stays open for the take to keep its screen and logs, then close.
      if (error.window) error.editor = new Editor(error.window);
      throw error;
    })
    .finally(() => {
      for (const signal of SIGNALS) {
        for (const listener of process.listeners(signal)) {
          if (!ours[signal].includes(listener)) process.off(signal, listener);
        }
      }
    });
  await window.app.evaluate(({ BrowserWindow }, bounds) => {
    const [win] = BrowserWindow.getAllWindows();
    win.unmaximize();
    win.setBounds(bounds);
  }, tile);
  return new Editor(window);
}
