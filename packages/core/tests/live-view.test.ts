import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  MAX_LIVE_FRAME_BASE64,
  formatLiveViewEnv,
  isLiveFrameData,
  isLiveViewKey,
  liveWorkerKey,
  parseInstanceToWorker,
  parseLiveViewEnv,
  readLiveCall,
  readLiveWorkerId,
  readWorkerToInstance,
} from '../src/live-view';
import { LatestPacer, fitViewSize } from '../src/run-view';

const KEY = `pdl_${'a'.repeat(43)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('the live view address', () => {
  test('names the run endpoint of the instance and the key, under a sub-path too', () => {
    const value = formatLiveViewEnv('https://piwi.example.com/team/', 42, KEY);
    expect(value).toBe(`https://piwi.example.com/team/api/test-runs/42/live-view#${KEY}`);
    expect(parseLiveViewEnv(value)).toEqual({
      url: 'https://piwi.example.com/team/api/test-runs/42/live-view',
      runId: 42,
      key: KEY,
    });
  });

  test('refuses what is not a run endpoint with a key', () => {
    for (const value of [
      undefined,
      '',
      `https://x.test/api/test-runs/42/live-view`,
      `https://x.test/api/test-runs/42/live-view#pd_${'a'.repeat(43)}`,
      `https://x.test/api/test-runs/42/live-view#${KEY}x`,
      `ftp://x.test/api/test-runs/42/live-view#${KEY}`,
      `https://x.test/api/test-runs/0/live-view#${KEY}`,
      `https://x.test/api/test-runs/abc/live-view#${KEY}`,
      `https://x.test/api/test-runs/42/events#${KEY}`,
      `https://x.test/api/test-runs/42/live-view?run=1#${KEY}`,
      `https://user:pass@x.test/api/test-runs/42/live-view#${KEY}`,
      `not a url#${KEY}`,
    ]) {
      expect(parseLiveViewEnv(value), String(value)).toBeNull();
    }
  });

  test('a key is pdl_ and 43 characters of base64url', () => {
    expect(isLiveViewKey(KEY)).toBe(true);
    expect(isLiveViewKey(`pdl_${'-_'.repeat(21)}A`)).toBe(true);
    expect(isLiveViewKey(`pdl_${'a'.repeat(42)}`)).toBe(false);
    expect(isLiveViewKey(`pd_${'a'.repeat(44)}`)).toBe(false);
    expect(isLiveViewKey(`pdl_${'a'.repeat(42)}+`)).toBe(false);
    expect(isLiveViewKey(42)).toBe(false);
  });
});

