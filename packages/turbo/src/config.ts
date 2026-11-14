// `withOptimizations`: the public levers, applied to a Playwright config.
import type { PlaywrightTestConfig, PlaywrightTestProject } from '@playwright/test';
import type { BlockRule, ResourceType } from './types';

type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure';
type Matcher = string | RegExp | Array<string | RegExp>;

/**
 * A named bundle of optimizations, by how much a test can notice:
 * - `safe`: nothing a test observes changes. Traces and video for failures or retries only, and failure screenshots.
 * - `fast`: `safe`, plus changes to what the page does: reduced motion and instant animations.
 * - `experimental`: `fast`, plus the hooks into Playwright's internals.
 */
export type Preset = 'safe' | 'fast' | 'experimental';

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
   * With retries, records video on the first retry instead of `retain-on-failure`, which records every test to keep the
   * failed ones.
   */
  videoOnRetry?: boolean;
  /** Emulates `prefers-reduced-motion: reduce`. Changes what the app does when it honors the preference. */
  reducedMotion?: boolean;
  /** Requests every test aborts, typically third-party scripts. Needs `test` from `@piwitests/turbo/test`. */
  blockRequests?: BlockRule[];
  /** Resource types every test aborts, e.g. `['image', 'font', 'media']`. Needs `test` from `@piwitests/turbo/test`. */
  blockResources?: ResourceType[];
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
     * Trace DOM snapshots visit only the nodes that changed since the previous snapshot, with the same result as a
     * full walk. Uses a modified copy of Playwright's snapshot script, under Apache-2.0.
     */
    differentialSnapshots?: boolean;
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
  const projects: AnyProject[] = config.projects?.length ? config.projects : [{ name: 'tests' }];
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

function defined<T extends object>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The options a preset stands for, given the config it applies to. */
export function presetOptions(preset: Preset, config: AnyConfig): Optimizations {
  const retries = typeof config.retries === 'number' && config.retries > 0;
  const safe: Optimizations = {
    // With retries, the first retry records the trace; without, every test records and only failures keep it.
    trace: retries ? 'on-first-retry' : 'retain-on-failure',
    failureScreenshots: true,
    videoOnRetry: true,
  };
  if (preset === 'safe') return safe;
  const fast: Optimizations = { ...safe, reducedMotion: true, instantAnimations: true };
  if (preset === 'fast') return fast;
  if (preset === 'experimental') {
    return { ...fast, experimental: { fastScreenshots: true, retryIntervals: EXPERIMENTAL_RETRY_INTERVALS } };
  }
  throw new Error(`@piwitests/turbo: unknown preset "${String(preset)}"; use safe, fast or experimental`);
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
  if (options.trace) use.trace = options.trace;
  if (options.lightTraces) {
    const current = use.trace as TraceMode | { mode: TraceMode } | undefined;
    const mode = typeof current === 'object' ? current.mode : (current ?? 'off');
    const snapshots = options.lightTraces === 'actions' ? false : { dom: true, aria: false, screen: false };
    use.trace = { ...(typeof current === 'object' ? current : {}), mode, snapshots, screenshots: false };
  }
  if (options.videoOnRetry && result.retries && use.video === 'retain-on-failure') use.video = 'on-first-retry';
  if (options.reducedMotion) use.contextOptions = { ...use.contextOptions, reducedMotion: 'reduce' };
  if (options.blockRequests?.length) use.blockRequests = options.blockRequests;
  if (options.blockResources?.length) use.blockResources = options.blockResources;
  if (options.instantAnimations) use.instantAnimations = true;
  if (options.failureScreenshots) {
    // In place of Playwright's own capture, unless the config asks for every test's screenshots.
    if (use.screenshot !== 'on' && use.screenshot !== 'on-first-failure') {
      use.screenshot = 'off';
      use.failureScreenshots = true;
    }
  }
  if (options.signIn) applySignIn(result, options.signIn);
  const experimental = options.experimental ?? {};
  if (experimental.fastScreenshots) use.fastScreenshots = true;
  if (experimental.retryIntervals) use.retryIntervals = experimental.retryIntervals;
  if (experimental.failFast) use.failFast = true;
  if (experimental.differentialSnapshots) use.differentialSnapshots = true;
  return result as T;
}
