/**
 * The input the Runs window plays on a stopped page through its live view (`@piwitests/core/run-view`): which key
 * presses go to the page and as what (`viewKey`), and the pointer's moves, presses and wheel turned into the view's
 * events and sent in batches (`ViewInputBatcher`). Pure: the window reads the browser's events into these, and sends
 * what comes out. Every point is in CSS pixels of the page's viewport.
 */
import {
  MAX_VIEW_EVENTS,
  MAX_VIEW_EVENT_RATE,
  MAX_VIEW_TEXT,
  MAX_VIEW_WHEEL,
  RateWindow,
  VIEW_TEXT_CONTROL,
  isViewKeyCombo,
  type ViewButton,
  type ViewInput,
} from '@piwitests/core/run-view';

/** A key press on the view, as the browser's `keydown` names it. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** AltGr held, which some layouts write a character with: Control and Alt as one key. */
  altGraph: boolean;
  /** An input method composes a character: its keys are its own. */
  isComposing: boolean;
}

/**
 * What a key press on the view does: it goes to the page (`send`); Escape gives the keyboard back to the window
 * (`leave`); it stays the window's or the browser's (`window`: Tab while the view does not hold the keyboard, a
 * function key, a shortcut of the browser or the system); or it is no key of its own (`none`: a modifier alone, a
 * dead key).
 */
export type KeyOnView = { send: ViewInput } | 'leave' | 'window' | 'none';

/** Keys that are no key press of their own: they hold, lock or compose another one. */
const NO_KEY = new Set([
  '',
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Process',
  'Unidentified',
  'Compose',
]);

/** The keys that edit or move in a text: with Control (⌘ on macOS) they act on a word or a line. */
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
/** The keys that go to the page by their name, alone or with Shift. */
const NAMED_KEYS = new Set([...EDIT_KEYS, 'Enter', 'Tab', 'PageUp', 'PageDown', 'Insert', 'ContextMenu']);
/** The letters a shortcut with Control (⌘ on macOS) sends: select all, undo and redo. */
const EDIT_LETTERS = new Set(['a', 'y', 'z']);

function pressed(combo: string): KeyOnView {
  return isViewKeyCombo(combo) ? { send: { type: 'key', action: 'press', key: combo } } : 'window';
}

/**
 * What a key press on the view sends the page. A character goes as Playwright's key when it is printable ASCII, else
 * as text; a named key (Enter, the arrows, Backspace) as a press, with Shift; Control on Windows and Linux, ⌘ on macOS,
 * goes as `ControlOrMeta`, and only with the editing keys, Enter, A, Y and Z: every other shortcut stays the
 * browser's, as do Alt's outside macOS (where Option writes a character, or moves by a word) and the function keys.
 * Tab goes to the page only while the view holds the keyboard (`captured`); Escape always gives it back.
 */
export function keyOnView(press: KeyPress, options: { mac: boolean; captured: boolean }): KeyOnView {
  const { key } = press;
  if (press.isComposing || NO_KEY.has(key)) return 'none';
  if (key === 'Escape') return 'leave';
  if (/^F\d{1,2}$/.test(key)) return 'window';
  if (key === 'Tab' && !options.captured) return 'window';
  const primary = options.mac ? press.metaKey : press.ctrlKey;
  /** The system's or the browser's: the other of Control and ⌘, and Alt but on macOS. */
  const other = !press.altGraph && ((options.mac ? press.ctrlKey : press.metaKey) || (!options.mac && press.altKey));
  const character = [...key].length === 1;
  // A control character is no text to type.
  if (character && key.search(VIEW_TEXT_CONTROL) >= 0) return 'none';
  if (character && (press.altGraph || (!primary && !other))) {
    return { send: key >= ' ' && key <= '~' ? { type: 'key', action: 'press', key } : { type: 'text', text: key } };
  }
  if (other || (primary && press.altKey)) return 'window';
  const shift = press.shiftKey ? 'Shift+' : '';
  if (primary) {
    const letter = character ? key.toLowerCase() : '';
    if (EDIT_LETTERS.has(letter)) return pressed(`ControlOrMeta+${shift}${letter}`);
    return EDIT_KEYS.has(key) || key === 'Enter' ? pressed(`ControlOrMeta+${shift}${key}`) : 'window';
  }
  if (!NAMED_KEYS.has(key)) return 'window';
  // Option on macOS: by a word.
  if (press.altKey) return EDIT_KEYS.has(key) ? pressed(`Alt+${shift}${key}`) : 'window';
  return pressed(`${shift}${key}`);
}

