import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { resolveE2ETarget } from './desktop-target';
import { waitForHydration } from './utils';

/**
 * A dashboard link opened in the system browser shows in the desktop app
 * window: the server forwards it as an `open-page` message on the desktop event
 * stream, and the `main` window navigates to it and asks the shell to bring it
 * to the front (`desktop_bring_to_front`). Driven against the web build with a
 * faked bridge; the last test needs the desktop build's server.
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiOpenPageInvocations: FakeInvocation[];
    __piwiDesktopEvents: string[];
    /** Deliver a shell event to the page's listeners, as the shell's `emit_to` does. */
    __piwiShellEmit: (event: string, payload: unknown) => void;
  }
}

/** Fake the shell bridge for a window labelled `label`, and record every desktop-stream message the page receives. */
async function installFakeBridge(page: Page, label: string) {
  await page.addInitScript((windowLabel) => {
    const invocations: FakeInvocation[] = [];
    const events: string[] = [];
    const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
    Object.assign(window, {
      __piwiOpenPageInvocations: invocations,
      __piwiDesktopEvents: events,
      __piwiShellEmit: (event: string, payload: unknown) => {
        for (const handler of listeners.get(event) ?? []) handler({ payload });
      },
    });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            if (cmd === 'desktop_take_pending_open_files') return [];
            return null;
          },
        },
        event: {
          listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
            return () => {};
          },
        },
        window: { getCurrentWindow: () => ({ label: windowLabel }) },
      },
    });
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (String(url).includes('/api/desktop/events')) {
          this.addEventListener('message', (event) => events.push((event as MessageEvent<string>).data));
        }
      }
    };
  }, label);
}

/** Hold the desktop event stream until `send` is called, then deliver `messages` on it. */
async function holdDesktopEvents(page: Page, messages: unknown[]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/desktop/events', async (route) => {
    await released;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      // A long retry keeps EventSource from replaying the messages on reconnect.
      body: `retry: 600000\n\n${messages.map((m) => `data: ${JSON.stringify(m)}\n\n`).join('')}`,
    });
  });
  return { send: release };
}

async function invokedCommands(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.__piwiOpenPageInvocations)).map((i) => i.cmd);
}

test.describe('Desktop window shows a page opened outside the app', () => {
  test('the main window navigates to the page and comes to the front', async ({ page }) => {
    await installFakeBridge(page, 'main');
    const stream = await holdDesktopEvents(page, [{ type: 'open-page', path: '/settings/about' }]);
    await page.goto('/');
    await waitForHydration(page);

    stream.send();

    await expect(page).toHaveURL(/\/settings\/about$/);
    await expect.poll(() => invokedCommands(page)).toContain('desktop_bring_to_front');
  });

  test('a path that could leave the dashboard is ignored', async ({ page }) => {
    await installFakeBridge(page, 'main');
    const stream = await holdDesktopEvents(page, [{ type: 'open-page', path: '//evil.example/settings' }]);
    await page.goto('/');
    await waitForHydration(page);

    stream.send();

    await expect.poll(() => page.evaluate(() => window.__piwiDesktopEvents.length)).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await invokedCommands(page)).not.toContain('desktop_bring_to_front');
  });

  test('the shell opens a page with its own event, under the same path check', async ({ page }) => {
    await installFakeBridge(page, 'main');
    await page.goto('/');
    await waitForHydration(page);

    await page.evaluate(() => window.__piwiShellEmit('piwi:open-page', '//evil.example/settings'));
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await invokedCommands(page)).not.toContain('desktop_bring_to_front');

    await page.evaluate(() => window.__piwiShellEmit('piwi:open-page', '/settings/about'));
    await expect(page).toHaveURL(/\/settings\/about$/);
    await expect.poll(() => invokedCommands(page)).toContain('desktop_bring_to_front');
  });

  test('another shell window ignores it', async ({ page }) => {
    await installFakeBridge(page, 'aux-1');
    const stream = await holdDesktopEvents(page, [{ type: 'open-page', path: '/settings/about' }]);
    await page.goto('/');
    await waitForHydration(page);

    stream.send();

    await expect.poll(() => page.evaluate(() => window.__piwiDesktopEvents.length)).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await invokedCommands(page)).not.toContain('desktop_bring_to_front');
  });
});

test.describe('Desktop handoff from the system browser', () => {
  const target = resolveE2ETarget();

  // The real app window listens on the same stream, so it shows the page too.
  test('a browser tab without the access token hands its page to the app window', async ({ page, browser }) => {
    test.skip(!target.desktop, 'needs the desktop build: run with PIWI_DESKTOP_E2E');

    await installFakeBridge(page, 'main');
    const streamOpened = page.waitForResponse('**/api/desktop/events');
    await page.goto('/');
    await waitForHydration(page);
    await streamOpened;

    // A plain browser: none of the suite's access-token headers.
    const tabContext = await browser.newContext({ extraHTTPHeaders: {} });
    try {
      const tab = await tabContext.newPage();
      await tab.goto(`${target.baseUrl}/settings/about`);
      await expect(tab.locator('[data-desktop-handoff="shown"]')).toBeVisible();
      await expect(tab.getByRole('heading', { name: 'Opened in Piwi Dashboard' })).toBeVisible();
    } finally {
      await tabContext.close();
    }

    await expect(page).toHaveURL(/\/settings\/about$/);
    await expect.poll(() => invokedCommands(page)).toContain('desktop_bring_to_front');
  });
});
