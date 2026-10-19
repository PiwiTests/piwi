import { describe, expect, test } from 'vitest';
import { maskUrlFragment } from '../src/mask';

describe('maskUrlFragment', () => {
  test('masks the credentials of an OAuth implicit flow or a magic link', () => {
    expect(maskUrlFragment('#access_token=ya29.a0AfH6SM&token_type=Bearer&expires_in=3599')).toBe(
      '#access_token=[masked]&token_type=[masked]&expires_in=3599',
    );
    expect(maskUrlFragment('#/callback?code=4/0AY0e-g7&state=xyz')).toBe('#/callback?code=[masked]&state=xyz');
    expect(maskUrlFragment('#refresh=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')).toBe(
      '#refresh=[masked-token]',
    );
  });

  test('keeps a route-like fragment, masking a token-shaped part of it', () => {
    expect(maskUrlFragment('#/cart/12')).toBe('#/cart/12');
    expect(maskUrlFragment('#section-2')).toBe('#section-2');
    expect(maskUrlFragment('#/reset/0123456789abcdef0123456789abcdef')).toBe('#/reset/[masked-hex]');
    expect(maskUrlFragment('#/list?page=2&sort=name')).toBe('#/list?page=2&sort=name');
  });
});
