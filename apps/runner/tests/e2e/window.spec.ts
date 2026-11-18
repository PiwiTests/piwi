import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Piwi Runner's window in another language than English, at its smallest size: the language the shell answers reaches
 * the page (`lang`), Runner's own words (the header, both views, the welcome, a run's card), the layer's (a run
 * request's confirmation and its checks, by their codes), the run model's (a stopped worker) and Nuxt UI's (a close
 * button), and no text is cut. The shell's bridge (`window.__TAURI__`) and the host's streams are played by the spec;
 * what each says comes from the catalogs.
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

/** The protected environment the request runs for. */
const ENVIRONMENT = { key: 'production', name: 'Production', protected: true, requiredTags: ['@smoke', '@readonly'] };

/** A run request the instance sent, for a protected environment, with a check of each level, by code. */
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
      {
        id: 'environment',
        level: 'warn',
        code: 'environment-protected',
        args: { environment: ENVIRONMENT.name, key: ENVIRONMENT.key, tags: ENVIRONMENT.requiredTags.join(', ') },
        message:
          'Runs for Production, a protected environment: only the tests tagged @smoke, @readonly run, beside the setup and teardown projects they depend on, which Playwright runs whole.',
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
    command:
      "PIWI_ENVIRONMENT=production npx playwright test tests/checkout.spec.ts:3 --headed --trace=on --repeat-each=2 '--grep-invert=^(?!.*(?:^|\\s)(?:@smoke|@readonly)(?:\\s|$))'",
    environment: ENVIRONMENT,
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
    __events: { send(stream: 'host' | 'hub', message: unknown): void; emit(event: string, payload: unknown): void };
  }
}

type ConnectionState = 'online' | 'offline' | 'none';

/** The connection the host answers: online (or not answering) with the project's folder linked, or none yet. */
function connectionView(state: ConnectionState) {
  const linked = state !== 'none';
  return {
    state,
    instance: linked ? 'https://piwi.example.com' : null,
    userCode: null,
    verificationUrl: null,
    error: null,
    errorCode: null,
    errorArgs: {},
    keyToKeep: false,
    linkedProjectIds: linked ? [12] : [],
    projectNames: linked ? { 12: 'Acme Checkout' } : {},
  };
}

/**
 * The shell's bridge, answering in `language`, and the window's two streams (the host's events and the runs' hub),
 * which `window.__events.send` speaks on; `window.__events.emit` says a shell event (`piwi:local-run`). A run the
 * person confirms starts as the shell's run 1.
 */
