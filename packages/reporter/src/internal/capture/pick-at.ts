import type { ElementHandle, Locator, Page } from '@playwright/test';
import { parseLeafLocatorCall } from '@piwitests/core/locator-chain';
import { locatorOn } from './chain-locator.js';
import {
  approximateAccessibleName,
  generateAlternatives,
  type LocatorSnapshot,
  type RankedLocator,
} from './locator-healing.js';
import type { PickedLocator, PickerProbe } from './pick-on-failure.js';

/**
 * Pick on the image: the element under a point of an image of a stopped page (the IDE's, the Runs window's, a frame of
 * its live view), found without touching the page, as an agent finds one. The page's ARIA snapshot in AI mode with
 * each element's box on the screen (`page.ariaSnapshot({ mode: 'ai', boxes: true })`, Playwright 1.60) names the
 * elements under the point; the innermost of them (none of whose descendants is under it too, the smallest first),
 * Piwi's own overlays left out, is read through its ref
 * (`page.getByRef`, 1.64) and ranked as the pause bar's Pick a locator ranks a picked element, with the locator
 * `locator.normalize()` writes among the candidates. The first candidate that finds that element alone on the page is
 * the pick. Every call is the caller's to make internal.
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

/** The elements Piwi puts in a stopped page: the pause bar, the picker, the recorder's panels. */
const PIWI_OVERLAY = '[id^="__piwi"], [id^="piwi-"][id$="-host"]';
/** The most elements under a point read, the smallest first, for one that is not Piwi's. */
const MAX_UNDER = 5;
/** The most candidates counted on the page for the one that finds the element alone. */
const MAX_CHECKED = 8;
/** Where the locator `normalize()` writes ranks among the candidates: below a role's, a label's or a test id's. */
const NORMALIZED_SCORE = 60;

export const PICK_AT_NEEDS =
  'Pick on the image needs Playwright 1.64 or later (page.getByRef and the boxes of page.ariaSnapshot): update @playwright/test.';
const NO_ELEMENT = 'No element there: pick an element of the page, not its background.';
const IN_IFRAME =
  "That point is in an iframe, whose elements Pick on the image does not reach: use Pick in the test's window.";

type ByRef = { getByRef?: (ref: string) => Locator };

/** Whether this Playwright picks on an image: `page.getByRef` (1.64). The snapshot's boxes (1.60) are checked as read. */
export function canPickAt(page: Page): boolean {
  return typeof (page as unknown as ByRef).getByRef === 'function';
}

/**
 * The element under the point `x`, `y` of `page` (CSS pixels of its viewport), ranked: the pick, or why there is none
 * (no element there, the page's background, an iframe, a Playwright without the calls it needs). Throws when the page
 * breaks.
 */
export async function pickAtPoint(page: Page, probe: PickerProbe, x: number, y: number): Promise<PointPick> {
  if (!canPickAt(page)) return { refusal: PICK_AT_NEEDS };
  const snapshot = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 5000 } as Parameters<
    Page['ariaSnapshot']
  >[0]);
  if (!/\[box=/.test(snapshot)) return { refusal: PICK_AT_NEEDS };
  for (const box of boxesAt(snapshotBoxes(snapshot), x, y).slice(0, MAX_UNDER)) {
    if (box.role === 'iframe') return { refusal: IN_IFRAME };
    if (box.depth === 0 && box.role === 'generic') return { refusal: NO_ELEMENT };
    const locator = (page as unknown as Required<ByRef>).getByRef(box.ref);
    const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
    if (!handle) continue;
    try {
      // A browser-side element, hence the cast: this package has no DOM types.
      const piwi = await handle.evaluate(
        (el, overlay) => !!(el as { closest(selector: string): unknown }).closest(overlay),
        PIWI_OVERLAY,
      );
      if (!piwi) return await rank(page, probe, locator, handle);
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
  return { refusal: NO_ELEMENT };
}

/**
 * Rank an element as the bar's Pick a locator does, `normalize()`'s locator among the candidates, and keep the first
 * that finds that element alone on the page.
 */
async function rank(page: Page, probe: PickerProbe, locator: Locator, handle: ElementHandle): Promise<PointPick> {
  const attrs = await handle.evaluate(probe.fn, probe.arg);
  const accessibleName = approximateAccessibleName({ ...attrs, accessibleName: null });
  const candidates = generateAlternatives({ ...attrs, accessibleName });
  const normalize = (locator as Locator & { normalize?: () => Promise<Locator> }).normalize;
  const normalized = typeof normalize === 'function' ? await normalize.call(locator).then(String, () => null) : null;
  if (normalized && !candidates.some((c) => c.locator === normalized)) {
    const leaf = parseLeafLocatorCall(normalized);
    candidates.push({ locator: normalized, method: leaf?.method ?? 'locator', args: {}, score: NORMALIZED_SCORE });
    candidates.sort((a, b) => b.score - a.score);
  }
  let found: RankedLocator | null = null;
  for (const candidate of candidates.slice(0, MAX_CHECKED)) {
    const built = locatorOn(page, candidate.locator);
    if (!built || (await built.count().catch(() => 0)) !== 1) continue;
    const same = await built.evaluate((el, target) => el === target, handle, { timeout: 2000 }).catch(() => false);
    if (same) {
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
