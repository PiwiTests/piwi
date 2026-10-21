import { describe, it, expect } from 'vitest';
import { bugPhrases } from '@piwitests/core/bug-phrases';
import { sentenceTokens, urlParts } from '../../src/shared/sentence-tokens.js';

const en = bugPhrases('en');
const fr = bugPhrases('fr');

describe('sentenceTokens', () => {
  it('finds the locators and addresses written in a sentence, and its quoted texts', () => {
    expect(
      sentenceTokens(
        `Nothing on this page matches getByRole('button', { name: 'Apply' }).first(). Found "Total: 40" on https://shop.test/cart.`,
        en,
      ),
    ).toEqual([
      { kind: 'text', text: 'Nothing on this page matches ' },
      { kind: 'locator', text: `getByRole('button', { name: 'Apply' }).first()` },
      { kind: 'text', text: '. Found ' },
      { kind: 'quote', text: '"Total: 40"' },
      { kind: 'text', text: ' on ' },
      { kind: 'url', text: 'https://shop.test/cart' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads a locator with double quotes as a locator, and an address inside quotes as the quoted text', () => {
    expect(sentenceTokens(`getByText("Total") shows "see https://a.test/x" now`, en)).toEqual([
      { kind: 'locator', text: 'getByText("Total")' },
      { kind: 'text', text: ' shows ' },
      { kind: 'quote', text: '"see https://a.test/x"' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('quotes the way the language does', () => {
    expect(sentenceTokens('Résultat : « Total: 40 ».', fr)).toEqual([
      { kind: 'text', text: 'Résultat : ' },
      { kind: 'quote', text: '« Total: 40 »' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads a code span fenced around backticks, and leaves an unclosed one as text', () => {
    expect(sentenceTokens('Run ``a `b` c`` now', en)).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'a `b` c' },
      { kind: 'text', text: ' now' },
    ]);
    expect(sentenceTokens('a ` b', en)).toEqual([{ kind: 'text', text: 'a ` b' }]);
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
