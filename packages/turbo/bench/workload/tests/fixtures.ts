import { test as base, expect, type Page } from '@playwright/test';

export const USER = { email: 'qa@example.com', password: 'bench-password' };
const VENDOR_PORT = String(Number(process.env.BENCH_PORT ?? 4310) + 1);

/** Signs in through the form, as a user does. */
export async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password').fill(USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** Signs in through the API: a session of the test's own, without the form. */
export async function signInViaApi(page: Page) {
  const response = await page.request.post('/api/login', { data: USER });
  expect(response.ok()).toBe(true);
}

/** Creates an order through the API for a test that changes it, so parallel tests never share one. */
export async function createOrder(page: Page, customer: string) {
  const response = await page.request.post('/api/orders', {
    data: { customer, email: 'buyer@example.com', items: 3, notes: 'Created by the suite' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: number; number: string; customer: string };
}

type Fixtures = {
  /** Whether the test starts signed in. Signed-out tests also clear `storageState`. */
  signedIn: boolean;
  /** Attaches a screenshot of the page to the report, in the format `BENCH_EVIDENCE` names. */
  evidence: (name: string, options?: { fullPage?: boolean }) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  signedIn: [true, { option: true }],
  context: async ({ context }, use) => {
    if (process.env.BENCH_BLOCK_THIRD_PARTY === '1') {
      await context.route((url) => url.port === VENDOR_PORT, (route) => route.abort());
    }
    await use(context);
  },
  page: async ({ page, signedIn }, use) => {
    if (signedIn && process.env.BENCH_AUTH === 'ui') await signIn(page);
    await use(page);
  },
  evidence: async ({ page }, use, testInfo) => {
    const jpeg = process.env.BENCH_EVIDENCE === 'jpeg';
    await use(async (name, options = {}) => {
      const body = await page.screenshot({ fullPage: options.fullPage ?? true, type: jpeg ? 'jpeg' : 'png', quality: jpeg ? 80 : undefined });
      await testInfo.attach(name, { body, contentType: jpeg ? 'image/jpeg' : 'image/png' });
    });
  },
});

export { expect };
