import { describe, expect, test } from 'vitest';
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
    expect(result.projects!.map((project) => project.name)).toEqual(['login', 'tests']);
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
      { use: { screenshot: 'only-on-failure' } },
      { preset: 'safe' },
    );
    expect(result.use).toMatchObject({ trace: 'retain-on-failure', screenshot: 'off', failureScreenshots: true });
    expect(result.use).not.toHaveProperty('contextOptions');
  });

  test('safe records traces on the first retry when the config retries', () => {
    const result = withOptimizations<PlaywrightTestConfig>({ retries: 2 }, { preset: 'safe' });
    expect(result.use?.trace).toBe('on-first-retry');
  });

  test('fast adds reduced motion and instant animations', () => {
    const result = withOptimizations<PlaywrightTestConfig>({}, { preset: 'fast' });
    expect(result.use).toMatchObject({ contextOptions: { reducedMotion: 'reduce' }, instantAnimations: true });
    expect(result.use).not.toHaveProperty('retryIntervals');
  });

  test('experimental adds both hooks', () => {
    const result = withOptimizations<PlaywrightTestConfig>({}, { preset: 'experimental' });
    expect(result.use).toMatchObject({
      fastScreenshots: true,
      retryIntervals: [10, 20, 40, 50],
      instantAnimations: true,
    });
  });

  test('an option named next to the preset wins', () => {
    const result = withOptimizations<PlaywrightTestConfig>(
      {},
      { preset: 'experimental', trace: 'on', experimental: { retryIntervals: [25] } },
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
      { preset: 'experimental', trace: undefined, instantAnimations: undefined, experimental: { failFast: undefined } },
    );
    expect(result.use).toMatchObject({ trace: 'retain-on-failure', instantAnimations: true, fastScreenshots: true });
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
