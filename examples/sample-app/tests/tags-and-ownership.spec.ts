import { test, expect } from './fixtures';

/**
 * Tags and ownership metadata. Neither changes how a test runs: they exist so
 * the dashboard can slice the suite, and so a failure can name the team that
 * owns it.
 *
 * See https://piwitests.dev/reference/test-metadata#test-tags
 */

// Playwright folds `@tag` tokens in the title into `TestCase.tags`, so this
// test is tagged `smoke` in the dashboard without any extra option.
test('loads items from the API @smoke', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('load-items').click();
  await expect(page.locator('#items li')).toHaveCount(3);
});

// The explicit option does the same thing and keeps the title readable. Both
// forms end up in the same place; use whichever your team prefers.
test('submits the contact form', { tag: ['@smoke', '@critical'] }, async ({ page }) => {
  await page.goto('/form');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Message').fill('Hello from the example project');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#result')).toHaveText('Sent!');
});

// `piwi:` annotations attach ownership. They are ordinary Playwright
// annotations. No Piwi-specific API is involved, so a project that later drops
// Piwi is left with harmless metadata rather than a broken import.
test(
  'exercises a slow endpoint',
  {
    tag: '@critical',
    annotation: [
      { type: 'piwi:owner', description: '@platform-team' },
      { type: 'piwi:priority', description: 'high' },
      { type: 'piwi:feature', description: 'API' },
      { type: 'piwi:link', description: 'https://github.com/PiwiTests/piwi/issues' },
    ],
  },
  async ({ page }) => {
    await page.goto('/slow');
    await expect(page.locator('#status')).toHaveText('done', { timeout: 5000 });
  },
);
