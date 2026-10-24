import { probeElementAttrs, type ProbeArg, type ProbedAttrs } from '@piwitests/picker-dom';
import {
  generateAlternatives,
  approximateAccessibleName,
  headingLevel,
  CAPTURED_ATTRIBUTES,
  TAG_TO_ROLE,
  INPUT_TYPE_TO_ROLE,
  type RankedLocator,
} from '@piwitests/core/locator-generation';
import {
  renderLocatorChain,
  tryParseLocatorChain,
  type LocatorArg,
  type LocatorCall,
  type LocatorChain,
} from '@piwitests/core/locator-chain';
import { DomModel, normalizeWhiteSpace, parentElementOrShadowHost } from './engine-aria.js';
import { createLocatorEngine, type LocatorEngine } from './locator-engine.js';
import { repeatedContainers, type ContainerOptions, type RepeatedContainer } from './repeated-container.js';

/**
 * How every tool names and ranks an element, checked against the page as it
 * is with the engine that evaluates locators the way Playwright does (the one
 * the replay and the Tested elements overlay use).
 *
 * Names and roles come from `DomModel`, the model `locator-engine.spec.ts`
 * compares with Playwright: "Regressions 5" for a tab showing a count badge,
 * where the element's `textContent` reads "Regressions5", and `columnheader`
 * for a `<th>`, which no tag map knows.
 *
 * The ranking comes from `generateAlternatives`, given no count for a
 * candidate itself, only for the anchors that scope one (from the engine a
 * scan hands over, else from the probe). A name Playwright matches as a
 * substring (`{ name: 'Failed' }` also finds "3 failed") or a link repeated in
 * the sidebar and in the page shows once each candidate is run through the
 * engine. One that finds this element alone is verified. One that finds several, this one among them, is narrowed: first to
 * an exact match, then to the one showing this element's text, then inside an
 * ancestor whose test id is unique on the page, then inside the repeated row,
 * list item or card it sits in, picked by a short text of that container
 * (`getByRole('row').filter({ hasText: 'Alice' })`), then inside the nearest
 * landmark, dialog, row, list item or test id that tells it apart. One that
 * finds only others is dropped. When nothing is verified, the best candidate is
 * kept with `.first()` or `.nth()`, which the stability judge flags.
 */

/** Everything that can carry a role, for the probe's role and anchor lookups. */
export const ROLE_SOURCES = [...new Set(['[role]', 'input', 'select', ...Object.keys(TAG_TO_ROLE)])].join(',');

/** The probe as the ranking needs it: every captured attribute, role maps, and the structural anchors. */
const PROBE_ARG: ProbeArg = {
  keep: [...CAPTURED_ATTRIBUTES],
  tagRoles: TAG_TO_ROLE,
  inputRoles: INPUT_TYPE_TO_ROLE,
  roleSources: ROLE_SOURCES,
  includeStructural: true,
};

/** The probe for a ranking an engine counts for: the anchors alone, none of the probe's walks of the page. */
const ANCHORS_PROBE: ProbeArg = { ...PROBE_ARG, countMatches: false };

/** The extension's own elements (panels, overlays, the picker's banner) and everything inside them. */
export function isPiwiElement(element: Element): boolean {
  return !!element.closest('[id^="piwi-"], [id^="__piwi"]');
}

/** The engines `createPageEngine` built, by their model: a ranking handed the model counts with its engine. */
const pageEngines = new WeakMap<DomModel, LocatorEngine>();

/** An engine over `doc` as it is now, blind to the extension's own elements. Its caches last as long as it does. */
export function createPageEngine(doc: Document = document, testIdAttributes?: string[]): LocatorEngine {
  const engine = createLocatorEngine(doc, { testIdAttributes, ignore: isPiwiElement });
  pageEngines.set(engine.model, engine);
  return engine;
}

/**
 * How `repeatedContainers` reads the page through `engine`: its roles, test id attributes, texts (lowered once
 * for as long as the engine lasts) and visibility.
 */