/** A browser's click count (`detail`) as a view's: 1 to 3, a synthetic press's 0 as 1, a fourth click as a third. */
function countOf(detail: number | undefined): number {
  return detail !== undefined && Number.isFinite(detail) ? Math.min(3, Math.max(1, Math.round(detail))) : 1;
}

/**
 * The pasted text as the view's events: text of at most `MAX_VIEW_TEXT` characters each, `max` of them at most, its
 * line breaks as `\n` and its other control characters but a tab left out.
 */
export function pastedText(text: string, max = MAX_VIEW_EVENTS): ViewInput[] {
  const chars = [...text.replace(/\r\n?/g, '\n').replace(VIEW_TEXT_CONTROL, '')];
  const events: ViewInput[] = [];
  for (let at = 0; at < chars.length && events.length < max; at += MAX_VIEW_TEXT) {
    events.push({ type: 'text', text: chars.slice(at, at + MAX_VIEW_TEXT).join('') });
  }
  return events;
}

/** A key held with a click, which goes down before it and up after it: Shift+click picks instead. */
export type ViewModifier = 'Control' | 'Alt' | 'Meta';

/** What a button's press carries beside its point: the browser's click count (`detail`), and the keys held with it. */
export interface PressKeys {
  count?: number;
  modifiers?: readonly ViewModifier[];
}

export interface ViewInputOptions {
  /** Sends a batch, at most `MAX_VIEW_EVENTS` events; resolves once it was played (`true`) or refused. */
  send(events: ViewInput[]): Promise<boolean>;
  /**
   * Whether the stop plays a click count on a button's `down` and `up` (`input-clicks`): each press goes at once as
   * the browser counted it, a double click included. Without it, a click is held for `doubleClickMs`.
   */
  clickCounts?: boolean;
  /** The least time between two batches. */
  intervalMs?: number;
  /** How long a click waits for the next one of a double or a triple click, at the same place. */
  doubleClickMs?: number;
  /** How far the pointer may go, in CSS pixels of the page, for a press to stay a click. */
  slop?: number;
  now?(): number;
}

/**
 * A button pressed on the view: not sent yet, a click once released or a drag once the pointer goes; or sent at once
 * (`dragging`), as `down` with its click count. The keys held with it go down before it and up after it.
 */
interface Press {
  button: ViewButton;
  x: number;
  y: number;
  dragging: boolean;
  modifiers: readonly ViewModifier[];
}

/** A click sent once no next click can make it a double click: the count it has, and until when it waits. */
interface HeldClick {
  button: ViewButton;
  x: number;
  y: number;
  count: number;
  until: number;
}

/**
 * The view's input in batches, one about every `intervalMs`, one on its way at a time: the pointer's moves coalesced to
 * the latest, the wheel's turns added up, a text typed after a text joined to it. Where the stop plays click counts
 * (`clickCounts`), a button's `down` and `up` go as they come, each with the browser's click count, so a double click
 * is the system's own. Elsewhere a press goes as a click when it is released where it went down, or as a drag
 * (`down`, the moves, `up`) once the pointer leaves that place, and a click is held for `doubleClickMs` so that the
 * next click there makes it a double (then a triple) click. Control, Alt or Meta held with a press goes down before it
 * and up after it. At most `MAX_VIEW_EVENTS` events wait, and `MAX_VIEW_EVENT_RATE` go in a second; past them, a move
 * is dropped first. Nothing is sent once `dispose` was called.
 */
