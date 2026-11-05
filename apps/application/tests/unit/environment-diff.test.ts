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
    expect(snap.playwrightVersion).toBe('1.49.0');
    expect(snap.viewport).toBe('1280x720');
    expect(snap.isMobile).toBe('no');
    expect(snap.javaScriptEnabled).toBe('yes');
    expect(snap.worker).toBe('2');
    expect(snap.shardIndex).toBeNull();
    expect(snap.channel).toBeNull();
  });

  test('picks up the contrast preference from the browser config', () => {
    const snap = snapshot({ browser: { ...browser, contrast: 'more' } });
    expect(snap.contrast).toBe('more');
  });

  test('reports a contrast preference change with its label', () => {
    const failing = snapshot({ browser: { ...browser, contrast: 'more' } });
    const baseline = snapshot({ browser: { ...browser, contrast: 'no-preference' } });
    const diff = computeEnvironmentDiff(failing, baseline);
    expect(diff).toContainEqual({
      key: 'contrast',
      label: 'Contrast preference',
      failing: 'more',
      baseline: 'no-preference',
    });
  });

  test('never includes non-whitelisted keys such as commit SHA or geolocation', () => {
    const snap = snapshot({
      browser: { ...browser, geolocation: { longitude: 1, latitude: 2 } },
    });
    const keys = Object.keys(snap);
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
      failing: '1.50.1',
      baseline: '1.49.0',
    });
    expect(diff).toContainEqual({ key: 'locale', label: 'Locale', failing: 'de-DE', baseline: 'en-US' });
  });

  test('a value appearing or disappearing counts as a change', () => {
    const failing = snapshot({ browser: { ...browser, channel: 'chrome' } });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([{ key: 'channel', label: 'Browser channel', failing: 'chrome', baseline: null }]);
  });

  test('a browser engine recorded on one side only is not a change', () => {
    const unrecorded = snapshot({ browser: { ...browser, browserName: null } });
    expect(computeEnvironmentDiff(snapshot(), unrecorded)).toEqual([]);
    expect(computeEnvironmentDiff(unrecorded, snapshot())).toEqual([]);
    const firefox = snapshot({ browser: { ...browser, browserName: 'firefox' } });
    expect(computeEnvironmentDiff(firefox, snapshot())).toEqual([
      { key: 'browserName', label: 'Browser', failing: 'firefox', baseline: 'chromium' },
    ]);
  });

  test('viewport changes are formatted as WxH', () => {
    const failing = snapshot({ browser: { ...browser, viewport: { width: 375, height: 667 } } });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([{ key: 'viewport', label: 'Viewport', failing: '375x667', baseline: '1280x720' }]);
  });

  test('names the worker by its lane from 1, else by the worker process of a result without a lane', () => {
    expect(snapshot({ workerIndex: 7, parallelIndex: 0 }).worker).toBe('1');
    expect(snapshot({ workerIndex: 7, parallelIndex: null }).worker).toBe('7');
    expect(snapshot({ workerIndex: null, parallelIndex: null }).worker).toBeNull();
  });

  test('a worker Playwright started again in the same lane is not a change', () => {
    expect(computeEnvironmentDiff(snapshot({ workerIndex: 5 }), snapshot())).toEqual([]);
  });

  test('worker and shard changes are flagged informational', () => {
    const failing = snapshot({ parallelIndex: 3, shardIndex: 1 });
    const diff = computeEnvironmentDiff(failing, snapshot());
    expect(diff).toEqual([
      { key: 'worker', label: 'Worker', failing: '4', baseline: '2', informational: true },
      { key: 'shardIndex', label: 'Shard index', failing: '1', baseline: null, informational: true },
    ]);
  });

  test('keys present in neither snapshot never appear', () => {
    const failing = snapshot({ browser: { ...browser, channel: null } });
    const diff = computeEnvironmentDiff(failing, snapshot({ browser: { ...browser, channel: null } }));
    expect(diff).toEqual([]);
  });
});