export function engineContainerOptions(engine: LocatorEngine): ContainerOptions {
  return {
    roleOf: (node) => engine.model.role(node),
    testIdAttributes: engine.testIdAttributes,
    textOf: (node) => engine.model.text(node).normalized,
    lowerTextOf: (node) => {
      const text = engine.model.text(node);
      return (text.lower ??= text.normalized.toLowerCase());
    },
    isVisible: (node) => engine.model.isVisible(node),
  };
}

/**
 * The name Playwright computes for `el`, spaces between the parts of a
 * composite control included; the probe's approximation only when the model
 * finds none (an element hidden from the accessibility tree).
 */
function accessibleNameOf(el: Element, attrs: ProbedAttrs, model: DomModel = new DomModel()): string | null {
  return model.normalizedAccessibleName(el, false) || approximateAccessibleName({ ...attrs, accessibleName: null });
}

export interface RankedElement {
  attrs: ProbedAttrs;
  accessibleName: string | null;
  /** The role Playwright gives the element (`DomModel`), null when it has none or is presentational. */
  role: string | null;
  /** Every candidate `generateAlternatives` builds, most stable first, not yet checked against the page. */
  ranked: RankedLocator[];
}

type Structure = Pick<ProbedAttrs, 'rolePosition' | 'ancestors'>;

/** The probe's structural data, without the counts it made for a role other than `role`. */
function probedStructure(attrs: ProbedAttrs, role: string | null): Structure {
  if (attrs.rolePosition?.role === role) return {};
  return {
    rolePosition: null,
    ancestors: attrs.ancestors?.map(({ scopedRoleCount: _, ...anchor }) => anchor),
  };
}

const byRole = (role: string, level?: number | null): LocatorCall => ({
  method: 'getByRole',
  args:
    level != null
      ? [str(role), { type: 'object', entries: [['level', { type: 'number', value: level }]] }]
      : [str(role)],
});
const bySelector = (selector: string): LocatorCall => ({ method: 'locator', args: [str(selector)] });

/**
 * The counts the probe leaves out with `countMatches` off, from the engine's
 * indexes: where `el` stands among the elements of its role, and how many
 * elements each anchor of the probe, and the leaf inside it, finds.
 */
function engineStructure(
  el: Element,
  attrs: ProbedAttrs,
  role: string | null,
  level: number | null,
  engine: LocatorEngine,
): Structure {
  const find = (calls: LocatorCall[], scope?: Element): Element[] | undefined => {
    try {
      return engine.queryAll({ calls }, scope);
    } catch {
      return undefined;
    }
  };
  const count = (calls: LocatorCall[], scope?: Element) => find(calls, scope)?.length;
  let rolePosition: Structure['rolePosition'] = null;
  const same = role ? find([byRole(role)]) : undefined;
  const index = same?.indexOf(el) ?? -1;
  if (role && same && index !== -1) {
    rolePosition = { role, count: same.length, index };
    if (level != null) rolePosition.levelCount = count([byRole(role, level)]);
  }
  const leaf: LocatorCall | null = role
    ? byRole(role, level)
    : attrs.textContent
      ? { method: 'getByText', args: [str(attrs.textContent)] }
      : null;
  let ancestor: Element | null = el;
  let depth = 0;
  const ancestors = attrs.ancestors?.map((anchor) => {
    for (; ancestor && depth < anchor.depth; depth++) ancestor = ancestor.parentElement;
    if (!ancestor) return anchor;
    const anchorRole = anchor.role || TAG_TO_ROLE[anchor.tag] || null;
    const scoped = leaf ? count([leaf], ancestor) : undefined;
    return {
      ...anchor,
      ...(role ? { scopedRoleCount: scoped } : { scopedTextCount: scoped }),
      ...(anchor.testId ? { testIdCount: count([{ method: 'getByTestId', args: [str(anchor.testId)] }]) } : {}),
      ...(anchor.id ? { idCount: count([bySelector(`#${CSS.escape(anchor.id)}`)]) } : {}),
      ...(anchor.dataAttr
        ? { dataAttrCount: count([bySelector(`[${anchor.dataAttr.name}=${JSON.stringify(anchor.dataAttr.value)}]`)]) }
        : {}),
      ...(anchorRole ? { roleCount: count([byRole(anchorRole)]) } : {}),
      ...(anchorRole && anchor.filterText
        ? {
            filterRoleCount: count([
              byRole(anchorRole),
              { method: 'filter', args: [{ type: 'object', entries: [['hasText', str(anchor.filterText)]] }] },
            ]),
          }
        : {}),
    };
  });
  return { rolePosition, ancestors };
}

