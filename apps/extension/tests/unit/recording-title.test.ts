import { describe, it, expect, afterEach } from 'vitest';
import type { RecordedStep } from '@piwitests/core/recording';
import { cleanTitle, recordingTitle, titleFromSteps } from '../../src/shared/recording-title.js';
import { setBrowserLanguage } from './setup-i18n.js';

const goto: RecordedStep = {
  action: 'goto',
  target: null,
  value: 'https://shop.test/cart?ref=mail',
  redacted: false,
  pageUrl: 'https://shop.test/cart?ref=mail',
  timestamp: 1,
};

const click: RecordedStep = {
  action: 'click',
  target: {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Apply',
    testId: null,
    text: 'Apply',
    alternatives: [{ locator: `getByRole('button', { name: 'Apply' })`, method: 'getByRole', score: 90 }],
  },
  value: null,
  redacted: false,
  pageUrl: 'https://shop.test/cart',
  timestamp: 2,
};

afterEach(() => setBrowserLanguage('en'));

describe('a recording’s title', () => {
  it('is the one it was given, on one line and trimmed', () => {
    expect(recordingTitle({ title: '  Apply a\n coupon ' }, [goto, click])).toBe('Apply a coupon');
    expect(cleanTitle('x'.repeat(300))).toHaveLength(120);
  });

  it('is the first action in words when it has none, else the first page’s path', () => {
    expect(recordingTitle({ title: null }, [goto, click])).toBe('Click button "Apply"');
    expect(recordingTitle({ title: '   ' }, [goto, click])).toBe('Click button "Apply"');
    expect(recordingTitle({}, [goto])).toBe('/cart');
    expect(titleFromSteps([])).toBeNull();
  });

  it('is written in the interface language', () => {
    setBrowserLanguage('fr');
    const title = titleFromSteps([goto, click]);
    expect(title).not.toBe('Click button "Apply"');
    expect(title).toContain('Apply');
  });
});
