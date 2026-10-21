/**
 * Test-level tags and ownership metadata — the shape, the limits, and the
 * normalization rules for both.
 *
 * Two independent sources feed this, both declared in the spec file:
 *
 * - **Tags** come from Playwright itself (`TestCase.tags`), which already folds
 *   together `@tag` tokens in a title and the `{ tag: [...] }` test option.
 * - **Metadata** comes from `piwi:`-prefixed test annotations, e.g.
 *   `test('…', { annotation: { type: 'piwi:owner', description: '@checkout' } })`.
 *
 * Both normalizers are total: they take `unknown`, never throw, and return a
 * value safe to store and render. The reporter runs them at collection time and
 * the ingest endpoints run them again on arrival, because a payload can reach
 * the API without passing through the reporter.
 */

/** Prefix identifying an annotation as Piwi metadata rather than a test mark. */
const PIWI_ANNOTATION_PREFIX = 'piwi:';

/** Priority levels accepted by `piwi:priority`, most severe first. */
export const TEST_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type TestPriority = (typeof TEST_PRIORITIES)[number];

export const MAX_TEST_TAGS = 20;
export const MAX_TEST_TAG_CHARS = 60;
export const MAX_TEST_LOCKS = 20;
export const MAX_TEST_LOCK_CHARS = 100;
/** Cap for `owner` and `feature`; `link` gets its own, longer cap. */
const MAX_TEST_META_CHARS = 120;
const MAX_TEST_LINK_CHARS = 500;
/** The largest `piwi:bug` id: bug report ids are 32-bit serials. */
const MAX_BUG_ID = 2_147_483_647;

/** Ownership and classification declared on a test via `piwi:` annotations. */
export interface TestMetadata {
  /** Free-form owner — a team handle, a squad name, an email. */
  owner?: string;
  priority?: TestPriority;
  /** Product area this test covers, for grouping across spec files. */
  feature?: string;
  /** Absolute `http(s)` URL to a ticket, spec or runbook. */
  link?: string;
  /** The id of the Piwi bug report this test reproduces (`piwi:bug`), digits only. */
  bug?: string;
}

const PRIORITY_SET: ReadonlySet<string> = new Set(TEST_PRIORITIES);

function cleanString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxChars);
}

/**
 * Normalize raw tags into the stored form: leading `@` stripped (Playwright
 * reports `@smoke`, we store `smoke` so a tag reads the same however it was
 * declared), blanks dropped, duplicates removed, declaration order preserved.
 */
export function normalizeTestTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().replace(/^@+/, '').trim().slice(0, MAX_TEST_TAG_CHARS);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TEST_TAGS) break;
  }

  return out;
}

/**
 * Normalize raw test locks into the stored form: a lock is a named shared
 * resource the runner serializes holders of, declared verbatim (no `@` prefix
 * to strip, unlike tags). Non-string and blank entries are dropped, duplicates
 * removed, declaration order preserved.
 *
 * Playwright never exposes locks publicly — the reporter reads a private field —
 * so this normalizer is deliberately defensive about its input.
 */
export function normalizeTestLocks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const lock = entry.trim().slice(0, MAX_TEST_LOCK_CHARS);
    if (!lock || seen.has(lock)) continue;
    seen.add(lock);
    out.push(lock);
    if (out.length >= MAX_TEST_LOCKS) break;
  }

  return out;
}

/**
 * A `link` is rendered as an anchor in the dashboard and in pull-request
 * comments, so only absolute `http(s)` URLs are accepted — anything else
 * (`javascript:`, `data:`, a bare word) is dropped rather than stored.
 */
