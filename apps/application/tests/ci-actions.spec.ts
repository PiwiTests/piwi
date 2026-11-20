import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * A project's CI actions, in the CI section of its settings: a list of named
 * actions, each with its own target, inputs, what it accepts, an environment
 * and defaults, a CI server action naming the credential it sends. A value
 * with no actions list is converted when it is read.
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

  test('a value with no actions list is read as CI actions', async ({ request }) => {
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

  test('a label in the action editor toggles its own control, and every control has its own id', async ({
    page,
    request,
  }) => {
    await request.patch(`/api/projects/${projectId}`, {
      data: { ciRerun: { enabled: true, actions: [], defaults: {} } },
    });
    await page.goto(`/projects/${projectId}?tab=settings&section=ci`);
    await waitForHydration(page);

    const enabled = page.getByTestId('ci-actions-enabled');
    await expect(enabled).toBeChecked();
    await page.getByTestId('ci-action-add').click();
    const editor = page.getByTestId('ci-action-editor');

    await editor.getByText('Flake Lab', { exact: true }).click();
    await expect(editor.getByRole('checkbox', { name: 'Flake Lab', exact: true })).toBeChecked();
    await editor.getByText('Default for Flake Lab', { exact: true }).click();
    await expect(editor.getByRole('switch', { name: 'Default for Flake Lab', exact: true })).toBeChecked();
    await expect(enabled).toBeChecked();

    const repeated = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    });
    expect(repeated).toEqual([]);
  });

  test('add an action, duplicate it, make it the default, save and reload', async ({ page, request }) => {
    await request.patch(`/api/projects/${projectId}`, { data: { ciRerun: null } });
    await page.goto(`/projects/${projectId}?tab=settings&section=ci`);
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

    await page.getByTestId('ci-save').click();
    await expect(page.getByText('CI saved', { exact: true })).toBeVisible();

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

  test('the CI actions are in the CI section, not in Source control', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=source-control`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { name: 'Source control', exact: true })).toBeVisible();
    await expect(page.getByTestId('ci-actions')).toHaveCount(0);

    await page.getByRole('button', { name: 'CI', exact: true }).click();
    await expect(page).toHaveURL(/[?&]section=ci/);
    await expect(page.getByRole('heading', { name: 'CI', exact: true })).toBeVisible();
    await expect(page.getByTestId('ci-actions')).toBeVisible();
  });

  test('an action needs a name no other action has', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=ci`);
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

    await page.goto(`/projects/${projectId}?tab=settings&section=ci`);
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

  test('a CI server action names a credential shared with the project, and the editor says it is sent', async ({
    page,
    request,
  }) => {
    const NAMES = ['E2E CI actions · shared', 'E2E CI actions · elsewhere'];
    const listed = (await (await request.get('/api/credentials')).json()) as {
      credentials: Array<{ id: number; name: string }>;
    };
    for (const stale of listed.credentials.filter((c) => NAMES.includes(c.name))) {
      expect((await request.delete(`/api/credentials/${stale.id}`)).ok()).toBeTruthy();
    }
    const create = async (name: string, projectIds: number[]) => {
      const res = await request.post('/api/credentials', {
        data: {
          name,
          service: 'ci-server',
          user: 'piwi-bot',
          secret: 'e2e-secret',
          destination: 'https://ci-a.example.com/',
          scope: { allProjects: false, projectIds },
        },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as { credential: { id: number } & Record<string, unknown> };
      expect(JSON.stringify(body)).not.toContain('e2e-secret');
      return body.credential.id;
    };
    const shared = await create(NAMES[0]!, [projectId]);
    const elsewhere = await create(NAMES[1]!, []);

    const action = (credentialId: number, baseUrl?: string) => ({
      id: 'jenkins',
      name: 'Jenkins',
      target: {
        type: 'ci-server',
        preset: 'jenkins',
        credentialId,
        ...(baseUrl ? { baseUrl } : {}),
        fields: { job: 'e2e' },
      },
      inputs: [],
      accepts: ['tests'],
    });
    const save = (data: Record<string, unknown>) => request.patch(`/api/projects/${projectId}`, { data });
    const token = await save({ ciServerToken: 'secret' });
    expect(token.status()).toBe(400);
    const outside = await save({
      ciRerun: { enabled: true, actions: [action(shared, 'https://ci-b.example.com/')], defaults: {} },
    });
    expect(outside.status()).toBe(400);
    expect(((await outside.json()) as { message: string }).message).toContain('is not under');
    const notShared = await save({ ciRerun: { enabled: true, actions: [action(elsewhere)], defaults: {} } });
    expect(notShared.status()).toBe(400);
    expect(((await notShared.json()) as { message: string }).message).toContain('is shared with this project');
    const ok = await save({ ciRerun: { enabled: true, actions: [action(shared)], defaults: {} } });
    expect(ok.ok()).toBeTruthy();

    await page.goto(`/projects/${projectId}?tab=settings&section=ci`);
    await waitForHydration(page);
    await page.getByTestId('ci-action-row').filter({ hasText: 'Jenkins' }).getByTestId('ci-action-edit').click();
    await expect(page.getByTestId('ci-server-credential-description')).toContainText(`“${NAMES[0]}” is sent`);
    await expect(page.getByTestId('ci-server-target')).toContainText('https://ci-a.example.com/job/e2e/');

    const credential = (await (await request.get(`/api/credentials/${shared}`)).json()) as {
      credential: { usedBy: Array<{ projectId: number; actionId: string }> };
    };
    expect(credential.credential.usedBy).toEqual([expect.objectContaining({ projectId, actionId: 'jenkins' })]);
    expect((await request.delete(`/api/credentials/${shared}`)).status()).toBe(409);
    expect((await save({ ciRerun: null })).ok()).toBeTruthy();
    expect((await request.delete(`/api/credentials/${shared}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/credentials/${elsewhere}`)).ok()).toBeTruthy();
  });
});
