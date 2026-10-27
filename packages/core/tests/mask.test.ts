import { describe, expect, test } from 'vitest';
import {
  HIDDEN_VALUE,
  hideSecretsInText,
  holdsPersonalData,
  isSecretName,
  isSecretValue,
  maskUrlFragment,
} from '../src/mask';

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

describe('the credentials a mock, a list or a snapshot hides', () => {
  test('are named by a word of a credential, in any spelling', () => {
    for (const name of [
      'password',
      'pwd',
      'accessToken',
      'refresh_token',
      'api-key',
      'apiKeys',
      'X-Amz-Signature',
      'sig',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of [
      'sessionId',
      'Cookie',
      'client_secret',
      'jwt',
      'csrfToken',
      'code',
      'PIN',
      'X-Amz-Credential',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['author', 'authorId', 'keyboard', 'monkey', 'countryCode', 'passport', 'sku', 'zip']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  test('are shaped like a token, a key a service gives or a random string', () => {
    for (const value of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl',
      'Bearer abcdefghijklmnop',
      ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'),
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxp-1234-5678-abcdefghij',
      'sk8Hd92jfKs0dLq3mZx7Pw1VbN4tRy6cUe5o',
    ]) {
      expect(isSecretValue(value), value).toBe(true);
    }
    for (const value of [
      '550e8400-e29b-41d4-a716-446655440000',
      '8f14e45fceea167a5a36dedd4bea2543',
      'ThisIsAVeryLongCamelCaseIdentifierName123',
      'Mozilla5WindowsNT10Win64x64AppleWebKit537',
      'hello',
    ]) {
      expect(isSecretValue(value), value).toBe(false);
    }
  });

  test('are hidden in a text: a query value named or shaped like one, a URL password, a token anywhere', () => {
    const count = { n: 0 };
    expect(
      hideSecretsInText(
        'go to https://shop.test/reset?token=abc123&lang=en or https://ada:pw@shop.test/ with Bearer abcdefghijklmnop',
        count,
      ),
    ).toBe(
      `go to https://shop.test/reset?token=${HIDDEN_VALUE}&lang=en or https://ada:${HIDDEN_VALUE}@shop.test/ with ${HIDDEN_VALUE}`,
    );
    expect(count.n).toBe(3);
    expect(hideSecretsInText('/b?q=AKIAIOSFODNN7EXAMPLE&page=2')).toBe(`/b?q=${HIDDEN_VALUE}&page=2`);
    expect(hideSecretsInText('/list?page=2&sort=name')).toBe('/list?page=2&sort=name');
  });

  test('tell an email address or a phone number from a date or an amount', () => {
    for (const text of ['ada@shop.test', '+33 6 12 34 56 78', '(555) 123-4567', '{"phone": "x"}', 'email=a']) {
      expect(holdsPersonalData(text), text).toBe(true);
    }
    for (const text of ['2026-10-27', '1234.5678', '{"total": 40}', 'order 12-34-56']) {
      expect(holdsPersonalData(text), text).toBe(false);
    }
  });
});
