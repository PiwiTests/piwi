import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type { H3Event } from 'h3';
import {
  checkRateLimit,
  limitLookupMisses,
  resetRateLimit,
  rateLimitResetSeconds,
  rateLimitedError,
  rateLimitClientIp,
} from '../../server/utils/rate-limit';

const WINDOW_MS = 15 * 60 * 1000;

/** Minimal H3Event carrying just what the helpers under test read. */
function fakeEvent(opts: { remoteAddress?: string; forwardedFor?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.forwardedFor) headers['x-forwarded-for'] = opts.forwardedFor;
  const setHeader = vi.fn();
  const event = {
    context: {},
    node: {
      req: { headers, socket: { remoteAddress: opts.remoteAddress } },
      res: { setHeader },
    },
  } as unknown as H3Event;
  return { event, setHeader };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('checkRateLimit', () => {
  test('allows up to the limit within a window, then blocks', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('check:basic', 3, WINDOW_MS)).toBe(true);
    }
    expect(checkRateLimit('check:basic', 3, WINDOW_MS)).toBe(false);
  });

  test('starts a fresh window once the previous one expires', () => {
    expect(checkRateLimit('check:expiry', 1, WINDOW_MS)).toBe(true);
    expect(checkRateLimit('check:expiry', 1, WINDOW_MS)).toBe(false);
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(checkRateLimit('check:expiry', 1, WINDOW_MS)).toBe(true);
  });
});

describe('limitLookupMisses', () => {
  const limit = { limit: 2, windowMs: WINDOW_MS };
  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 200,
      (error: { statusCode?: number }) => error.statusCode ?? 500,
    );

  test('counts only the lookups that miss, and refuses once they reach the limit', async () => {
    const { event } = fakeEvent();
    const lookup = (found: boolean) =>
      limitLookupMisses(
        event,
        'miss:basic',
        limit,
        async () => found,
        (f) => !f,
      );
    for (let i = 0; i < 5; i++) expect(await status(lookup(true))).toBe(200);
    expect(await status(lookup(false))).toBe(200);
    expect(await status(lookup(false))).toBe(200);
    expect(await status(lookup(true))).toBe(429);
  });

  test('concurrent misses cannot all pass the check', async () => {
    const { event } = fakeEvent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const miss = () =>
      limitLookupMisses(
        event,
        'miss:concurrent',
        limit,
        async () => {
          await gate;
          return null;
        },
        (found) => !found,
      );
    const statuses = Promise.all(Array.from({ length: 5 }, () => status(miss())));
    release();
    expect((await statuses).sort()).toEqual([200, 200, 429, 429, 429]);
  });

  test('a lookup that throws gives its slot back', async () => {
    const { event } = fakeEvent();
    const failing = () =>
      limitLookupMisses(
        event,
        'miss:throws',
        { limit: 1, windowMs: WINDOW_MS },
        async () => {
          throw new Error('database down');
        },
        () => true,
      );
    expect(await status(failing())).toBe(500);
    expect(await status(failing())).toBe(500);
  });
});

describe('resetRateLimit', () => {
  test('reset clears the counter', () => {
    expect(checkRateLimit('reset:key', 1, WINDOW_MS)).toBe(true);
    expect(checkRateLimit('reset:key', 1, WINDOW_MS)).toBe(false);
    resetRateLimit('reset:key');
    expect(checkRateLimit('reset:key', 1, WINDOW_MS)).toBe(true);
  });
});

describe('rateLimitResetSeconds', () => {
  test('is 0 with no active window', () => {
    expect(rateLimitResetSeconds('seconds:none')).toBe(0);
  });

  test('reports the remaining window, rounded up, and counts down', () => {
    checkRateLimit('seconds:live', 1, WINDOW_MS);
    expect(rateLimitResetSeconds('seconds:live')).toBe(WINDOW_MS / 1000);
    vi.advanceTimersByTime(WINDOW_MS / 3);
    expect(rateLimitResetSeconds('seconds:live')).toBe(600);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(rateLimitResetSeconds('seconds:live')).toBe(0);
  });
});

describe('rateLimitedError', () => {
  test('is a 429 with a Retry-After header from the longest-lived window', () => {
    checkRateLimit('err:short', 1, 60 * 1000);
    checkRateLimit('err:long', 1, 300 * 1000);
    const { event, setHeader } = fakeEvent();
    const error = rateLimitedError(event, ['err:short', 'err:long']);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe('Too many requests. Please wait before trying again.');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 300);
  });

  test('sends at least 1 second even when no window is active', () => {
    const { event, setHeader } = fakeEvent();
    const error = rateLimitedError(event, ['err:missing'], 'Too many failed attempts.');
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe('Too many failed attempts.');
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 1);
  });
});

describe('rateLimitClientIp', () => {
  test('uses the socket address by default, even when X-Forwarded-For is present', () => {
    const { event } = fakeEvent({ remoteAddress: '203.0.113.9', forwardedFor: '198.51.100.7' });
    expect(rateLimitClientIp(event)).toBe('203.0.113.9');
  });

  test('falls back to "unknown" without an address', () => {
    const { event } = fakeEvent();
    expect(rateLimitClientIp(event)).toBe('unknown');
  });

  test('with PIWI_TRUST_PROXY, uses the last X-Forwarded-For entry', () => {
    vi.stubEnv('PIWI_TRUST_PROXY', 'true');
    const { event } = fakeEvent({
      remoteAddress: '127.0.0.1',
      forwardedFor: '198.51.100.7, 192.0.2.1 , 10.0.0.3',
    });
    expect(rateLimitClientIp(event)).toBe('10.0.0.3');
  });

  test('with PIWI_TRUST_PROXY but no header, falls back to the socket address', () => {
    vi.stubEnv('PIWI_TRUST_PROXY', 'true');
    const { event } = fakeEvent({ remoteAddress: '203.0.113.9' });
    expect(rateLimitClientIp(event)).toBe('203.0.113.9');
  });
});
