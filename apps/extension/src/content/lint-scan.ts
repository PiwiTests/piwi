import { parseLocatorChain, quoteJsString } from '@piwitests/core/locator-chain';
import { normalizeWhiteSpace, parentElementOrShadowHost, tagNameOf, type DomModel } from './engine-aria.js';
import type { LocatorEngine } from './locator-engine.js';
import { checkLocators, createPageEngine, rankElement } from './verified-locators.js';

/** Where an element's suggested test id comes from, the first of these it has. */
export type SlugSource = 'name' | 'label' | 'placeholder' | 'heading' | 'role';

/**
 * What a developer changes so a stable locator finds the element:
 *
 * - `element`: add the test id to the element itself;
 * - `container`: the element sits in a repeated container (a row, a card, a list item) whose copies hold the same
 *   element, so the test id goes on the container, named after the text that tells it apart, and `locator` reaches the
 *   element inside it;
 * - `scope`: the repeated container already carries a test id its copies share, so `locator` scopes by it, filtered by
 *   the container's own text, and nothing needs adding.
 */
export type LintSuggestion =
  | {
      kind: 'element';
      attribute: string;
      value: string;
      source: SlugSource;
      locator: string;
    }
  | {
      kind: 'container' | 'scope';
      /** The repeated container. */
      container: Element;
      attribute: string;
      /** The test id to add (`container`), or the one the copies already share (`scope`). */
      value: string;
      /** The container's text no other copy holds. */
      text: string;
      locator: string;
    };

export interface LintFinding {
  element: Element;
  role: string;
  /** The name Playwright computes, when it has one: a name other elements share, which no locator tells apart but by position. */
  accessibleName: string | null;
  /** The best score of a locator finding this element alone on the page (`checkLocators`), 0 when none does — below the bad-score threshold, meaning no test id, no telling name, and no stable structural anchor either. */
  bestScore: number;
  suggestion: LintSuggestion;
}

export interface LintScan {
  findings: LintFinding[];
  /** The interactive elements of the page, open shadow roots included, those hidden from the accessibility tree aside. */
  interactive: number;
  /** How many of them were checked: every one, or the first `MAX_CHECKED` in page order. */
  checked: number;
  /** The attribute the suggestions name. */
  testIdAttribute: string;
}

/** ARIA widget roles: the elements a test operates. Headings, regions and lists are not lint targets. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'switch',
  'tab',
  'menuitem',
  'option',
  'slider',
  'spinbutton',
  'searchbox',
]);

/**
 * Below this, the only alternatives left are CSS-class-based
 * (classifyCssStability tops out at 40) or nothing at all — see
 * locator-generation.ts's own score comments for the full scale.
 */
const BAD_SCORE_THRESHOLD = 50;

/** Interactive elements checked at most, so a page with thousands of them cannot hang the scan; the panel says when it stops. */
const MAX_CHECKED = 800;

/** Characters a suggested test id keeps at most, cut at a word. */
const SLUG_CHARS = 40;

/** A text longer than this is a description rather than a title: a shorter one names a container better. */
const TITLE_CHARS = 60;

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

export interface LintScanOptions {
  /** Checked between slices of work; returning false abandons the scan. */
  keepGoing?: () => boolean;
  /** Milliseconds of work between yields back to the page. */
  sliceMs?: number;
  /** The attribute `getByTestId` reads in the project; `data-testid` when unset. */
  testIdAttribute?: string | null;
}

/**
 * A test id made of `text`: lower case, accents dropped, letters and digits joined by `-`, at most `SLUG_CHARS`
 * characters cut at a word. Empty when the text has no letter or digit.
 */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= SLUG_CHARS) return slug;
  const cut = slug.slice(0, SLUG_CHARS + 1);
  const end = cut.lastIndexOf('-');
  return (end >= SLUG_CHARS / 2 ? cut.slice(0, end) : slug.slice(0, SLUG_CHARS)).replace(/-+$/, '');
}

/** `slug`, or `slug-2`, `slug-3`… for the first one `used` does not hold yet, which it then holds. */
export function claimTestId(slug: string, used: Set<string>): string {
  let value = slug;
  for (let n = 2; used.has(value); n++) value = `${slug}-${n}`;
  used.add(value);
  return value;
}

