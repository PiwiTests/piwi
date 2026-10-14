import type { Page, PlaywrightWorkerOptions } from '@playwright/test';

/** Playwright's `screenshot` use option: a mode, or a mode with screenshot options. */
export type ScreenshotOption = PlaywrightWorkerOptions['screenshot'];

/**
 * Whether Playwright's `screenshot` option keeps screenshots of this attempt
 * when it fails. The failure-page screenshot follows the same option, so a
 * suite on `'off'` gets none.
 */
export function keepsFailureScreenshots(option: ScreenshotOption | undefined, retry: number): boolean {
  const mode = typeof option === 'string' ? option : option?.mode;
  return mode === 'on' || mode === 'only-on-failure' || (mode === 'on-first-failure' && retry === 0);
}

/**
 * A PNG of the page, taken as Playwright takes its own failure screenshots:
 * the `fullPage` / `omitBackground` the option sets, the caret left as is,
 * five seconds at most. Null when the page could not be captured.
 */
export async function readFailureScreenshot(page: Page, option: ScreenshotOption | undefined): Promise<Buffer | null> {
  const options = typeof option === 'object' && option !== null ? option : null;
  try {
    return await page.screenshot({
      fullPage: options?.fullPage,
      omitBackground: options?.omitBackground,
      timeout: 5000,
      caret: 'initial',
    });
  } catch {
    return null;
  }
}
