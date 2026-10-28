import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';
import { fakeJetbrainsIdes } from './utils/fake-jetbrains';

/**
 * Open in IDE through the Piwi JetBrains plugin: the dashboard asks every port
 * a JetBrains IDE's built-in server may take (`/api/piwi/open?…&check=1`), then
 * has the IDE that holds the file open it, and reports what the IDE answered.
 * The IDEs are faked by intercepting those requests in the browser, so an IDE
 * running on the machine never answers.
 */

async function openTheSettings(page: Page) {
  await page.goto('/');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'Configuration' }).click();
  await page.getByRole('menuitem', { name: 'Open in IDE…' }).click();
  await expect(page.getByRole('dialog').filter({ hasText: 'Click a source path anywhere' })).toBeVisible();
}

test.describe('Open in IDE through the Piwi JetBrains plugin', () => {
  test('opens the file in the IDE that holds it, the configured product first', async ({ page }) => {
    const seen = await fakeJetbrainsIdes(page, [
      { port: 63342, ide: 'WebStorm', holds: true },
      { port: 63343, ide: 'Rider', holds: true },
    ]);
    await page.addInitScript(() =>
      localStorage.setItem('piwi-ide-prefs', JSON.stringify({ method: 'auto', jetbrainsProduct: 'rider' })),
    );
    await openTheSettings(page);

    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect(page.getByText('Opened in Rider', { exact: true })).toBeVisible();

    const checks = seen.filter((u) => u.searchParams.has('check'));
    expect(new Set(checks.map((u) => Number(u.port)))).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => 63342 + i)),
    );
    const opens = seen.filter((u) => !u.searchParams.has('check'));
    expect(opens.map((u) => `${u.port} ${u.searchParams.get('file')}:${u.searchParams.get('line')}`)).toEqual([
      '63343 package.json:1',
    ]);

    // The next click asks the IDE that answered alone.
    seen.length = 0;
    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect.poll(() => seen.length).toBe(2);
    expect(seen.map((u) => u.port)).toEqual(['63343', '63343']);
  });

  test('says which IDE is running when none of its projects holds the file', async ({ page }) => {
    await fakeJetbrainsIdes(page, [{ port: 63342, ide: 'WebStorm', holds: false }]);
    await page.addInitScript(() => localStorage.setItem('piwi-ide-prefs', JSON.stringify({ method: 'auto' })));
    await openTheSettings(page);

    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect(page.getByText('Not found in WebStorm', { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        'None of the projects open in WebStorm (other-app) holds package.json. Open the project that contains it.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
  });

  test('does not ask the plugin for VS Code', async ({ page }) => {
    const seen = await fakeJetbrainsIdes(page, [{ port: 63342, ide: 'Rider', holds: true }]);
    await page.addInitScript(() =>
      localStorage.setItem('piwi-ide-prefs', JSON.stringify({ method: 'vscode', defaultRoot: '/home/me/shop' })),
    );
    await openTheSettings(page);

    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect(page.getByText('Opening VS Code…', { exact: true })).toBeVisible();
    expect(seen).toEqual([]);
  });
});

declare global {
  interface Window {
    __piwiIdeLaunches: Array<Record<string, unknown>>;
  }
}

/** Fake the desktop shell's bridge: every IDE launcher is installed and starts. */
async function fakeDesktopShell(page: Page) {
  await page.addInitScript(() => {
    const launches: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      __piwiIdeLaunches: launches,
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            if (cmd === 'desktop_open_in_ide') {
              launches.push(args ?? {});
              return true;
            }
            if (cmd === 'desktop_take_pending_open_files') return [];
            return null;
          },
        },
        event: { listen: async () => () => {} },
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  });
}

test.describe('Open in IDE in the desktop app', () => {
  test.beforeEach(async ({ page }) => {
    await fakeDesktopShell(page);
    await page.addInitScript(() =>
      localStorage.setItem(
        'piwi-ide-prefs',
        JSON.stringify({ method: 'auto', defaultRoot: '/home/me/shop', jetbrainsProduct: 'rider' }),
      ),
    );
  });

  test('starts the JetBrains launcher first when a JetBrains IDE is running', async ({ page }) => {
    await fakeJetbrainsIdes(page, [{ port: 63342, ide: 'Rider', holds: false }]);
    await openTheSettings(page);

    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect(page.getByText('Opened in JetBrains', { exact: true })).toBeVisible();
    const launches = await page.evaluate(() => window.__piwiIdeLaunches);
    expect(launches).toEqual([
      { command: 'rider', family: 'jetbrains', path: '/home/me/shop/package.json', line: 1, column: null },
    ]);
  });

  test('starts VS Code first when no JetBrains IDE is running', async ({ page }) => {
    await fakeJetbrainsIdes(page, []);
    await openTheSettings(page);

    await page.getByRole('button', { name: 'Open package.json' }).click();
    await expect(page.getByText('Opened in VS Code', { exact: true })).toBeVisible();
    const launches = await page.evaluate(() => window.__piwiIdeLaunches);
    expect(launches.map((l) => l.command)).toEqual(['code']);
  });
});
