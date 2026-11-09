import { describe, test, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bodyLimitError,
  MAX_EVENT_BATCH_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_OPEN_ROUTE_BODY_BYTES,
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

describe('the desktop app’s run-target routes', () => {
  const routes = [
    { method: 'POST', path: '/api/desktop/run-target/connect' },
    { method: 'PUT', path: '/api/desktop/run-target/key' },
    { method: 'PUT', path: '/api/desktop/run-target/links' },
    { method: 'POST', path: '/api/desktop/run-target/requests/12/answer' },
    { method: 'POST', path: '/api/desktop/run-target/requests/12/plan' },
  ];

  test('take up to 64 KiB, and a 413 past that', () => {
    for (const route of routes) {
      const request = { ...route, contentType: 'application/json' };
      expect(bodyLimitError({ ...request, contentLength: String(64 * 1024) })).toBeNull();
      expect(bodyLimitError({ ...request, contentLength: String(64 * 1024 + 1) })).toEqual({
        statusCode: 413,
        message: 'Request body over 64 KB',
      });
      expect(bodyLimitError({ ...request, transferEncoding: 'chunked' })?.statusCode).toBe(411);
    }
  });
});

describe('the routes that read a body before checking any credential', () => {
  const paths = [
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/oauth/register',
    '/oauth/token',
    '/oauth/revoke',
    '/api/extension/connect',
    '/api/extension/connect/token',
    '/api/desktop/picker-pairings',
    '/api/test-runs/12/heartbeat',
  ];

  test('take up to 64 KiB, and a 413 past that', () => {
    expect(MAX_OPEN_ROUTE_BODY_BYTES).toBe(64 * 1024);
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
    expect(bodyLimitError({ ...json, path: '/api/extension/connect/decision', contentLength: '100000' })).toBeNull();
    expect(bodyLimitError({ ...json, path: '/api/test-runs/12/events', contentLength: '100000' })).toBeNull();
  });

  /**
   * The routes that declare no `x-required-permission` (open to anyone, or
   * authenticated by a token of their own) and read a body, but take a larger
   * one than the open routes' cap, or read it only once a credential checked
   * out. Every other such route is under the cap. Keys are paths relative to
   * the app directory.
   */
  const LARGER_OR_AFTER_CREDENTIAL: Record<string, string> = {
    'server/api/assistant/conversations/[id]/mcp.post.ts':
      'Reads its body after the bearer token of a running answer, from this machine only.',
    'server/api/integrations/jira/webhook/[token].post.ts':
      "Reads its body after the token in its path names a connection; a Jira issue's payload can pass 64 KiB.",
    'server/api/test-runs/[id]/begin.post.ts':
      "Carries the run's metadata, whose `customData` and Playwright `metadata` are the user's and bounded by nothing, so it takes any body's 32 MB; a run that does not exist is refused before the body is read.",
    'server/api/test-runs/[id]/case-files.post.ts': 'A multipart upload, streamed under caps of its own.',
    'server/api/test-runs/[id]/events.post.ts':
      'A batch of test events, up to its own 10 MB: the reporter sends an event alone up to it, and an event carries every step of its test, which nothing bounds; a run that does not exist is refused before the body is read.',
    'server/api/test-runs/[id]/finish.post.ts':
      "Carries a duration per test and the run's metadata, which nothing bounds, so it takes any body's 32 MB; a run that does not exist is refused before the body is read.",
    'server/api/test-runs/[id]/live-resources.post.ts':
      "A post that resets the series names every worker the reporter sampled, which nothing bounds, so it takes any body's 32 MB; a run that does not exist is refused before the body is read.",
    'server/api/test-runs/[id]/live-view.post.ts':
      "Reads its body after the run's live view key, up to its own limit on a message.",
    'server/routes/mcp.post.ts': 'Reads its body after `requireMcpAuth`.',
  };

  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const READS_BODY =
    /\b(?:readBody|readRawBody|readOAuthParams|readMultipartFormData|readFormData|readValidatedBody|getRequestWebStream|readJsonBodyWithin|streamMultipart)(?:<[^()]*>)?\(/;

  /** Every route file that takes a body (any method but GET), relative to the app directory. */
  function bodyRouteFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:post|put|patch|delete)\.ts$/.test(name)) files.push(relative(appDir, path));
      }
    };
    for (const dir of ['server/api', 'server/routes']) walk(join(appDir, dir));
    return files.sort();
  }

  /** The request a route file answers: its method, and its path with `12` for each parameter. */
  function routeRequest(file: string): { method: string; path: string } {
    const [, route, method] = file.match(/^server(?:\/routes)?(\/.*?)(?:\/index)?\.(post|put|patch|delete)\.ts$/)!;
    return { method: method!.toUpperCase(), path: route!.replace(/\[[^\]]+\]/g, '12') };
  }

  test('every route that reads a body before any credential is under the cap, or listed with its reason', () => {
    const open = bodyRouteFiles().filter((file) => {
      const src = readFileSync(join(appDir, file), 'utf8');
      return !src.includes('x-required-permission') && READS_BODY.test(src);
    });
    expect(open.length).toBeGreaterThan(10);
    const uncapped = open
      .filter((file) => !(file in LARGER_OR_AFTER_CREDENTIAL))
      .filter((file) => {
        const request = { ...routeRequest(file), contentType: 'application/json' };
        return bodyLimitError({ ...request, contentLength: String(MAX_OPEN_ROUTE_BODY_BYTES + 1) })?.statusCode !== 413;
      });
    expect(
      uncapped,
      'Add these routes to OPEN_ROUTE_PATHS in server/utils/body-limit.ts, or to LARGER_OR_AFTER_CREDENTIAL with the reason',
    ).toEqual([]);
    expect(Object.keys(LARGER_OR_AFTER_CREDENTIAL).filter((file) => !open.includes(file))).toEqual([]);
  });
});

describe("a streaming run's routes that read the body before its token", () => {
  test('a batch of events takes up to 10 MB, the most the reporter sends, and a 413 naming it past that', () => {
    expect(MAX_EVENT_BATCH_BYTES).toBe(10 * 1024 * 1024);
    for (const path of ['/api/test-runs/12/events', '/api/test-runs/12/events/', '/api/test-runs/12/events?x=1']) {
      expect(bodyLimitError({ ...json, path, contentLength: String(MAX_EVENT_BATCH_BYTES) })).toBeNull();
      expect(bodyLimitError({ ...json, path, contentLength: String(MAX_EVENT_BATCH_BYTES + 1) })).toEqual({
        statusCode: 413,
        message: 'Event batch too large (max 10 MB)',
      });
      expect(bodyLimitError({ ...json, path, transferEncoding: 'chunked' })?.statusCode).toBe(411);
    }
  });

  test("begin, finish and live resources take any body's 32 MB, and a 413 naming it past that", () => {
    for (const route of ['begin', 'finish', 'live-resources']) {
      const path = `/api/test-runs/12/${route}`;
      expect(bodyLimitError({ ...json, path, contentLength: String(MAX_REQUEST_BODY_BYTES) })).toBeNull();
      expect(bodyLimitError({ ...json, path, contentLength: String(MAX_REQUEST_BODY_BYTES + 1) })).toEqual({
        statusCode: 413,
        message: 'Request body over 32 MB',
      });
    }
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
