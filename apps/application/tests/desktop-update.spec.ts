import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The desktop-only update card on Settings → About, driven against the web
 * build with a faked Tauri bridge. The updater itself lives in the shell;
 * this covers the dashboard side: the three check outcomes render, install
 * streams progress, the restart is only ever user-initiated, an update the
 * startup check found shows without a click, and the startup notification
 * checkbox round-trips to the shell.
 */

declare global {
  interface Window {
    __piwiUpdateInvocations: string[];
    __piwiNotifySettings: boolean[];
    __piwiEmitProgress: (downloaded: number, total: number | null) => void;
  }
}

interface FakeBridgeOptions {
  /** What the startup check already found — `desktop_get_update_settings`'s `pending`. */
  pending?: boolean;
  notifyOnStartup?: boolean;
  /** The Microsoft Store package: `desktop_get_update_settings`'s `store`. */
  store?: boolean;
}

async function installFakeBridge(
  page: Page,
  outcome: 'unsupported' | 'uptodate' | 'available',
  options: FakeBridgeOptions = {},
) {
  const init = { state: outcome, opts: options };
  await page.addInitScript(({ state, opts }) => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const invocations: string[] = [];
    const notifySettings: boolean[] = [];
    const found = { state: 'available', version: '99.0.0', notes: 'feat: everything', date: null };
    Object.assign(window, {
      __piwiUpdateInvocations: invocations,
      __piwiNotifySettings: notifySettings,
      __piwiEmitProgress: (downloaded: number, total: number | null) => {
        for (const cb of listeners) cb({ payload: { downloaded, total } });
      },
    });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push(cmd);
            switch (cmd) {
              case 'desktop_get_update_settings':
                return {
                  supported: state !== 'unsupported',
                  store: opts.store ?? false,
                  notify_on_startup: opts.notifyOnStartup ?? true,
                  pending: opts.pending ? found : null,
                };
              case 'desktop_set_update_notification':
                notifySettings.push(args?.enabled as boolean);
                return null;
              case 'desktop_check_update':
                return state === 'available' ? found : { state, version: null, notes: null, date: null };
              case 'desktop_install_update':
                // Resolves after a beat so the progress event lands mid-install.
                return new Promise((resolve) => setTimeout(resolve, 150));
              case 'desktop_restart_app':
                return null;
              case 'desktop_take_pending_open_files':
                return [];
              default:
                throw new Error(`unexpected command: ${cmd}`);
            }
          },
        },
        event: {
          listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
            if (name === 'piwi:update-progress') listeners.push(cb);
            return () => {};
          },
        },
      },
    });
  }, init);
}

test.describe('Desktop update card', () => {
  test('does not exist without the bridge', async ({ page }) => {
    await page.goto('/settings/about');
    await waitForHydration(page);
    await expect(page.getByText('Application', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Check for updates')).toHaveCount(0);
  });

  test('reports an unsupported build honestly', async ({ page }) => {
    await installFakeBridge(page, 'unsupported');
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText('This build has no update channel')).toBeVisible();
    // Nothing to be notified about on a build that cannot update.
    await expect(page.getByRole('checkbox', { name: /notification at startup/ })).toHaveCount(0);
  });

  test('leaves the Store package to the Microsoft Store', async ({ page }) => {
    await installFakeBridge(page, 'unsupported', { store: true });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByText('The Microsoft Store updates this app')).toBeVisible();
    await expect(page.getByText('Windows installs new versions in the background.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /notification at startup/ })).toHaveCount(0);
  });

  test('reports being up to date', async ({ page }) => {
    await installFakeBridge(page, 'uptodate');
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText("You're on the latest version.")).toBeVisible();
  });

  test('installs an available update and restarts on demand', async ({ page }) => {
    await installFakeBridge(page, 'available');
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText('Version 99.0.0 is available')).toBeVisible();
    await expect(page.getByText('feat: everything')).toBeVisible();

    await page.getByRole('button', { name: 'Install update' }).click();
    await page.evaluate(() => window.__piwiEmitProgress(50, 100));

    await expect(page.getByRole('button', { name: 'Restart now' })).toBeVisible();
    await expect(page.getByText('applies the next time the app starts')).toBeVisible();

    await page.getByRole('button', { name: 'Restart now' }).click();
    const invocations = await page.evaluate(() => window.__piwiUpdateInvocations);
    expect(invocations).toContain('desktop_install_update');
    expect(invocations).toContain('desktop_restart_app');
  });

  test('shows an update the startup check already found', async ({ page }) => {
    await installFakeBridge(page, 'available', { pending: true });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByText('Version 99.0.0 is available')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install update' })).toBeVisible();
    const invocations = await page.evaluate(() => window.__piwiUpdateInvocations);
    expect(invocations).not.toContain('desktop_check_update');
  });

  test('the startup notification is on by default and can be turned off', async ({ page }) => {
    await installFakeBridge(page, 'uptodate');
    await page.goto('/settings/about');
    await waitForHydration(page);

    const notify = page.getByRole('checkbox', { name: 'Show a notification at startup when an update is available' });
    await expect(notify).toBeChecked();

    await notify.click();
    await expect(notify).not.toBeChecked();
    expect(await page.evaluate(() => window.__piwiNotifySettings)).toEqual([false]);

    await notify.click();
    await expect(notify).toBeChecked();
    expect(await page.evaluate(() => window.__piwiNotifySettings)).toEqual([false, true]);
  });

  test('reflects a startup notification the user turned off', async ({ page }) => {
    await installFakeBridge(page, 'uptodate', { notifyOnStartup: false });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(
      page.getByRole('checkbox', { name: 'Show a notification at startup when an update is available' }),
    ).not.toBeChecked();
  });
});
