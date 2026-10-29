// The set (the order it is built in, and its layout): the team's instance with its history and the shop's two "CI"
// runs, the shop's repository and the developer's checkout, VS Code on it, the developer's browser with Piwi Picker
// paired and its Runs window, and the dashboard in the browser's first window. Everything is rebuilt for each take.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachTestBrowser, launchDeveloperBrowser } from './browser.mjs';
import { launchEditor } from './editor.mjs';
import { startCiRun, startInstance } from './instance.mjs';
import { SHOP_PORT, buildWorkspace } from './workspace.mjs';

/** The variable that names the folder of the editors' discovery files (`@piwitests/core/editor-discovery`). */
const EDITORS_DIR_ENV = 'PIWI_EDITORS_DIR';

/** The scale every app renders at, on a screen of 3840 × 2160 device pixels. */
export const SCALE = 2;

/**
 * Each window's tile, in CSS pixels (device pixels over `SCALE`), side by side without overlap; the dashboard's window
 * covers the screen, raised for the beats that are about it.
 */
export const TILES = {
  vscode: { x: 0, y: 0, width: 1080, height: 720 },
  testBrowser: { x: 1080, y: 0, width: 800, height: 540 },
  runs: { x: 1080, y: 540, width: 800, height: 500 },
  dashboard: { x: 0, y: 0, width: 1920, height: 1080 },
};

/** The test's browser's debugging port, which the checkout's config gives a headed run. */
export const TEST_BROWSER_CDP = 9334;

