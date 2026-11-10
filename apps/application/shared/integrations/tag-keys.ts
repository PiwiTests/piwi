/**
 * The two patterns that read a key out of a test's tags: the issue key of the tracker integration (a tag naming the bug
 * a failure is tracked in) and the test case key of the test management integration (a tag naming the case a test
 * covers). One helper reads both, and the project's settings edit both in one place.
 *
 * A pattern is a regular expression without flags, tested against a tag without its `@`. It is anchored with `^` and
 * `$` and is a flat list of atoms (a literal, an escape such as `\d`, or a character class), each with at most one
 * quantifier: no groups, no `|`. Because of that a pattern is matched here by walking the tag once per atom, not with
 * the engine's backtracking, so matching takes time proportional to the tag length. Nothing here throws: a pattern
 * that is not valid matches nothing, and `validateTagKeyPattern` says why.
 */

/** The longest pattern a project stores. */
export const MAX_TAG_KEY_PATTERN_LENGTH = 200;

/** The longest tag a pattern is tested against; a longer tag matches nothing. */
export const MAX_TAG_KEY_TEXT_LENGTH = 128;

/** The largest repeat count a `{n,m}` quantifier names. */
const MAX_REPEAT_COUNT = 32;

/** A project's tag key patterns; null turns a pattern off. */
export interface TagKeyPatterns {
  /** The issue key a tag carries, such as `^[A-Z][A-Z0-9]+-[0-9]+$`. */
  issue: string | null;
  /** The test case key a tag carries, such as `^SHOP-T[0-9]+$`. */
  testCase: string | null;
}

/** Both patterns off. */
export const DEFAULT_TAG_KEY_PATTERNS: Readonly<TagKeyPatterns> = Object.freeze({ issue: null, testCase: null });

export type TagKeyPatternCheck = { ok: true } | { ok: false; message: string };

const SYNTAX_MESSAGE = 'Use letters, digits, character classes and quantifiers only (no groups or |).';
const ANCHOR_MESSAGE = 'Anchor it with ^ and $.';

const CLASS_ESCAPES = new Set(['d', 'D', 'w', 'W', 's', 'S']);

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

/** Whether `char` after a backslash is an escape the patterns allow: `\d`-style classes or an escaped symbol. */
function isAllowedEscape(char: string): boolean {
  return CLASS_ESCAPES.has(char) || /^[^A-Za-z0-9]$/.test(char);
}

/** One element of a pattern: a single character that passes `test`, repeated `min` to `max` times (null: unbounded). */
interface Atom {
  test: (char: string) => boolean;
  min: number;
  max: number | null;
}

/** Reads the quantifier at `index`, if any: its end and its repeat counts, or an error. */
function readQuantifier(
  body: string,
  index: number,
): { end: number; min: number; max: number | null } | { error: string } | null {
  const char = body[index];
  if (char === '*') return { end: index + 1, min: 0, max: null };
  if (char === '+') return { end: index + 1, min: 1, max: null };
  if (char === '?') return { end: index + 1, min: 0, max: 1 };
  if (char !== '{') return null;
  const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(body.slice(index));
  if (!match) return { error: SYNTAX_MESSAGE };
  const min = Number(match[1]);
  const max = match[2] ? (match[3] ? Number(match[3]) : null) : min;
  if (max !== null && max < min) return { error: SYNTAX_MESSAGE };
  if (min > MAX_REPEAT_COUNT || (max !== null && max > MAX_REPEAT_COUNT)) {
    return { error: `A repeat count is ${MAX_REPEAT_COUNT} at most.` };
  }
  return { end: index + match[0].length, min, max };
}

/** A test for one character: an exact character, or a one-character regular expression for a class. */
function literalTest(literal: string): (char: string) => boolean {
  return (char) => char === literal;
}

function classTest(source: string): (char: string) => boolean {
  const regex = new RegExp(`^${source}$`);
  return (char) => regex.test(char);
}

/**
 * Reads the body between `^` and `$` as a sequence of atoms (a literal, an escape, a character class), each followed by
 * at most one quantifier.
 */
