// The developer's editor: VS Code, as `@vscode/test-electron` downloads it, with the built Piwi extension, opened on
// the shop's checkout and placed at its tile. Driven through the workbench's DOM as the extension's nightly suite
// drives it (`apps/vscode/scripts/lib/vscode-window.mjs`), and read through the files on disk.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { command, launchVSCode } from '../../vscode/scripts/lib/vscode-window.mjs';
import { REPO_ROOT } from './workspace.mjs';

const EXTENSION = path.join(REPO_ROOT, 'apps', 'vscode');

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
};

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

  async close() {
    await this.window.close();
  }
}

/** Opens `workspace` in VS Code at `tile` (CSS pixels), at device scale `scale`, with `env` for its runs. */
export async function launchEditor({ workspace, env, tile, scale }) {
  if (!fs.existsSync(path.join(EXTENSION, 'dist', 'extension.cjs'))) {
    throw new Error('The VS Code extension is not built: run `npm run vscode:build` in apps/vscode first.');
  }
  const window = await launchVSCode({
    extensionPath: EXTENSION,
    workspace,
    env,
    scale,
    cachePath: VSCODE_CACHE,
    settings: SETTINGS,
  });
  await window.app.evaluate(({ BrowserWindow }, bounds) => {
    const [win] = BrowserWindow.getAllWindows();
    win.unmaximize();
    win.setBounds(bounds);
  }, tile);
  return new Editor(window);
}
