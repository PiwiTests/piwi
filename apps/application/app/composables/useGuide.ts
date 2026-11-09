import type { Config, Driver, DriveStep, PopoverDOM } from 'driver.js';
import { docsUrl } from '#shared/docs';
import { findGuideAnchor, type GuideAnchor } from '#shared/guide-anchors/index.mjs';
import { escapeGuideHtml, guideMarkup } from '~/utils/guide/markup';
import { changedQuery, guidePath, linkMatch, segmentLabel, type GuidePathSegment } from '~/utils/guide/path';
import { anchorSelector, opensLayer, revealQuery, stopRoute } from '~/utils/guide/stops';
import type { GuidePoint, GuideRun, GuideStop } from '~/utils/guide/types';

/** How long a stop waits for its anchor to render before it shows centered. */
const TARGET_WAIT_MS = 8000;
/** How long a move to another page waits for Nuxt to show it (`page:finish`). */
const PAGE_WAIT_MS = 4000;
/** How long a reveal step waits for the folded section or the opener it clicks to render. */
const REVEAL_WAIT_MS = 4000;
/** Where a target's top edge lands below the top of the panel that scrolls it. */
const TARGET_OFFSET = 72;
/** The closest a target's top edge comes to its panel's top to make room for the popover under it. */
const MIN_TARGET_OFFSET = 4;
/** The space driver.js leaves around a target: its cutout padding. */
const STAGE_PADDING = 6;
/** Between a target and a popover above it: the stage padding, driver.js's 10 px popover offset, and a margin. */
const POPOVER_GAP = STAGE_PADDING + 10 + 8;
/** The height a popover is assumed to have before the guide has shown one. */
const POPOVER_HEIGHT_GUESS = 240;
/** From this width up, a stop's `side` and `align` place its popover; below it, driver.js puts it where it fits. */
const WIDE_QUERY = '(min-width: 640px)';
/** The popover's class, which `guide.css` themes. */
const POPOVER_CLASS = 'piwi-guide';
/** The popover's docs link. */
const DOCS_CLASS = 'piwi-guide-docs';
/** The line under a centered stop's body saying when its anchor shows. */
const NOTE_CLASS = 'piwi-guide-note';
/** On `<body>` while the guide moves to another stop: the popover is hidden until the next one renders. */
const MOVING_CLASS = 'piwi-guide-moving';
/** On `<body>` while the guide moves to another page: the overlay is a plain wash, with no cutout. */
const PAGING_CLASS = 'piwi-guide-paging';
/** On the popover once its stop is fully shown: the cutout on the target, the popover in place. */
const SETTLED_ATTRIBUTE = 'data-guide-settled';
/**
 * What marks a Reka UI layer (a popover, a menu, a dialog). Reka counts focus
 * and clicks in a marked element that comes after a layer as inside that
 * layer, as for a menu opened from it, so the layer stays open.
 */
const LAYER_ATTRIBUTE = 'data-dismissable-layer';
/** How often the shown target is checked for having moved, or been replaced by the page. */
const TARGET_CHECK_MS = 250;
/** What the user does to move the page: after one, the guide no longer scrolls its target back into view. */
const USER_INPUT_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
/** The element driver.js highlights for a stop it shows centered. */
const CENTERED_ELEMENT_ID = 'driver-dummy-element';
/** The class driver.js gives a highlighted element's parent while it stops that parent from scrolling. */
const PARENT_NO_SCROLL_CLASS = 'driver-active-element-parent-no-scroll';
/** The attributes driver.js writes on a highlighted element and removes when the guide moves on. */
const DRIVER_ARIA = ['aria-haspopup', 'aria-expanded', 'aria-controls'] as const;
/** The toggle of a section that folds: a `<button>`, or a `role="button"` header such as `CollapsibleSectionCard`'s. */
const SECTION_TOGGLE = 'button, [role="button"]';
/** Where `aria-expanded` is in a `savedAria` entry. */
const EXPANDED_AT = DRIVER_ARIA.indexOf('aria-expanded');
/** The line above the popover's title saying where the stop is. */
const PATH_CLASS = 'piwi-guide-path';
/** A segment of that line the guide opened on its way to the stop. */
const PATH_OPENED_CLASS = 'piwi-guide-path-opened';
/** Text a screen reader reads and the screen does not show. */
const SR_CLASS = 'piwi-guide-sr';
/** The numbered list of a stop's points, under its body. */
const POINTS_CLASS = 'piwi-guide-points';
/** A point's number, in the list and on the page. */
const NUMBER_CLASS = 'piwi-guide-number';
/** A point's number on the page, over its part. */
const BADGE_CLASS = 'piwi-guide-badge';
/** On a point's list item and its number on the page while the pointer is on the item. */
const ACTIVE_POINT_CLASS = 'piwi-guide-point-active';
/** How far a point's number sits up and left of its part's top left corner: it overlaps the part by a few pixels. */
const BADGE_OFFSET = 16;
/** The ring and the label on the control the guide is about to use. */
const WAY_CLASS = 'piwi-guide-way';
/** The label under, or over, that ring. */
const WAY_LABEL_CLASS = 'piwi-guide-way-label';
/** On the way's label when the ring is too close to the bottom of the screen for it to go under. */
const WAY_ABOVE_CLASS = 'piwi-guide-way-above';
/** On the way's label when the ring is in the right half of the screen: it lines up with the ring's right edge. */
const WAY_END_CLASS = 'piwi-guide-way-end';
/** The space between the control and its ring. */
const WAY_PADDING = 4;
/** How long the guide points at a control before it uses it; shorter when the user asks for less motion. */
const WAY_MS = 900;
const WAY_MS_REDUCED = 600;
/** A selected tab: a `role="tab"` one, or an item of a tab strip marked as the current one. */
const SELECTED_TAB = '[role="tab"][aria-selected="true"], [aria-current="true"]';
/** The links that lead to another page or tab: not a link to a place on the page itself, such as a skip link. */
const PAGE_LINKS = 'a[href]:not([href^="#"])';
/** What names a control on the path line and the way's label, the first that holds text. */
const CONTROL_LABELS = ['[data-slot="linkLabel"]', '[data-slot="label"]', 'h1, h2, h3, h4'];
/** The path drawing the spotlight's edge, beside driver.js's own in its overlay. */
const RING_CLASS = 'piwi-guide-ring';
/** On the ring while the stop shows centered, with nothing to outline. */
const RING_OFF_CLASS = 'piwi-guide-ring-off';

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
/** Lucide's `x`, for the popover's close button. */
const CLOSE_ICON = `<svg ${SVG_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
/** Lucide's `arrow-up-right`, after the docs link, which opens a new tab. */
const EXTERNAL_ICON = `<svg ${SVG_ATTRS}><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`;
/** Lucide's `info`, before the line saying when a centered stop's anchor shows. */
const INFO_ICON = `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
/** Lucide's `map-pin`, before the line saying where the stop is. */
const PIN_ICON = `<svg ${SVG_ATTRS}><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`;
/** Lucide's `chevron-right`, between two segments of that line. */
const CHEVRON_ICON = `<svg ${SVG_ATTRS}><path d="m9 18 6-6-6-6"/></svg>`;
/** Lucide's `mouse-pointer-click`, before the label of the control the guide is about to use. */
const POINTER_ICON = `<svg ${SVG_ATTRS}><path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/></svg>`;

