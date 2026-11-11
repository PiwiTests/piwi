import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { HubSession, LiveHub } from '@piwitests/core/run-hub';
import { EditorRuns } from '../../server/utils/desktop-editor-runs';

/**
 * The desktop server observing the editors' runs (`EditorRuns`), against a fake editor hub on this machine: it connects
 * with no `Origin`, says hello with the hub's token, subscribes to observe, and keeps the runs the hub tells until they
 * end or the hub leaves the discovery folder. A hub that refuses the connection, as an editor service that predates it
 * does, is not asked again while it is listed.
 */

const TOKEN = 'editor-hub-token-0123456789';

function session(ref: string, ended = false): HubSession {
  return {
    ref,
    root: '/home/dev/shop',
    label: 'shop',
    command: null,
    project: 'Shop',
    ended,
    workers: [
      {
        worker: 0,
        parallelIndex: 0,
        state: 'stopped',
        test: null,
        stop: {
          reason: 'breakpoint',
          title: 'Click',
          uri: 'file:///home/dev/shop/tests/checkout.spec.ts',
          line: 4,
          character: 2,
          locator: null,
          bar: false,
          since: 's1',
          intents: [],
        },
        pausing: false,
        intents: [],
      },
    ],
  };
}

interface FakeHub {
  live: LiveHub;
  origins: Array<string | undefined>;
  heard: Array<Record<string, unknown>>;
  /** Tell the observer a run changed. */
  tell(session: HubSession): void;
  close(): Promise<void>;
}

const opened: FakeHub[] = [];

async function fakeHub(refuse = false): Promise<FakeHub> {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const origins: Array<string | undefined> = [];
  const heard: Array<Record<string, unknown>> = [];
  const sockets = new Set<import('ws').WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    origins.push(req.headers.origin);
    if (refuse) return void socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        heard.push(message);
        if (message.type === 'hello' && message.token === TOKEN) {
          ws.send(
            JSON.stringify({
              type: 'welcome',
              pid: 41,
              version: '0.69.0',
              client: 'Visual Studio Code',
              roots: ['/home/dev/shop'],
              keepaliveMs: 30_000,
              features: [],
            }),
          );
        }
        if (message.type === 'subscribe') {
          ws.send(JSON.stringify({ type: 'answer', id: message.id, ok: true, message: 'Following 1 run.' }));
          ws.send(JSON.stringify({ type: 'session', session: session('ed-1') }));
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const hub: FakeHub = {
    live: {
      url: `ws://127.0.0.1:${port}/piwi/hub`,
      token: TOKEN,
      pid: 41,
      version: '0.69.0',
      client: 'Visual Studio Code',
      roots: ['/home/dev/shop'],
      startedAt: new Date().toISOString(),
    },
    origins,
    heard,
    tell: (changed) => {
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'session', session: changed }));
    },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  opened.push(hub);
  return hub;
}

async function waitFor<T>(read: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let follower: EditorRuns | null = null;

afterEach(async () => {
  follower?.close();
  follower = null;
  for (const hub of opened.splice(0)) await hub.close();
});

describe('the editors’ runs the desktop server observes', () => {
  it('connects with no Origin, says hello with the hub’s token, observes, and keeps the runs until they end', async () => {
    const hub = await fakeHub();
    let live: LiveHub[] = [hub.live];
    let changes = 0;
    follower = new EditorRuns({ live: () => live, changed: () => changes++, readMs: 20 });
    follower.start();
    const [run] = await waitFor(() => (follower!.runs().length ? follower!.runs() : undefined));
    expect(run).toMatchObject({ client: 'Visual Studio Code', session: { ref: 'ed-1' } });
    expect(hub.origins).toEqual([undefined]);
    expect(hub.heard).toEqual([
      { type: 'hello', token: TOKEN },
      { type: 'subscribe', id: 1, observe: true },
    ]);
    expect(changes).toBeGreaterThan(0);
    // The run ends: it is let go.
    hub.tell(session('ed-1', true));
    await waitFor(() => follower!.runs().length === 0);
    // A new one, then the hub leaves the folder: its runs go with it.
    hub.tell(session('ed-2'));
    await waitFor(() => follower!.runs().length === 1);
    live = [];
    await waitFor(() => follower!.runs().length === 0);
  });

  it('asks a hub that refused the connection no more while it is listed', async () => {
    const hub = await fakeHub(true);
    follower = new EditorRuns({ live: () => [hub.live], changed: () => {}, readMs: 20 });
    follower.start();
    await waitFor(() => hub.origins.length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(hub.origins).toHaveLength(1);
    expect(follower.runs()).toEqual([]);
  });
});
