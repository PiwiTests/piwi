/**
 * How a project's tests map onto the test cases of its test management project: which key each test carries, how many
 * tests carry none, and which keys the tool's catalog does not know.
 *
 * Pure and dependency-free, so the mapping summary screen and the payload of a later sync read the same keys. The
 * code that reads the tests and the catalog is `shared/handlers/test-management-summary.ts`.
 */
import { makeTagKeyMatcher } from './tag-keys';
import type { TestManagementKeySources } from './test-management-binding';

/** The most unknown keys a summary lists. */
export const MAX_LISTED_UNKNOWN_KEYS = 20;

/** The most example test titles an unknown key lists. */
export const MAX_UNKNOWN_KEY_EXAMPLES = 3;

/** The most keys one catalog lookup names: a page of tags, not a whole suite. */
export const MAX_CATALOG_LOOKUP_KEYS = 100;

const LOOKUP_KEY = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9_-]{1,40}$/;

/** Whether a catalog lookup accepts `key`: a project key, a dash and a number or name, as Zephyr Scale writes them. */
export function isCatalogLookupKey(key: string): boolean {
  return LOOKUP_KEY.test(key);
}

/** A test as the mapping reads it. */
export interface MappingTest {
  title: string;
  file: string;
  /** The test's tags, with or without their `@`. */
  tags: readonly string[];
  externalId: string | null;
}

/** What the stored catalog holds: its keys, and when it was read (null while it never was). */
export interface MappingCatalog {
  keys: readonly string[];
  fetchedAt: Date | null;
}

export interface UnknownKey {
  key: string;
  /** Up to {@link MAX_UNKNOWN_KEY_EXAMPLES} titles of tests that carry the key. */
  examples: string[];
  /** How many tests carry the key. */
  tests: number;
}

export interface TestCaseMappingSummary {
  /** Tests that carry at least one key. */
  mappedTests: number;
  /** Tests that carry none. */
  testsWithoutKey: number;
  /** The distinct keys the tests carry, in the order they were met. */
  keys: string[];
  /** The keys the catalog does not hold, up to {@link MAX_LISTED_UNKNOWN_KEYS}. Empty while the catalog was never read. */
  unknownKeys: UnknownKey[];
  /** How many keys the catalog does not hold, listed or not. Zero while the catalog was never read. */
  unknownKeyCount: number;
  /** False while the catalog was never read: nothing can be called unknown yet. */
  catalogRead: boolean;
  catalogSize: number;
  catalogFetchedAt: Date | null;
}

/** The pattern a test case key has in a project that names none: `^SHOP-T[0-9]+$`. */
export function defaultTestCaseKeyPattern(providerProjectKey: string): string {
  return `^${providerProjectKey.replace(/[^A-Za-z0-9]/g, '\\$&')}-T[0-9]+$`;
}

/** The keys one test carries, each once: its matching tags (when tags are a source) and its external ID (when it is). */
export function testCaseKeys(
  test: Pick<MappingTest, 'tags' | 'externalId'>,
  pattern: string | null,
  sources: TestManagementKeySources,
): string[] {
  const matches = makeTagKeyMatcher(pattern);
  const keys = new Set<string>();
  if (sources.tags) {
    for (const tag of test.tags) {
      if (matches(tag)) keys.add(tag.startsWith('@') ? tag.slice(1) : tag);
    }
  }
  if (sources.externalId && test.externalId && matches(test.externalId)) keys.add(test.externalId);
  return [...keys];
}

/** Map `tests` onto the catalog. `pattern` is the project's test case key pattern, or the default for its project. */
export function summarizeTestCaseMapping(input: {
  tests: readonly MappingTest[];
  pattern: string | null;
  keySources: TestManagementKeySources;
  catalog: MappingCatalog;
}): TestCaseMappingSummary {
  const { tests, pattern, keySources, catalog } = input;
  const known = new Set(catalog.keys);
  const catalogRead = catalog.fetchedAt !== null;

  const keys = new Map<string, string[]>(); // key → the titles of the tests that carry it
  let mappedTests = 0;
  for (const test of tests) {
    const found = testCaseKeys(test, pattern, keySources);
    if (found.length > 0) mappedTests += 1;
    for (const key of found) {
      const titles = keys.get(key);
      if (titles) titles.push(test.title);
      else keys.set(key, [test.title]);
    }
  }

  const unknown: UnknownKey[] = [];
  if (catalogRead) {
    for (const [key, titles] of keys) {
      if (known.has(key)) continue;
      unknown.push({ key, examples: [...new Set(titles)].slice(0, MAX_UNKNOWN_KEY_EXAMPLES), tests: titles.length });
    }
  }

  // The keys that affect the most tests come first, so the cap keeps the ones worth fixing.
  unknown.sort((a, b) => b.tests - a.tests || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    mappedTests,
    testsWithoutKey: tests.length - mappedTests,
    keys: [...keys.keys()],
    unknownKeys: unknown.slice(0, MAX_LISTED_UNKNOWN_KEYS),
    unknownKeyCount: unknown.length,
    catalogRead,
    catalogSize: catalog.keys.length,
    catalogFetchedAt: catalog.fetchedAt,
  };
}
