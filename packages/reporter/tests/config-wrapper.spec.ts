import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { PlaywrightTestConfig } from '@playwright/test';
import { wrapConfig, setPlaywrightVersionReader } from '../src/public/config-wrapper.js';
import { PIWI_DEFAULTED_CAPTURE_ENV } from '../src/internal/config/env.js';

describe('wrapConfig', () => {
  it('preserves other config properties', () => {
    const config = wrapConfig<PlaywrightTestConfig>({
      testDir: './tests',
      timeout: 30_000,
      retries: 2,
      fullyParallel: true,
    });
    expect(config.testDir).toBe('./tests');
    expect(config.timeout).toBe(30_000);
    expect(config.retries).toBe(2);
    expect(config.fullyParallel).toBe(true);
  });

  it('forwards failOnFlakyTests into the Playwright config only when set', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' }, { failOnFlakyTests: true });
    expect(config.failOnFlakyTests).toBe(true);
    const off = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect('failOnFlakyTests' in off).toBe(false);
  });

  it('forwards failOnFlakyTests from PIWI_FAIL_ON_FLAKY_TESTS', () => {
    const previous = process.env.PIWI_FAIL_ON_FLAKY_TESTS;
    try {
      process.env.PIWI_FAIL_ON_FLAKY_TESTS = 'true';
      expect(wrapConfig<PlaywrightTestConfig>({ testDir: './tests' }).failOnFlakyTests).toBe(true);

      // An explicit option still wins over the env var.
      process.env.PIWI_FAIL_ON_FLAKY_TESTS = 'true';
      expect(
        'failOnFlakyTests' in wrapConfig<PlaywrightTestConfig>({ testDir: './tests' }, { failOnFlakyTests: false }),
      ).toBe(false);

      process.env.PIWI_FAIL_ON_FLAKY_TESTS = 'false';
      expect('failOnFlakyTests' in wrapConfig<PlaywrightTestConfig>({ testDir: './tests' })).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PIWI_FAIL_ON_FLAKY_TESTS;
      else process.env.PIWI_FAIL_ON_FLAKY_TESTS = previous;
    }
  });

  it('adds piwi global-setup-module when no original globalSetup exists', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(typeof config.globalSetup).toBe('string');
    expect((config.globalSetup as string).includes('global-setup-module')).toBeTruthy();
  });

  it('keeps original globalSetup string and prepends piwi module', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ globalSetup: './tests/globalSetup' });
    expect(Array.isArray(config.globalSetup)).toBeTruthy();
    expect((config.globalSetup as string[]).length).toBe(2);
    expect((config.globalSetup as string[])[0].includes('global-setup-module')).toBeTruthy();
    expect((config.globalSetup as string[])[1]).toBe('./tests/globalSetup');
  });

  it('keeps original globalSetup array and prepends piwi module', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ globalSetup: ['./tests/cleanup', './tests/bootstrap'] });
    expect(Array.isArray(config.globalSetup)).toBeTruthy();
    expect((config.globalSetup as string[]).length).toBe(3);
    expect((config.globalSetup as string[])[0].includes('global-setup-module')).toBeTruthy();
    expect((config.globalSetup as string[])[1]).toBe('./tests/cleanup');
    expect((config.globalSetup as string[])[2]).toBe('./tests/bootstrap');
  });

  it('injects piwi reporter when no reporter is set', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(Array.isArray(config.reporter)).toBeTruthy();
    expect((config.reporter as any[]).length).toBe(1);
    expect((config.reporter as any[])[0][0]).toBe('@piwitests/reporter');
  });

  it('injects piwi reporter alongside an existing string reporter', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ reporter: 'list' });
    expect(Array.isArray(config.reporter)).toBeTruthy();
    expect((config.reporter as any[]).length).toBe(2);
    expect((config.reporter as any[])[1][0]).toBe('@piwitests/reporter');
  });

  it('injects piwi reporter alongside an existing array reporter', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ reporter: [['json', { outputFile: 'report.json' }]] });
    expect(Array.isArray(config.reporter)).toBeTruthy();
    expect((config.reporter as any[]).length).toBe(2);
    expect((config.reporter as any[])[1][0]).toBe('@piwitests/reporter');
  });

  it('does not duplicate piwi reporter if already present', () => {
    const config = wrapConfig<PlaywrightTestConfig>({
      reporter: [['@piwitests/reporter', { projectName: 'test' }]],
    });
    expect(Array.isArray(config.reporter)).toBeTruthy();
    expect((config.reporter as any[]).length).toBe(1);
  });

  it('passes piwiOptions to the injected reporter entry', () => {
    const config = wrapConfig<PlaywrightTestConfig>(
      { testDir: './tests' },
      { projectName: 'my-project', serverUrl: 'http://localhost:3000' },
    );
    const entry = (config.reporter as any[]).find((r: any) => r[0] === '@piwitests/reporter');
    expect(entry).toBeTruthy();
    expect(entry[1]?.projectName).toBe('my-project');
    expect(entry[1]?.serverUrl).toBe('http://localhost:3000');
  });
});

