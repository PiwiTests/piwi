/**
 * The search language of the test lists — a run's Tests tab and a project's
 * Tests catalog. A query is a list of terms separated by spaces:
 *
 * - a free word (`checkout`) or a "quoted phrase" matches the test title, its
 *   describe blocks and its file path (and, on a run, the error text);
 * - a qualifier (`file:cart.spec.ts`, `describe:"Guest checkout"`, `tag:smoke`)
 *   matches one field only;
 * - a leading `-` excludes (`-tag:slow`, `-file:legacy`).
 *
 * Text fields (title, describe, file, error) match anywhere inside the value,
 * and `*` stands for any characters; the others (tag, lock, browser, owner,
 * priority, feature, id) match a whole value. Case and accents never matter
 * (`foldText`). Every term must
 * match, except that repeating a qualifier of a field a test has one value of
 * (file, browser, owner, priority, feature, id) matches any of the values. A
 * qualifier the list does not know is read as a free word.
 *
 * One parser serves the browser (the run list filters in memory, both lists
 * highlight matches and suggest completions) and the server (the catalog turns
 * the same terms into SQL), so a query means the same thing on both lists.
 */

import { foldText, foldTextWithOffsets } from '#shared/utils/fold-text';

export type TestSearchField =
  | 'file'
  | 'describe'
  | 'title'
  | 'tag'
  | 'browser'
  | 'error'
  | 'lock'
  | 'owner'
  | 'priority'
  | 'feature'
  | 'id';

export interface TestSearchFieldDef {
  field: TestSearchField;
  /** The qualifier suggestions insert. */
  key: string;
  /** Other spellings accepted for the same qualifier. */
  aliases: readonly string[];
  /** What the qualifier filters on, shown beside it in the suggestions. */
  description: string;
  /** `contains`: anywhere inside the value, `*` as a wildcard. `exact`: the whole value. */
  match: 'contains' | 'exact';
  /** A test has one value of this field, so a repeated qualifier matches any of its values. */
  single: boolean;
}

export const TEST_SEARCH_FIELD_DEFS: readonly TestSearchFieldDef[] = [
  { field: 'file', key: 'file', aliases: ['path'], description: 'Spec file path', match: 'contains', single: true },
  {
    field: 'describe',
    key: 'describe',
    aliases: ['suite'],
    description: 'Describe block',
    match: 'contains',
    single: false,
  },
  {
    field: 'title',
    key: 'title',
    aliases: ['test', 'name'],
    description: 'Test title',
    match: 'contains',
    single: false,
  },
  { field: 'tag', key: 'tag', aliases: [], description: 'Tag, with or without @', match: 'exact', single: false },
  {
    field: 'browser',
    key: 'browser',
    aliases: ['project'],
    description: 'Playwright project',
    match: 'exact',
    single: true,
  },
  { field: 'error', key: 'error', aliases: [], description: 'Error message', match: 'contains', single: false },
  { field: 'lock', key: 'lock', aliases: [], description: 'Lock', match: 'exact', single: false },
  { field: 'owner', key: 'owner', aliases: [], description: 'Owner', match: 'exact', single: true },
  { field: 'priority', key: 'priority', aliases: [], description: 'Priority', match: 'exact', single: true },
  { field: 'feature', key: 'feature', aliases: [], description: 'Feature', match: 'exact', single: true },
  { field: 'id', key: 'id', aliases: [], description: 'External test ID', match: 'exact', single: true },
];

const DEF_BY_FIELD = new Map(TEST_SEARCH_FIELD_DEFS.map((def) => [def.field, def]));

export function testSearchFieldDef(field: TestSearchField): TestSearchFieldDef {
  return DEF_BY_FIELD.get(field)!;
}

/** The qualifiers of a run's Tests tab: executions carry an error and a browser. */
export const RUN_SEARCH_FIELDS: readonly TestSearchField[] = [
  'file',
  'describe',
  'title',
  'tag',
  'browser',
  'error',
  'lock',
  'owner',
  'priority',
  'feature',
  'id',
];

/** The qualifiers of a project's Tests catalog. */
export const CATALOG_SEARCH_FIELDS: readonly TestSearchField[] = [
  'file',
  'describe',
  'title',
  'tag',
  'lock',
  'owner',
  'priority',
  'feature',
  'id',
];

/** The fields a free word or phrase is looked for in, when the list has them. */
const FREE_TEXT_FIELDS: readonly TestSearchField[] = ['title', 'describe', 'file', 'error'];

