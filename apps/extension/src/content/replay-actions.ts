import { safeLocator, stepLocator } from '@piwitests/core/codegen';
import { parseLocatorChain } from '@piwitests/core/locator-chain';
import type { RecordedStep, RecordedTarget } from '@piwitests/core/recording';
import { t, tn } from '../shared/i18n.js';
import { createLocatorEngine, type LocatorEngine } from './locator-engine.js';
import { LocatorEngineError } from './engine-selector.js';
import { endHoverEmulation, hoverElement } from './hover-emulation.js';
import { parentOf } from './hover-reveal.js';
import { isOwnHost } from './record-ui.js';
import type { FakeCursor } from './replay-cursor.js';
import { chooseElement, wait, type Observation } from './replay-core.js';

/**
 * How the replay finds each step's element and acts on it in the page.
 *
 * The element is looked for with every locator it was recorded with, the one
 * the generated spec would use (`stepLocator`) first, each resolved by the
 * in-page engine; the element they agree on (`chooseElement`) is waited for as
 * Playwright waits: visible, enabled, and still in place across two frames.
 * This file's actions are the page's own events, the replay's fallback where
 * trusted input (`replay-trusted.ts`) is not there: Firefox, a browser that
 * refused the debugging session, or a person who cancelled its bar.
 */

/** How long a step waits for its element, and an assertion for its result. */
export const ACTION_TIMEOUT_MS = 10_000;
export const ASSERT_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * How long the page must stay still before the replay acts: no change to its
 * DOM and no new request. An app rendered on the server ignores input until it
 * has hydrated, and hydrating writes its own state back over whatever was
 * typed before; a person never acts that fast after a page appears.
 */
const QUIET_MS = 400;
const LOAD_QUIET_MAX_MS = 10_000;
const STEP_QUIET_MS = 250;
const STEP_QUIET_MAX_MS = 3_000;

function isOwnNode(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !!element && isOwnHost(element);
}

/** Resolves once the page has gone `quietMs` without a DOM change or a new request, or after `maxMs`. */
async function waitForQuiet(quietMs: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = Date.now();
  const mutations = new MutationObserver((records) => {
    if (records.some((r) => !isOwnNode(r.target))) last = Date.now();
  });
  mutations.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  let requests: PerformanceObserver | null = null;
  try {
    requests = new PerformanceObserver(() => {
      last = Date.now();
    });
    requests.observe({ type: 'resource' });
  } catch {
    requests = null;
  }
  try {
    while (Date.now() < deadline && Date.now() - last < quietMs) await wait(50);
  } finally {
    mutations.disconnect();
    requests?.disconnect();
  }
}

/** Waits for a page that has just opened: its load, then a quiet moment. */
export async function waitForPageReady(): Promise<void> {
  if (document.readyState !== 'complete') {
    await Promise.race([
      new Promise((resolve) => window.addEventListener('load', resolve, { once: true })),
      wait(LOAD_QUIET_MAX_MS),
    ]);
  }
  await waitForQuiet(QUIET_MS, LOAD_QUIET_MAX_MS);
}

/** Waits, briefly, for what the last step started (a request, a re-render) to finish. */
export function waitForStepReady(): Promise<void> {
  return waitForQuiet(STEP_QUIET_MS, STEP_QUIET_MAX_MS);
}

/** The locator the spec would write for a step, or null when none was recorded. */
export function locatorFor(step: RecordedStep): string | null {
  return stepLocator(step.target, { locators: 'stable' });
}

/**
 * Every locator an element was recorded with, as the spec writes them: the
 * spec's own first, then the others in their recorded rank.
 */
export function locatorsOf(target: RecordedTarget | null | undefined): string[] {
  if (!target) return [];
  const others = target.alternatives.flatMap((alt) => {
    const safe = safeLocator(alt.locator);
    return safe ? [safe.text] : [];
  });
  return [...new Set([stepLocator(target, { locators: 'stable' }), ...others])].filter((l): l is string => !!l);
}