/** What the guide did on its way to the stop shown, which the path line marks. */
interface GuideMoves {
  /** It opened another page. */
  page: boolean;
  /** The query keys whose value it changed, a tab or a pane selected through the URL. */
  query: Set<string>;
  /** The anchors it clicked: the toggles of folded sections, the openers of menus. */
  clicked: Set<string>;
}

/** A point's number on the page, over its part, and the panels scrolling the part. */
interface PointBadge {
  part: Element;
  badge: HTMLElement;
  panels: Element[];
}

/** A guide in progress; one at a time, in the browser only. */
interface RunningGuide {
  guide: GuideRun;
  /** Each stop's anchor from the registry, by stop index; `undefined` for a stop shown centered. */
  anchors: (GuideAnchor | undefined)[];
  /** The `shownWhen` of each stop's anchor, by stop index: said under the body when the stop shows centered. */
  notes: (string | undefined)[];
  driver?: Driver;
  /** A move to another stop is under way: Next, Back and the arrow keys wait for its popover. */
  moving: boolean;
  /** The guide is navigating: the route guard lets that navigation through. */
  navigating: boolean;
  /** The cutout is travelling to its target: scrolling does not redraw the stop meanwhile. */
  travelling: boolean;
  /** The user scrolled, clicked or typed since the stop showed: the guide leaves its target where they put it. */
  userActed: boolean;
  /** The height of the last popover shown, for making room above the next target. */
  popoverHeight: number;
  /** The stop shown has no target: the popover is centered. */
  centered: boolean;
  /** The spotlight's edge, once driver.js has drawn its overlay. */
  ring?: SVGPathElement;
  /** The `DRIVER_ARIA` values of each highlighted element before driver.js changed them. */
  savedAria: Map<Element, (string | null)[]>;
  /** What the guide did on its way to the stop shown. */
  moves: GuideMoves;
  /** The numbers of the stop's points on the page. */
  badges: PointBadge[];
  /** The ring on the control the guide is pointing at, while it does. */
  way?: HTMLElement;
  /** Removes the listeners the guide added. */
  cleanups: (() => void)[];
}

let running: RunningGuide | null = null;
let engine: Promise<typeof import('driver.js')> | null = null;

/** driver.js and the two stylesheets, loaded once, when the first guide starts. */
function loadEngine(): Promise<typeof import('driver.js')> {
  engine ??= Promise.all([
    import('driver.js'),
    import('driver.js/dist/driver.css'),
    import('~/assets/css/guide.css'),
  ]).then(
    ([module]) => module,
    (error: unknown) => {
      engine = null;
      throw error;
    },
  );
  return engine;
}

function isWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}

/** The elements that scroll `element` vertically, nearest first, then the document when it scrolls. */
function scrollPanels(element: Element): Element[] {
  const panels: Element[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    if (/auto|scroll/.test(getComputedStyle(node).overflowY) || node.classList.contains(PARENT_NO_SCROLL_CLASS)) {
      panels.push(node);
    }
  }
  const page = document.scrollingElement;
  if (page && page.scrollHeight > page.clientHeight && !panels.includes(page)) panels.push(page);
  return panels;
}

/**
 * Scrolls each panel holding `element`, nearest first, so its top edge sits
 * `TARGET_OFFSET` px below the panel's top, and at least `minTop` px below the
 * top of the viewport.
 */
function scrollToTarget(element: Element, minTop: number): void {
  for (const panel of scrollPanels(element)) {
    const panelTop = panel === document.scrollingElement ? 0 : panel.getBoundingClientRect().top;
    const goal = Math.max(panelTop + TARGET_OFFSET, minTop);
    panel.scrollTop += element.getBoundingClientRect().top - goal;
  }
}

