import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { FormData, HttpClient, runTokenHeaders } from '../src/internal/transport/http-client.js';
import { desktopTokenProof } from '@piwitests/core/desktop-proof';
import { Logger } from '../src/internal/support/logger.js';

interface RecordedReq {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startServer(handler: (req: RecordedReq, res: http.ServerResponse) => void): Promise<{
  server: http.Server;
  url: string;
  requests: RecordedReq[];
}> {
  const requests: RecordedReq[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const rec: RecordedReq = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body };
      requests.push(rec);
      handler(rec, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no addr'));
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

function jsonRes(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

describe('HttpClient (against fake http.Server)', () => {
  describe('postJSON', () => {
    it('sends a JSON POST and parses the response', async () => {
      const { server, url, requests } = await startServer((req, res) => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/api/echo');
        jsonRes(res, 200, { ok: true, echoed: JSON.parse(req.body) });
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        const out = await client.postJSON('/api/echo', { hello: 'world' }, null);
        expect(out.ok).toBe(true);
        expect(out.echoed).toEqual({ hello: 'world' });
        expect(requests.length).toBe(1);
        expect(requests[0].headers['content-type']).toBe('application/json');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rejects with "Request failed with status N" on non-2xx', async () => {
      const { server, url } = await startServer((_req, res) => jsonRes(res, 404, { error: 'nope' }));
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.postJSON('/api/x', {}, null)).rejects.toThrow(/Request failed with status 404/);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it("carries the server's own word on a refusal, on one bounded line", async () => {
      const refusal =
        'With authentication off, this dashboard answers only on its local addresses.\nAdd the name you use.';
      const answers: Record<string, (res: http.ServerResponse) => void> = {
        '/plain': (res) => {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(refusal);
        },
        '/json': (res) =>
          jsonRes(res, 403, { statusCode: 403, statusMessage: 'Forbidden', message: 'No access to this project' }),
        '/status-message': (res) => jsonRes(res, 403, { statusMessage: 'Forbidden' }),
        '/long': (res) => {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('x'.repeat(2000));
        },
        '/html': (res) => {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>403 Forbidden</h1></body></html>');
        },
      };
      const { server, url } = await startServer((req, res) => answers[req.url]!(res));
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.postJSON('/plain', {}, null)).rejects.toThrow(
          'Request failed with status 403: With authentication off, this dashboard answers only on its local addresses. Add the name you use.',
        );
        await expect(client.putJSON('/json', {}, null)).rejects.toThrow(
          'Request failed with status 403: No access to this project',
        );
        await expect(client.postJSON('/status-message', {}, null)).rejects.toThrow(
          'Request failed with status 403: Forbidden',
        );
        const long = await client.postJSON('/long', {}, null).catch((error: Error) => error.message);
        expect(long).toBe(`Request failed with status 403: ${'x'.repeat(499)}…`);
        const form = new FormData();
        form.append('field', 'value');
        await expect(client.postFormData('/plain', form, null)).rejects.toThrow(/status 403: With authentication off/);
        const html = await client.postJSON('/html', {}, null).catch((error: Error) => error.message);
        expect(html).toBe('Request failed with status 403');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('reads a character the answer splits across two chunks', async () => {
      const body = Buffer.from(JSON.stringify({ title: 'café ✓' }));
      const cut = body.indexOf(Buffer.from('é')) + 1;
      const { server, url } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(body.subarray(0, cut));
        setTimeout(() => res.end(body.subarray(cut)), 30);
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.postJSON('/api/x', {}, null)).resolves.toEqual({ title: 'café ✓' });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rejects a 2xx answer that is not JSON, naming its content type', async () => {
      const { server, url } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title>');
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.postJSON('/api/x', {}, null)).rejects.toThrow(
          'The answer to /api/x is not JSON (text/html; charset=utf-8)',
        );
        const form = new FormData();
        form.append('field', 'value');
        await expect(client.postFormData('/api/upload', form, null)).rejects.toThrow(/not JSON \(text\/html/);
        await expect(client.putJSON('/api/put', {}, null)).rejects.toThrow(/not JSON \(text\/html/);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('applies apiKey as Bearer header (pd_ prefix)', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        await client.postJSON('/api/x', {}, 'pd_secret123');
        expect(requests[0].headers['authorization']).toBe('Bearer pd_secret123');
        expect(requests[0].headers['cookie']).toBe(undefined);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('applies a request token as Bearer header (pdq_ prefix)', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        const token = `pdq_${'b'.repeat(64)}`;
        await client.postJSON('/api/x', {}, token);
        expect(requests[0].headers['authorization']).toBe(`Bearer ${token}`);
        expect(requests[0].headers['cookie']).toBe(undefined);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('sends a run token in its header beside the body, and none without one', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        await client.postJSON('/api/x', { streamToken: 'tok' }, null, undefined, { headers: runTokenHeaders('tok') });
        await client.postJSON('/api/x', {}, null, undefined, { headers: runTokenHeaders(null) });
        expect(requests[0].headers['x-piwi-run-token']).toBe('tok');
        expect(requests[0].headers['content-type']).toBe('application/json');
        expect(JSON.parse(requests[0].body)).toEqual({ streamToken: 'tok' });
        expect(requests[1].headers['x-piwi-run-token']).toBe(undefined);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('applies session cookie as Cookie header', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        await client.postJSON('/api/x', {}, 'session=abc; path=/');
        expect(requests[0].headers['cookie']).toBe('session=abc; path=/');
        expect(requests[0].headers['authorization']).toBe(undefined);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe('login', () => {
    it('returns the session cookie on 200', async () => {
      const { server, url, requests } = await startServer((req, res) => {
        expect(JSON.parse(req.body)).toEqual({ username: 'u', password: 'p' });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['session=abc; Path=/', 'other=xyz; HttpOnly'],
        });
        res.end(JSON.stringify({ ok: true }));
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        const cookie = await client.login('u', 'p');
        expect(cookie).toBe('session=abc; other=xyz');
        expect(requests[0].url).toBe('/api/auth/login');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rejects when no set-cookie header is returned', async () => {
      const { server, url } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.login('u', 'p')).rejects.toThrow(/no session cookie/);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('rejects with "Login failed with status N" on non-2xx', async () => {
      const { server, url } = await startServer((_req, res) => jsonRes(res, 401, { error: 'bad' }));
      try {
        const client = new HttpClient(url, new Logger(false));
        await expect(client.login('u', 'p')).rejects.toThrow(/Login failed with status 401/);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe('resolveAuth', () => {
    it('returns apiKey directly when set', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        const auth = await client.resolveAuth({ apiKey: 'pd_key', username: 'u', password: 'p' });
        expect(auth).toBe('pd_key');
        expect(requests.length).toBe(0); // no login call
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('returns null when neither apiKey nor username/password configured', async () => {
      const { server, url } = await startServer((_req, res) => jsonRes(res, 200, {}));
      try {
        const client = new HttpClient(url, new Logger(false));
        const auth = await client.resolveAuth({ apiKey: null, username: null, password: null });
        expect(auth).toBe(null);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });

    it('logs in when username/password provided', async () => {
      const { server, url, requests } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['sess=1; Path=/'] });
        res.end('{}');
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        const auth = await client.resolveAuth({ apiKey: null, username: 'u', password: 'p' });
        expect(auth).toBe('sess=1');
        expect(requests[0].url).toBe('/api/auth/login');
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe('request timeout', () => {
    it('rejects when the server never responds within the timeout', async () => {
      // Server accepts the request but never responds (never calls res.end).
      const { server, url } = await startServer((_req, _res) => {
        // intentionally swallow the request and never respond
      });
      try {
        const client = new HttpClient(url, new Logger(false), 100);
        await expect(client.postJSON('/api/slow', {}, null)).rejects.toThrow(/timed out after 100ms/);
      } finally {
        // Drop the hung connection and stop accepting new ones.
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });
  });

  describe('postJSON of a run', () => {
    it('waits for a slow answer past the JSON timeout, up to the upload timeout', async () => {
      const { server, url } = await startServer((_req, res) => {
        setTimeout(() => jsonRes(res, 200, { runId: 7 }), 300);
      });
      try {
        const client = new HttpClient(url, new Logger(false), 100, 2000);
        await expect(client.postJSON('/api/results', {}, null, undefined, { upload: true })).resolves.toEqual({
          runId: 7,
        });
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });
  });

  describe('postFormData', () => {
    it('waits for a slow answer past the JSON timeout, up to the upload timeout', async () => {
      const { server, url } = await startServer((_req, res) => {
        setTimeout(() => jsonRes(res, 200, { runId: 7 }), 300);
      });
      try {
        const client = new HttpClient(url, new Logger(false), 100, 2000);
        const form = new FormData();
        form.append('field', 'value');
        await expect(client.postFormData('/api/upload', form, null)).resolves.toEqual({ runId: 7 });
        await expect(client.postJSON('/api/submit', {}, null)).rejects.toThrow(/timed out after 100ms/);
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });

    it('ends an upload when its signal aborts, in flight or before it starts', async () => {
      const { server, url, requests } = await startServer(() => {
        // never respond
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        const controller = new AbortController();
        const form = new FormData();
        form.append('field', 'value');
        const pending = client.postFormData('/api/upload', form, null, controller.signal);
        await expect.poll(() => requests.length).toBe(1);
        controller.abort(new Error('no time left'));
        await expect(pending).rejects.toThrow('no time left');

        const later = new FormData();
        later.append('field', 'value');
        await expect(client.postFormData('/api/upload', later, null, controller.signal)).rejects.toThrow(
          'no time left',
        );
        expect(requests).toHaveLength(1);
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });

    it('rejects when a file in the form cannot be read, without an uncaught exception', async () => {
      const { server, url } = await startServer((_req, res) => jsonRes(res, 200, {}));
      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown) => uncaught.push(error);
      process.on('uncaughtException', onUncaught);
      try {
        const form = new FormData();
        form.append('field', 'value');
        form.append('file', fs.createReadStream(path.join(os.tmpdir(), `piwi-missing-${process.pid}.zip`)), {
          filename: 'trace.zip',
        });
        const client = new HttpClient(url, new Logger(false));
        await expect(client.postFormData('/api/upload', form, null)).rejects.toThrow(/ENOENT/);
        expect(uncaught).toEqual([]);
      } finally {
        process.off('uncaughtException', onUncaught);
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });
  });

  describe('close', () => {
    it('aborts a request in flight and fails every later one with the reason', async () => {
      const { server, url, requests } = await startServer((_req, _res) => {
        // never respond
      });
      try {
        const client = new HttpClient(url, new Logger(false), 30000);
        const pending = client.postJSON('/api/hung', {}, null);
        await expect.poll(() => requests.length).toBe(1);
        client.close('budget spent');
        await expect(pending).rejects.toThrow('budget spent');
        expect(client.closed).toBe(true);
        await expect(client.postJSON('/api/later', {}, null)).rejects.toThrow('budget spent');
        expect(requests.length).toBe(1);
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });
  });

  describe('connection dropped mid-response', () => {
    it('rejects when the socket closes after the headers but before the body completes', async () => {
      const { server, url } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        setTimeout(() => res.socket?.destroy(), 20);
      });
      try {
        const client = new HttpClient(url, new Logger(false), 5000);
        await expect(client.postJSON('/api/cut', {}, null)).rejects.toThrow(
          /closed before the response completed|aborted|ECONNRESET|socket hang up/,
        );
      } finally {
        (server as any).closeAllConnections?.();
        server.close();
        await new Promise<void>((r) => server.on('close', () => r()));
      }
    });
  });

  describe("the desktop app's token", () => {
    const TOKEN = 'pd_desktop_token';

    /** A server that answers the health check with `proofOf(challenge, port)` and everything else with `{}`. */
    async function desktopServer(proofOf: (challenge: string, port: number) => Promise<string | null>, status = 200) {
      const started = await startServer(() => undefined);
      const port = Number(new URL(started.url).port);
      started.server.removeAllListeners('request');
      started.server.on('request', async (req, res) => {
        const rec = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: '' };
        started.requests.push(rec);
        if (req.url === '/api/health') {
          const proof = await proofOf(String(req.headers['x-piwi-desktop-challenge'] ?? ''), port);
          res.writeHead(status, proof ? { 'x-piwi-desktop-proof': proof } : {});
          res.end('{}');
          return;
        }
        req.resume();
        req.on('end', () => jsonRes(res, 200, {}));
      });
      return started;
    }
    const honest = (challenge: string, port: number) => desktopTokenProof(TOKEN, port, challenge);
    const close = (server: http.Server) => new Promise<void>((r) => server.close(() => r()));

    it('sends the token after the server proved it holds it, with a proof of its own for each request', async () => {
      const { server, url, requests } = await desktopServer(honest);
      try {
        const client = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
        await client.postJSON('/api/a', {}, TOKEN);
        await client.postJSON('/api/b', {}, TOKEN);
        expect(requests.map((r) => [r.url, r.headers['authorization']])).toEqual([
          ['/api/health', undefined],
          ['/api/a', `Bearer ${TOKEN}`],
          ['/api/health', undefined],
          ['/api/b', `Bearer ${TOKEN}`],
        ]);
      } finally {
        await close(server);
      }
    });

    it.each([
      ['proves it with another token', (c: string, p: number) => desktopTokenProof('pd_other', p, c), 200],
      ['proves it for another port', (c: string) => desktopTokenProof(TOKEN, 1, c), 200],
      ['gives no proof', async () => null, 200],
      ['answers the check with an error', honest, 503],
    ])('sends no token to a server that %s', async (_name, proofOf, status) => {
      const { server, url, requests } = await desktopServer(proofOf, status);
      try {
        const client = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
        await expect(client.postJSON('/api/a', {}, TOKEN)).rejects.toThrow(
          /token is not sent to http:\/\/127\.0\.0\.1:\d+/,
        );
        await expect(client.postJSON('/api/b', {}, TOKEN)).rejects.toThrow(/did not prove it holds the token/);
        expect(requests.map((r) => r.url)).toEqual(['/api/health', '/api/health']);
        expect(requests.every((r) => r.headers['authorization'] === undefined)).toBe(true);
      } finally {
        await close(server);
      }
    });

    it('sends no token when nothing answers the check, and asks again with the next request', async () => {
      const { server, url, requests } = await desktopServer(honest);
      await close(server);
      const client = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
      await expect(client.postJSON('/api/a', {}, TOKEN)).rejects.toThrow('did not answer');
      await expect(client.postJSON('/api/b', {}, TOKEN)).rejects.toThrow('did not answer');
      expect(requests).toHaveLength(0);
    });

    it('fails a server that did not answer like a connection that never opened, and one that did not prove it for good', async () => {
      const gone = await desktopServer(honest);
      await close(gone.server);
      const down = await new HttpClient(gone.url, new Logger(false), 30000, 1000, TOKEN)
        .postJSON('/api/a', {}, TOKEN)
        .catch((error) => error);
      expect((down as { code?: string }).code).toBe('ECONNREFUSED');

      const silent = await desktopServer(async () => null);
      try {
        const refused = await new HttpClient(silent.url, new Logger(false), 30000, 1000, TOKEN)
          .postJSON('/api/a', {}, TOKEN)
          .catch((error) => error);
        expect(refused.name).toBe('DesktopNotProvenError');
        expect((refused as { code?: string }).code).toBeUndefined();
      } finally {
        await close(silent.server);
      }
    });

    it('sends no token after a failed connection to a server that cannot prove it', async () => {
      const first = await desktopServer(honest);
      const client = new HttpClient(first.url, new Logger(false), 30000, 1000, TOKEN);
      await client.postJSON('/api/a', {}, TOKEN);
      await close(first.server);
      await expect(client.postJSON('/api/b', {}, TOKEN)).rejects.toThrow();

      const replaced: Array<[string | undefined, string | undefined]> = [];
      const impostor = http.createServer((req, res) => {
        replaced.push([req.url, req.headers['authorization']]);
        req.resume();
        res.end('{}');
      });
      await new Promise<void>((resolve) => impostor.listen(Number(new URL(first.url).port), '127.0.0.1', resolve));
      try {
        await expect(client.postJSON('/api/c', {}, TOKEN)).rejects.toThrow(/did not prove it holds the token/);
        expect(replaced).toEqual([['/api/health', undefined]]);
      } finally {
        await close(impostor);
      }
    });

    it('shares a proof still being asked between requests that start together', async () => {
      const { server, url, requests } = await desktopServer(async (c, p) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return honest(c, p);
      });
      try {
        const client = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
        await Promise.all([client.postJSON('/api/a', {}, TOKEN), client.postJSON('/api/b', {}, TOKEN)]);
        expect(requests.filter((r) => r.url === '/api/health')).toHaveLength(1);
        expect(requests.filter((r) => r.headers['authorization'] === `Bearer ${TOKEN}`)).toHaveLength(2);
      } finally {
        await close(server);
      }
    });

    it('sends no token to a server that replaced the app with no request failing in between', async () => {
      const first = await desktopServer(honest);
      const client = new HttpClient(first.url, new Logger(false), 30000, 1000, TOKEN);
      await client.postJSON('/api/a', {}, TOKEN);
      await close(first.server);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const replaced: Array<[string | undefined, string | undefined]> = [];
      const impostor = http.createServer((req, res) => {
        replaced.push([req.url, req.headers['authorization']]);
        req.resume();
        res.end('{}');
      });
      await new Promise<void>((resolve) => impostor.listen(Number(new URL(first.url).port), '127.0.0.1', resolve));
      try {
        await expect(client.postJSON('/api/b', {}, TOKEN)).rejects.toThrow(/did not prove it holds the token/);
        expect(replaced).toEqual([['/api/health', undefined]]);
      } finally {
        await close(impostor);
      }
    });

    it('makes no check for a request that carries another credential, or for a client that holds no desktop token', async () => {
      const { server, url, requests } = await desktopServer(async () => null);
      try {
        const held = new HttpClient(url, new Logger(false), 30000, 1000, TOKEN);
        await held.postJSON('/api/a', {}, 'pd_someone_else');
        await held.postJSON('/api/b', {}, null);
        const plain = new HttpClient(url, new Logger(false));
        await plain.postJSON('/api/c', {}, TOKEN);
        expect(requests.map((r) => [r.url, r.headers['authorization']])).toEqual([
          ['/api/a', 'Bearer pd_someone_else'],
          ['/api/b', undefined],
          ['/api/c', `Bearer ${TOKEN}`],
        ]);
      } finally {
        await close(server);
      }
    });
  });

  describe('serverUrl', () => {
    it('sends nothing to an address that is not a whole http:// or https:// URL', async () => {
      const { server, url, requests } = await startServer((_req, res) => jsonRes(res, 200, { ok: true }));
      try {
        const request = (serverUrl: string) =>
          new HttpClient(serverUrl, new Logger(false)).postJSON('/api/x', {}, null);
        await expect(request(url.replace('http:', 'ftp:'))).rejects.toThrow('is not an http:// or https:// URL');
        await expect(request('localhost:3000')).rejects.toThrow('is not an http:// or https:// URL');
        await expect(request('piwi.example.com')).rejects.toThrow('"piwi.example.com" is not a URL');
        expect(requests).toHaveLength(0);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });

  describe('insecure transport warning', () => {
    function warningsFor(url: string): string[] {
      const logger = new Logger(false);
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      new HttpClient(url, logger);
      const calls = spy.mock.calls.map((c) => String(c[0]));
      spy.mockRestore();
      return calls;
    }

    it('warns when the dashboard URL is plaintext http:// to a remote host', () => {
      const w = warningsFor('http://dashboard.example.com:3000');
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/plaintext http/i);
    });

    it('does not warn for loopback http:// (localhost / 127.0.0.1 / ::1)', () => {
      expect(warningsFor('http://localhost:3000')).toHaveLength(0);
      expect(warningsFor('http://127.0.0.1:3000')).toHaveLength(0);
      expect(warningsFor('http://[::1]:3000')).toHaveLength(0);
    });

    it('does not warn for https:// endpoints', () => {
      expect(warningsFor('https://dashboard.example.com')).toHaveLength(0);
    });
  });
});
