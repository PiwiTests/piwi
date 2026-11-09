import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The page's side of the desktop shell's notifications: the Notification shim (installed by the desktop plugin
 * whenever the IPC bridge exists) shows the page's notifications through the shell, which counts the ones shown while
 * the window is not in front as unread, and hands a click back; the page gives the shell its notification choices,
 * which the shell applies to the server's notifications. Driven against the web build with a faked bridge.
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiAmbientInvocations: FakeInvocation[];
    /** Deliver a shell event to the page's listeners, as the shell's `emit` does. */
    __piwiAmbientEmit: (event: string, payload: unknown) => void;
  }
}

async function installFakeBridge(page: Page) {
  await page.addInitScript(() => {
    const invocations: FakeInvocation[] = [];
    const listeners = new Map<string, Array<(event: { payload: unknown }) => void>>();
    Object.assign(window, {
      __piwiAmbientInvocations: invocations,
      __piwiAmbientEmit: (event: string, payload: unknown) => {
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
        window: { getCurrentWindow: () => ({ label: 'main' }) },
        event: {
          listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
            return () => {};
          },
        },
      },
    });
  });
}

test.describe('Desktop notifications from the page', () => {
  test('a notification the page shows goes to the shell', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto('/');
    await waitForHydration(page);

    // The shim replaced the Notification API and always reports granted.
    const permission = await page.evaluate(() => window.Notification.permission);
    expect(permission).toBe('granted');

    await page.evaluate(() => {
      new Notification('Piwi Dashboard', { body: 'acme-web on main: 3/120 tests failed' });
      new Notification('Piwi Dashboard', { body: 'acme-web: new failure cluster' });
    });

    const invocations = await page.evaluate(() => window.__piwiAmbientInvocations);
    const notifies = invocations.filter((i) => i.cmd === 'desktop_notify');
    expect(notifies.map((i) => [i.args?.title, i.args?.body])).toEqual([
      ['Piwi Dashboard', 'acme-web on main: 3/120 tests failed'],
      ['Piwi Dashboard', 'acme-web: new failure cluster'],
    ]);
  });

  test('a click the shell reports runs the notification’s own click handler', async ({ page }) => {
    await installFakeBridge(page);
    await page.goto('/');
    await waitForHydration(page);

    const clicks = await page.evaluate(() => {
      const opened: string[] = [];
      const first = new Notification('Piwi Dashboard', { body: 'acme-web on main: 3/120 tests failed' });
      first.onclick = () => opened.push('run');
      const second = new Notification('Piwi Dashboard', { body: 'acme-web: new failure cluster' });
      second.addEventListener('click', () => opened.push('cluster'));
      const ids = window.__piwiAmbientInvocations
        .filter((i) => i.cmd === 'desktop_notify')
        .map((i) => i.args?.id as number);
      window.__piwiAmbientEmit('piwi:notification-click', ids[1]);
      window.__piwiAmbientEmit('piwi:notification-click', ids[0]);
      // An id this page never gave, such as one from before a reload, opens nothing.
      window.__piwiAmbientEmit('piwi:notification-click', -1);
      return { ids, opened };
    });

    expect(new Set(clicks.ids).size).toBe(2);
    expect(clicks.opened).toEqual(['cluster', 'run']);
  });

  test('the shell gets the notification choices, and each change', async ({ page, context, baseURL }) => {
    await installFakeBridge(page);
    await context.addCookies([
      {
        name: 'piwi-browser-notify',
        value: encodeURIComponent(JSON.stringify({ projects: { 3: { events: ['cluster.new'] } } })),
        url: baseURL!,
      },
    ]);
    await page.addInitScript(() => localStorage.setItem('piwi-diagnosis-notifications', 'false'));
    await page.goto('/settings/ai');
    await waitForHydration(page);

    const choices = () =>
      page.evaluate(() =>
        window.__piwiAmbientInvocations
          .filter((i) => i.cmd === 'desktop_set_notification_choices')
          .map((i) => i.args?.choices),
      );
    await expect.poll(choices).toEqual([{ projects: { 3: ['cluster.new'] }, muted: ['diagnosis.completed'] }]);

    // Turning diagnosis notifications back on reaches the shell at once.
    await page.getByRole('switch', { name: 'Diagnosis notifications' }).click();
    await expect.poll(async () => (await choices()).at(-1)).toEqual({ projects: { 3: ['cluster.new'] }, muted: [] });
  });
});