/** Scrolls the panels holding `element` up until a popover `height` px tall fits above it. */
function makeRoomAbove(element: Element, height: number): void {
  let missing = height + POPOVER_GAP - element.getBoundingClientRect().top;
  for (const panel of scrollPanels(element)) {
    if (missing <= 0) return;
    const step = Math.min(missing, panel.scrollTop);
    panel.scrollTop -= step;
    missing -= step;
  }
}

/**
 * Scrolls the panels holding `element` down until a popover `height` px tall
 * fits under it, as far as each panel scrolls and with the target's top edge
 * kept `MIN_TARGET_OFFSET` px below the panel's top.
 */
function makeRoomBelow(element: Element, height: number): void {
  let missing = element.getBoundingClientRect().bottom + POPOVER_GAP + height - window.innerHeight;
  for (const panel of scrollPanels(element)) {
    if (missing <= 0) return;
    const panelTop = panel === document.scrollingElement ? 0 : panel.getBoundingClientRect().top;
    const above = element.getBoundingClientRect().top - panelTop - MIN_TARGET_OFFSET;
    const left = panel.scrollHeight - panel.clientHeight - panel.scrollTop;
    const step = Math.max(0, Math.min(missing, above, left));
    panel.scrollTop += step;
    missing -= step;
  }
}

/** The first element `selector` matches once it renders, or `null` after `timeoutMs`. */
async function rendered(selector: string, timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  let found = document.querySelector(selector);
  while (!found && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = document.querySelector(selector);
  }
  return found;
}

/**
 * Opens the section whose toggle is the anchor `section`, when the toggle
 * reads `aria-expanded="false"`, pointing at the toggle first; an open
 * section, or an anchor that is no toggle (a section that never folds), stays
 * as it is. A toggle the guide highlights carries driver.js's
 * `aria-expanded`, so its own value is read from `savedAria`, and updated
 * there once it opened.
 */
async function unfold(run: RunningGuide, section: string): Promise<void> {
  const toggle = await rendered(anchorSelector(section), REVEAL_WAIT_MS);
  if (!(toggle instanceof HTMLElement) || !toggle.matches(SECTION_TOGGLE)) return;
  const saved = run.savedAria.get(toggle);
  if ((saved ? saved[EXPANDED_AT] : toggle.getAttribute('aria-expanded')) !== 'false') return;
  await pointAt(run, toggle);
  if (running !== run) return;
  // The page may have drawn the section again while the guide pointed at it.
  const current = toggle.isConnected ? toggle : document.querySelector(anchorSelector(section));
  if (!(current instanceof HTMLElement)) return;
  if (current !== toggle && current.getAttribute('aria-expanded') !== 'false') return;
  run.moves.clicked.add(section);
  current.click();
  await nextTick();
  if (saved && current === toggle) saved[EXPANDED_AT] = toggle.getAttribute('aria-expanded');
}

/**
 * Clicks `opener` (an anchor id), the button opening the menu, drawer or
 * modal holding `target`, when `target` is not rendered, pointing at it first.
 */
async function open(run: RunningGuide, opener: string, target: string): Promise<void> {
  if (document.querySelector(anchorSelector(target))) return;
  const button = await rendered(anchorSelector(opener), REVEAL_WAIT_MS);
  if (!(button instanceof HTMLElement)) return;
  await pointAt(run, button);
  if (running !== run || document.querySelector(anchorSelector(target))) return;
  // The page may have drawn the opener again while the guide pointed at it.
  const current = button.isConnected ? button : document.querySelector(anchorSelector(opener));
  if (!(current instanceof HTMLElement)) return;
  run.moves.clicked.add(opener);
  current.click();
  await nextTick();
}

/** Runs the `unfold` and `open` steps of `anchor`'s reveal on the page, in order; its `query` is in the route. */
async function reveal(run: RunningGuide, anchor: GuideAnchor): Promise<void> {
  for (const step of anchor.reveal ?? []) {
    if (running !== run) return;
    if ('unfold' in step) await unfold(run, step.unfold);
    if ('open' in step) await open(run, step.open, anchor.id);
  }
}

/** The line saying when an anchor shows, under the body of a stop shown centered for want of it. */
function noteLine(text: string): HTMLParagraphElement {
  const line = document.createElement('p');
  line.className = NOTE_CLASS;
  line.insertAdjacentHTML('afterbegin', INFO_ICON);
  line.append(text);
  return line;
}

function docsLink(doc: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = DOCS_CLASS;
  link.href = docsUrl(doc);
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = label;
  link.insertAdjacentHTML('beforeend', EXTERNAL_ICON);
  return link;
}

/** Remembers the `DRIVER_ARIA` values of `element` before driver.js highlights it. */
function saveAria(run: RunningGuide, element: Element): void {
  if (run.savedAria.has(element)) return;
  run.savedAria.set(
    element,
    DRIVER_ARIA.map((name) => element.getAttribute(name)),
  );
}

