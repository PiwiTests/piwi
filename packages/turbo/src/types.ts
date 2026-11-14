/** A request to block: a URL glob, a regular expression, or a predicate. */
export type BlockRule = string | RegExp | ((url: URL) => boolean);

/** The fixture options of `@piwitests/turbo/test`, set in `use` or with `test.use`. */
export interface TurboOptions {
  /** Requests to abort in every context of the test. */
  blockRequests: BlockRule[];
  /** Experimental, Chromium only: encode PNG screenshots for speed. */
  fastScreenshots: boolean;
  /** Experimental: the backoff of Playwright's retry loop, in milliseconds. */
  retryIntervals: number[] | undefined;
}
