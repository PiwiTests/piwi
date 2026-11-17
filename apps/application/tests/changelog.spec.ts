import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The Changelog window: the changelog shipped with the build, opened from
 * Settings → About and from the user menu, the running version's release
 * marked and open, older releases read a page at a time.
 */

test.describe('Changelog', () => {
  test('opens from Settings → About on the running version, and reads older releases', async ({ page, request }) => {
    const { appVersion } = (await (await request.get('/api/version')).json()) as { appVersion: string };
    await page.goto('/settings/about');
    await waitForHydration(page);

    await page.getByTestId('about-changelog').click();
    const dialog = page.getByRole('dialog', { name: 'Changelog' });
    await expect(dialog.getByText(`You are on v${appVersion}`)).toBeVisible();

    const current = dialog.locator(`[data-release="${appVersion}"]`);
    await expect(current).toBeVisible();
    await expect(dialog.getByTestId('release-notes-current')).toHaveCount(1);
    await expect(current.getByRole('link', { name: 'Release page' })).toHaveAttribute(
      'href',
      new RegExp(`/releases/tag/v${appVersion.replace(/\./g, '\\.')}$`),
    );

    const folds = dialog.getByRole('button', { name: /^v\d+\.\d+\.\d+/ });
    await expect(folds).toHaveCount(10);
    await dialog.getByTestId('changelog-older').click();
    await expect(folds).toHaveCount(20);
  });

  test('opens from the user menu', async ({ page }) => {
    await page.goto('/projects');
    await waitForHydration(page);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Changelog' }).click();
    await expect(page.getByRole('dialog', { name: 'Changelog' }).locator('[data-release]').first()).toBeVisible();
  });
});
