import type { ElementHandle, Locator, Page } from '@playwright/test';
import { parseLeafLocatorCall } from '@piwitests/core/locator-chain';
import { locatorOfRef } from './aria-ref.js';
import { locatorOn } from './chain-locator.js';
import {
  approximateAccessibleName,
  generateAlternatives,
  type LocatorSnapshot,
  type RankedLocator,
} from './locator-healing.js';
import type { PickedLocator, PickerProbe } from './pick-on-failure.js';
import type { ProbedAttrs } from '@piwitests/picker-dom';

/**
 * Pick on the image: the element under a point of an image of a stopped page (the IDE's, the Runs window's, a frame of
 * its live view), found without touching the page, as an agent finds one. The page's ARIA snapshot in AI mode with
 * each element's box on the screen (`page.ariaSnapshot({ mode: 'ai', boxes: true })`, Playwright 1.60) names the
 * elements under the point, read through their refs (`locatorOfRef`). Of those, the pick is the innermost one
 * that is, or holds, the element a click there lands on: the page's hit test in paint order
 * (`document.elementsFromPoint`, into open shadow roots, an element of `pointer-events: none` passed through), Piwi's
 * own overlays left out, so a dialog, a fixed banner or a sticky header over another element is the one picked. Only
 * where the hit test finds nothing of the snapshot's, the innermost of the boxes under the point is (none of whose
 * descendants is under it too, the smallest first). It is ranked as the pause bar's Pick a locator ranks a picked
 * element, with the locator `locator.normalize()` writes among the candidates, and the first candidate that finds
 * that element alone on the page is the pick. Every call is the caller's to make internal.
 */

/** An element of a snapshot with its box on the screen, in CSS pixels of the viewport. */
export interface SnapshotBox {
  ref: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** How deep it is in the tree: 0 for the page's body. */
  depth: number;
  /** The refs of the elements with a box it is in, the outermost first. */
  ancestors: string[];
}

/** A line of the snapshot: its indentation, its role, its name, and its attributes (`[ref=e5] [box=…]`). */
const LINE = /^(\s*)- ([a-z][\w-]*)(?: "(?:[^"\\]|\\.)*")?((?: \[[^\]\n]*\])*)(?::.*)?$/;
const REF = /\[ref=(e\d+)\]/;
const NUMBER = '(-?\\d+(?:\\.\\d+)?)';
const BOX = new RegExp(`\\[box=${NUMBER},${NUMBER},${NUMBER},${NUMBER}\\]`);

/**
 * The elements of the main frame a snapshot names with a box, in its order. An element in an iframe has its box in
 * that frame's document and a ref of its own (`f1e2`): it is left out, and its iframe stands for it.
 */
export function snapshotBoxes(snapshot: string): SnapshotBox[] {
  const boxes: SnapshotBox[] = [];
  /** The elements with a box the next line may be in, by their indentation. */
  const open: Array<{ indent: number; ref: string }> = [];
  let unit = 0;
  for (const line of snapshot.split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    if (indent > 0 && unit === 0) unit = indent;
    while (open.length && open[open.length - 1]!.indent >= indent) open.pop();
    const attrs = m[3] ?? '';
    const ref = REF.exec(attrs)?.[1];
    const box = BOX.exec(attrs);
    if (!ref || !box) continue;
    const [x, y, width, height] = box.slice(1).map(Number) as [number, number, number, number];
    if (!(width > 0) || !(height > 0)) continue;
    const depth = unit ? Math.round(indent / unit) : 0;
    boxes.push({ ref, role: m[2]!, x, y, width, height, depth, ancestors: open.map((o) => o.ref) });
    open.push({ indent, ref });
  }
  return boxes;
}

/**
 * The elements whose box holds the point: first the innermost ones, none of whose descendants holds it too (a field
 * that overflows its label's box is under the point, not the label), the smallest first; then the others, the
 * smallest first.
 */