/** One term of a query, with where it sits in the text (for completion). */
export interface TestSearchToken {
  /** Offset of the term's first character. */
  start: number;
  /** Offset just past its last character. */
  end: number;
  negated: boolean;
  /** The qualifier's field; null for a free word or phrase. */
  field: TestSearchField | null;
  /** The value with its quotes removed. */
  value: string;
  /** The value was written with quotes. */
  quoted: boolean;
}

export interface TestSearchTerm {
  field: TestSearchField | null;
  value: string;
  negated: boolean;
}

export interface TestSearchQuery {
  terms: TestSearchTerm[];
  /** The qualifiers the query was read with. */
  fields: readonly TestSearchField[];
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0';
}

function fieldForKey(key: string, fields: ReadonlySet<TestSearchField>): TestSearchField | null {
  const lower = key.toLowerCase();
  for (const def of TEST_SEARCH_FIELD_DEFS) {
    if (!fields.has(def.field)) continue;
    if (def.key === lower || def.aliases.includes(lower)) return def.field;
  }
  return null;
}

/** Remove the quotes of a (possibly partly) quoted value; `\"` and `\\` stand for `"` and `\`. */
function unquote(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
      out += text[i + 1];
      i++;
    } else if (ch !== '"') {
      out += ch;
    }
  }
  return out;
}

function readToken(raw: string, start: number, end: number, fields: ReadonlySet<TestSearchField>): TestSearchToken {
  const negated = raw.startsWith('-');
  const body = negated ? raw.slice(1) : raw;
  const qualifier = /^([A-Za-z]+):/.exec(body);
  const field = qualifier ? fieldForKey(qualifier[1]!, fields) : null;
  const rawValue = field ? body.slice(qualifier![0].length) : body;
  return { start, end, negated, field, value: unquote(rawValue), quoted: rawValue.includes('"') };
}

/**
 * Split a query into its terms. A quote keeps spaces inside one term
 * (`describe:"Guest checkout"`); an unclosed quote runs to the end of the text.
 */
export function tokenizeTestSearch(
  query: string,
  fields: readonly TestSearchField[] = RUN_SEARCH_FIELDS,
): TestSearchToken[] {
  const allowed = new Set(fields);
  const tokens: TestSearchToken[] = [];
  let i = 0;
  while (i < query.length) {
    while (i < query.length && isSpace(query[i]!)) i++;
    if (i >= query.length) break;
    const start = i;
    let inQuote = false;
    while (i < query.length) {
      const ch = query[i]!;
      if (inQuote) {
        if (ch === '\\' && i + 1 < query.length) i++;
        else if (ch === '"') inQuote = false;
      } else if (isSpace(ch)) {
        break;
      } else if (ch === '"') {
        inQuote = true;
      }
      i++;
    }
    tokens.push(readToken(query.slice(start, i), start, i, allowed));
  }
  return tokens;
}

/** The value a term compares: trimmed, and a tag without its leading `@`. */
function termValue(field: TestSearchField | null, value: string): string {
  const trimmed = value.trim();
  return field === 'tag' ? trimmed.replace(/^@+/, '') : trimmed;
}

/** A contains-value made only of wildcards matches everything, so it constrains nothing. */
function isBlankTerm(field: TestSearchField | null, value: string): boolean {
  if (value === '') return true;
  const match = field ? testSearchFieldDef(field).match : 'contains';
  return match === 'contains' && /^\*+$/.test(value);
}

/** Read a query into the terms that filter; incomplete ones (`file:` alone, a lone `-`) are left out. */
export function parseTestSearch(
  query: string,
  fields: readonly TestSearchField[] = RUN_SEARCH_FIELDS,
): TestSearchQuery {
  const terms: TestSearchTerm[] = [];
  for (const token of tokenizeTestSearch(query, fields)) {
    const value = termValue(token.field, token.value);
    if (isBlankTerm(token.field, value)) continue;
    terms.push({ field: token.field, value, negated: token.negated });
  }
  return { terms, fields };
}

/** The free-text fields a query of this list looks in. */
export function freeTextFields(fields: readonly TestSearchField[]): TestSearchField[] {
  return FREE_TEXT_FIELDS.filter((field) => fields.includes(field));
}

