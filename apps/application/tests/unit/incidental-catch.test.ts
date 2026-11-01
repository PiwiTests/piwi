/**
 * What *incidental catch* reads from a fixing change: which changed files are
 * tests, the words a cause file is about, and whether a test's identity names them.
 */
import { describe, expect, test } from 'vitest';
import { causeWords, identityNames, isTestFilePath } from '../../server/utils/incidental-catch';

describe('isTestFilePath', () => {
  test('spec and test files, and files under a tests folder, are tests', () => {
    expect(
      ['tests/checkout.spec.ts', 'src/cart.test.tsx', 'e2e/helpers.ts', 'Shop.Tests/CartTests.cs'].map(isTestFilePath),
    ).toEqual([true, true, true, true]);
    expect(['src/cart.ts', 'server/api/tests.get.ts'].map(isTestFilePath)).toEqual([false, false]);
  });
});

describe('causeWords and identityNames', () => {
  test('a file is about its own name, or its folder when the name is generic', () => {
    expect(causeWords('src/pricing/roundingRules.ts')).toEqual(['rounding', 'rules']);
    expect(causeWords('src/checkout/index.ts')).toEqual(['checkout']);
    expect(causeWords('server/api/orders.post.ts')).toEqual(['orders']);
  });

  test('a test names a cause by the same word or one sharing its first five letters', () => {
    expect(identityNames('cart › rounds the total', ['rounding'])).toBe(true);
    expect(identityNames('checkout › pays by card', ['rounding'])).toBe(false);
  });
});
