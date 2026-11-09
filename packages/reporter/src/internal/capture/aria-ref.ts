import type { Locator, Page } from '@playwright/test';

/**
 * The element a ref of the page's AI snapshot names (`page.ariaSnapshot({ mode: 'ai' })`): `page.getByRef` where
 * Playwright has it (1.64), else the `aria-ref=` selector it wraps.
 */
export function locatorOfRef(page: Page, ref: string): Locator {
  const getByRef = (page as unknown as { getByRef?: (ref: string) => Locator }).getByRef;
  return typeof getByRef === 'function' ? getByRef.call(page, ref) : page.locator(`aria-ref=${ref}`);
}