/** Whether an element another locator finds is the kind recorded: the same tag, or the same role. */
function fitsTarget(engine: LocatorEngine, element: Element, target: RecordedTarget): boolean {
  if (element.tagName.toLowerCase() === target.tagName.toLowerCase()) return true;
  return target.role != null && engine.model.role(element) === target.role;
}

/**
 * An engine over the page as it is now, blind to the extension's own surfaces.
 * Its caches hold for one look at the page: one per poll, shared by the
 * locators that poll looks for. A strict one refuses a frame part that finds
 * more than one frame, as an action and an assertion other than a count do.
 */
export function pageEngine(options: { strict?: boolean } = {}): LocatorEngine {
  return createLocatorEngine(document, { ignore: isOwnHost, strict: options.strict });
}

/** Every element a locator finds on the page now, the extension's own surfaces left out. */
export function findAll(locator: string, engine = pageEngine()): Element[] {
  try {
    return engine.queryAll(parseLocatorChain(locator));
  } catch {
    return [];
  }
}

/**
 * The element a step acts on, the locator that found it (the spec's own, or
 * another recorded one when the spec's finds nothing, more than one element,
 * or one the others disagree with) and how many the spec's own found.
 */
export type Resolution =
  | { ok: true; element: Element; locator: string; specCount: number }
  | { ok: false; reason: string };

