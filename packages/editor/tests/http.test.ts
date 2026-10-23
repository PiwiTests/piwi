import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { hasProxy, instanceFetch, isLoopback } from '../src/http.js';

describe('the requests to an instance', () => {
  test('name a proxy through the environment, upper or lower case', () => {
    expect(hasProxy({})).toBe(false);
    expect(hasProxy({ HTTPS_PROXY: ' ' })).toBe(false);
    expect(hasProxy({ https_proxy: 'http://proxy.corp:3128' })).toBe(true);
    expect(hasProxy({ HTTP_PROXY: 'http://proxy.corp:3128' })).toBe(true);
  });

  test('reach this machine directly', () => {
    for (const url of ['http://localhost:3000', 'http://app.localhost', 'http://127.0.0.1:9', 'http://[::1]:3000/x']) {
      expect(isLoopback(url)).toBe(true);
    }
    for (const url of ['https://piwi.example.com', 'http://10.0.0.4:3000', 'not a url']) {
      expect(isLoopback(url)).toBe(false);
    }
  });

  describe('with a proxy named', () => {
    let proxy: http.Server;
    let proxied: string[] = [];
    let local: http.Server;

    beforeAll(async () => {
      // A proxy that records the address it is asked for, and refuses the tunnel to it.
      proxy = http.createServer((req, res) => {
        proxied.push(req.url ?? '');
        res.statusCode = 403;
        res.end();
      });
      proxy.on('connect', (req: http.IncomingMessage, socket: Socket) => {
        proxied.push(req.url ?? '');
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
      local = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ via: 'direct' }));
      });
      await Promise.all([proxy, local].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    });

    afterAll(async () => {
      await Promise.all([proxy, local].map((s) => new Promise<void>((r) => s.close(() => r()))));
    });

    test('go through it to an instance off this machine, and directly to one on it', async () => {
      proxied = [];
      const env = { HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}` };
      await instanceFetch('http://piwi.example.com/api/projects/menu', {}, env).catch(() => null);
      expect(proxied).toHaveLength(1);
      expect(proxied[0]).toContain('piwi.example.com');
      const on = await instanceFetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/x`, {}, env);
      expect(await on.json()).toEqual({ via: 'direct' });
      expect(proxied).toHaveLength(1);
    });
  });
});
