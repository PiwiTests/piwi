import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoverageFile } from '@piwitests/core/coverage';
import {
  ServerCoverageCollector,
  baseUrlsFromConfig,
  parseServerCoverageRequests,
  type CollectorLimits,
} from '../src/internal/collect/server-coverage.js';
import { SourceChecksums, contentChecksums } from '../src/internal/collect/source-checksums.js';
import { Logger } from '../src/internal/support/logger.js';
import { jsonRes, startServerOnTestPort, textRes, type FakeServer, type RecordedReq } from './_helpers.js';

interface CollectBody {
  granularity: string;
  groups: Array<{ key: string; requests: string[] }>;
}

/** The coverage the fake backend holds per request id; an id it does not hold answers as missing. */
const HELD: Record<string, CoverageFile[]> = {
  'p.1': [{ path: 'src/Web/Services/BasketService.cs', runtime: 'server', functions: [[22, 25]], lines: [[23, 24]] }],
  'p.2': [{ path: 'src/Web/Services/BasketService.cs', runtime: 'server', functions: [[31, 48]], lines: [[33, 35]] }],
  'p.3': [{ path: 'src/Web/Pages/Index.cshtml', runtime: 'server', lines: [[1, 4]] }],
  'p.4': [{ path: 'src/Web/Program.cs', runtime: 'server', functions: [[10, 12]], lines: [[11, 11]] }],
  'p.5': [{ path: 'src/Web/Program.cs', runtime: 'server', functions: [[20, 22]], lines: [[21, 21]] }],
};

/** A collect answer for a body, from `HELD`. */
function answer(body: CollectBody): unknown {
  return {
    v: 1,
    groups: body.groups.map((group) => ({
      key: group.key,
      files: group.requests.flatMap((id) => HELD[id] ?? []),
      missing: group.requests.filter((id) => !HELD[id]),
    })),
  };
}

let servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  vi.restoreAllMocks();
});

/** A backend serving coverage under `base` (the origin root by default); every other path answers 404. */
async function backend(
  options: { base?: string; respond?: (req: RecordedReq, res: http.ServerResponse) => boolean } = {},
): Promise<FakeServer> {
  const base = options.base ?? '';
  const server = await startServerOnTestPort((req, res) => {
    if (options.respond?.(req, res)) return;
    if (req.method === 'POST' && req.url === `${base}/__piwi/coverage/collect`) {
      jsonRes(res, 200, answer(JSON.parse(req.body) as CollectBody));
    } else if (req.method === 'GET' && req.url?.startsWith(`${base}/__piwi/coverage/run`)) {
      jsonRes(res, 200, {
        v: 1,
        files: [
          {
            path: 'src/Web/Program.cs',
            runtime: 'server',
            functions: [[10, 12]],
            lines: [[11, 11]],
            executable: [[11, 30]],
            allFunctions: [
              [10, 12],
              [14, 30],
            ],
          },
          { path: '../outside.cs', runtime: 'server', lines: [[1, 1]] },
        ],
      });
    } else {
      textRes(res, 404, 'not found');
    }
  });
  servers.push(server);
  return server;
}

function collector(
  baseUrls: string[],
  limits: Partial<CollectorLimits> = {},
  granularity: 'files' | 'functions' | 'lines' = 'lines',
): ServerCoverageCollector {
  return new ServerCoverageCollector({
    granularity,
    baseUrls,
    blobs: null,
    logger: new Logger(),
    limits: { batchDelayMs: 20, ...limits },
  });
}

const collectCalls = (server: FakeServer) =>
  server.requests
    .filter((req) => req.method === 'POST')
    .map((req) => ({ url: req.url, body: JSON.parse(req.body) as CollectBody }));

