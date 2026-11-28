import type { Page, APIRequestContext } from '@playwright/test';
import { waitForHydration as nuxtWaitForHydration } from '@nuxt/test-utils/e2e';

// Helper to wait for Nuxt page hydration.
// Uses @nuxt/test-utils/e2e which checks
// `window.useNuxtApp?.().isHydrating === false` — the official Nuxt API.
export async function waitForHydration(page: Page) {
  await page.waitForLoadState('load');
  await nuxtWaitForHydration(page, undefined as unknown as string, 'hydration').catch(() => {});
}

/**
 * Retry an API request on transient connection errors (e.g. ECONNRESET).
 * Returns the response on success; throws after all attempts are exhausted.
 */
export async function retryPost(
  request: APIRequestContext,
  url: string,
  options: Parameters<APIRequestContext['post']>[1],
  attempts = 3,
  delayMs = 1000,
) {
  const isTransient = (err: unknown) =>
    err instanceof Error && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(err.message);

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await request.post(url, options);
    } catch (err) {
      if (!isTransient(err)) throw err;
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Presses a two-key chord with the page's clock paused, then lets it run again. A chord's second key counts only
 * until a timer its first key starts runs out (800 ms in Nuxt UI's `defineShortcuts`), and each press waits for the
 * page to take its key before the next is sent, so a busy page takes the two further apart than a person's keys.
 * `pauseAt` only moves the clock forward, and the page's clock runs until the call reaches it, so it pauses a minute
 * past the page's time. The page needs `page.clock.install()` before it loads.
 */
export async function pressChord(page: Page, first: string, second: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 60_000);
  await page.keyboard.press(first);
  await page.keyboard.press(second);
  await page.clock.resume();
}
