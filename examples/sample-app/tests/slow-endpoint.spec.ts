import { test, expect } from './fixtures';

// The page fires one slow call (~800 ms) and two parameterized calls
// (/api/users/1 and /api/users/2). The dashboard's Slow endpoints tab groups
// the latter under the normalized route /api/users/:id.
test('exercises a slow endpoint and parameterized routes', async ({ page }) => {
  await page.goto('/slow');
  await expect(page.locator('#status')).toHaveText('done', { timeout: 5000 });
});
