import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * Settings → Source control holds the instance-wide SCM token, the one setting
 * the AI settings endpoint stores as `scm_token`; the AI page links to it.
 */
test.describe.serial('Settings → Source control', () => {
  test.afterAll(async ({ request }) => {
    await request.put('/api/settings/ai', { data: { scmToken: null } });
  });

  test('stores the instance-wide SCM token, then removes it', async ({ page, request }) => {
    await request.put('/api/settings/ai', { data: { scmToken: null } });
    await page.goto('/settings/source-control');
    await waitForHydration(page);

    await page.getByRole('textbox', { name: 'SCM token' }).fill('ghp_source_control_settings_test');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('A token is stored, encrypted.')).toBeVisible();
    expect((await (await request.get('/api/settings/ai')).json()).hasScmToken).toBe(true);

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'SCM token' })).toBeVisible();
    expect((await (await request.get('/api/settings/ai')).json()).hasScmToken).toBe(false);
  });

  test('the AI page says where the token is set', async ({ page }) => {
    await page.goto('/settings/ai');
    await waitForHydration(page);
    const sentence = page.locator('[data-tour="ai-repository-access"]');
    await sentence.getByRole('link', { name: 'Settings → Source control' }).click();
    await expect(page).toHaveURL(/\/settings\/source-control$/);
  });
});
