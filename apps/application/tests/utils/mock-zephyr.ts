/**
 * A stand-in for the Zephyr Scale Cloud API on a local port, serving the recorded shapes in `tests/fixtures/
 * zephyr-scale/` (projects, case statuses and cases over two pages). It records what it was asked, so a spec can see
 * the bearer token arrive here and nowhere else. It also takes a run's results: an upload makes a test cycle (the
 * keys and results it carried are recorded), a web link is added to it, and the cycle is found again through its test
 * executions. Sample data only; the real service is never called.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { strFromU8, unzipSync } from 'fflate';

export interface ZephyrCall {
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
}

/** One upload the mock took: the test cycle it was asked for and the results the file carried. */
export interface ZephyrUpload {
  projectKey: string | undefined;
  name: string;
  description: string;
  executions: { result: string; testCase: { key: string } }[];
}

/** A web link added to a test cycle. */
export interface ZephyrWebLink {
  cycleKey: string;
  url: string;
  description: string;
}

export interface MockZephyr {
  /** The origin the spawned server's fetch is redirected to. */
  url: string;
  calls: ZephyrCall[];
  /** How many catalog pages were asked for. */
  caseRequests(): number;
  /** The uploads taken, in order, whether the mock answered them or not. */
  uploads: ZephyrUpload[];
  /** The web links added to the test cycles it made. */
  weblinks: ZephyrWebLink[];
  /**
   * The next upload fails with `status`. With `createsCycle` the mock still makes the test cycle, as a tool does when
   * the answer is lost on the way back.
   */
  failNextUpload(status: number, options?: { createsCycle?: boolean }): void;
  /** Forget the uploads, links, cycles and any failure set. */
  reset(): void;
  close(): Promise<void>;
}

function fixture(name: string): string {
  return readFileSync(resolve('tests', 'fixtures', 'zephyr-scale', `${name}.json`), 'utf8');
}

/** The parts of a multipart body, by field name. */
function multipartParts(body: Buffer, contentType: string | undefined): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType ?? '');
  if (!boundary) return parts;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    const name = /name="([^"]+)"/.exec(part.subarray(0, headerEnd).toString('utf8'));
    if (name) parts.set(name[1]!, part.subarray(headerEnd + 4));
    start = next;
  }
  return parts;
}

interface Cycle {
  id: number;
  key: string;
  name: string;
}

export async function startMockZephyr(token: string): Promise<MockZephyr> {
  const calls: ZephyrCall[] = [];
  const uploads: ZephyrUpload[] = [];
  const weblinks: ZephyrWebLink[] = [];
  const cycles: Cycle[] = [];
  let failure: { status: number; createsCycle: boolean } | null = null;
  const selfUrl = (key: string) => `https://api.zephyrscale.smartbear.com/v2/testcycles/${key}`;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
  });

  function handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const url = new URL(req.url ?? '/', 'http://mock');
    const query = Object.fromEntries(url.searchParams);
    const path = url.pathname.replace(/^\/v2/, '');
    calls.push({ path, query, authorization: req.headers.authorization });
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, fixture('error-unauthorized'));
    }
    if (req.method === 'POST' && path === '/automations/executions/custom') {
      const parts = multipartParts(body, req.headers['content-type']);
      const file = parts.get('file');
      const cycleInput = parts.get('testCycle');
      if (!file || !cycleInput) return send(400, fixture('error-project-not-found'));
      const cycle = JSON.parse(cycleInput.toString('utf8')) as { name: string; description: string };
      const results = JSON.parse(strFromU8(unzipSync(new Uint8Array(file))['results.json']!)) as {
        executions: ZephyrUpload['executions'];
      };
      uploads.push({
        projectKey: query.projectKey,
        name: cycle.name,
        description: cycle.description,
        executions: results.executions,
      });
      const fails = failure;
      failure = null;
      if (fails && !fails.createsCycle) return send(fails.status, fixture('error-server'));
      const made: Cycle = { id: 3000 + cycles.length + 1, key: `SHOP-R${cycles.length + 1}`, name: cycle.name };
      cycles.push(made);
      if (fails) return send(fails.status, fixture('error-server'));
      return send(200, JSON.stringify({ testCycle: { id: made.id, key: made.key, url: selfUrl(made.key) } }));
    }
    const weblink = req.method === 'POST' ? /^\/testcycles\/([^/]+)\/links\/weblinks$/.exec(path) : null;
    if (weblink) {
      const input = JSON.parse(body.toString('utf8')) as { url: string; description: string };
      weblinks.push({ cycleKey: weblink[1]!, url: input.url, description: input.description });
      return send(201, JSON.stringify({ id: weblinks.length }));
    }
    const startAt = Number(query.startAt ?? 0);
    if (path === '/projects') return send(200, fixture(startAt === 0 ? 'projects-page-1' : 'projects-page-2'));
    if (path === '/statuses') {
      return send(
        200,
        fixture(query.statusType === 'TEST_EXECUTION' ? 'statuses-test-execution' : 'statuses-test-case'),
      );
    }
    if (path === '/folders') return send(200, fixture('folders-test-cycle'));
    if (path === '/testcases') return send(200, fixture(startAt === 0 ? 'testcases-page-1' : 'testcases-page-2'));
    if (path === '/testexecutions') {
      return send(
        200,
        JSON.stringify({
          next: null,
          startAt: 0,
          maxResults: 1000,
          total: cycles.length,
          isLast: true,
          values: cycles.map((c) => ({
            id: c.id + 2000,
            testCase: { id: 1, self: 'https://api.zephyrscale.smartbear.com/v2/testcases/SHOP-T1/versions/1' },
            testCycle: { id: c.id, self: selfUrl(String(c.id)) },
          })),
        }),
      );
    }
    const cycle = /^\/testcycles\/(\d+)$/.exec(path);
    const found = cycle ? cycles.find((c) => c.id === Number(cycle[1])) : undefined;
    if (found) {
      return send(
        200,
        JSON.stringify({ id: found.id, key: found.key, name: found.name, links: { self: selfUrl(found.key) } }),
      );
    }
    return send(404, fixture('error-project-not-found'));
  }
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    caseRequests: () => calls.filter((c) => c.path === '/testcases').length,
    uploads,
    weblinks,
    failNextUpload: (status, options) => {
      failure = { status, createsCycle: options?.createsCycle === true };
    },
    reset: () => {
      uploads.length = 0;
      weblinks.length = 0;
      cycles.length = 0;
      failure = null;
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
