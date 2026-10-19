import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * DNS rebinding against `safeFetch`: the name resolves to a public address
 * when the URL is checked and to a loopback one when the connection is made.
 * The connection uses the checked lookup, so it never reaches the local server.
 * Link unfurling goes through the same guard.
 */

const dns = vi.hoisted(() => ({
  /** What the connection's lookup resolves every name to. */
  connectAddress: '127.0.0.1',
  /** The names the connection's lookup was asked for. */
  looked: [] as string[],
}));

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookup: (
    hostname: string,
    _options: unknown,
    callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
  ) => {
    dns.looked.push(hostname);
    callback(null, [{ address: dns.connectAddress, family: 4 }]);
  },
}));

const { safeFetch, publicOnlyLookup } = await import('../../server/utils/safe-fetch');
const { GenericUnfurlProvider } = await import('../../server/utils/unfurl/GenericUnfurlProvider');

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Internal admin</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Resolve `hostname` through the connection lookup. */
function lookUp(hostname: string, all: boolean) {
  return new Promise<{ err: Error | null; address: unknown }>((resolve) =>
    publicOnlyLookup(hostname, { all }, (err, address) => resolve({ err, address })),
  );
}

describe('the connection lookup', () => {
  test('refuses a name that resolves to a blocked address', async () => {
    dns.connectAddress = '169.254.169.254';
    const { err } = await lookUp('metadata.example.test', true);
    expect(err?.message).toContain('not allowed');
  });

  test('passes a public address through, in the shape the caller asked for', async () => {
    dns.connectAddress = '93.184.216.34';
    expect((await lookUp('example.test', true)).address).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect((await lookUp('example.test', false)).address).toBe('93.184.216.34');
  });
});

describe('a name rebound to loopback after the check', () => {
  test('safeFetch never reaches the local server', async () => {
    dns.connectAddress = '127.0.0.1';
    dns.looked = [];
    hits = 0;
    await expect(safeFetch(`http://rebind.example.test:${port}/`)).rejects.toThrow();
    expect(dns.looked).toContain('rebind.example.test');
    expect(hits).toBe(0);
  });

  test('a link to it unfurls to nothing', async () => {
    dns.connectAddress = '127.0.0.1';
    hits = 0;
    const result = await new GenericUnfurlProvider().unfurl(`http://localtest.me:${port}/`, null);
    expect(result.title).toBeNull();
    expect(hits).toBe(0);
  });
});

describe('link unfurling refuses internal addresses written as literals', () => {
  test.each([
    `http://[::ffff:127.0.0.1]:PORT/`,
    'http://[fd00::1]/',
    `http://127.0.0.1:PORT/`,
    'http://169.254.169.254/latest/meta-data',
  ])('%s', async (template) => {
    hits = 0;
    const result = await new GenericUnfurlProvider().unfurl(template.replace('PORT', String(port)), null);
    expect(result.title).toBeNull();
    expect(hits).toBe(0);
  });
});
