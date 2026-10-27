import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { formatEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  newEditorChallenge,
  type EditorSendPayload,
} from '@piwitests/core/editor-send';
import { liveUrlOf } from '@piwitests/core/run-hub';
import { readLiveHubs } from '@piwitests/editor/discovery';
import {
  liveHubsHere,
  loopbackPort,
  sendPairing,
  startSendListener,
  type PairingStore,
  type SendListener,
} from '../src/send-listener';

const TOKEN = 'abcdefghijklmnop_1234';
const received: EditorSendPayload[] = [];
let listener: SendListener;
/** The discovery files the listener reads, as the editor services of two windows and one killed write them. */
let editors = '';
const dead = spawnSync(process.execPath, ['-e', '']).pid;

const discovery = (pid: number, port: number): EditorDiscovery => ({
  pid,
  host: os.hostname(),
  version: '0.60.0',
  client: 'Visual Studio Code',
  startedAt: `2026-10-25T10:00:0${port % 10}.000Z`,
  roots: [`/work/shop-${port}`],
  hub: { url: `ws://127.0.0.1:${port}/piwi/hub`, token: `hub-token-${port}-0123456789` },
  runChannel: { path: `/tmp/piwi-record-${port}/channel.sock`, token: 'channel-token-0123456789' },
  recorderBundle: null,
});

beforeAll(async () => {
  editors = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-editors-'));
  fs.writeFileSync(path.join(editors, `${process.pid}.json`), formatEditorDiscovery(discovery(process.pid, 43121)));
  fs.writeFileSync(path.join(editors, `${process.ppid}.json`), formatEditorDiscovery(discovery(process.ppid, 43122)));
  fs.writeFileSync(path.join(editors, `${dead}.json`), formatEditorDiscovery(discovery(dead, 43123)));
  listener = await startSendListener({
    port: 0,
    token: () => TOKEN,
    onPayload: async (payload) => {
      received.push(payload);
      return { inserted: true, file: '/w/tests/a.spec.ts' };
    },
    live: () => readLiveHubs(editors),
  });
});

afterAll(async () => {
  await listener.close();
  fs.rmSync(editors, { recursive: true, force: true });
});

