/**
 * A stand-in for the Zephyr Scale Cloud API on a local port, serving the recorded shapes in `tests/fixtures/
 * zephyr-scale/` (projects, case statuses and cases over two pages). It records what it was asked, so a spec can see
 * the bearer token arrive here and nowhere else. Sample data only; the real service is never called.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface ZephyrCall {
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
}

export interface MockZephyr {
  /** The origin the spawned server's fetch is redirected to. */
  url: string;
  calls: ZephyrCall[];
  /** How many catalog pages were asked for. */
  caseRequests(): number;
  close(): Promise<void>;
}

function fixture(name: string): string {
  return readFileSync(resolve('tests', 'fixtures', 'zephyr-scale', `${name}.json`), 'utf8');
}

export async function startMockZephyr(token: string): Promise<MockZephyr> {
  const calls: ZephyrCall[] = [];
  const server: Server = createServer((req, res) => {
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
    return send(404, fixture('error-project-not-found'));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    caseRequests: () => calls.filter((c) => c.path === '/testcases').length,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
