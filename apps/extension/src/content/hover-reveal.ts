import {
  REVEAL_PROPS,
  conditionsHold,
  hides,
  reveals,
  safeMatches,
  withMarker,
  type StyleRuleEntry,
  type StyleRules,
} from './hover-rules.js';

/**
 * Which hovers a click depends on: the elements whose hover revealed the
 * element pressed, or one of its ancestors.
 *
 * Two kinds of reveal. A CSS `:hover` rule shows an element hidden by another
 * rule (`.row:hover .actions { visibility: visible }`); the hovered element is
 * found by writing the rule's `:hover` as a marker attribute and setting it on
 * the element's ancestors until the rule matches. A script inserts or shows an
 * element when the pointer enters another (menus, hover cards, tooltips); that
 * is read from the order of the pointer's entries and the page's mutations.
 */

const PROBE = 'data-piwi-hover-probe';
const MAX_DEPTH = 40;

/** The element's parent, through a shadow root to its host. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function chainOf(el: Element): Element[] {
  const chain: Element[] = [];
  for (let n: Element | null = el; n && chain.length < MAX_DEPTH; n = parentOf(n)) chain.push(n);
  return chain;
}

function contains(outer: Element, inner: Element): boolean {
  for (let n: Element | null = inner; n; n = parentOf(n)) if (n === outer) return true;
  return false;
}

function isPageRoot(el: Element): boolean {
  const doc = el.ownerDocument;
  return el === doc.documentElement || el === doc.body;
}

/** Whether a rule without `:hover`, an inline style or the `hidden` attribute hides `el` for `prop`. */
function hiddenWithoutHover(el: Element, prop: (typeof REVEAL_PROPS)[number], hiding: StyleRuleEntry[]): boolean {
  if (prop === 'display' && el.hasAttribute('hidden')) return true;
  const inline = (el as HTMLElement).style?.getPropertyValue(prop);
  if (inline && hides(prop, inline)) return true;
  return hiding.some(
    (rule) =>
      rule.props[prop] != null &&
      hides(prop, rule.props[prop]!) &&
      safeMatches(el, rule.selector) &&
      conditionsHold(rule.conditions),
  );
}

/**
 * The element a real hover must be on for `probe` (the selector, `:hover`
 * written as the probe attribute) to match `x`: the markers are set from `x`
 * upward until it matches, then taken off from below while it still does.
 * Setting the attribute is the only change to the page, and it is undone
 * before this returns.
 */
function hoverSubject(x: Element, probe: string): Element | null {
  const chain = chainOf(x);
  const marked: Element[] = [];
  try {
    let matched = false;
    for (const el of chain) {
      el.setAttribute(PROBE, '');
      marked.push(el);
      if (safeMatches(x, probe)) {
        matched = true;
        break;
      }
    }
    if (!matched) return null;
    for (const el of marked) {
      el.removeAttribute(PROBE);
      if (!safeMatches(x, probe)) {
        el.setAttribute(PROBE, '');
        return el;
      }
    }
    return null;
  } finally {
    for (const el of marked) el.removeAttribute(PROBE);
  }
}

/**
 * The elements whose CSS `:hover` shows `target` or one of its ancestors, while
 * the pointer is on it: rules that hold now, set a reveal value, and apply to
 * an element that another rule hides. Only an element that contains the target
 * counts: hovering the target itself is part of clicking it.
 */
export function cssHoverSubjects(target: Element, rules: StyleRules): Array<{ subject: Element; revealed: Element }> {
  if (rules.hover.length === 0) return [];
  const chain = chainOf(target);
  const subjects: Array<{ subject: Element; revealed: Element }> = [];
  for (const rule of rules.hover) {
    const props = REVEAL_PROPS.filter((p) => rule.props[p] != null && reveals(p, rule.props[p]!));
    if (props.length === 0 || !conditionsHold(rule.conditions)) continue;
    for (const x of chain) {
      if (!safeMatches(x, rule.selector)) continue;
      if (!props.some((p) => hiddenWithoutHover(x, p, rules.hiding))) continue;
      const subject = hoverSubject(x, withMarker(rule.selector, PROBE));
      if (subject && subject !== target && contains(subject, target) && !isPageRoot(subject)) {
        if (!subjects.some((s) => s.subject === subject)) subjects.push({ subject, revealed: x });
      }
    }
  }
  return subjects;
}

/** How recent an insertion may be to count as a reveal, and how soon after the pointer entered it must follow. */
const RECENT_ADD_MS = 60_000;
const ENTER_TO_ADD_MS = 3_000;
/** An element this large is a page region, not something a person hovers to reveal a control. */
const MAX_SUBJECT_VIEWPORT_SHARE = 0.4;

interface Added {
  at: number;
  /** The last press before the insertion. */
  pressAt: number;
}

/**
 * Follows the pointer's entries and the page's insertions during a recording,
 * to tell which element's hover a script revealed a pressed element for.
 */
