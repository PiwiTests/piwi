/**
 * A form the browser submits itself, before the page hydrates or without its
 * `@submit` handler, posts its fields to the page's own URL: never in the URL.
 * The password pages render their forms on the server, so they are submitted
 * with JavaScript off. The sign-in form renders once the page has mounted, so
 * the form's own `submit()`, which skips the handler, stands in for it.
 */
import { test, expect } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { waitForHydration } from './utils';

const PASSWORD = 'NotInTheUrl1!';

/** The navigation request `submit` starts, once its page has loaded. */
async function submission(page: Page, submit: () => Promise<unknown>): Promise<Request> {
  const request = page.waitForRequest((r) => r.isNavigationRequest());
  const loaded = page.waitForEvent('load');
  await submit();
  await loaded;
  return request;
}

/** The query keys of the page's URL. */
function queryKeys(page: Page): string[] {
  return [...new URL(page.url()).searchParams.keys()];
}

test.describe('Forms submitted without their handler', () => {
  test('the reset-password form posts the passwords in the body before hydration', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/reset-password?token=e2e-unused-token');
      await page.getByLabel('New password').fill(PASSWORD);
      await page.getByLabel('Confirm password').fill(PASSWORD);

      const request = await submission(page, () => page.getByRole('button', { name: 'Reset password' }).click());

      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toMatchObject({ password: PASSWORD, confirmPassword: PASSWORD });
      expect((await request.response())?.status()).toBe(200);
      expect(queryKeys(page)).toEqual(['token']);
      await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the forgot-password form posts the email in the body before hydration', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto('/forgot-password');
      await page.getByLabel('Email').fill('nobody@example.com');

      const request = await submission(page, () => page.getByRole('button', { name: 'Send reset link' }).click());

      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toMatchObject({ email: 'nobody@example.com' });
      expect((await request.response())?.status()).toBe(200);
      expect(queryKeys(page)).toEqual([]);
      await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the sign-in form posts the password in the body when submitted without its handler', async ({ page }) => {
    await page.goto('/login');
    await waitForHydration(page);
    await page.getByLabel('Username').fill('nobody');
    await page.getByLabel('Password').fill(PASSWORD);
    const form = page.locator('form').filter({ has: page.getByLabel('Password') });

    // `submit()` runs on a later task, so the evaluation returns before the page unloads.
    const request = await submission(page, () => form.evaluate((el: HTMLFormElement) => setTimeout(() => el.submit())));

    expect(request.method()).toBe('POST');
    expect(request.postDataJSON()).toMatchObject({ username: 'nobody', password: PASSWORD });
    expect((await request.response())?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(queryKeys(page)).toEqual([]);
  });
});
