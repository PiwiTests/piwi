import { backend, unsupported } from '../backends';
import { test, expect } from './fixtures';
import { serverSpans } from './piwi-headers';

// Skipped before the test takes its page, so a backend without spans leaves no page unused.
test.skip(!backend.features.serverSpans, unsupported('serverSpans'));

// The integration times each request on the server and sends its spans on the response (X-Piwi-Trace), and the
// fixtures attach them to the matching network request. On the dashboard, this test's GET /api/items shows the time
// the server spent on it.
test('each response carries the server spans of its request', async ({ page }) => {
  await page.goto('/');

  const items = page.waitForResponse('**/api/items');
  await page.getByTestId('load-items').click();
  const [root] = serverSpans((await items).headers()['x-piwi-trace']) ?? [];
  expect(root).toMatchObject({ name: 'GET /api/items', status: 'ok' });
  await expect(page.locator('#items li')).toHaveCount(3);
});