export function boxesAt(boxes: readonly SnapshotBox[], x: number, y: number): SnapshotBox[] {
  const under = boxes.filter((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
  const holding = new Set(under.flatMap((box) => box.ancestors));
  const area = (box: SnapshotBox) => box.width * box.height;
  return under.sort(
    (a, b) => Number(holding.has(a.ref)) - Number(holding.has(b.ref)) || area(a) - area(b) || b.depth - a.depth,
  );
}

/** What Pick on the image found: the pick, or why there is none. */
export type PointPick = { picked: PickedLocator } | { refusal: string };

/**
 * The elements Piwi puts in a stopped page: the pause bar, the picker's panels and outlines (each root an `__piwi`
 * id), the recorder's and the extension's panels (a `piwi-…-host`).
 */
const PIWI_OVERLAY = '[id^="__piwi"], [id^="piwi-"][id$="-host"]';
/** The most elements under a point read, the innermost first. */
const MAX_UNDER = 24;
/** The most candidates counted on the page for the one that finds the element alone. */
export const MAX_CHECKED = 8;
/** Where the locator `normalize()` writes ranks among the candidates: below a role's, a label's or a test id's. */
const NORMALIZED_SCORE = 60;

export const PICK_AT_NEEDS =
  'Pick on the image needs Playwright 1.60 or later (the boxes of page.ariaSnapshot): update @playwright/test.';
const NO_ELEMENT = 'No element there: pick an element of the page, not its background.';
const IN_IFRAME =
  "That point is in an iframe, whose elements Pick on the image does not reach: use Pick in the test's window.";

/** What the page's hit test says of a point: which element a click there lands on, among those it is given. */
interface HitArg {
  x: number;
  y: number;
  overlay: string;
  /** The elements of the boxes under the point, in their order; null for one that is not found. */
  elements: unknown[];
}

/**
 * In the page: the index of the element of `elements` that is, or holds, the element a click at the point lands on,
 * the nearest to it in the tree the page draws (a slotted element in its slot, a shadow root in its host); -1 when
 * none is; null when no element is there but Piwi's. Self-contained: it runs in the page.
 */
const hitIn = ({ x, y, overlay, elements }: HitArg): number | null => {
  // A browser-side element, hence the loose type: this package has no DOM types.
  type Node = {
    closest?(selector: string): unknown;
    getRootNode?(): unknown;
    shadowRoot?: { elementsFromPoint(x: number, y: number): Node[] } | null;
    assignedSlot?: Node | null;
    parentElement?: Node | null;
    parentNode?: (Node & { host?: Node }) | null;
  };
  type Scope = { elementsFromPoint(x: number, y: number): Node[] };
  let scope: Scope | null = (globalThis as unknown as { document: Scope }).document;
  let hit: Node | null = null;
  // In paint order, the topmost first, Piwi's overlays left out: into each open shadow root the point is in.
  for (let depth = 0; scope && depth < 32; depth++) {
    const within: Scope = scope;
    const top = within.elementsFromPoint(x, y).find((el) => el.getRootNode?.() === within && !el.closest?.(overlay));
    if (!top) break;
    hit = top;
    scope = top.shadowRoot ?? null;
  }
  if (!hit) return null;
  for (let node: Node | null = hit; node;) {
    const at = elements.indexOf(node);
    if (at >= 0) return at;
    node = node.assignedSlot ?? node.parentElement ?? node.parentNode?.host ?? null;
  }
  return -1;
};

/**
 * The element under the point `x`, `y` of `page` (CSS pixels of its viewport), ranked: the pick, or why there is none
 * (no element there, the page's background, an iframe, a Playwright without the calls it needs). Throws when the page
 * breaks.
 */
export async function pickAtPoint(page: Page, probe: PickerProbe, x: number, y: number): Promise<PointPick> {
  const snapshot = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 5000 } as Parameters<
    Page['ariaSnapshot']
  >[0]);
  if (!/\[box=/.test(snapshot)) return { refusal: PICK_AT_NEEDS };
  const under = boxesAt(snapshotBoxes(snapshot), x, y).slice(0, MAX_UNDER);
  const handles = await Promise.all(
    under.map((box) =>
      locatorOfRef(page, box.ref)
        .elementHandle({ timeout: 2000 })
        .catch(() => null),
    ),
  );
  try {
    const hit = await page.evaluate(hitIn, { x, y, overlay: PIWI_OVERLAY, elements: handles });
    const tested = hit !== null && hit >= 0;
    for (const [i, box] of under.entries()) {
      if (tested && i !== hit) continue;
      if (box.role === 'iframe') return { refusal: IN_IFRAME };
      if (box.depth === 0 && box.role === 'generic') return { refusal: NO_ELEMENT };
      const handle = handles[i];
      if (!handle) continue;
      // Without the hit test, Piwi's own overlays are left out here.
      const piwi =
        !tested &&
        (await handle.evaluate(
          // A browser-side element, hence the cast: this package has no DOM types.
          (el, overlay) => !!(el as { closest(selector: string): unknown }).closest(overlay),
          PIWI_OVERLAY,
        ));
      if (!piwi) return await rank(page, probe, locatorOfRef(page, box.ref), handle);
    }
    return { refusal: NO_ELEMENT };
  } finally {
    await Promise.all(handles.map((handle) => handle?.dispose().catch(() => undefined)));
  }
}

/**
 * An element's locator candidates, ranked as the bar's Pick a locator ranks them, the locator `normalize()` writes for
 * `locator` among them, with the attributes the probe read; `testIdAttribute` is the project's (`data-testid` when
 * null).
 */
export async function rankedCandidates(
  probe: PickerProbe,
  locator: Locator,
  handle: ElementHandle,
  testIdAttribute: string | null = null,
): Promise<{ attrs: ProbedAttrs; accessibleName: string | null; candidates: RankedLocator[] }> {
  const attrs = await handle.evaluate(probe.fn, probe.arg);
  const accessibleName = approximateAccessibleName({ ...attrs, accessibleName: null });
  const candidates = generateAlternatives({ ...attrs, accessibleName }, { testIdAttribute });
  const normalize = (locator as Locator & { normalize?: () => Promise<Locator> }).normalize;
  const normalized = typeof normalize === 'function' ? await normalize.call(locator).then(String, () => null) : null;
  if (normalized && !candidates.some((c) => c.locator === normalized)) {
    const leaf = parseLeafLocatorCall(normalized);
    candidates.push({ locator: normalized, method: leaf?.method ?? 'locator', args: {}, score: NORMALIZED_SCORE });
    candidates.sort((a, b) => b.score - a.score);
  }
  return { attrs, accessibleName, candidates };
}

/** Whether `candidate` finds `handle`'s element alone on the page. */
export async function findsAlone(page: Page, candidate: string, handle: ElementHandle): Promise<boolean> {
  const built = locatorOn(page, candidate);
  if (!built || (await built.count().catch(() => 0)) !== 1) return false;
  return built.evaluate((el, target) => el === target, handle, { timeout: 2000 }).catch(() => false);
}

/**
 * Rank an element as the bar's Pick a locator does, `normalize()`'s locator among the candidates, and keep the first
 * that finds that element alone on the page.
 */
async function rank(page: Page, probe: PickerProbe, locator: Locator, handle: ElementHandle): Promise<PointPick> {
  const { attrs, accessibleName, candidates } = await rankedCandidates(probe, locator, handle);
  let found: RankedLocator | null = null;
  for (const candidate of candidates.slice(0, MAX_CHECKED)) {
    if (await findsAlone(page, candidate.locator, handle)) {
      found = candidate;
      break;
    }
  }
  if (!found) return { refusal: 'Piwi found no locator that finds that element alone on the page.' };
  const picked: RankedLocator = { ...found, pickedByUser: true };
  const element: NonNullable<LocatorSnapshot['element']> = {
    tagName: attrs.tagName,
    attributes: attrs.attributes,
    textContent: attrs.textContent,
    accessibleName,
    center: attrs.center,
    ...(attrs.rolePosition ? { rolePosition: attrs.rolePosition } : {}),
    ...(attrs.ancestors && attrs.ancestors.length > 0 ? { ancestors: attrs.ancestors } : {}),
  };
  return { picked: { picked, alternatives: [picked, ...candidates.filter((c) => c !== found)], element } };
}
