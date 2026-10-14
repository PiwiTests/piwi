import { test, expect, BASE_URL } from './fixtures';

// Contexts created from the patched browser instrument every page they open.
test('captures pages created from a fresh context', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/form`);
  await page.getByLabel('Email').fill('lin@example.com');
  await page.getByLabel('Message').fill('From a dedicated context');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#result')).toHaveText('Sent!');
  await context.close();
});