function normalizeLink(value: unknown): string | undefined {
  const raw = cleanString(value, MAX_TEST_LINK_CHARS);
  if (!raw) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract `piwi:` metadata from a test's annotations. Annotation types are
 * matched case-insensitively; unknown `piwi:` fields and unparseable values are
 * ignored, and a later annotation of the same field wins. Returns `null` when
 * nothing usable was declared, so callers can store a null column rather than
 * an empty object.
 */
export function parseTestMetadata(annotations: unknown): TestMetadata | null {
  if (!Array.isArray(annotations)) return null;

  const meta: TestMetadata = {};

  for (const entry of annotations) {
    if (!entry || typeof entry !== 'object') continue;
    const { type, description } = entry as { type?: unknown; description?: unknown };
    if (typeof type !== 'string') continue;

    const lower = type.trim().toLowerCase();
    if (!lower.startsWith(PIWI_ANNOTATION_PREFIX)) continue;
    const field = lower.slice(PIWI_ANNOTATION_PREFIX.length);

    switch (field) {
      case 'owner': {
        const value = cleanString(description, MAX_TEST_META_CHARS);
        if (value) meta.owner = value;
        break;
      }
      case 'priority': {
        const value = cleanString(description, MAX_TEST_META_CHARS)?.toLowerCase();
        if (value && PRIORITY_SET.has(value)) meta.priority = value as TestPriority;
        break;
      }
      case 'feature': {
        const value = cleanString(description, MAX_TEST_META_CHARS);
        if (value) meta.feature = value;
        break;
      }
      case 'link': {
        const value = normalizeLink(description);
        if (value) meta.link = value;
        break;
      }
      case 'bug': {
        const value = cleanString(description, MAX_TEST_META_CHARS)?.replace(/^#/, '');
        // A bug report's id is a 32-bit serial on Postgres: a larger one names no report and breaks the query.
        if (value && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_BUG_ID) meta.bug = value;
        break;
      }
      default:
        break;
    }
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Validate an already-shaped metadata object (e.g. one that arrived on the wire
 * as `testMeta`) against the same rules `parseTestMetadata` applies, by routing
 * it through the annotation parser. Keeps one definition of what each field
 * accepts instead of two that can drift.
 */
export function sanitizeTestMetadata(raw: unknown): TestMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const asAnnotations = Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
    type: `${PIWI_ANNOTATION_PREFIX}${key}`,
    description: typeof value === 'string' ? value : undefined,
  }));
  return parseTestMetadata(asAnnotations);
}

/**
 * True when the annotation belongs to Piwi rather than to Playwright: the
 * `piwi:` metadata annotations, and the `piwi-` ones the reporter adds itself
 * (a locator suggestion). The dashboard renders test marks (`skip`, `fixme`,
 * `slow`) as chips and would otherwise show Piwi's own annotations among them.
 */
export function isPiwiAnnotation(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const lower = type.trim().toLowerCase();
  return lower.startsWith(PIWI_ANNOTATION_PREFIX) || lower.startsWith('piwi-');
}

/**
 * The longest external ID kept. A longer value is dropped rather than cut, since two IDs cut to the same prefix
 * would name the same test.
 */
export const MAX_EXTERNAL_ID_CHARS = 120;

/**
 * Normalize an external ID, the ID a team gives a test in its own test management tool: a string, trimmed, at most
 * {@link MAX_EXTERNAL_ID_CHARS} characters, without control characters. Anything else is no ID. Case is kept, so
 * `ab-1` and `AB-1` are two IDs.
 */
export function normalizeExternalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXTERNAL_ID_CHARS) return undefined;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return trimmed;
}

/**
 * The external ID declared with a `piwi:id` annotation, or `undefined` when there is none. The type is matched
 * case-insensitively, like the other `piwi:` annotations, and a later `piwi:id` wins.
 */
export function parseExternalId(annotations: unknown): string | undefined {
  if (!Array.isArray(annotations)) return undefined;
  let id: string | undefined;
  for (const entry of annotations) {
    if (!entry || typeof entry !== 'object') continue;
    const { type, description } = entry as { type?: unknown; description?: unknown };
    if (typeof type !== 'string' || type.trim().toLowerCase() !== `${PIWI_ANNOTATION_PREFIX}id`) continue;
    const value = normalizeExternalId(description);
    if (value) id = value;
  }
  return id;
}

