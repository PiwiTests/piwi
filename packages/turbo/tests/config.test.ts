import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { withOptimizations } from '../src/config';

describe('withOptimizations', () => {
  test('leaves a config alone without options', () => {
    const config = { use: { trace: 'on' as const }, projects: [{ name: 'chromium' }] };
    const result = withOptimizations(config);
    expect(result).toEqual(config);
    expect(result).not.toBe(config);
  });

  test('sets the trace mode, reduced motion and blocked requests', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { trace: 'on', contextOptions: { locale: 'fr-FR' } } },
      { trace: 'retain-on-failure', reducedMotion: true, blockRequests: ['**/analytics.js'] },
    );
    expect(result.use?.trace).toBe('retain-on-failure');
    expect(result.use?.contextOptions).toEqual({ locale: 'fr-FR', reducedMotion: 'reduce' });
    expect((result.use as Record<string, unknown>).blockRequests).toEqual(['**/analytics.js']);
  });

  test('adds a setup project every project depends on', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      {
        projects: [
          { name: 'chromium', use: { viewport: { width: 800, height: 600 } } },
          { name: 'firefox', dependencies: ['db'] },
        ],
      },
      { signIn: { storageState: '.auth/user.json' } },
    );
    const [setup, chromium, firefox] = result.projects!;
    expect(result.projects!.map((project) => project.name)).toEqual(['setup', 'chromium', 'firefox']);
    expect('auth.setup.ts').toMatch(setup!.testMatch as RegExp);
    expect(chromium!.dependencies).toEqual(['setup']);
    expect(firefox!.dependencies).toEqual(['db', 'setup']);
    expect(chromium!.use?.storageState).toBe('.auth/user.json');
    expect(chromium!.use?.viewport).toEqual({ width: 800, height: 600 });
  });

  test("keeps a project's own storageState", () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { projects: [{ name: 'signed-out', use: { storageState: { cookies: [], origins: [] } } }] },
      { signIn: { storageState: '.auth/user.json' } },
    );
    expect(result.projects![1]!.use?.storageState).toEqual({ cookies: [], origins: [] });
  });

  test('gives a config without projects one project behind the setup', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      {},
      { signIn: { storageState: 'state.json', project: 'login' } },
    );
    expect(result.projects!.map((project) => project.name)).toEqual(['login', '']);
    expect(result.projects![1]!.dependencies).toEqual(['login']);
  });

  test('refuses a sign-in without a storage path, or with a taken project name', () => {
    expect(() => withOptimizations<PlaywrightTestConfig>({}, { signIn: {} as { storageState: string } })).toThrow(
      /storageState/,
    );
    expect(() =>
      withOptimizations<PlaywrightTestConfig>(
        { projects: [{ name: 'setup' }] },
        { signIn: { storageState: 'x.json' } },
      ),
    ).toThrow(/already named "setup"/);
  });

  test('does not change the projects it was given', () => {
    const projects = [{ name: 'chromium' }];
    withOptimizations<PlaywrightTestConfig>({ projects }, { signIn: { storageState: 'state.json' } });
    expect(projects).toEqual([{ name: 'chromium' }]);
  });

  test('passes the experimental options to the fixtures', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      {},
      { experimental: { fastScreenshots: true, retryIntervals: [10, 20] } },
    );
    expect(result.use).toMatchObject({ fastScreenshots: true, retryIntervals: [10, 20] });
  });
});

