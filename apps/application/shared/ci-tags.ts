/**
 * Tagged tests on CI: the tags a dispatch of the `tags` kind names, and the one `--grep` it hands to CI.
 *
 * Playwright matches `--grep` against a test's title path and its tags, joined by spaces, ignoring case, so a tag
 * written in a title (`login @smoke`) and one of the `tag` option (`{ tag: '@smoke' }`) both match. A tag Playwright
 * reads from a title is any `@` and the characters up to the next space (`@example.com` in `emails user@example.com`,
 * `@smoke)` in `login (@smoke)`), so the grep holds each tag after any character and before a space or the end. A tag
 * of {@link MAX_TEST_TAG_CHARS} characters may have been cut when it was stored: it matches as the start of a tag.
 * With several tags, a test carrying any of them runs, or, with `all`, only a test carrying every one.
 *
 * The argument is double-quoted, as every argument Piwi hands to CI (`buildRetryArgs`). A tag that holds a space or
 * a character a shell expands inside double quotes is refused, and its regular expression characters are escaped.
 * Around the tags, the grep holds `\s` (a backslash before a letter) and `$` only right before `)`, which bash, zsh,
 * PowerShell and cmd leave as they are inside double quotes, and `piwi rerun` reads as written.
 *
 * Pure + dependency-free: the server, the demo and the app share it.
 */
import { MAX_TEST_TAG_CHARS } from '@piwitests/core/test-meta';
import { escapeGrep, quoteShellArg } from '#shared/retry-command';

/** The most tags one dispatch names. */
export const MAX_CI_TAGS = 10;

/** Whether a test carrying any of the tags runs, or only one carrying all of them. */
export const CI_TAG_MATCHES = ['any', 'all'] as const;
export type CiTagMatch = (typeof CI_TAG_MATCHES)[number];

/** A tag as a dispatch names it: trimmed, without its leading `@`, as Piwi stores a test's tags. */
export function ciTagName(raw: string): string {
  return raw.trim().replace(/^@+/, '');
}

/**
 * Why a tag (without its `@`) cannot be sent to CI, or null: an empty one, one longer than a stored tag
 * ({@link MAX_TEST_TAG_CHARS}), and one holding a space or a character a shell expands inside double quotes.
 */
export function ciTagProblem(tag: string): string | null {
  if (tag === '') return 'A tag is empty.';
  if (tag.length > MAX_TEST_TAG_CHARS) {
    return `A tag is at most ${MAX_TEST_TAG_CHARS} characters after its @.`;
  }
  if (/\s/.test(tag) || quoteShellArg(tag) === null) {
    return `${JSON.stringify(`@${tag}`)} cannot be sent to CI: it holds a space, a control character, a double quote or one of $ \` \\ % !.`;
  }
  return null;
}

/** Whether a tag can be sent to CI ({@link ciTagProblem}). */
export function isCiTag(tag: string): boolean {
  return ciTagProblem(ciTagName(tag)) === null;
}

/** A tag a person can pick, with how many tests carry it. */
export interface CiTagOption {
  value: string;
  count: number;
}

/**
 * The tags to pick from, out of a project's tags and how many tests carry each: those a dispatch can send
 * ({@link isCiTag}), the spellings that differ only in case, which the grep does not tell apart, as one under the
 * spelling most tests carry with their counts added, the most carried first. `refused` counts the tags left out.
 */
export function ciTagOptions(values: readonly CiTagOption[]): { options: CiTagOption[]; refused: number } {
  const byKey = new Map<string, CiTagOption & { top: number }>();
  let refused = 0;
  for (const { value, count } of values) {
    const tag = ciTagName(value);
    if (!isCiTag(tag)) {
      refused++;
      continue;
    }
    const known = byKey.get(tag.toLowerCase());
    if (!known) byKey.set(tag.toLowerCase(), { value: tag, count, top: count });
    else {
      known.count += count;
      if (count > known.top) Object.assign(known, { value: tag, top: count });
    }
  }
  const options = [...byKey.values()]
    .map(({ value, count }) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { options, refused };
}

export type CiTagsParse = { ok: true; tags: string[] } | { ok: false; message: string };

/**
 * The tags a request names: a list of names (a body), or, from a query, a name per `tags` key and an empty value for
 * none. Each is read without its `@` ({@link ciTagName}) and checked ({@link ciTagProblem}); one that repeats another,
 * ignoring case as the grep does, is kept once. At most {@link MAX_CI_TAGS}.
 */
export function parseCiTags(raw: unknown): CiTagsParse {
  const list = typeof raw === 'string' ? (raw === '' ? [] : [raw]) : raw;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
    return { ok: false, message: 'tags must be a list of tag names.' };
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of list as string[]) {
    const tag = ciTagName(entry);
    const problem = ciTagProblem(tag);
    if (problem) return { ok: false, message: problem };
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_CI_TAGS) return { ok: false, message: `A dispatch names at most ${MAX_CI_TAGS} tags.` };
  return { ok: true, tags };
}

/**
 * A tag as the grep holds it: after any character, before a space or the end, or, at {@link MAX_TEST_TAG_CHARS}
 * characters, as the start of a tag.
 */
function tagWord(tag: string): string {
  return `@${escapeGrep(tag)}${tag.length < MAX_TEST_TAG_CHARS ? '(?=\\s|$)' : ''}`;
}

/**
 * The grep of tagged tests: one alternative per tag for `any`, and for `all`, from the start, one lookahead per tag.
 * One tag is the same either way.
 */
export function ciTagsGrep(tags: readonly string[], match: CiTagMatch): string {
  if (match === 'all' && tags.length > 1) return `^${tags.map((tag) => `(?=[^]*${tagWord(tag)})`).join('')}`;
  return tags.map(tagWord).join('|');
}

/**
 * The Playwright arguments of a dispatch of tagged tests, `--grep="<pattern>"` ({@link ciTagsGrep}), or an empty
 * string without tags. With {@link MAX_CI_TAGS} tags of {@link MAX_TEST_TAG_CHARS} characters, each escaped to at most
 * twice its length, it stays under 1,500 characters.
 */
export function ciTagsArgs(tags: readonly string[], match: CiTagMatch): string {
  return tags.length > 0 ? `--grep="${ciTagsGrep(tags, match)}"` : '';
}

/**
 * A tag in the grep: its `@`, then escaped characters or any but a space, `"` and the `\`, `(`, `)` and `|` a tag holds
 * escaped.
 */
const TAG_WORD = /@((?:\\.|[^\\()|"\s])+)/g;

/**
 * The tags, and how they match, that a dispatch's arguments name: read back from what {@link ciTagsArgs} wrote, and
 * null for any other arguments. A single tag reads as `any`.
 */
export function ciTagsOfArgs(args: string): { tags: string[]; match: CiTagMatch } | null {
  const tags = [...args.matchAll(TAG_WORD)].map((found) => found[1]!.replace(/\\(.)/g, '$1'));
  if (tags.length === 0) return null;
  const match = CI_TAG_MATCHES.find((m) => ciTagsArgs(tags, m) === args);
  return match ? { tags, match } : null;
}

/** The tags as a sentence names them: `@smoke`, `@smoke or @checkout`, `@a, @b and @c`. */
export function ciTagsPhrase(tags: readonly string[], match: CiTagMatch): string {
  const named = tags.map((tag) => `@${tag}`);
  if (named.length < 2) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} ${match === 'all' ? 'and' : 'or'} ${named.at(-1)}`;
}
