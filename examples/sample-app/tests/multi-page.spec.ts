import { test, expect, BASE_URL } from './fixtures';

// A test that drives two pages: Web Vitals and the failure-time ARIA snapshot
// are attributed to the most recently active page (the form page here).
test('attributes capture across multiple pages', async ({ context }) => {
  const home = await context.newPage();
  await home.goto(`${BASE_URL}/`);
  await home.getByTestId('load-items').click();
  await expect(home.locator('#items li')).toHaveCount(3);

  const form = await context.newPage();
  await form.goto(`${BASE_URL}/form`);
  await form.getByLabel('Email').fill('grace@example.com');
  await form.getByLabel('Message').fill('Second page of the same test');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.locator('#result')).toHaveText('Sent!');
});
