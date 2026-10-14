import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

/** The variable the workers read the backend's URL from. */
export const API_BACKEND_ENV = 'PIWI_ITEST_API_BACKEND';

/** The backend file each path runs, which its server coverage names. */
export const API_BACKEND_FILES: Record<string, string> = {
  '/api/items': 'src/Api/Controllers/ItemsController.cs',
  '/api/orders': 'src/Api/Controllers/OrdersController.cs',
};

/** The logs the backend sends in `X-Piwi-Logs` for a path. */
export function backendLogsOf(path: string): Array<Record<string, unknown>> {
  return [{ timestamp: 1, level: 'Warning', category: 'Api.Controllers', message: `Handled ${path}` }];
}

interface CollectBody {
  groups?: Array<{ key: string; requests: string[] }>;
}

/**
 * Global setup: a stub of a backend built with Piwi's instrumentation, for
 * the API tests of `capture.spec.ts`. Each answer carries its logs
 * (`X-Piwi-Logs`) and names its request's server coverage
 * (`X-Piwi-Coverage`), and `POST /__piwi/coverage/collect` answers the files
 * each named request ran, as the ASP.NET Core package does. It runs in the
 * runner process, where the reporter collects a test's server coverage after
 * the test ended, so it outlives the workers; it is unref'd, and ends with the
 * run.
 */
export default async function startApiBackend(): Promise<void> {
  const ran = new Map<string, string>();
  let sequence = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'POST' && path === '/__piwi/coverage/collect') {
        const groups = (JSON.parse(body) as CollectBody).groups ?? [];
        const answer = {
          v: 1,
          groups: groups.map((group) => ({
            key: group.key,
            files: group.requests
              .filter((id) => ran.has(id))
              .map((id) => ({ path: ran.get(id)!, runtime: 'server', lines: [[10, 14]] })),
            missing: group.requests.filter((id) => !ran.has(id)),
          })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
        return;
      }
      const file = API_BACKEND_FILES[path];
      const id = `itest-api.${++sequence}`;
      if (file) ran.set(id, file);
      res.writeHead(path === '/api/orders' ? 201 : file ? 200 : 404, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Piwi-Logs': gzipSync(JSON.stringify(backendLogsOf(path))).toString('base64'),
        'X-Piwi-Coverage': id,
      });
      res.end(JSON.stringify({ path }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  process.env[API_BACKEND_ENV] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
