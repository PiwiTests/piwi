import { describe, expect, test } from 'vitest';
import { setupLinkToken } from '../../app/utils/setup-link';

/** The setup link's token, read from the address fragment the browser keeps to itself. */
describe('the token of a setup link', () => {
  test('is the value of `setup` in the fragment, percent-decoded only', () => {
    expect(setupLinkToken('#setup=3f9a0c')).toBe('3f9a0c');
    expect(setupLinkToken('#lang=fr&setup=a%2Fb+c')).toBe('a/b+c');
    expect(setupLinkToken('setup=%20padded%20')).toBe('padded');
    expect(setupLinkToken('#setup=%E0%A4%A')).toBe('%E0%A4%A');
  });

  test('is empty for a `setup` key without a value, and absent without the key', () => {
    expect(setupLinkToken('#setup=')).toBeNull();
    expect(setupLinkToken('#setup')).toBeNull();
    expect(setupLinkToken('#settings')).toBeUndefined();
    expect(setupLinkToken('#')).toBeUndefined();
    expect(setupLinkToken('')).toBeUndefined();
  });
});
