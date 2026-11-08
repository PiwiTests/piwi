import { describe, test, expect } from 'vitest';
import { buildEnvironmentSnapshot, computeEnvironmentDiff } from '#shared/environment-diff';
import type { BrowserConfig } from '#shared/types';

const browser: BrowserConfig = {
  browserName: 'chromium',
  channel: null,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  javaScriptEnabled: true,
  userAgent: 'Mozilla/5.0 Chrome/120',
};

function snapshot(overrides: Parameters<typeof buildEnvironmentSnapshot>[0] = {}) {
  return buildEnvironmentSnapshot({
    playwrightVersion: '1.49.0',
    reporterVersion: '0.11.0',
    environment: 'staging',
    ciProvider: 'github-actions',
    scmBranch: 'main',
    browser,
    workerIndex: 2,
    parallelIndex: 1,
    shardIndex: null,
    ...overrides,
  });
}

describe('buildEnvironmentSnapshot', () => {
  test('flattens whitelisted keys with formatted values', () => {
    const snap = snapshot();
    expect(snap.values.playwrightVersion).toBe('1.49.0');
    expect(snap.values.viewport).toBe('1280x720');
    expect(snap.values.isMobile).toBe('no');
    expect(snap.values.javaScriptEnabled).toBe('yes');
    expect(snap.values.worker).toBe('2');
    expect(snap.values.shardIndex).toBeNull();
    expect(snap.values.channel).toBeNull();
  });

  test('picks up the contrast preference from the browser config', () => {
    const snap = snapshot({ browser: { ...browser, contrast: 'more' } });
    expect(snap.values.contrast).toBe('more');
  });

  test('reports a contrast preference change with its label', () => {
    const failing = snapshot({ browser: { ...browser, contrast: 'more' } });
    const baseline = snapshot({ browser: { ...browser, contrast: 'no-preference' } });
    const diff = computeEnvironmentDiff(failing, baseline);
    expect(diff).toContainEqual({
      key: 'contrast',
      label: 'Contrast preference',
      group: 'browser',
      failing: 'more',
      baseline: 'no-preference',
    });
  });

  test('never includes non-whitelisted keys such as commit SHA or geolocation', () => {
    const snap = snapshot({
      browser: { ...browser, geolocation: { longitude: 1, latitude: 2 } },
    });
    const keys = Object.keys(snap.values);
    expect(keys).not.toContain('geolocation');
    expect(keys).not.toContain('commit');
    expect(keys).not.toContain('bypassCSP');
  });
});

describe('computeEnvironmentDiff', () => {
  test('returns empty array for identical snapshots', () => {
    expect(computeEnvironmentDiff(snapshot(), snapshot())).toEqual([]);
  });

  test('returns only the changed keys with both values', () => {
    const failing = snapshot({ playwrightVersion: '1.50.1', browser: { ...browser, locale: 'de-DE' } });
    const baseline = snapshot();
    const diff = computeEnvironmentDiff(failing, baseline);
    expect(diff).toHaveLength(2);
    expect(diff).toContainEqual({
      key: 'playwrightVersion',
      label: 'Playwright version',
      group: 'run',
      failing: '1.50.1',
      baseline: '1.49.0',
    });
    expect(diff).toContainEqual({
      key: 'locale',
      label: 'Locale (declared)',
      group: 'browser',
      failing: 'de-DE',
      baseline: 'en-US',
    });
  });

  test('a value appearing or disappearing counts as a change', () => {
    const failing = snapshot({ browser: { ...browser, channel: 'chrome' } });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([
      { key: 'channel', label: 'Browser channel', group: 'browser', failing: 'chrome', baseline: null },
    ]);
  });

  test('a browser engine recorded on one side only is not a change', () => {
    const unrecorded = snapshot({ browser: { ...browser, browserName: null } });
    expect(computeEnvironmentDiff(snapshot(), unrecorded)).toEqual([]);
    expect(computeEnvironmentDiff(unrecorded, snapshot())).toEqual([]);
    const firefox = snapshot({ browser: { ...browser, browserName: 'firefox' } });
    expect(computeEnvironmentDiff(firefox, snapshot())).toEqual([
      { key: 'browserName', label: 'Browser', group: 'browser', failing: 'firefox', baseline: 'chromium' },
    ]);
  });

  test('viewport changes are formatted as WxH', () => {
    const failing = snapshot({ browser: { ...browser, viewport: { width: 375, height: 667 } } });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([
      { key: 'viewport', label: 'Viewport', group: 'browser', failing: '375x667', baseline: '1280x720' },
    ]);
  });

  test('names the worker by its lane from 1, else by the worker process of a result without a lane', () => {
    expect(snapshot({ workerIndex: 7, parallelIndex: 0 }).values.worker).toBe('1');
    expect(snapshot({ workerIndex: 7, parallelIndex: null }).values.worker).toBe('7');
    expect(snapshot({ workerIndex: null, parallelIndex: null }).values.worker).toBeNull();
  });

  test('a worker Playwright started again in the same lane is not a change', () => {
    expect(computeEnvironmentDiff(snapshot({ workerIndex: 5 }), snapshot())).toEqual([]);
  });

  test('worker and shard changes are flagged informational', () => {
    const failing = snapshot({ parallelIndex: 3, shardIndex: 1 });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([
      { key: 'worker', label: 'Worker', group: 'run', failing: '4', baseline: '2', informational: true },
      { key: 'shardIndex', label: 'Shard index', group: 'run', failing: '1', baseline: null, informational: true },
    ]);
  });

  test('keys present in neither snapshot never appear', () => {
    const failing = snapshot({ browser: { ...browser, channel: null } });
    const diff = computeEnvironmentDiff(failing, snapshot({ browser: { ...browser, channel: null } }));
    expect(diff).toEqual([]);
  });
});

