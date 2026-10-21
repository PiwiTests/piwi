#!/usr/bin/env node
// Captures the extension's illustrations for the docs site and the Marketplace README: VS Code, downloaded by
// @vscode/test-electron, opens the fixture project of `lib/editor-fixture.mjs` with the built extension against the
// stub Piwi instance served from this process, and Playwright drives the window. On Linux without a display, run it
// through Xvfb at twice the window size, so the images are rendered at 2×:
//
//   npm run vscode:build
//   xvfb-run -a -s "-screen 0 2880x1800x24" node scripts/take-screenshots.mjs [--out <dir>] [--scene <name>…]
//
// Every image is a 1440 × 900 window, written at that width to apps/docs/public/screenshots/vscode-<scene>.png; the
// harness in apps/application/scripts/take-feature-screenshots.mjs lists them as external so `--check` leaves them alone.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import {
  FAILING_LINE,
  PAGE_OBJECT_FILE,
  PROJECT,
  SPEC_FILE,
  startStub,
  writeWorkspace,
} from './lib/editor-fixture.mjs';
import { writeAtWidth } from './lib/image.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '..');
const repoRoot = path.resolve(extensionPath, '..', '..');
const DEFAULT_OUT = path.join(repoRoot, 'apps', 'docs', 'public', 'screenshots');
const WINDOW = { width: 1440, height: 900 };
const SCALE = 2;

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : DEFAULT_OUT;
const only = args.filter((a, i) => args[i - 1] === '--scene');

if (!fs.existsSync(path.join(extensionPath, 'dist', 'extension.cjs'))) {
  console.error('The extension is not built: run `npm run vscode:build` first.');
  process.exit(1);
}

function writeUserData() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-user-'));
  const settings = {
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
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return userDataDir;
}

/** Runs a command by its palette title: the first row whose label starts with it. */
async function command(page, title) {
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
async function openFile(page, file) {
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
async function goToLine(page, line, column = 1) {
  await page.keyboard.press('Control+G');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' });
  await input.fill(`:${line}:${column}`);
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.locator('.quick-input-widget').waitFor({ state: 'hidden' });
}

async function settle(page, ms = 600) {
  await page.waitForTimeout(ms);
}

/** The bottom panel, hidden or shown. */
async function showPanel(page, shown) {
  const panel = page.locator('.part.panel');
  if ((await panel.isVisible().catch(() => false)) !== shown) await page.keyboard.press('Control+J');
}

/** Hides the secondary side bar when it is open, as it is in a new profile. */
async function closeSecondarySideBar(page) {
  const bar = page.locator('.part.auxiliarybar');
  if (await bar.isVisible().catch(() => false)) await command(page, 'View: Toggle Secondary Side Bar Visibility');
}

/** Closes the notification toasts, before a scene opens a menu or a hover. */
async function clearNotifications(page) {
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

/** The title as a user of the published extension sees it: without the extension host's and the root user's labels. */
async function plainTitle(page) {
  await page.evaluate(() => {
    for (const title of document.querySelectorAll('.window-title')) {
      title.textContent = title.textContent
        .replace(/\[Extension Development Host\]\s*/, '')
        .replace(/\s*\[Superuser\]/, '');
    }
  });
}

async function shoot(page, name) {
  await plainTitle(page);
  await settle(page, 300);
  const image = await page.screenshot();
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `vscode-${name}.png`);
  await writeAtWidth(image, WINDOW.width, file);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

const SCENES = {
  /** The page object: the CI failure at its line, its quick fixes open, the Problems panel below. */
  async heal(page) {
    await openFile(page, PAGE_OBJECT_FILE);
    await clearNotifications(page);
    await command(page, 'View: Focus Problems');
    await page.locator('.markers-panel .monaco-list-row').first().waitFor({ timeout: 60_000 });
    await page.locator('.monaco-editor .view-lines').first().click();
    await goToLine(page, FAILING_LINE, 5);
    await settle(page, 800);
    await page.keyboard.press('Control+.');
    await page.locator('.action-widget', { hasText: 'Heal: use' }).first().waitFor({ state: 'visible' });
    await settle(page);
    await shoot(page, 'heal');
    await page.keyboard.press('Escape');
  },

  /** The spec with its tests' results, and the Failures view with the run's failures and the local run since. */
  async failures(page) {
    await openFile(page, SPEC_FILE);
    await clearNotifications(page);
    await command(page, 'Piwi: Focus on Failures View');
    await page.locator('.pane-body .monaco-list-row').first().waitFor({ timeout: 60_000 });
    await settle(page, 1200);
    await page.locator('.monaco-editor .view-lines').first().click();
    await goToLine(page, 1);
    await settle(page);
    await shoot(page, 'failures');
  },

  /** The hover on the failing line: the error, its call chain and the failure screenshot. */
  async hover(page) {
    await openFile(page, PAGE_OBJECT_FILE);
    await clearNotifications(page);
    await showPanel(page, false);
    await page.locator('.monaco-editor .view-lines').first().click();
    await goToLine(page, FAILING_LINE);
    await settle(page);
    const token = page
      .locator('.monaco-editor .view-line', { hasText: 'btn-primary' })
      .first()
      .locator('span', { hasText: 'btn-primary' })
      .first();
    const hover = page.locator('.monaco-hover:not(.hidden)').first();
    // The first hover starts the screenshot's download; the second shows it.
    await token.hover();
    await hover.waitFor({ state: 'visible', timeout: 10_000 });
    await settle(page, 2500);
    await page.mouse.move(10, 400);
    await hover.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    await token.hover();
    await hover.waitFor({ state: 'visible', timeout: 10_000 });
    await hover
      .locator('img')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await settle(page, 1500);
    await shoot(page, 'hover');
  },
};

async function main() {
  const codePath = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-shots-')));
  const { workspace, commit } = writeWorkspace(parent);
  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'files.exclude': { '.vscode': true, 'package.json': true, node_modules: true } }, null, 2),
  );
  const userDataDir = writeUserData();
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-ext-'));
  const { server, url } = await startStub(commit);
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
        `--force-device-scale-factor=${SCALE}`,
        workspace,
      ],
      env: {
        ...process.env,
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: PROJECT.name,
        PIWI_DESKTOP_CONFIG: path.join(parent, 'no-desktop.json'),
      },
      timeout: 120_000,
    });
    const page = await app.firstWindow();
    await page.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
    // The window is maximized to the X screen, which is sized for it.
    await page.locator('.statusbar-item', { hasText: 'Piwi:' }).waitFor({ timeout: 120_000 });
    await closeSecondarySideBar(page);
    await settle(page, 1500);
    const names = Object.keys(SCENES).filter((name) => only.length === 0 || only.includes(name));
    for (const name of names) {
      try {
        await SCENES[name](page);
      } catch (error) {
        // The window as it stands says what the scene ran into.
        fs.mkdirSync(outDir, { recursive: true });
        await page.screenshot({ path: path.join(outDir, `vscode-${name}-failed.png`) }).catch(() => {});
        throw error;
      }
    }
  } finally {
    await app?.close().catch(() => {});
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
