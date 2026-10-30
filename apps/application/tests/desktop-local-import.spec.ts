import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The desktop-only local import flow: archives dropped on the window (or
 * opened with the app) land in an import dialog that posts their *paths* to
 * `/api/desktop/import-local`. Driven against the regular web build with a
 * faked Tauri bridge and a stubbed import route — the route itself is
 * desktop-only and must 404 here, which is asserted directly.
 */

/** Install a fake `window.__TAURI__` whose events the test can fire itself. */
async function installFakeBridge(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
    Object.assign(window, {
      __piwiEmit: (name: string, payload: unknown) => {
        for (const cb of listeners.get(name) ?? []) cb({ payload });
      },
      __TAURI__: {
        core: {
          invoke: async (cmd: string) => {
            if (cmd === 'desktop_take_pending_open_files') return [];
            throw new Error(`unexpected command: ${cmd}`);
          },
        },
        event: {
          listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
            const list = listeners.get(name) ?? [];
            list.push(cb);
            listeners.set(name, list);
            return () => {};
          },
        },
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  });
}

declare global {
  interface Window {
    __piwiEmit: (name: string, payload: unknown) => void;
  }
}

test.describe('Desktop local import', () => {
  test.beforeAll(async ({ request }) => {
    // The project only needs to exist so the dialog's project selector has a
    // real entry to pick.
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_LOCAL_IMPORT,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'seed',
            status: 'passed',
            duration: 1000,
            location: 'tests/seed.spec.ts:1:1',
            retries: 0,
            workerIndex: 0,
            startedAt: Date.now(),
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('the local import routes are desktop-only and 404 on the server build', async ({ request }) => {
    const res = await request.post('/api/desktop/import-local', {
      data: { path: '/tmp/trace.zip', projectName: PROJECT.DESKTOP_LOCAL_IMPORT },
    });
    expect(res.status()).toBe(404);
    const bug = await request.post('/api/desktop/import-bug-report', {
      data: { path: '/tmp/bug.piwibug', projectName: PROJECT.DESKTOP_LOCAL_IMPORT },
    });
    expect(bug.status()).toBe(404);
  });

  test('a dropped .piwibug imports as a bug report and links to it', async ({ page }) => {
    await installFakeBridge(page);

    const bugBodies: Record<string, unknown>[] = [];
    await page.route('**/api/desktop/import-bug-report', async (route) => {
      bugBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 4321, url: '/bug-reports/4321' }),
      });
    });
    await page.route('**/api/desktop/import-local', (route) => route.abort());

    await page.goto('/');
    await waitForHydration(page);

    await page.evaluate(() => {
      window.__piwiEmit('tauri://drag-drop', { paths: ['/home/dev/coupon.piwibug'], position: { x: 0, y: 0 } });
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('coupon.piwibug', { exact: true })).toBeVisible();
    await dialog.getByText('Select a project…').click();
    await page.getByRole('option', { name: PROJECT.DESKTOP_LOCAL_IMPORT }).click();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(dialog.getByRole('link', { name: 'View report' })).toHaveAttribute('href', '/bug-reports/4321');
    expect(bugBodies).toEqual([{ path: '/home/dev/coupon.piwibug', projectName: PROJECT.DESKTOP_LOCAL_IMPORT }]);
  });

  test('dropped archives open the dialog and import by path', async ({ page }) => {
    await installFakeBridge(page);

    const importBodies: Record<string, unknown>[] = [];
    await page.route('**/api/desktop/import-local', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      importBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'imported',
          kind: 'trace',
          runId: 12345,
          projectId: 1,
          runStatus: 'failed',
          startTime: new Date().toISOString(),
          totalTests: 1,
        }),
      });
    });

    await page.goto('/');
    await waitForHydration(page);

    // Drop three files — only the archives may enter the dialog.
    await page.evaluate(() => {
      window.__piwiEmit('tauri://drag-drop', {
        paths: ['/home/dev/trace-a.zip', '/home/dev/trace-b.zip', '/home/dev/notes.md'],
        position: { x: 0, y: 0 },
      });
    });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Import archives' })).toBeVisible();
    await expect(dialog.getByText('trace-a.zip', { exact: true })).toBeVisible();
    await expect(dialog.getByText('trace-b.zip', { exact: true })).toBeVisible();
    await expect(dialog.getByText('notes.md')).toHaveCount(0);

    await dialog.getByText('Select a project…').click();
    await page.getByRole('option', { name: PROJECT.DESKTOP_LOCAL_IMPORT }).click();

    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(dialog.getByText('Imported').first()).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'View run' }).first()).toHaveAttribute('href', '/test-runs/12345');

    expect(importBodies).toHaveLength(2);
    expect(importBodies.map((b) => b.path).sort()).toEqual(['/home/dev/trace-a.zip', '/home/dev/trace-b.zip']);
    expect(importBodies.every((b) => b.projectName === PROJECT.DESKTOP_LOCAL_IMPORT)).toBe(true);
    // Both files carry the same generated batch group, so traces gather into
    // one run.
    const groups = importBodies.map((b) => b.importGroup as string);
    expect(groups[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(groups[1]).toBe(groups[0]);
  });
});
