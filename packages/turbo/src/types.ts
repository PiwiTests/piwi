/** A request to block: a URL glob, a regular expression, or a predicate. */
export type BlockRule = string | RegExp | ((url: URL) => boolean);

/** The fixture options of `@piwitests/turbo/test`, set in `use` or with `test.use`. */
export interface TurboOptions {
  /** Requests to abort in every context of the test. */
  blockRequests: BlockRule[];
  /** Screenshots of the test's pages when it fails, and none when it passes. */
  failureScreenshots: boolean;
  /** Chromium: CSS transitions and animations, and Web Animations, run 1000 times faster. */
  instantAnimations: boolean;
  /** Experimental, Chromium: encode PNG screenshots for speed. */
  fastScreenshots: boolean;
  /**
   * Worker option: keep one browser context per worker, reset between tests by Playwright and by turbo, in place of a
   * new context for each test. Needs video off.
   */
  reuseContextWithReset: boolean;
  /**
   * Experimental worker option, with `reuseContextWithReset` on Chromium: the reset between tests clears the storage of
   * the origins the test visited without navigating to them.
   */
  fastReset: boolean;
  /**
   * Experimental worker option: the worker's stack traces map only the frames that may have a source map, leaving out
   * those of Node and of `node_modules`. They read the same.
   */
  fastStackTraces: boolean;
  /**
   * Experimental: a screenshot assertion passes without decoding its capture when the capture's bytes are the
   * baseline's, or those of a capture that matched the same baseline with the same options before.
   */
  screenshotMatches: boolean;
  /** Experimental: the backoff of Playwright's retry loop, in milliseconds. */
  retryIntervals: number[] | undefined;
  /** Experimental: a failing web-first assertion ends once nothing can change the page before its timeout. */
  failFast: boolean;
  /** Experimental: pointer actions skip the wait for the element to keep still; the hit-target check stays. */
  skipStabilityWait: boolean;
}
