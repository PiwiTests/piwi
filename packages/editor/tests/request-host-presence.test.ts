/**
 * The presence a request host keeps with an instance, against a fake clock: the app is listed every minute while its
 * stream is open, an offer the instance withdraws is dropped, and an offer past its time is dropped by the list,
 * claimed or not. The desktop app and Piwi Runner both keep it with this host.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunRequestOffer } from '@piwitests/core/run-request';
import { RequestHost } from '../src/request-host';

const KEY = `pd_${'a'.repeat(64)}`;
const MINUTE = 60_000;
const id = (n: number) => n.toString(16).padStart(32, '0');

function offer(n: number, expiresInMs: number): RunRequestOffer {
  return {
    id: id(n),
    kind: 'run',
    projectId: 1,
    tests: [{ filePath: 'tests/checkout.spec.ts', title: 'pays with a saved card', line: 12, projectName: 'chromium' }],
    options: { headed: true },
    source: { runId: 7, branch: 'main', commit: 'a'.repeat(40) },
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

/** A fake instance behind `fetch`: its stream stays open and says what `say` is given, its list answers `listed`. */
function fakeInstance() {
  const encoder = new TextEncoder();
  const calls: string[] = [];
  const listed: RunRequestOffer[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const route = new URL(url).pathname;
    calls.push(route);
    if (route === '/api/run-targets/stream') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          init.signal?.addEventListener('abort', () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ requests: listed, stops: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    listed,
    lists: () => calls.filter((route) => route === '/api/run-targets/requests').length,
    say: (event: unknown) => stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    /** The comment the instance sends every 15 s, which keeps the stream from counting as silent. */
    heartbeat: () => stream?.enqueue(encoder.encode(': heartbeat\n\n')),
  };
}

/** Moves the clock `ms` forward in 15-second steps, the instance's heartbeat between them. */
async function pass(instance: ReturnType<typeof fakeInstance>, ms: number) {
  for (let left = ms; left > 0; left -= 15_000) {
    await vi.advanceTimersByTimeAsync(Math.min(15_000, left));
    instance.heartbeat();
  }
}

function requestHost(instance: ReturnType<typeof fakeInstance>) {
  const heard: string[] = [];
  const host = new RequestHost({
    instance: 'http://instance.test',
    key: KEY,
    describe: () => ({ platform: 'macOS', version: '0.67.0', projectIds: [1] }),
    onOffer: (o) => heard.push(`offer ${o.id}`),
    onWithdrawn: (i) => heard.push(`withdrawn ${i}`),
    onStop: (i) => heard.push(`stop ${i}`),
    fetch: instance.fetchImpl as never,
  });
  host.start();
  return { host, heard };
}

let open: RequestHost | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  open?.close();
  open = null;
  vi.useRealTimers();
});

describe('the presence of a request host on an instance', () => {
  test('lists the requests as the stream opens, then every minute while it stays open', async () => {
    const instance = fakeInstance();
    const { host } = requestHost(instance);
    open = host;
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.lists()).toBe(1);
    await pass(instance, MINUTE - 15_000);
    expect(instance.lists()).toBe(1);
    await pass(instance, 15_000);
    expect(instance.lists()).toBe(2);
    await pass(instance, 3 * MINUTE);
    expect(instance.lists()).toBe(5);
  });

  test('drops an offer the instance withdraws', async () => {
    const instance = fakeInstance();
    const { host, heard } = requestHost(instance);
    open = host;
    await vi.advanceTimersByTimeAsync(0);
    instance.say({ type: 'request', request: offer(1, 10 * MINUTE) });
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([`offer ${id(1)}`]);
    instance.say({ type: 'withdrawn', id: id(1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([`offer ${id(1)}`, `withdrawn ${id(1)}`]);
  });

  test('drops an offer past its time at the next list, though the instance still lists it', async () => {
    const instance = fakeInstance();
    const { host, heard } = requestHost(instance);
    open = host;
    await vi.advanceTimersByTimeAsync(0);
    const waiting = offer(2, 90_000);
    instance.listed.push(waiting);
    instance.say({ type: 'request', request: waiting });
    await vi.advanceTimersByTimeAsync(0);
    await pass(instance, MINUTE);
    expect(heard).toEqual([`offer ${id(2)}`]);
    await pass(instance, MINUTE);
    expect(heard).toEqual([`offer ${id(2)}`, `withdrawn ${id(2)}`]);
  });
});
