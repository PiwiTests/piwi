import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  FrameAcks,
  LatestPacer,
  MAX_VIEW_COORD,
  MAX_VIEW_EVENTS,
  MAX_VIEW_FRAME,
  MAX_VIEW_FRAME_BASE64,
  MAX_VIEW_HEIGHT,
  MAX_VIEW_TEXT,
  MAX_VIEW_WHEEL,
  MAX_VIEW_WIDTH,
  RateWindow,
  isViewFrameData,
  isViewKey,
  isViewKeyCombo,
  isViewPoint,
  isViewSize,
  readViewInput,
  viewSize,
  type ViewInput,
} from '../src/run-view';

/** A seeded generator, so a failing case is the same on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Values a message's fields may hold, the odd ones among them. */
const ODD = [
  null,
  undefined,
  0,
  -1,
  1,
  1.5,
  2 ** 53,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MAX_VIEW_COORD,
  MAX_VIEW_COORD + 1,
  '',
  'a',
  'Enter',
  'Shift+Tab',
  '\0',
  '\n',
  'é',
  'x'.repeat(MAX_VIEW_TEXT + 1),
  [],
  {},
  [1],
  true,
  'left',
  'move',
  'click',
  'press',
  'mouse',
  'key',
  'text',
  'wheel',
  '__proto__',
];

describe('the keys a viewer plays', () => {
  test('are Playwright’s key names and the printable ASCII characters', () => {
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowLeft', 'KeyA', 'Digit0', 'F12', 'Shift', 'ControlOrMeta', 'a']) {
      expect(isViewKey(key), key).toBe(true);
    }
    for (const char of [' ', '~', '!', 'A', 'z', '0']) expect(isViewKey(char), char).toBe(true);
    for (const key of ['', 'Ctrl', 'enter', 'Return', '\n', '\t', 'é', '🙂', 'ab', 'Key', 42, null]) {
      expect(isViewKey(key), String(key)).toBe(false);
    }
  });

  test('press modifiers before a key, split as Playwright splits them', () => {
    for (const combo of ['Shift+Tab', 'ControlOrMeta+a', 'Control+Shift+ArrowLeft', 'Control++', '+', 'Alt+F4']) {
      expect(isViewKeyCombo(combo), combo).toBe(true);
    }
    for (const combo of ['a+', 'Shift+', 'a+b', 'Tab+Shift', 'Shift+Shift+Shift+Shift+Shift+a', '', 'Foo+a']) {
      expect(isViewKeyCombo(combo), combo).toBe(false);
    }
    expect(isViewKeyCombo('Shift+'.repeat(20) + 'a')).toBe(false);
  });
});