describe('environment snapshots in the diff', () => {
  const runner = {
    kind: 'runner' as const,
    v: 1 as const,
    shardIndex: null,
    timeZone: 'UTC',
    locale: 'en-US',
    nodeVersion: 'v24.3.0',
    hostname: 'fv-az1',
  };

  test('a runner time zone change is a compared change; a host name change is informational', () => {
    const failing = snapshot({ runner: { ...runner, timeZone: 'Europe/Paris', hostname: 'laptop' } });
    const diff = computeEnvironmentDiff(failing, snapshot({ runner }));
    expect(diff).toContainEqual({
      key: 'runner.timeZone',
      label: 'Time zone',
      group: 'runner',
      failing: 'Europe/Paris',
      baseline: 'UTC',
    });
    expect(diff.find((e) => e.key === 'runner.hostname')?.informational).toBe(true);
  });

  test('a run from an older reporter shows no runner change', () => {
    expect(computeEnvironmentDiff(snapshot({ runner }), snapshot())).toEqual([]);
    expect(computeEnvironmentDiff(snapshot(), snapshot({ runner }))).toEqual([]);
  });

  test("without a browser snapshot the browser time zone is inferred: declared, else the runner's", () => {
    const declared = snapshot({ runner });
    expect(declared.values['browser.timeZone']).toBe('UTC');
    expect(declared.inferred.has('browser.timeZone')).toBe(true);
    const undeclared = snapshot({
      browser: { ...browser, timezoneId: null },
      runner: { ...runner, timeZone: 'Asia/Tokyo' },
    });
    expect(undeclared.values['browser.timeZone']).toBe('Asia/Tokyo');
  });

  test('an inferred value that differs from an observed one is labeled inferred', () => {
    const failing = snapshot({ browser: { ...browser, timezoneId: null }, runner });
    const baseline = snapshot({
      browser: { ...browser, timezoneId: null },
      runner,
      observedBrowser: { kind: 'browser', v: 1, project: 'chromium', timeZone: 'Europe/Paris' },
    });
    const entry = computeEnvironmentDiff(failing, baseline).find((e) => e.key === 'browser.timeZone');
    expect(entry).toMatchObject({ failing: 'UTC', baseline: 'Europe/Paris', failingInferred: true });
    expect(entry?.label).toContain('inferred');
  });

  test('a runner change is not repeated as an inferred browser change', () => {
    const failing = snapshot({
      browser: { ...browser, timezoneId: null },
      runner: { ...runner, timeZone: 'Europe/Paris' },
    });
    const baseline = snapshot({ browser: { ...browser, timezoneId: null }, runner });
    const keys = computeEnvironmentDiff(failing, baseline).map((e) => e.key);
    expect(keys).toContain('runner.timeZone');
    expect(keys).not.toContain('browser.timeZone');
  });

  test('an observed browser value replaces the inferred one', () => {
    const observed = snapshot({
      runner,
      observedBrowser: { kind: 'browser', v: 1, project: 'chromium', timeZone: 'America/New_York' },
    });
    expect(observed.values['browser.timeZone']).toBe('America/New_York');
    expect(observed.inferred.size).toBe(0);
  });

  test('server fields are keyed by origin', () => {
    const server = {
      kind: 'server' as const,
      v: 1 as const,
      origin: 'http://api.test',
      timeZone: 'UTC',
      runtime: '.NET 10.0.1',
    };
    const failing = snapshot({ servers: [{ ...server, runtime: '.NET 10.0.2' }] });
    const diff = computeEnvironmentDiff(failing, snapshot({ servers: [server] }));
    expect(diff).toEqual([
      {
        key: 'server.runtime@http://api.test',
        label: 'Runtime · http://api.test',
        group: 'server',
        failing: '.NET 10.0.2',
        baseline: '.NET 10.0.1',
      },
    ]);
  });
});
