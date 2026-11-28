// `withOptimizations`: the public levers, applied to a Playwright config.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PlaywrightTestConfig, PlaywrightTestProject } from '@playwright/test';
import { enableCompileCache } from './compile-cache';
import type { BlockRule } from './types';

type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure';
type Matcher = string | RegExp | Array<string | RegExp>;

/**
 * A named bundle of optimizations, by how much a test can notice:
 * - `safe`: nothing a test observes changes. Traces and video for failures or retries only, and failure screenshots.
 * - `fast`: `safe`, plus changes to what the page does: reduced motion and instant animations, and one browser context
 *   per worker, reset between tests.
 * - `max`: `fast`, plus every hook into Playwright's internals but `keepStaticCache`, which a project turns on itself.
 */
export type Preset = 'safe' | 'fast' | 'max';

export interface Optimizations {
  /** A bundle of the options below. An option named next to it wins over the preset. */
  preset?: Preset;
  /** Trace mode for every test, e.g. `'retain-on-failure'` or `'on-first-retry'`. */
  trace?: TraceMode;
  /**
   * Lighter traces, whatever the trace mode. `true` keeps the DOM snapshots of each action and leaves out the ARIA and
   * screenshot snapshots and the screencast, which cost the most to record. `'actions'` also leaves out the DOM
   * snapshots: the trace keeps the actions, network, console and sources, and the viewer shows no page at each step.
   */
  lightTraces?: boolean | 'actions';
  /**
   * One browser context per worker, reset between tests, in place of a new context for each test: Playwright's own
   * reuse, plus turbo's reset of offline mode, extra headers, permissions, geolocation and Cache Storage. Needs `test`
   * from `@piwitests/turbo/test`, and video off.
   */
  reuseContext?: boolean;
  /**
   * Node's compile cache for the test workers, which shortens their start: `true` caches in
   * `node_modules/.cache/piwi-turbo-compile`, or the temporary folder without `node_modules`. The processes the runner
   * starts (the web server, global setup) use it too. The runner has loaded Playwright before the config:
   * `NODE_COMPILE_CACHE` set in the environment caches its start too. Skipped when `NODE_V8_COVERAGE` or a compile cache
   * is already set.
   */
  compileCache?: boolean | string;
  /**
   * With retries, records video on the first retry instead of `retain-on-failure`, which records every test to keep the
   * failed ones.
   */
  videoOnRetry?: boolean;
  /** Emulates `prefers-reduced-motion: reduce`. Changes what the app does when it honors the preference. */
  reducedMotion?: boolean;
  /** Requests every test aborts, typically third-party scripts. Needs `test` from `@piwitests/turbo/test`. */
  blockRequests?: BlockRule[];
  /**
   * Screenshots of a test's pages when it fails, and none when it passes, in place of `screenshot: 'only-on-failure'`,
   * which captures every test's pages and keeps the failed ones. Needs `test` from `@piwitests/turbo/test`.
   */
  failureScreenshots?: boolean;
  /**
   * Chromium: CSS transitions and animations, and Web Animations, run 1000 times faster, whether or not the app
   * honors reduced motion. Needs `test` from `@piwitests/turbo/test`.
   */
  instantAnimations?: boolean;
  /**
   * Signs in once: adds a setup project that runs the files matching `setup` (default `*.setup.ts`) and saves
   * `storageState`, which every other project then loads into each fresh context.
   */
  signIn?: { storageState: string; setup?: Matcher; project?: string };
  /** Hooks into Playwright's internals, pinned to tested versions. They throw rather than fall back. */
  experimental?: {
    /** Chromium only: encode PNG screenshots for speed. Same pixels, larger files. Off while snapshots are written. */
    fastScreenshots?: boolean;
    /** The backoff of Playwright's retry loop in milliseconds, e.g. `[10, 20, 40, 50]`. Stock: `[20, 50, 100, 100, 500]`. */
    retryIntervals?: number[];
    /**
     * A failing web-first assertion ends as soon as nothing can change the page before its timeout: no request, timer,
     * animation frame, interval, socket, worker, running animation or playing media. A test that changes the page from
     * its own Node code while an assertion waits must leave it off.
     */
    failFast?: boolean;
    /**
     * Clicks, hovers, taps and drags stop waiting for the element to keep still for two animation frames. The visible,
     * enabled and hit-target checks stay, so an element still moving under the pointer is retried. Leave it off for
     * apps that ignore input while they animate.
     */
    skipStabilityWait?: boolean;
    /**
     * With `reuseContext`, on Chromium: the reset between tests clears the storage of the origins the test visited
     * through CDP instead of loading each of them, and resets the tab without loading about:blank a second time or
     * applying its viewport and media again when the test left them alone and the next test asks for the same context
     * options.
     */
    fastReset?: boolean;
    /**
     * Chromium: Playwright's injected script, which its actions and assertions run in, is created in each new document
     * of a tab while the document loads, instead of at its first call, so the first call after a navigation finds it
     * ready. A document that gets no call pays for it anyway.
     */
    earlyInjection?: boolean;
    /**
     * A trace that records DOM snapshots and leaves out the bodies of scripts, as every trace but a live one does, does
     * not request them from the browser. On Chromium, the DOM snapshot taken after a call, and before most actions,
     * assertions and evaluations, is left in flight rather than awaited, unless the trace also records screenshots,
     * aria snapshots or coverage; navigation, closing, the page's own input, screenshots, emulation changes, CDP
     * sessions and the trace's stop wait for them. The trace holds the same calls and snapshots.
     */
    fastTraces?: boolean;
    /**
     * Fewer round trips with the browser per action. An action looks its element up, then asks the page twice more
     * for the lookup's log and for the element: the lookup returns the element, and its log is read by a command sent
     * right behind it. Playwright's own element handles get no preview from the page until a client is given one. On
     * Chromium, a pointer action asks for its click point right behind the scroll that brings the element into view.
     * What an action does, logs and records in a trace is the same.
     */
    fastActions?: boolean;
    /**
     * The test worker's stack traces, which Playwright captures for every API call, look up source maps only for the
     * frames outside Node and `node_modules`. They read the same. With another experimental hook on, Playwright's
     * server also captures no stack as each evaluation in a page starts, nor for the errors it prepares in case a
     * call times out or, on Chromium, a command to the browser fails: the test's errors read the same, and a trace
     * records the server's errors without Playwright's internal frames.
     */
    fastStackTraces?: boolean;
    /**
     * A screenshot assertion passes without decoding its capture when the capture's bytes are the baseline's, or those
     * of a capture that matched the same baseline with the same options before, remembered in
     * `node_modules/.cache/piwi-turbo`. Any other capture is compared as Playwright compares it.
     */
    screenshotMatches?: boolean;
    /**
     * With `reuseContext`: the reset between tests leaves the browser's HTTP cache while it holds only static assets:
     * responses `immutable`; images, fonts, stylesheets, scripts and media with no lifetime of their own or one of a
     * week; other responses fresh for a week requested without a cookie. Anything else the browser could reuse clears
     * it, a favicon included, and so does a request still waiting for its response at the reset, or a response no page
     * or worker received. A file the app changes at the same URL between tests, with no lifetime of its own, reaches the
     * next test as it was, and so can a response to a request a document starts in `pagehide`, `unload` or
     * `visibilitychange`. Chromium only: other browsers give no events for responses no page received, so their cache
     * is always cleared. Not part of the `max` preset.
     */
    keepStaticCache?: boolean;
  };
}