describe('a viewer’s input', () => {
  test('reads each kind of event, a button and a click count left out as the left one, once', () => {
    const events = [
      { type: 'mouse', action: 'move', x: 10.5, y: 20 },
      { type: 'mouse', action: 'down', x: 10, y: 20, button: 'right' },
      { type: 'mouse', action: 'up', x: 10, y: 20 },
      { type: 'mouse', action: 'click', x: 0, y: MAX_VIEW_COORD, clickCount: 2 },
      { type: 'wheel', x: 5, y: 5, deltaX: -MAX_VIEW_WHEEL, deltaY: 120 },
      { type: 'key', action: 'down', key: 'Shift' },
      { type: 'key', action: 'press', key: 'Shift+Tab' },
      { type: 'key', action: 'up', key: 'Shift' },
      { type: 'text', text: 'héllo 🙂' },
    ];
    expect(readViewInput(events)).toEqual([
      { type: 'mouse', action: 'move', x: 10.5, y: 20 },
      { type: 'mouse', action: 'down', x: 10, y: 20, button: 'right' },
      { type: 'mouse', action: 'up', x: 10, y: 20, button: 'left' },
      { type: 'mouse', action: 'click', x: 0, y: MAX_VIEW_COORD, button: 'left', clickCount: 2 },
      { type: 'wheel', x: 5, y: 5, deltaX: -MAX_VIEW_WHEEL, deltaY: 120 },
      { type: 'key', action: 'down', key: 'Shift' },
      { type: 'key', action: 'press', key: 'Shift+Tab' },
      { type: 'key', action: 'up', key: 'Shift' },
      { type: 'text', text: 'héllo 🙂' },
    ] satisfies ViewInput[]);
  });

  test('drops what an event carries beyond its fields', () => {
    expect(readViewInput([{ type: 'text', text: 'a', script: 'alert(1)', x: 4 }])).toEqual([
      { type: 'text', text: 'a' },
    ]);
    expect(readViewInput([{ type: 'mouse', action: 'move', x: 1, y: 2, button: 'left', code: 'x' }])).toEqual([
      { type: 'mouse', action: 'move', x: 1, y: 2 },
    ]);
  });

  test('refuses a list that is empty or too long, and names the first event it cannot play', () => {
    expect(readViewInput([])).toBe('The input needs its events.');
    expect(readViewInput('click')).toBe('The input needs its events.');
    const move = { type: 'mouse', action: 'move', x: 1, y: 1 };
    expect(readViewInput(Array.from({ length: MAX_VIEW_EVENTS }, () => move))).toHaveLength(MAX_VIEW_EVENTS);
    expect(readViewInput(Array.from({ length: MAX_VIEW_EVENTS + 1 }, () => move))).toBe(
      `The input carries ${MAX_VIEW_EVENTS} events at most.`,
    );
    const refusals: Array<[unknown, string]> = [
      [{ type: 'mouse', action: 'move', x: -1, y: 0 }, `needs x and y, CSS pixels from 0 to ${MAX_VIEW_COORD}.`],
      [{ type: 'mouse', action: 'move', x: 1, y: MAX_VIEW_COORD + 1 }, 'needs x and y'],
      [{ type: 'mouse', action: 'move', x: Number.NaN, y: 1 }, 'needs x and y'],
      [{ type: 'mouse', action: 'move', x: '1', y: 1 }, 'needs x and y'],
      [{ type: 'mouse', action: 'drag', x: 1, y: 1 }, 'whose action is not move, down, up or click'],
      [{ type: 'mouse', action: 'down', x: 1, y: 1, button: 'back' }, 'other than left, right or middle'],
      [{ type: 'mouse', action: 'click', x: 1, y: 1, clickCount: 4 }, 'needs a clickCount from 1 to 3'],
      [{ type: 'mouse', action: 'click', x: 1, y: 1, clickCount: 1.5 }, 'needs a clickCount from 1 to 3'],
      [{ type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: MAX_VIEW_WHEEL + 1 }, 'needs deltaX and deltaY'],
      [{ type: 'wheel', x: 1, y: 1, deltaY: 1 }, 'needs deltaX and deltaY'],
      [{ type: 'key', action: 'type', key: 'a' }, 'whose action is not down, up or press'],
      [{ type: 'key', action: 'down', key: 'Shift+Tab' }, 'names a key Playwright does not play: "Shift+Tab".'],
      [{ type: 'key', action: 'press', key: 'Ctrl+a' }, 'names a key Playwright does not play'],
      [{ type: 'text', text: '' }, `needs a text of 1 to ${MAX_VIEW_TEXT} characters.`],
      [{ type: 'text', text: 'x'.repeat(MAX_VIEW_TEXT + 1) }, 'needs a text'],
      [{ type: 'text', text: 'a\0b' }, 'needs a text'],
      [{ type: 'evaluate', code: 'document.cookie' }, 'is of a type other than mouse, wheel, key or text.'],
      ['click', 'is not an event.'],
    ];
    for (const [event, why] of refusals) {
      const said = readViewInput([move, event]);
      expect(said, JSON.stringify(event)).toEqual(expect.stringMatching(/^Event 2 /));
      expect(said, JSON.stringify(event)).toContain(why);
    }
  });

  test('reads any value without throwing, every event it takes within its bounds', () => {
    const next = random(7);
    const pick = () => ODD[Math.floor(next() * ODD.length)];
    for (let i = 0; i < 20_000; i++) {
      const event: Record<string, unknown> = {
        type: pick(),
        action: pick(),
        x: pick(),
        y: pick(),
        button: pick(),
        clickCount: pick(),
        deltaX: pick(),
        deltaY: pick(),
        key: pick(),
        text: pick(),
      };
      const read = readViewInput(next() < 0.1 ? pick() : [event]);
      if (typeof read === 'string') continue;
      for (const e of read) {
        if (e.type === 'mouse' || e.type === 'wheel') expect(isViewPoint(e.x, e.y)).toBe(true);
        if (e.type === 'wheel')
          expect(Math.abs(e.deltaX) <= MAX_VIEW_WHEEL && Math.abs(e.deltaY) <= MAX_VIEW_WHEEL).toBe(true);
        if (e.type === 'key') expect(e.action === 'press' ? isViewKeyCombo(e.key) : isViewKey(e.key)).toBe(true);
        if (e.type === 'text') expect(e.text.length >= 1 && e.text.length <= MAX_VIEW_TEXT).toBe(true);
      }
    }
  });
});

