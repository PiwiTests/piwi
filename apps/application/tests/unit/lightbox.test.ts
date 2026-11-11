import { describe, expect, test } from 'vitest';
import { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';
import { attachmentOwnName, splitExpected } from '../../app/utils/lightbox';

const LONG_NAME =
  'Step 2: Add one wireless mouse and two USB-C cables, then open the cart page, check that the badge counts ' +
  'three items, and wait for the shipping estimate to load before taking the screenshot of the summary';

describe('attachmentOwnName', () => {
  test('keeps a custom name whole, however long', () => {
    expect(attachmentOwnName(LONG_NAME, 'runs/12/Step-2-Add-one-wireless-mouse.png')).toBe(LONG_NAME);
  });

  test('keeps a short custom name', () => {
    expect(attachmentOwnName('cart page', 'runs/12/cart-page.png')).toBe('cart page');
  });

  test.each([
    ['no name', null],
    ['an empty name', ''],
    ['a blank name', '   '],
    ['the failure screenshot of the capture fixtures', FAILURE_SCREENSHOT_ATTACHMENT],
    ["Playwright's screenshot", 'screenshot'],
    ["the file's own name", 'cart-summary.png'],
  ])('says nothing for %s', (_label, name) => {
    expect(attachmentOwnName(name, 'runs/12/cart-summary.png')).toBeNull();
  });
});

describe('splitExpected', () => {
  test('splits a step from its expected result', () => {
    expect(splitExpected('Step 13: Click Generate new code | Expected: The new code is not the expired one.')).toEqual({
      step: 'Step 13: Click Generate new code',
      expected: 'The new code is not the expired one.',
    });
  });

  test('keeps a long name with no expected result whole', () => {
    expect(splitExpected(LONG_NAME)).toEqual({ step: LONG_NAME, expected: null });
  });

  test('gives no expected result when the name ends at the separator', () => {
    expect(splitExpected('Step 4: Open the cart | Expected:')).toEqual({
      step: 'Step 4: Open the cart',
      expected: null,
    });
    expect(splitExpected('Step 4: Open the cart | Expected:   ')).toEqual({
      step: 'Step 4: Open the cart',
      expected: null,
    });
  });

  test('splits at the first separator only', () => {
    expect(splitExpected('Step 5: Compare | Expected: A | Expected: B')).toEqual({
      step: 'Step 5: Compare',
      expected: 'A | Expected: B',
    });
  });

  test('tolerates the spacing around the separator', () => {
    expect(splitExpected('Step 6: Save|Expected:Saved')).toEqual({ step: 'Step 6: Save', expected: 'Saved' });
    expect(splitExpected('Step 6: Save  |  Expected:  Saved')).toEqual({ step: 'Step 6: Save', expected: 'Saved' });
  });

  test('keeps a name that opens with the separator whole', () => {
    expect(splitExpected('| Expected: Saved')).toEqual({ step: '| Expected: Saved', expected: null });
  });
});