const DEFAULT_SETUP = /.*\.setup\.[cm]?[jt]sx?$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any fixture options a config declares
type AnyConfig = PlaywrightTestConfig<any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProject = PlaywrightTestProject<any, any>;

function applySignIn(config: AnyConfig, signIn: NonNullable<Optimizations['signIn']>): void {
  const { storageState, setup = DEFAULT_SETUP, project = 'setup' } = signIn;
  if (typeof storageState !== 'string' || !storageState) {
    throw new Error('@piwitests/turbo: signIn.storageState must be the path the setup project saves to');
  }
  // Without projects, Playwright's own project has no name: snapshot paths and reports stay as they were.
  const projects: AnyProject[] = config.projects?.length ? config.projects : [{ name: '' }];
  if (projects.some((item) => item.name === project)) {
    throw new Error(
      `@piwitests/turbo: a project is already named "${project}"; pass signIn.project to name the setup project`,
    );
  }
  config.projects = [
    { name: project, testMatch: setup },
    ...projects.map((item) => ({
      ...item,
      dependencies: [...new Set([...(item.dependencies ?? []), project])],
      testIgnore: item.testIgnore ?? setup,
      use: { storageState, ...item.use },
    })),
  ];
}

const EXPERIMENTAL_RETRY_INTERVALS = [10, 20, 40, 50];

/** The run folder's `node_modules/.cache`, else the system's temporary folder: never a new `node_modules`. */
function defaultCompileCache(): string {
  const modules = resolve('node_modules');
  return existsSync(modules) ? join(modules, '.cache', 'piwi-turbo-compile') : join(tmpdir(), 'piwi-turbo-compile');
}

function defined<T extends object>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function modeOf(setting: unknown): string | undefined {
  return typeof setting === 'object' && setting !== null
    ? (setting as { mode?: string }).mode
    : (setting as string | undefined);
}