describe('the messages', () => {
  test('a worker is a shard from 1 or none, and an index from 0, from a message or a query', () => {
    expect(readLiveWorkerId(null, 3)).toEqual({ shard: null, worker: 3 });
    expect(readLiveWorkerId('', '3')).toEqual({ shard: null, worker: 3 });
    expect(readLiveWorkerId('2', '0')).toEqual({ shard: 2, worker: 0 });
    for (const [shard, worker] of [
      [0, 1],
      [null, -1],
      [null, 1.5],
      [true, 1],
      ['1e3', 1],
      [null, '0x1'],
      [null, undefined],
    ] as const) {
      expect(readLiveWorkerId(shard, worker), `${shard}:${worker}`).toBeNull();
    }
    expect(liveWorkerKey({ shard: null, worker: 3 })).toBe(':3');
    expect(liveWorkerKey({ shard: 2, worker: 3 })).toBe('2:3');
  });

  test('a call keeps its title, and its place only when both are one', () => {
    expect(readLiveCall({ title: 'Click', file: 'tests/a.spec.ts', line: 4 })).toEqual({
      title: 'Click',
      file: 'tests/a.spec.ts',
      line: 4,
    });
    expect(readLiveCall({ title: 'Click', file: 'a\nb', line: 4 })).toEqual({ title: 'Click', file: null, line: null });
    expect(readLiveCall({ title: 'Click', file: 'a.ts', line: 0 })).toEqual({
      title: 'Click',
      file: 'a.ts',
      line: null,
    });
    expect(readLiveCall({ title: 'x'.repeat(2000) })?.title).toHaveLength(500);
    expect(readLiveCall({ title: '  ' })).toBeNull();
    expect(readLiveCall('Click')).toBeNull();
  });

  test('a frame is base64 within the cap, with its call and its test', () => {
    expect(isLiveFrameData('/9j/4AAQ')).toBe(true);
    expect(isLiveFrameData('')).toBe(false);
    expect(isLiveFrameData('not base64!')).toBe(false);
    expect(isLiveFrameData('A'.repeat(MAX_LIVE_FRAME_BASE64))).toBe(true);
    expect(isLiveFrameData('A'.repeat(MAX_LIVE_FRAME_BASE64 + 4))).toBe(false);
    expect(
      readWorkerToInstance({
        type: 'frame',
        shard: null,
        worker: 1,
        data: '/9j/',
        call: { title: 'Fill', line: 2 },
        test: 'pays',
      }),
    ).toEqual({
      type: 'frame',
      shard: null,
      worker: 1,
      data: '/9j/',
      call: { title: 'Fill', file: null, line: null },
      test: 'pays',
    });
    expect(readWorkerToInstance({ type: 'frame', worker: 1, data: '/9j/', test: 7 })).toEqual({
      type: 'frame',
      shard: null,
      worker: 1,
      data: '/9j/',
      call: null,
      test: null,
    });
    expect(readWorkerToInstance({ type: 'frame', worker: 1, refused: 'Too heavy.' })).toEqual({
      type: 'frame',
      shard: null,
      worker: 1,
      refused: 'Too heavy.',
    });
    expect(typeof readWorkerToInstance({ type: 'frame', worker: 1, data: 'A'.repeat(MAX_LIVE_FRAME_BASE64 + 4) })).toBe(
      'string',
    );
  });

  test('a stop names its call, an unknown reason read as other; its end is null', () => {
    expect(
      readWorkerToInstance({
        type: 'stop',
        shard: 2,
        worker: 0,
        stop: { reason: 'page-pause', call: { title: 'Pause' }, test: 'pays' },
      }),
    ).toEqual({
      type: 'stop',
      shard: 2,
      worker: 0,
      stop: { reason: 'page-pause', call: { title: 'Pause', file: null, line: null }, test: 'pays' },
    });
    expect(readWorkerToInstance({ type: 'stop', worker: 0, stop: { reason: 'later', call: { title: 'Go' } } })).toEqual(
      expect.objectContaining({ stop: { reason: 'other', call: { title: 'Go', file: null, line: null }, test: null } }),
    );
    expect(readWorkerToInstance({ type: 'stop', worker: 0, stop: null })).toEqual({
      type: 'stop',
      shard: null,
      worker: 0,
      stop: null,
    });
    expect(typeof readWorkerToInstance({ type: 'stop', worker: 0, stop: { reason: 'pause' } })).toBe('string');
  });

  test('refuses what names no worker or is of another type', () => {
    for (const value of [
      null,
      [],
      'frame',
      { type: 'frame', data: '/9j/' },
      { type: 'frame', shard: 0, worker: 1, data: '/9j/' },
      { type: 'input', worker: 1, events: [] },
    ]) {
      expect(typeof readWorkerToInstance(value), JSON.stringify(value)).toBe('string');
    }
    expect(readWorkerToInstance({ type: 'ended', worker: 4 })).toEqual({ type: 'ended', shard: null, worker: 4 });
  });

  test('the instance says how many watch, and nothing else', () => {
    expect(parseInstanceToWorker('{"type":"viewers","count":2}')).toEqual({ type: 'viewers', count: 2 });
    for (const data of [
      '',
      'x',
      '{"type":"viewers","count":-1}',
      '{"type":"viewers"}',
      '{"type":"input","events":[]}',
    ]) {
      expect(parseInstanceToWorker(data), data).toBeNull();
    }
  });
});

describe('the pace of frames', () => {
  test('fits a viewport into the frame size, its proportions kept', () => {
    expect(fitViewSize({ width: 1280, height: 720 }, 640, 400)).toEqual({ width: 640, height: 360 });
    expect(fitViewSize({ width: 600, height: 800 }, 640, 400)).toEqual({ width: 300, height: 400 });
    expect(fitViewSize({ width: 320, height: 200 }, 640, 400)).toEqual({ width: 320, height: 200 });
  });

  test('a heavier frame holds the next one back longer, within the byte rate', () => {
    vi.useFakeTimers();
    const sent: Array<[number, number]> = [];
    const pacer = new LatestPacer<number>({
      intervalMs: 1000 / LIVE_FRAME_FPS,
      spacing: (bytes) => (bytes * 1000) / LIVE_FRAME_BYTE_RATE,
      send: (bytes) => void sent.push([Date.now(), bytes]),
    });
    const start = Date.now();
    // Light frames go at the frame rate; one of a full second's bytes holds the next one a second.
    for (let i = 0; i < 40; i++) {
      pacer.offer(i < 20 ? 30_000 : LIVE_FRAME_BYTE_RATE);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(3000);
    const light = sent.filter(([at]) => at - start < 1000);
    expect(light.length).toBeLessThanOrEqual(LIVE_FRAME_FPS);
    const heavy = sent.filter(([, bytes]) => bytes === LIVE_FRAME_BYTE_RATE);
    for (let i = 1; i < heavy.length; i++) expect(heavy[i]![0] - heavy[i - 1]![0]).toBeGreaterThanOrEqual(1000);
    const bytes = sent.reduce((sum, [, b]) => sum + b, 0);
    const seconds = (sent[sent.length - 1]![0] - start) / 1000 + 1;
    expect(bytes / seconds).toBeLessThanOrEqual(LIVE_FRAME_BYTE_RATE * 1.5);
  });
});