/** Write a value so that it reads back as one term: quoted when it holds a space or a quote. */
export function formatTestSearchValue(value: string): string {
  if (value !== '' && /^[^\s"\\]+$/.test(value) && !value.startsWith('-')) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** The text of a qualifier term, e.g. `file:cart.spec.ts` or `describe:"Guest checkout"`. */
export function formatTestSearchTerm(field: TestSearchField, value: string, negated = false): string {
  return `${negated ? '-' : ''}${testSearchFieldDef(field).key}:${formatTestSearchValue(value)}`;
}

// ── Matching ──────────────────────────────────────────────────────────────────

/** What a test list row offers to the matcher; a field the list does not have stays unset. */
export interface TestSearchSubject {
  title: string;
  suitePath?: readonly string[] | null;
  filePath?: string | null;
  /** The error text, without its ANSI codes. */
  error?: string | null;
  /** Tags without their `@`. */
  tags?: readonly string[] | null;
  locks?: readonly string[] | null;
  browser?: string | null;
  owner?: string | null;
  priority?: string | null;
  feature?: string | null;
  /** The test's external ID (`piwi:id`, or read from its title). */
  externalId?: string | null;
}

/** The describe path as one string, blocks joined the way the database stores them. */
const DESCRIBE_JOINER = '\x1f';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A contains-value as a matcher: its `*`-separated parts must appear in order,
 * anywhere in the text, ignoring case and accents. It reads folded text
 * (`foldText`). Each part is found with a plain literal search from where the
 * last one ended, so the cost stays linear in the text however many stars the
 * value holds. Stars at either end add nothing (the match is anywhere already),
 * so a highlight covers only what the value names.
 */
interface ContainsMatcher {
  /** The first span of `folded`, from the start of its first part to the end of its last, at or after `from`. */
  find(folded: string, from?: number): [number, number] | null;
}

function containsMatcher(value: string): ContainsMatcher {
  const parts = value.split('*').map(foldText).filter(Boolean);
  return {
    find(folded, from = 0) {
      if (parts.length === 0) return null;
      let at = from;
      let start = -1;
      for (const part of parts) {
        const hit = folded.indexOf(part, at);
        if (hit < 0) return null;
        if (start < 0) start = hit;
        at = hit + part.length;
      }
      return [start, at];
    },
  };
}

function subjectTexts(subject: TestSearchSubject, field: TestSearchField): string[] {
  switch (field) {
    case 'title':
      return [subject.title];
    case 'describe':
      return subject.suitePath?.length ? [subject.suitePath.join(DESCRIBE_JOINER)] : [];
    case 'file':
      return subject.filePath ? [subject.filePath] : [];
    case 'error':
      return subject.error ? [subject.error] : [];
    case 'tag':
      return (subject.tags ?? []).map((tag) => tag.replace(/^@+/, ''));
    case 'lock':
      return [...(subject.locks ?? [])];
    case 'browser':
      return subject.browser ? [subject.browser] : [];
    case 'owner':
      return subject.owner ? [subject.owner] : [];
    case 'priority':
      return subject.priority ? [subject.priority] : [];
    case 'feature':
      return subject.feature ? [subject.feature] : [];
    case 'id':
      return subject.externalId ? [subject.externalId] : [];
  }
}

type Predicate = (subject: TestSearchSubject) => boolean;

function termPredicate(term: TestSearchTerm, fields: readonly TestSearchField[]): Predicate {
  if (term.field === null) {
    const matcher = containsMatcher(term.value);
    const lookIn = freeTextFields(fields);
    return (subject) =>
      lookIn.some((field) => subjectTexts(subject, field).some((text) => !!matcher.find(foldText(text))));
  }
  const field = term.field;
  if (testSearchFieldDef(field).match === 'contains') {
    const matcher = containsMatcher(term.value);
    return (subject) => subjectTexts(subject, field).some((text) => !!matcher.find(foldText(text)));
  }
  const wanted = foldText(term.value);
  return (subject) => subjectTexts(subject, field).some((text) => foldText(text) === wanted);
}

/**
 * Turn a query into one predicate over list rows. Compile once per query and
 * run it over every row: the patterns are built here, not per row.
 */
export function compileTestSearch(query: TestSearchQuery): Predicate {
  const required: Predicate[] = [];
  const anyOf = new Map<TestSearchField, Predicate[]>();
  for (const term of query.terms) {
    const predicate = termPredicate(term, query.fields);
    if (term.negated) {
      required.push((subject) => !predicate(subject));
    } else if (term.field && testSearchFieldDef(term.field).single) {
      const group = anyOf.get(term.field) ?? [];
      group.push(predicate);
      anyOf.set(term.field, group);
    } else {
      required.push(predicate);
    }
  }
  for (const group of anyOf.values()) required.push((subject) => group.some((predicate) => predicate(subject)));
  return (subject) => required.every((predicate) => predicate(subject));
}

// ── Highlighting ──────────────────────────────────────────────────────────────

/** The patterns to mark in each visible text of a row, from the query's positive text terms. */
export interface TestSearchHighlights {
  title: string[];
  describe: string[];
  file: string[];
  error: string[];
}

export function testSearchHighlights(query: TestSearchQuery): TestSearchHighlights {
  const out: TestSearchHighlights = { title: [], describe: [], file: [], error: [] };
  const free = freeTextFields(query.fields);
  for (const term of query.terms) {
    if (term.negated) continue;
    const targets = term.field === null ? free : [term.field];
    for (const field of targets) {
      if (field === 'title' || field === 'describe' || field === 'file' || field === 'error')
        out[field].push(term.value);
    }
  }
  return out;
}

/** The `[start, end)` spans of `text` that match any pattern, sorted and merged. */
export function highlightRanges(text: string, patterns: readonly string[] | null | undefined): Array<[number, number]> {
  if (!text || !patterns?.length) return [];
  const folded = foldTextWithOffsets(text);
  const ranges: Array<[number, number]> = [];
  for (const value of patterns) {
    if (isBlankTerm(null, value)) continue;
    const matcher = containsMatcher(value);
    for (let span = matcher.find(folded.text); span; span = matcher.find(folded.text, span[1])) {
      ranges.push([folded.starts[span[0]]!, folded.ends[span[1] - 1]!]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// ── Completion ────────────────────────────────────────────────────────────────

export interface TestSearchValue {
  value: string;
  /** How many tests carry it. */
  count: number;
}

/** Every value a qualifier can take in a list, for completion. */
export type TestSearchValues = Partial<Record<TestSearchField, TestSearchValue[]>>;

/** The fields completion offers values for (the free-text ones have too many). */
const VALUE_FIELDS: readonly TestSearchField[] = [
  'file',
  'describe',
  'tag',
  'browser',
  'lock',
  'owner',
  'priority',
  'feature',
];

/** Count every value of the list's value fields: a describe block once per test under it. */
export function collectTestSearchValues(
  subjects: Iterable<TestSearchSubject>,
  fields: readonly TestSearchField[] = RUN_SEARCH_FIELDS,
): TestSearchValues {
  const wanted = VALUE_FIELDS.filter((field) => fields.includes(field));
  const counts = new Map<TestSearchField, Map<string, number>>(wanted.map((field) => [field, new Map()]));
  for (const subject of subjects) {
    for (const field of wanted) {
      const values = field === 'describe' ? [...(subject.suitePath ?? [])] : subjectTexts(subject, field);
      const tally = counts.get(field)!;
      for (const value of new Set(values)) {
        if (value) tally.set(value, (tally.get(value) ?? 0) + 1);
      }
    }
  }
  const out: TestSearchValues = {};
  for (const [field, tally] of counts) {
    if (tally.size === 0) continue;
    out[field] = [...tally.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return out;
}

export type TestSearchSuggestion =
  | { kind: 'field'; field: TestSearchField; key: string; description: string }
  | { kind: 'value'; field: TestSearchField; key: string; value: string; count: number };

export interface TestSearchCompletion {
  /** The span of the query a chosen suggestion replaces. */
  start: number;
  end: number;
  /** The term being typed excludes (`-`), and so does whatever replaces it. */
  negated: boolean;
  /** The qualifier being filled in, when the term has one. */
  field: TestSearchField | null;
  /** What is typed of the term so far: the value of a qualifier, or the bare word. */
  value: string;
  suggestions: TestSearchSuggestion[];
}

/** The term under the caret, or an empty one when the caret sits between terms. */
function tokenAtCaret(tokens: TestSearchToken[], caret: number): TestSearchToken {
  const hit = tokens.find((token) => token.start <= caret && caret <= token.end);
  return hit ?? { start: caret, end: caret, negated: false, field: null, value: '', quoted: false };
}

/** Better matches first: the whole value, then a prefix, then a word start, then anywhere. */
function matchRank(value: string, typed: string): number {
  if (!typed) return 3;
  const lower = foldText(value);
  if (lower === typed) return 0;
  if (lower.startsWith(typed)) return 1;
  if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(typed)}`).test(lower)) return 2;
  return lower.includes(typed) ? 3 : -1;
}

interface RankedValue {
  entry: TestSearchValue;
  rank: number;
}

function byRank(a: RankedValue, b: RankedValue): number {
  return a.rank - b.rank || b.entry.count - a.entry.count || a.entry.value.localeCompare(b.entry.value);
}

function rankValues(values: TestSearchValue[], typed: string, used: ReadonlySet<string>, limit: number) {
  return values
    .filter((entry) => !used.has(foldText(entry.value)))
    .map((entry): RankedValue => ({ entry, rank: matchRank(entry.value, typed) }))
    .filter((ranked) => ranked.rank >= 0)
    .sort(byRank)
    .slice(0, limit);
}

/**
 * What to offer for the term under the caret. A qualifier (`file:ca`) gets the
 * values of its field that contain what is typed; a bare word gets the
 * qualifiers it starts, then the values of any field that contain it; an empty
 * term gets every qualifier.
 */
export function completeTestSearch(options: {
  query: string;
  caret: number;
  fields: readonly TestSearchField[];
  values: TestSearchValues;
  limit?: number;
}): TestSearchCompletion {
  const { query, caret, fields, values, limit = 8 } = options;
  const tokens = tokenizeTestSearch(query, fields);
  const token = tokenAtCaret(tokens, caret);
  const base = { start: token.start, end: token.end, negated: token.negated, field: token.field, value: token.value };

  // Values already in the query, per field, are not offered again.
  const used = new Map<TestSearchField, Set<string>>();
  for (const other of tokens) {
    if (other === token || !other.field) continue;
    const set = used.get(other.field) ?? new Set<string>();
    set.add(foldText(termValue(other.field, other.value)));
    used.set(other.field, set);
  }
  const usedIn = (field: TestSearchField) => used.get(field) ?? new Set<string>();

  const valueSuggestion = (def: TestSearchFieldDef, entry: TestSearchValue): TestSearchSuggestion => ({
    kind: 'value',
    field: def.field,
    key: def.key,
    value: entry.value,
    count: entry.count,
  });

  if (token.field) {
    const def = testSearchFieldDef(token.field);
    const typed = foldText(termValue(token.field, token.value));
    const ranked = rankValues(values[token.field] ?? [], typed, usedIn(token.field), limit);
    return { ...base, suggestions: ranked.map(({ entry }) => valueSuggestion(def, entry)) };
  }

  if (token.quoted) return { ...base, suggestions: [] };
  const typed = foldText(token.value);
  const defs = TEST_SEARCH_FIELD_DEFS.filter((def) => fields.includes(def.field));
  const keyMatches = defs
    .filter((def) => !typed || def.key.startsWith(typed) || def.aliases.some((alias) => alias.startsWith(typed)))
    .map((def): TestSearchSuggestion => ({
      kind: 'field',
      field: def.field,
      key: def.key,
      description: def.description,
    }));
  if (!typed) return { ...base, suggestions: keyMatches };

  // A bare word also offers the values of every field that contain it, a few per field.
  const valueMatches: Array<RankedValue & { def: TestSearchFieldDef }> = [];
  if (typed.length >= 2) {
    const perField = Math.max(2, Math.ceil(limit / 3));
    for (const def of defs) {
      for (const ranked of rankValues(values[def.field] ?? [], typed, usedIn(def.field), perField)) {
        valueMatches.push({ ...ranked, def });
      }
    }
    valueMatches.sort(byRank);
  }
  const suggestions = [...keyMatches, ...valueMatches.map(({ def, entry }) => valueSuggestion(def, entry))];
  return { ...base, suggestions: suggestions.slice(0, limit) };
}

/**
 * Put a chosen suggestion in place of the term it completes. A qualifier leaves
 * the caret after its colon, ready for a value; a value closes the term with a
 * space, ready for the next one.
 */
export function applyTestSearchSuggestion(
  query: string,
  completion: Pick<TestSearchCompletion, 'start' | 'end' | 'negated'>,
  suggestion: TestSearchSuggestion,
): { query: string; caret: number } {
  const prefix = completion.negated ? '-' : '';
  const before = query.slice(0, completion.start);
  const after = query.slice(completion.end);
  if (suggestion.kind === 'field') {
    const text = `${prefix}${suggestion.key}:`;
    return { query: before + text + after, caret: before.length + text.length };
  }
  const text = `${prefix}${suggestion.key}:${formatTestSearchValue(suggestion.value)}`;
  const spacer = after.length > 0 && isSpace(after[0]!) ? '' : ' ';
  return { query: before + text + spacer + after, caret: before.length + text.length + 1 };
}