export interface RankOptions {
  /**
   * The engine of the page `el` is on, for a caller ranking many elements:
   * the anchors are counted with its indexes, built once for the whole scan,
   * where the probe walks the page again for every element. A `model` from
   * `createPageEngine` brings its engine along.
   */
  engine?: LocatorEngine;
  /** The model names and roles come from, a new one otherwise. */
  model?: DomModel;
  /** A probe of the caller's own, whose counts are taken as they are. */
  probe?: ProbeArg;
  /**
   * The attribute `getByTestId` reads in the project (Playwright's
   * `testIdAttribute`), which the probe reads the test ids from and the
   * candidates are built with; `data-testid` when unset.
   */
  testIdAttribute?: string | null;
}

/**
 * Probe `el`, name it and give it its role as Playwright does, and rank its
 * candidate locators. The probe's match counts are left out of the ranking:
 * they are estimates, and `checkLocators` counts every candidate with the
 * engine instead, so a name shared with another element is narrowed from its
 * own score rather than ranked down on a guess.
 */
export function rankElement(el: Element, options: RankOptions = {}): RankedElement {
  const { testIdAttribute = null } = options;
  const engine = options.probe ? undefined : (options.engine ?? (options.model && pageEngines.get(options.model)));
  const model = engine?.model ?? options.model ?? new DomModel();
  const probe = options.probe ?? (engine ? ANCHORS_PROBE : PROBE_ARG);
  const attrs = probeElementAttrs(el, testIdAttribute ? { ...probe, testIdAttribute } : probe);
  const accessibleName = accessibleNameOf(el, attrs, model);
  // As Playwright's own generator: no role candidate for a presentational element.
  const modelRole = model.role(el);
  const role = modelRole === 'none' || modelRole === 'presentation' ? null : modelRole;
  const level = headingLevel({ ...attrs, accessibleName }, role);
  const structure = engine ? engineStructure(el, attrs, role, level, engine) : probedStructure(attrs, role);
  const ranked = generateAlternatives(
    { ...attrs, ...structure, selectorCounts: undefined, accessibleName: shortName(accessibleName) },
    { role, testIdAttribute },
  );
  // An element with a role and no name (an unlabelled checkbox) still gets a candidate, which `checkLocators`
  // narrows or keeps by position.
  const bare = role && !accessibleName ? renderLocatorChain({ calls: [byRole(role, level)] }) : null;
  if (bare && !ranked.some((r) => r.locator === bare)) {
    ranked.push({ locator: bare, method: 'getByRole', args: level != null ? { role, level } : { role }, score: 12 });
  }
  return { attrs, accessibleName, role, ranked };
}

/** A name longer than this is a whole card's (a link around a title, a summary and tags): its start names it. */
const LONG_NAME = 80;
/** The most characters the start of a long name keeps. */
const NAME_START = 60;

/**
 * The name a candidate names an element by: its whole name, or the words a
 * long one starts with, which Playwright finds as well, matching a name as a
 * substring; `checkLocators` checks it finds the element alone.
 */
function shortName(name: string | null): string | null {
  if (!name || name.length <= LONG_NAME) return name;
  let start = '';
  for (const word of name.split(' ')) {
    const next = start ? `${start} ${word}` : word;
    if (next.length > NAME_START) break;
    start = next;
  }
  return start || name.slice(0, NAME_START);
}

/**
 * How a candidate fares on the page:
 * - `unique`: it finds this element and nothing else;
 * - `narrowed`: built from a candidate finding several, it finds this one alone;
 * - `position`: `.first()` or `.nth()` on a candidate finding several, when nothing better finds it alone;
 * - `ambiguous`: it finds this element among others;
 * - `unchecked`: the engine cannot evaluate it.
 */