describe('a frame', () => {
  test('carries base64 of at most the longest frame, and a viewport of whole pixels', () => {
    expect(MAX_VIEW_FRAME_BASE64).toBe(4 * Math.ceil(MAX_VIEW_FRAME / 3));
    expect(isViewFrameData('/9j/4A==')).toBe(true);
    expect(isViewFrameData('A'.repeat(MAX_VIEW_FRAME_BASE64))).toBe(true);
    expect(isViewFrameData('A'.repeat(MAX_VIEW_FRAME_BASE64 + 4))).toBe(false);
    for (const data of ['', 'not base64!', '/9j/4A==\n', 7, null]) expect(isViewFrameData(data)).toBe(false);
    expect(isViewSize(1280, 720)).toBe(true);
    for (const [w, h] of [
      [0, 720],
      [1280.5, 720],
      [1280, MAX_VIEW_COORD + 1],
      ['1280', 720],
    ]) {
      expect(isViewSize(w, h)).toBe(false);
    }
  });

  test('is asked at the viewport’s size, scaled down to fit the largest frame', () => {
    expect(viewSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(viewSize({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(viewSize({ width: 2560, height: 1440 })).toEqual({ width: MAX_VIEW_WIDTH, height: 720 });
    expect(viewSize({ width: 1000, height: 2000 })).toEqual({ width: 400, height: MAX_VIEW_HEIGHT });
    expect(viewSize({ width: 0, height: 0 })).toEqual({ width: 2, height: 2 });
  });
});

describe('the pace of the view', () => {
  afterEach(() => vi.useRealTimers());

  test('counts at most so many units in each second', () => {
    let now = 0;
    const rate = new RateWindow(10, () => now);
    expect(rate.take(6)).toBe(true);
    expect(rate.take(5)).toBe(false);
    expect(rate.take(4)).toBe(true);
    expect(rate.take(1)).toBe(false);
    now = 999;
    expect(rate.take(1)).toBe(false);
    now = 1000;
    expect(rate.take(10)).toBe(true);
    expect(rate.take(11)).toBe(false);
  });

  test('sends the latest item at most once an interval, one waiting at most, none while the way out is busy', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    let busy = false;
    const pacer = new LatestPacer<number>({ intervalMs: 100, send: (n) => void sent.push(n), busy: () => busy });
    pacer.offer(1);
    expect(sent).toEqual([1]);
    for (let n = 2; n <= 50; n++) pacer.offer(n);
    expect(sent).toEqual([1]);
    expect(pacer.waiting).toBe(true);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 50]);
    expect(pacer.waiting).toBe(false);
    busy = true;
    pacer.offer(51);
    pacer.offer(52);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([1, 50]);
    busy = false;
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 50, 52]);
    pacer.offer(53);
    pacer.close();
    vi.advanceTimersByTime(1000);
    pacer.offer(54);
    expect(sent).toEqual([1, 50, 52]);
    expect(pacer.waiting).toBe(false);
  });

  test('acknowledges a browser’s frames one an interval while it waits for them, the first at once', async () => {
    vi.useFakeTimers();
    const acks = new FrameAcks(100);
    // A browser that paints the next frame once the one before is acknowledged, as fast as it can.
    const acked: number[] = [];
    for (let frame = 0; frame < 10; frame++) {
      let done = false;
      void (acks.next() ?? Promise.resolve()).then(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1);
      acked.push(Date.now());
      await vi.advanceTimersByTimeAsync(16);
    }
    const gaps = acked.slice(1).map((at, i) => at - acked[i]!);
    // The first one at once, then one an interval, as the browser paints each one.
    expect(gaps[0]).toBeLessThanOrEqual(100);
    for (const gap of gaps.slice(1)) expect(gap).toBe(100);
  });

  test('holds one frame at a time, one interval at most, while another client acknowledges the others', async () => {
    vi.useFakeTimers();
    const acks = new FrameAcks(100);
    // A test's video acknowledges every frame at once: the browser paints at 60 a second whatever the view waits for.
    let waiting = 0;
    let most = 0;
    let longest = 0;
    for (let frame = 0; frame < 600; frame++) {
      const ack = acks.next();
      if (ack) {
        const asked = Date.now();
        waiting++;
        void ack.then(() => {
          waiting--;
          longest = Math.max(longest, Date.now() - asked);
        });
      }
      most = Math.max(most, waiting);
      await vi.advanceTimersByTimeAsync(1000 / 60);
    }
    // Ten seconds of frames: one held at a time, each one interval at most, and none left once they stop.
    expect(most).toBe(1);
    expect(longest).toBeLessThanOrEqual(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(waiting).toBe(0);
    expect(acks.holding).toBe(false);
  });

  test('lets the frame waiting go as the view stops, and every later one at once', async () => {
    vi.useFakeTimers();
    const acks = new FrameAcks(100);
    expect(acks.next()).toBeUndefined();
    const held = acks.next();
    expect(held).toBeInstanceOf(Promise);
    let released = false;
    void held!.then(() => (released = true));
    acks.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    expect(acks.next()).toBeUndefined();
    expect(acks.holding).toBe(false);
  });
});
