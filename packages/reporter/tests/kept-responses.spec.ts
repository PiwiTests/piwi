import { afterEach, describe, expect, it } from 'vitest';
import { MAX_KEPT_BODY, MAX_KEPT_RESPONSES } from '@piwitests/core/run-channel';
import {
  keepResponse,
  keptRequests,
  keptResponse,
  startKeeping,
  stopKeeping,
} from '../src/internal/capture/kept-responses.js';

/** A finished request of the page, as Playwright hands it. */
function request(resourceType = 'fetch', method = 'GET', url = 'https://shop.test/api/cart') {
  return { resourceType: () => resourceType, method: () => method, url: () => url } as never;
}

/** Its response; `read` counts the reads of its body. */
function response(body: string | Buffer | Error, headers: Record<string, string> = {}, status = 200) {
  const read = { count: 0 };
  return {
    read,
    response: {
      status: () => status,
      headers: () => ({ 'content-type': 'application/json', ...headers }),
      body: async () => {
        read.count++;
        if (body instanceof Error) throw body;
        return Buffer.isBuffer(body) ? body : Buffer.from(body);
      },
    } as never,
  };
}

/** A body as the editor gets it, with its length as the response says. */
function sized(body: string, headers: Record<string, string> = {}) {
  return response(body, { 'content-length': String(Buffer.byteLength(body)), ...headers });
}

describe('the responses an interactive run keeps', () => {
  afterEach(() => stopKeeping());

  it('keeps nothing until a test keeps responses, and nothing once it ended', async () => {
    await keepResponse(request(), sized('{}').response);
    startKeeping();
    await keepResponse(request(), sized('{"a":1}').response);
    expect(keptRequests()).toHaveLength(1);
    stopKeeping();
    expect(keptRequests()).toEqual([]);
    expect(await keptResponse(1)).toEqual({ refusal: 'The test kept no such response: it keeps the latest 50.' });
  });

  it('keeps the text answers of fetch and XHR requests alone, without a header, and reads no body as it keeps', async () => {
    startKeeping(Date.now() - 500);
    const login = sized('{"token":"t"}', { 'set-cookie': 'session=1' });
    await keepResponse(request('xhr', 'post', 'https://shop.test/api/login'), {
      ...(login.response as object),
      status: () => 201,
    } as never);
    await keepResponse(request('fetch'), sized('<p>hi</p>', { 'content-type': 'text/html; charset=utf-8' }).response);
    await keepResponse(
      request('fetch', 'GET', 'https://shop.test/plain'),
      response('plain', { 'content-type': '' }).response,
    );
    for (const [kind, type] of [
      ['document', 'text/html'],
      ['script', 'application/javascript'],
      ['fetch', 'image/png'],
    ] as const) {
      await keepResponse(request(kind), sized('x', { 'content-type': type }).response);
    }
    expect(login.read.count).toBe(0);
    expect(keptRequests()).toEqual([
      {
        id: 1,
        method: 'POST',
        url: 'https://shop.test/api/login',
        status: 201,
        type: 'application/json',
        size: 13,
        time: expect.any(Number),
      },
      expect.objectContaining({ id: 2, type: 'text/html', size: 9 }),
      // A body sent in chunks says no size.
      expect.objectContaining({ id: 3, type: '', size: null }),
    ]);
    expect(keptRequests()[0]!.time).toBeGreaterThanOrEqual(500);
    expect(await keptResponse(1)).toEqual({
      method: 'POST',
      url: 'https://shop.test/api/login',
      status: 201,
      type: 'application/json',
      body: '{"token":"t"}',
    });
    expect(login.read.count).toBe(1);
    expect(JSON.stringify(keptRequests())).not.toContain('session=1');
  });

  it('lists and hands over a URL with its credentials hidden', async () => {
    startKeeping();
    const url = 'https://shop.test/api/reset?token=abc123&lang=en&key=AIzaSyD-abcdefghijklmnopqrstuvwxyz12345';
    await keepResponse(request('fetch', 'GET', url), sized('{}').response);
    const hidden = 'https://shop.test/api/reset?token=<hidden>&lang=en&key=<hidden>';
    expect(keptRequests()[0]!.url).toBe(hidden);
    expect(await keptResponse(1)).toMatchObject({ url: hidden });
  });

  it('keeps a body of 256 KB at most, as the response says, and hands over one that says no size if it is', async () => {
    startKeeping();
    await keepResponse(request(), sized('x'.repeat(MAX_KEPT_BODY)).response);
    await keepResponse(request(), sized('x'.repeat(MAX_KEPT_BODY + 1)).response);
    await keepResponse(request(), response('x'.repeat(MAX_KEPT_BODY + 1)).response);
    await keepResponse(request(), response('{"chunked":true}').response);
    expect(keptRequests().map((r) => r.size)).toEqual([MAX_KEPT_BODY, null, null]);
    expect(await keptResponse(2)).toEqual({ refusal: 'This answer is larger than 256 KB: Piwi mocks a smaller one.' });
    expect(await keptResponse(3)).toMatchObject({ body: '{"chunked":true}' });
  });

  it('keeps the latest 50, numbered in the order they finished', async () => {
    startKeeping();
    for (let i = 1; i <= MAX_KEPT_RESPONSES + 5; i++) {
      await keepResponse(request('fetch', 'GET', `https://shop.test/api/item/${i}`), sized(`{"n":${i}}`).response);
    }
    const kept = keptRequests();
    expect(kept).toHaveLength(MAX_KEPT_RESPONSES);
    expect(kept[0]).toMatchObject({ id: 6, url: 'https://shop.test/api/item/6' });
    expect(kept[kept.length - 1]).toMatchObject({ id: 55 });
    expect(await keptResponse(5)).toEqual({ refusal: 'The test kept no such response: it keeps the latest 50.' });
    expect(await keptResponse(55)).toMatchObject({ body: '{"n":55}' });
  });

  it('refuses a body the browser no longer holds, one larger than 256 KB, and one that is not text', async () => {
    startKeeping();
    await keepResponse(request(), sized('{}').response);
    await keepResponse(
      request(),
      response(new Error('No resource with given identifier found'), { 'content-length': '2' }).response,
    );
    await keepResponse(request(), response('x'.repeat(MAX_KEPT_BODY + 1), { 'content-length': '2' }).response);
    for (const body of [Buffer.from([0xff, 0xfe, 0x00]), 'a\0b']) {
      await keepResponse(request(), response(body, { 'content-type': '', 'content-length': '3' }).response);
    }
    expect(keptRequests()).toHaveLength(5);
    expect(await keptResponse(1)).toMatchObject({ body: '{}' });
    expect(await keptResponse(2)).toEqual({
      refusal: "The browser no longer holds this answer's body: mock one the page received since it last loaded.",
    });
    expect(await keptResponse(3)).toEqual({ refusal: 'This answer is larger than 256 KB: Piwi mocks a smaller one.' });
    for (const id of [4, 5])
      expect(await keptResponse(id)).toEqual({ refusal: 'This answer is not text: Piwi mocks a text answer.' });
  });

  it('keeps nothing of a request the browser no longer describes', async () => {
    startKeeping();
    const gone = {
      resourceType: () => 'fetch',
      method: () => 'GET',
      url: () => {
        throw new Error('Target page, context or browser has been closed');
      },
    } as never;
    await keepResponse(gone, sized('{}').response);
    expect(keptRequests()).toEqual([]);
  });
});
