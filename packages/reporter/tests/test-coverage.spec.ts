import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CoverageFile } from '@piwitests/core/coverage';
import { BlobIds, gitBlobId } from '../src/internal/collect/blob-ids.js';
import {
  browserFunctionCoverage,
  coverageSettings,
  type CoverageSettings,
} from '../src/internal/collect/coverage-settings.js';
import {
  CoverageCollection,
  LastTestWatch,
  chunkRunCoverage,
  composeTestCoverage,
} from '../src/internal/collect/test-coverage.js';
import { ATTACHMENT_NAMES } from '../src/internal/capture/attachments.js';
import type { CollectedTestCase } from '../src/types.js';
import { jsonRes, startServerOnTestPort, textRes, type FakeServer } from './_helpers.js';

const SERVER_FILE: CoverageFile = {
  path: 'src/Web/Services/BasketService.cs',
  runtime: 'server',
  blob: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
  functions: [
    [22, 25],
    [31, 48],
  ],
  lines: [
    [23, 24],
    [33, 35],
  ],
};

const settings = (server: CoverageSettings['server'], browser: CoverageSettings['browser'] = 'off') => ({
  server,
  browser,
});

describe('composeTestCoverage', () => {
  it('keeps the lines, functions and blob at lines granularity', () => {
    expect(composeTestCoverage({ files: [SERVER_FILE], incomplete: false }, null, settings('lines'))).toEqual({
      v: 1,
      files: [SERVER_FILE],
    });
  });

  it('drops the lines at functions granularity, keeping the blob', () => {
    expect(composeTestCoverage({ files: [SERVER_FILE], incomplete: false }, null, settings('functions'))).toEqual({
      v: 1,
      files: [{ path: SERVER_FILE.path, runtime: 'server', blob: SERVER_FILE.blob, functions: SERVER_FILE.functions }],
    });
  });

  it('keeps the paths only at files granularity', () => {
    expect(composeTestCoverage({ files: [SERVER_FILE], incomplete: false }, null, settings('files'))).toEqual({
      v: 1,
      files: [{ path: SERVER_FILE.path, runtime: 'server' }],
    });
  });

  it('merges the browser files in as paths when browser coverage is on', () => {
    const coverage = composeTestCoverage(
      { files: [SERVER_FILE], incomplete: false },
      ['src/components/Pay.vue', 'node_modules/vue/index.js'],
      settings('files', 'files'),
    );
    expect(coverage).toEqual({
      v: 1,
      files: [
        { path: 'src/Web/Services/BasketService.cs', runtime: 'server' },
        { path: 'src/components/Pay.vue', runtime: 'browser' },
      ],
    });
  });

  it('keeps the browser functions and their blob at functions granularity, and drops their lines', () => {
    const browserFile: CoverageFile = {
      path: 'src/components/Pay.vue',
      runtime: 'browser',
      blob: SERVER_FILE.blob,
      functions: [[12, 20]],
      lines: [[13, 14]],
    };
    expect(composeTestCoverage(null, [browserFile, 'src/cart.ts'], settings('off', 'functions'))).toEqual({
      v: 1,
      files: [
        { path: 'src/cart.ts', runtime: 'browser' },
        { path: 'src/components/Pay.vue', runtime: 'browser', blob: SERVER_FILE.blob, functions: [[12, 20]] },
      ],
    });
  });

  it('leaves the browser files out when browser coverage is off, and the server files when server coverage is', () => {
    expect(composeTestCoverage(null, ['src/components/Pay.vue'], settings('lines'))).toBeNull();
    expect(composeTestCoverage({ files: [SERVER_FILE], incomplete: false }, null, settings('off', 'files'))).toBeNull();
  });

  it('carries incomplete over, with the browser files when the server has none', () => {
    expect(composeTestCoverage({ files: [], incomplete: true }, ['src/a.ts'], settings('lines', 'files'))).toEqual({
      v: 1,
      files: [{ path: 'src/a.ts', runtime: 'browser' }],
      incomplete: true,
    });
    expect(composeTestCoverage({ files: [], incomplete: true }, null, settings('lines'))).toBeNull();
  });

  it('keeps line numbers without a blob', () => {
    const { blob: _blob, ...withoutBlob } = SERVER_FILE;
    expect(composeTestCoverage({ files: [withoutBlob], incomplete: false }, null, settings('lines'))!.files).toEqual([
      withoutBlob,
    ]);
  });

  it('keeps server files only from the server side', () => {
    const coverage = composeTestCoverage(
      { files: [SERVER_FILE, { path: 'src/a.ts', runtime: 'browser' }], incomplete: false },
      null,
      settings('files'),
    );
    expect(coverage!.files.map((file) => file.runtime)).toEqual(['server']);
  });
});