/** `getByRole('button', { name: 'Add to cart' })`, or `getByRole('button')` for an element with no name. */
function roleLocator(role: string, name: string | null): string {
  return name
    ? `getByRole(${quoteJsString(role)}, { name: ${quoteJsString(name)} })`
    : `getByRole(${quoteJsString(role)})`;
}

interface Heading {
  heading: Element;
  text: string;
}

/**
 * The page's headings that a slug can be made of, each tree (the document, an open shadow root) in document order,
 * with their texts: read once per scan rather than once per finding and ancestor.
 */
class HeadingIndex {
  private readonly byRoot = new Map<Node, Heading[]>();

  constructor(elements: readonly Element[], model: DomModel) {
    for (const element of elements) {
      if (!element.matches(HEADING_SELECTOR)) continue;
      const text = model.text(element).normalized;
      if (!slugify(text)) continue;
      const root = element.getRootNode();
      const list = this.byRoot.get(root);
      if (list) list.push({ heading: element, text });
      else this.byRoot.set(root, [{ heading: element, text }]);
    }
  }

  /**
   * The text of the heading nearest `element`: in its nearest ancestor below `<body>` that holds one, the last
   * heading before it, else the first after it. A heading holding the element does not count. Past a shadow root,
   * the host stands for the element.
   */
  nearest(element: Element): string | null {
    let ref = element;
    let [before, after] = this.around(ref);
    for (let ancestor = parentElementOrShadowHost(element); ancestor; ancestor = parentElementOrShadowHost(ancestor)) {
      if (tagNameOf(ancestor) === 'BODY') break;
      if (ancestor.getRootNode() !== ref.getRootNode()) {
        ref = ancestor;
        [before, after] = this.around(ref);
      }
      // An ancestor's descendants follow one another in document order: when it holds any heading before `ref`,
      // it holds the last one.
      if (before && ancestor.contains(before.heading)) return before.text;
      if (after && ancestor.contains(after.heading)) return after.text;
    }
    return null;
  }

  /** The last heading before `ref` in its tree and the first after it, neither holding it. */
  private around(ref: Element): [Heading | undefined, Heading | undefined] {
    const list = this.byRoot.get(ref.getRootNode()) ?? [];
    // How many headings come before `ref`, the ones holding it included.
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid]!.heading.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING) low = mid + 1;
      else high = mid;
    }
    let before = low - 1;
    while (before >= 0 && list[before]!.heading.contains(ref)) before--;
    let after = low;
    while (after < list.length && list[after]!.heading.contains(ref)) after++;
    return [list[before], list[after]];
  }
}

/** The text a slug is made from, and where it comes from: the name, a label, the placeholder, the nearest heading, the role. */
function slugText(
  element: Element,
  role: string,
  name: string | null,
  model: DomModel,
  headings: () => HeadingIndex,
): [string, SlugSource] {
  if (name && slugify(name)) return [name, 'name'];
  const label = model.labels(element).find((l) => slugify(l.normalized));
  if (label) return [label.normalized, 'label'];
  const placeholder = normalizeWhiteSpace(element.getAttribute('placeholder') ?? '');
  if (slugify(placeholder)) return [placeholder, 'placeholder'];
  const heading = headings().nearest(element);
  return heading ? [`${heading} ${role}`, 'heading'] : [role, 'role'];
}

/**
 * A container's runs of visible text, whitespace collapsed, each once: its headings' first, then those with a letter,
 * then the others (a price, a count).
 */
function containerTexts(container: Element, model: DomModel): string[] {
  const headings: string[] = [];
  const words: string[] = [];
  const others: string[] = [];
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = normalizeWhiteSpace(node.nodeValue ?? '');
    if (!parent || !text || !slugify(text)) continue;
    const tag = tagNameOf(parent);
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || !model.isVisible(parent)) continue;
    (parent.closest(HEADING_SELECTOR) ? headings : /\p{L}/u.test(text) ? words : others).push(text);
  }
  return [...new Set([...headings, ...words, ...others])];
}

interface RepeatedContainer {
  container: Element;
  /** The container's text no other copy holds. */
  text: string;
  /** Whether no other copy's text contains it, in any case: `filter({ hasText })` then keeps this one alone. */
  filters: boolean;
}

/**
 * Finds the repeated container a finding sits in. Its caches last one scan: the texts of each container, how many
 * children of one tag of a parent hold each text, and how many twins each ancestor of a group of twins holds.
 */