function sameRect(a: DOMRect, b: DOMRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/**
 * Waits until the step's element can take the action, and answers it with
 * the locator that found it; or, after `timeout`, why it could not, in the
 * words of the spec's own locator. `target` is the element looked for: the
 * step's own, or where a `dragTo` step drops.
 */
export async function resolveForAction(
  step: RecordedStep,
  timeout = ACTION_TIMEOUT_MS,
  target: RecordedTarget | null = step.target,
): Promise<Resolution> {
  const locators = locatorsOf(target);
  const primary = locators[0];
  if (!primary || !target) return { ok: false, reason: t('replay_reasonNoLocator') };
  const deadline = Date.now() + timeout;
  let reason = '';
  for (;;) {
    const engine = pageEngine({ strict: true });
    let frames = 0;
    const looks = locators.map((locator, rank) => {
      try {
        return { locator, found: engine.queryAll(parseLocatorChain(locator)) };
      } catch (e) {
        if (rank === 0) frames = e instanceof LocatorEngineError ? (e.matched ?? 0) : 0;
        return { locator, found: [] };
      }
    });
    const choice = chooseElement(looks, (element) => fitsTarget(engine, element, target));
    const model = engine.model;
    const spec = looks[0]!.found.length;
    if (!choice) {
      if (frames > 1) reason = tn('replay_reasonManyMatches', frames, { locator: primary });
      else if (spec === 0) reason = t('replay_reasonNoMatch', { locator: primary });
      else reason = tn('replay_reasonManyMatches', spec, { locator: primary });
    } else {
      const { element, locator } = choice;
      // A file field is often hidden behind a button of its own; Playwright sets its files all the same.
      if (step.action === 'setInputFiles') return { ok: true, element, locator, specCount: spec };
      if (!model.isVisible(element)) reason = t('replay_reasonHidden', { locator });
      else if (step.action !== 'hover' && model.disabled(element)) reason = t('replay_reasonDisabled', { locator });
      else {
        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        const before = element.getBoundingClientRect();
        await nextFrame();
        await nextFrame();
        if (element.isConnected && sameRect(before, element.getBoundingClientRect())) {
          return { ok: true, element, locator, specCount: spec };
        }
        reason = t('replay_reasonMoving', { locator });
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason };
    await wait(POLL_MS);
  }
}

/** What the page shows for an assertion step's element, or for the page itself. */
export function observe(step: RecordedStep, engine = pageEngine()): Observation {
  const url = location.href;
  const locator = step.assertion?.matcher === 'toHaveURL' ? null : locatorFor(step);
  const found = locator ? findAll(locator, engine) : [];
  const first = found[0];
  if (!first) {
    return { count: 0, text: null, value: null, name: null, visible: false, enabled: false, checked: false, url };
  }
  const model = engine.model;
  const value =
    'value' in first && typeof (first as HTMLInputElement).value === 'string'
      ? (first as HTMLInputElement).value
      : null;
  return {
    count: found.length,
    text: first.textContent,
    value,
    name: model.accessibleName(first, false),
    visible: model.isVisible(first),
    enabled: !model.disabled(first),
    checked: model.checked(first) === true,
    url,
  };
}

function center(element: Element): { x: number; y: number } {
  const r = element.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function mouseInit(x: number, y: number): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
}

/** The element the replay's pointer is over, which gets the leave events when it moves on. */
let hovered: Element | null = null;

function chainOf(element: Element): Element[] {
  const chain: Element[] = [];
  for (let n: Element | null = element; n; n = parentOf(n)) chain.push(n);
  return chain;
}

/**
 * The pointer leaving the element it was over for `next` (null: for no
 * element), as a mouse sends it: out of that element, then a leave for each of
 * its ancestors `next` is not inside, innermost first. A menu that opens on
 * hover closes on it.
 */
function dispatchLeave(next: Element | null, x: number, y: number): void {
  const previous = hovered;
  if (!previous || previous === next) return;
  hovered = null;
  if (!previous.isConnected) return;
  const init = { ...mouseInit(x, y), relatedTarget: next };
  const pointer: PointerEventInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  const staying = new Set(next ? chainOf(next) : []);
  previous.dispatchEvent(new PointerEvent('pointerout', pointer));
  previous.dispatchEvent(new MouseEvent('mouseout', init));
  for (const el of chainOf(previous)) {
    if (staying.has(el)) break;
    el.dispatchEvent(new PointerEvent('pointerleave', { ...pointer, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseleave', { ...init, bubbles: false }));
  }
}

/**
 * The pointer arriving over an element, as a mouse sends it on its way to a
 * click: out of the last element, over this one and into each ancestor it was
 * not in yet, outermost first, then a move. CSS `:hover` moves with it
 * (`hoverElement`). Menus and selects rely on it: a Radix or Reka select
 * ignores the release that picks an option unless the pointer moved since it
 * opened.
 */
function dispatchHover(element: Element, x: number, y: number): void {
  const init = mouseInit(x, y);
  const pointer: PointerEventInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  hoverElement(element);
  if (hovered !== element) {
    const previous = hovered?.isConnected ? hovered : null;
    const before = new Set(previous ? chainOf(previous) : []);
    dispatchLeave(element, x, y);
    const entering = chainOf(element)
      .filter((el) => !before.has(el))
      .reverse();
    element.dispatchEvent(new PointerEvent('pointerover', { ...pointer, relatedTarget: previous }));
    for (const el of entering) {
      el.dispatchEvent(new PointerEvent('pointerenter', { ...pointer, bubbles: false, relatedTarget: previous }));
    }
    element.dispatchEvent(new MouseEvent('mouseover', { ...init, relatedTarget: previous }));
    for (const el of entering) {
      el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false, relatedTarget: previous }));
    }
    hovered = element;
  }
  element.dispatchEvent(new PointerEvent('pointermove', pointer));
  element.dispatchEvent(new MouseEvent('mousemove', init));
}

/** The pointer leaving the page's elements, and the emulated `:hover` removed: the replay is over. */
export function endHover(): void {
  dispatchLeave(null, 0, 0);
  endHoverEmulation();
}

/** A click as a person makes it: pointer and mouse down and up, focus, then the click. */
function dispatchClick(element: Element, x: number, y: number, detail = 1): void {
  const init = { ...mouseInit(x, y), detail };
  const pointer: PointerEventInit = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  element.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
  element.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus({ preventScroll: true });
  element.dispatchEvent(new PointerEvent('pointerup', pointer));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.dispatchEvent(new MouseEvent('click', init));
}

async function pointAt(element: Element, cursor: FakeCursor, caption: string): Promise<{ x: number; y: number }> {
  const target = center(element);
  cursor.outline(element.getBoundingClientRect());
  await cursor.moveTo(target.x, target.y, caption);
  dispatchHover(element, target.x, target.y);
  return target;
}

/** A hover: the pointer moves over the element and stays there. */
export async function performHover(element: Element, cursor: FakeCursor, caption: string): Promise<void> {
  await pointAt(element, cursor, caption);
  cursor.outline(null);
}

export async function performClick(element: Element, cursor: FakeCursor, caption: string): Promise<void> {
  const { x, y } = await pointAt(element, cursor, caption);
  await cursor.press();
  cursor.outline(null);
  dispatchClick(element, x, y);
}

/** A double click: two clicks, the second counting two, then `dblclick`. */
export async function performDoubleClick(element: Element, cursor: FakeCursor, caption: string): Promise<void> {
  const { x, y } = await pointAt(element, cursor, caption);
  await cursor.press();
  cursor.outline(null);
  dispatchClick(element, x, y, 1);
  dispatchClick(element, x, y, 2);
  element.dispatchEvent(new MouseEvent('dblclick', { ...mouseInit(x, y), detail: 2 }));
}

/**
 * A drag and drop with the page's own events: the HTML drag events a browser
 * sends, carrying one `DataTransfer`, and the pointer events a drag done by
 * script listens to, pressed on the element and released over the target.
 */
export async function performDrag(
  element: Element,
  target: Element,
  cursor: FakeCursor,
  caption: string,
): Promise<void> {
  const from = await pointAt(element, cursor, caption);
  await cursor.press();
  const to = center(target);
  cursor.outline(target.getBoundingClientRect());
  await cursor.moveTo(to.x, to.y, caption);
  cursor.outline(null);
  const pointer = (x: number, y: number, buttons: number): PointerEventInit => ({
    ...mouseInit(x, y),
    buttons,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  });
  element.dispatchEvent(new PointerEvent('pointerdown', pointer(from.x, from.y, 1)));
  element.dispatchEvent(new MouseEvent('mousedown', { ...mouseInit(from.x, from.y), buttons: 1 }));
  const data = new DataTransfer();
  const drag = (type: string, on: Element, x: number, y: number) =>
    on.dispatchEvent(new DragEvent(type, { ...mouseInit(x, y), dataTransfer: data }));
  const html = element instanceof HTMLElement && element.draggable;
  if (html) drag('dragstart', element, from.x, from.y);
  target.dispatchEvent(new PointerEvent('pointermove', pointer(to.x, to.y, 1)));
  target.dispatchEvent(new MouseEvent('mousemove', { ...mouseInit(to.x, to.y), buttons: 1 }));
  if (html) {
    drag('dragenter', target, to.x, to.y);
    drag('dragover', target, to.x, to.y);
    drag('drop', target, to.x, to.y);
    drag('dragend', element, to.x, to.y);
  }
  target.dispatchEvent(new PointerEvent('pointerup', pointer(to.x, to.y, 0)));
  target.dispatchEvent(new MouseEvent('mouseup', mouseInit(to.x, to.y)));
}

/**
 * Fields whose value is only valid whole (`09:30`, `2026-09-27`, `#22c55e`):
 * a browser drops a partial one, so the replay sets them in one go, as
 * Playwright does.
 */
export const WHOLE_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

/** Typed in steps a person can follow, at most about a second and a half whatever its length. */
export async function performFill(
  element: Element,
  value: string,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  const { x, y } = await pointAt(element, cursor, caption);
  await cursor.press();
  dispatchClick(element, x, y);
  cursor.outline(null);
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }),
    );
    return true;
  }
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  element.focus({ preventScroll: true });
  if (element instanceof HTMLInputElement && WHOLE_VALUE_TYPES.has(element.type)) {
    element.value = value;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText' }),
    );
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === value;
  }
  element.value = '';
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
  const perTick = Math.max(1, Math.ceil(value.length / 40));
  for (let i = 0; i < value.length; i += perTick) {
    const chunk = value.slice(i, i + perTick);
    element.value += chunk;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: chunk }),
    );
    await wait(35);
  }
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return element.value === value;
}

