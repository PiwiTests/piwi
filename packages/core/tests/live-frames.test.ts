import { describe, expect, test, vi } from 'vitest';
import {
  LIVE_FRAME_FPS,
  LIVE_HEARTBEAT,
  LIVE_TILE_FPS,
  LIVE_TILE_HEIGHT,
  LIVE_TILE_WIDTH,
  MAX_LIVE_FRAME,
  MAX_LIVE_HEADER,
  MAX_LIVE_VIEW_HEIGHT,
  MAX_LIVE_VIEW_WIDTH,
  createLiveMessageReader,
  decodeLiveMessage,
  encodeLiveMessage,
  encodeLiveViewerMessage,
  liveFrameHeader,
  parseInstanceToWorker,
  readLiveViewSize,
  readLiveViewerMessage,
  readLiveWorkerFrame,
  readWorkerToInstance,
  type LiveMessage,
  type LiveViewerMessage,
} from '../src/live-view';
import { MAX_LANE_TEXT, type LaneText } from '../src/live-layers';

/** A JPEG's first bytes, then filler: what a reader checks of an image. */
function jpeg(length: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

const LIMITS = { maxData: MAX_LIVE_FRAME };
const WHOLE = 'The body holds one live message, whole.';

/** Every message a reader completes as `bytes` arrive in chunks of `size` bytes. */
function readInChunks(bytes: Uint8Array, size: number): LiveMessage[] {
  const read = createLiveMessageReader(LIMITS);
  const messages: LiveMessage[] = [];
  for (let at = 0; at < bytes.length; at += size) messages.push(...read(bytes.subarray(at, at + size)));
  return messages;
}

function joined(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

describe('a live message', () => {
  test('goes and comes back whole: its header, and its data or none', () => {
    const image = jpeg(5000);
    const bytes = encodeLiveMessage({ type: 'frame', test: 'pays – “é”' }, image);
    const json = new TextEncoder().encode('{"type":"frame","test":"pays – “é”"}');
    expect(new DataView(bytes.buffer).getUint32(0)).toBe(json.length);
    expect(decodeLiveMessage(bytes, LIMITS)).toEqual({ header: { type: 'frame', test: 'pays – “é”' }, data: image });
    expect(decodeLiveMessage(encodeLiveMessage({ type: 'ended' }), LIMITS)).toEqual({
      header: { type: 'ended' },
      data: null,
    });
  });

  test('is read across chunks of any size, heartbeats passed over', () => {
    const first = jpeg(20_000);
    const stream = joined(
      encodeLiveMessage({ type: 'hello', watch: 'w'.repeat(22) }),
      LIVE_HEARTBEAT,
      encodeLiveMessage({ type: 'frame', n: 1 }, first),
      LIVE_HEARTBEAT,
      encodeLiveMessage({ type: 'refused', n: 2 }),
    );
    for (const size of [1, 3, 7, 4096, 65_536, stream.length]) {
      const messages = readInChunks(stream, size);
      expect(
        messages.map((m) => m.header.type),
        `chunks of ${size}`,
      ).toEqual(['hello', 'frame', 'refused']);
      expect(messages[1]!.data).toEqual(first);
      expect(messages[2]!.data).toBeNull();
    }
  });

  test('holds a message that comes a byte at a time in one buffer, never a copy of each chunk', () => {
    const image = jpeg(MAX_LIVE_FRAME);
    const bytes = encodeLiveMessage({ type: 'frame', n: 1 }, image);
    const read = createLiveMessageReader(LIMITS);
    const slice = vi.spyOn(Uint8Array.prototype, 'slice');
    try {
      const messages: LiveMessage[] = [];
      for (let at = 0; at < bytes.length; at++) messages.push(...read(bytes.subarray(at, at + 1)));
      expect(messages.map((m) => m.data)).toEqual([image]);
      // The message's data alone is copied out.
      expect(slice.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      slice.mockRestore();
    }
    // Messages that come together, and one cut across two chunks, read the same.
    const stream = joined(bytes, encodeLiveMessage({ type: 'refused', n: 2 }), bytes);
    const again = createLiveMessageReader(LIMITS);
    const half = bytes.length + 100;
    expect([...again(stream.subarray(0, half)), ...again(stream.subarray(half))].map((m) => m.header.n)).toEqual([
      1, 2, 1,
    ]);
  });

  test('gives each message data of its own, which the next chunk leaves as it was', () => {
    const read = createLiveMessageReader(LIMITS);
    const chunk = encodeLiveMessage({ type: 'frame' }, jpeg(10));
    const [message] = read(chunk);
    chunk.fill(0);
    expect(message!.data).toEqual(jpeg(10));
  });

  test('is refused once its header or its data is longer than the bounds, before it arrives whole', () => {
    const big = encodeLiveMessage({ type: 'frame' }, jpeg(MAX_LIVE_FRAME + 1));
    const read = createLiveMessageReader(LIMITS);
    // The data's length alone, before the data: the reader refuses at once.
    expect(() => read(big.subarray(0, 40))).toThrow(`A live message’s data is ${MAX_LIVE_FRAME} bytes at most.`);
    // A broken stream stays broken.
    expect(() => read(encodeLiveMessage({ type: 'ended' }))).toThrow(/at most/);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_LIVE_HEADER + 1);
    expect(() => createLiveMessageReader(LIMITS)(header)).toThrow(`header is ${MAX_LIVE_HEADER} bytes at most`);
    expect(decodeLiveMessage(big, LIMITS)).toBe(`A live message’s data is ${MAX_LIVE_FRAME} bytes at most.`);
    expect(() => createLiveMessageReader({ maxData: 10 })(encodeLiveMessage({ a: 1 }, jpeg(11)))).toThrow();
  });

  test('is refused when its header is not a JSON object, or it has data and no header', () => {
    const text = new TextEncoder().encode('[1]');
    const array = joined(new Uint8Array([0, 0, 0, text.length]), text, new Uint8Array(4));
    expect(decodeLiveMessage(array, LIMITS)).toBe('A live message’s header is not a JSON object.');
    expect(() => createLiveMessageReader(LIMITS)(array)).toThrow('not a JSON object');
    const garbled = joined(new Uint8Array([0, 0, 0, 2]), new Uint8Array([0xc3, 0x28]), new Uint8Array(4));
    expect(decodeLiveMessage(garbled, LIMITS)).toBe('A live message’s header is not JSON.');
    const headless = joined(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), new Uint8Array([9]));
    expect(() => createLiveMessageReader(LIMITS)(headless)).toThrow('A live message with data has a header.');
  });

  test('is a whole body when a worker posts it: none cut short, none followed by more', () => {
    const one = encodeLiveMessage({ type: 'frame' }, jpeg(100));
    expect(decodeLiveMessage(one.subarray(0, one.length - 1), LIMITS)).toBe(WHOLE);
    expect(decodeLiveMessage(joined(one, LIVE_HEARTBEAT), LIMITS)).toBe(WHOLE);
    expect(decodeLiveMessage(LIVE_HEARTBEAT, LIMITS)).toBe(WHOLE);
    expect(decodeLiveMessage(new Uint8Array(3), LIMITS)).toBe(WHOLE);
  });
});

describe('a frame a worker posts as bytes', () => {
  const call = { title: "Click getByRole('button')", file: 'tests/a.spec.ts', line: 4 };

  test('names its worker, its call, its test and when the page looked so, its image the data', () => {
    const header = liveFrameHeader({ shard: 2, worker: 3, slot: 1 }, { call, test: 'pays', at: 1_760_000_000_000.4 });
    expect(readLiveWorkerFrame({ header, data: jpeg(300) })).toEqual({
      type: 'frame',
      shard: 2,
      worker: 3,
      slot: 1,
      image: jpeg(300),
      call,
      test: 'pays',
      at: 1_760_000_000_000,
    });
    // The text a fill typed is hidden, whatever the worker sent.
    const typed = readLiveWorkerFrame({
      header: liveFrameHeader({ shard: null, worker: 0 }, { call: { ...call, title: 'Fill "hunter2"' }, test: null }),
      data: jpeg(10),
    });
    expect(typed).toMatchObject({ test: null });
    expect(JSON.stringify(typed)).not.toContain('hunter2');
    expect(typed).not.toHaveProperty('at');
  });

  test('is refused without a JPEG within the bound, or a worker', () => {
    const header = liveFrameHeader({ shard: null, worker: 0 }, { call: null, test: null });
    expect(readLiveWorkerFrame({ header, data: null })).toMatch(/JPEG/);
    expect(readLiveWorkerFrame({ header, data: new Uint8Array([1, 2, 3, 4]) })).toMatch(/JPEG/);
    expect(readLiveWorkerFrame({ header, data: jpeg(MAX_LIVE_FRAME + 1) })).toMatch(/JPEG/);
    expect(readLiveWorkerFrame({ header: { ...header, worker: -1 }, data: jpeg(10) })).toMatch(/names no worker/);
    expect(readLiveWorkerFrame({ header: { ...header, type: 'stop' }, data: jpeg(10) })).toMatch(/is a frame/);
  });
});

describe('what the viewers ask of a worker', () => {
  test('is a size within a tile and the largest view, and a pace no faster than a full view', () => {
    expect(readLiveViewSize(1920, 1080)).toEqual({ width: MAX_LIVE_VIEW_WIDTH, height: MAX_LIVE_VIEW_HEIGHT });
    expect(readLiveViewSize('100', '50')).toEqual({ width: LIVE_TILE_WIDTH, height: LIVE_TILE_HEIGHT });
    expect(readLiveViewSize(900, 560)).toEqual({ width: 900, height: 560 });
    expect(readLiveViewSize(900.5, 560)).toBeNull();
    expect(readLiveViewSize('wide', 560)).toBeNull();
    for (const [width, height] of [
      [0, 560],
      [900, -1],
      ['-5', '600'],
    ]) {
      expect(readLiveViewSize(width, height), `${width} by ${height}`).toBeNull();
    }
    expect(
      parseInstanceToWorker(JSON.stringify({ type: 'view', width: 1000, height: 640, fps: 4, full: true })),
    ).toEqual({
      type: 'view',
      width: 1000,
      height: 640,
      fps: 4,
      full: true,
      layers: [],
    });
    expect(parseInstanceToWorker(JSON.stringify({ type: 'view', width: 4000, height: 50, fps: 30 }))).toEqual({
      type: 'view',
      width: MAX_LIVE_VIEW_WIDTH,
      height: LIVE_TILE_HEIGHT,
      fps: LIVE_FRAME_FPS,
      full: true,
      layers: [],
    });
    expect(
      parseInstanceToWorker(JSON.stringify({ type: 'view', width: 320, height: 200, fps: LIVE_TILE_FPS, full: false })),
    ).toMatchObject({ fps: 1, full: false });
    for (const view of [
      { type: 'view', width: '1000', height: 640, fps: 4 },
      { type: 'view', width: 1000, height: 640, fps: 0 },
      { type: 'view', width: 1000, height: 640 },
      { type: 'view', width: 0, height: 640, fps: 4 },
    ]) {
      expect(parseInstanceToWorker(JSON.stringify(view)), JSON.stringify(view)).toBeNull();
    }
  });

  test('asks the worker for its latest image and call log again', () => {
    expect(parseInstanceToWorker(JSON.stringify({ type: 'resend' }))).toEqual({ type: 'resend' });
  });
});

describe('a viewer’s watch', () => {
  const id = { shard: null, worker: 2, slot: 1 };

  test('carries each message as a live message, a frame’s image as its data', () => {
    const frame = { type: 'frame' as const, ...id, image: jpeg(2048), call: null, test: 'pays', at: 1_760_000_000_000 };
    const stream = joined(
      encodeLiveViewerMessage({ type: 'hello', watch: 'abcdefghijklmnopqrstuv' }),
      encodeLiveViewerMessage(frame),
      encodeLiveViewerMessage({ type: 'refused', ...id, message: 'No page yet.' }),
      encodeLiveViewerMessage({ type: 'test-ended', ...id, outcome: { test: 'pays', status: 'failed', ms: 1200 } }),
      encodeLiveViewerMessage({ type: 'end', ...id, reason: 'worker-left' }),
      encodeLiveViewerMessage({ type: 'end', reason: 'run-ended' }),
    );
    expect(readInChunks(stream, 500).map(readLiveViewerMessage)).toEqual([
      { type: 'hello', watch: 'abcdefghijklmnopqrstuv' },
      frame,
      { type: 'refused', ...id, message: 'No page yet.' },
      { type: 'test-ended', ...id, outcome: { test: 'pays', status: 'failed', ms: 1200 } },
      { type: 'end', ...id, reason: 'worker-left' },
      { type: 'end', reason: 'run-ended' },
    ]);
  });

  test('carries the page’s text as its data: whole while it fits a reader’s data, else cut where a character ends', () => {
    /** A page's text of `MAX_LANE_TEXT` characters, of lines in one script. */
    const page = (line: (i: number) => string) => {
      let text = '';
      for (let i = 0; text.length < MAX_LANE_TEXT; i++) text += `${line(i)}\n`;
      return text.slice(0, MAX_LANE_TEXT);
    };
    const scripts = [
      page((i) => `- row "Order ${i}": cell "Paid" link "Open ${i}"`),
      page((i) => `- row "Commande ${i} réglée à Zürich": cell "Payée"`),
      page((i) => `- text: 注文番号${i}の支払いは東京駅の窓口で済みました。お受け取りは明日です`),
    ];
    for (const text of scripts) {
      const message = {
        type: 'text' as const,
        ...id,
        text: { call: 'call@4', source: 'snapshot' as const, text, cut: false, at: 1_760_000_000_000 },
        test: 'pays – “é”',
      };
      const bytes = encodeLiveViewerMessage(message);
      expect(new DataView(bytes.buffer).getUint32(0)).toBeLessThan(1024);
      const [read, after] = readInChunks(joined(bytes, encodeLiveViewerMessage({ type: 'end', reason: 'off' })), 4096);
      const shown = readLiveViewerMessage(read!) as Extract<LiveViewerMessage, { type: 'text'; text: LaneText }>;
      expect(shown).toMatchObject({ type: 'text', ...id, test: 'pays – “é”' });
      expect(text.startsWith(shown.text.text)).toBe(true);
      expect(shown.text.cut).toBe(shown.text.text.length < text.length);
      expect(new TextEncoder().encode(shown.text.text).length).toBeLessThanOrEqual(MAX_LIVE_FRAME);
      expect(readLiveViewerMessage(after!)).toEqual({ type: 'end', reason: 'off' });
    }
    // A text of mostly one or two bytes a character comes whole; one of three, cut.
    const read = (text: string) =>
      (
        readLiveViewerMessage(
          readInChunks(
            encodeLiveViewerMessage({
              type: 'text',
              ...id,
              test: null,
              text: { call: null, source: 'trace', text, cut: false, at: 1_760_000_000_000 },
            }),
            65536,
          )[0]!,
        ) as Extract<LiveViewerMessage, { type: 'text'; text: LaneText }>
      ).text;
    expect(read(scripts[0]!)).toMatchObject({ text: scripts[0], cut: false });
    expect(read(scripts[1]!)).toMatchObject({ text: scripts[1], cut: false });
    expect(read(scripts[2]!).cut).toBe(true);
    expect(read('- heading "Shop"')).toMatchObject({ text: '- heading "Shop"', cut: false });
  });

  test('writes a header a reader takes, whatever the fields a worker posted: each at its longest, all escapes', () => {
    // A control character is six bytes of JSON: the most any character of a field takes.
    const long = (length: number) => '\u0001'.repeat(length);
    const worker = { shard: null, worker: 2, slot: 1 };
    const call = { title: long(5000), file: 'x'.repeat(1024), line: 12 };
    const posted = [
      {
        type: 'call-log',
        ...worker,
        test: long(5000),
        log: {
          id: 'x'.repeat(100),
          call,
          status: 'failed',
          lines: Array.from({ length: 50 }, () => long(5000)),
          point: { x: 1, y: 2 },
          target: { count: 3, box: { x: 1, y: 2, width: 3, height: 4 }, enabled: false },
          viewport: { width: 1280, height: 800 },
          ms: 12,
          error: long(5000),
        },
      },
      {
        type: 'page-event',
        ...worker,
        test: long(5000),
        at: 1_760_000_000_000,
        event: {
          kind: 'backend',
          method: 'POST',
          url: `http://a.test/${long(5000)}`,
          status: 500,
          level: 'error',
          text: long(5000),
        },
      },
      { type: 'text', ...worker, test: long(5000), refused: long(5000) },
    ];
    for (const value of posted) {
      const message = readWorkerToInstance(value);
      expect(typeof message).toBe('object');
      const bytes = encodeLiveViewerMessage(message as unknown as LiveViewerMessage);
      expect(new DataView(bytes.buffer).getUint32(0)).toBeLessThanOrEqual(MAX_LIVE_HEADER);
    }
  });

  test('leaves out what this version does not read', () => {
    const at = (header: Record<string, unknown>, data: Uint8Array | null = null) =>
      readLiveViewerMessage({ header, data });
    expect(at({ type: 'frame', ...id }, new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(at({ type: 'frame', ...id })).toBeNull();
    expect(at({ type: 'frame', worker: -1 }, jpeg(10))).toBeNull();
    expect(at({ type: 'hello', watch: 'short' })).toBeNull();
    expect(at({ type: 'end', reason: 'bored' })).toBeNull();
    expect(at({ type: 'video', ...id })).toBeNull();
  });
});
