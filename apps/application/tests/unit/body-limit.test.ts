import { describe, test, expect } from 'vitest';
import { bodyLimitError, MAX_REQUEST_BODY_BYTES, readStreamWithin } from '../../server/utils/body-limit';

const json = { method: 'POST', path: '/api/auth/login', contentType: 'application/json' };

describe('bodyLimitError', () => {
  test('a chunked non-multipart body must declare its length', () => {
    expect(bodyLimitError({ ...json, transferEncoding: 'chunked' })?.statusCode).toBe(411);
  });

  test('a body over the limit is refused', () => {
    expect(bodyLimitError({ ...json, contentLength: String(MAX_REQUEST_BODY_BYTES + 1) })?.statusCode).toBe(413);
    expect(bodyLimitError({ ...json, contentLength: '1024' })).toBeNull();
  });

  test('multipart uploads, bodiless requests and the batch submit are left to their routes', () => {
    expect(
      bodyLimitError({ ...json, contentType: 'multipart/form-data; boundary=x', transferEncoding: 'chunked' }),
    ).toBeNull();
    expect(bodyLimitError({ method: 'DELETE', path: '/api/links/1' })).toBeNull();
    expect(bodyLimitError({ method: 'GET', path: '/api/projects', transferEncoding: 'chunked' })).toBeNull();
    expect(
      bodyLimitError({ ...json, path: '/api/test-runs/submit', contentLength: String(MAX_REQUEST_BODY_BYTES * 4) }),
    ).toBeNull();
  });
});

describe('readStreamWithin', () => {
  const stream = (...chunks: string[]) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { body, cancelled: () => cancelled };
  };

  test('reads a body within the limit, whatever its headers say', async () => {
    const { body } = stream('{"v":', '1}');
    expect(new TextDecoder().decode((await readStreamWithin(body, 7))!)).toBe('{"v":1}');
    expect(await readStreamWithin(undefined, 7)).toEqual(new Uint8Array());
  });

  test('stops reading a chunked body once it passes the limit', async () => {
    const { body, cancelled } = stream('1234', '5678', '9');
    expect(await readStreamWithin(body, 6)).toBeNull();
    expect(cancelled()).toBe(true);
  });
});
