// What the extension draws in a real VS Code: the fixture project of `scripts/lib/editor-fixture.mjs` (a shop's suite
// whose latest CI run failed twice, with a local run since) against its stub instance, in the window
// `scripts/lib/vscode-window.mjs` opens, asserted on the workbench's DOM. The in-process suites check the answers;
// this one checks that they reach the screen.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  FAILING_LINE,
  PAGE_OBJECT_FILE,
  PROJECT,
  RECOMMENDED,
  SPEC_FILE,
  startStub,
  writeWorkspace,
} from '../../scripts/lib/editor-fixture.mjs';
import {
  clearNotifications,
  command,
  goToLine,
  launchVSCode,
  openFile,
  settle,
  showPanel,
} from '../../scripts/lib/vscode-window.mjs';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test.describe.configure({ mode: 'serial' });

/** The window, the stub instance and the fixture's folder, for the whole suite. */
let window;
let stub;
let parent;
/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(extensionPath, 'dist', 'extension.cjs'))) {
    throw new Error('The extension is not built: run `npm run vscode:build` first.');
  }
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-e2e-')));
  const { workspace, commit } = writeWorkspace(parent);
  stub = await startStub(commit);
  window = await launchVSCode({
    extensionPath,
    workspace,
    env: {
      PIWI_DASHBOARD_URL: stub.url,
      PIWI_PROJECT_NAME: PROJECT.name,
      PIWI_DESKTOP_CONFIG: path.join(parent, 'no-desktop.json'),
    },
  });
  page = window.page;
});

test.afterAll(async () => {
  await window?.close();
  stub?.server.close();
  if (parent) fs.rmSync(parent, { recursive: true, force: true });
});

test.afterEach(async ({}, testInfo) => {
  // The window as it stood when a test failed, for the report.
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('window', { body: await page.screenshot(), contentType: 'image/png' });
  }
  await page?.keyboard.press('Escape');
});

test('the status bar item counts what still fails and what the local run fixed', async () => {
  const item = page.locator('.statusbar-item', { hasText: 'Piwi:' }).first();
  await expect(item).toHaveText(/2 failing/);
  await expect(item).toHaveText(/1 fixed/);
});

test('the Problems panel lists the run’s two failures at their lines, with their reasons', async () => {
  await clearNotifications(page);
  await command(page, 'View: Focus Problems');
  const rows = page.locator('.markers-panel .monaco-list-row');
  await expect(
    rows.filter({ hasText: "locator('.btn-primary').nth(1) was not found (pays by card, run #124)" }),
  ).toHaveCount(1);
  await expect(rows.filter({ hasText: `[Ln ${FAILING_LINE}, Col 5]` })).toHaveCount(1);
  await expect(
    rows.filter({ hasText: 'toHaveText: expected "10.80 €", received "12.00 €" (applies a coupon, run #124)' }),
  ).toHaveCount(1);
});

test('the quick fixes on the failing line offer the recommended locator first', async () => {
  await openFile(page, PAGE_OBJECT_FILE);
  await page.locator('.monaco-editor .view-lines').first().click();
  await goToLine(page, FAILING_LINE, 5);
  await settle(page, 800);
  await page.keyboard.press('Control+.');
  // The menu's rows, its group headers left out.
  const fixes = page.locator('.action-widget .monaco-list-row:not(.group-header)');
  await expect(fixes.first()).toContainText(`Heal: use ${RECOMMENDED}`);
  await page.keyboard.press('Escape');
});

test('the hover on the failing locator names the failing test and the run', async () => {
  await openFile(page, PAGE_OBJECT_FILE);
  await showPanel(page, false);
  const token = page
    .locator('.monaco-editor .view-line', { hasText: 'btn-primary' })
    .first()
    .locator('span', { hasText: 'btn-primary' })
    .first();
  await token.hover();
  const hover = page.locator('.monaco-hover:not(.hidden)').first();
  await expect(hover).toContainText('CI failure');
  await expect(hover).toContainText('pays by card');
  await expect(hover).toContainText('run #124');
  await page.mouse.move(10, 400);
});

test('CodeLens above the locators names the tests behind them', async () => {
  await openFile(page, PAGE_OBJECT_FILE);
  const lenses = page.locator('.monaco-editor .codelens-decoration');
  await expect(lenses.filter({ hasText: /\d+ tests? ·/ }).first()).toBeVisible();
});

test('the failures view holds the run, the local run since, and the failures', async () => {
  await clearNotifications(page);
  await command(page, 'Piwi: Focus on Failures View');
  const rows = page.locator('.pane-body .monaco-list-row');
  await expect(rows.filter({ hasText: '#124' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'pays by card' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'applies a coupon' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'removes a row' }).first()).toBeVisible();
});

test('the Testing view lists the spec’s tests with the run’s results', async () => {
  await command(page, 'Testing: Focus on Test Explorer View');
  const tree = page.getByRole('tree', { name: 'Test Explorer' });
  /** Expands a node of the tree: selected, then opened with the arrow key. */
  const expand = async (name) => {
    const item = tree.getByRole('treeitem', { name });
    await expect(item).toBeVisible();
    await item.click();
    if ((await item.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('ArrowRight');
  };
  await expand('tests (Failed)');
  await expand(`${path.basename(SPEC_FILE)} (Failed)`);
  // The spec's describe block, then its tests.
  await expand('checkout (Failed)');
  await expect(tree.getByRole('treeitem', { name: 'pays by card (Failed)' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'removes a row (Passed)' })).toBeVisible();
});
