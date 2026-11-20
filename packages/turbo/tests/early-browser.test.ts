import { describe, expect, test } from 'vitest';
import { browserEnv, earlyBrowserRefusal, launchableOptions } from '../src/early-browser';

describe('launchableOptions', () => {
  test('keeps the options of a headless launch that hold no credential', () => {
    expect(
      launchableOptions({
        handleSIGINT: false,
        headless: true,
        args: ['--mute-audio'],
        tracesDir: '/t',
        slowMo: undefined,
      }),
    ).toEqual({ handleSIGINT: false, headless: true, args: ['--mute-audio'], tracesDir: '/t' });
  });

  test('refuses a headed launch, devtools, and options that can hold a credential', () => {
    expect(launchableOptions({ headless: false })).toBeUndefined();
    expect(launchableOptions({ devtools: true })).toBeUndefined();
    expect(launchableOptions({ proxy: { server: 'http://p', username: 'u', password: 'p' } })).toBeUndefined();
    expect(launchableOptions({ env: { TOKEN: 'secret' } })).toBeUndefined();
    expect(launchableOptions({ firefoxUserPrefs: {} })).toBeUndefined();
  });
});

describe('browserEnv', () => {
  test("keeps the variables the browser or its launch reads, and leaves out the runner's and the others", () => {
    const env = browserEnv({
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      PLAYWRIGHT_BROWSERS_PATH: '/browsers',
      https_proxy: 'http://proxy',
      PLAYWRIGHT_LEGACY_SCREENSHOT: '1',
      SELENIUM_REMOTE_URL: 'http://grid',
      SSLKEYLOGFILE: '/keys',
      PLAYWRIGHT_FORCE_TTY: '0',
      PW_TEST_REUSE_CONTEXT: '1',
      TEST_WORKER_INDEX: '0',
      CI: '1',
      APP_SECRET: 'kept out',
    });
    expect(env).toEqual({
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      PLAYWRIGHT_BROWSERS_PATH: '/browsers',
      https_proxy: 'http://proxy',
      PLAYWRIGHT_LEGACY_SCREENSHOT: '1',
      SELENIUM_REMOTE_URL: 'http://grid',
      SSLKEYLOGFILE: '/keys',
    });
  });
});

describe('earlyBrowserRefusal', () => {
  const early = { options: { headless: true, tracesDir: '/t' }, env: { TZ: 'UTC' } };

  test('accepts a Chromium launch with the same options and browser environment', () => {
    expect(earlyBrowserRefusal(early, 'chromium', { headless: true, tracesDir: '/t' }, { TZ: 'UTC', CI: '1' })).toBe(
      undefined,
    );
  });

  test('refuses another browser, other options, or a changed variable the browser reads', () => {
    expect(earlyBrowserRefusal(early, 'firefox', early.options, { TZ: 'UTC' })).toBe('the worker launches firefox');
    expect(earlyBrowserRefusal(early, 'chromium', undefined, { TZ: 'UTC' })).toContain('options an early browser');
    expect(earlyBrowserRefusal(early, 'chromium', { headless: true, tracesDir: '/u' }, { TZ: 'UTC' })).toBe(
      'the launch options changed',
    );
    expect(earlyBrowserRefusal(early, 'chromium', early.options, { TZ: 'Asia/Tokyo' })).toBe('TZ changed');
    expect(earlyBrowserRefusal(early, 'chromium', early.options, { TZ: 'UTC', LANG: 'fr_FR' })).toBe('LANG changed');
  });
});
