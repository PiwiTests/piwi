// `withOptimizations`: the public levers, applied to a Playwright config.
import module from 'node:module';
import { resolve } from 'node:path';

const DEFAULT_SETUP = /.*\.setup\.[cm]?[jt]sx?$/;

function applySignIn(config, signIn) {
  const { storageState, setup = DEFAULT_SETUP, project = 'setup' } = signIn;
  if (typeof storageState !== 'string' || !storageState) throw new Error('playwright-turbo: signIn.storageState must be the path the setup project saves to');
  const projects = config.projects?.length ? config.projects : [{ name: 'tests' }];
  if (projects.some((item) => item.name === project)) throw new Error(`playwright-turbo: a project is already named "${project}"; pass signIn.project to name the setup project`);
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

function enableCompileCache(directory) {
  if (process.env.NODE_COMPILE_CACHE || process.env.NODE_DISABLE_COMPILE_CACHE) return;
  // Precise V8 coverage needs functions compiled fresh.
  if (process.env.NODE_V8_COVERAGE) return;
  const path = resolve(directory);
  // The runner caches from here on; workers inherit the variable and cache from their start.
  module.enableCompileCache?.(path);
  process.env.NODE_COMPILE_CACHE = path;
}

/**
 * Returns `config` with the given optimizations applied. Every one is off unless named.
 * @param {import('@playwright/test').PlaywrightTestConfig} config
 * @param {import('./config.js').Optimizations} [options]
 */
export function withOptimizations(config, options = {}) {
  const result = { ...config, use: { ...config.use } };
  if (config.projects) result.projects = config.projects.map((project) => ({ ...project }));
  if (options.trace) result.use.trace = options.trace;
  if (options.reducedMotion) result.use.contextOptions = { ...result.use.contextOptions, reducedMotion: 'reduce' };
  if (options.blockRequests?.length) result.use.blockRequests = options.blockRequests;
  if (options.signIn) applySignIn(result, options.signIn);
  if (options.compileCache) enableCompileCache(options.compileCache === true ? 'node_modules/.cache/playwright-turbo-compile' : options.compileCache);
  const experimental = options.experimental ?? {};
  if (experimental.fastScreenshots) result.use.fastScreenshots = true;
  if (experimental.retryIntervals) result.use.retryIntervals = experimental.retryIntervals;
  return result;
}
