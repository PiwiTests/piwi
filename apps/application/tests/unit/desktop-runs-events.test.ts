/**
 * The desktop window's stream of its runs (`GET /api/desktop/runs/events`), on a real socket: what the window has not
 * read yet is what the stream tells the hub it holds unsent, so a window that stops reading gets no frame past 1 MB and
 * is cut past 32 MB, as a WebSocket of the hub is. The hub's side of it is `desktop-runs.test.ts`.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopRunEvent } from '#shared/desktop-runs';
import type { DesktopRunSink } from '../../server/utils/desktop-runs';

/** The hub's side, as the route reaches it: the windows it opened, each with how often it was let go, or none. */
const hub = {
  refuse: false,
  windows: [] as Array<{ sink: DesktopRunSink; closed: number }>,
};

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({}) }));
vi.mock('../../server/utils/desktop-runs', () => ({
  desktopRuns: async () => ({
    openWindow: async (sink: DesktopRunSink) => {
      if (hub.refuse) return null;
      const window = { sink, closed: 0 };
      hub.windows.push(window);
      sink.send({ type: 'hello', viewer: 'a'.repeat(32) } satisfies DesktopRunEvent);
      return { viewer: 'a'.repeat(32), close: () => void window.closed++ };
    },
  }),
}));

let server: http.Server;
let base = '';

async function waitFor<T>(read: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  vi.stubEnv('PIWI_DESKTOP_TOKEN', 'pd_token');
  vi.stubGlobal('defineRouteMeta', () => {});
  vi.stubGlobal('eventHandler', (handler: unknown) => handler);
  const route = (await import('../../server/api/desktop/runs/events.get')).default as unknown as (
    event: unknown,
  ) => Promise<void>;
  server = http.createServer((req, res) => {
    route({ node: { req, res } }).catch((error: { statusCode?: number }) => {
      res.statusCode = error.statusCode ?? 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  hub.refuse = false;
  hub.windows.length = 0;
});

/** A window's stream: what it read, and its response, to stop and start reading. */
function open(): Promise<{ res: http.IncomingMessage; read: () => string; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/api/desktop/runs/events`, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        const closed = new Promise<void>((done) => res.on('close', () => done()));
        resolve({ res, read: () => text, closed });
      })
      .on('error', reject);
  });
}

/** An event of about 64 KB, as a frame of a live view is. */
const BIG = { type: 'notice', root: null, severity: 'information', message: 'x'.repeat(64 * 1024) } as const;

/** Sends big events while the window does not read, until the stream holds more than `bytes` unsent. */
function fill(sink: DesktopRunSink, bytes: number): number {
  for (let sent = 0; sent < 1024 && sink.buffered() <= bytes; sent++) sink.send(BIG);
  return sink.buffered();
}

describe('the window’s stream of its runs', () => {
  it('is an event stream that starts with the hello the hub sends', async () => {
    const window = await open();
    expect(window.res.statusCode).toBe(200);
    expect(window.res.headers['content-type']).toBe('text/event-stream');
    await waitFor(() => window.read().includes(`data: {"type":"hello","viewer":"${'a'.repeat(32)}"}\n\n`));
    window.res.destroy();
    await waitFor(() => hub.windows[0]?.closed === 1);
  });

  it('tells the hub what the window has not read, so a frame waits past 1 MB, and none once it reads again', async () => {
    const window = await open();
    const opened = await waitFor(() => hub.windows[0]);
    const sink = opened.sink;
    await waitFor(() => window.read().includes('hello'));
    window.res.pause();
    expect(fill(sink, 1024 * 1024)).toBeGreaterThan(1024 * 1024);
    // Read again: what it holds unsent drains.
    window.res.resume();
    await waitFor(() => (sink.buffered() === 0 ? true : undefined), 10_000);
    window.res.destroy();
    await window.closed;
    // The window left: its peer of the hub leaves with it.
    await waitFor(() => opened.closed === 1);
  });

  it('is cut when the hub lets a window go that left its stream unread', async () => {
    const window = await open();
    const opened = await waitFor(() => hub.windows[0]);
    const sink = opened.sink;
    await waitFor(() => window.read().includes('hello'));
    window.res.pause();
    fill(sink, 1024 * 1024);
    sink.close();
    await window.closed;
    expect(window.res.complete).toBe(false);
    // Nothing is written to a stream that was cut.
    sink.send(BIG);
    expect(sink.buffered()).toBe(0);
    expect(opened.closed).toBe(1);
  });

  it('ends a stream the window read whole when the hub closes it', async () => {
    const window = await open();
    const opened = await waitFor(() => hub.windows[0]);
    const sink = opened.sink;
    await waitFor(() => window.read().includes('hello'));
    await waitFor(() => (sink.buffered() === 0 ? true : undefined));
    sink.close();
    await window.closed;
    expect(window.res.complete).toBe(true);
  });

  it('is refused while the hub takes no window', async () => {
    hub.refuse = true;
    const window = await open();
    expect(window.res.statusCode).toBe(503);
    window.res.destroy();
  });
});