async function playShell(page: Page, language: string, state: ConnectionState = 'online') {
  await page.addInitScript((code) => {
    const listeners: Record<string, Array<(event: { payload: unknown }) => void>> = {};
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
        emit: (event: string, payload: unknown) => {
          for (const listener of listeners[event] ?? []) listener({ payload });
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
              case 'desktop_run_requested_tests':
                return 1;
              default:
                return null;
            }
          },
        },
        event: {
          listen: async (event: string, listener: (event: { payload: unknown }) => void) => {
            (listeners[event] ??= []).push(listener);
            return () => {};
          },
        },
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  }, language);
  await page.route('**/api/desktop/run-target', (route) =>
    route.fulfill({ json: { connection: connectionView(state) } }),
  );
  await page.route('**/api/desktop/run-target/requests/*/answer', (route) =>
    route.fulfill({ json: { launch: (route.request().postDataJSON() as { decision: string }).decision === 'run' } }),
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

const ESC = '\u001b';
/** What the run prints: Playwright's colors on, as the shell starts it. */
const OUTPUT = [
  'Running 1 test using 1 worker',
  `  ${ESC}[31m✘${ESC}[39m  1 ${ESC}[2m[chromium] › tests/checkout.spec.ts:3:1 › checkout › pays with a saved card${ESC}[22m`,
  `    Expected: ${ESC}[32m"Total: $45.00"${ESC}[39m`,
  `    Received: ${ESC}[31m"Total: $50.00"${ESC}[39m`,
  `  ${ESC}[31m1 failed${ESC}[39m`,
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
    const header = page.getByTestId('runner-header');
    await expect(header.getByText(said(runner, 'runner_connectedTo', { host: 'piwi.example.com' }))).toBeVisible();
    await expect(page.getByText(said(runner, 'runner_noRuns'))).toBeVisible();
    expect(await clipped(header)).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);

    // The settings, a section at a time: the connection (Disconnect asks first), the folders, the general settings
    // and About.
    await header.getByRole('tab', { name: said(runner, 'runner_settingsHeading') }).click();
    const settings = page.getByTestId('runner-settings');
    const section = (key: string) => settings.getByRole('tab', { name: said(runner, key) }).click();
    await expect(settings.getByText(said(layer, 'runui_connectionStateOnline'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    await page.getByTestId('runner-disconnect').click();
    const question = page.getByTestId('runner-disconnect-question');
    await expect(
      question.getByText(said(runner, 'runner_disconnectQuestion', { host: 'piwi.example.com' })),
    ).toBeVisible();
    expect(await clipped(question)).toEqual([]);
    await question.getByRole('button', { name: said(layer, 'runui_commonCancel') }).click();
    await expect(question).toBeHidden();
    await section('runner_navFolders');
    await expect(page.getByTestId('runner-folders').getByText('Acme Checkout')).toBeVisible();
    await expect(page.getByTestId('runner-folders')).toContainText(FOLDER);
    await section('runner_navGeneral');
    await expect(page.getByRole('heading', { name: said(runner, 'runner_languageHeading') })).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    await section('runner_aboutHeading');
    await expect(page.getByTestId('runner-about').getByText(said(runner, 'runner_tagline'))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);

    // A request: its confirmation, its checks said from their codes, and Nuxt UI's own close button.
    await page.evaluate((request) => window.__events.send('host', { type: 'run-request', request }), runRequest());
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(said(layer, 'runui_requestTitleFor', { environment: ENVIRONMENT.name })),
    ).toBeVisible();
    const checks = dialog.getByTestId('team-run-request-checks');
    await expect(checks).toContainText(said(layer, 'runui_checkFolderLinked', { folder: FOLDER }));
    await expect(checks).toContainText(said(layer, 'runui_checkChangesUncommitted'));
    const tags = ENVIRONMENT.requiredTags.join(', ');
    await expect(checks).toContainText(
      said(layer, 'runui_checkEnvironmentProtected', { environment: ENVIRONMENT.name, tags }),
    );
    // A protected environment: Run waits for the box that names it.
    const protectedBox = dialog.getByTestId('team-run-request-protected');
    await expect(protectedBox).toContainText(
      said(layer, 'runui_requestProtectedNote', { environment: ENVIRONMENT.name, tags }),
    );
    const confirm = protectedBox.getByRole('checkbox', {
      name: said(layer, 'runui_requestProtectedConfirm', { environment: ENVIRONMENT.name }),
    });
    await expect(dialog.getByRole('button', { name: said(layer, 'runui_requestRun') })).toBeDisabled();
    await confirm.check();
    await expect(dialog.getByRole('button', { name: said(layer, 'runui_requestRun') })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: close })).toBeVisible();
    expect(await clipped(dialog)).toEqual([]);

    // Run: the window shows the runs again, the run's card under Running now names its project and tests; once it
    // failed, its row under Finished shows its output, with Playwright's colors and none of their codes.
    await dialog.getByRole('button', { name: said(layer, 'runui_requestRun') }).click();
    await expect(dialog).toBeHidden();
    const run = page.getByTestId('runner-running').getByTestId('runner-run');
    await expect(page.getByTestId('runner-running').getByRole('heading')).toContainText(
      said(runner, 'runner_runningHeading'),
    );
    await expect(run.getByText(said(runner, 'runner_statusRunning'))).toBeVisible();
    await expect(run).toContainText('Acme Checkout');
    await expect(run.getByText(said(layer, 'runui_tests_one', { count: '1' }))).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
    for (const line of OUTPUT) {
      await page.evaluate((l) => window.__events.emit('piwi:local-run', { id: 1, kind: 'stdout', line: l }), line);
    }
    await page.evaluate(() => window.__events.emit('piwi:local-run', { id: 1, kind: 'exit', code: 1 }));
    await expect(run).toBeHidden();
    const ended = page.getByTestId('runner-finished').getByTestId('runner-run');
    await expect(page.getByTestId('runner-finished').getByRole('heading')).toContainText(
      said(runner, 'runner_finishedHeading'),
    );
    await expect(ended.getByText(said(runner, 'runner_statusFailed'))).toBeVisible();
    const output = ended.getByTestId('runner-run-output');
    await expect(output.locator('pre')).toBeVisible();
    await expect(output.locator('pre')).toContainText('Received: "Total: $50.00"');
    expect(await output.locator('pre').innerText()).not.toContain(ESC);
    await expect(output.getByRole('button', { name: said(runner, 'runner_copyOutput') })).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);

    // Clear finished takes the ended run away.
    await page.getByTestId('runner-clear-finished').click();
    await expect(ended).toBeHidden();
    await expect(page.getByText(said(runner, 'runner_noRuns'))).toBeVisible();

    // A run the hub has and this window holds no entry for: its worker stopped at a Pause, in the run model's words.
    await page.evaluate((viewer) => window.__events.send('hub', { type: 'hello', viewer }), VIEWER);
    await page.evaluate((event) => window.__events.send('hub', event), stoppedRun());
    const unlisted = page.getByTestId('runner-unlisted-run');
    await expect(unlisted.getByText(said(runner, 'runner_stillRunning'))).toBeVisible();
    await expect(unlisted.getByText(runWords.runs_stoppedPause!, { exact: true }).first()).toBeVisible();
    expect(await clipped(page.locator('main'))).toEqual([]);
  });

  test(`the window speaks ${code} before it is connected, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    const layer = read(`packages/run-ui/locales/${code}.json`);
    await playShell(page, code, 'none');
    await page.goto('/');

    const welcome = page.getByTestId('runner-welcome');
    await expect(welcome.getByRole('heading', { name: said(runner, 'runner_welcomeHeading') })).toBeVisible();
    await expect(welcome.getByText(said(runner, 'runner_tagline'))).toBeVisible();
    await expect(
      welcome.getByText(said(runner, 'runner_stepConfirm', { run: said(layer, 'runui_requestRun') })),
    ).toBeVisible();
    await expect(welcome.getByRole('button', { name: said(layer, 'runui_connectionConnect') })).toBeVisible();
    await expect(page.getByTestId('runner-status')).toHaveText(said(layer, 'runui_connectionStateNone'));
    expect(await clipped(page.getByTestId('runner-header'))).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);
  });

  test(`the window speaks ${code} while the instance does not answer, with no text cut`, async ({ page }) => {
    const runner = read(`apps/runner/locales/${code}.json`);
    await playShell(page, code, 'offline');
    await page.goto('/');

    const host = 'piwi.example.com';
    await expect(page.getByTestId('runner-status')).toHaveText(said(runner, 'runner_reconnectingTo', { host }));
    await expect(page.getByTestId('runner-offline')).toHaveText(said(runner, 'runner_offline', { host }));
    expect(await clipped(page.getByTestId('runner-header'))).toEqual([]);
    expect(await clipped(page.locator('main'))).toEqual([]);
  });
}
