import { describe, test, expect } from 'vitest';
import {
  DEFAULT_WASTED_WAIT_PATTERNS,
  parseWastedWaitPatterns,
  isWastedWait,
  computeWastedMs,
} from '#shared/utils/wasted-waits';
import type { TestStepEvent } from '#shared/types';

const wait = (title: string, location: string | null = null): { title: string; location: string | null } => ({
  title,
  location,
});

describe('parseWastedWaitPatterns', () => {
  test('splits on newlines and commas, trimming blanks', () => {
    expect(parseWastedWaitPatterns('a,b\n c , \n d')).toEqual(['a', 'b', 'c', 'd']);
  });

  test('accepts arrays and drops empty entries', () => {
    expect(parseWastedWaitPatterns([' x ', '', 'y'])).toEqual(['x', 'y']);
  });

  test('handles null/undefined', () => {
    expect(parseWastedWaitPatterns(null)).toEqual([]);
    expect(parseWastedWaitPatterns(undefined)).toEqual([]);
  });
});

describe('isWastedWait', () => {
  test('default patterns match explicit waitForTimeout only', () => {
    const p = DEFAULT_WASTED_WAIT_PATTERNS;
    expect(isWastedWait(wait('Wait for timeout'), p)).toBe(true);
    expect(isWastedWait(wait('page.waitForTimeout'), p)).toBe(true);
    expect(isWastedWait(wait('Wait for load state "load"'), p)).toBe(false);
    expect(isWastedWait(wait('Wait for function'), p)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isWastedWait(wait('WAIT FOR TIMEOUT'), ['wait for timeout*'])).toBe(true);
  });

  test('matches against source location', () => {
    expect(
      isWastedWait(wait('Wait for function', '/x/node_modules/@nuxt/test-utils/dist/a.mjs:54:16'), ['*node_modules*']),
    ).toBe(true);
    expect(isWastedWait(wait('Wait for function', '/x/tests/spec.ts:10:1'), ['*node_modules*'])).toBe(false);
  });

  test('? wildcard matches a single char', () => {
    expect(isWastedWait(wait('Wait for X'), ['Wait for ?'])).toBe(true);
    expect(isWastedWait(wait('Wait for XY'), ['Wait for ?'])).toBe(false);
  });

  test('empty allowlist means nothing is wasted', () => {
    expect(isWastedWait(wait('Wait for timeout'), [])).toBe(false);
  });

  test('* matches everything', () => {
    expect(isWastedWait(wait('Wait for load state'), ['*'])).toBe(true);
  });
});

describe('computeWastedMs', () => {
  const events: TestStepEvent[] = [
    { title: 'Before Hooks', category: 'hook', startedAt: 1, duration: 100, status: 'passed' },
    { title: 'Wait for timeout', category: 'wait', startedAt: 2, duration: 3000, status: 'wasted' },
    { title: 'Wait for load state "load"', category: 'wait', startedAt: 3, duration: 78, status: 'wasted' },
    {
      title: 'Wait for function',
      category: 'wait',
      startedAt: 4,
      duration: 2989,
      status: 'wasted',
      location: '/x/node_modules/@nuxt/test-utils/dist/a.mjs:54:16',
    },
  ];

  test('default patterns count only waitForTimeout', () => {
    expect(computeWastedMs(events, DEFAULT_WASTED_WAIT_PATTERNS)).toBe(3000);
  });

  test('* counts all waits but never hooks', () => {
    expect(computeWastedMs(events, ['*'])).toBe(3000 + 78 + 2989);
  });

  test('location pattern selects framework waits', () => {
    expect(computeWastedMs(events, ['*node_modules*'])).toBe(2989);
  });

  test('empty patterns and empty events yield 0', () => {
    expect(computeWastedMs(events, [])).toBe(0);
    expect(computeWastedMs(null, ['*'])).toBe(0);
    expect(computeWastedMs([], ['*'])).toBe(0);
  });

  test('leaves out the time the test stood paused at the pause bar while a wait ran', () => {
    const paused: TestStepEvent[] = [
      ...events,
      { title: 'Click', category: 'pause', startedAt: 1002, duration: 1000, status: 'breakpoint' },
    ];
    expect(computeWastedMs(paused, DEFAULT_WASTED_WAIT_PATTERNS)).toBe(2000);
    expect(computeWastedMs(paused, ['*'])).toBe(2000 + 78 + 1989);
  });
});
