/**
 * The live view of a stopped page, which the run channel (`@piwitests/core/run-channel`) and the hub's WebSocket
 * (`@piwitests/core/run-hub`) carry: JPEG frames of the page as it paints, from a worker to the viewers that asked for
 * them, and the input a viewer plays on the page through it, a closed set of mouse, wheel, key and text events the
 * worker plays with `page.mouse` and `page.keyboard`. Every coordinate is in the CSS pixels of the page's viewport,
 * which each frame and each image of a stopped page names (`width`, `height`): a point on an image is
 * `x * width / naturalWidth`, whatever the image's own size or the page's device scale factor. Nothing here evaluates
 * code: a key is one of Playwright's key names, a text is inserted as typed text.
 */

/** The largest frame a view asks for, in pixels: a larger viewport is scaled down to fit. */
export const MAX_VIEW_WIDTH = 1280;
export const MAX_VIEW_HEIGHT = 800;
/** The JPEG quality a view asks for. */
export const VIEW_QUALITY = 60;
/** The longest frame sent, in bytes of JPEG: a longer one is dropped. */
export const MAX_VIEW_FRAME = 384 * 1024;
/** The longest frame's data, in characters of base64. */
export const MAX_VIEW_FRAME_BASE64 = 4 * Math.ceil(MAX_VIEW_FRAME / 3);
/** The most frames a view sends a second: a faster page has its latest frame sent at that pace, the others dropped. */
export const MAX_VIEW_FPS = 10;
/** The most input events one message carries. */
export const MAX_VIEW_EVENTS = 50;
/** The most input events played in a second, for each stop: a message past it is refused whole. */
export const MAX_VIEW_EVENT_RATE = 200;
/** The longest text one event inserts, in characters. */
export const MAX_VIEW_TEXT = 1000;
/** The largest coordinate an event or a pick names, in CSS pixels, and the largest viewport a frame names. */
export const MAX_VIEW_COORD = 10_000;
/** The largest scroll of one wheel event, in pixels each way. */
export const MAX_VIEW_WHEEL = 10_000;
/** The most keys a key press holds together: modifiers, then the key. */
const MAX_COMBO_KEYS = 5;

/** A mouse button, as Playwright names it. */
export type ViewButton = 'left' | 'right' | 'middle';

/** One event of a viewer's input, played on the stopped page in the order it comes. */
export type ViewInput =
  /** The pointer moves to `x`, `y`. */
  | { type: 'mouse'; action: 'move'; x: number; y: number }
  /**
   * The pointer moves to `x`, `y`, and a button goes down or up there: the `clickCount`th of a double or a triple click
   * when it says so (1 to 3, as the browser's `detail` counts them), which a worker that takes `input-clicks` plays.
   */
  | { type: 'mouse'; action: 'down' | 'up'; x: number; y: number; button: ViewButton; clickCount?: number }
  /** A click at `x`, `y`: 1 to 3 in a row (a double click is 2). */
  | { type: 'mouse'; action: 'click'; x: number; y: number; button: ViewButton; clickCount: number }
  /** The pointer moves to `x`, `y`, and the wheel scrolls there. */
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  /**
   * A key goes down, up, or is pressed (down, then up). A key is one of Playwright's key names (`Enter`, `ArrowLeft`,
   * `KeyA`, `ControlOrMeta`) or a printable ASCII character; a press may hold modifiers first (`Shift+Tab`,
   * `ControlOrMeta+a`).
   */
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string }
  /**
   * Text typed as one insertion, without key events: what no key name writes (`é`, an emoji, a paste). No control
   * character but a tab and a line break (`isViewTextControl`).
   */
  | { type: 'text'; text: string };

/**
 * Playwright's key names: the codes of its US keyboard layout (`KeyA`, `Digit1`, `Enter`, `ArrowLeft`), the modifiers
 * (`Shift`, `Control`, `Alt`, `Meta`, and `ControlOrMeta`, which is `Meta` on macOS), and the keys of the keypad.
 */
