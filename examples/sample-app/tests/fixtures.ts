/**
 * Option A: extend the base `test` with the Piwi capture fixtures.
 *
 * Every spec imports `test` from this file instead of `@playwright/test`;
 * that import is what switches capture on for the spec.
 */
import { test as base, expect } from '@playwright/test';
import { piwiFixtures } from '@piwitests/reporter';

/** Absolute base URL for pages created outside the `page` fixture (browser.newPage etc.). */
export { BASE_URL } from '../backends';

export const test = base.extend(piwiFixtures);
export { expect };
