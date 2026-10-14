/**
 * The shop's fixtures, on top of the Piwi capture fixtures: its page objects, the shopper a test plays, and a
 * shopper already signed in. A spec of the shop imports `test` from here and asks for what it needs:
 * `async ({ page, loginPage, shopper }) => …`.
 */
import { test as base, expect } from '@playwright/test';
import { extendPiwiFixtures } from '@piwitests/reporter';
import { CheckoutPage, type Shipping } from './pages/checkout-page';
import { LoginPage } from './pages/login-page';
import { ProductsPage } from './pages/products-page';

/** The shopper a test plays: who signs in, and where the orders go. */
export interface Shopper extends Shipping {
  email: string;
}

interface ShopFixtures {
  loginPage: LoginPage;
  productsPage: ProductsPage;
  checkoutPage: CheckoutPage;
  shopper: Shopper;
  /** Signs the shopper in without the sign-in page, as a session cookie: the test starts on the products. */
  signedIn: void;
}

export const test = extendPiwiFixtures(base).extend<ShopFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  productsPage: async ({ page }, use) => {
    await use(new ProductsPage(page));
  },
  checkoutPage: async ({ page }, use) => {
    await use(new CheckoutPage(page));
  },
  // An option: a spec can play another shopper with `test.use({ shopper: { … } })`.
  shopper: [{ email: 'alice@example.com', name: 'Alice Martin', address: '12 Harbour Street', city: 'La Rochelle' }, { option: true }],
  signedIn: async ({ page, shopper, baseURL }, use) => {
    await page.context().addCookies([{ name: 'shop_user', value: encodeURIComponent(shopper.email), url: baseURL! }]);
    await page.goto('/shop');
    await use();
  },
});
export { expect };
