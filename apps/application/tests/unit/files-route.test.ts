import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as h3 from 'h3';
import { apiError } from '../../server/utils/api-error';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { recordRouteMeta, type RouteAccessState } from './route-access';

/** `GET /api/files/**`: stored files streamed, a `Range` answered with 206, every path held to its project. */

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null, caller: null, routePermission: [] }) as RouteAccessState);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => (await import('./route-access')).authMock(state));
vi.mock('../../server/utils/project-access', async (importOriginal) =>
  (await import('./route-access')).projectAccessMock(state, await importOriginal<object>()),
);

vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('apiError', apiError);
for (const name of [
  'eventHandler',
  'getRouterParam',
  'getQuery',
  'getRequestHeader',
  'setResponseHeader',
  'removeResponseHeader',
  'setResponseStatus',
  'sendStream',
] as const) {
  vi.stubGlobal(name, h3[name]);
}

const storageDir = mkdtempSync(join(tmpdir(), 'piwi-files-route-'));
process.env.PIWI_STORAGE_PATH = storageDir;
const { resetStorage } = await import('../../server/storage');
const { LocalStorageAdapter } = await import('../../server/storage/local');
resetStorage();

const handler = (await import('../../server/api/files/[...path].get')).default;

/** A video's bytes: every byte tells its own offset, so a slice is easy to check. */
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const SECRET = Buffer.from('project 2 only');
const BLOB = 'a'.repeat(64);
/**
 * Stored names that hold `..` but are no `..` segment, each with the type it is served as: a step's file, and
 * screenshots named after step titles that end in `.` or hold `...`.
 */
const TWO_DOT_NAMES: Record<string, string> = {
  'step-2..json': 'application/json',
  'Step-13-Click-Generate-new-code-Expected-The-new-code-is-not-the-expired-one..png': 'image/png',
  'Step-3-Read-the-dialog-as-it-starts-Expected-It-shows-Generating-code...-..png': 'image/png',
};

const reader = {
  user: { id: 5, username: 'rae', role: InstanceRole.MEMBER } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
};

let server: Server;
let base: { host: string; port: number };

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** A GET of `path` exactly as written: no client normalizes its dot segments away. */
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ ...base, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  mkdirSync(join(storageDir, 'project-1/run-7/42'), { recursive: true });
  mkdirSync(join(storageDir, 'project-2'), { recursive: true });
  writeFileSync(join(storageDir, 'project-1/run-7/42/video.webm'), VIDEO);
  for (const name of Object.keys(TWO_DOT_NAMES)) writeFileSync(join(storageDir, `project-1/run-7/42/${name}`), name);
  // A slim trace blob whose manifest does not parse.
  mkdirSync(join(storageDir, 'project-1/blobs'), { recursive: true });
  writeFileSync(join(storageDir, `project-1/blobs/${BLOB}.zip`), 'slim');
  writeFileSync(join(storageDir, `project-1/blobs/${BLOB}.manifest.json`), '{ not json');
  writeFileSync(join(storageDir, 'project-2/secret.txt'), SECRET);

  const router = h3.createRouter().get('/api/files/**:path', handler as h3.EventHandler);
  server = createServer(h3.toNodeListener(h3.createApp().use(router)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(storageDir, { recursive: true, force: true });
});

