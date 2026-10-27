import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIEW_EVENTS, MAX_VIEW_EVENT_RATE, MAX_VIEW_TEXT, type ViewInput } from '@piwitests/core/run-view';
import { ViewInputBatcher, keyOnView, pastedText, type KeyPress } from '../../src/shared/view-input.js';

/**
 * The live view's input: which key presses go to the stopped page and as what, and the pointer's events in batches,
 * against fake timers.
 */

const key = (over: Partial<KeyPress>): KeyPress => ({
  key: 'a',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  altGraph: false,
  isComposing: false,
  ...over,
});
const pc = { mac: false, captured: false };
const mac = { mac: true, captured: false };
const press = (combo: string) => ({ send: { type: 'key', action: 'press', key: combo } });

describe('a key press on the live view', () => {
  it('types a character: printable ASCII as Playwright’s key, any other as text', () => {
    expect(keyOnView(key({ key: 'a' }), pc)).toEqual(press('a'));
    expect(keyOnView(key({ key: 'A', shiftKey: true }), pc)).toEqual(press('A'));
    expect(keyOnView(key({ key: ' ' }), pc)).toEqual(press(' '));
    expect(keyOnView(key({ key: 'é' }), pc)).toEqual({ send: { type: 'text', text: 'é' } });
    expect(keyOnView(key({ key: '😀' }), pc)).toEqual({ send: { type: 'text', text: '😀' } });
    // AltGr writes a character; Option on macOS does too.
    expect(keyOnView(key({ key: '€', ctrlKey: true, altKey: true, altGraph: true }), pc)).toEqual({
      send: { type: 'text', text: '€' },
    });
    expect(keyOnView(key({ key: 'å', altKey: true }), mac)).toEqual({ send: { type: 'text', text: 'å' } });
  });

  it('sends a named key, with Shift, and an editing shortcut with the system’s own key as ControlOrMeta', () => {
    expect(keyOnView(key({ key: 'Enter' }), pc)).toEqual(press('Enter'));
    expect(keyOnView(key({ key: 'ArrowLeft', shiftKey: true }), pc)).toEqual(press('Shift+ArrowLeft'));
    expect(keyOnView(key({ key: 'a', ctrlKey: true }), pc)).toEqual(press('ControlOrMeta+a'));
    expect(keyOnView(key({ key: 'a', metaKey: true }), mac)).toEqual(press('ControlOrMeta+a'));
    expect(keyOnView(key({ key: 'Z', ctrlKey: true, shiftKey: true }), pc)).toEqual(press('ControlOrMeta+Shift+z'));
    expect(keyOnView(key({ key: 'Backspace', ctrlKey: true }), pc)).toEqual(press('ControlOrMeta+Backspace'));
    expect(keyOnView(key({ key: 'Enter', metaKey: true }), mac)).toEqual(press('ControlOrMeta+Enter'));
    // Option and an arrow on macOS: a word.
    expect(keyOnView(key({ key: 'ArrowRight', altKey: true }), mac)).toEqual(press('Alt+ArrowRight'));
  });

  it('leaves the browser’s and the system’s shortcuts, and the function keys, to them', () => {
    for (const [pressed, on] of [
      [key({ key: 'l', ctrlKey: true }), pc],
      [key({ key: 't', ctrlKey: true }), pc],
      [key({ key: 'w', metaKey: true }), mac],
      [key({ key: 'v', ctrlKey: true }), pc],
      [key({ key: 'a', ctrlKey: true }), mac],
      [key({ key: 'Tab', ctrlKey: true }), { ...pc, captured: true }],
      [key({ key: 'ArrowLeft', altKey: true }), pc],
      [key({ key: 'f', altKey: true }), pc],
      [key({ key: 'ArrowLeft', metaKey: true, altKey: true }), mac],
      [key({ key: 'F5' }), pc],
      [key({ key: 'F12' }), pc],
      [key({ key: 'AudioVolumeUp' }), pc],
    ] as const) {
      expect(keyOnView(pressed, on), JSON.stringify(pressed)).toBe('window');
    }
  });

  it('gives Escape back to the window, and Tab to the page only while the view holds the keyboard', () => {
    expect(keyOnView(key({ key: 'Escape' }), { ...pc, captured: true })).toBe('leave');
    expect(keyOnView(key({ key: 'Tab' }), pc)).toBe('window');
    expect(keyOnView(key({ key: 'Tab', shiftKey: true }), pc)).toBe('window');
    expect(keyOnView(key({ key: 'Tab' }), { ...pc, captured: true })).toEqual(press('Tab'));
    expect(keyOnView(key({ key: 'Tab', shiftKey: true }), { ...pc, captured: true })).toEqual(press('Shift+Tab'));
  });

  it('sends nothing for a modifier alone, a dead key or an input method’s keys', () => {
    for (const pressed of [
      key({ key: 'Shift', shiftKey: true }),
      key({ key: 'Control', ctrlKey: true }),
      key({ key: 'Dead' }),
      key({ key: 'Process' }),
      key({ key: 'a', isComposing: true }),
      key({ key: '' }),
    ]) {
      expect(keyOnView(pressed, pc)).toBe('none');
    }
  });
});

