import { expect, type Page } from '@playwright/test';

/** The shop's products page, and the page of each product. */
export class ProductsPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/shop');
  }

  /** Opens a product from the products page and adds it to the cart; the shop then comes back to the products. */
  async addToCart(product: string): Promise<void> {
    await this.page.getByRole('link', { name: product }).click();
    await this.page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(this.page.getByRole('status')).toHaveText(`${product} added to the cart`);
  }
}