beforeEach(() => {
  state.caller = reader;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a stored file', () => {
  test('streams whole, without reading it into memory, and says it takes ranges', async () => {
    const readFile = vi.spyOn(LocalStorageAdapter.prototype, 'readFile');
    const answer = await get('/api/files/project-1/run-7/42/video.webm');

    expect(answer.status).toBe(200);
    expect(answer.body.equals(VIDEO)).toBe(true);
    expect(answer.headers['content-type']).toBe('video/webm');
    expect(answer.headers['content-length']).toBe(String(VIDEO.length));
    expect(answer.headers['accept-ranges']).toBe('bytes');
    expect(readFile).not.toHaveBeenCalled();
  });

  test('answers a range with 206 and just those bytes', async () => {
    const answer = await get('/api/files/project-1/run-7/42/video.webm', { Range: 'bytes=100-199' });

    expect(answer.status).toBe(206);
    expect(answer.headers['content-range']).toBe(`bytes 100-199/${VIDEO.length}`);
    expect(answer.headers['content-length']).toBe('100');
    expect(answer.body.equals(VIDEO.subarray(100, 200))).toBe(true);
  });

  test('answers an open range and a suffix range', async () => {
    const open = await get('/api/files/project-1/run-7/42/video.webm', { Range: 'bytes=990-' });
    expect(open.status).toBe(206);
    expect(open.body.equals(VIDEO.subarray(990))).toBe(true);

    const suffix = await get('/api/files/project-1/run-7/42/video.webm', { Range: 'bytes=-5' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe(`bytes 995-999/${VIDEO.length}`);
    expect(suffix.body.equals(VIDEO.subarray(995))).toBe(true);
  });

  test('answers 416 to a range past its end, and the whole file to ranges it does not serve', async () => {
    const past = await get('/api/files/project-1/run-7/42/video.webm', { Range: 'bytes=5000-6000' });
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${VIDEO.length}`);
    expect(past.body.length).toBe(0);

    const several = await get('/api/files/project-1/run-7/42/video.webm', { Range: 'bytes=0-1,5-6' });
    expect(several.status).toBe(200);
    expect(several.body.equals(VIDEO)).toBe(true);
  });
});

describe('a stored trace', () => {
  test('that cannot be rebuilt goes out as stored, never cached for a year', async () => {
    const answer = await get(`/api/files/project-1/blobs/${BLOB}.zip`);
    expect(answer.status).toBe(200);
    expect(answer.body.toString()).toBe('slim');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers.etag).toBeUndefined();
  });
});

describe('the path checks', () => {
  test('serve a name that holds two dots, which is no way up', async () => {
    for (const [name, type] of Object.entries(TWO_DOT_NAMES)) {
      const answer = await get(`/api/files/project-1/run-7/42/${name}`);
      expect(answer.status, name).toBe(200);
      expect(answer.headers['content-type'], name).toBe(type);
      expect(answer.body.toString(), name).toBe(name);
    }
  });

  test("refuse another project's file to a reader of this one", async () => {
    expect((await get('/api/files/project-2/secret.txt')).status).toBe(403);
  });

  test('refuse every way out of the project folder', async () => {
    for (const path of [
      '/api/files/project-1/../project-2/secret.txt',
      '/api/files/project-1/run-7/../../project-2/secret.txt',
      '/api/files/project-1/..',
      '/api/files/project-1/run-7/..\\..\\project-2\\secret.txt',
    ]) {
      const answer = await get(path, { Range: 'bytes=0-3' });
      expect(answer.status, path).toBe(403);
      expect(answer.body.includes(SECRET.subarray(0, 4)), path).toBe(false);
    }
  });

  test('refuse an absolute path with 403', async () => {
    for (const path of ['/api/files//project-2/secret.txt', '/api/files/\\project-2\\secret.txt']) {
      const answer = await get(path);
      expect(answer.status, path).toBe(403);
      expect(answer.body.includes(SECRET), path).toBe(false);
    }
  });

  // h3 decodes the request's path once before routing, all but `%2F` and `%25`: an encoded dot or backslash reaches
  // the route's guard decoded, while an encoded slash or a double-encoded dot stays part of a name no file has.
  test('refuse a way out spelled with percent-encoded dots, slashes or backslashes', async () => {
    for (const [path, status] of [
      ['/api/files/project-1/%2e%2e/project-2/secret.txt', 403],
      ['/api/files/project-1/run-7/%2E%2E%5C..%5Cproject-2%5Csecret.txt', 403],
      ['/api/files/project-1/run-7/..%5C..%5Cproject-2%5Csecret.txt', 403],
      ['/api/files/project-1/..%2Fproject-2/secret.txt', 404],
      ['/api/files/project-1/%252e%252e/project-2/secret.txt', 404],
      ['/api/files/project-1/..%252Fproject-2/secret.txt', 404],
    ] as const) {
      const answer = await get(path);
      expect(answer.status, path).toBe(status);
      expect(answer.body.includes(SECRET), path).toBe(false);
    }
  });
});