export type LocatorVerdict = 'unique' | 'narrowed' | 'position' | 'ambiguous' | 'unchecked';

/**
 * How a narrowed locator tells the element apart from the others its candidate finds:
 * - `exact`: the candidate's name or text matched exactly;
 * - `text`: `.filter({ hasText })` with the element's own text;
 * - `container`: inside the repeated row, list item or card it sits in, picked by a text of that container
 *   (`getByRole('row').filter({ hasText: 'Alice' })`) or by the container's own accessible name;
 * - `scope`: inside an ancestor found alone (a test id, a landmark, a named dialog or row).
 */
export type NarrowingKind = 'exact' | 'text' | 'container' | 'scope';

export interface CheckedLocator extends RankedLocator {
  verdict: LocatorVerdict;
  /** The elements it finds, by the engine; null when unchecked. */
  count: number | null;
  /** For a narrowed or positional locator: the candidate it was built from, and how many elements that one finds. */
  from?: { locator: string; count: number };
  /** For a narrowed locator: how it was narrowed. */
  narrowedBy?: NarrowingKind;
}

export interface CheckOptions {
  /** The engine to evaluate with; one over the element's document otherwise. */
  engine?: LocatorEngine;
  /** How many verified locators to return at most. Checking stops once no later candidate can outrank them. */
  limit?: number;
  /** How many candidates to evaluate at most, for callers on a time budget. */
  maxChecked?: number;
  /** Also return the ambiguous and unchecked candidates, after the verified ones. */
  keepAmbiguous?: boolean;
}

/** Roles that make a useful scope when named, or on their own for the landmarks. */
const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search']);
const NAMED_SCOPE_ROLES = new Set([
  'dialog',
  'alertdialog',
  'region',
  'form',
  'group',
  'menu',
  'menubar',
  'listbox',
  'tablist',
  'toolbar',
  'tabpanel',
  'row',
  'listitem',
  'article',
  'grid',
  'table',
  'list',
]);
const TEXT_METHODS = new Set(['getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle']);
const MAX_SCOPE_DEPTH = 15;

const str = (value: string): LocatorArg => ({ type: 'string', value });

/** The chain with its last call matching exactly, or null when it already does or cannot. */
function exactVariant(chain: LocatorChain): LocatorChain | null {
  const last = chain.calls[chain.calls.length - 1];
  if (!last) return null;
  const options = last.args[1];
  if (last.method === 'getByRole' && options?.type === 'object') {
    const hasName = options.entries.some(([key, value]) => key === 'name' && value.type === 'string');
    if (!hasName || options.entries.some(([key]) => key === 'exact')) return null;
    const call: LocatorCall = {
      method: last.method,
      args: [
        last.args[0]!,
        { type: 'object', entries: [...options.entries, ['exact', { type: 'boolean', value: true }]] },
      ],
    };
    return { calls: [...chain.calls.slice(0, -1), call] };
  }
  if (TEXT_METHODS.has(last.method) && last.args.length === 1 && last.args[0]!.type === 'string') {
    const call: LocatorCall = {
      method: last.method,
      args: [last.args[0]!, { type: 'object', entries: [['exact', { type: 'boolean', value: true }]] }],
    };
    return { calls: [...chain.calls.slice(0, -1), call] };
  }
  return null;
}

/** The chain kept to the elements that show `text`, or null when there is no short text to go by. */
function textFilterVariant(chain: LocatorChain, text: string): LocatorChain | null {
  if (!text || text.length > 80) return null;
  const filter: LocatorCall = { method: 'filter', args: [{ type: 'object', entries: [['hasText', str(text)]] }] };
  return { calls: [...chain.calls, filter] };
}

/** `getByRole(role, { name, exact: true })`. */
const byNamedRole = (role: string, name: string): LocatorCall => ({
  method: 'getByRole',
  args: [
    str(role),
    {
      type: 'object',
      entries: [
        ['name', str(name)],
        ['exact', { type: 'boolean', value: true }],
      ],
    },
  ],
});