/**
 * The options a preset stands for, given the config it applies to. A preset only lowers a cost the config has: it
 * never turns on traces, screenshots or video the config leaves off.
 */
export function presetOptions(preset: Preset, config: AnyConfig): Optimizations {
  const retries = typeof config.retries === 'number' && config.retries > 0;
  const trace = modeOf(config.use?.trace);
  const safe: Optimizations = { videoOnRetry: true, compileCache: true };
  // With retries, the first retry records the trace; without, every test records and only failures keep it.
  if (trace === 'on' || trace === 'retain-on-failure') safe.trace = retries ? 'on-first-retry' : 'retain-on-failure';
  if (modeOf(config.use?.screenshot) === 'only-on-failure') safe.failureScreenshots = true;
  if (preset === 'safe') return safe;
  const fast: Optimizations = { ...safe, reducedMotion: true, instantAnimations: true, reuseContext: true };
  if (preset === 'fast') return fast;
  if (preset === 'max') {
    return {
      ...fast,
      experimental: {
        fastScreenshots: true,
        retryIntervals: EXPERIMENTAL_RETRY_INTERVALS,
        failFast: true,
        skipStabilityWait: true,
        fastReset: true,
        fastStackTraces: true,
        screenshotMatches: true,
        earlyInjection: true,
        fastTraces: true,
        fastActions: true,
      },
    };
  }
  throw new Error(`@piwitests/turbo: unknown preset "${String(preset)}"; use safe, fast or max`);
}

/** Returns `config` with the given optimizations applied. Every one is off unless named, or part of the preset. */
export function withOptimizations<T extends AnyConfig>(config: T, given: Optimizations = {}): T {
  const preset = given.preset ? presetOptions(given.preset, config) : {};
  // An option left undefined keeps the preset's value: only the options given a value win over it.
  const options: Optimizations = {
    ...preset,
    ...defined(given),
    experimental: { ...preset.experimental, ...defined(given.experimental ?? {}) },
  };
  const result: AnyConfig = { ...config, use: { ...config.use } };
  const use = result.use as Record<string, unknown> & { contextOptions?: Record<string, unknown> };
  if (config.projects) result.projects = config.projects.map((project) => ({ ...project }));
  if (options.trace)
    use.trace = typeof use.trace === 'object' && use.trace ? { ...use.trace, mode: options.trace } : options.trace;
  if (options.lightTraces) {
    const current = use.trace as TraceMode | { mode: TraceMode } | undefined;
    const mode = typeof current === 'object' ? current.mode : (current ?? 'off');
    const snapshots = options.lightTraces === 'actions' ? false : { dom: true, aria: false, screen: false };
    use.trace = { ...(typeof current === 'object' ? current : {}), mode, snapshots, screenshots: false };
  }
  if (options.videoOnRetry && result.retries && modeOf(use.video) === 'retain-on-failure') {
    use.video =
      typeof use.video === 'object' && use.video ? { ...use.video, mode: 'on-first-retry' } : 'on-first-retry';
  }
  if (options.reducedMotion) use.contextOptions = { ...use.contextOptions, reducedMotion: 'reduce' };
  if (options.blockRequests?.length) use.blockRequests = options.blockRequests;
  if (options.instantAnimations) use.instantAnimations = true;
  if (options.reuseContext) use.reuseContextWithReset = true;
  // turbo's `test` captures in place of Playwright, unless the config asks for every test's screenshots.
  const screenshot = modeOf(use.screenshot);
  if (options.failureScreenshots && screenshot !== 'on' && screenshot !== 'on-first-failure')
    use.failureScreenshots = true;
  if (options.signIn) applySignIn(result, options.signIn);
  const experimental = options.experimental ?? {};
  if (experimental.fastScreenshots) use.fastScreenshots = true;
  if (experimental.retryIntervals) use.retryIntervals = experimental.retryIntervals;
  if (experimental.failFast) use.failFast = true;
  if (experimental.skipStabilityWait) use.skipStabilityWait = true;
  if (experimental.fastReset) use.fastReset = true;
  if (experimental.fastStackTraces) use.fastStackTraces = true;
  if (experimental.screenshotMatches) use.screenshotMatches = true;
  if (experimental.keepStaticCache) use.keepStaticCache = true;
  if (experimental.earlyInjection) use.earlyInjection = true;
  if (experimental.fastTraces) use.fastTraces = true;
  if (experimental.fastActions) use.fastActions = true;
  if (options.compileCache) {
    enableCompileCache(options.compileCache === true ? defaultCompileCache() : options.compileCache);
  }
  return result as T;
}