describe('chunkRunCoverage', () => {
  it('splits the files into requests of at most 5000 files', () => {
    const files = Array.from({ length: 12_001 }, (_, i) => ({ path: `src/f${i}.cs`, runtime: 'server' as const }));
    expect(chunkRunCoverage(files).map((chunk) => chunk.length)).toEqual([5000, 5000, 2001]);
    expect(chunkRunCoverage([])).toEqual([]);
  });
});

describe('LastTestWatch', () => {
  it('tells when every planned test reported and none runs', () => {
    const watch = new LastTestWatch(2);
    watch.begin('a');
    watch.begin('b');
    expect(watch.end('a', false)).toBe(false);
    expect(watch.end('b', false)).toBe(true);
  });

  it('waits for a test that will be retried', () => {
    const watch = new LastTestWatch(2);
    watch.begin('a');
    watch.begin('b');
    expect(watch.end('a', true)).toBe(false);
    expect(watch.end('b', false)).toBe(false);
    watch.begin('a');
    expect(watch.end('a', false)).toBe(true);
  });
});

describe('coverageSettings', () => {
  it('is off by default', () => {
    expect(coverageSettings({})).toEqual({ browser: 'off', server: 'off' });
  });

  it('reads both sides, and captureCodeReach as browser files', () => {
    expect(coverageSettings({ coverage: { browser: 'files', server: 'functions' } })).toEqual({
      browser: 'files',
      server: 'functions',
    });
    expect(coverageSettings({ captureCodeReach: true })).toEqual({ browser: 'files', server: 'off' });
    expect(coverageSettings({ captureCodeReach: true, coverage: { browser: 'functions' } }).browser).toBe('functions');
    expect(coverageSettings({ coverage: { server: 'nope' as never } }).server).toBe('off');
  });

  it('is off with collectPerformanceMetrics: false', () => {
    expect(
      coverageSettings({
        collectPerformanceMetrics: false,
        captureCodeReach: true,
        coverage: { browser: 'files', server: 'lines' },
      }),
    ).toEqual({ browser: 'off', server: 'off' });
  });
});

describe('browserFunctionCoverage', () => {
  it('keeps the repository files, with their function ranges merged', () => {
    const files = new Map([
      ['src/pay.ts', [[4, 9], [1, 2], [4, 9]] as Array<[number, number]>],
      ['node_modules/vue/index.js', [[1, 1]] as Array<[number, number]>],
      ['src/cart.ts', [] as Array<[number, number]>],
    ]);
    expect(browserFunctionCoverage(files)).toEqual({
      v: 1,
      files: [
        { path: 'src/cart.ts', runtime: 'browser' },
        { path: 'src/pay.ts', runtime: 'browser', functions: [[1, 2], [4, 9]] },
      ],
    });
    expect(browserFunctionCoverage(new Map())).toBeNull();
  });
});

