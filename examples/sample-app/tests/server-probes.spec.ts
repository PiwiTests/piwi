import { backend, unsupported } from '../backends';
import { test, expect } from './fixtures';
import { probeHeader, serverSpans } from './piwi-headers';

// A server probe asks the backend to fail one request on purpose: the probe run signs the fault onto the request
// (X-Piwi-Probe) and the integration applies it inside the server, then names the fault it applied on the response's
// X-Piwi-Trace. Here the test signs the header itself, to show that the home page handles the failure. The backend
// runs with server probes on (PIWI_SERVER_PROBES=true) and the sample's PIWI_PROBE_SECRET.
test('a signed server probe fails the items request inside the backend', async ({ page }) => {
  test.skip(!backend.features.serverProbes, unsupported('serverProbes'));
  await page.route('**/api/items', (route) =>
    route.continue({
      headers: { ...route.request().headers(), 'x-piwi-probe': probeHeader('GET /api/items', 'status-500') },
    }),
  );
  await page.goto('/');

  const items = page.waitForResponse('**/api/items');
  await page.getByTestId('load-items').click();
  const response = await items;
  expect(response.status()).toBe(500);
  const [root] = serverSpans(response.headers()['x-piwi-trace']) ?? [];
  expect(root?.attrs['piwi.probe.applied']).toBe('status-500');
  await expect(page.getByRole('alert')).toHaveText('Could not load the items (500).');
});