export class ViewInputBatcher {
  private queue: ViewInput[] = [];
  private press: Press | null = null;
  private held: HeldClick | null = null;
  private sending = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the timer set is due. */
  private timerAt = Infinity;
  private last = -Infinity;
  private readonly rate: RateWindow;
  private readonly intervalMs: number;
  private readonly doubleClickMs: number;
  private readonly slop: number;
  private readonly clickCounts: boolean;
  private readonly now: () => number;

  constructor(private readonly options: ViewInputOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 50;
    this.doubleClickMs = options.doubleClickMs ?? 250;
    this.slop = options.slop ?? 4;
    this.clickCounts = options.clickCounts ?? false;
    this.rate = new RateWindow(MAX_VIEW_EVENT_RATE, this.now);
  }

  /** The pointer moved to `x`, `y`, a button held or not. */
  move(x: number, y: number): void {
    if (this.disposed) return;
    const press = this.press;
    if (press && !press.dragging) {
      if (!this.far(press, x, y)) return;
      // A drag: the button goes down where it was pressed, then follows the pointer.
      this.release();
      press.dragging = true;
      this.hold(press.modifiers);
      this.add({ type: 'mouse', action: 'down', x: press.x, y: press.y, button: press.button });
    } else if (!press && this.held) {
      if (!this.far(this.held, x, y)) return;
      this.release();
    }
    const tail = this.queue[this.queue.length - 1];
    if (tail?.type === 'mouse' && tail.action === 'move') this.queue[this.queue.length - 1] = { ...tail, x, y };
    else this.add({ type: 'mouse', action: 'move', x, y });
  }

  /**
   * A button went down at `x`, `y`: sent at once with its click count where the stop plays them; elsewhere nothing is
   * sent until the pointer goes or the button comes up.
   */
  down(button: ViewButton, x: number, y: number, keys: PressKeys = {}): void {
    if (this.disposed) return;
    if (this.press) this.up(this.press.button, x, y);
    const modifiers = [...(keys.modifiers ?? [])];
    if (this.clickCounts) {
      this.hold(modifiers);
      this.add({ type: 'mouse', action: 'down', x, y, button, clickCount: countOf(keys.count) });
      this.press = { button, x, y, dragging: true, modifiers };
      return;
    }
    const held = this.held;
    if (held && (held.button !== button || this.far(held, x, y) || modifiers.length)) this.release();
    this.press = { button, x, y, dragging: false, modifiers };
  }

  /** A button came up at `x`, `y`: sent at once where the stop plays click counts; the end of a drag, or a click. */
  up(button: ViewButton, x: number, y: number, keys: PressKeys = {}): void {
    if (this.disposed) return;
    const press = this.press;
    if (!press || press.button !== button) return;
    this.press = null;
    if (this.clickCounts) {
      this.add({ type: 'mouse', action: 'up', x, y, button, clickCount: countOf(keys.count) });
      this.letGo(press.modifiers);
      return;
    }
    if (press.dragging) {
      this.add({ type: 'mouse', action: 'up', x, y, button });
      this.letGo(press.modifiers);
      return;
    }
    if (press.modifiers.length) {
      // A click with a key held goes at once, the key held around it.
      this.release();
      this.hold(press.modifiers);
      this.add({ type: 'mouse', action: 'click', x: press.x, y: press.y, button, clickCount: 1 });
      this.letGo(press.modifiers);
      return;
    }
    const held = this.held;
    const count = held && held.button === button && !this.far(held, press.x, press.y) ? held.count + 1 : 1;
    if (held && count === 1) this.release();
    this.held = null;
    if (button === 'left' && count < 3) {
      this.held = { button, x: press.x, y: press.y, count, until: this.now() + this.doubleClickMs };
      this.schedule();
    } else {
      this.add({ type: 'mouse', action: 'click', x: press.x, y: press.y, button, clickCount: count });
    }
  }