const KEY_NAMES: ReadonlySet<string> = new Set([
  'Escape',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'Backquote',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
  'Minus',
  'Equal',
  'Backslash',
  'Backspace',
  'Tab',
  'KeyQ',
  'KeyW',
  'KeyE',
  'KeyR',
  'KeyT',
  'KeyY',
  'KeyU',
  'KeyI',
  'KeyO',
  'KeyP',
  'BracketLeft',
  'BracketRight',
  'CapsLock',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyG',
  'KeyH',
  'KeyJ',
  'KeyK',
  'KeyL',
  'Semicolon',
  'Quote',
  'Enter',
  'ShiftLeft',
  'Shift',
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
  'KeyB',
  'KeyN',
  'KeyM',
  'Comma',
  'Period',
  'Slash',
  'ShiftRight',
  'ControlLeft',
  'Control',
  'MetaLeft',
  'Meta',
  'AltLeft',
  'Alt',
  'Space',
  'AltRight',
  'AltGraph',
  'MetaRight',
  'ContextMenu',
  'ControlRight',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'PageUp',
  'PageDown',
  'Insert',
  'Delete',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'AudioVolumeMute',
  'AudioVolumeDown',
  'AudioVolumeUp',
  'MediaTrackNext',
  'MediaTrackPrevious',
  'MediaPlayPause',
  'NumLock',
  'NumpadDivide',
  'NumpadMultiply',
  'NumpadSubtract',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'NumpadAdd',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad0',
  'NumpadDecimal',
  'NumpadEnter',
  'ControlOrMeta',
]);

/** The keys a press may hold before its key. */
const MODIFIERS: ReadonlySet<string> = new Set(['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta']);

/** Whether `char` is a control character a text never carries: a C0 one but a tab and a line break, or DEL. */
export function isViewTextControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
}

/** Whether `key` is one key Playwright plays: one of its key names, or a printable ASCII character. */
export function isViewKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 1) return key >= ' ' && key <= '~';
  return KEY_NAMES.has(key);
}

/**
 * Whether `combo` is a key press Playwright plays: a key, or modifiers then a key joined by `+` (`Shift+Tab`,
 * `ControlOrMeta++`), split as Playwright splits it.
 */