/** Puts back the `DRIVER_ARIA` values of every element driver.js no longer highlights, or of all of them. */
function restoreAria(run: RunningGuide, highlighted?: Element): void {
  for (const [element, values] of run.savedAria) {
    if (element === highlighted) continue;
    DRIVER_ARIA.forEach((name, i) => {
      const value = values[i];
      if (value == null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    });
    run.savedAria.delete(element);
  }
}

/**
 * Makes driver.js's `scrollIntoView` call on `element`, for a target not
 * entirely in view, do nothing during the highlight starting now: the guide
 * scrolls the target's panels itself (`scrollToTarget`), never the layout
 * around them.
 */
function holdScrollIntoView(element: Element): void {
  element.scrollIntoView = () => {};
  queueMicrotask(() => Reflect.deleteProperty(element, 'scrollIntoView'));
}

function noMoves(): GuideMoves {
  return { page: false, query: new Set(), clicked: new Set() };
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The part of `element` the user sees, as a viewport box: its box cut by the
 * viewport and by each panel scrolling it (`panels`, looked up when not
 * given); null when nothing of it shows, or when it is hidden or fully
 * transparent.
 */
function visibleBox(element: Element, panels = scrollPanels(element)): DOMRect | null {
  const box = element.getBoundingClientRect();
  let top = Math.max(box.top, 0);
  let left = Math.max(box.left, 0);
  let bottom = Math.min(box.bottom, window.innerHeight);
  let right = Math.min(box.right, window.innerWidth);
  for (const panel of panels) {
    if (panel === document.scrollingElement) continue;
    const clip = panel.getBoundingClientRect();
    top = Math.max(top, clip.top);
    left = Math.max(left, clip.left);
    bottom = Math.min(bottom, clip.bottom);
    right = Math.min(right, clip.right);
  }
  if (bottom - top < 1 || right - left < 1) return null;
  if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
    return null;
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * What a control is called: its `aria-label`, else its label or heading, else
 * the text of the element holding its first words, so a toggle reading
 * `Diagnosis` then its summary is called `Diagnosis`.
 */
function controlText(element: Element): string {
  const named = element.getAttribute('aria-label');
  if (named?.trim()) return named;
  for (const selector of CONTROL_LABELS) {
    const text = element.querySelector(selector)?.textContent;
    if (text?.trim()) return text;
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.trim() && !(node.parentElement && screenReaderOnly(node.parentElement))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP,
  });
  return walker.nextNode()?.parentElement?.textContent ?? '';
}

/**
 * Whether `element` is rendered for screen readers only (`sr-only`): laid out
 * in a box of a pixel or less. A part of the page hidden at this width, which
 * has no box at all, still names what it holds.
 */
function screenReaderOnly(element: Element): boolean {
  const { width, height } = element.getBoundingClientRect();
  return width <= 1 && height <= 1 && (element.checkVisibility?.() ?? true);
}

/**
 * The link on the screen that leads to `href`, an absolute URL of the app: a
 * link to the route itself first, else, when `href` is on another page, one
 * to that page; null when none shows. A link to the page shown would not
 * select the tab the move selects.
 */
function wayTo(href: string, otherPage: boolean): { link: HTMLElement; toRoute: boolean } | null {
  let toPage: HTMLElement | null = null;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(PAGE_LINKS)) {
    if (link.closest(`.${POPOVER_CLASS}`)) continue;
    const match = linkMatch(link.href, href);
    if (!match || !visibleBox(link)) continue;
    if (match === 'route') return { link, toRoute: true };
    if (otherPage) toPage ??= link;
  }
  return toPage ? { link: toPage, toRoute: false } : null;
}

/**
 * The selected tab nearest `element`: a `role="tab"` one, or a tab strip's
 * item marked `aria-current="true"` (the pages' `UNavigationMenu` tabs, which
 * are buttons), looked for in the closest ancestor holding one, else the first
 * on the page.
 */
function selectedTab(element: Element | null): Element | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const tab = node.querySelector(SELECTED_TAB);
    if (tab && !tab.closest(`.${POPOVER_CLASS}`)) return tab;
  }
  return document.querySelector(SELECTED_TAB);
}

/**
 * Shows the control the guide is about to use, a link to the next page, the
 * toggle of a folded section or the opener of a menu: a ring around it and
 * its label, for `WAY_MS`, so the user sees how the guide gets there. A
 * control out of view is scrolled into it first; one that still does not
 * show is used without being shown.
 */
async function pointAt(run: RunningGuide, element: Element | null): Promise<void> {
  if (!element || running !== run) return;
  if (!visibleBox(element)) scrollToTarget(element, 0);
  const box = visibleBox(element);
  if (!box) return;
  if (run.driver?.isActive()) document.body.classList.add(PAGING_CLASS);
  const way = document.createElement('div');
  way.className = WAY_CLASS;
  way.setAttribute('aria-hidden', 'true');
  way.style.top = `${box.top - WAY_PADDING}px`;
  way.style.left = `${box.left - WAY_PADDING}px`;
  way.style.width = `${box.width + 2 * WAY_PADDING}px`;
  way.style.height = `${box.height + 2 * WAY_PADDING}px`;
  const label = segmentLabel(controlText(element));
  if (label) {
    const caption = document.createElement('span');
    caption.className = WAY_LABEL_CLASS;
    caption.classList.toggle(WAY_ABOVE_CLASS, box.bottom + 48 > window.innerHeight);
    caption.classList.toggle(WAY_END_CLASS, box.left + box.width / 2 > window.innerWidth / 2);
    caption.insertAdjacentHTML('afterbegin', POINTER_ICON);
    caption.append(label);
    way.append(caption);
  }
  run.way?.remove();
  run.way = way;
  document.body.append(way);
  await new Promise((resolve) => setTimeout(resolve, reducedMotion() ? WAY_MS_REDUCED : WAY_MS));
  way.remove();
  if (run.way === way) run.way = undefined;
}

