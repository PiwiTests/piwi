import { test, expect } from './fixtures';
import { waitForHydration } from './utils';

/**
 * The user menu's theme choices — accent color, gray tone and the
 * system/light/dark appearance — are saved in cookies, so a reload keeps them
 * and the server renders the saved colors from the first byte.
 */

test.describe('Theme preferences', () => {
  test('keeps the chosen accent color, gray tone and appearance across a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await waitForHydration(page);
    const menuButton = page.getByRole('button', { name: 'Settings', exact: true });

    await menuButton.click();
    await page.getByRole('menuitem', { name: /^Theme/ }).hover();
    await page.getByRole('menuitem', { name: /^Accent color/ }).hover();
    await page.getByRole('menuitemcheckbox', { name: 'Blue' }).click();
    await page.getByRole('menuitem', { name: /^Gray tone/ }).hover();
    await page.getByRole('menuitemcheckbox', { name: 'Stone' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    await menuButton.click();
    await page.getByRole('menuitem', { name: /^Appearance/ }).hover();
    await page.getByRole('menuitemcheckbox', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    const ssrHtml = await (await page.request.get('/')).text();
    expect(ssrHtml).toContain('--ui-color-primary-500: var(--color-blue-500');
    expect(ssrHtml).toContain('--ui-color-neutral-500: var(--color-stone-500');

    await page.reload();
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string) => style.getPropertyValue(name).trim();
      return {
        primary: read('--ui-color-primary-500') === read('--color-blue-500'),
        neutral: read('--ui-color-neutral-500') === read('--color-stone-500'),
      };
    });
    expect(colors).toEqual({ primary: true, neutral: true });

    await menuButton.click();
    await page.getByRole('menuitem', { name: /^Appearance/ }).hover();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dark' })).toBeChecked();
    await page.getByRole('menuitemcheckbox', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
  });
});
