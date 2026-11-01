import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The desktop app's automatic cleanup on Settings › Storage: the shell stores how many days of runs
 * the server keeps and hands it `PIWI_RETENTION_DAYS` when it starts. Driven against the web build
 * with a faked bridge; the shell's own side is covered by its Rust tests.
 */

interface FakeInvocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiRetentionInvocations: FakeInvocation[];
  }
}

async function installFakeBridge(page: Page, settings: Record<string, unknown>) {
  await page.addInitScript((initial) => {
    const invocations: FakeInvocation[] = [];
    Object.assign(window, { __piwiRetentionInvocations: invocations });
    Object.assign(window, {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            if (cmd === 'desktop_get_service_settings') return initial;
            if (cmd === 'desktop_take_pending_open_files') return [];
            return null;
          },
        },
        event: { listen: async () => () => {} },
      },
    });
  }, settings);
}

const SETTINGS = { run_in_background: false, start_on_login: false, server_port: 3000, active_port: 3000 };

test.describe('Desktop automatic cleanup', () => {
  test('choosing a period saves it and offers a restart until the server runs with it', async ({ page }) => {
    await installFakeBridge(page, { ...SETTINGS, retention_days: null, active_retention_days: null });
    await page.goto('/settings/storage');
    await waitForHydration(page);

    const setting = page.locator('[data-shot="desktop-retention"]');
    await expect(setting.getByText('Delete old runs automatically')).toBeVisible();
    await expect(setting.getByRole('button', { name: 'Restart now' })).toHaveCount(0);

    await setting.getByRole('combobox', { name: 'Delete runs older than' }).click();
    await page.getByRole('option', { name: 'After 90 days' }).click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__piwiRetentionInvocations.filter((i) => i.cmd === 'desktop_set_retention_days').map((i) => i.args),
        ),
      )
      .toEqual([{ days: 90 }]);
    await expect(setting.getByText('Piwi applies the change the next time it starts.')).toBeVisible();
    await expect(setting.getByRole('button', { name: 'Restart now' })).toBeVisible();
  });

  test('a shell that predates the setting shows nothing', async ({ page }) => {
    await installFakeBridge(page, SETTINGS);
    await page.goto('/settings/storage');
    await waitForHydration(page);

    await expect(page.locator('[data-tour="storage-cleanup"]')).toBeVisible();
    await expect(page.locator('[data-shot="desktop-retention"]')).toHaveCount(0);
  });
});
