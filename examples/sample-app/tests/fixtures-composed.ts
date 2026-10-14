/**
 * Option B + composition: `extendPiwiFixtures` wraps the base `test`,
 * then regular `.extend()` layers project-specific fixtures on top.
 * Capture and custom fixtures work together; the custom fixture types flow through.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { extendPiwiFixtures } from '@piwitests/reporter';

class FormPage {
  constructor(readonly page: Page) {}

  async sendMessage(email: string, message: string): Promise<void> {
    await this.page.goto('/form');
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Message').fill(message);
    await this.page.getByLabel('Priority').selectOption('high');
    await this.page.getByRole('button', { name: 'Send' }).click();
  }
}

export const test = extendPiwiFixtures(base).extend<{ formPage: FormPage }>({
  formPage: async ({ page }, use) => {
    await use(new FormPage(page));
  },
});
export { expect };
