import { describe, expect, test } from 'vitest';
import { beforeFirstTestText } from '../../app/utils/run-before-tests';

describe('beforeFirstTestText', () => {
  test('says global setup while the run initializes, then that its tests start', () => {
    expect(beforeFirstTestText({ initializing: true, heard: false, total: 0 }, 130_000)).toBe(
      'Global setup · 2 minutes 10 seconds',
    );
    expect(beforeFirstTestText({ initializing: false, heard: true, total: 12 }, 1_000)).toBe(
      'Starting 12 tests · 1 second',
    );
    expect(beforeFirstTestText({ initializing: false, heard: true, total: 1 }, 0)).toBe(
      'Starting 1 test · less than a second',
    );
  });

  test('claims no start the page cannot hear', () => {
    expect(beforeFirstTestText({ initializing: false, heard: false, total: 12 }, 5_000)).toBe(
      'Waiting for the run’s tests · 5 seconds',
    );
  });

  test('leaves the time out until the page counts it', () => {
    expect(beforeFirstTestText({ initializing: true, heard: false }, null)).toBe('Global setup');
  });
});