/**
 * Compile the pattern an external ID is read from in a test's title. A string is compiled with `new RegExp(value)`;
 * the `g` and `y` flags are dropped from a `RegExp`, so a match never depends on the previous one. Throws on a string
 * that is not a valid regular expression.
 */
export function compileExternalIdPattern(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern);
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/** An external ID read from a test's title, with the title left once the match is removed. */
export interface TitleExternalId {
  externalId: string;
  /** The title without the whole match, trimmed; absent when nothing is left. */
  displayTitle?: string;
}

/**
 * Read an external ID from a test's title with a pattern from {@link compileExternalIdPattern}. The ID is the first
 * capture group, or the whole match when the pattern has no group. Returns `null` when the pattern does not match or
 * the ID it captures is not a valid one.
 */
export function readExternalIdFromTitle(title: string, pattern: RegExp): TitleExternalId | null {
  const match = pattern.exec(title);
  if (!match) return null;
  const externalId = normalizeExternalId(match.length > 1 ? match[1] : match[0]);
  if (!externalId) return null;
  const rest = (title.slice(0, match.index) + title.slice(match.index + match[0].length)).trim();
  return rest ? { externalId, displayTitle: rest } : { externalId };
}

/** One test that declares an external ID another test of the same run also declares. */
export interface ExternalIdDuplicateTest {
  filePath: string;
  /** Describe-block titles, outermost first. */
  suitePath?: string[];
  title: string;
  line?: number | null;
}

/**
 * An external ID declared by tests with different file, describe path or title in one run. The run matches each of
 * them by file, describe path and title instead, and records the list in its `metadata.externalIdDuplicates`.
 */
export interface ExternalIdDuplicate {
  externalId: string;
  tests: ExternalIdDuplicateTest[];
}

/** The most duplicate IDs a run records, and the most tests recorded per ID. */
export const MAX_EXTERNAL_ID_DUPLICATES = 50;
export const MAX_EXTERNAL_ID_DUPLICATE_TESTS = 10;

function duplicateTestKey(test: ExternalIdDuplicateTest): string {
  return `${test.filePath}\u0000${(test.suitePath ?? []).join('\u001f')}\u0000${test.title}`;
}

function readDuplicateTest(raw: unknown): ExternalIdDuplicateTest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { filePath, suitePath, title, line } = raw as Record<string, unknown>;
  if (typeof filePath !== 'string' || typeof title !== 'string') return null;
  const test: ExternalIdDuplicateTest = { filePath, title };
  if (Array.isArray(suitePath) && suitePath.every((s) => typeof s === 'string') && suitePath.length > 0)
    test.suitePath = suitePath as string[];
  if (typeof line === 'number' && Number.isFinite(line)) test.line = line;
  return test;
}

/**
 * Merge lists of duplicate external IDs (a run's stored list, a shard's, the server's own findings) into one: an ID
 * appears once, with every distinct test that declared it, both capped. Takes `unknown` lists, since a stored or sent
 * one is read back unchecked; malformed entries are dropped.
 */
export function mergeExternalIdDuplicates(...lists: unknown[]): ExternalIdDuplicate[] {
  const byId = new Map<string, Map<string, ExternalIdDuplicateTest>>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const externalId = normalizeExternalId((entry as { externalId?: unknown }).externalId);
      const tests = (entry as { tests?: unknown }).tests;
      if (!externalId || !Array.isArray(tests)) continue;
      const read = tests.map(readDuplicateTest).filter((test): test is ExternalIdDuplicateTest => test !== null);
      if (read.length === 0) continue;
      let known = byId.get(externalId);
      if (!known) {
        if (byId.size >= MAX_EXTERNAL_ID_DUPLICATES) continue;
        known = new Map();
        byId.set(externalId, known);
      }
      for (const test of read) {
        if (known.size >= MAX_EXTERNAL_ID_DUPLICATE_TESTS) break;
        const key = duplicateTestKey(test);
        if (!known.has(key)) known.set(key, test);
      }
    }
  }
  return [...byId].map(([externalId, tests]) => ({ externalId, tests: [...tests.values()] }));
}
