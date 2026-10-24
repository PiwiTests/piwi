import { actionPoint, boxInTopViewport, type FallbackReason, type InputOp, type Point } from '../shared/cdp-input.js';
import { t } from '../shared/i18n.js';
import { DomModel } from './engine-aria.js';
import { parentOf } from './hover-reveal.js';
import { OWN_HOST_IDS } from './record-ui.js';
import { optionFor, WHOLE_VALUE_TYPES } from './replay-actions.js';
import { quoted, wait } from './replay-core.js';
import type { FakeCursor } from './replay-cursor.js';

/**
 * The replay's actions as trusted input: this script finds the element and
 * the point to act on, and the background worker sends the mouse and keyboard
 * input through the debugging protocol (`piwi-replay-input`). The page gets
 * what a person's mouse and keyboard give it: a real `:hover`, focus moving as
 * the browser moves it, Enter submitting a form, a drag the browser runs.
 *
 * Filling a field follows Playwright: focus, select what it holds, insert the
 * text; date, time and color fields, which only take a whole value, get it set
 * with an `input` and a `change` event, and a `<select>` gets its option
 * chosen the same way, as Playwright's `selectOption` does.
 */

/** The worker could not send the input: the debugging session is gone or refused the command. */
export class TrustedInputLost extends Error {
  constructor(
    message: string,
    /** Whether some of the input reached the page before it failed. */
    readonly started: boolean,
    readonly reason: FallbackReason = 'lost',
  ) {
    super(message);
  }
}

/** An action that cannot be done with the pointer where it would land, with why. */
export class NotActionable extends Error {}

let replayId = '';

/** The replay whose input the worker sends; it checks the id against the running replay. */
export function setTrustedReplay(id: string): void {
  replayId = id;
}

async function send(ops: InputOp[]): Promise<void> {
  let answer: { ok: boolean; started?: boolean; error?: string; reason?: FallbackReason } | undefined;
  try {
    answer = await chrome.runtime.sendMessage({ type: 'piwi-replay-input', replayId, ops });
  } catch (e) {
    throw new TrustedInputLost(e instanceof Error ? e.message : String(e), false);
  }
  if (answer?.ok) return;
  throw new TrustedInputLost(answer?.error ?? t('common_workerNoAnswer'), answer?.started ?? false, answer?.reason);
}

/** The origin of each frame's content around `element`, innermost first, in its parent's viewport. */
function frameOrigins(element: Element): Point[] {
  const origins: Point[] = [];
  let win: Window | null = element.ownerDocument.defaultView;
  while (win && win !== window.top) {
    let frame: Element | null = null;
    try {
      frame = win.frameElement;
    } catch {
      frame = null;
    }
    if (!frame) break;
    const r = frame.getBoundingClientRect();
    origins.push({ x: r.left + frame.clientLeft, y: r.top + frame.clientTop });
    win = frame.ownerDocument.defaultView;
  }
  return origins;
}

/** Whether `hit`, what the browser finds at the point, is the element, inside it, or a label that acts for it. */
function reaches(element: Element, hit: Element | null): boolean {
  for (let n: Element | null = hit; n; n = parentOf(n)) {
    if (n === element) return true;
    if (n.tagName === 'LABEL' && (n as HTMLLabelElement).control === element) return true;
  }
  return false;
}

