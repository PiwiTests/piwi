import { test, expect } from './fixtures';

// Labeled form fields: fill/selectOption actions produce locator snapshots
// with getByLabel alternatives; the XHR POST lands in the network capture.
test('submits the contact form', async ({ page }) => {
  await page.goto('/form');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Message').fill('Hello from the example project');
  await page.getByLabel('Priority').selectOption('high');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#result')).toHaveText('Sent!');
});
