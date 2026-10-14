import { backend, unsupported } from '../backends';
import { test, expect } from './fixtures';
import { backendLogs } from './piwi-headers';

// Each response carries the server-side Warning and Error logs of its request in the X-Piwi-Logs header, and the
// fixtures attach them to the matching network request. On the dashboard, open this test's network requests:
// /api/report carries a warning and an error with its stack trace, and the 500 from /api/failing carries the
// unhandled exception.
test('backend logs ride along on the X-Piwi-Logs header', async ({ page }) => {
  test.skip(!backend.features.backendLogs, unsupported('backendLogs'));
  await page.goto('/backend');

  const report = page.waitForResponse('/api/report');
  await page.getByTestId('load-report').click();
  await expect(page.locator('#backend-result')).toHaveText('report loaded');
  const reportLogs = backendLogs((await report).headers()['x-piwi-logs']);
  expect(reportLogs?.map(({ level, message }) => ({ level, message }))).toEqual([
    { level: 'Warning', message: 'demo: low stock for item Alpha' },
    { level: 'Error', message: 'demo: price sync failed, using cached prices' },
  ]);
  expect(reportLogs?.[1]?.stack).toBeTruthy();

  const failedResponse = page.waitForResponse('/api/failing');
  await page.getByTestId('trigger-failure').click();
  const failed = await failedResponse;
  expect(failed.status()).toBe(500);
  await expect(page.locator('#backend-result')).toHaveText('backend failed as expected (500)');
  const failedLogs = backendLogs(failed.headers()['x-piwi-logs']) ?? [];
  const unhandled = failedLogs.filter((entry) =>
    `${entry.message}\n${entry.stack}`.includes('demo: inventory backend exploded'),
  );
  expect(unhandled.map((entry) => entry.level)).toEqual(['Error']);
});

// A response that logged nothing still carries the header, with no entry: the reporter fetches the route manifest
// only from an app whose responses carry it.
test('a request that logs nothing carries an empty X-Piwi-Logs header', async ({ request }) => {
  test.skip(!backend.features.backendLogs, unsupported('backendLogs'));
  const response = await request.get('/api/items');
  expect(backendLogs(response.headers()['x-piwi-logs'])).toEqual([]);
});