/** The call that locates `ancestor` on its own, when it has something that names it. */
function scopeCall(engine: LocatorEngine, ancestor: Element): LocatorCall | null {
  for (const attribute of engine.testIdAttributes) {
    const testId = ancestor.getAttribute(attribute);
    if (testId) return { method: 'getByTestId', args: [str(testId)] };
  }
  const role = engine.model.role(ancestor);
  if (!role) return null;
  const name = engine.model.normalizedAccessibleName(ancestor, false);
  if (name && (NAMED_SCOPE_ROLES.has(role) || LANDMARK_ROLES.has(role))) return byNamedRole(role, name);
  if (LANDMARK_ROLES.has(role)) return { method: 'getByRole', args: [str(role)] };
  return null;
}

/**
 * `ranked` checked against the page for `el`: the verified locators first,
 * most stable first (a narrowed one scores a point under the candidate it
 * narrows), then, with `keepAmbiguous`, the others in their ranked order.
 */
export function checkLocators(
  el: Element,
  ranked: readonly RankedLocator[],
  options: CheckOptions = {},
): CheckedLocator[] {
  const { limit = Infinity, maxChecked = Infinity, keepAmbiguous = false } = options;
  const engine = options.engine ?? createPageEngine(el.ownerDocument);
  const find = (chain: LocatorChain): Element[] | null => {
    try {
      return engine.queryAll(chain);
    } catch {
      return null;
    }
  };
  const isUnique = (chain: LocatorChain): boolean => {
    const found = find(chain);
    return found?.length === 1 && found[0] === el;
  };

  const text = normalizeWhiteSpace(engine.model.text(el).normalized);
  let containers: RepeatedContainer[] | undefined;

  /** `inner` inside an ancestor that a call finds alone; with `testIdOnly`, an ancestor's unique test id only. */
  const ancestorScope = (inner: LocatorChain, testIdOnly: boolean): LocatorChain | null => {
    let ancestor = parentElementOrShadowHost(el);
    for (let depth = 0; ancestor && depth < MAX_SCOPE_DEPTH; depth++, ancestor = parentElementOrShadowHost(ancestor)) {
      const scope = scopeCall(engine, ancestor);
      if (!scope || (testIdOnly && scope.method !== 'getByTestId')) continue;
      const scopeFound = find({ calls: [scope] });
      if (scopeFound?.length !== 1 || scopeFound[0] !== ancestor) continue;
      const scoped: LocatorChain = { calls: [scope, ...inner.calls] };
      if (isUnique(scoped)) return scoped;
    }
    return null;
  };

  /**
   * `chain` (else `exact`) inside the nearest repeated container whose siblings hold the other elements `chain`
   * finds, the container picked by its own accessible name when its author gave it one, else by a short text it
   * shows and its siblings do not.
   */
  const containerScope = (chain: LocatorChain, exact: LocatorChain | null, found: Element[]): LocatorChain | null => {
    containers ??= repeatedContainers(el, engineContainerOptions(engine));
    const others = found.filter((other) => other !== el);
    const inners = exact && exact !== chain ? [chain, exact] : [chain];
    for (const container of containers) {
      if (!container.repeats(others)) continue;
      const scopes: LocatorChain[] = [];
      const { element, role } = container;
      const ownName = element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
      const name = role && ownName ? engine.model.normalizedAccessibleName(element, false) : '';
      if (role && name) scopes.push({ calls: [byNamedRole(role, name)] });
      const base = container.base ? tryParseLocatorChain(container.base) : null;
      for (const hasText of base ? container.textsAmong(container.siblings) : []) {
        const filtered = textFilterVariant(base!, hasText);
        if (filtered) scopes.push(filtered);
      }
      for (const scope of scopes) {
        for (const inner of inners) {
          const scoped: LocatorChain = { calls: [...scope.calls, ...inner.calls] };
          if (isUnique(scoped)) return scoped;
        }
      }
    }
    return null;
  };

  /** A chain that finds `el` alone, built from one that finds it among others, and how it was narrowed. */
  const narrow = (chain: LocatorChain, found: Element[]): { chain: LocatorChain; kind: NarrowingKind } | null => {
    const exact = exactVariant(chain);
    if (exact && isUnique(exact)) return { chain: exact, kind: 'exact' };
    // Controls that share a name ("Show popup") often still say different things.
    const byText = textFilterVariant(chain, text);
    if (byText && isUnique(byText)) return { chain: byText, kind: 'text' };
    if (chain.calls[0]?.method === 'frameLocator') return null;
    const inner = exact && find(exact)?.includes(el) ? exact : chain;
    // A test id unique on the page is the author's own hook, steadier than any text.
    const byTestId = ancestorScope(inner, true);
    if (byTestId) return { chain: byTestId, kind: 'scope' };
    const byContainer = containerScope(chain, inner, found);
    if (byContainer) return { chain: byContainer, kind: 'container' };
    const scoped = ancestorScope(inner, false);
    return scoped ? { chain: scoped, kind: 'scope' } : null;
  };

  const verified: CheckedLocator[] = [];
  const others: CheckedLocator[] = [];
  const seen = new Set<string>();
  const keep = (list: CheckedLocator[], entry: CheckedLocator): void => {
    if (seen.has(entry.locator)) return;
    seen.add(entry.locator);
    list.push(entry);
  };
  let fallback: { chain: LocatorChain; alt: RankedLocator; index: number; count: number } | null = null;
  let checked = 0;

  for (const alt of ranked) {
    // Candidates come most stable first: once `limit` are verified, a later one can only tie the lowest.
    if (verified.length >= limit && alt.score <= Math.min(...verified.map((v) => v.score))) break;
    if (checked >= maxChecked) break;
    checked++;
    const chain = tryParseLocatorChain(alt.locator);
    const found = chain && find(chain);
    if (!chain || !found) {
      if (keepAmbiguous) keep(others, { ...alt, verdict: 'unchecked', count: null });
      continue;
    }
    if (!found.includes(el)) continue;
    const locator = renderLocatorChain(chain);
    if (found.length === 1) {
      keep(verified, { ...alt, locator, verdict: 'unique', count: 1 });
      continue;
    }
    if (keepAmbiguous) keep(others, { ...alt, locator, verdict: 'ambiguous', count: found.length });
    const narrowed = narrow(chain, found);
    if (narrowed) {
      keep(verified, {
        ...alt,
        locator: renderLocatorChain(narrowed.chain),
        score: alt.score - 1,
        verdict: 'narrowed',
        count: 1,
        from: { locator, count: found.length },
        narrowedBy: narrowed.kind,
      });
    } else fallback ??= { chain, alt, index: found.indexOf(el), count: found.length };
  }

  if (verified.length === 0 && fallback) {
    const pick: LocatorCall =
      fallback.index === 0
        ? { method: 'first', args: [] }
        : { method: 'nth', args: [{ type: 'number', value: fallback.index }] };
    const nth: LocatorChain = { calls: [...fallback.chain.calls, pick] };
    if (isUnique(nth)) {
      keep(verified, {
        ...fallback.alt,
        locator: renderLocatorChain(nth),
        score: Math.min(fallback.alt.score, 20),
        verdict: 'position',
        count: 1,
        from: { locator: renderLocatorChain(fallback.chain), count: fallback.count },
      });
    }
  }

  const best = verified.sort((a, b) => b.score - a.score).slice(0, limit);
  return keepAmbiguous ? [...best, ...others] : best;
}

