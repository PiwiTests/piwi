import { describe, expect, test } from 'vitest';
import { coerceDesktopSettings, desktopOrigin } from '../../src/shared/desktop-settings';
import { asReplayVerdict, reproStatus } from '../../src/content/desktop-run-panel';
import { verdictText } from '../../src/content/replay-core';

describe('the desktop app pairing', () => {
  test('takes only plain http on this machine’s loopback, as an origin on 127.0.0.1', () => {
    expect(desktopOrigin('http://127.0.0.1:4318/setup')).toBe('http://127.0.0.1:4318');
    // The app binds 127.0.0.1 alone: another program on the IPv6 loopback never gets the token.
    expect(desktopOrigin(' http://localhost:4318 ')).toBe('http://127.0.0.1:4318');
    expect(desktopOrigin('http://LOCALHOST:4318/')).toBe('http://127.0.0.1:4318');
    expect(desktopOrigin('http://[::1]:4318')).toBe('http://127.0.0.1:4318');
    expect(desktopOrigin('http://localhost')).toBe('http://127.0.0.1');
    expect(desktopOrigin('https://127.0.0.1:4318')).toBeNull();
    expect(desktopOrigin('http://192.168.1.4:4318')).toBeNull();
    expect(desktopOrigin('http://127.0.0.1.example.com')).toBeNull();
    expect(desktopOrigin('not a url')).toBeNull();
  });

  test('reads stored settings only when both the address and the token are usable', () => {
    expect(coerceDesktopSettings({ url: 'http://127.0.0.1:4318', token: ' pd_abc ' })).toEqual({
      url: 'http://127.0.0.1:4318',
      token: 'pd_abc',
    });
    expect(coerceDesktopSettings({ url: 'http://localhost:4318', token: 'pd_abc' })).toEqual({
      url: 'http://127.0.0.1:4318',
      token: 'pd_abc',
    });
    expect(coerceDesktopSettings({ url: 'http://127.0.0.1:4318', token: '' })).toBeNull();
    expect(coerceDesktopSettings({ url: 'https://piwi.example.com', token: 'pd_abc' })).toBeNull();
    expect(coerceDesktopSettings(null)).toBeNull();
  });
});

describe('the desktop app’s verdict', () => {
  test('reads as Replay’s own', () => {
    expect(asReplayVerdict({ kind: 'reproduced', step: 3, found: '"Total: 40"' })).toEqual({
      kind: 'reproduced',
      step: 3,
      found: '"Total: 40"',
      sameAsReported: false,
    });
    expect(asReplayVerdict({ kind: 'diverged', step: 1, reason: 'Test timeout' })).toEqual({
      kind: 'diverged',
      step: 1,
      reason: 'Test timeout',
    });
    expect(asReplayVerdict({ kind: 'not-reproduced' })).toEqual({ kind: 'not-reproduced' });
    expect(asReplayVerdict({ kind: 'completed' })).toEqual({ kind: 'completed' });
  });

  test('says a stopped run without naming a step it never gave', () => {
    const stopped = asReplayVerdict({ kind: 'stopped' });
    expect(stopped).toEqual({ kind: 'stopped', step: null });
    expect(verdictText(stopped!, [])).toEqual({
      title: 'Stopped',
      detail: 'The run ended before the last step: it was stopped, or could not start.',
    });
  });

  test('is none for a verdict or a status this version does not read', () => {
    expect(asReplayVerdict({ kind: 'flaky', step: 2 })).toBeNull();
    expect(asReplayVerdict({ kind: 'reproduced', step: -1, found: null })).toBeNull();
    expect(asReplayVerdict({ kind: 'reproduced', step: 1, found: 4 })).toBeNull();
    expect(asReplayVerdict({ kind: 'diverged', step: 1 })).toBeNull();
    expect(asReplayVerdict(null)).toBeNull();
    expect(asReplayVerdict('reproduced')).toBeNull();
    expect(reproStatus('running')).toBe('running');
    expect(reproStatus('queued')).toBeNull();
    expect(reproStatus(undefined)).toBeNull();
  });
});
