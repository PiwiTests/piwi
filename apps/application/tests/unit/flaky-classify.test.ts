import { describe, test, expect } from 'vitest';

describe('Flaky root cause classification', () => {
  test('classifies environment when one runner time zone fails and another passes cleanly', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const base = {
      errorMessages: ['expect(received).toBe(expected) Expected: "Monday" Received: "Sunday"'],
      stepErrors: [],
      stepNames: ['expect toHaveText'],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 30, failed: 12 } },
    };
    expect(
      classifyFlakyRootCause({
        ...base,
        runnerDistributions: [{ UTC: { passed: 0, failed: 12 }, 'Europe/Paris': { passed: 30, failed: 0 } }],
      }),
    ).toBe('environment');
    expect(
      classifyFlakyRootCause({
        ...base,
        runnerDistributions: [{ UTC: { passed: 10, failed: 12 }, 'Europe/Paris': { passed: 20, failed: 1 } }],
      }),
    ).toBe('assertion');
  });

  test('classifies timing errors', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['TimeoutError: locator.click: Timeout 30000ms exceeded'],
      stepErrors: [],
      stepNames: ['waitFor navigation'],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 }, firefox: { passed: 3, failed: 4 } },
    });
    expect(result).toBe('timing');
  });

  test('classifies network errors', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['net::ERR_CONNECTION_REFUSED', 'status 500 on POST /api/orders'],
      stepErrors: [],
      stepNames: ['waitForResponse'],
      networkErrorCount: 2,
      status5xxCount: 1,
      browserDistribution: { chromium: { passed: 2, failed: 5 } },
    });
    expect(result).toBe('network');
  });

  test('classifies assertion errors without timing/network keywords', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['expect(received).toBe(expected)\n\nExpected: 3\nReceived: 0'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 } },
    });
    expect(result).toBe('assertion');
  });

  test('falls back to timing when assertion also has timing keywords', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['expect(element).toBeVisible: Timeout 5000ms exceeded'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 } },
    });
    // "to be visible" is a timing keyword, "expect(" is assertion — timing wins
    expect(result).toBe('timing');
  });

  test('classifies environment when one browser fails and another passes', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Some intermittent error'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 }, firefox: { passed: 6, failed: 0 } },
    });
    expect(result).toBe('environment');
  });

  test('is not environment when the other browsers never ran', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Some intermittent error'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 }, firefox: { passed: 0, failed: 0 } },
    });
    expect(result).toBe('other');
  });

  test('is not environment when every browser fails', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Some intermittent error'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 2, failed: 5 }, firefox: { passed: 6, failed: 1 } },
    });
    expect(result).toBe('other');
  });

  test('matches mixed-case network keywords against the error text', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Error: connect ECONNREFUSED 127.0.0.1:3000'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: {},
    });
    expect(result).toBe('network');
  });

  test('matches mixed-case timing keywords against step titles', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Something went wrong'],
      stepErrors: [],
      stepNames: ['page.waitForSelector(#cart)'],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: {},
    });
    expect(result).toBe('timing');
  });

  test('matches mixed-case assertion markers against the error text', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Error: order status mismatch\n\nExpected: "Paid"\nReceived: "Pending"'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: {},
    });
    expect(result).toBe('assertion');
  });

  test('returns other for empty inputs', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: [],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: {},
    });
    expect(result).toBe('other');
  });

  test('returns other for unrecognized errors', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Something went wrong: undefined is not a function'],
      stepErrors: [],
      stepNames: ['do something'],
      networkErrorCount: 0,
      status5xxCount: 0,
      browserDistribution: { chromium: { passed: 0, failed: 1 } },
    });
    expect(result).toBe('other');
  });

  test('an attempt-diff network vote makes an otherwise-unclear flake network', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['Something went wrong: undefined is not a function'],
      stepErrors: [],
      stepNames: ['submit order'],
      networkErrorCount: 0,
      status5xxCount: 0,
      attemptDiffNetworkVotes: 1,
      browserDistribution: { chromium: { passed: 1, failed: 3 } },
    });
    expect(result).toBe('network');
  });

  test('an attempt-diff network vote outweighs a lone assertion keyword', async () => {
    const { classifyFlakyRootCause } = await import('#shared/flaky-classify');
    const result = classifyFlakyRootCause({
      errorMessages: ['expect(received).toBe(expected)'],
      stepErrors: [],
      stepNames: [],
      networkErrorCount: 0,
      status5xxCount: 0,
      attemptDiffNetworkVotes: 2,
      browserDistribution: { chromium: { passed: 1, failed: 3 } },
    });
    expect(result).toBe('network');
  });
});
