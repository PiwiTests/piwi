import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { FormData, HttpClient } from '../src/internal/transport/http-client.js';
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

    it('resolves to {} when the response body is not JSON', async () => {
      const { server, url } = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('not json');
      });
      try {
        const client = new HttpClient(url, new Logger(false));
        const out = await client.postJSON('/api/x', {}, null);
        expect(out).toEqual({});
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