/**
 * The page's breadcrumb, or its title: the navbar of the panel holding
 * `element`, else the first one of the page. A breadcrumb's levels hidden
 * on narrow screens are read too; its first level is left out when it links
 * to `root`, the home page every breadcrumb starts from, and more follow.
 */
function pageCrumbs(element: Element | null, root: string): string[] {
  const read = (scope: Element): string[] | null => {
    const navbar = scope.querySelector('[data-slot="left"]:has(ol[data-slot="list"], h1[data-slot="title"])');
    if (!navbar) return null;
    const items = [...navbar.querySelectorAll('ol[data-slot="list"] > li[data-slot="item"]')];
    const home = items[0]?.querySelector<HTMLAnchorElement>('a[href]');
    if (items.length > 1 && home && new URL(home.href).pathname === new URL(root).pathname) items.shift();
    if (items.length > 0) return items.map(controlText);
    return [navbar.querySelector('h1[data-slot="title"]')?.textContent ?? ''];
  };
  for (let node = element?.parentElement; node && node !== document.body; node = node.parentElement) {
    const crumbs = read(node);
    if (crumbs) return crumbs;
  }
  return read(document.body) ?? [];
}

/**
 * The label of the tab the query value `key=value` selects on the page of
 * `href`: a link to it, else the selected tab nearest `element`.
 */
function tabLabel(key: string, value: string, href: string, element: Element | null): string {
  const page = new URL(href).pathname;
  for (const link of document.querySelectorAll<HTMLAnchorElement>(PAGE_LINKS)) {
    const url = new URL(link.href);
    if (url.pathname === page && url.searchParams.get(key) === value && !link.closest(`.${POPOVER_CLASS}`)) {
      return controlText(link);
    }
  }
  const tab = selectedTab(element);
  return tab ? controlText(tab) : '';
}

/** The popover's list of a stop's points, numbered, each item naming its part. */
function pointList(points: readonly GuidePoint[]): HTMLOListElement {
  const list = document.createElement('ol');
  list.className = POINTS_CLASS;
  list.setAttribute('role', 'list');
  points.forEach((point, i) => {
    const item = document.createElement('li');
    item.dataset.guidePart = point.part;
    const number = document.createElement('span');
    number.className = NUMBER_CLASS;
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(i + 1);
    const text = document.createElement('span');
    text.innerHTML = guideMarkup(point.text);
    item.append(number, text);
    list.append(item);
  });
  return list;
}

/** Removes the numbers of the stop's points from the page. */
function clearBadges(run: RunningGuide): void {
  for (const { badge } of run.badges.splice(0)) badge.remove();
}

/** Puts each number of the stop's points on its part's top left corner, hidden while the part is out of view. */
function placeBadges(run: RunningGuide): void {
  for (const { part, badge, panels } of run.badges) {
    const box = part.isConnected ? visibleBox(part, panels) : null;
    const corner = part.getBoundingClientRect();
    const shows = box !== null && box.top <= corner.top + 1 && box.left <= corner.left + 1;
    badge.hidden = !shows;
    if (!shows) continue;
    badge.style.top = `${Math.max(corner.top - BADGE_OFFSET, 0)}px`;
    badge.style.left = `${Math.max(corner.left - BADGE_OFFSET, 0)}px`;
  }
}

/**
 * Numbers the stop's points on the page: a badge over each part found in the
 * highlighted `element`, with the same number as its item in the popover's
 * list. Pointing at an item marks its number on the page too. An item whose
 * part does not render is marked `data-missing`.
 */
function showBadges(run: RunningGuide, element: Element | undefined, points: readonly GuidePoint[] | undefined): void {
  clearBadges(run);
  if (!points?.length) return;
  const items = run.driver?.getState('popover')?.wrapper.querySelectorAll(`.${POINTS_CLASS} > li`);
  points.forEach((point, i) => {
    const item = items?.[i];
    const part = element?.querySelector(`[data-tour-part="${point.part}"]`);
    if (!part) {
      item?.setAttribute('data-missing', '');
      return;
    }
    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS} ${NUMBER_CLASS}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = String(i + 1);
    document.body.append(badge);
    run.badges.push({ part, badge, panels: scrollPanels(part) });
    if (!item) return;
    const mark = (on: boolean) => {
      item.classList.toggle(ACTIVE_POINT_CLASS, on);
      badge.classList.toggle(ACTIVE_POINT_CLASS, on);
    };
    item.addEventListener('pointerenter', () => mark(true));
    item.addEventListener('pointerleave', () => mark(false));
  });
  placeBadges(run);
}

/**
 * Draws the spotlight's edge (`RING_CLASS`, styled in guide.css) in
 * driver.js's overlay, once the overlay exists: a second path that copies the
 * cutout's outline from the overlay's path on every change, so it follows the
 * cutout as it moves, and no `overflow` of the page clips it.
 */
function attachRing(run: RunningGuide): void {
  if (running !== run || run.ring?.isConnected) return;
  const overlayPath = document.querySelector('svg.driver-overlay > path');
  if (!overlayPath) return;
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ring.classList.add(RING_CLASS);
  ring.classList.toggle(RING_OFF_CLASS, run.centered);
  overlayPath.after(ring);
  // The overlay's path is the screen-wide rectangle, closed with `Z`, then the cutout.
  const follow = () => {
    const d = overlayPath.getAttribute('d') ?? '';
    ring.setAttribute('d', d.slice(d.indexOf('Z') + 1));
  };
  follow();
  const observer = new MutationObserver(follow);
  observer.observe(overlayPath, { attributes: true, attributeFilter: ['d'] });
  run.ring = ring;
  run.cleanups.push(() => observer.disconnect());
}

