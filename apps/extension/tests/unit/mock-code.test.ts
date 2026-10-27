import { describe, it, expect } from 'vitest';
import { HIDDEN_VALUE, mockCode, mockFileName, mockUrlPattern, responseBody } from '../../src/shared/mock-code.js';

const cart = {
  method: 'GET',
  url: 'https://shop.test/api/cart',
  status: 200,
  mimeType: 'application/json; charset=utf-8',
  body: JSON.stringify({ items: [{ sku: 'SPRING-TEE', qty: 1 }], total: 40 }),
};

describe('mockUrlPattern', () => {
  it('keeps the path and drops the origin', () => {
    expect(mockUrlPattern('https://shop.test/api/cart')).toBe('**/api/cart');
  });

  it('keeps the query, with the volatile values as a wildcard', () => {
    expect(mockUrlPattern('https://shop.test/api/cart?page=2&_=1695820800000')).toBe('**/api/cart?page=2&_=*');
    expect(mockUrlPattern('https://shop.test/api/items?q=tee&v=6f1c2d3e4a5b6c7d8e9f')).toBe('**/api/items?q=tee&v=*');
    expect(mockUrlPattern('https://shop.test/api/items?flag')).toBe('**/api/items?flag');
  });

  it('matches a credential in the query with a wildcard that takes a slash too, so it is never written', () => {
    expect(mockUrlPattern('https://shop.test/api/cart?page=2&access_token=abc123&apiKey=k')).toBe(
      '**/api/cart?page=2&access_token=**&apiKey=**',
    );
    // Named like one, or shaped like one whatever its name.
    expect(
      mockUrlPattern(
        'https://s3.test/b/o?X-Amz-Signature=ab%2Fcd&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F2026&key=AIzaSyD-abcdefghijklmnopqrstuvwxyz12345&sig=x&code=4%2F0Ab&q=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      ),
    ).toBe('**/b/o?X-Amz-Signature=**&X-Amz-Credential=**&key=**&sig=**&code=**&q=**');
    // A path segment shaped like a token.
    expect(mockUrlPattern('https://shop.test/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln/done')).toBe(
      '**/reset/*/done',
    );
    // A URL whose credentials a stopped test hid already.
    expect(mockUrlPattern('https://shop.test/reset/<hidden>/done?q=<hidden>&token=<hidden>')).toBe(
      '**/reset/*/done?q=**&token=**',
    );
  });

  it('turns glob characters of the URL into wildcards', () => {
    expect(mockUrlPattern('https://shop.test/api/items?filter={a}')).toBe('**/api/items?filter=*a*');
  });
});

describe('mockFileName', () => {
  it('names the file after the last path segment, with its parent for an id', () => {
    expect(mockFileName('https://shop.test/api/cart')).toBe('cart');
    expect(mockFileName('https://shop.test/api/orders/42/')).toBe('orders-42');
    expect(mockFileName('https://shop.test/')).toBe('response');
    expect(mockFileName('https://shop.test/assets/data.json')).toBe('data');
  });
});

describe('mockCode', () => {
  it('fulfills a JSON body with json', () => {
    expect(mockCode(cart).code).toBe(
      [
        "await page.route('**/api/cart', (route) =>",
        '  route.fulfill({',
        '    json: {',
        '      "items": [',
        '        {',
        '          "sku": "SPRING-TEE",',
        '          "qty": 1',
        '        }',
        '      ],',
        '      "total": 40',
        '    },',
        '  }),',
        ');',
      ].join('\n'),
    );
  });

  it('sets the route on the page expression it is given', () => {
    expect(mockCode(cart, { page: 'this.page' }).code).toMatch(
      /^await this\.page\.route\('\*\*\/api\/cart', \(route\) =>/,
    );
    expect(mockCode({ ...cart, method: 'POST' }, { page: 'adminPage' }).code).toMatch(/^await adminPage\.route\(/);
  });

  it('adds the status when it is not 200, and a method check when it is not GET', () => {
    const { code } = mockCode({ ...cart, method: 'post', status: 201, body: '{"id":7}' });
    expect(code).toContain("if (route.request().method() !== 'POST') return route.fallback();");
    expect(code).toContain('status: 201, json: {');
  });

  it('fulfills any other body with its content type', () => {
    const { code } = mockCode({ ...cart, mimeType: 'text/html', body: "<p>It's here</p>\n" });
    expect(code).toContain("route.fulfill({ contentType: 'text/html', body: '<p>It\\'s here</p>\\n' })");
    // A tab, a control character or a line separator stays escaped, so the literal holds on one line.
    const odd = mockCode({ ...cart, mimeType: 'text/plain', body: 'a\tb\u0001c\u2028d' }).code;
    expect(odd).toContain("body: 'a\\tb\\u0001c\\u2028d'");
    const binary = mockCode({ ...cart, mimeType: 'image/png', body: 'iVBORw0KGgo=', base64: true });
    expect(binary.code).toContain("body: Buffer.from('iVBORw0KGgo=', 'base64')");
  });

  it('hides the whole value of a field named like a credential, whatever it holds', () => {
    const body = JSON.stringify({
      tokens: ['t1', 't2'],
      token: { value: 'v', expires: 1 },
      apiKeys: [{ value: 'k1' }],
      refresh_token: 'r',
      hasPassword: true,
      sessionId: null,
      sku: 'SPRING-TEE',
    });
    const { code, hidden } = mockCode({ ...cart, body });
    expect(hidden).toBe(4);
    for (const key of ['tokens', 'token', 'apiKeys', 'refresh_token'])
      expect(code).toContain(`"${key}": "${HIDDEN_VALUE}"`);
    for (const kept of ['"hasPassword": true', '"sessionId": null', '"sku": "SPRING-TEE"'])
      expect(code).toContain(kept);
    for (const secret of ['t1', 'k1', '"v"']) expect(code).not.toContain(secret);
  });

  it('hides a value shaped like a credential wherever it is, in JSON, a form and a text body', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const shaped = [
      jwt,
      'Bearer abcdefghijklmnop',
      ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'),
      'AKIAIOSFODNN7EXAMPLE',
      'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-1234-5678-abcdefghij',
      'sk8Hd92jfKs0dLq3mZx7Pw1VbN4tRy6cUe5o',
    ];
    const json = mockCode({
      ...cart,
      body: JSON.stringify({ note: shaped.join(' '), link: `/reset?token=abc&page=2` }),
    });
    expect(json.hidden).toBe(shaped.length + 1);
    for (const secret of [...shaped, 'token=abc']) expect(json.code).not.toContain(secret);
    expect(json.code).toContain(`/reset?token=${HIDDEN_VALUE}&page=2`);

    const form = mockCode({ ...cart, mimeType: 'application/x-www-form-urlencoded', body: `q=tee&t=${jwt}&sig=1` });
    expect(form.code).toContain('q=tee&t=%3Chidden%3E&sig=%3Chidden%3E');

    const text = mockCode({ ...cart, mimeType: 'text/plain', body: `token: ${jwt}\nsee /cb?code=4/0Ab&x=1` });
    expect(text.code).not.toContain(jwt);
    expect(text.code).toContain(`/cb?code=${HIDDEN_VALUE}&x=1`);
    // A UUID, a hex hash and a long name stay.
    const ids =
      '550e8400-e29b-41d4-a716-446655440000 8f14e45fceea167a5a36dedd4bea2543 getProductRecommendationsForCustomer2024';
    expect(mockCode({ ...cart, mimeType: 'text/plain', body: ids }).hidden).toBe(0);
  });

  it('says a body that is neither JSON nor a form was written as it came, and one that holds personal data', () => {
    for (const mimeType of ['text/plain', 'text/html', 'application/xml']) {
      expect(mockCode({ ...cart, mimeType, body: '<p>ok</p>' })).toMatchObject({ asReceived: true, personal: false });
    }
    expect(mockCode(cart)).toMatchObject({ asReceived: false, personal: false });
    expect(mockCode({ ...cart, mimeType: 'application/x-www-form-urlencoded', body: 'a=1' }).asReceived).toBe(false);
    for (const body of ['{"email":"ada@shop.test"}', '{"contact":"+33 6 12 34 56 78"}', '{"tel":"(555) 123-4567"}']) {
      expect(mockCode({ ...cart, body }).personal, body).toBe(true);
    }
    expect(mockCode({ ...cart, body: '{"date":"2026-10-27","total":1234.5678}' }).personal).toBe(false);
  });

  it('hides credentials unless asked to reveal them', () => {
    const body = JSON.stringify({ user: { name: 'Ada', accessToken: 'abc', password: 'p' }, sessionId: 5 });
    const hidden = mockCode({ ...cart, body });
    expect(hidden.hidden).toBe(3);
    expect(hidden.code).toContain(`"accessToken": "${HIDDEN_VALUE}"`);
    expect(hidden.code).toContain(`"sessionId": "${HIDDEN_VALUE}"`);
    expect(hidden.code).toContain('"name": "Ada"');
    const revealed = mockCode({ ...cart, body }, { reveal: true });
    expect(revealed.hidden).toBe(0);
    expect(revealed.code).toContain('"accessToken": "abc"');
    const form = mockCode({ ...cart, mimeType: 'application/x-www-form-urlencoded', body: 'user=ada&password=p' });
    expect(form.code).toContain('user=ada&password=%3Chidden%3E');
  });

  it('writes a large body to a file the code reads', () => {
    const big = { ...cart, body: JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => ({ i })) }) };
    const result = mockCode(big, { maxInlineBody: 100 });
    expect(result.code).toBe(
      "await page.route('**/api/cart', (route) =>\n  route.fulfill({ contentType: 'application/json', path: 'mocks/cart.json' }),\n);",
    );
    expect(JSON.parse(result.file!.content).rows).toHaveLength(50);
  });

  it('answers a JSON body that a round-trip would change with the body as it came, unless a value is hidden', () => {
    const body = '{"id":12345678901234567890,"__proto__":{"admin":true},"name":"caf\\u00e9"}';
    const { code, hidden } = mockCode({ ...cart, body });
    expect(hidden).toBe(0);
    expect(code).toContain(
      `route.fulfill({ contentType: 'application/json', body: '${body.replace(/\\/g, '\\\\')}' })`,
    );

    const big = mockCode({ ...cart, body }, { maxInlineBody: 10 });
    expect(big.code).toContain("path: 'mocks/cart.json'");
    expect(big.file!.content).toBe(body);

    // A value hidden: the body is written again, every key kept, `__proto__` as the object's own field, and every
    // number with its digits.
    const withToken = mockCode({
      ...cart,
      body: '{"__proto__":{"admin":true},"id":12345678901234567890,"token":"abc"}',
    });
    expect(withToken.hidden).toBe(1);
    expect(withToken.code).toContain('["__proto__"]: {');
    expect(withToken.code).toContain('"id": 12345678901234567890,');
    expect(withToken.code).toContain(`"token": "${HIDDEN_VALUE}"`);
    const start = withToken.code.indexOf('json: ') + 6;
    const literal = withToken.code.slice(start, withToken.code.indexOf('\n    },', start) + 6);
    const json = new Function(`return ${literal};`)() as Record<string, unknown>;
    expect(Object.getPrototypeOf(json)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(json, '__proto__')).toBe(true);
    // The file a large one goes to is JSON, its numbers as they came.
    const file = mockCode({ ...cart, body: '{"id":12345678901234567890,"token":"abc"}' }, { maxInlineBody: 10 }).file!;
    expect(file.content).toBe(`{\n  "id": 12345678901234567890,\n  "token": "${HIDDEN_VALUE}"\n}`);
  });

  it('writes a JSON body nested deeper than it reads as text, its tokens hidden all the same', () => {
    const body = `${'['.repeat(5000)}"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln"${']'.repeat(5000)}`;
    const deep = mockCode({ ...cart, body });
    expect(deep).toMatchObject({ asReceived: true, hidden: 1 });
    expect(deep.code).not.toContain('eyJ');
  });

  it('writes an error or a network failure for the same route', () => {
    expect(mockCode(cart, { kind: 'error' }).code).toBe(
      "await page.route('**/api/cart', (route) =>\n  route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }),\n);",
    );
    expect(mockCode(cart, { kind: 'abort', pattern: '**/api/*' }).code).toBe(
      "await page.route('**/api/*', (route) =>\n  route.abort(),\n);",
    );
  });
});

