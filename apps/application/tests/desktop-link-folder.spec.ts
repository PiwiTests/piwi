import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration, retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The dialog that links a project to its folder on this machine, driven against the regular web build with a faked
 * Tauri bridge: it offers the folders the shell finds from the project's runs, and when a folder picked by hand does
 * not match the project it says why and offers the folder that holds the Playwright config, or links it anyway.
 */

interface Invocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

interface BridgeOptions {
  suggestions?: unknown[];
  pickFolder?: string;
  check?: unknown;
}

declare global {
  interface Window {
    __linkFolderInvocations: () => Invocation[];
  }
}

/** The folder the project's run reports, and where the shell finds it. */
const RUN_FOLDER = '/home/dev/shop/e2e';
const SPEC = 'tests/cart.spec.ts';

/** A monorepo's root: no config, none of the tests, a clone of a fork, with the config folder below it. */
const ROOT_CHECK = {
  path: '/home/dev/shop',
  exists: true,
  playwrightConfig: null,
  specsChecked: 1,
  specsFound: 0,
  missingSpecs: [SPEC],
  repository: 'git.example.com/me/fork',
  sameRepository: false,
  fits: false,
  alternatives: [{ path: RUN_FOLDER, playwrightConfig: 'playwright.config.ts', specsFound: 1, source: 'below' }],
};

async function installFakeBridge(page: Page, options: BridgeOptions) {
  await page.addInitScript((opts: BridgeOptions) => {
    const invocations: Invocation[] = [];
    let link: { path: string; exists: boolean } | null = null;
    Object.assign(window, {
      __linkFolderInvocations: () => invocations,
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            switch (cmd) {
              case 'desktop_get_project_link':
                return link;
              case 'desktop_set_project_link':
                link = args?.path ? { path: args.path as string, exists: true } : null;
                return null;
              case 'desktop_suggest_project_folders':
                return opts.suggestions ?? [];
              case 'desktop_pick_folder':
                return opts.pickFolder ?? null;
              case 'desktop_check_project_folder':
                return opts.check ?? null;
              case 'desktop_find_importable_runs':
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

async function invocationOf(page: Page, cmd: string): Promise<Invocation | undefined> {
  return await page.evaluate((name) => window.__linkFolderInvocations().find((i) => i.cmd === name), cmd);
}

test.describe('Desktop link folder dialog', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DESKTOP_LINK_FOLDER,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        metadata: { workingDir: RUN_FOLDER, scm: { remoteUrl: 'git@git.example.com:acme/shop.git' } },
        testCases: [
          {
            title: 'adds to cart',
            status: 'passed',
            duration: 1000,
            location: `${SPEC}:3:1`,
            retries: 0,
            workerIndex: 0,
            startedAt: Date.now(),
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();

    const menu = await (await request.get('/api/projects/menu')).json();
    const project = (menu.items as { id: number; name: string }[]).find((p) => p.name === PROJECT.DESKTOP_LINK_FOLDER);
    expect(project).toBeTruthy();
    projectId = project!.id;
  });

  async function openDialog(page: Page) {
    await page.goto(`/projects/${projectId}?tab=settings&section=local-folder`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    const dialog = page.getByRole('dialog', { name: `Link ${PROJECT.DESKTOP_LINK_FOLDER} to its folder` });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('offers the folder the runs came from and links it', async ({ page }) => {
    await installFakeBridge(page, {
      suggestions: [{ path: RUN_FOLDER, playwrightConfig: 'playwright.config.ts', specsFound: 1, source: 'run' }],
    });
    const dialog = await openDialog(page);

    await expect(dialog.getByText('Found on this machine')).toBeVisible();
    await expect(dialog.getByText('A run of this project came from this folder.')).toBeVisible();
    // The shell looks for the folder with what the project's runs report.
    const suggest = await invocationOf(page, 'desktop_suggest_project_folders');
    expect(suggest!.args).toEqual({
      workingDirs: [RUN_FOLDER],
      specs: [SPEC],
      repositoryUrl: 'https://git.example.com/acme/shop',
    });

    await dialog.getByRole('button', { name: `Link ${RUN_FOLDER}` }).click();

    await expect(dialog).toBeHidden();
    expect((await invocationOf(page, 'desktop_set_project_link'))!.args!.path).toBe(RUN_FOLDER);
    await expect(page.locator('#local-folder').getByText(RUN_FOLDER)).toBeVisible();
  });

  test('says why a picked folder does not match and links the config folder below it', async ({ page }) => {
    await installFakeBridge(page, { pickFolder: '/home/dev/shop', check: ROOT_CHECK });
    const dialog = await openDialog(page);
    await expect(dialog.getByText('No folder of this project found on this machine')).toBeVisible();

    await dialog.getByRole('button', { name: 'Choose folder…' }).click();

    const check = dialog.getByTestId('desktop-link-folder-check');
    await expect(check.getByText(`This folder does not match ${PROJECT.DESKTOP_LINK_FOLDER}`)).toBeVisible();
    await expect(check.getByText('It holds no Playwright config')).toBeVisible();
    await expect(check.getByText('It holds none of the 1 test files of the latest run')).toBeVisible();
    await expect(check.getByText('It is a clone of git.example.com/me/fork')).toBeVisible();
    expect((await invocationOf(page, 'desktop_pick_folder'))!.args!.title).toBe(
      `Choose the folder of ${PROJECT.DESKTOP_LINK_FOLDER} that holds playwright.config.ts`,
    );
    expect(await invocationOf(page, 'desktop_set_project_link')).toBeUndefined();

    await expect(dialog.getByText('Did you mean')).toBeVisible();
    await dialog.getByRole('button', { name: `Link ${RUN_FOLDER}` }).click();

    await expect(dialog).toBeHidden();
    expect((await invocationOf(page, 'desktop_set_project_link'))!.args!.path).toBe(RUN_FOLDER);
  });

  test('links a folder that does not match when asked to', async ({ page }) => {
    await installFakeBridge(page, { pickFolder: '/home/dev/shop', check: ROOT_CHECK });
    const dialog = await openDialog(page);

    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await dialog.getByRole('button', { name: 'Link it anyway' }).click();

    await expect(dialog).toBeHidden();
    expect((await invocationOf(page, 'desktop_set_project_link'))!.args!.path).toBe('/home/dev/shop');
  });
});
