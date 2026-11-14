import { test as setup } from '@playwright/test';
import { signIn } from './fixtures';

setup('sign in once for the suite', async ({ page }) => {
  await signIn(page);
  await page.context().storageState({ path: '.auth/user.json' });
});
