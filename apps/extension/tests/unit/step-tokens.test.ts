import { describe, it, expect } from 'vitest';
import { describeStepInWords } from '@piwitests/core/bug-report';
import { bugPhrases } from '@piwitests/core/bug-phrases';
import type { RecordedStep, RecordedTarget } from '@piwitests/core/recording';
import { urlParts, wordTokens, type WordToken } from '../../src/shared/step-tokens.js';

const en = bugPhrases('en');
const fr = bugPhrases('fr');

function target(partial: Partial<RecordedTarget>): RecordedTarget {
  return {
    tagName: 'button',
    role: null,
    accessibleName: null,
    testId: null,
    text: null,
    alternatives: [],
    ...partial,
  };
}

function step(partial: Partial<RecordedStep>): RecordedStep {
  return {
    action: 'click',
    target: null,
    value: null,
    redacted: false,
    pageUrl: 'https://shop.test/',
    timestamp: 1,
    ...partial,
  };
}

/** The tokens of a step's words, as `kind:text` lines, plain text left out. */
function marked(s: RecordedStep, phrases = en): string[] {
  return wordTokens(describeStepInWords(s, phrases), s, phrases)
    .filter((token: WordToken) => token.kind !== 'text')
    .map((token) => `${token.kind}:${token.text}`);
}

describe('wordTokens', () => {
  it('sets apart a goto’s address', () => {
    expect(marked(step({ action: 'goto', value: 'https://shop.test/cart?x=1' }))).toEqual([
      'url:https://shop.test/cart?x=1',
    ]);
  });

  it('tells the typed value apart from the field’s name', () => {
    const fill = step({
      action: 'fill',
      value: 'SPRING10',
      target: target({ tagName: 'input', role: 'textbox', accessibleName: 'Coupon' }),
    });
    expect(marked(fill)).toEqual(['name:"Coupon"', 'value:"SPRING10"']);
    expect(marked(fill, fr)).toEqual(['value:«\u202fSPRING10\u202f»', 'name:«\u202fCoupon\u202f»']);
  });

  it('marks a pressed key, and a test id or a locator as code', () => {
    expect(marked(step({ action: 'press', value: 'ControlOrMeta+a' }))).toEqual(['key:Ctrl+A']);
    expect(marked(step({ target: target({ testId: 'cart-total' }) }))).toEqual(['code:cart-total']);
    const byLocator = target({ alternatives: [{ locator: `locator('#total')`, method: 'locator', score: 10 }] });
    expect(marked(step({ target: byLocator }))).toEqual([`locator:locator('#total')`]);
  });

  it('marks the key as a word of its own, not the same letter inside a word', () => {
    expect(marked(step({ action: 'press', value: 'p' }))).toEqual(['key:P']);
    const press = step({ action: 'press', value: 'a' });
    expect(wordTokens(describeStepInWords(press, fr), press, fr)).toEqual([
      { kind: 'text', text: 'Appuyer sur ' },
      { kind: 'key', text: 'A' },
    ]);
  });

  it('keeps an address inside a quoted name in its name, and the next quote pairs as it should', () => {
    const drag = step({
      action: 'dragTo',
      target: target({ tagName: 'a', role: 'link', accessibleName: 'https://a.test/x' }),
      dropTarget: target({ tagName: 'section', role: 'region', accessibleName: 'Drop' }),
    });
    expect(marked(drag)).toEqual(['name:"https://a.test/x"', 'name:"Drop"']);
  });

  it('finds the locators and addresses written in a sentence, and its quoted texts', () => {
    const tokens = wordTokens(
      `Nothing on this page matches getByRole('button', { name: 'Apply' }).first(). Found "Total: 40" on https://shop.test/cart.`,
      null,
      en,
    );
    expect(tokens).toEqual([
      { kind: 'text', text: 'Nothing on this page matches ' },
      { kind: 'locator', text: `getByRole('button', { name: 'Apply' }).first()` },
      { kind: 'text', text: '. Found ' },
      { kind: 'quote', text: '"Total: 40"' },
      { kind: 'text', text: ' on ' },
      { kind: 'url', text: 'https://shop.test/cart' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads a code span fenced around backticks, and leaves an unclosed one as text', () => {
    expect(wordTokens('Run ``a `b` c`` now', null, en)).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'a `b` c' },
      { kind: 'text', text: ' now' },
    ]);
    expect(wordTokens('a ` b', null, en)).toEqual([{ kind: 'text', text: 'a ` b' }]);
  });
});

describe('urlParts', () => {
  it('splits an address into its origin, its path, and the rest', () => {
    expect(urlParts('https://shop.test/cart?x=1#top')).toEqual({
      origin: 'https://shop.test',
      path: '/cart',
      rest: '?x=1#top',
    });
    expect(urlParts('/checkout/thanks')).toEqual({ origin: '', path: '/checkout/thanks', rest: '' });
    expect(urlParts('https://shop.test')).toEqual({ origin: 'https://shop.test', path: '', rest: '' });
  });
});
