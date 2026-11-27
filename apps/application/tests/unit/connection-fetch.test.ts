import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

/**
 * A Jira site or an AI base URL set in Settings reaches a private address only on a place the operator allows: the
 * host of an address the environment sets, a `PIWI_PRIVATE_HOSTS` entry, or anywhere on the desktop app. Each hop of a
 * redirect is checked on its own, and a hop to another site loses the request's credentials.
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

const runtimeAi: Record<string, string> = {};
vi.stubGlobal('useRuntimeConfig', () => ({ ai: runtimeAi }));

const { connectionFetch, connectionMayReachPrivateAddress, connectionPrivatePlaces } = await vi.importActual<
  typeof import('../../server/utils/connection-fetch')
>('../../server/utils/connection-fetch');
const { PrivateAddressError, privateAddressRefusal } = await import('../../server/utils/safe-fetch');

const ENV = [
  'PIWI_PRIVATE_HOSTS',
  'PIWI_JIRA_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'PIWI_DESKTOP_TOKEN',
  'NUXT_PUBLIC_DESKTOP',
];

let server: Server;
let port: number;
let hits = 0;

/** Answers `/echo` with what it received, and `/to?status=&url=` with a redirect. */
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/to') {
      res.writeHead(Number(url.searchParams.get('status')), { location: url.searchParams.get('url') ?? '/' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          method: req.method,
          host: req.headers.host,
          authorization: req.headers.authorization ?? null,
          contentType: req.headers['content-type'] ?? null,
          body,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  for (const name of ENV) delete process.env[name];
  for (const key of Object.keys(runtimeAi)) delete runtimeAi[key];
  hits = 0;
});

/** The error a request answers, or null when it reached a server. */
async function refusal(url: string, init: RequestInit = {}): Promise<unknown> {
  try {
    await connectionFetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    return null;
  } catch (error) {
    return error;
  }
}

const redirect = (status: number, to: string) =>
  `http://127.0.0.1:${port}/to?status=${status}&url=${encodeURIComponent(to)}`;

describe('the places a connection may reach on a private address', () => {
  test('are the hosts the environment sets an address on, and the entries of PIWI_PRIVATE_HOSTS', () => {
    process.env.PIWI_JIRA_BASE_URL = 'http://jira.internal:8080/jira';
    runtimeAi.baseUrl = 'http://ollama:11434/v1';
    runtimeAi.embeddingBaseUrl = 'ollama:11434';
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.lan';
    process.env.PIWI_PRIVATE_HOSTS = 'models.lan, jira.lan:8443, bad/path';
    expect(connectionPrivatePlaces()).toEqual([
      { host: 'jira.internal', port: '8080' },
      { host: 'ollama', port: '11434' },
      { host: 'gateway.lan', port: '443' },
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
      `http://127.0.0.1:${port}/echo`,
      `http://localhost:${port}/echo`,
      `http://2130706433:${port}/`,
      `http://[::ffff:127.0.0.1]:${port}/`,
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/',
      `http://rebound.example:${port}/`,
    ]) {
      const error = await refusal(url);
      expect(error, url).toBeInstanceOf(PrivateAddressError);
      expect(privateAddressRefusal(new Error('Connection error.', { cause: error }))).toBe(error);
    }
    expect(hits).toBe(0);
  });

  test('names the host and the variable that would allow it, and whether the name resolves there', async () => {
    expect(((await refusal(`http://127.0.0.1:${port}/echo`)) as Error).message).toBe(
      `127.0.0.1:${port} is a private address, which an address set in Settings may not reach. The operator allows it by listing the host in PIWI_PRIVATE_HOSTS.`,
    );
    expect(((await refusal('http://metadata.google.internal/')) as Error).message).toMatch(
      /^metadata\.google\.internal is a name reserved for private addresses, /,
    );
    expect(((await refusal(`http://rebound.example:${port}/`)) as Error).message).toMatch(
      new RegExp(`^rebound\\.example:${port} resolves to a private address, .* PIWI_PRIVATE_HOSTS\\.$`),
    );
  });

  test('keeps its refusal readable through the Anthropic client, which wraps it', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: 'key',
      baseURL: 'http://169.254.169.254',
      fetch: connectionFetch as typeof fetch,
      maxRetries: 0,
    });
    const error = await client.messages
      .create({ model: 'model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).not.toContain('PIWI_PRIVATE_HOSTS');
    expect(privateAddressRefusal(error)).toBeInstanceOf(PrivateAddressError);
  });

  test('reaches a private address the operator allows, a form sent as its bytes', async () => {
    process.env.PIWI_PRIVATE_HOSTS = `127.0.0.1:${port}`;
    const form = new FormData();
    form.append('file', new Blob(['shot']), 'shot.png');
    const answer = await (
      await connectionFetch(`http://127.0.0.1:${port}/echo`, { method: 'POST', body: form })
    ).json();
    expect(answer.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(answer.body).toContain('filename="shot.png"');
  });

  test('checks each hop of a redirect on its own', async () => {
    process.env.PIWI_PRIVATE_HOSTS = `127.0.0.1:${port}`;
    expect(await refusal(redirect(302, `http://localhost:${port}/echo`))).toBeInstanceOf(PrivateAddressError);
    expect(await refusal(redirect(302, 'http://169.254.169.254/'))).toBeInstanceOf(PrivateAddressError);
    expect(String(await refusal(redirect(302, 'file:///etc/passwd')))).toContain('Only http(s)');
  });

  test('keeps its credentials on its own site and drops them on another', async () => {
    process.env.PIWI_PRIVATE_HOSTS = `127.0.0.1:${port},localhost:${port}`;
    const headers = { authorization: 'Basic c2VjcmV0' };
    const same = await (await connectionFetch(redirect(302, '/echo'), { headers })).json();
    expect(same).toMatchObject({ host: `127.0.0.1:${port}`, authorization: 'Basic c2VjcmV0' });
    const other = await (await connectionFetch(redirect(302, `http://localhost:${port}/echo`), { headers })).json();
    expect(other).toMatchObject({ host: `localhost:${port}`, authorization: null });
  });

  test('follows a redirect as fetch does: a 307 keeps the POST, a 302 turns it into a GET', async () => {
    process.env.PIWI_PRIVATE_HOSTS = `127.0.0.1:${port}`;
    const init = { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } };
    expect(await (await connectionFetch(redirect(307, '/echo'), init)).json()).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
    });
    expect(await (await connectionFetch(redirect(302, '/echo'), init)).json()).toMatchObject({
      method: 'GET',
      body: '',
      contentType: null,
    });
    const manual = await connectionFetch(redirect(302, '/echo'), { redirect: 'manual' });
    expect(manual.status).toBe(302);
  });
});