describe('responseBody', () => {
  type Callback = (content: string | null, encoding: string) => void;
  const entry = (getContent: unknown, content?: { text?: string; encoding?: string }) => ({
    getContent,
    response: { content },
  });

  it('reads what Chrome hands its callback: the content and its encoding', async () => {
    expect(await responseBody(entry((callback: Callback) => callback('aGk=', 'base64'), { text: 'x' }))).toEqual({
      text: 'aGk=',
      base64: true,
    });
    expect(await responseBody(entry((callback: Callback) => callback('{"total":40}', '')))).toEqual({
      text: '{"total":40}',
      base64: false,
    });
  });

  it('calls getContent on its entry, as DevTools’ own request objects need', async () => {
    const request = {
      body: '{"total":40}',
      getContent(this: { body: string }, callback: Callback) {
        callback(this.body, '');
      },
    };
    expect(await responseBody(request)).toEqual({ text: '{"total":40}', base64: false });
  });

  it('reads what Firefox’s promise gives, the content and its MIME type, with the encoding the entry names', async () => {
    expect(await responseBody(entry(() => Promise.resolve(['{"total":40}', 'application/json']), {}))).toEqual({
      text: '{"total":40}',
      base64: false,
    });
    expect(await responseBody(entry(() => Promise.resolve(['aGk=', 'image/png']), { encoding: 'base64' }))).toEqual({
      text: 'aGk=',
      base64: true,
    });
  });

  it('falls back to the body the entry holds when DevTools gives none', async () => {
    expect(await responseBody(entry((callback: Callback) => callback(null, ''), { text: 'kept' }))).toEqual({
      text: 'kept',
      base64: false,
    });
    expect(await responseBody(entry(() => Promise.reject(new Error('gone')), { text: 'kept' }))).toEqual({
      text: 'kept',
      base64: false,
    });
    expect(await responseBody(entry(undefined, { text: 'aGk=', encoding: 'base64' }))).toEqual({
      text: 'aGk=',
      base64: true,
    });
    expect(await responseBody(entry(undefined))).toEqual({ text: null, base64: false });
  });
});
