/**
 * Shared test fixtures for the Piwi Dashboard test suite: Playwright's `test` with the reporter's capture fixtures
 * (`extendPiwiFixtures`), as a project set up by `npx @piwitests/reporter init` has. The suite records what any
 * project records (network timing, Web Vitals, ARIA and locator snapshots, code reach, the resource census), and its
 * workers join the run channel of the editor or the desktop app that started the run, where a running test can be
 * watched, paused and stepped.
 *
 * Usage in test files:
 * ```ts
 * import { test, expect } from './fixtures'
 * ```
 */
import { test as base, expect } from '@playwright/test';
import { extendPiwiFixtures } from '@piwitests/reporter';

export const test = extendPiwiFixtures(base);

export { expect };
export type { APIRequestContext, Page } from '@playwright/test';
