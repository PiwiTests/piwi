import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * A project's run variables: set in Project → Settings → Run variables, checked as they are typed and when they are
 * saved, and at the start of the retry command a run's page copies.
 */

/** A run of the project with one failed test, and the project's id. */
async function failedRun(request: APIRequestContext): Promise<{ runId: number; projectId: number }> {
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.RUN_VARIABLES,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      testCases: [
        {
          title: 'pays with a saved card',
          status: 'failed',
          error: 'Error: expect(received).toBe(expected)',
          duration: 10,
          location: 'tests/checkout.spec.ts:12:1',
        },
      ],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { runId } = (await submitted.json()) as { runId: number };
  const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as { projectId: number };
  return { runId, projectId: run.projectId };
}

test.describe('Run variables', () => {
  test('a Project admin sets them, a refused name cannot be saved, and the retry command starts with them', async ({
    page,
    request,
    context,
  }) => {
    const { runId, projectId } = await failedRun(request);
    await request.patch(`/api/projects/${projectId}`, { data: { runVariables: [] } });

    await page.goto(`/projects/${projectId}?tab=settings&section=run-variables`);
    await waitForHydration(page);
    const section = page.locator('[data-shot="project-run-variables-settings"]');
    await expect(section.getByText('No run variables: runs get none.')).toBeVisible();
    const save = section.getByRole('button', { name: 'Save changes' });

    await section.getByRole('button', { name: 'Add a variable' }).click();
    await section.getByRole('textbox', { name: 'Name of run variable 1' }).fill('NODE_OPTIONS');
    await section.getByRole('textbox', { name: 'Value of run variable 1' }).fill('--require ./x.js');
    await expect(section.getByRole('alert')).toHaveText(/NODE_OPTIONS is not a variable a project can set/);
    await expect(save).toBeDisabled();

    await section.getByRole('textbox', { name: 'Name of run variable 1' }).fill('TENANT');
    await section.getByRole('textbox', { name: 'Value of run variable 1' }).fill('acme');
    await expect(section.getByRole('alert')).toHaveCount(0);
    // The shell picked here is the one every copy button of the app copies for.
    await section.getByRole('tab', { name: 'Windows (PowerShell)' }).click();
    await expect(section.getByText("$env:TENANT='acme'; npx playwright test")).toBeVisible();
    await section.getByRole('tab', { name: 'Linux / macOS' }).click();
    await expect(section.getByText('TENANT=acme npx playwright test')).toBeVisible();
    await save.click();
    await expect(page.getByText('Run variables saved').first()).toBeVisible();
    const stored = async () =>
      ((await (await request.get(`/api/projects/${projectId}/run-variables`)).json()) as { runVariables: unknown })
        .runVariables;
    expect(await stored()).toEqual([{ name: 'TENANT', value: 'acme' }]);

    // The API refuses a name the section refuses, and keeps what was saved.
    const refused = await request.patch(`/api/projects/${projectId}`, {
      data: { runVariables: [{ name: 'PIWI_PROJECT_NAME', value: 'other' }] },
    });
    expect(refused.status()).toBe(400);
    expect(await stored()).toEqual([{ name: 'TENANT', value: 'acme' }]);

    // The run's retry command starts with them, in the shell picked above.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Copy retry command' }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/^TENANT=acme npx playwright test /);

    expect((await request.patch(`/api/projects/${projectId}`, { data: { runVariables: null } })).ok()).toBeTruthy();
    expect(await stored()).toEqual([]);
  });
});
