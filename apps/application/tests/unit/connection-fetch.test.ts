import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * A Jira site or an AI base URL set in Settings reaches a private address only on a place the operator allows: the
 * host of an address the environment sets, a `PIWI_PRIVATE_HOSTS` entry, or anywhere on the desktop app.
 */

// A name that resolves to a loopback address, as a DNS answer an administrator controls would.
vi.mock('node:dns', async (importOriginal) => {
  const dns = await importOriginal<typeof import('node:dns')>();
  const lookup = ((host: string, options: object, callback: (...args: unknown[]) => void) =>
    host === 'rebound.example'
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : dns.lookup(host, options as never, callback as never)) as typeof dns.lookup;
  return { ...dns, default: { ...dns, lookup }, lookup };
});

const { connectionFetch, connectionMayReachPrivateAddress, connectionPrivatePlaces, PrivateAddressError } =
  await vi.importActual<typeof import('../../server/utils/connection-fetch')>('../../server/utils/connection-fetch');

const ENV = [
  'PIWI_PRIVATE_HOSTS',
  'PIWI_JIRA_BASE_URL',
  'PIWI_AI_BASE_URL',
  'PIWI_AI_EMBEDDING_BASE_URL',
  'PIWI_DESKTOP_TOKEN',
  'NUXT_PUBLIC_DESKTOP',
];

let server: Server;
let port: number;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.end('{"data":[]}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  hits = 0;
});

/** The error a request answers, or null when it reached the server. */
async function refusal(url: string): Promise<unknown> {
  try {
    await connectionFetch(url, { signal: AbortSignal.timeout(5000) });
    return null;
  } catch (error) {
    return error;
  }
}

describe('the places a connection may reach on a private address', () => {
  test('are the hosts the environment sets an address on, and the entries of PIWI_PRIVATE_HOSTS', () => {
    process.env.PIWI_JIRA_BASE_URL = 'http://jira.internal:8080/jira';
    process.env.PIWI_AI_BASE_URL = 'http://ollama:11434/v1';
    process.env.PIWI_AI_EMBEDDING_BASE_URL = 'not a url';
    process.env.PIWI_PRIVATE_HOSTS = 'models.lan, jira.lan:8443, bad/path';
    expect(connectionPrivatePlaces()).toEqual([
      { host: 'jira.internal', port: '8080' },
      { host: 'ollama', port: '11434' },
      { host: 'models.lan', port: null },
      { host: 'jira.lan', port: '8443' },
    ]);
    expect(connectionMayReachPrivateAddress('http://ollama:11434/v1/chat/completions')).toBe(true);
    expect(connectionMayReachPrivateAddress('http://ollama:11435/v1')).toBe(false);
    expect(connectionMayReachPrivateAddress('https://models.lan:9999/v1')).toBe(true);
    expect(connectionMayReachPrivateAddress('https://jira.lan/')).toBe(false);
  });

  test('are every address on the desktop app', () => {
    expect(connectionMayReachPrivateAddress('http://127.0.0.1:11434/v1')).toBe(false);
    process.env.NUXT_PUBLIC_DESKTOP = 'true';
    expect(connectionMayReachPrivateAddress('http://127.0.0.1:11434/v1')).toBe(true);
  });
});

describe('a request to an address set in Settings', () => {
  test('never reaches a private address the operator did not allow, however it is written', async () => {
    for (const url of [
      `http://127.0.0.1:${port}/v1/models`,
      `http://localhost:${port}/v1/models`,
      `http://2130706433:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      `http://rebound.example:${port}/`,
    ]) {
      expect(await refusal(url), url).toBeInstanceOf(PrivateAddressError);
    }
    expect(hits).toBe(0);
  });

  test('reaches a private address the operator allows', async () => {
    process.env.PIWI_PRIVATE_HOSTS = `127.0.0.1:${port}`;
    const response = await connectionFetch(`http://127.0.0.1:${port}/v1/models`);
    expect(await response.json()).toEqual({ data: [] });
    expect(hits).toBe(1);
  });

  test('refuses an address that is not http(s)', async () => {
    expect(String(await refusal('file:///etc/passwd'))).toContain('Only http(s)');
  });
});
