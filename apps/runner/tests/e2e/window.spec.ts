import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Piwi Runner's window in another language than English, at its smallest size: the language the shell answers reaches
 * the page (`lang`), Runner's own words, the layer's (a run request's confirmation and its checks, by their codes), the
 * run model's (a stopped worker) and Nuxt UI's (a close button), and no text is cut. The shell's bridge
 * (`window.__TAURI__`) and the host's streams are played by the spec; what each says comes from the catalogs.
 */

type Catalog = Record<string, { message: string }>;

const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Catalog;

/** A message of a catalog with its placeholders filled. */
function said(catalog: Catalog, key: string, args: Record<string, string> = {}): string {
  const message = catalog[key]?.message;
  if (message === undefined) throw new Error(`no ${key}`);
  return message.replace(/\$([A-Za-z0-9_]+)\$/g, (_whole, name: string) => args[name] ?? '');
}

const FOLDER = '/home/dana/shop';
const REF = 'runner-run-7';
const VIEWER = 'f'.repeat(32);

/** A run request the instance sent, with a check of each level, by code. */
function runRequest() {
  return {
    id: 'a1b2c3d4',
    instance: 'https://piwi.example.com',
    projectId: 12,
    projectName: 'Acme Checkout',
    tests: [
      {
        title: 'checkout › pays with a saved card',
        filePath: 'tests/checkout.spec.ts',
        line: 3,
        projectName: 'chromium',
      },
    ],
    options: { headed: true, trace: 'on', repeatEach: 2, workers: 1, project: 'chromium' },
    source: { branch: 'feat/pay', commit: '5d6e7f8a9b0c' },
    checks: [
      {
        id: 'folder',
        level: 'ok',
        code: 'folder-linked',
        args: { folder: FOLDER },
        message: `Linked folder: ${FOLDER}`,
      },
      { id: 'specs', level: 'ok', code: 'specs-found', args: {}, message: 'The specs are in the folder.' },
      { id: 'playwright', level: 'ok', code: 'playwright-installed', args: {}, message: 'Playwright is installed.' },
      {
        id: 'commit',
        level: 'warn',
        code: 'commit-differs',
        args: { branch: 'main', commit: '1a2b3c4', sourceBranch: 'feat/pay', sourceCommit: '5d6e7f8' },
        message: 'Your folder is on main at 1a2b3c4; the run you came from was on feat/pay at 5d6e7f8. …',
      },
      {
        id: 'changes',
        level: 'warn',
        code: 'changes-uncommitted',
        args: {},
        message: 'Your folder has uncommitted changes.',
      },
    ],
    runnable: true,
    command: 'npx playwright test tests/checkout.spec.ts:3 --headed --trace=on --repeat-each=2',
    hasFolder: true,
    answerBy: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

/** The hub's run, its worker stopped at a Pause. */
function stoppedRun() {
  const test = {
    id: 't1',
    title: ['checkout', 'pays with a saved card'],
    uri: `file://${FOLDER}/tests/checkout.spec.ts`,
    line: 3,
    project: 'chromium',
    retry: 0,
    cannotPause: null,
  };
  const worker = {
    worker: 0,
    parallelIndex: 0,
    state: 'stopped',
    test,
    pausing: false,
    intents: [],
    stop: {
      reason: 'pause',
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: test.uri,
      line: 4,
      character: 2,
      locator: "getByRole('button', { name: 'Pay' })",
      bar: false,
      since: '2026-11-17T10:00:00.000Z',
      intents: ['mock', 'view'],
    },
  };
  return {
    type: 'session',
    session: {
      ref: REF,
      root: FOLDER,
      label: 'shop',
      command: null,
      project: 'Acme Checkout',
      workers: [worker],
      ended: false,
    },
  };
}

declare global {
  interface Window {
    __events: { send(stream: 'host' | 'hub', message: unknown): void };
  }
}

/**
 * The shell's bridge, answering in `language`, and the window's two streams (the host's events and the runs' hub),
 * which `window.__events.send` speaks on.
 */
async function playShell(page: Page, language: string) {
  await page.addInitScript((code) => {
    const streams: Array<{ kind: 'host' | 'hub'; closed: boolean; onmessage: ((e: { data: string }) => void) | null }> =
      [];
    function Stream(url: string | URL) {
      const stream = {
        kind: String(url).includes('/api/desktop/runs/events') ? ('hub' as const) : ('host' as const),
        url: String(url),
        readyState: 1,
        closed: false,
        onmessage: null as ((e: { data: string }) => void) | null,
        onerror: null,
        addEventListener() {},
        close() {
          this.closed = true;
          this.readyState = 2;
        },
      };
      streams.push(stream);
      return stream;
    }
    Object.assign(Stream, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    Object.assign(window, {
      EventSource: Stream,
      __events: {
        send: (kind: 'host' | 'hub', message: unknown) => {
          for (const stream of streams) {
            if (stream.kind === kind && !stream.closed) stream.onmessage?.({ data: JSON.stringify(message) });
          }
        },
      },
      __TAURI__: {
        core: {
          invoke: async (cmd: string) => {
            switch (cmd) {
              case 'desktop_get_language':
                return { language: code, chosen: code, system: 'en' };
              case 'desktop_get_service_settings':
                return { run_in_background: true, start_on_login: false };
              case 'desktop_request_folders':
                return { '12': '/home/dana/shop' };
              default:
                return null;
            }
          },
        },
        event: { listen: async () => () => {} },
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  }, language);
  await page.route('**/api/desktop/run-target', (route) =>
    route.fulfill({
      json: {
        connection: {
          state: 'online',
          instance: 'https://piwi.example.com',
          userCode: null,
          verificationUrl: null,
          error: null,
          errorCode: null,
          errorArgs: {},
          keyToKeep: false,
          linkedProjectIds: [12],
          projectNames: { 12: 'Acme Checkout' },
        },
      },
    }),
  );
  await page.route('**/api/desktop/run-target/requests/*/answer', (route) =>
    route.fulfill({ json: { launch: false } }),
  );
  await page.route('**/api/desktop/runs/commands', (route) =>
    route.fulfill({ json: { type: 'answer', id: 1, ok: true, message: '' } }),
  );
}

/**
 * The elements under `scope` whose own text is wider than their box, cut or spilling out, as `tag: text`. Code is left
 * out, and so is a box that scrolls, whose text the reader reaches.
 */
function clipped(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('*')]
      .filter((element) => {
        if (element.closest('code, pre, kbd')) return false;
        const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim());
        if (!own) return false;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || ['auto', 'scroll'].includes(style.overflowX)) return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => `${element.tagName.toLowerCase()}: ${element.textContent?.trim()}`),
  );
}

const LANGUAGES = [
  { code: 'fr', tag: 'fr', close: 'Fermer' },
  { code: 'de', tag: 'de', close: 'Schließen' },
];

for (const { code, tag, close } of LANGUAGES) {
  test(`the window speaks ${code}, a run request and a stopped run included, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    const layer = read(`packages/run-ui/locales/${code}.json`);
    const runWords = JSON.parse(
      readFileSync(path.join(root, `packages/run-model/src/words/${code}.json`), 'utf8'),
    ) as Record<string, string>;
    await playShell(page, code);
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', tag);
    await expect(page.getByText(said(runner, 'runner_tagline'))).toBeVisible();
    await expect(page.getByRole('heading', { name: said(runner, 'runner_languageHeading') })).toBeVisible();
    await expect(page.getByText(said(layer, 'runui_connectionStateOnline'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);

    // A request: its confirmation, its checks said from their codes, and Nuxt UI's own close button.
    await page.evaluate((request) => window.__events.send('host', { type: 'run-request', request }), runRequest());
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(said(layer, 'runui_requestTitle'))).toBeVisible();
    const checks = dialog.getByTestId('team-run-request-checks');
    await expect(checks).toContainText(said(layer, 'runui_checkFolderLinked', { folder: FOLDER }));
    await expect(checks).toContainText(said(layer, 'runui_checkChangesUncommitted'));
    await expect(dialog.getByRole('button', { name: close })).toBeVisible();
    expect(await clipped(dialog)).toEqual([]);
    await expect(dialog.getByRole('button', { name: said(layer, 'runui_requestNotNow') })).toBeEnabled();
    await dialog.getByRole('button', { name: said(layer, 'runui_requestNotNow') }).click();
    await expect(dialog).toBeHidden();

    // A run the hub has and this window holds no entry for: its worker stopped at a Pause, in the run model's words.
    await page.evaluate((viewer) => window.__events.send('hub', { type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__events.send('hub', event), stoppedRun());
    const run = page.getByTestId('runner-unlisted-run');
    await expect(run.getByText(said(runner, 'runner_stillRunning'))).toBeVisible();
    await expect(run.getByText(runWords.runs_stoppedPause!, { exact: true }).first()).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
  });
}