describe('presets', () => {
  test('safe keeps traces for failures and screenshots failed tests only', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { trace: 'on', screenshot: 'only-on-failure' } },
      { preset: 'safe' },
    );
    expect(result.use).toMatchObject({
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      failureScreenshots: true,
    });
    expect(result.use).not.toHaveProperty('contextOptions');
  });

  test('safe records traces on the first retry when the config retries', () => {
    const result = withOptimizations<PlaywrightTestConfig>({ retries: 2, use: { trace: 'on' } }, { preset: 'safe' });
    expect(result.use?.trace).toBe('on-first-retry');
  });

  test('fast adds reduced motion, instant animations and context reuse', () => {
    const result = withOptimizations<PlaywrightTestConfig>({}, { preset: 'fast' });
    expect(result.use).toMatchObject({
      contextOptions: { reducedMotion: 'reduce' },
      instantAnimations: true,
      reuseContextWithReset: true,
    });
    expect(result.use).not.toHaveProperty('retryIntervals');
  });

  test('max adds every hook', () => {
    const result = withOptimizations<PlaywrightTestConfig>({}, { preset: 'max' });
    expect(result.use).toMatchObject({
      fastScreenshots: true,
      retryIntervals: [10, 20, 40, 50],
      failFast: true,
      skipStabilityWait: true,
      fastReset: true,
      fastStackTraces: true,
      screenshotMatches: true,
      instantAnimations: true,
    });
  });

  test('turns reuse off when asked, whatever the preset', () => {
    const result = withOptimizations<PlaywrightTestConfig>({}, { preset: 'fast', reuseContext: false });
    expect(result.use).not.toHaveProperty('reuseContextWithReset');
  });

  test('an option named next to the preset wins', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      {},
      { preset: 'max', trace: 'on', experimental: { retryIntervals: [25] } },
    );
    expect(result.use).toMatchObject({ trace: 'on', retryIntervals: [25], fastScreenshots: true });
  });

  test("keeps the config's own screenshots of every test", () => {
    const result = withOptimizations<PlaywrightTestConfig>({ use: { screenshot: 'on' } }, { preset: 'safe' });
    expect(result.use).toMatchObject({ screenshot: 'on' });
    expect(result.use).not.toHaveProperty('failureScreenshots');
  });

  test('keeps the preset where an option is left undefined', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { trace: 'on' } },
      { preset: 'max', trace: undefined, instantAnimations: undefined, experimental: { failFast: undefined } },
    );
    expect(result.use).toMatchObject({
      trace: 'retain-on-failure',
      instantAnimations: true,
      fastScreenshots: true,
      failFast: true,
    });
  });

  test("keeps the config's screenshots of every test when failureScreenshots is named", () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { screenshot: { mode: 'on', fullPage: true } } },
      { failureScreenshots: true },
    );
    expect(result.use?.screenshot).toEqual({ mode: 'on', fullPage: true });
    expect(result.use).not.toHaveProperty('failureScreenshots');
  });

  test('records video in object form on the first retry, with its options', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { retries: 1, use: { video: { mode: 'retain-on-failure', size: { width: 640, height: 480 } } } },
      { videoOnRetry: true },
    );
    expect(result.use?.video).toEqual({ mode: 'on-first-retry', size: { width: 640, height: 480 } });
  });

  test('turns on no trace, screenshot or video the config leaves off', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { trace: 'off', screenshot: 'off', video: 'off' } },
      { preset: 'max' },
    );
    expect(result.use).toMatchObject({ trace: 'off', screenshot: 'off', video: 'off' });
    expect(result.use).not.toHaveProperty('failureScreenshots');
  });

  test('keeps the sub-options of a trace it lowers', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      { use: { trace: { mode: 'on', screenshots: false } } },
      { preset: 'safe' },
    );
    expect(result.use?.trace).toEqual({ mode: 'retain-on-failure', screenshots: false });
  });

  test('refuses an unknown preset', () => {
    expect(() => withOptimizations({}, { preset: 'turbo' as 'safe' })).toThrow(/unknown preset "turbo"/);
  });
});

test('light traces keep the trace mode and leave out snapshots and the screencast', () => {
  const result = withOptimizations<PlaywrightTestConfig>(
    { use: { trace: 'on' } },
    { trace: 'retain-on-failure', lightTraces: true },
  );
  expect(result.use?.trace).toEqual({
    mode: 'retain-on-failure',
    snapshots: { dom: true, aria: false, screen: false },
    screenshots: false,
  });
  const actions = withOptimizations<PlaywrightTestConfig>(
    { use: { trace: { mode: 'on', sources: false } } },
    { lightTraces: 'actions' },
  );
  expect(actions.use?.trace).toEqual({ mode: 'on', sources: false, snapshots: false, screenshots: false });
});

test('records video on the first retry only when the config retries', () => {
  const retrying = withOptimizations<PlaywrightTestConfig>(
    { retries: 2, use: { video: 'retain-on-failure' } },
    { preset: 'safe' },
  );
  expect(retrying.use?.video).toBe('on-first-retry');
  const once = withOptimizations<PlaywrightTestConfig>({ use: { video: 'retain-on-failure' } }, { preset: 'safe' });
  expect(once.use?.video).toBe('retain-on-failure');
});

describe('compileCache', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('sets the cache folder for the runner and its workers', () => {
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', undefined);
    vi.stubEnv('NODE_V8_COVERAGE', undefined);
    vi.stubEnv('NODE_COMPILE_CACHE', undefined);
    const folder = join(mkdtempSync(join(tmpdir(), 'piwi-turbo-')), 'cache');
    withOptimizations({}, { compileCache: folder });
    expect(process.env.NODE_COMPILE_CACHE).toBe(folder);
  });

  test('keeps a compile cache already set', () => {
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', undefined);
    vi.stubEnv('NODE_COMPILE_CACHE', '/somewhere/else');
    withOptimizations({}, { preset: 'safe' });
    expect(process.env.NODE_COMPILE_CACHE).toBe('/somewhere/else');
  });

  test('stays off while coverage is collected', () => {
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', undefined);
    vi.stubEnv('NODE_COMPILE_CACHE', undefined);
    vi.stubEnv('NODE_V8_COVERAGE', join(tmpdir(), 'coverage'));
    withOptimizations({}, { compileCache: true });
    expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();
  });
});
