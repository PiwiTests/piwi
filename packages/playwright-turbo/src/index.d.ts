import type { PlaywrightTestConfig } from '@playwright/test';

/** A request to block: a URL glob, a regular expression, or a predicate. */
export type BlockRule = string | RegExp | ((url: URL) => boolean);

export interface Optimizations {
  /** Trace mode for every test, e.g. `'retain-on-failure'` or `'on-first-retry'`. */
  trace?: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure';
  /** Emulates `prefers-reduced-motion: reduce`. Changes what the app does when it honors the preference. */
  reducedMotion?: boolean;
  /** Requests every test aborts, typically third-party scripts. Needs `test` from `playwright-turbo/test`. */
  blockRequests?: BlockRule[];
  /**
   * Signs in once: adds a setup project that runs the files matching `setup` and saves `storageState`, which every
   * other project then loads into each fresh context.
   */
  signIn?: { storageState: string; setup?: string | RegExp | Array<string | RegExp>; project?: string };
  /** Node's compile cache for the runner and the workers; `true` caches in `node_modules/.cache/playwright-turbo-compile`. */
  compileCache?: boolean | string;
  /** Hooks into Playwright's internals. Pinned to tested versions; they throw rather than fall back. */
  experimental?: {
    /** Chromium only: encode PNG screenshots for speed. Same pixels, larger files. Off while snapshots are written. */
    fastScreenshots?: boolean;
    /** The backoff of Playwright's retry loop, in milliseconds, e.g. `[10, 20, 40, 50]`. Stock is `[20, 50, 100, 100, 500]`. */
    retryIntervals?: number[];
  };
}

export declare function withOptimizations<T extends PlaywrightTestConfig<any, any>>(config: T, options?: Optimizations): T;

/** The playwright-core versions the experimental hooks were tested with. */
export declare const TESTED_VERSIONS: readonly string[];