export function isViewKeyCombo(combo: unknown): combo is string {
  if (typeof combo !== 'string' || !combo || combo.length > 64) return false;
  const keys: string[] = [];
  let building = '';
  for (const char of combo) {
    if (char === '+' && building) {
      keys.push(building);
      building = '';
    } else {
      building += char;
    }
  }
  keys.push(building);
  if (keys.length > MAX_COMBO_KEYS) return false;
  const key = keys.pop()!;
  return isViewKey(key) && keys.every((modifier) => MODIFIERS.has(modifier));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite number from `min` to `max`. */
function isNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** Whether `x` and `y` are a point a view names: CSS pixels from 0 to `MAX_VIEW_COORD`. */
export function isViewPoint(x: unknown, y: unknown): boolean {
  return isNumber(x, 0, MAX_VIEW_COORD) && isNumber(y, 0, MAX_VIEW_COORD);
}

const BUTTONS: readonly string[] = ['left', 'right', 'middle'];

/** One event, checked field by field; why not, as a sentence, when it is not one. */
function readEvent(value: unknown): ViewInput | string {
  if (!isObject(value)) return 'is not an event.';
  const { type, action } = value;
  if (type === 'mouse' || type === 'wheel') {
    const { x, y } = value;
    if (!isViewPoint(x, y)) return `needs x and y, CSS pixels from 0 to ${MAX_VIEW_COORD}.`;
    const at = { x: x as number, y: y as number };
    if (type === 'wheel') {
      const { deltaX, deltaY } = value;
      if (!isNumber(deltaX, -MAX_VIEW_WHEEL, MAX_VIEW_WHEEL) || !isNumber(deltaY, -MAX_VIEW_WHEEL, MAX_VIEW_WHEEL)) {
        return `needs deltaX and deltaY, pixels from -${MAX_VIEW_WHEEL} to ${MAX_VIEW_WHEEL}.`;
      }
      return { type, ...at, deltaX, deltaY };
    }
    if (action === 'move') return { type, action, ...at };
    if (action !== 'down' && action !== 'up' && action !== 'click') {
      return 'is a mouse event whose action is not move, down, up or click.';
    }
    const button = value.button === undefined ? 'left' : value.button;
    if (typeof button !== 'string' || !BUTTONS.includes(button))
      return 'names a button other than left, right or middle.';
    const clickCount = value.clickCount === undefined && action !== 'click' ? undefined : (value.clickCount ?? 1);
    if (clickCount !== undefined && (!isNumber(clickCount, 1, 3) || !Number.isInteger(clickCount))) {
      return 'needs a clickCount from 1 to 3.';
    }
    if (action !== 'click') {
      return { type, action, ...at, button: button as ViewButton, ...(clickCount === undefined ? {} : { clickCount }) };
    }
    return { type, action, ...at, button: button as ViewButton, clickCount: clickCount! };
  }
  if (type === 'key') {
    if (action !== 'down' && action !== 'up' && action !== 'press') {
      return 'is a key event whose action is not down, up or press.';
    }
    const { key } = value;
    const known = action === 'press' ? isViewKeyCombo(key) : isViewKey(key);
    return known
      ? { type, action, key: key as string }
      : `names a key Playwright does not play: ${JSON.stringify(String(key).slice(0, 64))}.`;
  }
  if (type === 'text') {
    const { text } = value;
    if (typeof text !== 'string' || !text || text.length > MAX_VIEW_TEXT || [...text].some(isViewTextControl)) {
      return `needs a text of 1 to ${MAX_VIEW_TEXT} characters, with no control character but a tab or a line break.`;
    }
    return { type, text };
  }
  return 'is of a type other than mouse, wheel, key or text.';
}

/**
 * A viewer's input, checked event by event: 1 to `MAX_VIEW_EVENTS` events; why not, as a sentence, when one of them is
 * not an event this version plays.
 */
export function readViewInput(value: unknown): ViewInput[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'The input needs its events.';
  if (value.length > MAX_VIEW_EVENTS) return `The input carries ${MAX_VIEW_EVENTS} events at most.`;
  const events: ViewInput[] = [];
  for (const [i, raw] of value.entries()) {
    const event = readEvent(raw);
    if (typeof event === 'string') return `Event ${i + 1} ${event}`;
    events.push(event);
  }
  return events;
}

/** Base64, as a frame's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` is a frame's data: base64, not empty, at most `MAX_VIEW_FRAME_BASE64` characters. */
export function isViewFrameData(data: unknown): data is string {
  return typeof data === 'string' && data.length > 0 && data.length <= MAX_VIEW_FRAME_BASE64 && BASE64.test(data);
}

/** Whether `width` and `height` name a viewport: whole CSS pixels from 1 to `MAX_VIEW_COORD`. */
export function isViewSize(width: unknown, height: unknown): boolean {
  return (
    isNumber(width, 1, MAX_VIEW_COORD) &&
    Number.isInteger(width) &&
    isNumber(height, 1, MAX_VIEW_COORD) &&
    Number.isInteger(height)
  );
}

/** The frame size a view of a viewport asks for: the viewport, scaled down to fit `MAX_VIEW_WIDTH` by `MAX_VIEW_HEIGHT`. */
export function viewSize(viewport: { width: number; height: number }): { width: number; height: number } {
  return fitViewSize(viewport, MAX_VIEW_WIDTH, MAX_VIEW_HEIGHT);
}

/** A viewport scaled down, its proportions kept, to fit `maxWidth` by `maxHeight` pixels; a smaller one as it is. */
export function fitViewSize(
  viewport: { width: number; height: number },
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const width = Math.max(2, Math.round(viewport.width));
  const height = Math.max(2, Math.round(viewport.height));
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(2, Math.floor(width * scale)), height: Math.max(2, Math.floor(height * scale)) };
}

