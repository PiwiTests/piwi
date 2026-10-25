import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { formatEditorDiscovery, type EditorDiscovery } from '@piwitests/core/editor-discovery';
import type { EditorSendPayload } from '@piwitests/core/editor-send';
import { liveUrlOf } from '@piwitests/core/run-hub';
import { readLiveHubs } from '@piwitests/editor/discovery';
import { startSendListener, type SendListener } from '../src/send-listener';

const TOKEN = 'abcdefghijklmnop_1234';
const received: EditorSendPayload[] = [];
let listener: SendListener;
/** The discovery files the listener reads, as the editor services of two windows and one killed write them. */
let editors = '';
const dead = spawnSync(process.execPath, ['-e', '']).pid;

const discovery = (pid: number, port: number): EditorDiscovery => ({
  pid,
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
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
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
        const { hub, runChannel: _, recorderBundle: __, ...service } = discovery(pid, 43121 + i);
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
