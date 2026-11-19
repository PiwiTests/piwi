import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';

/**
 * What the window's specs play: the shell's bridge (`window.__TAURI__`), the host's routes and streams, a run request
 * and the hub's runs, and the catalogs' words, read as each says them.
 */

export type Catalog = Record<string, { message: string }>;

export const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Catalog;

/** A message of a catalog with its placeholders filled. */
export function said(catalog: Catalog, key: string, args: Record<string, string> = {}): string {
  const message = catalog[key]?.message;
  if (message === undefined) throw new Error(`no ${key}`);
  return message.replace(/\$([A-Za-z0-9_]+)\$/g, (_whole, name: string) => args[name] ?? '');
}

export const FOLDER = '/home/dana/shop';
export const REF = 'runner-run-7';
export const VIEWER = 'f'.repeat(32);

/** The protected environment the request runs for. */
export const ENVIRONMENT = {
  key: 'production',
  name: 'Production',
  protected: true,
  requiredTags: ['@smoke', '@readonly'],
};

/**
 * A run request the instance sent, with a check of each level, by code: for a protected environment unless
 * `environment` is null.
 */
export function runRequest(id = 'a1b2c3d4', environment: typeof ENVIRONMENT | null = ENVIRONMENT) {
  return {
    id,
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
      ...(environment
        ? [
            {
              id: 'environment',
              level: 'warn',
              code: 'environment-protected',
              args: { environment: ENVIRONMENT.name, key: ENVIRONMENT.key, tags: ENVIRONMENT.requiredTags.join(', ') },
              message:
                'Runs for Production, a protected environment: only the tests tagged @smoke, @readonly run, beside the setup and teardown projects they depend on, which Playwright runs whole.',
            },
          ]
        : []),
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
    command: environment
      ? "PIWI_ENVIRONMENT=production npx playwright test tests/checkout.spec.ts:3 --headed --trace=on --repeat-each=2 '--grep-invert=^(?!.*(?:^|\\s)(?:@smoke|@readonly)(?:\\s|$))'"
      : 'npx playwright test tests/checkout.spec.ts:3 --headed --trace=on --repeat-each=2',
    environment,
    hasFolder: true,
    answerBy: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

/**
 * The hub's run `ref`, its worker stopped at a Pause (`stopped`) or running its test, with its page on the instance
 * once its process named it; `ended` once its process exited.
 */
export function hubRun(
  ref = REF,
  {
    stopped = true,
    ended = false,
    page,
  }: { stopped?: boolean; ended?: boolean; page?: { id: number; url: string } } = {},
) {
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
    state: stopped ? 'stopped' : 'running',
    test,
    pausing: false,
    intents: [],
    stop: !stopped
      ? null
      : {
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
      ref,
      root: FOLDER,
      label: 'shop',
      command: null,
      project: 'Acme Checkout',
      workers: ended ? [] : [worker],
      ended,
      ...(page ? { page } : {}),
    },
  };
}

declare global {
  interface Window {
    __events: { send(stream: 'host' | 'hub', message: unknown): void; emit(event: string, payload: unknown): void };
    /** The shell's commands the window called, in order. */
    __invoked: string[];
  }
}

export type ConnectionState = 'online' | 'offline' | 'none';

/** The connection the host answers: online (or not answering) with the project's folder linked, or none yet. */
export function connectionView(state: ConnectionState) {
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
 * person confirms starts as the shell's run 1, the next as run 2, and `window.__invoked` lists the commands called.
 */
export async function playShell(page: Page, language: string, state: ConnectionState = 'online') {
  await page.addInitScript((code) => {
    const listeners: Record<string, Array<(event: { payload: unknown }) => void>> = {};
    const invoked: string[] = [];
    let runs = 0;
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
      __invoked: invoked,
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
            invoked.push(cmd);
            switch (cmd) {
              case 'desktop_get_language':
                return { language: code, chosen: code, system: 'en' };
              case 'desktop_get_service_settings':
                return { run_in_background: true, start_on_login: false };
              case 'desktop_request_folders':
                return { '12': '/home/dana/shop' };
              case 'desktop_run_requested_tests':
                return ++runs;
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
export function clipped(scope: Locator): Promise<string[]> {
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