describe('a paste on the live view', () => {
  it('is text, cut into the longest texts an event carries, nulls left out and lines kept', () => {
    expect(pastedText('a\r\nb\0c')).toEqual([{ type: 'text', text: 'a\nbc' }]);
    const long = 'x'.repeat(MAX_VIEW_TEXT * 2 + 5);
    expect(pastedText(long).map((e) => (e as { text: string }).text.length)).toEqual([MAX_VIEW_TEXT, MAX_VIEW_TEXT, 5]);
    expect(pastedText(long, 2)).toHaveLength(2);
    expect(pastedText('')).toEqual([]);
  });
});

describe('the live view’s input in batches', () => {
  let batches: ViewInput[][];
  let answer: (played: boolean) => void;
  let inFlight: number;
  let batcher: ViewInputBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    batches = [];
    inFlight = 0;
    answer = () => {};
    batcher = new ViewInputBatcher({
      send: (events) => {
        batches.push(events);
        inFlight++;
        return new Promise<boolean>((resolve) => {
          answer = (played) => {
            inFlight--;
            resolve(played);
          };
        });
      },
      now: () => Date.now(),
    });
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  /** The batch on its way is played, and the next one may go. */
  async function played(ok = true): Promise<void> {
    answer(ok);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('sends one batch every 50 ms at most, one on its way at a time, the pointer’s moves coalesced', async () => {
    batcher.move(1, 1);
    batcher.move(2, 2);
    batcher.move(3, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([[{ type: 'mouse', action: 'move', x: 3, y: 3 }]]);
    batcher.move(4, 4);
    batcher.key({ type: 'key', action: 'press', key: 'a' });
    batcher.move(5, 5);
    batcher.move(6, 6);
    await vi.advanceTimersByTimeAsync(200);
    // The batch before was not answered yet: nothing more went.
    expect(batches).toHaveLength(1);
    expect(inFlight).toBe(1);
    await played();
    await vi.advanceTimersByTimeAsync(50);
    expect(batches[1]).toEqual([
      { type: 'mouse', action: 'move', x: 4, y: 4 },
      { type: 'key', action: 'press', key: 'a' },
      { type: 'mouse', action: 'move', x: 6, y: 6 },
    ]);
  });

  it('sends a press released where it went down as a click, once no next click can make it a double click', async () => {
    batcher.down('left', 10, 20);
    batcher.move(11, 21);
    batcher.up('left', 11, 21);
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    expect(batches).toEqual([[{ type: 'mouse', action: 'click', x: 10, y: 20, button: 'left', clickCount: 1 }]]);
  });

  it('makes a second and a third click at the same place one double, then triple, click', async () => {
    for (let i = 0; i < 2; i++) {
      batcher.down('left', 50, 50);
      batcher.up('left', 50, 50);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toEqual([[{ type: 'mouse', action: 'click', x: 50, y: 50, button: 'left', clickCount: 2 }]]);
    await played();
    for (let i = 0; i < 3; i++) {
      batcher.down('left', 50, 50);
      batcher.up('left', 51, 50);
    }
    await vi.advanceTimersByTimeAsync(60);
    expect(batches[1]).toEqual([{ type: 'mouse', action: 'click', x: 50, y: 50, button: 'left', clickCount: 3 }]);
  });

  it('sends a click elsewhere, a key or the wheel after the click before, which waits no more', async () => {
    batcher.down('left', 10, 10);
    batcher.up('left', 10, 10);
    batcher.down('left', 300, 300);
    batcher.up('left', 300, 300);
    batcher.key({ type: 'text', text: 'hi' });
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([
      [
        { type: 'mouse', action: 'click', x: 10, y: 10, button: 'left', clickCount: 1 },
        { type: 'mouse', action: 'click', x: 300, y: 300, button: 'left', clickCount: 1 },
        { type: 'text', text: 'hi' },
      ],
    ]);
  });

  it('sends the right and the middle buttons’ clicks at once, and a drag as the button down, the moves and up', async () => {
    batcher.down('right', 5, 5);
    batcher.up('right', 5, 5);
    batcher.down('middle', 6, 6);
    batcher.up('middle', 6, 6);
    batcher.down('left', 10, 10);
    batcher.move(12, 12);
    batcher.move(40, 40);
    batcher.move(80, 60);
    batcher.up('left', 80, 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([
      [
        { type: 'mouse', action: 'click', x: 5, y: 5, button: 'right', clickCount: 1 },
        { type: 'mouse', action: 'click', x: 6, y: 6, button: 'middle', clickCount: 1 },
        { type: 'mouse', action: 'down', x: 10, y: 10, button: 'left' },
        { type: 'mouse', action: 'move', x: 80, y: 60 },
        { type: 'mouse', action: 'up', x: 80, y: 60, button: 'left' },
      ],
    ]);
  });

  it('adds the wheel’s turns up at the same place, each kept within what one event scrolls', async () => {
    batcher.wheel(10, 10, 0, 120);
    batcher.wheel(11, 10, 0, 120);
    batcher.wheel(10, 10, 30, 9_000);
    batcher.wheel(10, 10, 0, 9_000);
    batcher.wheel(500, 10, 0, -40.4);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([
      [
        { type: 'wheel', x: 10, y: 10, deltaX: 30, deltaY: 10_000 },
        { type: 'wheel', x: 500, y: 10, deltaX: 0, deltaY: -40 },
      ],
    ]);
  });

  it('joins a text typed after a text, within what one event carries', async () => {
    batcher.key({ type: 'text', text: 'é' });
    batcher.key({ type: 'text', text: 'à' });
    batcher.key({ type: 'text', text: 'x'.repeat(MAX_VIEW_TEXT) });
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]!.map((e) => (e as { text: string }).text.length)).toEqual([2, MAX_VIEW_TEXT]);
  });

  it('keeps at most a message’s events waiting, a move giving its place first', async () => {
    batcher.key({ type: 'key', action: 'press', key: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MAX_VIEW_EVENTS + 20; i++) {
      batcher.key({ type: 'key', action: 'press', key: 'b' });
      batcher.move(i, i);
    }
    await played();
    await vi.advanceTimersByTimeAsync(50);
    expect(batches[1]).toHaveLength(MAX_VIEW_EVENTS);
    expect(batches[1]!.every((e) => e.type === 'key')).toBe(true);
  });

  it('sends at most the rate a second, a batch past it waiting for the next second', async () => {
    for (let round = 0; round < MAX_VIEW_EVENT_RATE / MAX_VIEW_EVENTS; round++) {
      for (let i = 0; i < MAX_VIEW_EVENTS; i++) batcher.key({ type: 'key', action: 'press', key: 'c' });
      await vi.advanceTimersByTimeAsync(50);
      await played();
    }
    expect(batches.flat()).toHaveLength(MAX_VIEW_EVENT_RATE);
    const before = batches.length;
    batcher.key({ type: 'key', action: 'press', key: 'd' });
    await vi.advanceTimersByTimeAsync(300);
    expect(batches).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(800);
    expect(batches).toHaveLength(before + 1);
  });

  it('drops what waits when a batch is refused, and sends nothing once disposed', async () => {
    batcher.key({ type: 'key', action: 'press', key: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    batcher.key({ type: 'key', action: 'press', key: 'b' });
    await played(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toHaveLength(1);
    batcher.down('left', 1, 1);
    batcher.up('left', 1, 1);
    batcher.dispose();
    batcher.key({ type: 'key', action: 'press', key: 'c' });
    batcher.move(9, 9);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(1);
  });

  it('ends a drag the browser took the pointer from where it was, and a pending click with nothing', async () => {
    batcher.down('left', 1, 1);
    batcher.cancel(1, 1);
    batcher.down('left', 1, 1);
    batcher.move(50, 50);
    batcher.cancel(60, 60);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([
      [
        { type: 'mouse', action: 'down', x: 1, y: 1, button: 'left' },
        { type: 'mouse', action: 'move', x: 50, y: 50 },
        { type: 'mouse', action: 'up', x: 60, y: 60, button: 'left' },
      ],
    ]);
  });
});
