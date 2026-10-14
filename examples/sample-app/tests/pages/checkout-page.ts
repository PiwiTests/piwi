import type { Page } from '@playwright/test';

/** Where an order goes. */
export interface Shipping {
  name: string;
  address: string;
  city: string;
}

/** The shop's shipping page. */
export class CheckoutPage {
  constructor(readonly page: Page) {}

  /** Fills in the shipping details and places the order. */
  async placeOrder(shipping: Shipping): Promise<void> {
    await this.page.getByLabel('Full name').fill(shipping.name);
    await this.page.getByLabel('Address').fill(shipping.address);
    await this.page.getByLabel('City').fill(shipping.city);
    await this.page.getByRole('button', { name: 'Place order' }).click();
  }
}
