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

    // A value hidden: the body is written again, every key kept.
    const withToken = mockCode({ ...cart, body: '{"__proto__":{"admin":true},"token":"abc"}' });
    expect(withToken.hidden).toBe(1);
    expect(withToken.code).toContain('"__proto__": {');
    expect(withToken.code).toContain(`"token": "${HIDDEN_VALUE}"`);
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
