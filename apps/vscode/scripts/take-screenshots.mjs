#!/usr/bin/env node
// Captures the extension's illustrations for the docs site and the Marketplace README: VS Code, downloaded by
// @vscode/test-electron at the version `lib/vscode-window.mjs` pins, opens the fixture project of
// `lib/editor-fixture.mjs` with the built extension against the stub Piwi instance served from this process, and
// Playwright drives the window. On Linux without a display, run it
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
import { fileURLToPath } from 'node:url';
import {
  FAILING_LINE,
  PAGE_OBJECT_FILE,
  PROJECT,
  SPEC_FILE,
  UNCOVERED_ROUTE_EDIT,
  UNCOVERED_ROUTE_FILE,
  startStub,
  writeWorkspace,
} from './lib/editor-fixture.mjs';
import { writeAtWidth } from './lib/image.mjs';
import {
  clearNotifications,
  command,
  goToLine,
  launchVSCode,
  openFile,
  settle,
  showPanel,
} from './lib/vscode-window.mjs';

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

  /** The Testing view: the spec's tests with the latest run's results, and a failure's message at its line. */
  async testing(page) {
    await openFile(page, SPEC_FILE);
    await clearNotifications(page);
    await showPanel(page, false);
    await command(page, 'Testing: Focus on Test Explorer View');
    const tree = page.getByRole('tree', { name: 'Test Explorer' });
    for (const name of ['tests (Failed)', `${path.basename(SPEC_FILE)} (Failed)`, 'checkout (Failed)']) {
      const item = tree.getByRole('treeitem', { name });
      await item.waitFor({ timeout: 60_000 });
      await item.click();
      if ((await item.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('ArrowRight');
    }
    await tree.getByRole('treeitem', { name: 'pays by card (Failed)' }).click();
    await settle(page);
    await shoot(page, 'testing');
  },

  /** A server route no test reaches, changed since the default branch: its uncovered change, and why on hover. */
  async uncovered(page, workspace) {
    fs.writeFileSync(path.join(workspace, UNCOVERED_ROUTE_FILE), UNCOVERED_ROUTE_EDIT);
    // The hover below its line, so the marked lines above it stay in view.
    const settingsFile = path.join(workspace, '.vscode', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'editor.hover.above': false }, null, 2));
    await openFile(page, UNCOVERED_ROUTE_FILE);
    await clearNotifications(page);
    await showPanel(page, false);
    await command(page, 'View: Show Explorer');
    await page.locator('.monaco-editor .view-lines').first().click();
    await goToLine(page, 1);
    // A keyword: TypeScript says nothing about it, so the hover is Piwi's alone.
    const token = page
      .locator('.monaco-editor .view-line', { hasText: 'return' })
      .first()
      .locator('span', { hasText: /^return$/ })
      .first();
    const hover = page.locator('.monaco-hover:not(.hidden)').first();
    // The mark comes once the service has compared the file with the default branch.
    for (let tries = 0; ; tries++) {
      await token.hover();
      await hover.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      if (await hover.filter({ hasText: 'uncovered change' }).count()) break;
      if (tries > 20) throw new Error('no uncovered change in the hover');
      await page.mouse.move(10, 400);
      await settle(page, 1000);
    }
    await settle(page, 800);
    await shoot(page, 'uncovered');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  },
};

async function main() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-shots-')));
  const { workspace, commit } = writeWorkspace(parent);
  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'files.exclude': { '.vscode': true, 'package.json': true, node_modules: true } }, null, 2),
  );
  const { server, url } = await startStub(commit);
  let window;
  try {
    // The window is maximized to the X screen, which is sized for it.
    window = await launchVSCode({
      extensionPath,
      workspace,
      scale: SCALE,
      env: {
        PIWI_DASHBOARD_URL: url,
        PIWI_PROJECT_NAME: PROJECT.name,
        PIWI_DESKTOP_CONFIG: path.join(parent, 'no-desktop.json'),
      },
    });
    const { page } = window;
    await settle(page, 1500);
    const unknown = only.filter((name) => !(name in SCENES));
    if (unknown.length)
      throw new Error(`Unknown scene: ${unknown.join(', ')} (the scenes: ${Object.keys(SCENES).join(', ')})`);
    const names = Object.keys(SCENES).filter((name) => only.length === 0 || only.includes(name));
    for (const name of names) {
      try {
        await SCENES[name](page, workspace);
      } catch (error) {
        // The window as it stands says what the scene ran into.
        const failed = path.join(os.tmpdir(), `vscode-${name}-failed.png`);
        await page.screenshot({ path: failed }).catch(() => {});
        console.error(`the ${name} scene failed: the window as it stood is in ${failed}`);
        throw error;
      }
    }
  } finally {
    await window?.close();
    server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
