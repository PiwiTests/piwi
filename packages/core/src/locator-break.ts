/**
 * Locator break prediction: which chains of a project's locator index a change
 * breaks, from the strings the change removes or renames ({@link DiffAnchor}).
 *
 * Each call of a chain is compared with the anchors of the kind it reads, under
 * Playwright's own text rules (`locator-text-match`):
 *
 * | Call | Anchors | Rule |
 * |---|---|---|
 * | `getByTestId`, `[data-testid=…]` | the test id attributes | exact |
 * | `getByRole(r, { name })` | text, translation, literal, `aria-label`, `title`, `alt`, `value` | accessible name |
 * | `getByText`, `hasText` | text, translation, literal | text |
 * | `getByLabel` | text, translation, literal, `aria-label` | text |
 * | `getByPlaceholder`, `getByAltText`, `getByTitle` | `placeholder`, `alt`, `title`, translation, literal | text |
 * | `locator('#id')`, `[name=…]` | `id`, `name` | exact |
 *
 * A chain breaks when a call matched an anchor's old string and does not match
 * the string that replaced it. For a one-to-one rename of a string argument,
 * the break carries the same chain with the new string.
 */
import type { DiffAnchor } from './diff-anchors';
import {
  renderLocatorChain,
  tryParseLocatorChain,
  type LocatorArg,
  type LocatorCall,
  type LocatorChain,
} from './locator-chain';
import type { LocatorIndex, LocatorIndexEntry, LocatorIndexTest, LocatorIndexUse } from './locator-index';
import { attributeMatches, nameMatches, normalizeWhiteSpace, textMatches } from './locator-text-match';

type LocatorBreakConfidence = 'likely' | 'possible';

export interface LocatorBreak {
  anchor: DiffAnchor;
  /** The chain as the index holds it. */
  locator: string;
  entry: LocatorIndexEntry;
  uses: LocatorIndexUse[];
  /** The tests of `uses`, from the index. */
  tests: LocatorIndexTest[];
  confidence: LocatorBreakConfidence;
  /** The chain with the renamed string, when the anchor is a rename of a string argument. */
  rewrite?: string;
  /** The string arguments the rewrite changes, as `[before, after]` pairs, for editing call sites. */
  replacements?: Array<[string, string]>;
}

export interface PredictLocatorBreaksOptions {
  /** The attributes `getByTestId` reads; the index's, then `data-testid`. */
  testIdAttributes?: string[];
  /**
   * Whether a test (by test case id) is known to reach a file. Given, a break
   * is likely only when one of its tests reaches the changed file.
   */
  reach?: (testId: number, file: string) => boolean;
}

type Rule = 'exact' | 'name' | 'text';

/** One string a call compares with anchors, and where it sits in the call. */
interface Slot {
  value: string | RegExp;
  exact: boolean;
  rule: Rule;
  accepts: (anchor: DiffAnchor) => boolean;
  /** Replaces the string in a copy of the call; absent for a regex. */
  rewrite?: (after: string, before: string) => LocatorCall;
  /** The source literal to edit at a call site, with its replacement. */
  literal?: (after: string, before: string) => [string, string];
}

const TEXT_KINDS = new Set(['text', 'translation', 'literal']);

function isText(anchor: DiffAnchor): boolean {
  return TEXT_KINDS.has(anchor.kind);
}

function hasAttribute(anchor: DiffAnchor, names: readonly string[]): boolean {
  return anchor.kind === 'attribute' && !!anchor.attribute && names.includes(anchor.attribute);
}

function toRegExp(arg: { source: string; flags: string }): RegExp | null {
  try {
    return new RegExp(arg.source, arg.flags.replace(/[gy]/g, ''));
  } catch {
    return null;
  }
}

function optionsOf(arg: LocatorArg | undefined): Map<string, LocatorArg> {
  return new Map(arg?.type === 'object' ? arg.entries : []);
}

