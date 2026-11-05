import { describe, expect, test } from 'vitest';
import { beforeFirstTestText } from '../../app/utils/run-before-tests';

describe('beforeFirstTestText', () => {
  test('says global setup until the run knows its tests, then that they start', () => {
    expect(beforeFirstTestText(0, 130_000)).toBe('Global setup · 2 minutes 10 seconds');
    expect(beforeFirstTestText(null, 5_000)).toBe('Global setup · 5 seconds');
    expect(beforeFirstTestText(12, 1_000)).toBe('Starting 12 tests · 1 second');
    expect(beforeFirstTestText(1, 0)).toBe('Starting 1 test · less than a second');
  });

  test('leaves the time out until the page counts it', () => {
    expect(beforeFirstTestText(0, null)).toBe('Global setup');
  });
});
