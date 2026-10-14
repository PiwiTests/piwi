import { backend, unsupported } from '../backends';
import { test, expect } from './shop-fixtures';

// A backend running a coverage build names the coverage of each request that ran its code on the response
// (X-Piwi-Coverage). The fixtures keep the names a test's pages receive, and once the test ends the reporter asks the
// backend for their coverage. On the dashboard, this test's coverage lists the backend files and lines that placed
// the order, beside the browser scripts it ran.
test(
  'placing an order names its server coverage',
  { tag: '@shop' },
  async ({ page, signedIn, productsPage, checkoutPage, shopper }) => {
    test.skip(!backend.features.serverCoverage, unsupported('serverCoverage'));
    await productsPage.addToCart('Water bottle');
    await page.goto('/shop/checkout');

    const order = page.waitForResponse(
      (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST',
    );
    await checkoutPage.placeOrder(shopper);
    const response = await order;
    expect(response.status()).toBe(201);
    expect(response.headers()['x-piwi-coverage']).toMatch(/^[\w-]+\.\d+$/);
    await expect(page.locator('#summary')).toHaveText(`1 item(s) on their way to ${shopper.city}, France.`);
  },
);