/** What the page shows at a point of the element's own frame, the extension's own surfaces aside. */
function hitAt(element: Element, x: number, y: number): Element | null {
  const doc = element.ownerDocument;
  let hit = doc.elementFromPoint(x, y);
  // Down through open shadow roots, as a pointer event reaches its target.
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

function describe(element: Element): string {
  const model = new DomModel();
  const name = model.accessibleName(element, false);
  const tag = element.tagName.toLowerCase();
  return name ? `${tag} ${quoted(name.slice(0, 60))}` : tag;
}

/** How long a covered element is waited for before the step gives up, as Playwright retries its hit check. */
const COVERED_WAIT_MS = 3_000;

/** The point to act on the element in its own frame's viewport; null when none of it is on screen. */
function localPoint(element: Element): Point | null {
  const win = element.ownerDocument.defaultView ?? window;
  return actionPoint(element.getBoundingClientRect(), { width: win.innerWidth, height: win.innerHeight });
}

/**
 * The point to act on the element, in the top viewport, once nothing covers
 * it: the element, something inside it, or its label must be what the
 * browser finds there. `requireHit` false takes the point as it is, for an
 * action that does not go through the pointer (a fill, a key press).
 * `scroll` false leaves the page where it is.
 */
async function pointFor(element: Element, requireHit = true, scroll = true): Promise<Point> {
  const deadline = Date.now() + COVERED_WAIT_MS;
  for (;;) {
    const local = localPoint(element);
    if (!local) {
      if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else {
      const hit = requireHit ? await withOwnSurfacesAside(() => hitAt(element, local.x, local.y)) : element;
      if (reaches(element, hit)) {
        const top = boxInTopViewport({ left: local.x, top: local.y, width: 0, height: 0 }, frameOrigins(element));
        return { x: top.left, y: top.top };
      }
      if (Date.now() >= deadline) {
        throw new NotActionable(
          hit
            ? t('replay_reasonCovered', { element: describe(element), other: describe(hit) })
            : t('replay_reasonOffscreen', { element: describe(element) }),
        );
      }
    }
    if (Date.now() >= deadline) throw new NotActionable(t('replay_reasonOffscreen', { element: describe(element) }));
    await wait(100);
  }
}

/** The request conditions' banner, drawn by another script, over the page like the extension's panels. */
const CONDITIONS_BANNER_ID = 'piwi-conditions-banner';

/**
 * Runs `fn` with the extension's own surfaces (the replay's panel, a
 * recorder's frame, the conditions' banner) letting the pointer through, so
 * input aimed at an element under one of them reaches the element, as the fake
 * cursor always does.
 */
async function withOwnSurfacesAside<T>(fn: () => T | Promise<T>): Promise<T> {
  const hosts = [...OWN_HOST_IDS, CONDITIONS_BANNER_ID]
    .map((id) => document.getElementById(id))
    .filter((host): host is HTMLElement => !!host);
  const before = hosts.map((host) => host.style.pointerEvents);
  for (const host of hosts) host.style.pointerEvents = 'none';
  try {
    return await fn();
  } finally {
    hosts.forEach((host, i) => {
      host.style.pointerEvents = before[i]!;
    });
  }
}

function sendAside(ops: InputOp[]): Promise<void> {
  return withOwnSurfacesAside(() => send(ops));
}

/** How long a press sent through the debugging protocol may take to reach the page before the step says it did not. */
const INPUT_REACH_MS = 1_000;

/**
 * Sends `ops` aside of the extension's surfaces, and throws `NotActionable`
 * when none of `types` reaches the window of `element`'s document within
 * {@link INPUT_REACH_MS}: the tab takes no input while a browser dialog is in
 * front of it.
 */
async function sendHeard(element: Element, ops: InputOp[], types: readonly string[]): Promise<void> {
  const view = element.ownerDocument.defaultView ?? window;
  let heard = false;
  const hear = (e: Event) => {
    if (e.isTrusted) heard = true;
  };
  for (const type of types) view.addEventListener(type, hear, { capture: true });
  try {
    await sendAside(ops);
    const deadline = Date.now() + INPUT_REACH_MS;
    while (!heard && Date.now() < deadline) await wait(20);
  } finally {
    for (const type of types) view.removeEventListener(type, hear, { capture: true });
  }
  if (!heard) throw new NotActionable(t('replay_reasonInputBlocked'));
}

const POINTER_HEARD = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
const KEY_HEARD = ['keydown', 'keyup'];

/**
 * The fake cursor glides to the point in the top viewport, where the real
 * pointer then goes; with `press`, it shows its press there before the point
 * is checked a last time, so the input follows that check at once.
 */
async function glide(
  element: Element,
  cursor: FakeCursor,
  caption: string,
  requireHit = true,
  press = false,
): Promise<Point> {
  const point = await pointFor(element, requireHit);
  const r = element.getBoundingClientRect();
  const origin = frameOrigins(element).reduce((sum, o) => ({ x: sum.x + o.x, y: sum.y + o.y }), { x: 0, y: 0 });
  cursor.outline({ left: r.left + origin.x, top: r.top + origin.y, width: r.width, height: r.height });
  await cursor.moveTo(point.x, point.y, caption);
  if (press) await cursor.press();
  // The page may have moved while the cursor glided.
  return pointFor(element, requireHit);
}

export async function trustedHover(
  element: Element,
  cursor: FakeCursor,
  caption: string,
  requireHit = true,
): Promise<void> {
  const point = await glide(element, cursor, caption, requireHit);
  cursor.outline(null);
  await sendAside([{ op: 'move', ...point }]);
}

export async function trustedClick(
  element: Element,
  cursor: FakeCursor,
  caption: string,
  count: 1 | 2 = 1,
): Promise<void> {
  const point = await glide(element, cursor, caption, true, true);
  cursor.outline(null);
  await sendHeard(element, [{ op: 'click', ...point, count }], POINTER_HEARD);
}

export async function trustedCheck(
  element: Element,
  checked: boolean,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  const input = element as HTMLInputElement;
  const current = () =>
    typeof input.checked === 'boolean' ? input.checked : element.getAttribute('aria-checked') === 'true';
  if (current() === checked) {
    await glide(element, cursor, caption);
    cursor.outline(null);
    return true;
  }
  await trustedClick(element, cursor, caption);
  await wait(50);
  return current() === checked;
}

function selectContents(element: HTMLElement): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.select();
    return;
  }
  const selection = element.ownerDocument.getSelection();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The editable element a fill types into: the element, or the editable host it is inside. */
function editableOf(element: Element): HTMLElement | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLElement && element.isContentEditable) {
    let host: HTMLElement = element;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  }
  return null;
}

