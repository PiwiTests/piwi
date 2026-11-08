import { describe, it, expect } from 'vitest';
import { buildServerEnvironment, type EnvironmentReaders } from '../src/environment';

const NOW = Date.parse('2026-03-29T10:00:00.000Z');

function readers(overrides: Partial<EnvironmentReaders> = {}): EnvironmentReaders {
  return {
    nodeVersion: () => 'v24.3.0',
    platform: () => 'linux',
    release: () => '6.8.0-45-generic',
    arch: () => 'x64',
    hostname: () => 'web-1',
    resolvedOptions: () => ({ timeZone: 'Europe/Paris', locale: 'fr-FR' }),
    timezoneOffset: () => -120,
    icuVersion: () => '76.1',
    hasFullIcu: () => true,
    nodeEnv: () => 'test',
    instanceId: () => 'a1b2c3d4e5f6',
    uptime: () => 90,
    now: () => NOW,
    ...overrides,
  };
}

describe('buildServerEnvironment', () => {
  it('reads every field from the process', () => {
    expect(buildServerEnvironment(readers())).toEqual({
      v: 1,
      runtime: 'Node.js v24.3.0',
      os: 'linux 6.8.0-45-generic',
      arch: 'x64',
      timeZone: 'Europe/Paris',
      utcOffsetMinutes: 120,
      locale: 'fr-FR',
      globalization: 'icu 76.1 full',
      environmentName: 'test',
      appVersion: null,
      hostname: 'web-1',
      instance: 'a1b2c3d4e5f6',
      startedAt: '2026-03-29T09:58:30.000Z',
      now: NOW,
    });
  });

  it('names small ICU, a zone west of UTC and UTC itself', () => {
    expect(buildServerEnvironment(readers({ hasFullIcu: () => false })).globalization).toBe('icu 76.1 small');
    expect(buildServerEnvironment(readers({ timezoneOffset: () => 300 })).utcOffsetMinutes).toBe(-300);
    expect(Object.is(buildServerEnvironment(readers({ timezoneOffset: () => 0 })).utcOffsetMinutes, 0)).toBe(true);
  });

  it('writes null for a fact it cannot read', () => {
    const env = buildServerEnvironment(
      readers({
        icuVersion: () => undefined,
        nodeEnv: () => undefined,
        hostname: () => {
          throw new Error('no hostname');
        },
      }),
    );
    expect(env.globalization).toBeNull();
    expect(env.environmentName).toBeNull();
    expect(env.hostname).toBeNull();
  });

  it('reads the real process without throwing, and keeps the instance across calls', () => {
    const first = buildServerEnvironment();
    expect(first.runtime).toBe(`Node.js ${process.version}`);
    expect(typeof first.instance).toBe('string');
    expect(buildServerEnvironment().instance).toBe(first.instance);
    expect(Date.parse(first.startedAt!)).toBeLessThanOrEqual(first.now!);
  });
});
