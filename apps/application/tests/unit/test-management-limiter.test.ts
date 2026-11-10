import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE,
  resolveRequestsPerMinute,
} from '#shared/integrations/test-management-limits';
import {
  configuredRequestsPerMinute,
  createRequestLimiter,
  limiterForConnection,
  resetLimitersForTests,
} from '../../server/utils/integrations/test-management/limiter';
import { testManagementForRow } from '../../server/utils/integrations/connections';
import { encryptSecret, getEncryptionKey } from '../../server/utils/crypto';
import type { IntegrationConnection } from '../../server/database/schema';

/**
 * The request limiter of a test management connection: it spaces request starts, follows the environment setting, and
 * is attached to every client a saved connection builds, so the catalog read, the pickers and a refresh share one budget.
 */

process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T09:00:00Z'));
  resetLimitersForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE;
});

describe('createRequestLimiter', () => {
  test('lets the first request go at once and spaces the next ones by the interval', async () => {
    const limiter = createRequestLimiter(3000);
    const started: number[] = [];
    const start = Date.now();
    const calls = [1, 2, 3].map(() => limiter.wait().then(() => started.push(Date.now() - start)));
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toEqual([0, 3000]);
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(calls);
    expect(started).toEqual([0, 3000, 6000]);
  });

  test('a request after a quiet spell goes at once', async () => {
    const limiter = createRequestLimiter(3000);
    await limiter.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    let went = false;
    void limiter.wait().then(() => (went = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(went).toBe(true);
  });
});

describe('the requests a minute setting', () => {
  test.each([
    [undefined, 20, false],
    ['', 20, false],
    ['30', 30, false],
    [' 45 ', 45, false],
    ['0', 20, true],
    ['601', 20, true],
    ['abc', 20, true],
    ['2.5', 20, true],
  ])('%j is %j (invalid: %j)', (raw, value, invalid) => {
    expect(resolveRequestsPerMinute(raw)).toEqual({ value, invalid });
  });

  test('an unusable value is logged once and the default is used', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = 'abc';
    expect(configuredRequestsPerMinute()).toBe(DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE);
    expect(configuredRequestsPerMinute()).toBe(DEFAULT_TEST_MANAGEMENT_REQUESTS_PER_MINUTE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE');
  });

  test('a limiter follows a changed setting, and is shared by one connection', () => {
    process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '30';
    const first = limiterForConnection(1);
    expect(limiterForConnection(1)).toBe(first);
    expect(limiterForConnection(2)).not.toBe(first);
    process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '60';
    expect(limiterForConnection(1)).not.toBe(first);
  });
});

describe('a saved connection’s client', () => {
  const row = (): IntegrationConnection =>
    ({
      id: 7,
      provider: 'zephyr-scale',
      name: 'Zephyr',
      baseUrl: '',
      status: 'unverified',
      config: { region: 'us' },
      credentials: encryptSecret(JSON.stringify({ apiToken: 'limiter-token-value' }), getEncryptionKey()),
    }) as unknown as IntegrationConnection;

  test('sends its requests spaced by the limiter, so two calls are not made together', async () => {
    process.env.PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE = '20';
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ startAt: 0, maxResults: 1000, isLast: true, values: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = testManagementForRow(row())!;
    const calls = [client.listProjects(), client.listProjects()];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(calls);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
