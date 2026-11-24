import { test, expect, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * The run button and its dialog on a project whose CI actions are a Jenkins re-run and a nightly job that runs the
 * whole suite: which actions each place offers, the row of an action that cannot take the chosen tests disabled with
 * the reason, the fields of the pick, the menu's one-click runs, and a dispatch Piwi refuses before sending it, said in
 * the dialog. The server runs without sign-in, so the person's apps are not offered.
 */
test.describe.serial('Run button', () => {
  let projectId: number;
  let runId: number;
  let clusterId: number;

  test.beforeAll(async ({ request }) => {
    const error =
      "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('pay')";
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.RUN_BUTTON,
        status: 'failed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 2000,
        totalTests: 2,
        passedTests: 0,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          { title: 'pays by card', status: 'failed', error, duration: 1000, location: 'tests/pay.spec.ts:12:5' },
          { title: 'pays by voucher', status: 'failed', error, duration: 1000, location: 'tests/pay.spec.ts:30:5' },
        ],
      },
    });
    expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    ({ projectId, runId } = (await res.json()) as { projectId: number; runId: number });
    // A base URL that resolves to this machine: the dispatch is refused before anything is sent.
    const jenkins = (id: string, name: string, job: string, accepts: string[], inputs: unknown[] = []) => ({
      id,
      name,
      target: { type: 'ci-server', preset: 'jenkins', baseUrl: 'https://localhost:9/', fields: { job } },
      inputs,
      accepts,
    });
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: {
          enabled: true,
          actions: [
            jenkins('rerun', 'Re-run e2e', 'e2e', ['tests']),
            jenkins(
              'nightly',
              'Nightly',
              'nightly',
              ['suite'],
              [{ name: 'SUITE', kind: 'choice', options: ['smoke', 'full'], default: 'smoke' }],
            ),
          ],
          defaults: { rerun: 'rerun', suite: 'nightly' },
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const clusters = (
      (await (await request.get(`/api/projects/${projectId}/failure-clusters`)).json()) as { items: { id: number }[] }
    ).items;
    expect(clusters.length).toBeGreaterThan(0);
    clusterId = clusters[0]!.id;
  });

  async function openDialog(page: Page, route: string) {
    await page.goto(route);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Run on CI' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('run-dialog-ci')).toBeVisible();
    return dialog;
  }

  test('each place renders its button on the server, as the browser shows it', async ({ request }) => {
    for (const route of [`/projects/${projectId}`, `/test-runs/${runId}`, `/failure-clusters/${clusterId}`]) {
      const html = await (await request.get(route)).text();
      expect(html, route).toContain('data-testid="run-button"');
    }
  });

  test('a cluster runs its affected tests on the action that takes re-runs', async ({ page }) => {
    const dialog = await openDialog(page, `/failure-clusters/${clusterId}`);
    await expect(dialog.getByText('Its affected tests')).toBeVisible();
    await expect(dialog.getByTestId('run-dialog-tests')).toContainText('pays by card');
    await expect(dialog.getByTestId('run-dialog-tests')).toContainText('pays by voucher');
    await expect(dialog.getByRole('radio', { name: /Re-run e2e/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Nightly/ })).toHaveCount(0);
    await expect(dialog.getByTestId('run-dialog-sentence')).toContainText('A team run');
    await expect(dialog.getByTestId('run-dialog-branch')).toContainText("Runs on the job's configured branch");
  });

  test('a run offers its failed tests and every test, each action disabled for what it does not take', async ({
    page,
  }) => {
    const dialog = await openDialog(page, `/test-runs/${runId}`);
    await expect(dialog.getByRole('radio', { name: 'The failed tests' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Re-run e2e/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Nightly/ })).toBeDisabled();
    await expect(dialog.getByTestId('run-dialog-ci')).toContainText('Does not take re-runs.');

    await dialog.getByRole('radio', { name: 'Every test' }).click();
    await expect(dialog.getByRole('radio', { name: /Nightly/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Re-run e2e/ })).toBeDisabled();
    await expect(dialog.getByTestId('run-dialog-ci')).toContainText('Does not take a whole suite.');
    await expect(dialog).toContainText('the action’s whole suite runs on the run’s branch');
  });

  test('a dispatch Piwi refuses before sending it is said in the dialog', async ({ page }) => {
    const dialog = await openDialog(page, `/failure-clusters/${clusterId}`);
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByTestId('run-dialog-error')).toContainText('URL host is not allowed', { timeout: 20_000 });
  });

  test('the project page runs the whole suite on its action, with the choice input', async ({ page }) => {
    const dialog = await openDialog(page, `/projects/${projectId}`);
    await expect(dialog.getByText('The whole suite')).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Nightly/ })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Re-run e2e/ })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: 'SUITE' })).toContainText('smoke');
  });

  test('the menu lists a one-click run for each action that takes the place’s tests', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'One-click runs' }).click();
    await expect(page.getByRole('menuitem', { name: 'Run on CI · Nightly (Jenkins)' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Re-run e2e/ })).toHaveCount(0);
  });
});