export async function trustedFill(
  element: Element,
  value: string,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  await glide(element, cursor, caption, false);
  await cursor.press();
  cursor.outline(null);
  const editable = editableOf(element);
  if (!editable) return false;
  editable.focus({ preventScroll: true });
  if (editable instanceof HTMLInputElement && WHOLE_VALUE_TYPES.has(editable.type)) {
    editable.value = value;
    editable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    editable.dispatchEvent(new Event('change', { bubbles: true }));
    return editable.value === value;
  }
  selectContents(editable);
  await send(value ? [{ op: 'insertText', text: value }] : [{ op: 'press', combo: 'Delete' }]);
  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    await wait(0);
    return editable.value === value;
  }
  return true;
}

export async function trustedPress(
  element: Element | null,
  key: string,
  cursor: FakeCursor,
  caption: string,
): Promise<void> {
  if (element) {
    await glide(element, cursor, caption, false);
    cursor.outline(null);
    if (element instanceof HTMLElement && element.ownerDocument.activeElement !== element) {
      element.focus({ preventScroll: true });
    }
  }
  const ops: InputOp[] = [{ op: 'press', combo: key }];
  const heardIn = element ?? focusedElement();
  // Focus in a frame of another origin: the key goes there, where this script cannot hear it.
  if (heardIn) await sendHeard(heardIn, ops, KEY_HEARD);
  else await send(ops);
}

/** The element a key with no element goes to, through the frames of this origin; null in a frame of another. */
function focusedElement(): Element | null {
  let focused: Element | null = document.activeElement ?? document.documentElement;
  // By tag: a frame's elements come from its own window, which `instanceof` does not know.
  while (focused && (focused.tagName === 'IFRAME' || focused.tagName === 'FRAME')) {
    let inner: Document | null = null;
    try {
      inner = (focused as HTMLIFrameElement).contentDocument;
    } catch {
      inner = null;
    }
    if (!inner) return null;
    focused = inner.activeElement ?? inner.documentElement;
  }
  return focused;
}

/** A `<select>`: the pointer goes over it, and the option is chosen as Playwright's `selectOption` chooses it. */
export async function trustedSelect(
  element: Element,
  value: string,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  await trustedHover(element, cursor, caption, false);
  if (!(element instanceof HTMLSelectElement)) return false;
  const option = optionFor(element, value);
  if (!option) return false;
  element.focus({ preventScroll: true });
  element.value = option.value;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export async function trustedDrag(
  element: Element,
  target: Element,
  cursor: FakeCursor,
  caption: string,
): Promise<void> {
  // The target first: the press lands where the element is once both are on screen.
  await pointFor(target);
  const from = await glide(element, cursor, caption, true, true);
  // Bringing the element on screen may have scrolled the target away: the drag needs both at once.
  if (!localPoint(target)) {
    throw new NotActionable(t('replay_reasonDragApart', { element: describe(element), target: describe(target) }));
  }
  const to = await pointFor(target, true, false);
  const r = target.getBoundingClientRect();
  cursor.outline(r);
  await cursor.moveTo(to.x, to.y, caption);
  cursor.outline(null);
  await sendAside([{ op: 'drag', from, to }]);
}