export interface VerifiedLocator {
  locator: string;
  method: string;
  score: number;
}

export interface VerifyOptions {
  /** How many locators to keep at most. */
  limit?: number;
  /** The attribute `getByTestId` reads in the project (Playwright's `testIdAttribute`); `data-testid` when unset. */
  testIdAttribute?: string | null;
}

/**
 * The locators a recording keeps for an element: at most `limit`, each
 * finding it alone on an engine over its page that reads the test ids from
 * `testIdAttribute`.
 */
export function verifiedLocators(
  el: Element,
  ranked: readonly RankedLocator[],
  { limit = 5, testIdAttribute = null }: VerifyOptions = {},
): VerifiedLocator[] {
  const engine = createPageEngine(el.ownerDocument, testIdAttribute ? [testIdAttribute] : undefined);
  return checkLocators(el, ranked, { limit, engine }).map(({ locator, method, score }) => ({ locator, method, score }));
}

/**
 * Every locator that finds `el` alone, most stable first, for tools that
 * choose among them (the Tested elements overlay's replacements).
 */
export function rankElementLocators(el: Element, engine = createPageEngine(el.ownerDocument)): CheckedLocator[] {
  const { ranked } = rankElement(el, { engine });
  return checkLocators(el, ranked, { engine });
}

export interface TopLocatorInfo {
  /** The most stable locator finding `el` alone, or null when none does. */
  locator: string | null;
  accessibleName: string | null;
}