function parseBody(body: string): { ok: true; atoms: Atom[] } | { ok: false; message: string } {
  const atoms: Atom[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index]!;
    let test: (char: string) => boolean;
    if (char === '\\') {
      const next = body[index + 1];
      if (next === undefined || !isAllowedEscape(next)) return fail(SYNTAX_MESSAGE);
      test = CLASS_ESCAPES.has(next) ? classTest(`\\${next}`) : literalTest(next);
      index += 2;
    } else if (char === '[') {
      const start = index;
      index += 1;
      if (body[index] === '^') index += 1;
      const first = index;
      while (index < body.length && body[index] !== ']') {
        if (body[index] === '\\') {
          const next = body[index + 1];
          if (next === undefined || !isAllowedEscape(next)) return fail(SYNTAX_MESSAGE);
          index += 2;
        } else {
          index += 1;
        }
      }
      if (index >= body.length || index === first) return fail(SYNTAX_MESSAGE);
      index += 1;
      try {
        test = classTest(body.slice(start, index));
      } catch {
        return fail('Not a valid regular expression.');
      }
    } else if ('()|.^$*+?{}]'.includes(char)) {
      return fail(SYNTAX_MESSAGE);
    } else {
      test = literalTest(char);
      index += 1;
    }

    const quantifier = readQuantifier(body, index);
    if (quantifier && 'error' in quantifier) return fail(quantifier.error);
    if (quantifier) {
      index = quantifier.end;
      if (readQuantifier(body, index) !== null) return fail(SYNTAX_MESSAGE);
    }
    atoms.push({ test, min: quantifier?.min ?? 1, max: quantifier ? quantifier.max : 1 });
  }
  return { ok: true, atoms };
}