class ContainerFinder {
  private readonly texts = new Map<Element, string[]>();
  private readonly counts = new Map<Element, Map<string, Map<string, number>>>();
  private readonly held = new Map<Element[], Map<Element, number>>();

  constructor(private readonly model: DomModel) {}

  /**
   * The repeated container `element` sits in: the outermost ancestor holding no other element of `twins` (the
   * findings sharing its role and name), whose parent has another child of the same tag holding a twin. Null when
   * there is none, or when every text of it is in another child of that tag too.
   */
  find(element: Element, twins: Element[]): RepeatedContainer | null {
    if (twins.length < 2) return null;
    const held = this.heldBy(twins);
    let item = element;
    let parent = parentElementOrShadowHost(item);
    while (parent && held.get(parent) === 1) {
      item = parent;
      parent = parentElementOrShadowHost(item);
    }
    if (!parent || item === element) return null;
    const tag = tagNameOf(item);
    const copies = [...parent.children].filter((child) => child !== item && tagNameOf(child) === tag);
    if (!copies.some((copy) => held.has(copy))) return null;
    const counts = this.countsUnder(parent, tag);
    const candidates = this.textsOf(item).filter((text) => counts.get(text) === 1);
    const text = candidates.find((c) => c.length <= TITLE_CHARS) ?? candidates[0];
    if (!text) return null;
    const lower = text.toLowerCase();
    const filters = copies.every((copy) => !this.model.text(copy).normalized.toLowerCase().includes(lower));
    return { container: item, text, filters };
  }

  private heldBy(twins: Element[]): Map<Element, number> {
    let held = this.held.get(twins);
    if (!held) {
      held = new Map();
      for (const twin of twins) {
        for (let node = parentElementOrShadowHost(twin); node; node = parentElementOrShadowHost(node)) {
          held.set(node, (held.get(node) ?? 0) + 1);
        }
      }
      this.held.set(twins, held);
    }
    return held;
  }

  private textsOf(container: Element): string[] {
    let texts = this.texts.get(container);
    if (!texts) {
      texts = containerTexts(container, this.model);
      this.texts.set(container, texts);
    }
    return texts;
  }

