import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

/**
 * The SCM credentials: Settings → Source control lists the instance's (stored
 * through the AI settings endpoint), a project's Source control settings pick
 * its own, and a token is never saved anywhere else. The AI page links to the
 * instance's.
 */
const INSTANCE = 'GitHub · source control settings test';
const OWN = 'GitHub · source control project test';

async function removeTestCredentials(request: APIRequestContext) {
  await request.put('/api/settings/ai', { data: { scmCredentialIds: [] } });
  const listed = (await (await request.get('/api/credentials')).json()) as {
    credentials: Array<{ id: number; name: string }>;
  };
  for (const stale of listed.credentials.filter((c) => c.name === INSTANCE || c.name === OWN)) {
    await request.delete(`/api/credentials/${stale.id}`);
  }
}

async function createCredential(request: APIRequestContext, name: string, scope: unknown): Promise<number> {
  const res = await request.post('/api/credentials', {
    data: { name, service: 'scm', secret: 'ghp_source_control_test', destination: 'https://api.github.com/', scope },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { credential: { id: number } }).credential.id;
}

test.describe.serial('Source control credentials', () => {
  test.beforeAll(async ({ request }) => removeTestCredentials(request));
  test.afterAll(async ({ request }) => removeTestCredentials(request));

  test('Settings → Source control lists an instance credential, which cannot be deleted while listed', async ({
    page,
    request,
  }) => {
    const id = await createCredential(request, INSTANCE, { allProjects: true });
    await page.goto('/settings/source-control');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Instance repository credentials' }).click();
    await page.getByRole('option', { name: new RegExp(INSTANCE) }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => (await (await request.get('/api/settings/ai')).json()) as Record<string, unknown>)
      .toMatchObject({ hasScmToken: true, scmCredentialIds: [id] });

    expect((await request.delete(`/api/credentials/${id}`)).status()).toBe(409);
    // A token is saved as a credential, never on the instance's settings.
    expect((await request.put('/api/settings/ai', { data: { scmToken: 'ghp_x' } })).status()).toBe(400);
    // The instance lists only credentials shared with all projects.
    const narrow = await request.patch(`/api/credentials/${id}`, {
      data: { scope: { allProjects: false, projectIds: [1] } },
    });
    expect(narrow.status()).toBe(409);
    // The other specs run beside this one: the instance lists no credential past this test.
    expect((await request.put('/api/settings/ai', { data: { scmCredentialIds: [] } })).ok()).toBeTruthy();
  });

  test('a project picks its own credential in its Source control settings', async ({ page, request }) => {
    const submitted = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.SOURCE_CONTROL_CREDENTIAL,
        status: 'passed',
        startTime: new Date(Date.now() - 60_000).toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        metadata: { scm: { remoteUrl: 'https://github.com/acme/source-control-test', branch: 'main' } },
        testCases: [{ title: 'opens the shop', status: 'passed', duration: 100, location: 'tests/shop.spec.ts:3:1' }],
      },
    });
    expect(submitted.ok()).toBeTruthy();
    const projectId = ((await submitted.json()) as { projectId: number }).projectId;
    const id = await createCredential(request, OWN, { allProjects: false, projectIds: [projectId] });

    await page.goto(`/projects/${projectId}?tab=settings&section=source-control`);
    await waitForHydration(page);
    await page.getByRole('combobox', { name: 'Repository credential' }).click();
    await page.getByRole('option', { name: new RegExp(OWN) }).click();
    await expect(page.getByTestId('scm-credential-description')).toContainText(`“${OWN}” is sent to`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/projects/${projectId}`)).json()) as Record<string, unknown>)
      .toMatchObject({ scmCredentialId: id, hasScmToken: true });

    const credential = (await (await request.get(`/api/credentials/${id}`)).json()) as {
      credential: { usedBy: Array<Record<string, unknown>> };
    };
    expect(credential.credential.usedBy).toEqual([expect.objectContaining({ kind: 'project-scm', projectId })]);
    expect((await request.patch(`/api/projects/${projectId}`, { data: { scmToken: 'ghp_x' } })).status()).toBe(400);
    expect((await request.patch(`/api/projects/${projectId}`, { data: { scmCredentialId: null } })).ok()).toBeTruthy();
  });

  test('the AI page says where the credentials are set', async ({ page }) => {
    await page.goto('/settings/ai');
    await waitForHydration(page);
    const sentence = page.locator('[data-tour="ai-repository-access"]');
    await sentence.getByRole('link', { name: 'Settings → Source control' }).click();
    await expect(page).toHaveURL(/\/settings\/source-control$/);
  });
});