/** How many candidates the top locator checks at most: the ranking puts the likely winners first. */
const TOP_CHECKED = 4;

/**
 * The one locator a tool needs for an already-picked element
 * (`assertion-suggest.ts`, the overlays' previews).
 */
export function deriveTopLocator(el: Element, engine = createPageEngine(el.ownerDocument)): TopLocatorInfo {
  const { ranked, accessibleName } = rankElement(el, { engine });
  const [top] = checkLocators(el, ranked, { engine, limit: 1, maxChecked: TOP_CHECKED });
  return { locator: top?.locator ?? null, accessibleName };
}

/** How long the pointer rests on an element before its locator is checked against the page. */
const HOVER_REST_MS = 80;

/** The probe for a hover preview: no structural anchors, which walk the page. */
const QUICK_PROBE: ProbeArg = { keep: [...CAPTURED_ATTRIBUTES], includeStructural: false };

interface HoverLocator {
  /**
   * The locator to show for `el` now: the checked one once the pointer has
   * rested on it this frame, else its best-ranked candidate, named as
   * Playwright names it but not yet checked against the page.
   */
  locatorOf(el: Element): string | null;
  /** Stops a check still waiting for the pointer to rest. */
  dispose(): void;
}

/**
 * Locators for the element under a moving pointer. Checking candidates
 * against the page builds the engine's indexes over the whole page (tens of
 * milliseconds on a large one), too slow for every element the pointer
 * crosses: `locatorOf` answers at once with the ranked candidate, and once the
 * pointer has rested on an element for {@link HOVER_REST_MS}, checks it with an
 * engine over the page as it is then (`deriveTopLocator`), keeps the answer for
 * that animation frame and calls `onChecked` so the caller asks again.
 */
function createHoverLocator(onChecked: (el: Element) => void): HoverLocator {
  let checked = new WeakMap<Element, string | null>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (el: Element) => {
    if (!el.isConnected) return;
    let locator: string | null = null;
    try {
      locator = deriveTopLocator(el).locator;
    } catch {
      locator = null;
    }
    checked.set(el, locator);
    // Good for this frame only: by the next one the page may have changed.
    requestAnimationFrame(() => {
      checked = new WeakMap();
    });
    onChecked(el);
  };
  return {
    locatorOf(el) {
      if (checked.has(el)) return checked.get(el)!;
      clearTimeout(timer);
      timer = setTimeout(() => check(el), HOVER_REST_MS);
      return rankElement(el, { probe: QUICK_PROBE }).ranked[0]?.locator ?? null;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * Points the shared picker overlay's hover preview at the verified ranking:
 * `installPickerOverlay` reads `globalThis.__piwiDescribeElement` for the
 * locator it shows on the element and in its banner, so with this installed the
 * expression under the cursor is the one the results panel will rank first,
 * rather than the overlay's own attribute-order approximation, checked against
 * the page once the pointer rests (`createHoverLocator`).
 *
 * Returns the teardown — call it when the flow ends, so a later pick with no
 * hook installed does not keep answering through this one.
 */
export function installDescribeHook(): () => void {
  const g = globalThis as any;
  const hover = createHoverLocator(() => g.__piwiRedescribe?.());
  g.__piwiDescribeElement = (el: Element): string | null => {
    try {
      return hover.locatorOf(el);
    } catch {
      return null;
    }
  };
  return () => {
    hover.dispose();
    delete g.__piwiDescribeElement;
  };
}
