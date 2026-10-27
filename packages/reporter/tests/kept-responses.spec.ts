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
function response(body: string | Buffer, headers: Record<string, string> = {}, status = 200) {
  const read = { count: 0 };
  return {
    read,
    response: {
      status: () => status,
      headers: () => ({ 'content-type': 'application/json', ...headers }),
      body: async () => {
        read.count++;
        return Buffer.isBuffer(body) ? body : Buffer.from(body);
      },
    } as never,
  };
}

describe('the responses an interactive run keeps', () => {
  afterEach(() => stopKeeping());

  it('keeps nothing until a test keeps responses, and nothing once it ended', async () => {
    const first = response('{}');
    await keepResponse(request(), first.response);
    expect(first.read.count).toBe(0);
    startKeeping();
    await keepResponse(request(), response('{"a":1}').response);
    expect(keptRequests()).toHaveLength(1);
    stopKeeping();
    expect(keptRequests()).toEqual([]);
    expect(keptResponse(1)).toBeNull();
  });

  it('keeps the text answers of fetch and XHR requests alone, without a header', async () => {
    startKeeping(Date.now() - 500);
    await keepResponse(request('xhr', 'post', 'https://shop.test/api/login'), response('{"token":"t"}', {
      'set-cookie': 'session=1',
    }, 201).response);
    await keepResponse(request('fetch'), response('<p>hi</p>', { 'content-type': 'text/html; charset=utf-8' }).response);
    await keepResponse(request('fetch'), response('plain', { 'content-type': '' }).response);
    for (const [kind, body, type] of [
      ['document', '<html></html>', 'text/html'],
      ['script', 'alert(1)', 'application/javascript'],
      ['fetch', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
      ['fetch', Buffer.from([0xff, 0xfe, 0x00]), ''],
      ['fetch', 'a\0b', ''],
    ] as const) {
      await keepResponse(request(kind), response(body, { 'content-type': type }).response);
    }
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
      expect.objectContaining({ id: 3, type: '', size: 5 }),
    ]);
    expect(keptRequests()[0]!.time).toBeGreaterThanOrEqual(500);
    expect(keptResponse(1)).toEqual({
      method: 'POST',
      url: 'https://shop.test/api/login',
      status: 201,
      type: 'application/json',
      body: '{"token":"t"}',
    });
    expect(JSON.stringify(keptRequests())).not.toContain('session=1');
  });

  it('keeps a body of 256 KB at most, and does not read one the response says is larger', async () => {
    startKeeping();
    await keepResponse(request(), response('x'.repeat(MAX_KEPT_BODY)).response);
    await keepResponse(request(), response('x'.repeat(MAX_KEPT_BODY + 1)).response);
    const declared = response('{}', { 'content-length': String(MAX_KEPT_BODY + 1) });
    await keepResponse(request(), declared.response);
    expect(declared.read.count).toBe(0);
    expect(keptRequests().map((r) => r.size)).toEqual([MAX_KEPT_BODY]);
  });

  it('keeps the latest 50, numbered in the order they finished', async () => {
    startKeeping();
    for (let i = 1; i <= MAX_KEPT_RESPONSES + 5; i++) {
      await keepResponse(request('fetch', 'GET', `https://shop.test/api/item/${i}`), response(`{"n":${i}}`).response);
    }
    const kept = keptRequests();
    expect(kept).toHaveLength(MAX_KEPT_RESPONSES);
    expect(kept[0]).toMatchObject({ id: 6, url: 'https://shop.test/api/item/6' });
    expect(kept[kept.length - 1]).toMatchObject({ id: 55 });
    expect(keptResponse(5)).toBeNull();
    expect(keptResponse(55)?.body).toBe('{"n":55}');
  });

  it('drops a body read after its test ended, and a response the browser no longer holds', async () => {
    startKeeping();
    let finish: (body: Buffer) => void = () => {};
    const late = {
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      body: () => new Promise<Buffer>((resolve) => (finish = resolve)),
    } as never;
    const keeping = keepResponse(request(), late);
    stopKeeping();
    startKeeping();
    finish(Buffer.from('{}'));
    await keeping;
    const gone = {
      status: () => 200,
      headers: () => ({}),
      body: async () => {
        throw new Error('Response body is unavailable for redirect responses');
      },
    } as never;
    await keepResponse(request(), gone);
    expect(keptRequests()).toEqual([]);
  });
});