/** Whether something listens on `port` on this machine. */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Ends every process of the set still running: those working in `dir` (a run the editor started and left stopped,
 * its shop server, its browser) and those whose environment names it, as every process the set starts inherits its
 * `TMPDIR` (the dev server's, still flushing its caches there as it exits), as Linux's `/proc` tells them. Each has two
 * seconds to end on SIGTERM before SIGKILL.
 */
async function endStrays(dir) {
  const inside = (file) => file === dir || file.startsWith(`${dir}/`);
  const strays = () =>
    fs.readdirSync('/proc').filter((pid) => {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
      try {
        if (inside(fs.readlinkSync(`/proc/${pid}/cwd`))) return true;
        const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        return environ.some((entry) => inside(entry.slice(entry.indexOf('=') + 1)));
      } catch {
        return false;
      }
    });
  const signal = (name) => {
    for (const pid of strays()) {
      try {
        process.kill(Number(pid), name);
      } catch {
        // Gone already.
      }
    }
  };
  signal('SIGTERM');
  for (let waited = 0; waited < 2_000 && strays().length; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signal('SIGKILL');
}

/**
 * The dashboard's links to the editor reach VS Code as the system's handler of `vscode://` would take them: the page
 * hands such a link to a hidden frame (or an anchor), which this script takes before the browser loads it and passes
 * to VS Code's command line. The browser never sees the link, so no handler of the machine's opens it, and a bare X
 * server has none.
 */
const HAND_OVER_EDITOR_LINKS = `(() => {
  const isEditorLink = (url) => typeof url === 'string' && /^vscode:/i.test(url.trim());
  const handOver = (url) => window.__showcaseOpenInEditor(url.trim());
  const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    ...src,
    set(value) {
      if (isEditorLink(String(value))) handOver(String(value));
      else src.set.call(this, value);
    },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === 'src' && isEditorLink(String(value))) {
      handOver(String(value));
      return;
    }
    return setAttribute.call(this, name, value);
  };
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (anchor && isEditorLink(anchor.getAttribute('href'))) {
      event.preventDefault();
      handOver(anchor.getAttribute('href'));
    }
  }, true);
})();`;

/** The visitor's Open in IDE choice, made once in the dashboard's settings: VS Code with the Piwi extension. */
const IDE_PREFS = { method: 'vscode', vscodeScheme: 'vscode', vscodeExtension: true };

/**
 * The set's folder, new in the temporary directory (short, as VS Code's and the editor service's sockets need), and
 * `close`, which ends every app and process of the set, then removes the folder unless `keep`. Every app the set
 * starts has its temporary files there (`TMPDIR`), and its own editors' discovery folder and desktop app's file, so a
 * developer's own editors and desktop app neither show in the Runs window nor follow the set's runs, and the set's
 * reach none of theirs.
 */
export function createSet({ logs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-showcase-'));
  const own = {
    TMPDIR: path.join(dir, 'tmp'),
    [EDITORS_DIR_ENV]: path.join(dir, 'piwi', 'editors'),
    PIWI_DESKTOP_CONFIG: path.join(dir, 'piwi', 'desktop.json'),
  };
  const before = Object.fromEntries(Object.keys(own).map((name) => [name, process.env[name]]));
  fs.mkdirSync(own.TMPDIR);
  fs.mkdirSync(own[EDITORS_DIR_ENV], { recursive: true, mode: 0o700 });
  Object.assign(process.env, own);
  const set = { dir, logs, editorsDir: own[EDITORS_DIR_ENV], closers: [] };
  let closing = null;
  set.close = ({ keep = false } = {}) =>
    (closing ??= (async () => {
      for (const closer of set.closers.reverse()) await closer().catch(() => {});
      await endStrays(dir);
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (!keep) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    })());
  return set;
}

/** Builds in `set` (`createSet`) what the beats act on; `say` hears each step. A failure leaves the set to close. */
export async function buildSet(set, { say }) {
  const { dir, logs } = set;
  for (const port of [SHOP_PORT, TEST_BROWSER_CDP]) {
    if (await listening(port)) throw new Error(`port ${port} is taken: the set needs it free`);
  }
  say('the instance: a fresh database with the demo history');
  set.instance = await startInstance(path.join(dir, 'instance'), { logFile: path.join(logs, 'dashboard.log') });
  set.closers.push(async () => set.instance.stop());
  const repo = buildWorkspace(path.join(dir, 'repo'), {
    instanceUrl: set.instance.base,
    testBrowser: {
      position: { x: TILES.testBrowser.x, y: TILES.testBrowser.y },
      size: { width: TILES.testBrowser.width, height: TILES.testBrowser.height },
      scale: SCALE,
      cdpPort: TEST_BROWSER_CDP,
    },
  });
  set.repo = repo;
  set.projectId = await set.instance.createProject();
  say('the "CI" runs: the shop as it shipped (green), then the redesign (red)');
  set.ciDir = path.join(dir, 'ci');
  set.reports = { shipped: path.join(logs, 'ci-shipped.json') };
  const ci = (commit, name, extraEnv) =>
    startCiRun({
      origin: repo.origin,
      dir: set.ciDir,
      commit,
      instance: set.instance,
      log: path.join(logs, `${name}.log`),
      extraEnv,
    });
  set.ci = ci;
  const shipped = await ci(repo.shipped, 'ci-shipped');
  if (shipped !== 0) throw new Error(`the shipped commit's CI run failed (exit ${shipped}): see ci-shipped.log`);
  const redesigned = await ci(repo.redesigned, 'ci-redesign');
  if (redesigned !== 1) throw new Error(`the redesign's CI run did not fail (exit ${redesigned}): see ci-redesign.log`);

  say('VS Code with the built extension, on the developer’s checkout');
  set.closers.push(async () => set.editor?.close());
  set.editor = await launchEditor({
    workspace: repo.shop,
    env: { SAMPLE_BACKEND: 'nitro' },
    tile: TILES.vscode,
    scale: SCALE,
  }).catch((error) => {
    // A window that did not come up is kept for its screen and logs, and closes with the set.
    set.editor = error.editor;
    throw error;
  });
  await set.editor.command('Piwi: Pair with Piwi Picker');
  const pairing = await set.editor.clipboard();
  // The editor service tells its address in the set's discovery folder, never the developer's.
  for (let waited = 0; !fs.readdirSync(set.editorsDir).some((name) => name.endsWith('.json')); waited += 250) {
    if (waited > 30_000) throw new Error(`the editor service wrote no discovery file in ${set.editorsDir}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await set.editor.command('Notifications: Clear All Notifications');

  say('the developer’s browser with Piwi Picker, paired');
  set.browser = await launchDeveloperBrowser({
    dir: path.join(dir, 'browser'),
    editorOrigin: new URL(pairing).origin,
    screen: { width: TILES.dashboard.width, height: TILES.dashboard.height },
    scale: SCALE,
    log: path.join(logs, 'piwi-picker.log'),
  });
  set.closers.push(() => set.browser.close());
  await set.browser.pair(pairing);
  set.runs = await set.browser.openRuns(TILES.runs);

  const { context } = set.browser;
  set.editorLinks = [];
  await context.exposeBinding('__showcaseOpenInEditor', (_source, url) => {
    set.editorLinks.push(url);
    return set.editor.openUrl(url);
  });
  await context.addInitScript(HAND_OVER_EDITOR_LINKS);
  await context.addInitScript(
    (prefs) =>
      localStorage.setItem(
        'piwi-ide-prefs',
        JSON.stringify({ ...JSON.parse(localStorage.getItem('piwi-ide-prefs') ?? '{}'), ...prefs }),
      ),
    IDE_PREFS,
  );
  set.dashboard = context.pages().find((page) => page.url() === 'about:blank') ?? (await context.newPage());
  await set.dashboard.goto(`${set.instance.base}/projects/${set.projectId}`, { waitUntil: 'domcontentloaded' });

  // The test's browser of the run going on: each run opens its own, on the same port.
  set.testBrowser = async () => {
    if (!set.attached?.browser.isConnected() || set.attached.page.isClosed()) {
      set.attached = await attachTestBrowser(TEST_BROWSER_CDP);
    }
    return set.attached.page;
  };
  set.closers.push(async () => set.attached?.browser.close());
  return set;
}
