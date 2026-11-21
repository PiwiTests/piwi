import { expect, test } from 'vitest';
import { checkVersion, validIntervals } from '../src/hooks';
import { TESTED_VERSIONS } from '../src/versions';

test('accepts only tested Playwright versions, unless told otherwise', () => {
  expect(() => checkVersion(TESTED_VERSIONS[0]!)).not.toThrow();
  expect(() => checkVersion('1.0.0')).toThrow(/tested with playwright-core .* and 1\.0\.0 is installed/);
  expect(() => checkVersion('1.0.0', true)).not.toThrow();
});

test('accepts retry intervals only as a non-empty list of milliseconds', () => {
  expect(validIntervals([10, 20])).toEqual([10, 20]);
  expect(validIntervals(undefined)).toBeUndefined();
  for (const bad of [[], [-1], ['10'], 50, [Number.NaN]]) expect(() => validIntervals(bad)).toThrow(/retryIntervals/);
});
