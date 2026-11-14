import type { PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions, TestType } from '@playwright/test';
import type { BlockRule } from './index.js';

export interface TurboOptions {
  /** Requests to abort in every context of the test. */
  blockRequests: BlockRule[];
  /** Experimental, Chromium only: encode PNG screenshots for speed. */
  fastScreenshots: boolean;
  /** Experimental: the backoff of Playwright's retry loop, in milliseconds. */
  retryIntervals: number[] | undefined;
}

export declare const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & TurboOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;
export { expect } from '@playwright/test';
