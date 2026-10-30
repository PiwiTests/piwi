import { describe, expect, test } from 'vitest';
import {
  HIDDEN_VALUE,
  hideSecretsInText,
  hideSecretsInUrl,
  hideTypedText,
  hideSecretsInLog,
  holdsPersonalData,
  isSecretLocator,
  isSecretAutocomplete,
  isSecretName,
  isSecretValue,
  maskUrlFragment,
} from '../src/mask';

/** A value in a provider's shape, built from parts so no scanner reads it as a live key. */
const shaped = (...parts: string[]) => parts.join('');

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
      'passcode',
      'jsessionid',
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
      // A random token of 40 characters or more, its letters in runs of one case as long as chance makes them.
      'sk8Hd92jfKs0dLq3mZx7Pw1VbN4tRy6cUe5oQ2wXz9Lm',
      'Qx7mbDKzpTrwhJnvNa3sFmqlewyR4uC8ePpGbKdA0vTTyxmQoLn2cW5hgZiUfk9RsB1JeYV6',
      shaped('sk-proj-', 'Sh1pab2-4fRG0leYtAzKkIi0IXT6lWbbYVUyNJ_g2_6XDO6lT3BlbkFJ'),
      shaped('glpat-', '13ArbE5nyBCIwhIbdl4c'),
      shaped('SK', '138277218d9c8f6bca66dcc5ad1d8bab'),
      shaped('whsec_', 'xH7SfQmcPoiKLEayfbetrIRvfBevNwCb'),
      shaped('npm_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
      'Basic dXNlcjpwYXNzd29yZA==',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----',
    ]) {
      expect(isSecretValue(value), value).toBe(true);
    }
    for (const value of [
      '550e8400-e29b-41d4-a716-446655440000',
      '8f14e45fceea167a5a36dedd4bea2543',
      // A git SHA, a SHA-256: hashes, kept.
      'c31cdf852a287e61fcc71852717ba5d999b8cfb3',
      '262728b02ec7f28e57e7b9097eb399f273599b963374d4b47dee0ee5b232dff0',
      'ThisIsAVeryLongCamelCaseIdentifierName123',
      'Mozilla5WindowsNT10Win64x64AppleWebKit537',
      'AbstractSingletonProxyFactoryBean2Impl123',
      // An id shorter than a random token, as a Drive file's, and base64 that encodes text, as a cursor.
      '1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2',
      'sk8Hd92jfKs0dLq3mZx7Pw1VbN4tRy6cUe5o',
      'eyJpZCI6MTIzNDUsInRzIjoxNjk1ODIwODAwfQ==',
      'eyJjdXJzb3IiOnsiaWQiOjEyMzQ1NiwidHMiOjE2OTU4MjA4MDAsImRpciI6Im5leHQiLCJrIjoiYWJjZGVmIn19',
      'how-to-write-better-tests-with-playwright-2024',
      'Basic information',
      'sk-button-primary-large-wide-rounded',
      'hello',
    ]) {
      expect(isSecretValue(value), value).toBe(false);
    }
  });

  test('find a random token of any length, its letters running in one case as chance makes them', () => {
    // A long token holds runs of six letters of one case by chance: still a token.
    const long = 'aB3dEfGhIjK'.repeat(4) + 'abcdefgXYZ' + 'Qr7sTuV9wXyZ'.repeat(30);
    expect(isSecretValue(long)).toBe(true);
    expect(hideSecretsInText(`{"x":"${long}"}`)).toBe(`{"x":"${HIDDEN_VALUE}"}`);
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

  test('are hidden in a text by the shape of a header, a cookie, a key block or a JSON field', () => {
    const basic = 'Basic dXNlcjpwYXNzd29yZA==';
    expect(hideSecretsInText(basic)).toBe(HIDDEN_VALUE);
    expect(hideSecretsInText(`Authorization: ${basic}`)).toBe(`Authorization: ${HIDDEN_VALUE}`);
    expect(hideSecretsInText('Basic information about the cart')).toBe('Basic information about the cart');
    expect(
      hideSecretsInText(
        'key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nggSjAgEAAoIBAQC7\n-----END RSA PRIVATE KEY-----\ndone',
      ),
    ).toBe(`key:\n${HIDDEN_VALUE}\ndone`);
    expect(hideSecretsInText('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nAASCBKcw')).toBe(HIDDEN_VALUE);
    expect(hideSecretsInText('Set-Cookie: sid=s%3Awc5WqfBGH1; Path=/; HttpOnly')).toBe(
      `Set-Cookie: sid=${HIDDEN_VALUE}; Path=/; HttpOnly`,
    );
    expect(hideSecretsInText('Cookie: theme=dark; sid=abc123')).toBe(
      `Cookie: theme=${HIDDEN_VALUE}; sid=${HIDDEN_VALUE}`,
    );
    // JSON written as text (behind a prefix, or nested too deep to read): a field named like a credential.
    expect(hideSecretsInText(`)]}'\n{"password":"hunter2","user":"ada","apiKey":"k-1"}`)).toBe(
      `)]}'\n{"password":"${HIDDEN_VALUE}","user":"ada","apiKey":"${HIDDEN_VALUE}"}`,
    );
    for (const value of [
      shaped('sk-proj-', 'Sh1pab2-4fRG0leYtAzKkIi0IXT6lWbbYVUyNJ_g2_6XDO6lT3BlbkFJ'),
      shaped('glpat-', '13ArbE5nyBCIwhIbdl4c'),
      shaped('SK', '138277218d9c8f6bca66dcc5ad1d8bab'),
    ]) {
      expect(hideSecretsInText(`the key ${value} works`), value).toBe(`the key ${HIDDEN_VALUE} works`);
    }
  });

  test('are hidden in a URL part by part, its host and its ids kept', () => {
    const count = { n: 0 };
    expect(hideSecretsInUrl('https://ada:pw@shop.test:8443/a?token=abc;lang=en#access_token=xyz&state=1', count)).toBe(
      `https://ada:${HIDDEN_VALUE}@shop.test:8443/a?token=${HIDDEN_VALUE};lang=en#access_token=${HIDDEN_VALUE}&state=1`,
    );
    expect(count.n).toBe(3);
    // The value after a `;` is a parameter of its own.
    expect(hideSecretsInText('https://x.test/a?lang=en;token=s3cr3tvalue')).toBe(
      `https://x.test/a?lang=en;token=${HIDDEN_VALUE}`,
    );
    expect(hideSecretsInText('https://x.test/cb#access_token=s3cr3tvalue&state=1')).toBe(
      `https://x.test/cb#access_token=${HIDDEN_VALUE}&state=1`,
    );
    expect(hideSecretsInUrl('/cart;jsessionid=A1B2C3D4/items')).toBe(`/cart;jsessionid=${HIDDEN_VALUE}/items`);
    // Ordinary ids stay, in the path and the query, and the host is never read as a token.
    for (const url of [
      'https://www.googleapis.com/drive/v3/files/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2',
      'https://api.shop.test/v2/items/Ab3x/Cd4y/Ef5z/Gh6w/Ij7v/Kl8u',
      'https://api.shop.test/orders/550e8400-e29b-41d4-a716-446655440000/lines/42?page=2',
      'https://git.shop.test/repo/commit/c31cdf852a287e61fcc71852717ba5d999b8cfb3',
      'https://shop.test/blog/how-to-write-better-tests-with-playwright-2024',
      'https://api.shop.test/graphql?after=YXJyYXljb25uZWN0aW9uOjEwMA==',
      '#/cart/12',
    ]) {
      expect(hideSecretsInUrl(url), url).toBe(url);
      expect(hideSecretsInText(`see ${url} now`), url).toBe(`see ${url} now`);
    }
    // A path segment shaped like a credential, alone.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(hideSecretsInUrl(`https://api.shop.test/reset/${jwt}/confirm`)).toBe(
      `https://api.shop.test/reset/${HIDDEN_VALUE}/confirm`,
    );
  });

  test('take the autocomplete tokens of a field that holds a secret', () => {
    for (const value of ['current-password', 'section-a one-time-code', 'cc-number', 'billing CC-CSC']) {
      expect(isSecretAutocomplete(value), value).toBe(true);
    }
    for (const value of ['email', 'cc-name', '', null, undefined]) expect(isSecretAutocomplete(value)).toBe(false);
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

describe('the text a fill, a typing or an insert types', () => {
  test('goes from the titles Playwright gives the step and the call, the verb and the locator kept', () => {
    // As Playwright 1.64 titles them: the runner's step, then the call with the locator it appends.
    expect(hideTypedText('Fill "S3cr3t!Passw0rd"')).toBe(`Fill "${HIDDEN_VALUE}"`);
    expect(hideTypedText(`Fill "S3cr3t!Passw0rd" getByLabel('Password')`)).toBe(
      `Fill "${HIDDEN_VALUE}" getByLabel('Password')`,
    );
    expect(hideTypedText('Type "abc"')).toBe(`Type "${HIDDEN_VALUE}"`);
    expect(hideTypedText('Insert "typed text"')).toBe(`Insert "${HIDDEN_VALUE}"`);
    expect(hideTypedText('Fill ""')).toBe(`Fill "${HIDDEN_VALUE}"`);
  });

  test('goes whole when it holds quotes, or when the title was cut short', () => {
    expect(hideTypedText('Fill "say "hi" now"')).toBe(`Fill "${HIDDEN_VALUE}"`);
    expect(hideTypedText(`Fill "a" b" getByLabel('Note')`)).toBe(`Fill "${HIDDEN_VALUE}" getByLabel('Note')`);
    expect(hideTypedText('Fill "a long secret cut')).toBe(`Fill "${HIDDEN_VALUE}"`);
  });

  test('leaves every other title as it is', () => {
    for (const title of [
      'Press "Enter"',
      'Click',
      `Click getByRole('button', { name: 'Fill "x"' })`,
      'Expect "toHaveValue"',
      'Fill the form',
    ]) {
      expect(hideTypedText(title), title).toBe(title);
    }
  });

  test('goes from the call log, in a call and in the "Call log" of its error, colored or not', () => {
    const error = [
      'locator.fill: Timeout 1500ms exceeded.',
      'Call log:',
      "  - waiting for getByLabel('Password')",
      '    - locator resolved to <input readonly id="p" type="password"/>',
      '  - fill("S3cr3t!Passw0rd")',
      '  - attempting fill action',
    ].join('\n');
    const hidden = hideSecretsInLog(error);
    expect(hidden).not.toContain('S3cr3t');
    expect(hidden).toContain(`  - fill("${HIDDEN_VALUE}")`);
    expect(hidden).toContain("waiting for getByLabel('Password')");
    expect(hideSecretsInLog('elementHandle.type("abc")')).toBe(`elementHandle.type("${HIDDEN_VALUE}")`);
    expect(hideSecretsInLog('\u001b[2m  - fill("x")\u001b[22m')).toBe(`\u001b[2m  - fill("${HIDDEN_VALUE}")\u001b[22m`);
    // Playwright writes the text as it is: quotes, a parenthesis and line breaks in it go too.
    expect(hideSecretsInLog('  - fill("a ") b")\n  - attempting fill action')).toBe(
      `  - fill("${HIDDEN_VALUE}")\n  - attempting fill action`,
    );
    expect(hideSecretsInLog('  - fill("line one\nline two")\n  - done')).toBe(`  - fill("${HIDDEN_VALUE}")\n  - done`);
    expect(hideSecretsInLog("waiting for locator('#fill')")).toBe("waiting for locator('#fill')");
  });

  test('goes to the end of the text when the call was cut before its end', () => {
    expect(hideSecretsInLog(`  - fill("${'S'.repeat(700)}`)).toBe(`  - fill("${HIDDEN_VALUE}")`);
    expect(hideSecretsInLog('  - type("abc')).toBe(`  - type("${HIDDEN_VALUE}")`);
  });

  test('takes a time linear in the length of the text, for a call never closed too', () => {
    const started = Date.now();
    hideSecretsInLog('fill("x '.repeat(100_000));
    hideSecretsInLog('fill("x")\n'.repeat(100_000));
    hideSecretsInLog(`waiting for a${' '.repeat(200_000)}b`);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the other secrets of a call log', () => {
  // As Playwright 1.64 writes a toHaveValue that timed out on a password field.
  const assertion = [
    'Error: expect(locator).toHaveValue(expected) failed',
    '',
    "Locator:  getByLabel('Password')",
    'Expected: \u001b[32m"S3cr3t!Passw0rd"\u001b[39m',
    'Received: \u001b[31m"S3cr3t!Passw0r"\u001b[39m',
    'Timeout:  5000ms',
    '',
    'Call log:',
    "\u001b[2m  - waiting for getByLabel('Password')\u001b[22m",
    '\u001b[2m      - unexpected value "S3cr3t!Passw0r"\u001b[22m',
  ].join('\n');

  test('an assertion’s values go when its locator names a field that holds a secret, colors kept', () => {
    const hidden = hideSecretsInLog(assertion);
    expect(hidden).not.toMatch(/S3cr3t/);
    expect(hidden).toContain(`Received: \u001b[31m"${HIDDEN_VALUE}"\u001b[39m`);
    expect(hidden).toContain(`unexpected value "${HIDDEN_VALUE}"`);
    // In a live call log, as its lines go.
    expect(hideSecretsInLog(`- waiting for locator('#newpassword')\n  - unexpected value "abc"`)).toContain(
      `unexpected value "${HIDDEN_VALUE}"`,
    );
  });

  test('an assertion’s values stay on any other field', () => {
    const plain = assertion.replaceAll("getByLabel('Password')", "getByLabel('City')");
    expect(hideSecretsInLog(plain)).toBe(plain);
  });

  test('the value of a header named like a credential goes from a request’s log, the others stay', () => {
    const log = [
      'apiRequestContext.get: connect ECONNREFUSED',
      'Call log:',
      '  - → GET https://api.test/orders',
      '    - user-agent: Playwright/1.64.1',
      '    - authorization: Bearer abc.def.ghi',
      '    - x-api-key: abcd1234efgh5678',
      '    - private-token: glpat-0123456789',
    ].join('\n');
    const hidden = hideSecretsInLog(log);
    expect(hidden).not.toMatch(/abc\.def|abcd1234|glpat/);
    expect(hidden).toContain('    - user-agent: Playwright/1.64.1');
    expect(hidden).toContain(`    - authorization: ${HIDDEN_VALUE}`);
    expect(hideSecretsInLog('Error: something failed')).toBe('Error: something failed');
  });
});

describe('a locator naming a field that holds a secret', () => {
  test('is one by a credential word, in English and in the languages Piwi speaks, or by a password field', () => {
    for (const locator of [
      "getByLabel('Password')",
      "locator('#pwd')",
      "getByLabel('PIN')",
      "getByPlaceholder('API key')",
      "getByLabel('Mot de passe')",
      "getByLabel('Passwort')",
      "getByLabel('Contraseña')",
      "getByLabel('Senha')",
      "getByLabel('CVV')",
      "locator('input[type=password]')",
      'locator(\'input[type="password"]\')',
      "getByRole('textbox', { name: 'Code' })",
      "locator('#newpassword')",
      "locator('#password1')",
      "getByLabel('PIN code')",
      "getByLabel('Verification code')",
      "getByLabel('One-time code')",
      "getByTestId('login-pw')",
    ]) {
      expect(isSecretLocator(locator), locator).toBe(true);
    }
  });

  test('is none otherwise, whatever the field holds', () => {
    for (const locator of [
      "getByLabel('Email')",
      "getByLabel('Coupon')",
      "getByLabel('Promo code')",
      "getByLabel('Postal code')",
      "getByRole('button', { name: 'Spinner' })",
      "getByRole('searchbox', { name: 'Search keywords' })",
      "locator('#city')",
    ]) {
      expect(isSecretLocator(locator), locator).toBe(false);
    }
  });
});