const send = (body: unknown, token = TOKEN, origin = 'chrome-extension://abc') =>
  fetch(listener.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: origin },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the send listener', () => {
  test('listens on the loopback interface', () => {
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/piwi\/send$/);
  });

  test('hands a paired request’s payload to the extension', async () => {
    const res = await send({ kind: 'locator', text: "page.getByRole('button', { name: 'Pay' })" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: true, file: '/w/tests/a.spec.ts' });
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://abc');
    expect(received).toEqual([{ kind: 'locator', text: "page.getByRole('button', { name: 'Pay' })" }]);
  });

  test('hands over the line a locator picked at a breakpoint belongs to', async () => {
    const at = { file: 'tests/login.spec.ts', line: 42 };
    expect((await send({ kind: 'locator', text: "getByRole('button')", at })).status).toBe(200);
    expect(received[received.length - 1]).toEqual({ kind: 'locator', text: "getByRole('button')", at });
    expect(
      (await send({ kind: 'locator', text: "getByRole('button')", at: { file: '../x.ts', line: 1 } })).status,
    ).toBe(400);
    received.pop();
  });

  test('refuses a wrong token, a bad body and another path', async () => {
    expect((await send({ kind: 'locator', text: 'x' }, 'wrong-token-wrong-token')).status).toBe(401);
    expect((await send('{')).status).toBe(400);
    expect((await send({ kind: 'file' })).status).toBe(400);
    expect((await fetch(listener.url.replace('/piwi/send', '/other'), { method: 'POST' })).status).toBe(404);
    expect(received).toHaveLength(1);
  });

  test('answers the preflight, and never names a web page as an allowed origin', async () => {
    const res = await fetch(listener.url, { method: 'OPTIONS', headers: { Origin: 'moz-extension://x' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type, x-piwi-editor-challenge',
    );
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-expose-headers')).toBe('x-piwi-editor-proof');
    const page = await fetch(listener.url, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('lists the live hubs of every editor service with the pairing’s token, and none of the run channels', async () => {
    const live = liveUrlOf(listener.url)!;
    expect(live).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/piwi\/live$/);
    const res = await fetch(live, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'chrome-extension://abc' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://abc');
    const body = (await res.json()) as { hubs: Array<{ pid: number }> };
    expect(body).toEqual({
      hubs: [process.pid, process.ppid].map((pid, i) => {
        const { hub, runChannel: _, recorderBundle: __, host: ___, ...service } = discovery(pid, 43121 + i);
        return { ...hub, ...service };
      }),
    });
    expect(JSON.stringify(body)).not.toContain('channel-token');
    // A killed service's file was skipped, and deleted.
    expect(fs.existsSync(path.join(editors, `${dead}.json`))).toBe(false);
  });

  test('refuses the live hubs without the pairing’s token, and names no web page as an allowed origin', async () => {
    const live = liveUrlOf(listener.url)!;
    expect((await fetch(live)).status).toBe(401);
    const wrong = await fetch(live, { headers: { Authorization: 'Bearer wrong-token-wrong-token' } });
    expect(wrong.status).toBe(401);
    const page = await fetch(live, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.test' } });
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(live, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(listener.url, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  test('proves it holds the token on every answer to a challenge, paired or not, for the port it answers on', async () => {
    const live = liveUrlOf(listener.url)!;
    const expected = (challenge: string) => editorTokenProof(TOKEN, listener.port, challenge);
    const asked = async (url: string, init: RequestInit = {}) => {
      const challenge = newEditorChallenge();
      const res = await fetch(url, {
        ...init,
        headers: { Origin: 'chrome-extension://abc', ...init.headers, [EDITOR_CHALLENGE_HEADER]: challenge },
      });
      expect(res.headers.get(EDITOR_PROOF_HEADER), `${init.method ?? 'GET'} ${url}`).toBe(await expected(challenge));
      return res.status;
    };
    expect(await asked(live)).toBe(401);
    expect(await asked(live, { headers: { Authorization: `Bearer ${TOKEN}` } })).toBe(200);
    expect(await asked(listener.url, { method: 'POST', body: '{}' })).toBe(401);
    expect(await asked(listener.url, { method: 'OPTIONS' })).toBe(204);
    expect(await asked(listener.url.replace('/piwi/send', '/other'))).toBe(404);
    expect(
      await asked(listener.url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{' }),
    ).toBe(400);
    // No challenge, or one that is not hex of the length a challenge has: no proof.
    for (const challenge of [undefined, 'ab', 'Z'.repeat(64), 'a'.repeat(129)]) {
      const res = await fetch(live, { headers: challenge ? { [EDITOR_CHALLENGE_HEADER]: challenge } : {} });
      expect(res.headers.get(EDITOR_PROOF_HEADER), String(challenge)).toBeNull();
    }
    expect(received).toHaveLength(1);
  });

  test('answers only a request naming it as this machine at its port', async () => {
    const asHost = (host: string) =>
      new Promise<{ status: number; proof: string | undefined }>((resolve, reject) => {
        const challenge = 'ab'.repeat(32);
        const req = http.request(liveUrlOf(listener.url)!, {
          headers: { Host: host, Authorization: `Bearer ${TOKEN}`, [EDITOR_CHALLENGE_HEADER]: challenge },
        });
        req.on('response', (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, proof: res.headers[EDITOR_PROOF_HEADER] as string | undefined });
        });
        req.on('error', reject);
        req.end();
      });
    expect((await asHost(`localhost:${listener.port}`)).status).toBe(200);
    for (const host of [`evil.test:${listener.port}`, `127.0.0.1:${listener.port + 1}`, '127.0.0.1']) {
      const refused = await asHost(host);
      expect(refused.status, host).toBe(403);
      expect(refused.proof).toBe(await editorTokenProof(TOKEN, listener.port, 'ab'.repeat(32)));
    }
  });

  test('takes the port a remote window forwards to it, proving the token for that port', async () => {
    const forwarded = [55_017];
    const remote = await startSendListener({
      port: 0,
      token: () => TOKEN,
      onPayload: async () => ({ inserted: true, file: null }),
      live: () => [],
      forwarded: () => forwarded,
    });
    try {
      const challenge = 'cd'.repeat(32);
      const asHost = (host: string) =>
        new Promise<{ status: number; proof: string | undefined }>((resolve, reject) => {
          // As VS Code's tunnel hands it over: the browser named the local end of the forward.
          const req = http.request(liveUrlOf(remote.url)!, {
            headers: { Host: host, Authorization: `Bearer ${TOKEN}`, [EDITOR_CHALLENGE_HEADER]: challenge },
          });
          req.on('response', (res) => {
            res.resume();
            resolve({ status: res.statusCode ?? 0, proof: res.headers[EDITOR_PROOF_HEADER] as string | undefined });
          });
          req.on('error', reject);
          req.end();
        });
      const through = await asHost('127.0.0.1:55017');
      expect(through.status).toBe(200);
      expect(through.proof).toBe(await editorTokenProof(TOKEN, 55_017, challenge));
      expect((await asHost('localhost:55017')).status).toBe(200);
      const own = await asHost(`127.0.0.1:${remote.port}`);
      expect(own.proof).toBe(await editorTokenProof(TOKEN, remote.port, challenge));
      // Another port, or another name at the forwarded one, is refused, with the proof of the port reached.
      for (const host of ['127.0.0.1:55018', 'evil.test:55017']) {
        const refused = await asHost(host);
        expect(refused.status, host).toBe(403);
        expect(refused.proof, host).toBe(await editorTokenProof(TOKEN, remote.port, challenge));
      }
      // A forward forgotten is refused again.
      forwarded.length = 0;
      expect((await asHost('127.0.0.1:55017')).status).toBe(403);
    } finally {
      await remote.close();
    }
  });

  test('a taken port is refused rather than replaced', async () => {
    await expect(
      startSendListener({
        port: listener.port,
        token: () => TOKEN,
        onPayload: async () => ({ inserted: false, file: null }),
        live: () => [],
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});

describe('the window’s pairing', () => {
  /** A pairing kept in memory, with the ports it saved, and the listeners it started. */
  function harness(port: number | undefined) {
    const saved: number[] = [];
    const listeners: SendListener[] = [];
    let running: SendListener | null = null;
    const store: PairingStore = {
      token: '',
      port,
      saveToken: async () => {},
      savePort: async (p) => void saved.push(p),
    };
    const pairing = sendPairing({
      store,
      listener: () => running,
      listen: async (p) => {
        running = await startSendListener({
          port: p,
          token: () => store.token,
          onPayload: async () => ({ inserted: false, file: null }),
          live: () => [],
        });
        listeners.push(running);
        return running;
      },
      mint: () => 'minted-token-0123456789',
    });
    return { store, saved, pairing, close: () => Promise.all(listeners.map((l) => l.close())) };
  }

  test('keeps the port Piwi Picker was given when a run’s pairing needs another', async () => {
    // Another window holds the port Piwi Picker was given.
    const other = http.createServer();
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const taken = (other.address() as AddressInfo).port;
    const { store, saved, pairing, close } = harness(taken);
    try {
      const run = await pairing(false);
      expect(run.token).toBe('minted-token-0123456789');
      expect(new URL(run.url).port).not.toBe(String(taken));
      expect(store.port).toBe(taken);
      expect(saved).toEqual([]);
      // Pair with Piwi Picker, asked in this window: its pairing is this listener's, saved for the next start.
      const paired = await pairing(true);
      expect(paired.url).toBe(run.url);
      expect(saved).toEqual([Number(new URL(run.url).port)]);
    } finally {
      await close();
      await new Promise((resolve) => other.close(resolve));
    }
  });

  test('takes the saved port when it is free, and saves it once', async () => {
    const free = http.createServer();
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
    const port = (free.address() as AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    const { saved, pairing, close } = harness(port);
    try {
      expect(new URL((await pairing(false)).url).port).toBe(String(port));
      await pairing(true);
      expect(saved).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('the live hubs of a window', () => {
  const hubAt = (port: number, pid: number) => ({
    url: `ws://127.0.0.1:${port}/piwi/hub`,
    token: `hub-token-${port}-0123456789`,
    pid,
    version: '0.61.0',
    client: 'Visual Studio Code',
    roots: [`/work/shop-${port}`],
    startedAt: '2026-10-27T10:00:00.000Z',
  });
  const own = hubAt(43_200, 11);
  const other = hubAt(43_201, 12);

  /** A remote window's side, VS Code's forwarding mocked: what it asked, and the ports its service was given. */
  function remote(forwardTo: (address: string) => string, ownUrl: string | null = own.url) {
    const asked: string[] = [];
    const forwarded: number[] = [];
    return {
      asked,
      forwarded,
      hub: {
        own: async () => ownUrl,
        external: async (address: string) => {
          asked.push(address);
          return forwardTo(address);
        },
        forward: async (port: number) => void forwarded.push(port),
      },
    };
  }

  test('lists every service’s hub in a local window, forwarding none', async () => {
    const side = remote(() => 'http://127.0.0.1:1/');
    expect(await liveHubsHere(undefined, () => [own, other], side.hub)).toEqual([own, other]);
    expect(side.asked).toEqual([]);
  });

  test('lists a remote window’s own hub at the local port VS Code forwards, once its service takes it', async () => {
    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'codespaces']) {
      const side = remote((address) => address.replace(':43200/', ':55002/'));
      const hubs = await liveHubsHere(remoteName, () => [own, other], side.hub);
      expect(hubs, remoteName).toEqual([{ ...own, url: 'ws://127.0.0.1:55002/piwi/hub' }]);
      expect(side.asked).toEqual(['http://127.0.0.1:43200/piwi/hub']);
      expect(side.forwarded).toEqual([55_002]);
    }
    // The same port when it was free on the browser's machine, as `localhost` when VS Code names it so.
    const same = remote((address) => address.replace('127.0.0.1', 'localhost'));
    expect((await liveHubsHere('ssh-remote', () => [own], same.hub))[0]?.url).toBe('ws://localhost:43200/piwi/hub');
  });

  test('lists none in a remote window whose forward is not a loopback address, or whose service has no hub', async () => {
    // Codespaces in the browser forwards to GitHub's `https` address.
    const web = remote(() => 'https://shop-43200.app.github.dev/piwi/hub');
    expect(await liveHubsHere('codespaces', () => [own], web.hub)).toEqual([]);
    expect(web.forwarded).toEqual([]);
    expect(await liveHubsHere('ssh-remote', () => [own], remote(() => 'http://10.0.0.5:55002/').hub)).toEqual([]);
    expect(await liveHubsHere('ssh-remote', () => [other], remote((a) => a).hub)).toEqual([]);
    expect(await liveHubsHere('ssh-remote', () => [own], remote((a) => a, null).hub)).toEqual([]);
  });

  test('reads the port of a loopback http address alone', () => {
    expect(loopbackPort('http://127.0.0.1:55002/piwi/send')).toBe(55_002);
    expect(loopbackPort('http://localhost:55002/')).toBe(55_002);
    for (const address of [
      'https://127.0.0.1:55002/',
      'http://127.0.0.1/',
      'http://10.0.0.5:1/',
      'ws://127.0.0.1:1/',
      'nope',
    ]) {
      expect(loopbackPort(address), address).toBeNull();
    }
  });
});