/** Whether the last character is a `$` that no backslash escapes. */
function endsWithUnescapedDollar(text: string): boolean {
  if (!text.endsWith('$')) return false;
  let backslashes = 0;
  for (let index = text.length - 2; index >= 0 && text[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 0;
}

/**
 * Whether `pattern` can be stored: it is not empty, holds at most `MAX_TAG_KEY_PATTERN_LENGTH` characters, is anchored
 * with `^` and `$`, uses only literals, escapes, character classes and quantifiers, compiles, and does not match the
 * empty string. Surrounding whitespace is ignored.
 */
export function validateTagKeyPattern(pattern: string): TagKeyPatternCheck {
  const parsed = parseTagKeyPattern(pattern);
  return parsed.ok ? { ok: true } : parsed;
}

/** Reads a pattern into its atoms, or says why it cannot be stored. */
function parseTagKeyPattern(pattern: string): { ok: true; atoms: Atom[] } | { ok: false; message: string } {
  const text = pattern.trim();
  if (!text) return fail('Enter a pattern, or leave the field empty to turn it off.');
  if (text.length > MAX_TAG_KEY_PATTERN_LENGTH) {
    return fail(`A pattern holds ${MAX_TAG_KEY_PATTERN_LENGTH} characters at most.`);
  }
  if (/^\/.*\/[a-z]*$/s.test(text)) return fail('Enter the pattern without slashes or flags.');

  if (!text.startsWith('^') || text.length < 2 || !endsWithUnescapedDollar(text)) return fail(ANCHOR_MESSAGE);

  const parsed = parseBody(text.slice(1, -1));
  if (!parsed.ok) return parsed;

  try {
    new RegExp(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : '';
    return fail(reason ? `Not a valid regular expression: ${reason}` : 'Not a valid regular expression.');
  }
  if (parsed.atoms.every((atom) => atom.min === 0)) {
    return fail('This pattern matches an empty tag; make at least one part required.');
  }
  return parsed;
}

/**
 * Whether the atoms match all of `text`: the positions reached after each atom, from 0 to the end. Each atom tests each
 * character once and moves the positions forward one character per repeat, so an atom costs the tag length times its
 * repeat count at most (an unbounded repeat is one forward pass).
 */
function matchesAtoms(atoms: readonly Atom[], text: string): boolean {
  const length = text.length;
  const passes = new Uint8Array(length);
  let reached: Uint8Array = new Uint8Array(length + 1);
  reached[0] = 1;
  const step = (from: Uint8Array): Uint8Array => {
    const to = new Uint8Array(length + 1);
    for (let position = 0; position < length; position += 1) {
      if (from[position] && passes[position]) to[position + 1] = 1;
    }
    return to;
  };
  for (const atom of atoms) {
    for (let position = 0; position < length; position += 1) passes[position] = atom.test(text[position]!) ? 1 : 0;
    let frontier: Uint8Array = reached;
    for (let count = 0; count < atom.min; count += 1) frontier = step(frontier);
    const next: Uint8Array = frontier.slice();
    if (atom.max === null) {
      for (let position = 0; position < length; position += 1) {
        if (next[position] && passes[position]) next[position + 1] = 1;
      }
    } else {
      for (let count = atom.min; count < atom.max && frontier.includes(1); count += 1) {
        frontier = step(frontier);
        for (let position = 0; position <= length; position += 1) if (frontier[position]) next[position] = 1;
      }
    }
    if (!next.includes(1)) return false;
    reached = next;
  }
  return reached[length] === 1;
}

/** A tag as the patterns read it: without a leading `@`. */
function tagKeyText(tag: string): string {
  return tag.startsWith('@') ? tag.slice(1) : tag;
}

/**
 * A function that tells whether a tag carries the key `pattern` reads. The pattern is validated and parsed once; a
 * pattern that is off or not valid matches nothing.
 */
export function makeTagKeyMatcher(pattern: string | null | undefined): (tag: string) => boolean {
  if (!pattern) return () => false;
  const parsed = parseTagKeyPattern(pattern);
  if (!parsed.ok) return () => false;
  const { atoms } = parsed;
  return (tag) => {
    const text = tagKeyText(tag);
    return text.length <= MAX_TAG_KEY_TEXT_LENGTH && matchesAtoms(atoms, text);
  };
}

/**
 * The tags `pattern` matches, in declaration order, each tested without its `@`. A pattern that is off or not valid
 * matches nothing.
 */
export function matchTagKeys(tags: readonly string[], pattern: string | null | undefined): string[] {
  return tags.filter(makeTagKeyMatcher(pattern));
}

/** The tags both patterns match, in declaration order: a tag the integrations would read as an issue and as a case. */
export function overlappingTagKeys(
  tags: readonly string[],
  issuePattern: string | null | undefined,
  testCasePattern: string | null | undefined,
): string[] {
  if (!issuePattern || !testCasePattern) return [];
  const asIssue = makeTagKeyMatcher(issuePattern);
  const asTestCase = makeTagKeyMatcher(testCasePattern);
  return tags.filter((tag) => asIssue(tag) && asTestCase(tag));
}

/** The patterns as a project stores them: a pattern that is not valid reads as off. */
export function resolveTagKeyPatterns(raw: unknown): TagKeyPatterns {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TAG_KEY_PATTERNS };
  const stored = raw as Record<string, unknown>;
  const read = (value: unknown) => (typeof value === 'string' && validateTagKeyPattern(value).ok ? value.trim() : null);
  return { issue: read(stored.issue), testCase: read(stored.testCase) };
}

/**
 * The patterns a request sends, for storing. A pattern left out or null is off, an empty string too; both off is
 * stored as null. Refuses (with the field and the reason) a value that is not an object of strings or a pattern
 * `validateTagKeyPattern` refuses.
 */
export function parseTagKeyPatterns(
  raw: unknown,
): { ok: true; tagKeys: TagKeyPatterns | null } | { ok: false; message: string } {
  if (raw === null) return { ok: true, tagKeys: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'tagKeys must be { issue?: string | null, testCase?: string | null }' };
  }
  const sent = raw as Record<string, unknown>;
  const result: TagKeyPatterns = { issue: null, testCase: null };
  for (const field of ['issue', 'testCase'] as const) {
    const value = sent[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return { ok: false, message: `tagKeys.${field} must be a string or null` };
    if (!value.trim()) continue;
    const check = validateTagKeyPattern(value);
    if (!check.ok) return { ok: false, message: `tagKeys.${field}: ${check.message}` };
    result[field] = value.trim();
  }
  return { ok: true, tagKeys: result.issue || result.testCase ? result : null };
}
