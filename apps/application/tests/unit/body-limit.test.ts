import { describe, test, expect, afterEach } from 'vitest';
import {
  bodyLimitError,
  MAX_REQUEST_BODY_BYTES,
  MAX_SIGN_IN_BODY_BYTES,
  readStreamWithin,
} from '../../server/utils/body-limit';
import { DEFAULT_MAX_SUBMIT_BYTES } from '#shared/upload-limits';

const json = { method: 'POST', path: '/api/auth/login', contentType: 'application/json' };

describe('bodyLimitError', () => {
  test('a chunked non-multipart body must declare its length', () => {
    expect(bodyLimitError({ ...json, transferEncoding: 'chunked' })?.statusCode).toBe(411);
  });

  test('a body over the limit is refused', () => {
    expect(bodyLimitError({ ...json, contentLength: String(MAX_REQUEST_BODY_BYTES + 1) })?.statusCode).toBe(413);
    expect(bodyLimitError({ ...json, contentLength: '1024' })).toBeNull();
  });

  test('multipart uploads and bodiless requests are left to their routes', () => {
    const multipart = { method: 'POST', contentType: 'multipart/form-data; boundary=x', transferEncoding: 'chunked' };
    for (const path of [
      '/api/test-runs/upload',
      '/api/test-runs/import',
      '/api/test-runs/12/case-files',
      '/api/projects/3/bug-reports',
    ]) {
      expect(bodyLimitError({ ...multipart, path })).toBeNull();
    }
    expect(bodyLimitError({ method: 'DELETE', path: '/api/links/1' })).toBeNull();
    expect(bodyLimitError({ method: 'GET', path: '/api/projects', transferEncoding: 'chunked' })).toBeNull();
  });

  test('a multipart body sent to a route that buffers it follows the same rules as any other body', () => {
    const multipart = { method: 'POST', path: '/api/projects', contentType: 'multipart/form-data; boundary=x' };
    expect(bodyLimitError({ ...multipart, transferEncoding: 'chunked' })?.statusCode).toBe(411);
    expect(bodyLimitError({ ...multipart, contentLength: String(MAX_REQUEST_BODY_BYTES + 1) })?.statusCode).toBe(413);
    expect(
      bodyLimitError({ ...multipart, path: '/api/test-runs/12/case-files/extra', transferEncoding: 'chunked' })
        ?.statusCode,
    ).toBe(411);
  });
});

describe('the routes that read a body before anyone is signed in', () => {
  const paths = [
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
  ];

  test('take up to 64 KiB, and a 413 past that', () => {
    expect(MAX_SIGN_IN_BODY_BYTES).toBe(64 * 1024);
    for (const path of paths) {
      for (const sent of [path, `${path}/`, `${path}?next=/`]) {
        expect(bodyLimitError({ ...json, path: sent, contentLength: String(64 * 1024) })).toBeNull();
        expect(bodyLimitError({ ...json, path: sent, contentLength: String(64 * 1024 + 1) })).toEqual({
          statusCode: 413,
          message: 'Request body over 64 KB',
        });
      }
      expect(bodyLimitError({ ...json, path, transferEncoding: 'chunked' })?.statusCode).toBe(411);
    }
    expect(bodyLimitError({ ...json, path: '/api/auth/change-password', contentLength: '100000' })).toBeNull();
  });
});

describe("a run's results sent as JSON", () => {
  const paths = ['/api/test-runs/submit', '/api/test-runs/upload/results', '/api/test-runs/submit/?x=1'];
  afterEach(() => {
    delete process.env.PIWI_SUBMIT_MAX_BYTES;
  });

  test('take up to PIWI_SUBMIT_MAX_BYTES, 256 MiB by default, and a 413 naming it past that', () => {
    for (const path of paths) {
      expect(bodyLimitError({ ...json, path, contentLength: String(MAX_REQUEST_BODY_BYTES * 4) })).toBeNull();
      expect(bodyLimitError({ ...json, path, contentLength: String(DEFAULT_MAX_SUBMIT_BYTES) })).toBeNull();
      const refused = bodyLimitError({ ...json, path, contentLength: String(DEFAULT_MAX_SUBMIT_BYTES + 1) });
      expect(refused?.statusCode).toBe(413);
      expect(refused?.message).toContain('PIWI_SUBMIT_MAX_BYTES');
    }
    process.env.PIWI_SUBMIT_MAX_BYTES = String(8 * 1024 * 1024);
    expect(bodyLimitError({ ...json, path: paths[0]!, contentLength: String(8 * 1024 * 1024 + 1) })).toMatchObject({
      statusCode: 413,
      message: "Request body over 8 MB: PIWI_SUBMIT_MAX_BYTES sets the limit on a run's results",
    });
  });

  test('must declare their length', () => {
    for (const path of paths) {
      expect(bodyLimitError({ ...json, path, transferEncoding: 'chunked' })?.statusCode).toBe(411);
    }
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
