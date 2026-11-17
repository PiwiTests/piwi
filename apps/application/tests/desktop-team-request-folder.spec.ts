import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * A team instance's run request for a project with no folder on this machine, driven against the regular web build
 * with a faked Tauri bridge and a stubbed event stream: the dialog says which folder the project needs, **Find it for
 * me** lists what the shell found, and a found folder is linked by its search and its place in the shell's list.
 */

interface Invocation {
  cmd: string;
  args: Record<string, unknown> | undefined;
}

/** A folder the shell found, as `desktop_find_request_folders` names it. */
interface FoundFolder {
  path: string;
  playwrightConfig: string;
  specsFound: number;
  source: string;
}

declare global {
  interface Window {
    __teamFolderInvocations: () => Invocation[];
  }
}

const FOUND = '/home/dev/code/acme-checkout/e2e';
const SPEC = 'tests/checkout.spec.ts';

/** The checks of the request: no folder, a linked one, or an older copy that lacks the test. */
type FolderState = 'none' | 'linked' | 'older';

function request(state: FolderState) {
  const linked = state === 'linked';
  return {
    id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    instance: 'https://piwi.example.com',
    projectId: 7,
    projectName: 'Acme Checkout',
    tests: [{ filePath: SPEC, title: 'pays with a saved card', line: 42, projectName: 'chromium' }],
    options: { headed: false },
    source: {},
    checks:
      state === 'none'
        ? [{ id: 'folder', level: 'fail', message: 'No folder is linked to this project on this machine.' }]
        : [
            { id: 'folder', level: 'ok', message: `Linked folder: ${FOUND}` },
            linked
              ? { id: 'specs', level: 'ok', message: 'The specs are in the folder.' }
              : { id: 'specs', level: 'fail', message: `Not in the folder: ${SPEC}.` },
          ],
    runnable: linked,
    command: linked ? `npx playwright test ${SPEC}:42` : '',
    hasFolder: state !== 'none',
    answerBy: new Date(Date.now() + 600_000).toISOString(),
  };
}

async function openRequest(page: Page, found: FoundFolder[], state: FolderState = 'none') {
  await page.addInitScript((folders: FoundFolder[]) => {
    const invocations: Invocation[] = [];
    Object.assign(window, {
      __teamFolderInvocations: () => invocations,
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            invocations.push({ cmd, args });
            if (cmd === 'desktop_find_request_folders') return { search: 3, folders, complete: true };
            if (cmd === 'desktop_link_request_folder') {
              const place = args?.found;
              return typeof place === 'number' && args?.search === 3 ? (folders[place]?.path ?? null) : null;
            }
            return null;
          },
        },
        event: { listen: async () => () => {} },
        window: { getCurrentWindow: () => ({ label: 'main' }) },
      },
    });
  }, found);
  await page.route('**/api/desktop/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'run-request', request: request(state) })}\n\n`,
    }),
  );
  await page.route('**/api/desktop/run-target/requests/*/plan', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(request('linked')) }),
  );
  await page.goto('/');
  await waitForHydration(page);
  const dialog = page.getByRole('dialog', { name: 'Run on this machine?' });
  const folder = dialog.getByTestId('team-run-request-folder');
  await expect(folder).toBeVisible();
  return { dialog, folder };
}

async function invocationOf(page: Page, cmd: string): Promise<Invocation | undefined> {
  return await page.evaluate((name) => window.__teamFolderInvocations().find((i) => i.cmd === name), cmd);
}

test.describe('Desktop team request folder', () => {
  test('finds the folder on this machine and links it by its search and place', async ({ page }) => {
    const { dialog, folder } = await openRequest(page, [
      { path: FOUND, playwrightConfig: 'playwright.config.ts', specsFound: 1, source: 'search' },
    ]);
    await expect(folder.getByText("Piwi needs your copy of Acme Checkout's code on this computer")).toBeVisible();

    await folder.getByRole('button', { name: 'Find it for me' }).click();

    await expect(folder.getByText('Found on this computer')).toBeVisible();
    await expect(folder.getByText('and the test file.')).toBeVisible();
    expect((await invocationOf(page, 'desktop_find_request_folders'))!.args).toEqual({ projectId: '7', specs: [SPEC] });

    await folder.getByRole('button', { name: `Use ${FOUND}` }).click();

    await expect(dialog.getByText(`Linked folder: ${FOUND}`)).toBeVisible();
    await expect(folder).toBeHidden();
    expect((await invocationOf(page, 'desktop_link_request_folder'))!.args).toEqual({
      projectId: '7',
      specs: [SPEC],
      found: 0,
      search: 3,
    });
  });

  test('says what to do when no copy of the code is found, and can look again', async ({ page }) => {
    const { folder } = await openRequest(page, []);

    await folder.getByRole('button', { name: 'Find it for me' }).click();

    await expect(
      folder.getByText("No copy of Acme Checkout's code was found in the usual places on this computer."),
    ).toBeVisible();
    await expect(folder.getByRole('button', { name: 'Look again' })).toBeVisible();
    await expect(folder.getByRole('button', { name: 'Choose the folder…' })).toBeEnabled();
  });

  test('names an older copy of the code that lacks the tests', async ({ page }) => {
    const { folder } = await openRequest(page, [], 'older');

    await expect(folder.getByText('The linked folder lacks some of these tests')).toBeVisible();
    await folder.getByRole('button', { name: 'Find it for me' }).click();
    await expect(folder.getByText("No other copy of Acme Checkout's code was found")).toBeVisible();
  });
});
