// A real VS Code window with the built extension, driven by Playwright's Electron support: the launcher and the
// window helpers the screenshot script (`take-screenshots.mjs`) and the nightly suite (`tests/e2e/`) share. VS Code
// is the one `@vscode/test-electron` downloads into `.vscode-test/`, at `VSCODE_VERSION` unless `VSCODE_TEST_VERSION`
// names another: the workbench's DOM (class names, the quick input's rows) moves between versions, so the version is
// moved on purpose. On Linux without a display, run under Xvfb.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');

/** The VS Code release the window opens, until `VSCODE_TEST_VERSION` names another (`stable`, `insiders`, `1.x.y`). */
export const VSCODE_VERSION = '1.143.1';

/** The user settings of the window: quiet, no telemetry, no updates, no AI features, CodeLens on. */
const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.statusBar.visible': true,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.commandCenter': true,
  'window.title': '${activeEditorShort}${separator}${rootName}',
  'window.newWindowDimensions': 'maximized',
  'window.titleBarStyle': 'custom',
  'window.zoomLevel': 0,
  'editor.fontFamily': "'JetBrains Mono', monospace",
  'editor.fontSize': 14,
  'editor.lineHeight': 22,
  'editor.minimap.enabled': false,
  'editor.codeLens': true,
  'editor.renderWhitespace': 'none',
  'editor.scrollBeyondLastLine': false,
  'editor.cursorBlinking': 'solid',
  'editor.lightbulb.enabled': 'onCode',
  'extensions.ignoreRecommendations': true,
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'security.workspace.trust.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'git.enabled': false,
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'terminal.integrated.showExitAlert': false,
  'typescript.tsserver.log': 'off',
};

/**
 * Opens `workspace` in VS Code with the extension at `extensionPath` under development, a fresh profile and no other
 * extension, with `env` over this process's environment; waits until the workbench shows Piwi's status bar item.
 * `close` closes the window and deletes the profile.
 */
export async function launchVSCode({ extensionPath, workspace, env = {}, scale = 1 }) {
  const codePath = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || VSCODE_VERSION);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-user-'));
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-ext-'));
  const removeProfile = () => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
  };
  let app;
  try {
    app = await electron.launch({
      executablePath: codePath,
      args: [
        `--extensionDevelopmentPath=${extensionPath}`,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-updates',
        '--no-sandbox',
        '--disable-gpu',
        `--force-device-scale-factor=${scale}`,
        workspace,
      ],
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
    await page.locator('.statusbar-item', { hasText: 'Piwi:' }).waitFor({ timeout: 120_000 });
    await closeSecondarySideBar(page);
    return {
      app,
      page,
      close: async () => {
        await app.close().catch(() => {});
        removeProfile();
      },
    };
  } catch (error) {
    await app?.close().catch(() => {});
    removeProfile();
    throw error;
  }
}

/** Runs a command by its palette title: the first row whose label starts with it. */
export async function command(page, title) {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  await input.fill(`>${title}`);
  const row = page
    .locator('.quick-input-list .monaco-list-row')
    .filter({
      has: page.locator('.label-name', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }),
    })
    .first();
  await row.waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  await row.click();
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
}

/** Opens a workspace file by its path. */
export async function openFile(page, file) {
  await page.keyboard.press('Control+P');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  await input.fill(file);
  await page.locator('.quick-input-list .monaco-list-row').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
  await page.locator('.monaco-editor .view-lines').first().waitFor();
}

/** Puts the cursor at `line`, and at `column` on it. */
export async function goToLine(page, line, column = 1) {
  await page.keyboard.press('Control+G');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  await input.fill(`:${line}:${column}`);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
}

export async function settle(page, ms = 600) {
  await page.waitForTimeout(ms);
}

/** The bottom panel, hidden or shown. */
export async function showPanel(page, shown) {
  const panel = page.locator('.part.panel');
  if ((await panel.isVisible().catch(() => false)) !== shown) await page.keyboard.press('Control+J');
}

/** Hides the secondary side bar when it is open, as it is in a new profile. */
export async function closeSecondarySideBar(page) {
  const bar = page.locator('.part.auxiliarybar');
  if (await bar.isVisible().catch(() => false)) await command(page, 'View: Toggle Secondary Side Bar Visibility');
}

/** Closes the notification toasts, before a step opens a menu or a hover. */
export async function clearNotifications(page) {
  if (
    await page
      .locator('.notification-toast')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await command(page, 'Notifications: Clear All Notifications');
  }
}