describe('blob ids', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-blob-')));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'Basket.cs'), 'namespace Shop;\r\n\npublic class Basket { }\n');
    fs.writeFileSync(path.join(dir, 'src', 'Empty.cs'), '');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('matches git hash-object', () => {
    for (const file of ['src/Basket.cs', 'src/Empty.cs']) {
      const expected = execFileSync('git', ['hash-object', '--no-filters', file], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      expect(gitBlobId(fs.readFileSync(path.join(dir, file)))).toBe(expected);
    }
  });

  it('names the files that carry line numbers, once per path, and none for a missing or outside file', async () => {
    const root = vi.fn(() => dir);
    const blobs = new BlobIds(root);
    const files: CoverageFile[] = [
      { path: 'src/Basket.cs', runtime: 'server', lines: [[1, 1]] },
      { path: 'src/Basket.cs', runtime: 'server', functions: [[3, 3]] },
      { path: 'src/Gone.cs', runtime: 'server', lines: [[1, 1]] },
      { path: '../outside.cs', runtime: 'server', lines: [[1, 1]] },
      { path: 'src/Empty.cs', runtime: 'server' },
    ];
    const named = await blobs.withBlobs(files);
    const expected = gitBlobId(fs.readFileSync(path.join(dir, 'src', 'Basket.cs')));
    expect(named.map((file) => file.blob)).toEqual([expected, expected, undefined, undefined, undefined]);
    expect(named[2]!.lines).toEqual([[1, 1]]);
    // Each path read once: a second call reads nothing.
    await blobs.withBlobs(files);
    expect(root).toHaveBeenCalledTimes(1);
  });

  it('hashes the file on disk when git cannot', async () => {
    const hashObjects = vi.fn(async () => null);
    const blobs = new BlobIds(() => dir, hashObjects);
    const files: CoverageFile[] = [{ path: 'src/Basket.cs', runtime: 'server', lines: [[1, 1]] }];
    const [named] = await blobs.withBlobs(files);
    expect(hashObjects).toHaveBeenCalledWith(dir, [path.join('src', 'Basket.cs')]);
    expect(named!.blob).toBe(gitBlobId(fs.readFileSync(path.join(dir, 'src', 'Basket.cs'))));
  });

  it('gives the id of what git stores when the checkout converts line endings', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-blob-crlf-')));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'core.autocrlf=true', ...args], { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '--quiet');
      git('config', 'core.autocrlf', 'true');
      fs.mkdirSync(path.join(repo, 'src'));
      fs.writeFileSync(path.join(repo, 'src', 'Basket.cs'), 'namespace Shop;\r\npublic class Basket { }\r\n');
      git('add', '.');
      git('-c', 'user.name=Piwi', '-c', 'user.email=piwi@example.com', 'commit', '--quiet', '-m', 'Basket');
      const stored = git('rev-parse', 'HEAD:src/Basket.cs');
      const onDisk = gitBlobId(fs.readFileSync(path.join(repo, 'src', 'Basket.cs')));
      expect(stored).not.toBe(onDisk);

      const files: CoverageFile[] = [{ path: 'src/Basket.cs', runtime: 'server', lines: [[2, 2]] }];
      const [named] = await new BlobIds(() => repo).withBlobs(files);
      expect(named!.blob).toBe(stored);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('CoverageCollection', () => {
  let servers: FakeServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    vi.restoreAllMocks();
  });

  /** A backend that answers each collection call after `delayMs`, every id with one file. */
  async function backend(delayMs = 0): Promise<FakeServer> {
    const server = await startServerOnTestPort((req, res) => {
      if (req.url === '/__piwi/coverage/collect') {
        const body = JSON.parse(req.body) as { groups: Array<{ key: string; requests: string[] }> };
        setTimeout(
          () =>
            jsonRes(res, 200, {
              v: 1,
              groups: body.groups.map((group) => ({
                key: group.key,
                files: group.requests.map((id) => ({ path: `src/${id}.cs`, runtime: 'server' })),
                missing: [],
              })),
            }),
          delayMs,
        );
      } else {
        textRes(res, 404, 'not found');
      }
    });
    servers.push(server);
    return server;
  }

  const requestsAttachment = (origin: string, ids: string[]) => ({
    name: ATTACHMENT_NAMES.serverCoverageRequests,
    body: Buffer.from(JSON.stringify({ [origin]: ids })),
  });

  const testCase = (codeReach?: string[]): CollectedTestCase => ({
    type: 'complete',
    title: 't',
    location: 'a.spec.ts:1:1',
    ...(codeReach ? { codeReach } : {}),
  });

  it('sets the coverage at once for a test without server request ids', () => {
    const collection = new CoverageCollection({
      settings: { browser: 'files', server: 'lines' },
      baseUrls: [],
      configDir: os.tmpdir(),
    });
    const tc = testCase(['src/a.ts']);
    expect(collection.apply(tc, [])).toBeNull();
    expect(tc.coverage).toEqual({ v: 1, files: [{ path: 'src/a.ts', runtime: 'browser' }] });
  });

  it('names the blob of each browser file at functions granularity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-browser-blobs-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'pay.ts'), 'export function pay() {}\n');
      const collection = new CoverageCollection({
        settings: { browser: 'functions', server: 'off' },
        baseUrls: [],
        configDir: dir,
      });
      const tc = testCase(['src/pay.ts']);
      const body = { v: 1, files: [{ path: 'src/pay.ts', runtime: 'browser', functions: [[1, 1]] }] };
      const ready = collection.apply(tc, [{ name: ATTACHMENT_NAMES.browserCoverage, body: Buffer.from(JSON.stringify(body)) }]);
      expect(ready).not.toBeNull();
      await collection.settle();
      expect(tc.coverage).toEqual({
        v: 1,
        files: [
          {
            path: 'src/pay.ts',
            runtime: 'browser',
            blob: gitBlobId(Buffer.from('export function pay() {}\n')),
            functions: [[1, 1]],
          },
        ],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the code reach paths when the browser coverage attachment is corrupt', () => {
    const collection = new CoverageCollection({
      settings: { browser: 'functions', server: 'off' },
      baseUrls: [],
      configDir: os.tmpdir(),
    });
    const tc = testCase(['src/pay.ts']);
    const ready = collection.apply(tc, [{ name: ATTACHMENT_NAMES.browserCoverage, body: Buffer.from('{"v":1,"fil') }]);
    expect(ready).toBeNull();
    expect(tc.coverage).toEqual({ v: 1, files: [{ path: 'src/pay.ts', runtime: 'browser' }] });
  });

  it('merges the server files and the browser functions of one test', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-browser-blobs-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'pay.ts'), 'export function pay() {}\n');
      const server = await backend();
      const collection = new CoverageCollection({
        settings: { browser: 'functions', server: 'files' },
        baseUrls: [server.url],
        configDir: dir,
        limits: { batchDelayMs: 10 },
      });
      const tc = testCase(['src/pay.ts']);
      const body = { v: 1, files: [{ path: 'src/pay.ts', runtime: 'browser', functions: [[1, 1]] }] };
      const ready = collection.apply(tc, [
        requestsAttachment(server.url, ['a.1']),
        { name: ATTACHMENT_NAMES.browserCoverage, body: Buffer.from(JSON.stringify(body)) },
      ]);
      expect(ready).not.toBeNull();
      await ready;
      expect(tc.coverage).toEqual({
        v: 1,
        files: expect.arrayContaining([
          { path: 'src/a.1.cs', runtime: 'server' },
          {
            path: 'src/pay.ts',
            runtime: 'browser',
            blob: gitBlobId(Buffer.from('export function pay() {}\n')),
            functions: [[1, 1]],
          },
        ]),
      });
      expect(tc.coverage?.files).toHaveLength(2);
      collection.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the coverage once the server coverage is collected', async () => {
    const server = await backend();
    const collection = new CoverageCollection({
      settings: { browser: 'off', server: 'files' },
      baseUrls: [server.url],
      configDir: os.tmpdir(),
      limits: { batchDelayMs: 10 },
    });
    const tc = testCase();
    const ready = collection.apply(tc, [requestsAttachment(server.url, ['a.1'])]);
    expect(ready).not.toBeNull();
    expect(tc.coverage).toBeUndefined();
    await ready;
    expect(tc.coverage).toEqual({ v: 1, files: [{ path: 'src/a.1.cs', runtime: 'server' }] });
  });

  it('stops waiting at its bound and marks the coverage incomplete', async () => {
    const server = await backend(2000);
    const collection = new CoverageCollection({
      settings: { browser: 'files', server: 'files' },
      baseUrls: [server.url],
      configDir: os.tmpdir(),
      waitMs: 100,
      limits: { batchDelayMs: 10 },
    });
    const tc = testCase(['src/a.ts']);
    const started = Date.now();
    await collection.apply(tc, [requestsAttachment(server.url, ['a.1'])]);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(tc.coverage).toEqual({ v: 1, files: [{ path: 'src/a.ts', runtime: 'browser' }], incomplete: true });
    collection.close();
  });

  it('settles every waiting test within its bound', async () => {
    const server = await backend(2000);
    const collection = new CoverageCollection({
      settings: { browser: 'off', server: 'files' },
      baseUrls: [server.url],
      configDir: os.tmpdir(),
      limits: { batchDelayMs: 60_000 },
    });
    const tc = testCase();
    let done = false;
    void collection.apply(tc, [requestsAttachment(server.url, ['a.1'])])!.then(() => (done = true));
    const started = Date.now();
    await collection.settle(100);
    await Promise.resolve();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(done).toBe(true);
    // Sent at once by the settle, not after the batch delay.
    expect(server.requests).toHaveLength(1);
    collection.close();
  });

  it('settles a test waiting for the blob ids of its browser files within its bound', async () => {
    vi.spyOn(BlobIds.prototype, 'withBlobs').mockReturnValue(new Promise(() => {}));
    const collection = new CoverageCollection({
      settings: { browser: 'functions', server: 'off' },
      baseUrls: [],
      configDir: os.tmpdir(),
    });
    const tc = testCase(['src/pay.ts']);
    const body = { v: 1, files: [{ path: 'src/pay.ts', runtime: 'browser', functions: [[1, 1]] }] };
    expect(
      collection.apply(tc, [{ name: ATTACHMENT_NAMES.browserCoverage, body: Buffer.from(JSON.stringify(body)) }]),
    ).not.toBeNull();
    const started = Date.now();
    await collection.settle(100);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(tc.coverage).toBeUndefined();
  });
});
