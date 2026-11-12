import { describe, expect, test } from 'vitest';
import type { PiwiClient } from '../src/piwi-client';
import { EventParser, EventStream, RunStreams, type OpenEvents, type RunEvent } from '../src/run-stream';

const encoder = new TextEncoder();

/** A response whose body is these chunks, then the end of the stream unless `open` keeps it open. */
function body(chunks: string[], open = false): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!open) controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function waitFor<T>(read: () => T | undefined, ms = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the event parser', () => {
  test('joins an event split across chunks, CRLF included, and skips comments', () => {
    const parser = new EventParser();
    const events = [
      'data: {"type":"run-st',
      'arted","runId":1}\r',
      '\n\r\n: heartbeat\n\n',
      'id: 3\ndata: {"a":\n',
      'data:1}\n',
      '\n',
      'event: other\n\n',
    ].flatMap((chunk) => parser.push(chunk));
    expect(events).toEqual(['{"type":"run-started","runId":1}', '{"a":\n1}']);
  });
});

describe('an event stream', () => {
  test('reads events split across chunks, and none of the heartbeats', async () => {
    const received: unknown[] = [];
    const states: boolean[] = [];
    const stream = new EventStream(
      async () =>
        body(
          [
            ': heartbeat\n\n',
            'data: {"type":"run-started","ru',
            'nId":12,"projectId":7}\n',
            '\n: heartbeat\n\ndata: not json\n\ndata: {"type":"run-finished","runId":12,"projectId":7}\n\n',
          ],
          true,
        ),
      (data) => received.push(data),
      (connected) => states.push(connected),
    );
    try {
      await waitFor(() => (received.length === 2 ? true : undefined));
      expect(received).toEqual([
        { type: 'run-started', runId: 12, projectId: 7 },
        { type: 'run-finished', runId: 12, projectId: 7 },
      ]);
      expect(stream.connected).toBe(true);
      expect(states).toEqual([true]);
    } finally {
      stream.close();
    }
  });

  test('connects again after a drop, waiting twice as long after each failure until it connects', async () => {
    const attempts: number[] = [];
    const states: boolean[] = [];
    const open: OpenEvents = async () => {
      attempts.push(Date.now());
      // Three failed attempts, a connection that brings a heartbeat then drops, then failures again.
      if (attempts.length === 4) return body([': heartbeat\n\n']);
      throw new Error('connection refused');
    };
    const stream = new EventStream(
      open,
      () => {},
      (connected) => states.push(connected),
      {
        retryMs: 20,
        maxRetryMs: 80,
      },
    );
    try {
      await waitFor(() => (attempts.length >= 7 ? true : undefined));
      const waits = attempts.slice(1, 7).map((at, i) => at - attempts[i]!);
      // 20, 40 and 80 ms after the failures; 20 ms after the drop of a connection; then 40 and 80 again.
      for (const [i, least] of [20, 40, 80, 20, 40, 80].entries()) expect(waits[i]).toBeGreaterThanOrEqual(least - 2);
      expect(waits[3]).toBeLessThan(waits[2]!);
      expect(states).toEqual([true, false]);
    } finally {
      stream.close();
    }
  });

  test('stops after a 401 until it is asked to try again, and waits longer after a 404', async () => {
    let refuse = true;
    let attempts = 0;
    const stream = new EventStream(
      async () => {
        attempts++;
        return new Response('{}', { status: refuse ? 401 : 404 });
      },
      () => {},
      undefined,
      { retryMs: 5, notFoundRetryMs: 60_000 },
    );
    try {
      await waitFor(() => (stream.refused ? true : undefined));
      await new Promise((r) => setTimeout(r, 50));
      expect(attempts).toBe(1);
      refuse = false;
      stream.retry();
      await waitFor(() => (attempts === 2 ? true : undefined));
      await new Promise((r) => setTimeout(r, 50));
      expect(stream.refused).toBe(false);
      expect(attempts).toBe(2);
    } finally {
      stream.close();
    }
  });
});

describe('the runs’ streams', () => {
  /** A client whose run streams each send `init` with the number of the connection, then stay open until aborted. */
  function stubClient(serverUrl = 'https://piwi.example') {
    const opened: number[] = [];
    const aborted: number[] = [];
    const client = {
      connection: { serverUrl, apiKey: 'pd_key' },
      runEvents: async (runId: number, signal: AbortSignal) => {
        opened.push(runId);
        const n = opened.length;
        signal.addEventListener('abort', () => aborted.push(n));
        return body([`data: ${JSON.stringify({ type: 'init', data: { connection: n } })}\n\n`], true);
      },
    } as unknown as PiwiClient;
    return { client, opened, aborted };
  }

  test('read one run on one connection, which a follower that joins opens again for its catch-up', async () => {
    const { client, opened, aborted } = stubClient();
    const streams = new RunStreams({ retryMs: 5 });
    const first: RunEvent[] = [];
    const second: RunEvent[] = [];
    const stopFirst = streams.follow(client, 78, (e) => first.push(e));
    await waitFor(() => (first.length ? true : undefined));
    expect(first).toEqual([{ type: 'init', data: { connection: 1 } }]);

    const stopSecond = streams.follow(client, 78, (e) => second.push(e));
    // The first connection ends, and the new one's catch-up reaches both followers.
    await waitFor(() => (second.length ? true : undefined));
    expect(aborted).toEqual([1]);
    expect(second).toEqual([{ type: 'init', data: { connection: 2 } }]);
    expect(first[first.length - 1]).toEqual({ type: 'init', data: { connection: 2 } });
    expect(opened).toEqual([78, 78]);
    expect(streams.size).toBe(1);

    // The stream closes with its last follower, never before.
    stopFirst();
    stopFirst();
    expect(streams.size).toBe(1);
    stopSecond();
    expect(streams.size).toBe(0);
    await waitFor(() => (aborted.length === 2 ? true : undefined));
    streams.dispose();
  });

  test('keep the runs of another instance or another run apart', async () => {
    const one = stubClient('https://one.example');
    const other = stubClient('https://other.example');
    const streams = new RunStreams({ retryMs: 5 });
    const stops = [
      streams.follow(one.client, 78, () => {}),
      streams.follow(one.client, 79, () => {}),
      streams.follow(other.client, 78, () => {}),
    ];
    await waitFor(() => (one.opened.length === 2 && other.opened.length === 1 ? true : undefined));
    expect(streams.size).toBe(3);
    for (const stop of stops) stop();
    expect(streams.size).toBe(0);
    streams.dispose();
  });
});