export async function performCheck(
  element: Element,
  checked: boolean,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  const input = element as HTMLInputElement;
  if (typeof input.checked !== 'boolean' || input.checked === checked) {
    await pointAt(element, cursor, caption);
    cursor.outline(null);
    return typeof input.checked !== 'boolean' ? false : true;
  }
  await performClick(element, cursor, caption);
  return input.checked === checked;
}

/** The option a `selectOption` step chooses: by its value, else by its label, as Playwright looks for it. */
export function optionFor(select: HTMLSelectElement, value: string): HTMLOptionElement | undefined {
  const options = [...select.options];
  return options.find((o) => o.value === value) ?? options.find((o) => o.label === value);
}

export async function performSelect(
  element: Element,
  value: string,
  cursor: FakeCursor,
  caption: string,
): Promise<boolean> {
  await pointAt(element, cursor, caption);
  await cursor.press();
  cursor.outline(null);
  if (!(element instanceof HTMLSelectElement)) return false;
  const option = optionFor(element, value);
  if (!option) return false;
  element.focus({ preventScroll: true });
  element.value = option.value;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * Files the developer chose for a file step, set on the page's file field as
 * the browser sets a choice, with its `input` and `change` events.
 */
export function assignFiles(element: Element, files: readonly File[]): boolean {
  const input = element as HTMLInputElement;
  if (input.tagName !== 'INPUT' || input.type !== 'file') return false;
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  input.files = data.files;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The events for a key as Playwright writes it: `Enter`, `?`, or a shortcut
 * such as `ControlOrMeta+K` (Ctrl, or ⌘ on a Mac) or `Shift+Tab`.
 */
function keyboardInit(combo: string): KeyboardEventInit {
  const parts = combo.length > 1 ? combo.split(/\+(?=.)/) : [combo];
  const name = parts.pop()!;
  const held = new Set(parts);
  const key = name === 'Space' ? ' ' : name;
  const code = /^[a-z]$/i.test(key)
    ? `Key${key.toUpperCase()}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : key === ' '
        ? 'Space'
        : key;
  return {
    key,
    code,
    ctrlKey: held.has('Control') || (held.has('ControlOrMeta') && !IS_MAC),
    metaKey: held.has('Meta') || (held.has('ControlOrMeta') && IS_MAC),
    altKey: held.has('Alt'),
    shiftKey: held.has('Shift'),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/**
 * A key press. Enter in a form's field submits the form, which the browser
 * does not do for an event a script sends, unless the page cancelled the key.
 */
export async function performPress(
  element: Element | null,
  key: string,
  cursor: FakeCursor,
  caption: string,
): Promise<void> {
  const target = element ?? document.activeElement ?? document.body;
  if (element) {
    await pointAt(element, cursor, caption);
    cursor.outline(null);
    if (element instanceof HTMLElement) element.focus({ preventScroll: true });
  }
  const init = keyboardInit(key);
  const down = new KeyboardEvent('keydown', init);
  target.dispatchEvent(down);
  // Enter, and a character typed without Ctrl or ⌘, also send the older `keypress` some pages still listen to.
  if (key === 'Enter' || ([...init.key!].length === 1 && !init.ctrlKey && !init.metaKey)) {
    target.dispatchEvent(new KeyboardEvent('keypress', init));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  if (key === 'Enter' && !down.defaultPrevented && target instanceof HTMLInputElement && target.form) {
    target.form.requestSubmit();
  }
}
