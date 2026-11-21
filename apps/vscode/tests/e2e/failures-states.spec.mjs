// The failures view in a real VS Code, in four states without a failure to list: a run with no failure and no run yet,
// served by the stub of `scripts/lib/editor-fixture.mjs`, an instance that does not answer, and none named. Each opens
// a window of its own on the fixture project. What the view shows on screen is held to the sentence and links of
// `packages/editor/tests/golden/failures-view.json`, which the JetBrains plugin's Failures tab is held to too.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PROJECT, startStub, writeWorkspace } from '../../scripts/lib/editor-fixture.mjs';
import { clearNotifications, command, launchVSCode } from '../../scripts/lib/vscode-window.mjs';

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const golden = JSON.parse(
  fs.readFileSync(
    path.resolve(extensionPath, '..', '..', 'packages', 'editor', 'tests', 'golden', 'failures-view.json'),
  ),
);

/** What both editors show for the golden case `name`. */
function shown(name) {
  const found = golden.cases.find((c) => c.name === name);
  if (!found) throw new Error(`No golden case named "${name}"`);
  return found.shown;
}

let parent;
/** The window of the test in progress, and the servers it reads. */
let window;
const servers = [];

test.beforeAll(() => {
  if (!fs.existsSync(path.join(extensionPath, 'dist', 'extension.cjs'))) {
    throw new Error('The extension is not built: run `npm run vscode:build` first.');
  }
  parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-states-')));
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && window) {
    await testInfo.attach('window', { body: await window.page.screenshot(), contentType: 'image/png' });
  }
  await window?.close();
  window = undefined;
  for (const server of servers.splice(0)) server.close();
});

test.afterAll(() => {
  if (parent) fs.rmSync(parent, { recursive: true, force: true });
});

/** A new copy of the fixture project, in a folder of its own. */
function fixtureIn(name) {
  const folder = path.join(parent, name);
  fs.mkdirSync(folder);
  return { folder, ...writeWorkspace(folder) };
}

/**
 * A window on the fixture with the failures view in sight, the instance at `url`, or none named: the variables blank,
 * so the shell's own never reach it.
 */
async function launch({ workspace, folder, url }) {
  window = await launchVSCode({
    extensionPath,
    workspace,
    env: {
      PIWI_DASHBOARD_URL: url ?? '',
      PIWI_PROJECT_NAME: url ? PROJECT.name : '',
      PIWI_DESKTOP_CONFIG: path.join(folder, 'no-desktop.json'),
    },
  });
  await clearNotifications(window.page);
  await command(window.page, 'Piwi: Focus on Failures View');
  return window.page;
}

/** The Failures pane of the Piwi panel, by its heading. */
const failuresPane = (page) =>
  page.locator('.pane').filter({ has: page.getByRole('heading', { name: 'Failures', exact: true }) });

/** The view's sentence above its tree, and the tree's items: each a link the state names. */
async function expectSentenceAndLinks(page, text, links) {
  const pane = failuresPane(page);
  await expect(typeof text === 'string' ? pane.getByText(text, { exact: true }) : pane.getByText(text)).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Failures', exact: true }).getByRole('treeitem')).toHaveText(links);
}

test('a run with no failure says so, with Refresh the latest run', async () => {
  const fixture = fixtureIn('clear');
  const stub = await startStub(fixture.commit, { latest: 'clear' });
  servers.push(stub.server);
  const page = await launch({ ...fixture, url: stub.url });
  const { text, links } = shown('no failure in the run read');
  await expectSentenceAndLinks(page, text, links);
});

test('a project with no run yet says so, with Compare with… and Get started', async () => {
  const fixture = fixtureIn('norun');
  const stub = await startStub(fixture.commit, { latest: 'none' });
  servers.push(stub.server);
  const page = await launch({ ...fixture, url: stub.url });
  const { text, links } = shown('no run of the project yet');
  await expectSentenceAndLinks(page, text, links);
});

test('an instance that does not answer is named, with Retry and Open settings', async () => {
  const fixture = fixtureIn('unreachable');
  // A port held for the test, closing every connection at once: nothing answers there, and nothing else takes it.
  const silent = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  servers.push(silent);
  const url = `http://127.0.0.1:${silent.address().port}`;
  const page = await launch({ ...fixture, url });
  // The golden case names another address; the sentence around it and the links are the same.
  const { links } = shown('the instance does not answer');
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expectSentenceAndLinks(
    page,
    new RegExp(`^Could not reach ${escaped}: .+ Piwi tries again on its own\\.$`),
    links,
  );
});

test('no instance named shows the welcome, with Connect… and Record a new test file…', async () => {
  const fixture = fixtureIn('disconnected');
  const page = await launch(fixture);
  const { text, links } = shown('no connection');
  const pane = failuresPane(page);
  await expect(pane.getByText(text, { exact: true })).toBeVisible();
  // The welcome's buttons: the workbench gives its content no role of its own.
  await expect(pane.locator('.welcome-view-content').getByRole('button')).toHaveText(links);
});
