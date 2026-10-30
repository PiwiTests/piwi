import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LIVE_FRAME_BYTE_RATE,
  LIVE_FRAME_FPS,
  LIVE_SHARE_MISSING,
  MAX_LIVE_FRAME_BASE64,
  formatLiveViewEnv,
  formatLiveViewMissing,
  isLiveFrameData,
  isLiveViewKey,
  liveRunPage,
  liveShareRefusal,
  liveWorkerKey,
  parseInstanceToWorker,
  parseLiveMasks,
  liveMaskProblem,
  MAX_LIVE_MASKS,
  MAX_LIVE_MASK_LENGTH,
  parseLiveViewEnv,
  parseLiveViewMissing,
  readLiveCall,
  readLiveWorkerId,
  readWorkerToInstance,
  compressCallLog,
  MAX_LIVE_CALL_LOG_LINES,
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

  test('names the run page beside its endpoint, under a sub-path too', () => {
    const address = parseLiveViewEnv(formatLiveViewEnv('https://piwi.example.com/team/', 42, KEY))!;
    expect(liveRunPage(address)).toBe('https://piwi.example.com/team/test-runs/42');
    expect(liveRunPage(parseLiveViewEnv(formatLiveViewEnv('http://127.0.0.1:7494', 7, KEY))!)).toBe(
      'http://127.0.0.1:7494/test-runs/7',
    );
  });

  test('a run outside CI without a key names why, which no address reads as one', () => {
    for (const why of ['no-instance', 'unregistered', 'off'] as const) {
      const value = formatLiveViewMissing(why);
      expect(value).toBe(`none:${why}`);
      expect(parseLiveViewMissing(value)).toBe(why);
      expect(parseLiveViewEnv(value)).toBeNull();
      expect(LIVE_SHARE_MISSING[why]).toMatch(/^This run cannot be shared live: /);
    }
    for (const value of [undefined, '', 'none:', 'none:later', 'off', formatLiveViewEnv('https://x.test', 4, KEY)]) {
      expect(parseLiveViewMissing(value), String(value)).toBeNull();
    }
  });

  test('says why a shared stream was given up, by the instance’s answer', () => {
    expect(liveShareRefusal(404)).toMatch(/live view was turned off/);
    expect(liveShareRefusal(401)).toBe(liveShareRefusal(403));
    expect(liveShareRefusal(410)).toMatch(/no longer live/);
    expect(liveShareRefusal(409)).toMatch(/holds the run as interrupted/);
    expect(liveShareRefusal(null)).toMatch(/did not answer/);
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

  test('a call names no text a fill or a typing typed, from a reporter that hid it or not', () => {
    expect(readLiveCall({ title: 'Fill "S3cr3t!Passw0rd"', file: 'tests/a.spec.ts', line: 4 })?.title).toBe(
      'Fill "<hidden>"',
    );
    expect(readLiveCall({ title: `Type "abc" getByLabel('Password')`, file: null, line: null })?.title).toBe(
      `Type "<hidden>" getByLabel('Password')`,
    );
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
    expect(readWorkerToInstance({ type: 'unshared', shard: 2, worker: 1 })).toEqual({
      type: 'unshared',
      shard: 2,
      worker: 1,
    });
  });

  test('the instance says how many watch, and nothing else', () => {
    expect(parseInstanceToWorker('{"type":"viewers","count":2}')).toEqual({ type: 'viewers', count: 2 });
    for (const data of [
      '',
      'x',
      '{"type":"viewers","count":-1}',
      '{"type":"viewers"}',
      '{"type":"input","events":[]}',
      '{"type":"masks","locators":"getByLabel(\'IBAN\')"}',
      '{"type":"masks","locators":["#iban"]}',
    ]) {
      expect(parseInstanceToWorker(data), data).toBeNull();
    }
  });

  test('reads the elements a project masks: Playwright locators, trimmed, each once, 20 at most', () => {
    expect(
      parseInstanceToWorker(
        JSON.stringify({ type: 'masks', locators: [" getByLabel('IBAN') ", "getByLabel('IBAN')", "locator('#card')"] }),
      ),
    ).toEqual({ type: 'masks', locators: ["getByLabel('IBAN')", "locator('#card')"] });
    expect(parseLiveMasks([])).toEqual([]);
    expect(parseLiveMasks(Array.from({ length: MAX_LIVE_MASKS + 1 }, (_, i) => `getByTestId('f${i}')`))).toBeNull();
    expect(parseLiveMasks([`getByLabel('${'x'.repeat(MAX_LIVE_MASK_LENGTH)}')`])).toBeNull();
    expect(liveMaskProblem("getByRole('textbox', { name: 'IBAN' })")).toBeNull();
    expect(liveMaskProblem('#iban')).toBe("`#iban` is not a Playwright locator, such as getByLabel('IBAN').");
    expect(liveMaskProblem('  ')).toBe('A masked element needs a locator.');
    // The worker masks elements: a chain that ends on a frame, or that no page can build, masks nothing.
    expect(liveMaskProblem("frameLocator('#card')")).toBe(
      "`frameLocator('#card')` ends on a frame, not an element: name the iframe itself, such as locator('iframe#card').",
    );
    expect(liveMaskProblem("locator('iframe').contentFrame()")).toMatch(/ends on a frame/);
    expect(liveMaskProblem("getByLabel('IBAN').owner()")).toMatch(/is not a Playwright locator/);
    expect(liveMaskProblem('first()')).toMatch(/is not a Playwright locator/);
    expect(liveMaskProblem("frameLocator('#card').owner()")).toBeNull();
    expect(liveMaskProblem("frameLocator('#card').getByLabel('Card number')")).toBeNull();
    expect(liveMaskProblem("locator('iframe').contentFrame().getByLabel('CVC').first()")).toBeNull();
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

describe('the call log a worker posts', () => {
  const log = {
    id: 'call@42',
    call: { title: "Click getByRole('button', { name: 'Pay' })", file: 'tests/checkout.spec.ts', line: 12 },
    status: 'running',
    lines: [
      "waiting for getByRole('button', { name: 'Pay' })",
      '  locator resolved to <button id="pay" disabled>Pay</button>',
      '  element is not enabled',
      'retrying click action',
    ],
    point: null,
    target: { count: 1, box: { x: 271, y: 18.5, width: 48, height: 24 }, enabled: false },
    viewport: { width: 1280, height: 800 },
    ms: 7400,
    error: null,
  };

  test('is read field by field, with its test’s title, and is refused without a log', () => {
    expect(readWorkerToInstance({ type: 'call-log', worker: 1, log, test: 'pays' })).toEqual({
      type: 'call-log',
      shard: null,
      worker: 1,
      log,
      test: 'pays',
    });
    expect(readWorkerToInstance({ type: 'call-log', worker: 1, log })).toMatchObject({ test: null });
    expect(typeof readWorkerToInstance({ type: 'call-log', worker: 1, log: null })).toBe('string');
  });

  test('keeps its last lines, each cut, and drops a field that is not one', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(400)}`);
    const read = readWorkerToInstance({
      type: 'call-log',
      worker: 0,
      log: { ...log, lines, point: { x: 'a', y: 2 }, target: { count: -1 }, viewport: { width: 0, height: 9 }, ms: -5 },
    });
    if (typeof read === 'string' || read.type !== 'call-log' || !read.log) throw new Error('not read');
    expect(read.log.lines).toHaveLength(MAX_LIVE_CALL_LOG_LINES);
    expect(read.log.lines[0]).toMatch(new RegExp(`^line ${40 - MAX_LIVE_CALL_LOG_LINES} `));
    expect(read.log.lines.every((line) => line.length <= 300)).toBe(true);
    expect(read.log).toMatchObject({ point: null, target: null, viewport: null, ms: 0 });
  });

  test('names no text a call typed and no credential, from a worker that hid them or not', () => {
    const read = readWorkerToInstance({
      type: 'call-log',
      worker: 0,
      log: {
        ...log,
        call: { title: 'Fill "S3cr3t!Passw0rd"', file: null, line: null },
        lines: [
          '  fill("S3cr3t!Passw0rd")',
          'navigating to "https://shop.test/?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"',
        ],
        status: 'failed',
        error: 'locator.fill: Timeout 1500ms exceeded.\nCall log:\n  - fill("S3cr3t!Passw0rd")',
      },
    });
    expect(JSON.stringify(read)).not.toMatch(/S3cr3t|eyJhbGci/);
    if (typeof read === 'string' || read.type !== 'call-log' || !read.log) throw new Error('not read');
    expect(read.log.error).toBe('locator.fill: Timeout 1500ms exceeded.');
  });

  test('is refused without a call, a status or an id', () => {
    for (const bad of [
      { ...log, id: '' },
      { ...log, call: null },
      { ...log, status: 'done' },
    ]) {
      expect(typeof readWorkerToInstance({ type: 'call-log', worker: 0, log: bad })).toBe('string');
    }
  });

  test('folds the lines a retried action repeats, as Playwright writes a failed call’s log', () => {
    // As Playwright 1.64 logs a click on a disabled button, retried every half second.
    const retry = [
      '  waiting for element to be visible, enabled and stable',
      '  element is not enabled',
      'retrying click action',
      '  waiting 500ms',
    ];
    const lines = [
      "waiting for getByRole('button', { name: 'Pay' })",
      '  locator resolved to <button disabled>Pay</button>',
      'attempting click action',
      ...Array.from({ length: 6 }, () => retry).flat(),
    ];
    expect(compressCallLog(lines)).toEqual([
      "- waiting for getByRole('button', { name: 'Pay' })",
      '  - locator resolved to <button disabled>Pay</button>',
      '- attempting click action',
      '  6 × waiting for element to be visible, enabled and stable',
      '    - element is not enabled',
      '  - retrying click action',
      '    - waiting 500ms',
    ]);
    expect(compressCallLog(['a', 'b', 'a', 'b', 'c'])).toEqual(['2 × a', '  - b', '- c']);
    expect(compressCallLog([])).toEqual([]);
  });
});
