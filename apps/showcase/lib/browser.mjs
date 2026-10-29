// The developer's browser: Chromium with the built Piwi Picker in a profile of its own, the dashboard in its first
// window, the Runs window at its tile, and Piwi Picker paired with VS Code's Send to editor listener through its
// settings page. The test's browser, which the run the editor starts opens, is reached over its debugging port.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { REPO_ROOT } from './workspace.mjs';

const PICKER_DIST = path.join(REPO_ROOT, 'apps', 'extension', 'dist');

/**
 * The built extension, copied with the grant of the editor's address already held, which **Pair**'s click asks the
 * browser for (a prompt no script can answer): the settings page then finds it granted and pairs at once.
 */
function pickerWithGrant(dir, origin) {
  if (!fs.existsSync(path.join(PICKER_DIST, 'manifest.json'))) {
    throw new Error('Piwi Picker is not built: run `npm run extension:build` in apps/extension first.');
  }
  fs.cpSync(PICKER_DIST, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions ?? []), `${origin}/*`];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** The extension's service worker, once it has registered. */
async function extensionWorker(context) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const [worker] = context.serviceWorkers();
    if (worker) return worker;
    if (Date.now() > deadline) throw new Error("Piwi Picker's service worker never registered");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export class DeveloperBrowser {
  constructor(context, worker) {
    this.context = context;
    this.worker = worker;
    this.extensionId = worker.url().split('/')[2];
  }

  /** The page of an extension page's path. */
  url(page) {
    return `chrome-extension://${this.extensionId}/${page}`;
  }

  /** Pairs Piwi Picker with the editor through its settings page, as a person pastes the address there. */
  async pair(address) {
    const page = await this.context.newPage();
    try {
      await page.goto(this.url('options.html#editor-card'));
      await page.locator('html[data-ready]').waitFor({ state: 'attached' });
      await page.locator('#editor-address').fill(address);
      await page.locator('#editor-pair').click();
      await page.locator('#editor-pill', { hasText: 'Paired' }).waitFor({ timeout: 15_000 });
    } finally {
      await page.close();
    }
  }

  /**
   * Opens the Runs window from the toolbar popup's **Runs** tile, as a person does once, and places it at `tile`
   * (CSS pixels); resolves with its page once it follows the paired editor.
   */
  async openRuns(tile) {
    const popup = await this.context.newPage();
    try {
      // The popup shows its Runs tile once the paired editor's hub answers, as it opens: it is opened again, as a
      // person does, until the tile shows. The worker asks an editor that did not answer again after up to 30 s.
      const tile = popup.getByRole('button', { name: /Runs/ });
      for (const deadline = Date.now() + 90_000; ;) {
        await popup.goto(this.url('popup.html'));
        if (
          await tile.waitFor({ timeout: 5_000 }).then(
            () => true,
            () => false,
          )
        )
          break;
        if (Date.now() > deadline) {
          const summary = await popup
            .evaluate(() => chrome.runtime.sendMessage({ type: 'piwi-runs-summary' }))
            .catch((why) => why.message);
          throw new Error(`Piwi Picker’s popup never showed its Runs tile; its worker says ${JSON.stringify(summary)}`);
        }
      }
      const opened = this.context.waitForEvent('page', (page) => page.url().endsWith('/runs.html'));
      // A click that fails throws here; the wait it leaves must not end the process when it times out after.
      opened.catch(() => {});
      await tile.click({ timeout: 30_000 });
      this.runs = await opened;
    } finally {
      await popup.close();
    }
    await this.runs.locator('html[data-ready]').waitFor({ state: 'attached' });
    await this.worker.evaluate(
      async (bounds) => {
        const windows = await chrome.windows.getAll({ populate: true });
        const runs = windows.find((w) => w.tabs?.some((t) => t.url?.endsWith('/runs.html')));
        if (runs?.id !== undefined) await chrome.windows.update(runs.id, { ...bounds, state: 'normal' });
      },
      { left: tile.x, top: tile.y, width: tile.width, height: tile.height },
    );
    await this.runs.getByText(/Following 1 editor window/).waitFor({ timeout: 30_000 });
    return this.runs;
  }

  /**
   * Zooms the tab of the browser's first window (the dashboard's) to `factor`, as a person does with Ctrl and +: the
   * zoom holds for every page of its origin, the Runs window's pages left as they are.
   */
  async zoomDashboard(factor) {
    await this.worker.evaluate(async (zoom) => {
      const [tab] = await chrome.tabs.query({ windowType: 'normal' });
      await chrome.tabs.setZoom(tab.id, zoom);
    }, factor);
  }

  async close() {
    await this.context.close().catch(() => {});
  }
}

/**
 * Launches the developer's browser on a profile under `dir`, Piwi Picker granted `editorOrigin`, its first window over
 * the whole screen (`screen`, CSS pixels) at device scale `scale`; what its pages and Piwi Picker's worker log goes to
 * `log`.
 */
export async function launchDeveloperBrowser({ dir, editorOrigin, screen, scale, log }) {
  const extension = pickerWithGrant(path.join(dir, 'piwi-picker'), editorOrigin);
  const profile = path.join(dir, 'profile');
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: null,
    // The developer works in the dark: the dashboard and Piwi Picker's pages follow the system's scheme.
    colorScheme: 'dark',
    // A signal stops the take through `showcase.mjs`'s handlers, which keep the screen before the browser closes.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--window-position=0,0',
      `--window-size=${screen.width},${screen.height}`,
      `--force-device-scale-factor=${scale}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const worker = await extensionWorker(context);
  // What Piwi Picker's worker and pages say, for the log a failure keeps.
  const write = (where, message) =>
    fs.appendFileSync(log, `${new Date().toISOString()} ${where} ${message.type()}: ${message.text()}\n`);
  worker.on('console', (message) => write('worker', message));
  context.on('page', (page) => page.on('console', (message) => write(page.url(), message)));
  return new DeveloperBrowser(context, worker);
}

/**
 * The test's browser, which a headed run opens with a debugging port (the checkout's Playwright config): attached
 * over that port, its page the test's, for gestures a person makes in it. Waits up to `ms` for the browser.
 */
export async function attachTestBrowser(port, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
      const page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => !p.url().startsWith('about:'));
      if (page) return { browser, page };
      await browser.close();
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`the test's browser never listened on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
