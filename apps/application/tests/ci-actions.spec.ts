import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * A project's CI actions: the settings are a list of named actions, each with
 * its own target, inputs, what it accepts, an environment and defaults. The
 * settings of the original shape are converted when they are read.
 */
test.describe.serial('CI actions', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.CI_ACTIONS,
        status: 'passed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'opens the shop', status: 'passed', duration: 100, location: 'tests/shop.spec.ts:3:1' }],
      },
    });
    expect(res.ok()).toBeTruthy();
    projectId = ((await res.json()) as { projectId: number }).projectId;
    const reset = await request.patch(`/api/projects/${projectId}`, { data: { ciRerun: null } });
    expect(reset.ok()).toBeTruthy();
  });

  test('settings of the original shape are read as CI actions', async ({ request }) => {
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: { ciRerun: { enabled: true, github: { workflow: 'e2e.yml', ref: 'main', inputName: 'args' } } },
    });
    expect(saved.ok()).toBeTruthy();

    const project = (await (await request.get(`/api/projects/${projectId}`)).json()) as {
      ciRerun: {
        enabled: boolean;
        actions: Array<{ name: string; accepts: string[]; target: { type: string; workflow?: string } }>;
        defaults: { rerun?: string };
      };
    };
    expect(project.ciRerun.enabled).toBe(true);
    expect(project.ciRerun.actions).toHaveLength(1);
    const [action] = project.ciRerun.actions;
    expect(action).toMatchObject({ accepts: ['tests'], target: { type: 'github', workflow: 'e2e.yml' } });
    expect(project.ciRerun.defaults.rerun).toBeTruthy();
  });

  test('two actions with the same name are refused and the stored settings stay', async ({ request }) => {
    const action = (name: string) => ({
      id: name.toLowerCase().replace(/\W+/g, '-'),
      name,
      target: { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' },
      inputs: [],
      accepts: ['tests'],
    });
    const res = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: { enabled: true, actions: [action('Smoke'), { ...action('smoke'), id: 'other' }], defaults: {} },
      },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('names must be unique');

    const project = (await (await request.get(`/api/projects/${projectId}`)).json()) as {
      ciRerun: { actions: Array<{ target: { type: string } }> };
    };
    expect(project.ciRerun.actions.map((a) => a.target.type)).toEqual(['github']);
  });

  test('add an action, duplicate it, make it the default, save and reload', async ({ page, request }) => {
    await request.patch(`/api/projects/${projectId}`, { data: { ciRerun: null } });
    await page.goto(`/projects/${projectId}?tab=settings&section=source-control`);
    await waitForHydration(page);

    const settings = page.getByTestId('ci-actions');
    await settings.getByTestId('ci-actions-enabled').click();
    await expect(settings.getByTestId('ci-actions-empty')).toBeVisible();

    await settings.getByTestId('ci-action-add').click();
    const editor = page.getByTestId('ci-action-editor');
    await editor.getByTestId('ci-action-name').fill('Smoke · staging');
    await editor.getByTestId('ci-action-github-workflow').fill('e2e.yml');
    await editor.getByTestId('ci-action-add-input').click();
    await editor.getByLabel('Input 1 name').fill('TARGET_ENV');
    await editor.getByLabel('Input 1 value').fill('staging');
    await editor.getByTestId('ci-action-default-tests').click();
    await page.getByTestId('ci-action-save').click();

    const rows = settings.getByTestId('ci-action-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Smoke · staging');
    await expect(rows.first()).toContainText('Default for re-runs');
    await expect(rows.first()).toContainText('TARGET_ENV=staging');

    await rows.first().getByTestId('ci-action-duplicate').click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).getByTestId('ci-action-row-name')).toHaveText('Smoke · staging (copy)');
    await expect(rows.nth(1)).not.toContainText('Default for re-runs');

    // Make the copy the default for re-runs: the badge moves.
    await rows.nth(1).getByTestId('ci-action-edit').click();
    await editor.getByTestId('ci-action-default-tests').click();
    await page.getByTestId('ci-action-save').click();
    await expect(rows.nth(1)).toContainText('Default for re-runs');
    await expect(rows.first()).not.toContainText('Default for re-runs');

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Source control saved', { exact: true })).toBeVisible();

    await page.reload();
    await waitForHydration(page);
    const reloaded = page.getByTestId('ci-actions').getByTestId('ci-action-row');
    await expect(reloaded).toHaveCount(2);
    await expect(reloaded.nth(1)).toContainText('Smoke · staging (copy)');
    await expect(reloaded.nth(1)).toContainText('Default for re-runs');
    await expect(reloaded.first()).toContainText('TARGET_ENV=staging');

    const stored = (await (await request.get(`/api/projects/${projectId}`)).json()) as {
      ciRerun: { actions: Array<{ id: string; name: string }>; defaults: { rerun?: string } };
    };
    expect(stored.ciRerun.defaults.rerun).toBe(stored.ciRerun.actions[1]!.id);
  });

  test('an action needs a name no other action has', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=source-control`);
    await waitForHydration(page);

    await page.getByTestId('ci-action-add').click();
    const editor = page.getByTestId('ci-action-editor');
    await editor.getByTestId('ci-action-name').fill('smoke · STAGING');
    await editor.getByTestId('ci-action-github-workflow').fill('other.yml');
    await page.getByTestId('ci-action-save').click();
    await expect(editor.getByTestId('ci-action-error')).toContainText('names must be unique');
    await expect(page.getByTestId('ci-actions').getByTestId('ci-action-row')).toHaveCount(2);
  });

  test('Check on a GitLab action says what cannot be checked', async ({ page, request }) => {
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'gitlab-rerun',
              name: 'Re-run on GitLab',
              target: { type: 'gitlab', ref: 'main', argsVariable: 'PIWI_RERUN_ARGS' },
              inputs: [],
              accepts: ['tests'],
            },
          ],
          defaults: { rerun: 'gitlab-rerun' },
        },
      },
    });
    expect(saved.ok()).toBeTruthy();

    await page.goto(`/projects/${projectId}?tab=settings&section=source-control`);
    await waitForHydration(page);
    const row = page.getByTestId('ci-action-row');
    await row.getByTestId('ci-action-check').click();
    await expect(row.getByTestId('ci-action-check-result')).toContainText("GitLab pipelines can't be checked");
  });

  test('Check answers for an action that is not saved yet', async ({ request }) => {
    const res = await request.post(`/api/projects/${projectId}/ci-actions/new/check`, {
      data: {
        action: {
          id: 'new',
          name: 'Bitbucket re-run',
          target: { type: 'bitbucket', pipeline: 'rerun', argsVariable: 'PIWI_RERUN_ARGS' },
          inputs: [],
          accepts: ['tests'],
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ ok: null, missing: [] });
  });
});
