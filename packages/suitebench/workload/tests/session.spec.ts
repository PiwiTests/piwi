import { test, expect, signIn, signInViaApi, USER } from './fixtures';

test.use({ signedIn: false, storageState: { cookies: [], origins: [] } });

test('sends a signed-out visitor to the sign-in page', async ({ page }) => {
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('refuses a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Password').fill('wrong password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong email or password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('signs in through the form', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(USER.email)).toBeVisible();
});

test('signs out', async ({ page }) => {
  await signInViaApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login$/);
});
