import { expect, type BrowserContext, type Page } from '@playwright/test';

/**
 * Opens one of the extension's DevTools pages (the Elements sidebar, the Piwi
 * panel) as an ordinary extension tab, with `chrome.devtools` stubbed over the
 * real `chrome`: `inspectedWindow.eval` runs in `inspected`'s own world, where
 * the spec has added the content script the evaluation calls, and `$0` is the
 * page's `globalThis.$0`, set by {@link selectElement}. The other `chrome.*`
 * APIs are the real ones.
 */

export interface DevtoolsStubOptions {
  /** `inspectedWindow.tabId`; by default a tab that does not exist. */
  tabId?: number;
  /** Whether `useContentScriptContext` finds the extension's content script, as after an injection. */
  contentScript?: boolean;
  /** Network entries `getHAR` answers with. */
  har?: unknown[];
  /** Runs before each `inspectedWindow.eval`, which waits for the promise it returns. */
  beforeEval?: (expression: string) => Promise<void> | void;
}

function installDevtoolsStub(seed: { tabId: number; har: unknown[] }): void {
  type Listener = (...args: unknown[]) => void;
  const events: Record<string, Listener[]> = {};
  const event = (name: string) => {
    events[name] = [];
    return {
      addListener: (fn: Listener) => events[name]!.push(fn),
      removeListener: (fn: Listener) => {
        events[name] = events[name]!.filter((f) => f !== fn);
      },
    };
  };
  const g = globalThis as unknown as {
    chrome: Record<string, unknown>;
    __piwiTestEval: (expression: string, contentScript: boolean) => Promise<[unknown, unknown]>;
    __piwiDevtoolsFire: (name: string, ...args: unknown[]) => void;
    __piwiDevtoolsHar: unknown[];
  };
  g.__piwiDevtoolsHar = seed.har;
  // A network entry carries its body as `__body`, handed out by `getContent` as Chrome's DevTools does, after
  // `__delayMs`; with `__promise`, as Firefox's does: a promise of the body and its MIME type, and no callback.
  const withContent = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('request' in entry)) return entry;
    const e = entry as {
      __body?: string | null;
      __encoding?: string;
      __delayMs?: number;
      __promise?: boolean;
      response?: { content?: { mimeType?: string } };
    };
    const body = e.__body ?? null;
    if (e.__promise) {
      const value = [body, e.response?.content?.mimeType ?? ''];
      return { ...e, getContent: () => new Promise((resolve) => setTimeout(() => resolve(value), e.__delayMs ?? 0)) };
    }
    return {
      ...e,
      getContent: (cb: (content: string | null, encoding: string) => void) => {
        const give = () => cb(body, e.__encoding ?? '');
        if (e.__delayMs) setTimeout(give, e.__delayMs);
        else give();
      },
    };
  };
  g.__piwiDevtoolsFire = (name, ...args) => {
    for (const fn of events[name] ?? []) fn(...args.map(withContent));
  };
  g.chrome.devtools = {
    inspectedWindow: {
      tabId: seed.tabId,
      eval(expression: string, options: unknown, callback?: (value: unknown, exception: unknown) => void) {
        const cb = typeof options === 'function' ? (options as typeof callback) : callback;
        const contentScript = typeof options === 'object' && options !== null && 'useContentScriptContext' in options;
        void g.__piwiTestEval(expression, contentScript).then(([value, exception]) => cb?.(value, exception));
      },
      reload() {},
    },
    panels: {
      themeName: 'default',
      create() {},
      elements: { onSelectionChanged: event('selectionChanged'), createSidebarPane() {} },
    },
    network: {
      onNavigated: event('navigated'),
      onRequestFinished: event('requestFinished'),
      getHAR(callback: (har: { entries: unknown[] }) => void) {
        callback({ entries: g.__piwiDevtoolsHar.map(withContent) });
      },
    },
  };
}

export async function openDevtoolsPage(
  context: BrowserContext,
  extensionId: string,
  file: string,
  inspected: Page,
  options: DevtoolsStubOptions = {},
): Promise<Page> {
  const page = await context.newPage();
  await page.exposeFunction('__piwiTestEval', async (expression: string, contentScript: boolean) => {
    await options.beforeEval?.(expression);
    if (contentScript && options.contentScript === false) {
      return [undefined, { isError: true, code: 'E_NOTFOUND', description: 'Object not found: %s' }];
    }
    try {
      const value = await inspected.evaluate((source) => {
        // DevTools' `$0` is null until an element is selected.
        (globalThis as { $0?: unknown }).$0 ??= null;
        return (0, eval)(source);
      }, expression);
      return [value, undefined];
    } catch (err) {
      return [undefined, { isException: true, value: err instanceof Error ? err.message : String(err) }];
    }
  });
  await page.addInitScript(installDevtoolsStub, { tabId: options.tabId ?? 987_654_321, har: options.har ?? [] });
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

/**
 * Opens the Piwi panel's Network tab once the panel has its listeners (`html[data-ready]`), and waits for its list to
 * be drawn: a `requestFinished` fired before either is lost.
 */
export async function openNetworkTab(panel: Page): Promise<void> {
  await expect(panel.locator('html')).toHaveAttribute('data-ready', 'true');
  await panel.getByRole('tab', { name: 'Network' }).click();
  await expect(panel.getByRole('list', { name: 'Network' })).toBeVisible();
}

/** Selects `selector` in the inspected page as DevTools would (`$0`) and tells the DevTools page. */
export async function selectElement(devtools: Page, inspected: Page, selector: string): Promise<void> {
  await inspected.evaluate((sel) => {
    (globalThis as { $0?: Element | null }).$0 = document.querySelector(sel);
  }, selector);
  await devtools.evaluate(() =>
    (globalThis as unknown as { __piwiDevtoolsFire: (name: string) => void }).__piwiDevtoolsFire('selectionChanged'),
  );
}

/** Fires one of the stub's events (`navigated`, `requestFinished`) in the DevTools page. */
export async function fireDevtoolsEvent(devtools: Page, name: string, ...args: unknown[]): Promise<void> {
  await devtools.evaluate(
    ([n, a]) =>
      (globalThis as unknown as { __piwiDevtoolsFire: (name: string, ...args: unknown[]) => void }).__piwiDevtoolsFire(
        n as string,
        ...(a as unknown[]),
      ),
    [name, args] as const,
  );
}