  /** The pointer left without its button coming up (the browser took it): a button sent down comes up where it was. */
  cancel(x: number, y: number): void {
    if (this.disposed || !this.press) return;
    const press = this.press;
    this.press = null;
    if (!press.dragging) return;
    this.add({ type: 'mouse', action: 'up', x, y, button: press.button });
    this.letGo(press.modifiers);
  }

  /** The wheel turned over `x`, `y`: turns in a row at the same place add up. */
  wheel(x: number, y: number, deltaX: number, deltaY: number): void {
    if (this.disposed) return;
    this.release();
    const clamp = (delta: number) => Math.max(-MAX_VIEW_WHEEL, Math.min(MAX_VIEW_WHEEL, Math.round(delta)));
    const tail = this.queue[this.queue.length - 1];
    if (tail?.type === 'wheel' && !this.far(tail, x, y)) {
      this.queue[this.queue.length - 1] = {
        ...tail,
        deltaX: clamp(tail.deltaX + deltaX),
        deltaY: clamp(tail.deltaY + deltaY),
      };
      return;
    }
    this.add({ type: 'wheel', x, y, deltaX: clamp(deltaX), deltaY: clamp(deltaY) });
  }

  /** A key or a text, after what came before it. */
  key(input: ViewInput): void {
    if (this.disposed) return;
    this.release();
    const tail = this.queue[this.queue.length - 1];
    if (
      input.type === 'text' &&
      tail?.type === 'text' &&
      [...tail.text].length + [...input.text].length <= MAX_VIEW_TEXT
    ) {
      this.queue[this.queue.length - 1] = { type: 'text', text: tail.text + input.text };
      return;
    }
    this.add(input);
  }

  /** Nothing more is sent: what waits is dropped. */
  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.press = null;
    this.held = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The keys held with a press go down, before it. */
  private hold(modifiers: readonly ViewModifier[]): void {
    for (const key of modifiers) this.add({ type: 'key', action: 'down', key });
  }

  /** The keys held with a press come up, after it, the last one first. */
  private letGo(modifiers: readonly ViewModifier[]): void {
    for (const key of [...modifiers].reverse()) this.add({ type: 'key', action: 'up', key });
  }

  /** Whether the point is farther than a click allows from where a press or a click was. */
  private far(from: { x: number; y: number }, x: number, y: number): boolean {
    return Math.abs(from.x - x) > this.slop || Math.abs(from.y - y) > this.slop;
  }

  /** The held click goes in its place: no next click makes it a double click now. */
  private release(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.add({ type: 'mouse', action: 'click', x: held.x, y: held.y, button: held.button, clickCount: held.count });
  }

  private add(input: ViewInput): void {
    if (this.queue.length >= MAX_VIEW_EVENTS) {
      // Full: a move waiting gives its place, else this one is dropped.
      const move = this.queue.findIndex((e) => e.type === 'mouse' && e.action === 'move');
      if (move < 0 || (input.type === 'mouse' && input.action === 'move')) return;
      this.queue.splice(move, 1);
    }
    this.queue.push(input);
    this.schedule();
  }

  /** Sets the timer for what is due first: the next batch, or the held click; an earlier one takes a later one's place. */
  private schedule(): void {
    if (this.disposed || this.sending) return;
    if (!this.queue.length && !this.held) return;
    const due = Math.min(this.queue.length ? this.last + this.intervalMs : Infinity, this.held?.until ?? Infinity);
    if (this.timer && this.timerAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = due;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(0, due - this.now()),
    );
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.sending) return;
    if (this.held && this.now() >= this.held.until) this.release();
    const now = this.now();
    if (!this.queue.length || now < this.last + this.intervalMs) return this.schedule();
    const batch = this.queue.slice(0, MAX_VIEW_EVENTS);
    if (!this.rate.take(batch.length)) {
      this.last = now;
      return this.schedule();
    }
    this.queue = this.queue.slice(batch.length);
    this.last = now;
    this.sending = true;
    const played = await this.options.send(batch).catch(() => false);
    this.sending = false;
    // Refused (the stop ended, the view stopped): what waited is the stop's, and goes with it.
    if (!played) this.queue = [];
    this.schedule();
  }
}