describe('ServerCoverageCollector', () => {
  it('batches the tests of an origin into one call, one group per test', async () => {
    const server = await backend();
    const c = collector([server.url]);
    const [a, b, d] = await Promise.all([
      c.collect({ [server.url]: ['p.1'] }),
      c.collect({ [server.url]: ['p.2', 'p.3'] }),
      c.collect({ [server.url]: ['p.4'] }),
    ]);
    const calls = collectCalls(server);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.granularity).toBe('lines');
    expect(calls[0]!.body.groups.map((group) => group.requests)).toEqual([['p.1'], ['p.2', 'p.3'], ['p.4']]);
    expect(a).toEqual({ files: HELD['p.1'], incomplete: false });
    expect(b.files.map((file) => file.path)).toEqual([
      'src/Web/Pages/Index.cshtml',
      'src/Web/Services/BasketService.cs',
    ]);
    expect(b.incomplete).toBe(false);
    expect(d.files).toEqual(HELD['p.4']);
  });

  it('sends a batch as soon as it holds batchTests tests', async () => {
    const server = await backend();
    const c = collector([server.url], { batchTests: 2, batchDelayMs: 60_000 });
    await Promise.all([c.collect({ [server.url]: ['p.1'] }), c.collect({ [server.url]: ['p.2'] })]);
    expect(collectCalls(server)).toHaveLength(1);
  });

  it('waits for the batch delay, or a flush, before sending a smaller batch', async () => {
    const server = await backend();
    const c = collector([server.url], { batchDelayMs: 60_000 });
    const pending = c.collect({ [server.url]: ['p.1'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(collectCalls(server)).toHaveLength(0);
    c.flush();
    expect((await pending).files).toEqual(HELD['p.1']);
  });

  it('splits a batch into calls of at most maxIdsPerCall ids, and merges a split test back', async () => {
    const server = await backend();
    const c = collector([server.url], { maxIdsPerCall: 3 });
    const [big, small] = await Promise.all([
      c.collect({ [server.url]: ['p.1', 'p.2', 'p.3', 'p.4', 'p.5'] }),
      c.collect({ [server.url]: ['p.1'] }),
    ]);
    const calls = collectCalls(server);
    expect(calls.map((call) => call.body.groups.flatMap((group) => group.requests).length)).toEqual([3, 3]);
    expect(calls.flatMap((call) => call.body.groups.flatMap((group) => group.requests))).toEqual([
      'p.1',
      'p.2',
      'p.3',
      'p.4',
      'p.5',
      'p.1',
    ]);
    // Every key is distinct, the split test's pieces included.
    const keys = calls.flatMap((call) => call.body.groups.map((group) => group.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(big.incomplete).toBe(false);
    expect(big.files).toEqual([
      { path: 'src/Web/Pages/Index.cshtml', runtime: 'server', lines: [[1, 4]] },
      {
        path: 'src/Web/Program.cs',
        runtime: 'server',
        functions: [
          [10, 12],
          [20, 22],
        ],
        lines: [
          [11, 11],
          [21, 21],
        ],
      },
      {
        path: 'src/Web/Services/BasketService.cs',
        runtime: 'server',
        functions: [
          [22, 25],
          [31, 48],
        ],
        lines: [
          [23, 24],
          [33, 35],
        ],
      },
    ]);
    expect(small).toEqual({ files: HELD['p.1'], incomplete: false });
  });

  it('keeps each call body within maxBodyBytes', async () => {
    const server = await backend();
    const maxBodyBytes = 80;
    const c = collector([server.url], { maxBodyBytes });
    const result = await c.collect({ [server.url]: ['p.1', 'p.2', 'p.3', 'p.4', 'p.5'] });
    const bodies = server.requests.filter((req) => req.method === 'POST').map((req) => req.body);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes);
    expect(result.files.map((file) => file.path)).toHaveLength(3);
    expect(result.incomplete).toBe(false);
  });

  it('caps the ids of one test and marks it incomplete', async () => {
    const server = await backend();
    const c = collector([server.url], { maxIdsPerTest: 2 });
    const result = await c.collect({ [server.url]: ['p.1', 'p.2', 'p.3'] });
    expect(collectCalls(server)[0]!.body.groups[0]!.requests).toEqual(['p.1', 'p.2']);
    expect(result.incomplete).toBe(true);
  });

  it("finds the path base under the base URL's path and keeps it", async () => {
    const server = await backend({ base: '/shop' });
    const c = collector([`${server.url}/shop/`]);
    await c.collect({ [server.url]: ['p.1'] });
    await c.collect({ [server.url]: ['p.2'] });
    expect(collectCalls(server).map((call) => call.url)).toEqual([
      '/shop/__piwi/coverage/collect',
      '/shop/__piwi/coverage/collect',
    ]);
  });

  it("falls back to the origin root when the base URL's path serves no coverage, and keeps it", async () => {
    const server = await backend();
    const c = collector([`${server.url}/shop`]);
    const first = await c.collect({ [server.url]: ['p.1'] });
    await c.collect({ [server.url]: ['p.2'] });
    expect(collectCalls(server).map((call) => call.url)).toEqual([
      '/shop/__piwi/coverage/collect',
      '/__piwi/coverage/collect',
      '/__piwi/coverage/collect',
    ]);
    expect(first).toEqual({ files: HELD['p.1'], incomplete: false });
  });

  it('marks a test incomplete when the backend no longer holds one of its ids', async () => {
    const server = await backend();
    const result = await collector([server.url]).collect({ [server.url]: ['p.1', 'gone.9'] });
    expect(result).toEqual({ files: HELD['p.1'], incomplete: true });
  });

  it('marks the tests incomplete when no endpoint answers with coverage, warning once per origin', async () => {
    const server = await backend({
      respond: (_req, res) => {
        textRes(res, 500, 'boom');
        return true;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = collector([server.url]);
    expect(await c.collect({ [server.url]: ['p.1'] })).toEqual({ files: [], incomplete: true });
    expect(await c.collect({ [server.url]: ['p.2'] })).toEqual({ files: [], incomplete: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`[Piwi Dashboard] Could not collect the server coverage`);
  });

  it('marks the tests incomplete when the backend is down', async () => {
    const server = await backend();
    const origin = server.url;
    await server.close();
    servers = servers.filter((s) => s !== server);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await collector([origin]).collect({ [origin]: ['p.1'] })).toEqual({ files: [], incomplete: true });
  });

  it('marks the tests incomplete when a call times out', async () => {
    const server = await backend({ respond: () => true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    const result = await collector([server.url], { callTimeoutMs: 150 }).collect({ [server.url]: ['p.1'] });
    expect(result).toEqual({ files: [], incomplete: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('collects each origin of a test from that origin', async () => {
    const one = await backend();
    const two = await backend();
    const result = await collector([one.url]).collect({ [one.url]: ['p.1'], [two.url]: ['p.4'] });
    expect(collectCalls(one)[0]!.body.groups[0]!.requests).toEqual(['p.1']);
    expect(collectCalls(two)[0]!.body.groups[0]!.requests).toEqual(['p.4']);
    expect(result.files.map((file) => file.path)).toEqual(['src/Web/Program.cs', 'src/Web/Services/BasketService.cs']);
  });

  it('resolves the tests still queued as incomplete once closed', async () => {
    const server = await backend();
    const c = collector([server.url], { batchDelayMs: 60_000 });
    const pending = c.collect({ [server.url]: ['p.1'] });
    c.close();
    expect(await pending).toEqual({ files: [], incomplete: true });
    expect(await c.collect({ [server.url]: ['p.2'] })).toEqual({ files: [], incomplete: true });
    expect(collectCalls(server)).toHaveLength(0);
  });

  it('fetches the run-level coverage at the granularity it collects, cleaning its paths', async () => {
    const server = await backend({ base: '/shop' });
    const c = collector([`${server.url}/shop`], {}, 'functions');
    const { files, gap } = await c.fetchRun(server.url);
    expect(server.requests[server.requests.length - 1]!.url).toBe('/shop/__piwi/coverage/run?granularity=functions');
    expect(gap).toBeNull();
    expect(files).toEqual([
      {
        path: 'src/Web/Program.cs',
        runtime: 'server',
        functions: [[10, 12]],
        lines: [[11, 11]],
        executable: [[11, 30]],
        allFunctions: [
          [10, 12],
          [14, 30],
        ],
      },
    ]);
  });

  it('drops the line numbers of a file built from other sources than the checkout, and marks the test incomplete', async () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-checksums-'));
    fs.mkdirSync(path.join(checkout, 'src/Web'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'src/Web/Program.cs'), 'class Program\n{\n}\n');
    fs.writeFileSync(path.join(checkout, 'src/Web/Basket.cs'), 'class Basket\n{\n}\n');
    const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
    const files = [
      // Built on Windows from the same file: its checksum is of the CRLF form.
      {
        path: 'src/Web/Program.cs',
        runtime: 'server',
        lines: [[1, 2]],
        checksums: [sha256('class Program\r\n{\r\n}\r\n')],
      },
      {
        path: 'src/Web/Basket.cs',
        runtime: 'server',
        lines: [[1, 2]],
        executable: [[1, 3]],
        checksums: [sha256('class Basket {}\n')],
      },
    ];
    const server = await backend({
      respond: (req, res) => {
        if (req.method === 'POST') {
          const body = JSON.parse(req.body) as CollectBody;
          jsonRes(res, 200, { v: 1, groups: body.groups.map((g) => ({ key: g.key, files, missing: [] })) });
        } else {
          jsonRes(res, 200, { v: 1, files });
        }
        return true;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new ServerCoverageCollector({
      granularity: 'lines',
      baseUrls: [server.url],
      blobs: null,
      checksums: new SourceChecksums(() => checkout),
      logger: new Logger(),
      limits: { batchDelayMs: 20 },
    });
    try {
      expect(await c.collect({ [server.url]: ['p.1'] })).toEqual({
        files: [
          { path: 'src/Web/Basket.cs', runtime: 'server' },
          { path: 'src/Web/Program.cs', runtime: 'server', lines: [[1, 2]] },
        ],
        incomplete: true,
      });
      expect((await c.fetchRun(server.url)).files).toEqual([
        { path: 'src/Web/Program.cs', runtime: 'server', lines: [[1, 2]] },
        { path: 'src/Web/Basket.cs', runtime: 'server' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('src/Web/Basket.cs differs');
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('marks the run-level coverage of an origin that answers none unreachable, warning', async () => {
    const server = await backend({
      respond: (_req, res) => {
        textRes(res, 404, 'nope');
        return true;
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await collector([server.url]).fetchRun(server.url)).toEqual({
      files: [],
      gap: { origin: server.url, reason: 'unreachable' },
    });
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      "the run's server coverage is marked incomplete",
    );
  });
});

describe('ServerCoverageCollector restart detection', () => {
  const FIRST = { id: 'aaaaaaaaaaaa', startedAt: '2026-10-17T09:00:00.000Z' };
  const SECOND = { id: 'bbbbbbbbbbbb', startedAt: '2026-10-17T09:12:30.000Z' };
  /** Each process's coverage per request id, and the run-level coverage it holds: what ran since it started. */
  const HELD_BY: Record<string, Record<string, CoverageFile[]>> = {
    [FIRST.id]: {
      [`${FIRST.id}.1`]: [{ path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]], lines: [[4, 6]] }],
    },
    [SECOND.id]: {
      [`${SECOND.id}.1`]: [{ path: 'src/Web/Orders.cs', runtime: 'server', functions: [[2, 8]], lines: [[3, 5]] }],
    },
  };
  const RUN_BY: Record<string, unknown[]> = {
    [FIRST.id]: [
      { path: 'src/Web/Basket.cs', runtime: 'server', functions: [[3, 9]], lines: [[4, 6]], executable: [[4, 20]] },
    ],
    [SECOND.id]: [
      { path: 'src/Web/Basket.cs', runtime: 'server', executable: [[4, 20]], allFunctions: [[3, 9]] },
      { path: 'src/Web/Orders.cs', runtime: 'server', functions: [[2, 8]], lines: [[3, 5]], executable: [[3, 12]] },
    ],
  };

  /** A backend whose process is `current.instance`, swapped to restart it; `named: false` answers no instance. */
  async function restartable(current: { instance: { id: string; startedAt: string }; named?: boolean }) {
    return backend({
      respond: (req, res) => {
        const instance = current.named === false ? {} : { instance: current.instance };
        const held = HELD_BY[current.instance.id]!;
        if (req.method === 'POST') {
          const body = JSON.parse(req.body) as CollectBody;
          jsonRes(res, 200, {
            v: 1,
            ...instance,
            groups: body.groups.map((g) => ({
              key: g.key,
              files: g.requests.flatMap((id) => held[id] ?? []),
              missing: g.requests.filter((id) => !held[id]),
            })),
          });
        } else {
          jsonRes(res, 200, { v: 1, ...instance, files: RUN_BY[current.instance.id] });
        }
        return true;
      },
    });
  }

  it('marks the run incomplete when another process answers the run-level coverage, keeping the lines the tests ran', async () => {
    const current = { instance: FIRST };
    const server = await restartable(current);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = collector([server.url]);
    await c.collect({ [server.url]: [`${FIRST.id}.1`] });
    current.instance = SECOND;
    await c.collect({ [server.url]: [`${SECOND.id}.1`] });

    const run = await c.fetchRun(server.url);

    expect(run.gap).toEqual({ origin: server.url, reason: 'restarted', at: SECOND.startedAt });
    expect(run.files).toEqual([
      // The second process never ran Basket.cs: the first test's lines come from its own coverage.
      {
        path: 'src/Web/Basket.cs',
        runtime: 'server',
        functions: [[3, 9]],
        lines: [[4, 6]],
        executable: [[4, 20]],
        allFunctions: [[3, 9]],
      },
      { path: 'src/Web/Orders.cs', runtime: 'server', functions: [[2, 8]], lines: [[3, 5]], executable: [[3, 12]] },
    ]);
    expect(String(warn.mock.calls[0]![0])).toContain(`restarted during the run at about ${SECOND.startedAt}`);
  });

  it('tells a restart from the request ids when the first collection already reached the new process', async () => {
    const current = { instance: SECOND };
    const server = await restartable(current);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = collector([server.url]);
    // Given out by the first process, collected from the second: missing.
    expect((await c.collect({ [server.url]: [`${FIRST.id}.1`] })).incomplete).toBe(true);

    expect((await c.fetchRun(server.url)).gap).toEqual({
      origin: server.url,
      reason: 'restarted',
      at: SECOND.startedAt,
    });
  });

  it('names no gap when one process answered every call', async () => {
    const server = await restartable({ instance: FIRST });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = collector([server.url]);
    await c.collect({ [server.url]: [`${FIRST.id}.1`] });

    const run = await c.fetchRun(server.url);

    expect(run.gap).toBeNull();
    expect(run.files).toEqual(RUN_BY[FIRST.id]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('names no restart for a backend that names no instance', async () => {
    const current = { instance: FIRST, named: false };
    const server = await restartable(current);
    const c = collector([server.url]);
    await c.collect({ [server.url]: [`${FIRST.id}.1`] });
    current.instance = SECOND;

    expect((await c.fetchRun(server.url)).gap).toBeNull();
  });

  it('keeps the lines the tests ran when the backend is down at the end of the run', async () => {
    const server = await restartable({ instance: FIRST });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = collector([server.url]);
    await c.collect({ [server.url]: [`${FIRST.id}.1`] });
    await server.close();
    servers = servers.filter((s) => s !== server);

    const run = await c.fetchRun(server.url);

    expect(run.gap).toEqual({ origin: server.url, reason: 'unreachable' });
    expect(run.files).toEqual(HELD_BY[FIRST.id]![`${FIRST.id}.1`]);
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      `Could not fetch the run's server coverage from ${server.url}`,
    );
  });
});

describe('parseServerCoverageRequests', () => {
  it('keeps http and https origins and valid ids, each once', () => {
    const body = Buffer.from(
      JSON.stringify({
        'http://127.0.0.1:5000': ['a1.1', 'a1.1', 'a1.2', 'has space', 42, ''],
        'https://api.shop.test': ['b.1'],
        'ftp://files.test': ['c.1'],
        'http://127.0.0.1:5000/path': ['d.1'],
        'not a url': ['e.1'],
        'http://empty.test': [],
      }),
    );
    expect(parseServerCoverageRequests(body)).toEqual({
      'http://127.0.0.1:5000': ['a1.1', 'a1.2'],
      'https://api.shop.test': ['b.1'],
    });
  });

  it('answers null for a body without any id', () => {
    expect(parseServerCoverageRequests(Buffer.from('{}'))).toBeNull();
    expect(parseServerCoverageRequests(Buffer.from('not json'))).toBeNull();
    expect(parseServerCoverageRequests(Buffer.from('["a.1"]'))).toBeNull();
  });
});

describe('baseUrlsFromConfig', () => {
  it("lists each project's base URL once", () => {
    expect(
      baseUrlsFromConfig({
        projects: [
          { use: { baseURL: 'http://localhost:5000/shop' } },
          { use: { baseURL: 'http://localhost:5000/shop' } },
          { use: {} },
          { use: { baseURL: 'http://localhost:3000' } },
        ],
      }),
    ).toEqual(['http://localhost:5000/shop', 'http://localhost:3000']);
  });
});

describe('contentChecksums', () => {
  it('names the SHA-1 and SHA-256 of the content as is, with LF and with CRLF line endings', () => {
    const checksums = contentChecksums(Buffer.from('a\r\nb\n'));
    const sha = (algorithm: string, text: string) =>
      `${algorithm}:${crypto.createHash(algorithm).update(text).digest('hex')}`;
    expect(checksums).toEqual(
      new Set([
        sha('sha1', 'a\r\nb\n'),
        sha('sha256', 'a\r\nb\n'),
        sha('sha1', 'a\nb\n'),
        sha('sha256', 'a\nb\n'),
        sha('sha1', 'a\r\nb\r\n'),
        sha('sha256', 'a\r\nb\r\n'),
      ]),
    );
  });
});
