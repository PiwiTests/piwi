import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * Desktop-only conveniences around a project's linked folder, driven against
 * the regular web build with a faked Tauri bridge and a stubbed local-import
 * route (the route itself is desktop-only and 404s here):
 *   - the project page's Link folder button opens Settings at the Local folder
 *     section;
 *   - linking a folder to a project offers to import the runs already in it; and
 *   - the import page's browse button opens the native picker at the linked
 *     project folder and imports the chosen files straight from disk.
 */

interface Archive {
  path: string;
  name: string;
  size: number;
  kind: 'blob' | 'trace' | null;
}

interface BridgeOptions {
  link?: { path: string; exists: boolean } | null;
  importableRuns?: Archive[];
  pickedFiles?: Archive[];
  pickFolder?: string;
}

interface Invocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

declare global {
  interface Window {
    __piwiInvocations: () => Invocation[];
  }
}

/** A stubbed, successful local-import response — the route captures each body. */
function importResponse() {
  return JSON.stringify({
    status: 'imported',
    kind: 'trace',
    runId: 4321,
    projectId: 1,
    runStatus: 'passed',
    startTime: new Date().toISOString(),
    totalTests: 1,
    passedTests: 1,
    failedTests: 0,
    skippedTests: 0,
    didNotRunTests: 0,
    flakyTests: 0,
    traceCount: 0,
    attachmentCount: 0,
    playwrightVersion: null,
    projectNames: [],
    filePaths: [],
    shard: null,
  });
}

async function installFakeBridge(page: Page, options: BridgeOptions = {}) {
  await page.addInitScript((opts: BridgeOptions) => {
    const invocations: Invocation[] = [];
    let link = opts.link ?? null;
    Object.assign(window, {
      __piwiInvocations: () => invocations,
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return link;
              case 'desktop_inspect_folder':
                return {
                  path: (args?.path as string) ?? '/home/dev/acme',
                  exists: true,
                  packageName: 'acme',
                  suggestedName: 'acme',
                  playwrightConfig: 'playwright.config.ts',
                  playwrightInstalled: true,
                  reporterInstalled: true,
                  reporterConfigured: true,
                  configuredProjectName: null,
                  webServer: false,
                };
              case 'desktop_pick_folder':
                return opts.pickFolder ?? '/home/dev/acme';
              case 'desktop_set_project_link':
                link = args?.path ? { path: args.path as string, exists: true } : null;
                return null;
              case 'desktop_find_importable_runs':
                return opts.importableRuns ?? [];
              case 'desktop_pick_import_files':
                return opts.pickedFiles ?? [];
              case 'desktop_get_service_settings':
                return { run_in_background: false, start_on_login: false };
              case 'desktop_check_update':
                return { state: 'unsupported' };
              case 'desktop_mcp_clients':
                return [];
              case 'desktop_take_pending_open_files':
                return [];
              default:
                return null;
            }
          },
        },
        event: { listen: async () => () => {} },
      },
    });
  }, options);
}

test.describe('Desktop import of previous runs', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_IMPORT_PREV,
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

    const menu = await (await request.get('/api/projects/menu')).json();
    const project = (menu.items as { id: number; name: string }[]).find((p) => p.name === PROJECT.DESKTOP_IMPORT_PREV);
    expect(project).toBeTruthy();
    projectId = project!.id;
  });

  test('the Link folder button opens Settings at the Local folder section', async ({ page }) => {
    await installFakeBridge(page, { link: null });

    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await page.getByRole('link', { name: 'Link folder' }).click();

    await page.waitForURL(new RegExp(`/projects/${projectId}\\?tab=settings#local-folder`));
    await expect(page.locator('#local-folder')).toBeInViewport();
  });

  test('linking a folder offers to import the runs already in it', async ({ page }) => {
    await installFakeBridge(page, {
      link: null,
      importableRuns: [
        { path: '/home/dev/acme/blob-report/report-1.zip', name: 'report-1.zip', size: 2000, kind: 'blob' },
        {
          path: '/home/dev/acme/test-results/checkout-chromium/trace.zip',
          name: 'trace.zip',
          size: 800,
          kind: 'trace',
        },
      ],
    });

    const importBodies: Record<string, unknown>[] = [];
    await page.route('**/api/desktop/import-local', async (route) => {
      importBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: importResponse() });
    });

    await page.goto(`/projects/${projectId}?tab=settings&section=local-folder`);
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Choose folder…' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Import previous runs' })).toBeVisible();
    await expect(dialog.getByText('1 blob report and 1 trace')).toBeVisible();
    await expect(dialog.getByText('report-1.zip', { exact: true })).toBeVisible();
    await expect(dialog.getByText('trace.zip', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: /^Import 2$/ }).click();

    await expect(dialog.getByText('Imported').first()).toBeVisible();
    expect(importBodies).toHaveLength(2);
    expect(importBodies.map((b) => b.path).sort()).toEqual([
      '/home/dev/acme/blob-report/report-1.zip',
      '/home/dev/acme/test-results/checkout-chromium/trace.zip',
    ]);
    expect(importBodies.every((b) => b.projectName === PROJECT.DESKTOP_IMPORT_PREV)).toBe(true);
    // A batch of more than one archive shares a group, so the traces gather into
    // one run; blob reports ignore it.
    const groups = importBodies.map((b) => b.importGroup as string);
    expect(groups[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(groups[1]).toBe(groups[0]);
  });

  test('the import page browse button opens at the project folder and imports the picks', async ({ page }) => {
    await installFakeBridge(page, {
      link: { path: '/home/dev/acme', exists: true },
      pickedFiles: [{ path: '/home/dev/acme/blob-report/report-9.zip', name: 'report-9.zip', size: 3000, kind: null }],
    });

    const importBodies: Record<string, unknown>[] = [];
    await page.route('**/api/desktop/import-local', async (route) => {
      importBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: importResponse() });
    });

    await page.goto(`/projects/${projectId}/import`);
    await waitForHydration(page);

    await expect(page.getByText('Opens in /home/dev/acme')).toBeVisible();

    await page.getByRole('button', { name: 'Choose files' }).click();
    await expect(page.getByText('report-9.zip', { exact: true })).toBeVisible();

    // The native picker is pointed at the linked project folder.
    const picked = await page.evaluate(() =>
      window.__piwiInvocations().find((i) => i.cmd === 'desktop_pick_import_files'),
    );
    expect(picked!.args!.defaultPath).toBe('/home/dev/acme');

    await page.getByRole('button', { name: /^Import 1 archive$/ }).click();

    await expect(page.getByText('Imported').first()).toBeVisible();
    expect(importBodies).toHaveLength(1);
    expect(importBodies[0]!.path).toBe('/home/dev/acme/blob-report/report-9.zip');
    expect(importBodies[0]!.projectName).toBe(PROJECT.DESKTOP_IMPORT_PREV);
  });
});