// A Playwright older than 1.63 rejects the `trace.snapshots` object, so the
// default stays the plain string there; pin the version so these tests don't
// depend on whichever Playwright the workspace has installed.
describe('wrapConfig capture defaults (Playwright < 1.63)', () => {
  beforeEach(() => setPlaywrightVersionReader(() => '1.61.1'));
  afterEach(() => {
    setPlaywrightVersionReader(null);
    delete process.env.PIWI_DEFAULT_CAPTURE;
    delete process.env[PIWI_DEFAULTED_CAPTURE_ENV];
  });

  it('defaults screenshot and trace on the top-level use when both are unset', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests', use: { headless: true } });
    expect(config.use?.screenshot).toBe('only-on-failure');
    expect(config.use?.trace).toBe('retain-on-failure');
    // The original use option is preserved.
    expect(config.use?.headless).toBe(true);
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBe(
      "screenshot: 'only-on-failure', trace: 'retain-on-failure'",
    );
  });

  it('defaults trace but keeps an explicit screenshot (only fills the unset one)', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ use: { screenshot: 'on' } });
    expect(config.use?.screenshot).toBe('on');
    expect(config.use?.trace).toBe('retain-on-failure');
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBe("trace: 'retain-on-failure'");
  });

  it("leaves an explicit 'off' untouched and defaults nothing else it already has", () => {
    const config = wrapConfig<PlaywrightTestConfig>({ use: { screenshot: 'off', trace: 'off' } });
    expect(config.use?.screenshot).toBe('off');
    expect(config.use?.trace).toBe('off');
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBeUndefined();
  });

  it('applies defaults even when the config has no use block', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(config.use?.screenshot).toBe('only-on-failure');
    expect(config.use?.trace).toBe('retain-on-failure');
  });

  it('never touches per-project use blocks', () => {
    const config = wrapConfig<PlaywrightTestConfig>({
      projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
    });
    expect((config.projects as any[])[0].use).toEqual({ browserName: 'chromium' });
    expect((config.projects as any[])[0].use.trace).toBeUndefined();
    // The top-level use still gets the defaults.
    expect(config.use?.trace).toBe('retain-on-failure');
  });

  it('opts out with defaultCapture: false', () => {
    const config = wrapConfig<PlaywrightTestConfig>({ use: { headless: true } }, { defaultCapture: false });
    expect(config.use?.screenshot).toBeUndefined();
    expect(config.use?.trace).toBeUndefined();
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBeUndefined();
  });

  it('opts out with PIWI_DEFAULT_CAPTURE=false', () => {
    process.env.PIWI_DEFAULT_CAPTURE = 'false';
    const config = wrapConfig<PlaywrightTestConfig>({ use: { headless: true } });
    expect(config.use?.screenshot).toBeUndefined();
    expect(config.use?.trace).toBeUndefined();

    // An explicit option overrides the env var.
    const on = wrapConfig<PlaywrightTestConfig>({ use: { headless: true } }, { defaultCapture: true });
    expect(on.use?.trace).toBe('retain-on-failure');
  });
});

describe('wrapConfig capture defaults (Playwright 1.63+)', () => {
  afterEach(() => {
    setPlaywrightVersionReader(null);
    delete process.env[PIWI_DEFAULTED_CAPTURE_ENV];
  });

  it('defaults trace to the snapshots object with dom + aria when unset', () => {
    setPlaywrightVersionReader(() => '1.63.0');
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests', use: { headless: true } });
    expect(config.use?.screenshot).toBe('only-on-failure');
    const trace = config.use?.trace as { mode: string; snapshots: Record<string, unknown> };
    expect(trace).toEqual({
      mode: 'retain-on-failure',
      snapshots: { dom: true, aria: true },
    });
    // Screen snapshots stay opt-in — never defaulted on.
    expect(trace.snapshots.screen).toBeUndefined();
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBe(
      "screenshot: 'only-on-failure', trace: 'retain-on-failure' with dom and aria snapshots",
    );
  });

  it('leaves an explicit trace untouched on 1.63', () => {
    setPlaywrightVersionReader(() => '1.63.0');
    const config = wrapConfig<PlaywrightTestConfig>({ use: { trace: 'on' } });
    expect(config.use?.trace).toBe('on');
    expect(process.env[PIWI_DEFAULTED_CAPTURE_ENV]).toBe("screenshot: 'only-on-failure'");
  });

  it('keeps the plain string just below the gate (1.62)', () => {
    setPlaywrightVersionReader(() => '1.62.5');
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(config.use?.trace).toBe('retain-on-failure');
  });

  it('treats an unreadable Playwright version as pre-1.63', () => {
    setPlaywrightVersionReader(() => undefined);
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(config.use?.trace).toBe('retain-on-failure');
  });

  it('turns aria snapshots on for a later major', () => {
    setPlaywrightVersionReader(() => '2.0.0');
    const config = wrapConfig<PlaywrightTestConfig>({ testDir: './tests' });
    expect(config.use?.trace).toEqual({
      mode: 'retain-on-failure',
      snapshots: { dom: true, aria: true },
    });
  });
});