export class HoverTracker {
  /** When the pointer entered each element it is over now. */
  private entered = new Map<Element, number>();
  /** The last elements the pointer went over, oldest first. */
  private log: Array<{ el: Element; at: number }> = [];
  private added = new WeakMap<Node, Added>();
  private lastPressAt = -Infinity;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A trusted `pointerover` on `target`. */
  pointerOver(target: Element): void {
    const at = this.now();
    const next = new Map<Element, number>();
    for (const el of chainOf(target)) next.set(el, this.entered.get(el) ?? at);
    this.entered = next;
    this.log.push({ el: target, at });
    if (this.log.length > 64) this.log.shift();
  }

  /** The element the pointer was on when it entered `el`, if it is inside `el`. */
  enteredVia(el: Element): Element | null {
    const at = this.entered.get(el);
    if (at == null) return null;
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i]!;
      if (entry.at === at && contains(el, entry.el)) return entry.el;
      if (entry.at < at) break;
    }
    return null;
  }

  press(): void {
    this.lastPressAt = this.now();
  }

  /**
   * What a `MutationObserver` saw: inserted elements, and elements shown by a
   * `style` or `hidden` change. An insertion in the same batch as the removal
   * of an element the pointer is over is that element swapped for another (a
   * link re-rendered as the pointer enters it), which no hover reveals.
   */
  mutations(records: MutationRecord[]): void {
    const info: Added = { at: this.now(), pressAt: this.lastPressAt };
    const swapped = records.some(
      (record) =>
        record.type === 'childList' &&
        Array.from(record.removedNodes).some((node) => node.nodeType === 1 && this.entered.has(node as Element)),
    );
    for (const record of records) {
      if (record.type === 'childList') {
        if (swapped) continue;
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === 1) this.added.set(node, info);
      } else if (record.type === 'attributes' && record.target.nodeType === 1 && shownBy(record)) {
        this.added.set(record.target, info);
      }
    }
  }

  /**
   * The element to hover for what a script revealed `target` for, or null. The
   * element the pointer entered then stands for the one listening, as long as
   * it is inside it and outside what appeared: hovering it hovers the other,
   * and its name does not include what the hover shows. `pick` turns the
   * element entered (an icon, a text span) into the one a person points at.
   */
  scriptSubject(target: Element, pick: (entered: Element, within: Element) => Element = (e) => e): Element | null {
    const now = this.now();
    let revealed: Element | null = null;
    let info: Added | null = null;
    for (const el of chainOf(target)) {
      const found = this.added.get(el);
      if (found && now - found.at <= RECENT_ADD_MS) {
        revealed = el;
        info = found;
      }
    }
    if (!revealed || !info) return null;
    const { at, pressAt } = info;
    const qualifies = (el: Element, enteredAt: number): boolean =>
      enteredAt <= at && enteredAt > pressAt && at - enteredAt <= ENTER_TO_ADD_MS && el.isConnected && fits(el);
    let best: { el: Element; at: number } | null = null;
    for (let n = parentOf(revealed); n; n = parentOf(n)) {
      const enteredAt = this.entered.get(n);
      if (enteredAt == null || isPageRoot(n) || !qualifies(n, enteredAt)) continue;
      if (!best || enteredAt > best.at) best = { el: n, at: enteredAt };
    }
    if (best) {
      const listening = best.el;
      const via = this.enteredVia(listening);
      return via && !contains(revealed, via) ? pick(via, listening) : listening;
    }
    // Shown elsewhere in the page (a portal): the last element the pointer went over before it appeared.
    for (let i = this.log.length - 1; i >= 0; i--) {
      const entry = this.log[i]!;
      if (entry.at > at) continue;
      if (isPageRoot(entry.el) || contains(revealed, entry.el) || !qualifies(entry.el, entry.at)) return null;
      return pick(entry.el, entry.el.ownerDocument.documentElement);
    }
    return null;
  }
}

function fits(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  const r = el.getBoundingClientRect();
  return r.width * r.height <= view.innerWidth * view.innerHeight * MAX_SUBJECT_VIEWPORT_SHARE;
}

/** Whether an attribute change showed its element: `hidden` removed, or an inline `display: none` / `visibility: hidden` dropped. */
function shownBy(record: MutationRecord): boolean {
  const el = record.target as Element;
  if (record.attributeName === 'hidden') return record.oldValue != null && !el.hasAttribute('hidden');
  if (record.attributeName !== 'style') return false;
  const before = record.oldValue ?? '';
  const wasHidden = /display\s*:\s*none|visibility\s*:\s*hidden/i.test(before);
  const style = (el as HTMLElement).style;
  return wasHidden && style?.display !== 'none' && style?.visibility !== 'hidden';
}

/** Outermost first: an element before the ones inside it. */
export function outermostFirst(elements: Element[]): Element[] {
  const unique = elements.filter((el, i) => elements.indexOf(el) === i);
  const depth = new Map(unique.map((el) => [el, chainOf(el).length]));
  return unique.sort((a, b) => depth.get(a)! - depth.get(b)!);
}
