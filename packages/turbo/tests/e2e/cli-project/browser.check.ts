import { test } from '@playwright/test';

test('reports whether its browser was launched early, and the time zone its page sees', async ({ browser, page }) => {
  const early = (browser as unknown as Record<symbol, unknown>)[Symbol.for('piwi-turbo.early-browser')] === true;
  console.log(`early browser: ${early}`);
  await page.goto('data:text/html,<p>time</p>');
  console.log(`page time zone: ${await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)}`);
});
