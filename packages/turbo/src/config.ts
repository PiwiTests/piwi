// `withOptimizations`: the public levers, applied to a Playwright config.
import type { PlaywrightTestConfig, PlaywrightTestProject } from '@playwright/test';
import type { BlockRule } from './types';

type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries' | 'retain-on-first-failure';
type Matcher = string | RegExp | Array<string | RegExp>;

export interface Optimizations {
  /** Trace mode for every test, e.g. `'retain-on-failure'` or `'on-first-retry'`. */
  trace?: TraceMode;
  /** Emulates `prefers-reduced-motion: reduce`. Changes what the app does when it honors the preference. */
  reducedMotion?: boolean;
  /** Requests every test aborts, typically third-party scripts. Needs `test` from `@piwitests/turbo/test`. */
  blockRequests?: BlockRule[];
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

/** Returns `config` with the given optimizations applied. Every one is off unless named. */
export function withOptimizations<T extends AnyConfig>(config: T, options: Optimizations = {}): T {
  const result: AnyConfig = { ...config, use: { ...config.use } };
  const use = result.use as Record<string, unknown> & { contextOptions?: Record<string, unknown> };
  if (config.projects) result.projects = config.projects.map((project) => ({ ...project }));
  if (options.trace) use.trace = options.trace;
  if (options.reducedMotion) use.contextOptions = { ...use.contextOptions, reducedMotion: 'reduce' };
  if (options.blockRequests?.length) use.blockRequests = options.blockRequests;
  if (options.signIn) applySignIn(result, options.signIn);
  const experimental = options.experimental ?? {};
  if (experimental.fastScreenshots) use.fastScreenshots = true;
  if (experimental.retryIntervals) use.retryIntervals = experimental.retryIntervals;
  return result as T;
}
