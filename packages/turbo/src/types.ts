/** A request to block: a URL glob, a regular expression, or a predicate. */
export type BlockRule = string | RegExp | ((url: URL) => boolean);

/** A resource type `blockResources` can skip. */
export type ResourceType = 'image' | 'font' | 'media' | 'stylesheet' | 'script';

/** The fixture options of `@piwitests/turbo/test`, set in `use` or with `test.use`. */
export interface TurboOptions {
  /** Requests to abort in every context of the test. */
  blockRequests: BlockRule[];
  /** Resource types to abort in every context of the test. */
  blockResources: ResourceType[];
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
  /** Experimental: trace DOM snapshots visit only what changed since the previous snapshot. */
  differentialSnapshots: boolean;
}