/** Whether the router is on `path` already: the same path, with each query value `path` names. */
function isOnRoute(path: string, router: ReturnType<typeof useRouter>): boolean {
  const target = router.resolve(path);
  const current = router.currentRoute.value;
  return (
    target.path === current.path &&
    Object.entries(target.query).every(([key, value]) => String(current.query[key]) === String(value))
  );
}

/**
 * The guide engine: runs a guide's stops across the dashboard's pages with a
 * driver.js popover on each stop's anchor. A stop opens its route, runs its
 * anchor's reveal (folded sections, openers), scrolls the panels holding the
 * anchor and highlights it; the guide makes every move itself, Next and Back
 * included, pointing first at the link or the button that makes it, and a
 * navigation it did not make ends it. Each popover says where its stop is, and
 * a stop's points are numbered on the page. driver.js and its CSS load when
 * the first guide starts.
 */
export function useGuide() {
  const router = useRouter();
  const nuxtApp = useNuxtApp();

  const activeGuideId = useState<string | null>('guide-active-id', () => null);
  const isRunning = computed(() => activeGuideId.value !== null);

  /** Starts `guide` at its first stop, ending the one running. */
  async function start(guide: GuideRun): Promise<void> {
    if (import.meta.server) return;
    stop();
    const run: RunningGuide = {
      guide,
      anchors: guide.stops.map((guideStop) =>
        guideStop.anchor && !guideStop.absent ? findGuideAnchor(guideStop.anchor) : undefined,
      ),
      notes: guide.stops.map((guideStop) =>
        guideStop.anchor ? findGuideAnchor(guideStop.anchor)?.shownWhen : undefined,
      ),
      moving: false,
      navigating: false,
      travelling: false,
      userActed: false,
      popoverHeight: POPOVER_HEIGHT_GUESS,
      centered: false,
      savedAria: new Map(),
      moves: noMoves(),
      badges: [],
      cleanups: [],
    };
    running = run;
    activeGuideId.value = guide.id;
    watchPage(run);
    await goTo(run, 0);
  }

  /** Starts loading driver.js and the stylesheets, so a guide that has work to do before `start` shows sooner. */
  function preload(): void {
    if (import.meta.server) return;
    loadEngine().catch(() => {});
  }

  /** Ends the running guide, if any. */
  function stop(): void {
    const run = running;
    if (!run) return;
    running = null;
    activeGuideId.value = null;
    for (const cleanup of run.cleanups.splice(0)) cleanup();
    document.body.classList.remove(MOVING_CLASS, PAGING_CLASS);
    run.way?.remove();
    clearBadges(run);
    if (run.driver?.isActive()) run.driver.destroy();
    restoreAria(run);
  }

  /** **Done** on the last stop: ends the guide, then hands over to its `onFinish`. */
  function finish(run: RunningGuide): void {
    stop();
    run.guide.onFinish?.();
  }

  /**
   * Shows stop `index`: opens its page first when it is on another one,
   * pointing at the link to it when one shows, then runs its anchor's reveal,
   * then highlights the anchor. What it did on the way is kept in `moves`
   * for the stop's path line.
   */
  async function goTo(run: RunningGuide, index: number, again = false): Promise<void> {
    const guideStop = run.guide.stops[index];
    if (running !== run || run.moving || !guideStop) return;
    const anchor = run.anchors[index];
    run.moving = true;
    run.userActed = false;
    if (!again) run.moves = noMoves();
    clearBadges(run);
    document.body.classList.add(MOVING_CLASS);
    run.driver?.getState('popover')?.wrapper.removeAttribute(SETTLED_ATTRIBUTE);
    try {
      // The pointer on the way to the stop is styled by `guide.css`: nothing is drawn before it loads.
      const { driver } = await loadEngine();
      if (running !== run) return;
      const route = stopRoute(guideStop.route, anchor);
      if (route && !isOnRoute(route, router)) {
        const current = router.currentRoute.value;
        const target = router.resolve(route);
        run.moves.page = target.path !== current.path;
        for (const [key] of changedQuery(run.moves.page ? null : current.fullPath, target.fullPath)) {
          run.moves.query.add(key);
        }
        if (run.driver?.isActive()) document.body.classList.add(PAGING_CLASS);
        const way = wayTo(new URL(target.href, window.location.origin).href, run.moves.page);
        await pointAt(run, way?.link ?? null);
        if (running !== run) return;
        await navigate(run, route);
        // No link named the tab the move selected: point at it now that it is selected.
        const revealed = revealQuery(anchor);
        if (!way?.toRoute && [...run.moves.query].some((key) => key in revealed)) {
          await pointAt(run, selectedTab(anchor ? document.querySelector(anchorSelector(anchor.id)) : null));
        }
      }
      if (running === run && anchor) await reveal(run, anchor);
      if (running !== run) return;
      const instance = (run.driver ??= driver(configFor(run)));
      instance.setConfig({ ...instance.getConfig(), steps: stepsFor(run) });
      if (instance.isActive()) instance.moveTo(index);
      else instance.drive(index);
    } catch (error) {
      if (running === run) stop();
      console.error('[guide]', error);
    }
  }

  /** Navigates to `path` and, when that opens another page, waits for Nuxt to show it. */
  async function navigate(run: RunningGuide, path: string): Promise<void> {
    const opensPage = router.resolve(path).path !== router.currentRoute.value.path;
    const shown = opensPage ? pageShown() : Promise.resolve();
    run.navigating = true;
    try {
      await router.push(path);
    } finally {
      run.navigating = false;
    }
    await shown;
  }

  /** Resolves on Nuxt's next `page:finish`, or after `PAGE_WAIT_MS`. */
  function pageShown(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        unhook();
        resolve();
      };
      const timer = setTimeout(done, PAGE_WAIT_MS);
      const unhook = nuxtApp.hook('page:finish', done);
    });
  }

  /**
   * Ends the guide on a navigation it did not make (the back button, a
   * shortcut); redraws the stop when a panel scrolls (driver.js follows the
   * window's scrolling only), once per frame; and every `TARGET_CHECK_MS`,
   * redraws it when its target moved without a scroll (content loading above
   * it), scrolls the target back into view when it left it before the user
   * scrolled, clicked or typed, and looks the target up again when the page
   * replaced it.
   */
  function watchPage(run: RunningGuide): void {
    const removeGuard = router.afterEach((to, from, failure) => {
      if (!failure && !run.navigating && to.path !== from.path) stop();
    });
    const onHistory = () => stop();
    let redrawn = false;
    const onScroll = () => {
      if (redrawn || run.travelling || !run.driver?.isActive()) return;
      redrawn = true;
      run.driver.refresh();
      placeBadges(run);
      requestAnimationFrame(() => {
        redrawn = false;
      });
    };
    const onResize = () => placeBadges(run);
    const onUserInput = () => {
      run.userActed = true;
    };
    let lastBox = '';
    const checkTarget = () => {
      const instance = run.driver;
      const element = instance?.getActiveElement();
      if (!instance?.isActive() || run.moving || run.travelling || !element) return;
      if (element.id === CENTERED_ELEMENT_ID) return;
      if (!element.isConnected) {
        void goTo(run, instance.getActiveIndex() ?? 0, true);
        return;
      }
      const { top, left, width, height, bottom } = element.getBoundingClientRect();
      if (!run.userActed && height > 0 && (bottom <= 0 || top >= window.innerHeight)) scrollToTarget(element, 0);
      const box = `${top} ${left} ${width} ${height}`;
      if (box !== lastBox) instance.refresh();
      lastBox = box;
      placeBadges(run);
    };
    window.addEventListener('popstate', onHistory);
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const type of USER_INPUT_EVENTS) window.addEventListener(type, onUserInput, { capture: true, passive: true });
    const timer = window.setInterval(checkTarget, TARGET_CHECK_MS);
    run.cleanups.push(
      removeGuard,
      () => window.removeEventListener('popstate', onHistory),
      () => window.removeEventListener('resize', onResize),
      () => document.removeEventListener('scroll', onScroll, { capture: true }),
      () => {
        for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, onUserInput, { capture: true });
      },
      () => window.clearInterval(timer),
    );
  }

  /** The driver.js steps of `run`, with the popover sides that apply at the current width. */
  function stepsFor(run: RunningGuide): DriveStep[] {
    const wide = isWide();
    return run.guide.stops.map((guideStop, index) => {
      const anchor = run.anchors[index];
      const selector = anchor ? anchorSelector(anchor.id) : undefined;
      return {
        // Looked up again on every move; driver.js shows the stop centered when it finds nothing.
        element: selector ? () => document.querySelector(selector) as Element : undefined,
        waitForElement: selector ? TARGET_WAIT_MS : 0,
        popover: {
          title: guideMarkup(guideStop.title),
          description: guideMarkup(guideStop.body),
          side: wide ? guideStop.side : undefined,
          align: wide ? guideStop.align : undefined,
        },
      };
    });
  }

  function configFor(run: RunningGuide): Config {
    const { words } = run.guide;
    const activeIndex = () => run.driver?.getActiveIndex() ?? 0;
    return {
      animate: !reducedMotion(),
      smoothScroll: false,
      allowClose: true,
      overlayClickBehavior: () => {},
      // Its opacity, which depends on the color mode, is set in guide.css.
      overlayColor: '#000',
      stagePadding: STAGE_PADDING,
      stageRadius: 8,
      disableActiveInteraction: true,
      popoverClass: POPOVER_CLASS,
      showProgress: true,
      progressText: escapeGuideHtml(words.progress),
      nextBtnText: escapeGuideHtml(words.next),
      prevBtnText: escapeGuideHtml(words.back),
      doneBtnText: escapeGuideHtml(words.done),
      onNextClick: () => void goTo(run, activeIndex() + 1),
      onPrevClick: () => void goTo(run, activeIndex() - 1),
      onDoneClick: () => finish(run),
      // On × and Escape.
      onDestroyStarted: () => stop(),
      onHighlightStarted: (element, step) => {
        run.travelling = true;
        run.centered = !element;
        run.ring?.classList.toggle(RING_OFF_CLASS, run.centered);
        // driver.js draws its overlay on the frame after the guide's first highlight starts.
        requestAnimationFrame(() => requestAnimationFrame(() => attachRing(run)));
        // driver.js moves its attributes from the last target to this one right after this hook.
        queueMicrotask(() => restoreAria(run, element));
        if (!element) return;
        saveAria(run, element);
        const opensAbove = step.popover?.side === 'top';
        scrollToTarget(element, opensAbove ? run.popoverHeight + POPOVER_GAP : 0);
        holdScrollIntoView(element);
      },
      onHighlighted: (element) => {
        run.travelling = false;
        attachRing(run);
        const index = run.driver?.getActiveIndex();
        const points = index === undefined ? undefined : run.guide.stops[index]?.points;
        showBadges(run, element && element.id !== CENTERED_ELEMENT_ID ? element : undefined, points);
        run.driver?.getState('popover')?.wrapper.setAttribute(SETTLED_ATTRIBUTE, '');
        run.driver?.refresh();
      },
      onPopoverRender: (popover, { state }) => {
        const index = state.activeIndex;
        decorate(run, popover, index, state.activeElement);
      },
    };
  }

  /**
   * The segments of the line saying where stop `index` is: the page's
   * breadcrumb, the tab each query value of its anchor's reveal selects, then
   * the section or menu each other step of the reveal unfolds or opens; each
   * one the guide opened on its way there is marked.
   */
  function stopPath(run: RunningGuide, index: number, element: Element | null): GuidePathSegment[] {
    const anchor = run.anchors[index];
    const route = router.currentRoute.value;
    const href = new URL(router.resolve(route.fullPath).href, window.location.origin).href;
    const inner: GuidePathSegment[] = [];
    for (const key of Object.keys(revealQuery(anchor))) {
      const raw = route.query[key];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value !== 'string') continue;
      const label = tabLabel(key, value, href, element);
      if (label) inner.push({ label, opened: run.moves.page || run.moves.query.has(key) });
    }
    for (const step of anchor?.reveal ?? []) {
      const control = 'unfold' in step ? step.unfold : 'open' in step ? step.open : undefined;
      const found = control ? document.querySelector(anchorSelector(control)) : null;
      if (control && found) inner.push({ label: controlText(found), opened: run.moves.clicked.has(control) });
    }
    const root = new URL(router.resolve('/').href, window.location.origin).href;
    return guidePath(pageCrumbs(element, root), inner, run.moves.page);
  }

  /** The line saying where the stop is, its segments separated by chevrons, the ones the guide opened marked. */
  function pathLine(segments: readonly GuidePathSegment[], name: string): HTMLParagraphElement {
    const line = document.createElement('p');
    line.className = PATH_CLASS;
    line.insertAdjacentHTML('afterbegin', PIN_ICON);
    const said = document.createElement('span');
    said.className = SR_CLASS;
    said.textContent = `${name}: `;
    line.append(said);
    segments.forEach((segment, i) => {
      if (i > 0) line.insertAdjacentHTML('beforeend', CHEVRON_ICON);
      const part = document.createElement('span');
      part.textContent = segment.label;
      if (segment.opened) part.className = PATH_OPENED_CLASS;
      line.append(part);
    });
    return line;
  }

  /**
   * Finishes a popover driver.js just rendered: what a check reads (`lang`,
   * `data-guide`, `data-guide-stop`, `data-guide-anchor`, empty for a stop
   * shown centered, and the guide's own `dataset`), the localized close button,
   * the line saying where the stop is above the title, the stop's points
   * numbered under the body, on a stop shown centered for want of its anchor
   * the line saying when the anchor shows, the docs link, room above the
   * target for a popover that opens above it, room under it for one that
   * opens below it (every popover below `sm`), and focus on Next. On a stop whose anchor sits in a layer its
   * reveal opened (a popover, a menu), the popover is marked as a layer opened
   * from that one, so Next taking focus leaves that layer, and the anchor in
   * it, open.
   */
  function decorate(run: RunningGuide, popover: PopoverDOM, index: number | undefined, element?: Element): void {
    const { words } = run.guide;
    const guideStop: GuideStop | undefined = index === undefined ? undefined : run.guide.stops[index];
    const anchor = index === undefined ? undefined : run.anchors[index];
    const { wrapper, closeButton, title, description, nextButton } = popover;
    const centered = !element || element.id === CENTERED_ELEMENT_ID;
    wrapper.lang = run.guide.lang;
    wrapper.dataset.guide = run.guide.id;
    wrapper.dataset.guideStop = guideStop?.id ?? '';
    wrapper.dataset.guideAnchor = centered ? '' : (anchor?.id ?? '');
    Object.assign(wrapper.dataset, run.guide.dataset);
    if (!centered && opensLayer(anchor)) wrapper.setAttribute(LAYER_ATTRIBUTE, '');
    // The popover is fixed: driver.js's scrollIntoView call on it does nothing.
    wrapper.scrollIntoView = () => {};
    closeButton.innerHTML = CLOSE_ICON;
    closeButton.setAttribute('aria-label', words.close);
    closeButton.title = words.close;
    const path = index === undefined ? [] : stopPath(run, index, centered ? null : (element ?? null));
    if (path.length > 0) title.before(pathLine(path, words.path));
    // Under the body: the points, the line saying when the anchor shows, on a stop shown centered for want of it, then the docs link.
    const note = centered && index !== undefined ? run.notes[index] : undefined;
    if (guideStop?.doc) description.after(docsLink(guideStop.doc, words.docs));
    if (note) description.after(noteLine(note));
    if (guideStop?.points?.length) description.after(pointList(guideStop.points));
    run.moving = false;
    document.body.classList.remove(MOVING_CLASS, PAGING_CLASS);
    run.popoverHeight = wrapper.offsetHeight;
    if (!centered && element) {
      const side = isWide() ? guideStop?.side : 'bottom';
      if (side === 'top') makeRoomAbove(element, run.popoverHeight);
      if (side === 'bottom') makeRoomBelow(element, run.popoverHeight);
    }
    // driver.js focuses the popover's first control, its ×, right after this.
    queueMicrotask(() => nextButton.focus({ preventScroll: true }));
  }

  return {
    start,
    preload,
    stop,
    isRunning,
    activeGuideId: readonly(activeGuideId),
  };
}
