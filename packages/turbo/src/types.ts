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
  /** Experimental: the backoff of Playwright's retry loop, in milliseconds. */
  retryIntervals: number[] | undefined;
  /** Experimental: a failing web-first assertion ends once nothing can change the page before its timeout. */
  failFast: boolean;
}
