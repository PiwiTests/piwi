import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The desktop-only update card on Settings → About, driven against the web
 * build with a faked Tauri bridge. The updater itself lives in the shell;
 * this covers the dashboard side: the three check outcomes render, install
 * streams progress, the restart is only ever user-initiated, an update the
 * startup check found shows without a click, the startup notification
 * checkbox round-trips to the shell, and an available update lists the
 * release notes of the versions in between.
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
  /**
   * What `desktop_get_release_notes` answers: three releases (the default), an error, an error the first time only,
   * or the notes of another version than the one offered.
   */
  notes?: 'ok' | 'error' | 'error-once' | 'other-version';
}

/** The releases between v96.0.0 and v99.0.0: a raw one with a breaking change, a polished one, one without notes. */
const RELEASE_NOTES = {
  installed: '96.0.0',
  offered: '99.0.0',
  complete: true,
  releases: [
    {
      version: '99.0.0',
      date: '2026-11-05T10:00:00Z',
      url: 'https://github.com/PiwiTests/piwi/releases/tag/v99.0.0',
      body: [
        '### ⚠ BREAKING CHANGES',
        '',
        '* **app:** the insights endpoint names each worker by its lane',
        '',
        '### Features',
        '',
        '* **app:** dock the live view beside the run page ([513f252](https://github.com/PiwiTests/piwi/commit/513f252))',
        '',
        '### Bug Fixes',
        '',
        '* **app:** keep a reported history ([da47453](https://github.com/PiwiTests/piwi/commit/da47453))',
        '* **reporter:** keep run errors ([c95053f](https://github.com/PiwiTests/piwi/commit/c95053f))',
      ].join('\n'),
    },
    {
      version: '98.0.0',
      date: '2026-11-04T10:00:00Z',
      url: 'https://github.com/PiwiTests/piwi/releases/tag/v98.0.0',
      body: [
        'This release makes branches a first-class dimension.',
        '',
        '## ✨ Highlights',
        '',
        '- **🌿 Branch as a first-class dimension** — Filter every page by branch.',
        '- **🎯 Test selections** — Save a set of tests.',
        '',
        '## Features',
        '',
        '### Branches',
        '',
        '- **app:** filter every page by branch',
        '',
        '<!-- notes:polished -->',
      ].join('\n'),
    },
    {
      version: '97.0.0',
      date: null,
      url: 'https://github.com/PiwiTests/piwi/releases/tag/v97.0.0',
      body: '',
    },
  ],
};

async function installFakeBridge(
  page: Page,
  outcome: 'unsupported' | 'uptodate' | 'available',
  options: FakeBridgeOptions = {},
) {
  const init = { state: outcome, opts: options, releaseNotes: RELEASE_NOTES };
  await page.addInitScript(({ state, opts, releaseNotes }) => {
    const listeners: ((event: { payload: unknown }) => void)[] = [];
    const invocations: string[] = [];
    const notifySettings: boolean[] = [];
    const found = { state: 'available', version: '99.0.0', date: null };
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
                  notify_on_startup: opts.notifyOnStartup ?? true,
                  pending: opts.pending ? found : null,
                };
              case 'desktop_set_update_notification':
                notifySettings.push(args?.enabled as boolean);
                return null;
              case 'desktop_check_update':
                return state === 'available' ? found : { state, version: null, date: null };
              case 'desktop_get_release_notes':
                if (opts.notes === 'error') throw 'GitHub limits anonymous requests; try again later';
                if (opts.notes === 'error-once' && invocations.filter((c) => c === cmd).length === 1) {
                  throw 'error sending request';
                }
                if (opts.notes === 'other-version') return { ...releaseNotes, offered: '100.0.0' };
                return releaseNotes;
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

  test('sums up the release notes of an available update', async ({ page }) => {
    await installFakeBridge(page, 'available', { pending: true });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByTestId('release-notes-summary')).toHaveText(
      /3 releases since v96\.0\.0\s*·\s*1 breaking change/,
    );
    await expect(page.getByText('🌿 Branch as a first-class dimension')).toBeVisible();
    await expect(page.getByText('🎯 Test selections')).toBeVisible();
    const invocations = await page.evaluate(() => window.__piwiUpdateInvocations);
    expect(invocations.filter((cmd) => cmd === 'desktop_get_release_notes')).toHaveLength(1);
  });

  test('opens every release, breaking changes first, and installs from there', async ({ page }) => {
    await installFakeBridge(page, 'available');
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Check for updates' }).click();
    await page.getByRole('button', { name: "What's new" }).click();
    const dialog = page.getByRole('dialog', { name: "What's new since v96.0.0" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Full diff on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/PiwiTests/piwi/compare/v96.0.0...v99.0.0',
    );

    const breaking = dialog.getByTestId('release-notes-breaking');
    await expect(breaking).toContainText('1 breaking change');
    await expect(breaking).toContainText('the insights endpoint names each worker by its lane');
    await expect(breaking).toContainText('v99.0.0');

    // The newest release is open, without its breaking change again; its fixes fold behind their count.
    const newest = dialog.locator('[data-release="99.0.0"]');
    await expect(newest).toContainText('dock the live view beside the run page');
    await expect(newest).not.toContainText('names each worker by its lane');
    await expect(newest.getByText('keep a reported history')).toBeHidden();
    await newest.getByRole('button', { name: '2 bug fixes' }).click();
    await expect(newest.getByText('keep a reported history')).toBeVisible();
    await expect(dialog.locator('[data-release="98.0.0"]')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'v98.0.0' }).click();
    await expect(dialog.locator('[data-release="98.0.0"]')).toContainText('first-class dimension');
    await dialog.getByRole('button', { name: 'v97.0.0' }).click();
    await expect(dialog.locator('[data-release="97.0.0"]')).toContainText('No notes for this release.');

    await dialog.getByRole('button', { name: 'Install update' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Restart now' })).toBeVisible();
    const invocations = await page.evaluate(() => window.__piwiUpdateInvocations);
    expect(invocations).toContain('desktop_install_update');
  });

  test('still installs when the release notes cannot be read', async ({ page }) => {
    await installFakeBridge(page, 'available', { pending: true, notes: 'error' });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(
      page.getByText("What's new is unavailable: GitHub limits anonymous requests; try again later."),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read the release notes on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/PiwiTests/piwi/releases',
    );
    await page.getByRole('button', { name: 'Install update' }).click();
    await expect(page.getByRole('button', { name: 'Restart now' })).toBeVisible();
  });

  test('reads the release notes again on Try again after a failure', async ({ page }) => {
    await installFakeBridge(page, 'available', { pending: true, notes: 'error-once' });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByText("What's new is unavailable: error sending request.")).toBeVisible();
    await page.getByRole('button', { name: 'try again' }).click();
    await expect(page.getByTestId('release-notes-summary')).toContainText('3 releases since v96.0.0');
  });

  test('refuses release notes the shell read for another version', async ({ page }) => {
    await installFakeBridge(page, 'available', { pending: true, notes: 'other-version' });
    await page.goto('/settings/about');
    await waitForHydration(page);

    await expect(page.getByText('the notes found are for v100.0.0')).toBeVisible();
    await expect(page.getByTestId('release-notes-summary')).toHaveCount(0);
  });

  test('reads no release notes without an update on offer', async ({ page }) => {
    await installFakeBridge(page, 'uptodate');
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Check for updates' }).click();
    await expect(page.getByText("You're on the latest version.")).toBeVisible();
    const invocations = await page.evaluate(() => window.__piwiUpdateInvocations);
    expect(invocations).not.toContain('desktop_get_release_notes');
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