function isExact(opts: Map<string, LocatorArg>): boolean {
  const exact = opts.get('exact');
  return exact?.type === 'boolean' && exact.value;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The string a rename turns `value` into: `after` when `value` is `before`
 * (after whitespace normalization, and ignoring case unless exact), otherwise
 * `value` with `before` replaced by `after` inside it.
 */
export function renameValue(value: string, before: string, after: string, exact: boolean): string | null {
  const v = normalizeWhiteSpace(value);
  const b = normalizeWhiteSpace(before);
  if (exact ? v === b : v.toLowerCase() === b.toLowerCase()) return after;
  const re = new RegExp(escapeRegExp(b).replace(/ /g, '\\s+'), exact ? '' : 'i');
  if (!re.test(value)) return null;
  return value.replace(re, () => after);
}

function withArg(call: LocatorCall, index: number, arg: LocatorArg): LocatorCall {
  return { method: call.method, args: call.args.map((a, i) => (i === index ? arg : a)) };
}

function withOption(call: LocatorCall, index: number, key: string, arg: LocatorArg): LocatorCall {
  const obj = call.args[index];
  if (obj?.type !== 'object') return call;
  return withArg(call, index, {
    type: 'object',
    entries: obj.entries.map(([k, v]) => [k, k === key ? arg : v] as [string, LocatorArg]),
  });
}

/** A slot over a string or regex argument, with its rewrite. */
function stringSlot(
  arg: LocatorArg | undefined,
  exact: boolean,
  rule: Rule,
  accepts: (a: DiffAnchor) => boolean,
  replace: (next: LocatorArg) => LocatorCall,
): Slot | null {
  if (arg?.type === 'regex') {
    const re = toRegExp(arg);
    return re ? { value: re, exact, rule, accepts } : null;
  }
  if (arg?.type !== 'string') return null;
  const value = arg.value;
  return {
    value,
    exact,
    rule,
    accepts,
    rewrite: (after, before) => replace({ type: 'string', value: renameValue(value, before, after, exact) ?? value }),
    literal: (after, before) => [value, renameValue(value, before, after, exact) ?? value],
  };
}

/** `#id`, `[attr=value]` and `[attr="value"]` parts of a CSS selector, for the attributes given. */
function cssSlots(selector: string, testIds: readonly string[], replace: (next: string) => LocatorCall): Slot[] {
  const slots: Slot[] = [];
  const slot = (value: string, names: readonly string[], render: (v: string) => string, at: number, len: number) => {
    const edited = (after: string) => selector.slice(0, at) + render(after) + selector.slice(at + len);
    slots.push({
      value,
      exact: true,
      rule: 'exact',
      accepts: (a) => hasAttribute(a, names),
      rewrite: (after) => replace(edited(after)),
      literal: (after) => [selector, edited(after)],
    });
  };
  for (const m of selector.matchAll(/#((?:[\w-]|\\.)+)/g)) {
    slot(
      m[1]!.replace(/\\(.)/g, '$1'),
      ['id'],
      (v) => `#${v.replace(/[^\w-]/g, (c) => `\\${c}`)}`,
      m.index,
      m[0].length,
    );
  }
  for (const m of selector.matchAll(/\[\s*([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/g)) {
    const attr = m[1]!;
    const names = testIds.includes(attr) ? testIds : attr === 'id' || attr === 'name' ? [attr] : null;
    if (!names) continue;
    const quote = m[2] !== undefined ? '"' : m[3] !== undefined ? "'" : '';
    const value = m[2] ?? m[3] ?? m[4]!;
    slot(value, [attr], (v) => `[${attr}=${quote}${v}${quote}]`, m.index, m[0].length);
  }
  return slots;
}

/** The slots of one call's own arguments. */
function directSlots(call: LocatorCall, testIds: readonly string[]): Slot[] {
  const first = call.args[0];
  const opts = optionsOf(call.args[1]);
  const exact = isExact(opts);
  const slots: Array<Slot | null> = [];
  const argSlot = (rule: Rule, accepts: (a: DiffAnchor) => boolean, ex = exact) =>
    stringSlot(first, ex, rule, accepts, (next) => withArg(call, 0, next));
  const hasTextSlot = (index: number) => {
    const hasText = optionsOf(call.args[index]).get('hasText');
    if (!hasText) return null;
    return stringSlot(hasText, false, 'text', isText, (next) => withOption(call, index, 'hasText', next));
  };
  const textOr = (attribute: string) => (a: DiffAnchor) =>
    a.kind === 'translation' || a.kind === 'literal' || hasAttribute(a, [attribute]);
  switch (call.method) {
    case 'getByTestId':
      slots.push(argSlot('exact', (a) => hasAttribute(a, testIds), true));
      break;
    case 'getByRole':
      slots.push(
        stringSlot(
          opts.get('name'),
          exact,
          'name',
          (a) => isText(a) || hasAttribute(a, ['aria-label', 'title', 'alt', 'value']),
          (next) => withOption(call, 1, 'name', next),
        ),
      );
      break;
    case 'getByText':
      slots.push(argSlot('text', isText));
      break;
    case 'getByLabel':
      slots.push(argSlot('text', (a) => isText(a) || hasAttribute(a, ['aria-label'])));
      break;
    case 'getByPlaceholder':
      slots.push(argSlot('text', textOr('placeholder')));
      break;
    case 'getByAltText':
      slots.push(argSlot('text', textOr('alt')));
      break;
    case 'getByTitle':
      slots.push(argSlot('text', textOr('title')));
      break;
    case 'locator':
      if (first?.type === 'string') {
        slots.push(...cssSlots(first.value, testIds, (next) => withArg(call, 0, { type: 'string', value: next })));
      }
      slots.push(hasTextSlot(1));
      break;
    case 'filter':
      slots.push(hasTextSlot(0));
      break;
  }
  return slots.filter((slot): slot is Slot => !!slot);
}

/** The locator chains passed to a call (`filter({ has })`, `and(…)`, `or(…)`), each with how to put an edited copy back. */
function nestedChains(call: LocatorCall): Array<{ chain: LocatorChain; put: (c: LocatorChain) => LocatorCall }> {
  const out: Array<{ chain: LocatorChain; put: (c: LocatorChain) => LocatorCall }> = [];
  call.args.forEach((arg, index) => {
    if (arg.type === 'chain')
      out.push({ chain: arg.chain, put: (c) => withArg(call, index, { type: 'chain', chain: c }) });
    if (arg.type === 'object') {
      for (const [key, v] of arg.entries) {
        if (v.type === 'chain') {
          out.push({ chain: v.chain, put: (c) => withOption(call, index, key, { type: 'chain', chain: c }) });
        }
      }
    }
  });
  return out;
}

/** A slot whose rewrite yields the whole chain. */
interface ChainSlot extends Omit<Slot, 'rewrite'> {
  rewrite?: (after: string, before: string) => LocatorChain;
}

/** Every slot of a chain, nested chains included. */
function chainSlots(chain: LocatorChain, testIds: readonly string[]): ChainSlot[] {
  const out: ChainSlot[] = [];
  chain.calls.forEach((call, i) => {
    const replaceAt = (next: LocatorCall): LocatorChain => ({ calls: chain.calls.map((c, j) => (j === i ? next : c)) });
    for (const slot of directSlots(call, testIds)) {
      const rewrite = slot.rewrite;
      out.push({ ...slot, rewrite: rewrite && ((after, before) => replaceAt(rewrite(after, before))) });
    }
    for (const n of nestedChains(call)) {
      for (const slot of chainSlots(n.chain, testIds)) {
        const rewrite = slot.rewrite;
        out.push({ ...slot, rewrite: rewrite && ((after, before) => replaceAt(n.put(rewrite(after, before)))) });
      }
    }
  });
  return out;
}

function slotMatches(slot: ChainSlot, text: string): boolean {
  switch (slot.rule) {
    case 'exact':
      return attributeMatches(slot.value, true, text);
    case 'name':
      return nameMatches(slot.value, slot.exact, text);
    case 'text':
      return textMatches(slot.value, slot.exact, text);
  }
}

const filePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

/** Two paths name the same file when equal or one ends with the other at a directory boundary. */
export function sameFilePath(a: string, b: string): boolean {
  const x = filePath(a);
  const y = filePath(b);
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

/**
 * The items whose path names `file` by {@link sameFilePath}: only those with `file`'s own path when any has it,
 * since another file can end with the same path (`apps/admin/src/App.vue` for `src/App.vue`).
 */
export function itemsOfFile<T extends { path: string }>(items: readonly T[], file: string): T[] {
  const matching = items.filter((item) => sameFilePath(item.path, file));
  const own = filePath(file);
  const exact = matching.filter((item) => filePath(item.path) === own);
  return exact.length > 0 ? exact : matching;
}

/** The parts of a code index (`GET /api/projects/:id/code-index`) that say which test reaches which file. */
export interface CodeReachIndex {
  files: string[];
  tests: Array<{ id: number }>;
  reach: Array<{ file: number; tests: number[]; origin: string }>;
}

/**
 * Whether a test reaches a file, from a code index, as `predictLocatorBreaks`
 * reads it; undefined when the index holds no client reach.
 */
export function reachOfIndex(index: CodeReachIndex): ((testId: number, file: string) => boolean) | undefined {
  if (!index.reach.some((r) => r.origin === 'client')) return undefined;
  const filesOf = new Map<number, string[]>();
  for (const r of index.reach) {
    const file = index.files[r.file];
    if (file === undefined) continue;
    for (const t of r.tests) {
      const id = index.tests[t]?.id;
      if (id === undefined) continue;
      const files = filesOf.get(id);
      if (files) files.push(file);
      else filesOf.set(id, [file]);
    }
  }
  return (testId, file) => (filesOf.get(testId) ?? []).some((reached) => sameFilePath(reached, file));
}

/** The file of a `file:line:col` call site. */
export function callSiteFile(callSite: string): string {
  return callSite.replace(/:\d+(?::\d+)?$/, '');
}

/** The line of a `file:line:col` call site; null when it names none. */
export function callSiteLine(callSite: string): number | null {
  const m = /:(\d+)(?::\d+)?$/.exec(callSite);
  return m ? Number(m[1]) : null;
}

/** Every file the index's tests call locators from. */
export function locatorCallSiteFiles(index: LocatorIndex): Set<string> {
  const files = new Set<string>();
  for (const entry of index.locators) {
    for (const use of entry.uses) for (const site of use.callSites) files.add(callSiteFile(site));
  }
  return files;
}

const CONFIDENCE_RANK: Record<LocatorBreakConfidence, number> = { likely: 0, possible: 1 };

/**
 * The chains of `index` the anchors break, likely first, then by the number
 * of tests. Anchors in a file the index's tests call locators from are
 * skipped: a change there edits the locator itself.
 */
export function predictLocatorBreaks(
  anchors: DiffAnchor[],
  index: LocatorIndex,
  options: PredictLocatorBreaksOptions = {},
): LocatorBreak[] {
  const testIds = options.testIdAttributes ?? index.testIdAttributes ?? ['data-testid'];
  const siteFiles = [...locatorCallSiteFiles(index)];
  const live = anchors.filter((a) => !siteFiles.some((f) => sameFilePath(f, a.file)));
  if (!live.length) return [];
  const breaks: LocatorBreak[] = [];
  for (const entry of index.locators) {
    const chain = tryParseLocatorChain(entry.locator);
    if (!chain) continue;
    const slots = chainSlots(chain, testIds);
    if (!slots.length) continue;
    for (const anchor of live) {
      const hit = slots.filter(
        (slot) =>
          slot.accepts(anchor) &&
          slotMatches(slot, anchor.before) &&
          (anchor.after === undefined || !slotMatches(slot, anchor.after)),
      );
      if (!hit.length) continue;
      const tests = [...new Set(entry.uses.map((u) => u.test))]
        .map((t) => index.tests[t])
        .filter((t): t is LocatorIndexTest => !!t);
      const found: LocatorBreak = {
        anchor,
        locator: entry.locator,
        entry,
        uses: entry.uses,
        tests,
        confidence: confidenceOf(anchor, tests, options.reach),
      };
      if (anchor.after !== undefined && hit.every((slot) => slot.rewrite)) {
        let rewritten: LocatorChain = chain;
        const replacements: Array<[string, string]> = [];
        for (const slot of hit) {
          // Each slot is re-found in the edited chain by position, so apply them one at a time.
          const again = chainSlots(rewritten, testIds).find(
            (s) => s.rule === slot.rule && String(s.value) === String(slot.value) && s.rewrite,
          );
          if (!again?.rewrite) continue;
          rewritten = again.rewrite(anchor.after, anchor.before);
          if (slot.literal) replacements.push(slot.literal(anchor.after, anchor.before));
        }
        const rendered = renderLocatorChain(rewritten);
        if (rendered !== entry.locator) {
          found.rewrite = rendered;
          found.replacements = replacements.filter(([a, b]) => a !== b);
        }
      }
      breaks.push(found);
    }
  }
  return breaks.sort(
    (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || b.tests.length - a.tests.length,
  );
}

/**
 * Likely: the string was an attribute value, tag text or translation value,
 * and, with reach data, one of the tests reaches the changed file. A
 * translation file's own anchors skip the reach check: no test executes a
 * locale file. Possible: a bare literal, or no test reaches the file.
 */
function confidenceOf(
  anchor: DiffAnchor,
  tests: LocatorIndexTest[],
  reach: PredictLocatorBreaksOptions['reach'],
): LocatorBreakConfidence {
  if (anchor.kind === 'literal') return 'possible';
  if (!reach) return 'likely';
  if (anchor.kind === 'translation' && /\.(?:json|ya?ml|properties|po|resx)$/i.test(anchor.file)) return 'likely';
  return tests.some((t) => reach(t.id, anchor.file)) ? 'likely' : 'possible';
}
