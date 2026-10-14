import type { Page } from '@playwright/test';

/** The shop's sign-in page. */
export class LoginPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/shop/login');
  }

  /** Signs in from the sign-in page; the shop then opens the products page. */
  async login(email: string, password: string): Promise<void> {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
  }
}
