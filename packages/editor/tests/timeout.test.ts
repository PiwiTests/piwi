import { describe, expect, test } from 'vitest';
import { timeoutEdit, timeoutMessage, type TimeoutAdvice } from '../src/analysis';

const oversized: TimeoutAdvice = {
  testCaseId: 1,
  kind: 'oversized-timeout',
  timeout: 120_000,
  p95: 4_100,
  recommendedTimeout: 12_000,
  estimatedSavingMs: 108_000,
};
const staleSlow: TimeoutAdvice = { ...oversized, kind: 'stale-slow', timeout: 90_000, recommendedTimeout: null };

const SPEC = [
  "test('pays', async ({ page }) => {",
  '  test.slow();',
  "  await page.goto('/cart');",
  '});',
  "test('adds', async ({ page }) => {",
  '  test.setTimeout(120_000);',
  '});',
];

describe('timeoutMessage', () => {
  test('says what to change and what it saves', () => {
    expect(timeoutMessage(oversized)).toBe(
      'Timeout 120 s is far above its p95 of 4.1 s: 12 s is enough, about 108 s less per failing run',
    );
    expect(timeoutMessage(staleSlow)).toBe(
      'test.slow() is no longer needed: its p95 is 4.1 s against a 90 s timeout, about 108 s less per failing run',
    );
  });
});

describe('timeoutEdit', () => {
  test('removes a stale test.slow() in the test’s own body', () => {
    expect(timeoutEdit(SPEC, 0, staleSlow)).toEqual({ line: 1, replace: true, text: '' });
    expect(timeoutEdit(SPEC, 4, staleSlow)).toBeNull();
  });

  test('replaces a test.setTimeout, or adds one as the first statement', () => {
    expect(timeoutEdit(SPEC, 4, oversized)).toEqual({ line: 5, replace: true, text: '  test.setTimeout(12000);' });
    expect(timeoutEdit(SPEC, 0, oversized)).toEqual({ line: 1, replace: false, text: '  test.setTimeout(12000);' });
  });

  test('reads a test whose title and function sit on the lines below its call, up to the next such test', () => {
    const spec = [
      'test(',
      "  'pays',",
      '  async ({ page }) => {',
      "    await page.goto('/cart');",
      '  },',
      ');',
      'test(',
      "  'adds',",
      "  { tag: '@cart' },",
      '  async ({ page }) => {',
      '    test.slow();',
      '    test.setTimeout(120_000);',
      '  },',
      ');',
    ];
    expect(timeoutEdit(spec, 0, staleSlow)).toBeNull();
    expect(timeoutEdit(spec, 0, oversized)).toEqual({ line: 3, replace: false, text: '    test.setTimeout(12000);' });
    expect(timeoutEdit(spec, 6, staleSlow)).toEqual({ line: 10, replace: true, text: '' });
    expect(timeoutEdit(spec, 6, oversized)).toEqual({ line: 11, replace: true, text: '    test.setTimeout(12000);' });
    // Details before the function: the statement goes in the function, not in the details.
    const details = ["test('x', {", "  tag: '@a',", '}, async () => {', '  await a();', '});'];
    expect(timeoutEdit(details, 0, oversized)).toEqual({ line: 3, replace: false, text: '  test.setTimeout(12000);' });
  });

  test('reads the whole body past a test.skip, test.fixme or test.fail given a description alone', () => {
    const spec = [
      "test('pays', async ({ page, browserName }) => {",
      "  test.skip('needs a card reader');",
      '  test.fixme(`fails on ${browserName}`);',
      '  test.fail("declines the card");',
      "  test.slow('the bank takes its time');",
      '  test.setTimeout(120_000);',
      '});',
    ];
    expect(timeoutEdit(spec, 0, staleSlow)).toEqual({ line: 4, replace: true, text: '' });
    expect(timeoutEdit(spec, 0, oversized)).toEqual({ line: 5, replace: true, text: '  test.setTimeout(12000);' });
    expect(timeoutEdit(spec.slice(0, 4).concat('});'), 0, oversized)).toEqual({
      line: 1,
      replace: false,
      text: '  test.setTimeout(12000);',
    });
  });

  test('removes a test.slow with a description alone, never one with a condition', () => {
    const slow = (line: string) => timeoutEdit(["test('pays', async () => {", line, '});'], 0, staleSlow);
    expect(slow('  test.slow("the bank takes its time");')).toEqual({ line: 1, replace: true, text: '' });
    expect(slow("  test.slow(`it's ${device} here`)")).toEqual({ line: 1, replace: true, text: '' });
    expect(slow("  test.slow(isMobile, 'slower on a phone');")).toBeNull();
  });

  test('leaves a one-line test alone', () => {
    expect(timeoutEdit(["test('x', async () => {});"], 0, oversized)).toBeNull();
  });
});
