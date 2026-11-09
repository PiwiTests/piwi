import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { desktopTokenProof, DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER } from '@piwitests/core/desktop-proof';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readDesktopDiscovery } from '../src/context.js';
import { DesktopNotProvenError, forgetDesktopTokens, instanceFetch } from '../src/http.js';
import { PiwiClient } from '../src/piwi-client.js';

const TOKEN = 'pd_sample_desktop_token';

/** A local server; `proves` is the token it proves, or null for no proof. Records the keys its requests carried. */
async function serve(proves: string | null, port = 0, status = 200) {
  const carried: Array<string | undefined> = [];
  let health = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/health') {
      health++;
      const challenge = req.headers[DESKTOP_CHALLENGE_HEADER];
      if (proves && typeof challenge === 'string') {
        const port = (server.address() as AddressInfo).port;
        res.setHeader(DESKTOP_PROOF_HEADER, await desktopTokenProof(proves, port, challenge));
      }
    } else {
      carried.push(req.headers['x-api-key'] as string | undefined);
    }
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = req.url === '/api/health' ? 200 : status;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    carried,
    healthChecks: () => health,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the desktop app's token", () => {
  let home: string;
  let stop: Array<() => Promise<void>> = [];

  beforeEach(() => {
    forgetDesktopTokens();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editor-proof-'));
    fs.mkdirSync(path.join(home, '.piwi'));
  });

  afterEach(async () => {
    await Promise.all(stop.map((close) => close()));
    stop = [];
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The app's discovery file naming `url`, read the way the service reads it. */
  function discover(url: string) {
    fs.writeFileSync(path.join(home, '.piwi', 'desktop.json'), JSON.stringify({ url, token: TOKEN, projects: [] }));
    return readDesktopDiscovery({ PIWI_DESKTOP_CONFIG: path.join(home, '.piwi', 'desktop.json') });
  }

  test('goes out after the server proves it holds the token', async () => {
    const app = await serve(TOKEN);
    stop.push(app.close);
    const desktop = discover(app.url)!;
    await new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' }).projects();
    expect(app.carried).toEqual([TOKEN]);
  });

  test.each([
    ['gives no proof', null],
    ['proves another token', 'pd_other'],
  ])('is not sent to a server that %s', async (_name, proves) => {
    const other = await serve(proves);
    stop.push(other.close);
    const desktop = discover(other.url)!;
    const client = new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' });
    await expect(client.projects()).rejects.toBeInstanceOf(DesktopNotProvenError);
    await expect(client.projects()).rejects.toThrow(/did not prove/);
    expect(other.carried).toEqual([]);
  });

  describe('after the app restarts on the same port', () => {
    const portOf = (url: string) => Number(new URL(url).port);

    test('is not sent once the connection that carried it failed and the new server cannot prove it', async () => {
      const app = await serve(TOKEN);
      const desktop = discover(app.url)!;
      const client = new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' });
      await client.projects();
      await app.close();
      await expect(client.projects()).rejects.toThrow();

      const impostor = await serve(null, portOf(app.url));
      stop.push(impostor.close);
      await expect(client.projects()).rejects.toBeInstanceOf(DesktopNotProvenError);
      expect(impostor.carried).toEqual([]);
    });

    test('is not sent once the old server refused it and the new server cannot prove it', async () => {
      const app = await serve(TOKEN, 0, 401);
      const desktop = discover(app.url)!;
      const client = new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' });
      await expect(client.projects()).rejects.toThrow();
      expect(app.carried).toEqual([TOKEN]);
      await app.close();

      const impostor = await serve(null, portOf(app.url));
      stop.push(impostor.close);
      await expect(client.projects()).rejects.toBeInstanceOf(DesktopNotProvenError);
      expect(impostor.carried).toEqual([]);
    });

    test('is not sent to a server that replaced the app with no request failing in between', async () => {
      const app = await serve(TOKEN);
      const desktop = discover(app.url)!;
      const client = new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' });
      await client.projects();
      await app.close();

      const impostor = await serve(null, portOf(app.url));
      stop.push(impostor.close);
      await expect(client.projects()).rejects.toBeInstanceOf(DesktopNotProvenError);
      expect(impostor.carried).toEqual([]);
    });

    test('is sent after a proof of its own for every request', async () => {
      const app = await serve(TOKEN);
      stop.push(app.close);
      const desktop = discover(app.url)!;
      const client = new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' });
      await client.projects();
      await client.projects();
      expect(app.healthChecks()).toBe(2);
      expect(app.carried).toEqual([TOKEN, TOKEN]);
    });
  });

  test('is not sent when either header carries it and the server cannot prove it', async () => {
    const other = await serve(null);
    stop.push(other.close);
    const desktop = discover(other.url)!;
    await expect(
      instanceFetch(`${other.url}/api/projects`, {
        headers: { 'X-API-Key': 'pd_a_users_own_key', Authorization: `Bearer ${desktop.token}` },
      }),
    ).rejects.toBeInstanceOf(DesktopNotProvenError);
    expect(other.carried).toEqual([]);
  });

  test('is not sent while nothing answers, and is sent once the app does', async () => {
    const app = await serve(TOKEN);
    const url = app.url;
    await app.close();
    const desktop = discover(url)!;
    await expect(instanceFetch(`${url}/api/projects`, { headers: { 'X-API-Key': desktop.token } })).rejects.toThrow(
      /did not answer/,
    );

    const port = Number(new URL(url).port);
    const again = http.createServer(async (req, res) => {
      const challenge = req.headers[DESKTOP_CHALLENGE_HEADER];
      if (req.url === '/api/health' && typeof challenge === 'string') {
        res.setHeader(DESKTOP_PROOF_HEADER, await desktopTokenProof(TOKEN, port, challenge));
      }
      res.end('{}');
    });
    await new Promise<void>((resolve) => again.listen(port, '127.0.0.1', resolve));
    stop.push(() => new Promise<void>((resolve) => again.close(() => resolve())));
    const res = await instanceFetch(`${url}/api/projects`, { headers: { 'X-API-Key': desktop.token } });
    expect(res.status).toBe(200);
  });

  test('is the only key that waits for a proof', async () => {
    const other = await serve(null);
    stop.push(other.close);
    discover(other.url);
    await instanceFetch(`${other.url}/api/projects`, { headers: { 'X-API-Key': 'pd_a_users_own_key' } });
    expect(other.carried).toEqual(['pd_a_users_own_key']);
  });
});