/** At most `limit` units in each second: `take(n)` says whether `n` more fit, and counts them when they do. */
export class RateWindow {
  private start = -Infinity;
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(n: number): boolean {
    const at = this.now();
    if (at - this.start >= 1000) {
      this.start = at;
      this.used = 0;
    }
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
}

export interface LatestPacerOptions<T> {
  /** The least time between two sends. */
  intervalMs: number;
  /** The least time after `item` went before the next one goes, when longer than `intervalMs`: a heavier item waits longer. */
  spacing?(item: T): number;
  send(item: T): void;
  /** Whether the way out is backed up: the item waits, and the latest one goes once it is not. */
  busy?(): boolean;
  now?(): number;
}

/**
 * Sends the latest item offered, at most one each `intervalMs` (longer after an item its `spacing` holds longer) and
 * none while `busy`: an item offered before the one waiting went takes its place, so one waits at most, whatever comes
 * in.
 */
export class LatestPacer<T> {
  private pending: { item: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = -Infinity;
  /** The least time after the item sent last before the next goes. */
  private gap: number;
  private closed = false;

  constructor(private readonly options: LatestPacerOptions<T>) {
    this.gap = options.intervalMs;
  }

  offer(item: T): void {
    if (this.closed) return;
    this.pending = { item };
    this.pump();
  }

  /** Whether an item waits. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** Send the item waiting when its time came and the way out is free; else try again later. */
  pump(): void {
    if (this.closed || !this.pending || this.timer) return;
    const now = this.options.now?.() ?? Date.now();
    const wait = this.last + this.gap - now;
    const busy = wait <= 0 && !!this.options.busy?.();
    if (wait > 0 || busy) {
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.pump();
        },
        busy ? this.options.intervalMs : wait,
      );
      (this.timer as { unref?: () => void }).unref?.();
      return;
    }
    const { item } = this.pending;
    this.pending = null;
    this.last = now;
    this.gap = Math.max(this.options.intervalMs, this.options.spacing?.(item) ?? 0);
    this.options.send(item);
  }

  /** Nothing more is sent: the item waiting is dropped. */
  close(): void {
    this.closed = true;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * When a view acknowledges its page's screencast frames: one each `intervalMs` at most, so a browser that waits for a
 * frame's acknowledgment before it paints the next one (Chromium, Firefox) paints no more for the view alone. `next()`
 * is what the screencast's `onFrame` returns for a frame: nothing, to acknowledge it at once, or a promise that settles
 * once it is acknowledged. One frame waits at a time, one interval at most: a frame that comes while one waits was
 * not waited for (another client of the page's screencast, a test's video or its trace's images, acknowledged the one
 * before at once), and is acknowledged at once, so no frame the view does not send is held.
 */
export class FrameAcks {
  private due = -Infinity;
  private waiting: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;
  private closed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  next(): Promise<void> | undefined {
    if (this.closed || this.waiting) return undefined;
    const now = this.now();
    this.due = Math.min(Math.max(now, this.due + this.intervalMs), now + this.intervalMs);
    if (this.due <= now) return undefined;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.release(), this.due - now);
      (timer as { unref?: () => void }).unref?.();
      this.waiting = { timer, resolve };
    });
  }

  /** Whether a frame waits for its acknowledgment. */
  get holding(): boolean {
    return this.waiting !== null;
  }

  /** The frame waiting is acknowledged now, and every later one at once. */
  close(): void {
    this.closed = true;
    this.release();
  }

  private release(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.resolve();
  }
}