  /** How many of `parent`'s children of tag `tag` hold each text. */
  private countsUnder(parent: Element, tag: string): Map<string, number> {
    let byTag = this.counts.get(parent);
    if (!byTag) {
      byTag = new Map();
      this.counts.set(parent, byTag);
    }
    let counts = byTag.get(tag);
    if (!counts) {
      counts = new Map();
      for (const child of parent.children) {
        if (tagNameOf(child) !== tag) continue;
        for (const text of this.textsOf(child)) counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      byTag.set(tag, counts);
    }
    return counts;
  }
}

/** Whether `locator`, evaluated inside `scope` (the page when unset), finds `element` and nothing else. */
function findsAlone(engine: LocatorEngine, locator: string, element: Element, scope?: Element): boolean {
  try {
    const found = engine.queryAll(parseLocatorChain(locator), scope);
    return found.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

type Unsuggested = Omit<LintFinding, 'suggestion'>;

/**
 * What each finding's developer adds. A finding in a repeated container gets the container's test id (or, when the
 * copies already share one, a scope by it); the others get their own, from their name, label, placeholder or nearest
 * heading, the role as the last resort. Every test id added is new on the page: a slug already taken gets `-2`, `-3`…
 * Calls `pause` before each finding, and answers null once it answers false.
 */
async function suggest(
  found: Unsuggested[],
  engine: LocatorEngine,
  attribute: string,
  pause: () => Promise<boolean>,
): Promise<LintSuggestion[] | null> {
  const model = engine.model;
  const used = new Set<string>();
  for (const element of engine.elements()) {
    const value = element.getAttribute(attribute);
    if (value) used.add(value);
  }
  const twins = new Map<string, Element[]>();
  const twinKey = (f: Unsuggested) => `${f.role}\u0000${f.accessibleName ?? ''}`;
  for (const f of found) {
    const group = twins.get(twinKey(f));
    if (group) group.push(f.element);
    else twins.set(twinKey(f), [f.element]);
  }
  let headingIndex: HeadingIndex | undefined;
  const headings = (): HeadingIndex => (headingIndex ??= new HeadingIndex(engine.elements(), model));
  const containers = new ContainerFinder(model);
  /** The test id given to each container, which every finding inside it shares. */
  const containerIds = new Map<Element, string>();

  const suggestions: LintSuggestion[] = [];
  for (const f of found) {
    if (!(await pause())) return null;
    const inner = roleLocator(f.role, f.accessibleName);
    const repeated = containers.find(f.element, twins.get(twinKey(f))!);
    if (repeated && findsAlone(engine, inner, f.element, repeated.container)) {
      const { container, text, filters } = repeated;
      const shared = container.getAttribute(attribute);
      if (shared) {
        const locator = `getByTestId(${quoteJsString(shared)}).filter({ hasText: ${quoteJsString(text)} }).${inner}`;
        if (filters && findsAlone(engine, locator, f.element)) {
          suggestions.push({ kind: 'scope', container, attribute, value: shared, text, locator });
          continue;
        }
      } else {
        let value = containerIds.get(container);
        if (!value) {
          value = claimTestId(slugify(text), used);
          containerIds.set(container, value);
        }
        const locator = `getByTestId(${quoteJsString(value)}).${inner}`;
        suggestions.push({ kind: 'container', container, attribute, value, text, locator });
        continue;
      }
    }
    const [text, source] = slugText(f.element, f.role, f.accessibleName, model, headings);
    const value = claimTestId(slugify(text) || slugify(f.role), used);
    suggestions.push({ kind: 'element', attribute, value, source, locator: `getByTestId(${quoteJsString(value)})` });
  }
  return suggestions;
}

/**
 * Find every interactive element that would score badly as a Playwright
 * locator target right now: no locator but a positional one finds it
 * alone — no test id, no name that tells it apart, and no unique structural
 * anchor either. The elements and their roles are the ones `getByRole` sees
 * (`DomModel`, open shadow roots included, hidden ones left out); the ranking and its check against
 * the page are the Pick results' own (`rankElement`, `checkLocators`), read as
 * a pass/fail signal instead of a ranked list, with one engine for the whole
 * scan. Works in slices so the page stays responsive; answers null when
 * `keepGoing` stopped it. Each finding comes with what to add (`LintSuggestion`).
 *
 * Unlike `derivePattern`, this isn't re-serialized via
 * `Function.prototype.toString()` in tests: `generateAlternatives` and the
 * engine have their own web of private module-level helpers that
 * reconstruction can't carry along. Tested via the real built
 * `lint-overlay.js` bundle instead (see that file).
 */
export async function scanForLintIssues(options: LintScanOptions = {}): Promise<LintScan | null> {
  const sliceMs = options.sliceMs ?? 12;
  const testIdAttribute = options.testIdAttribute || 'data-testid';
  const found: Unsuggested[] = [];
  const engine = createPageEngine(document, options.testIdAttribute ? [testIdAttribute] : undefined);
  const model = engine.model;
  const interactive: Array<{ element: Element; role: string }> = [];
  for (const element of engine.elements()) {
    const role = model.role(element);
    if (role && INTERACTIVE_ROLES.has(role) && !model.isHiddenForAria(element)) interactive.push({ element, role });
  }
  const checked = Math.min(interactive.length, MAX_CHECKED);
  let sliceStart = performance.now();
  /** Yields to the page once a slice of work is done; false when the scan is to stop. */
  const pause = async (): Promise<boolean> => {
    if (performance.now() - sliceStart <= sliceMs) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (options.keepGoing && !options.keepGoing()) return false;
    sliceStart = performance.now();
    return true;
  };

  for (let i = 0; i < checked; i++) {
    if (!(await pause())) return null;
    const { element, role } = interactive[i]!;
    const { accessibleName, ranked } = rankElement(element, { model, testIdAttribute: options.testIdAttribute });
    const [best] = checkLocators(element, ranked, { engine, limit: 1 });
    const bestScore = best?.score ?? 0;
    if (bestScore >= BAD_SCORE_THRESHOLD) continue;
    found.push({ element, role, accessibleName, bestScore });
  }

  const suggestions = await suggest(found, engine, testIdAttribute, pause);
  if (!suggestions) return null;
  const findings = found.map((f, i) => ({ ...f, suggestion: suggestions[i]! }));
  return { findings, interactive: interactive.length, checked, testIdAttribute };
}
