/**
 * Read a test's declared tags and `piwi:` ownership metadata off Playwright's
 * `TestCase` / `TestResult`.
 *
 * Both normalizers live in `@piwitests/core` so the server can re-run them on
 * ingest; this module is only the Playwright-shaped adapter around them.
 */
import {
  MAX_TEST_TAGS,
  normalizeTestLocks,
  normalizeTestTags,
  parseTestMetadata,
  type TagsTruncated,
  type TestMetadata,
} from '@piwitests/core/test-meta';
import type { TestAnnotation } from '../../types.js';

/** The slice of `TestCase` this module reads. */
interface TaggedTestCase {
  /**
   * Playwright folds `@tag` tokens in the title and the `{ tag: [...] }` test
   * option into one array. Optional here because a `TestCase` from an older
   * Playwright than the peer range can reach the reporter through a
   * hand-rolled harness.
   */
  tags?: readonly string[];
}

/** Tags declared on a test, normalized for storage. Empty array when none. */
export function collectTestTags(test: TaggedTestCase): string[] {
  return normalizeTestTags(test.tags);
}

/**
 * The console lines naming the tests whose tags were cut at `MAX_TEST_TAGS`, the examples the run records, or none.
 */
export function formatTagsTruncated(found: TagsTruncated | null): string[] {
  if (!found) return [];
  const lines = [
    found.tests === 1
      ? `1 test declares more than ${MAX_TEST_TAGS} tags; Piwi keeps its first ${MAX_TEST_TAGS} and drops the rest:`
      : `${found.tests} tests declare more than ${MAX_TEST_TAGS} tags; Piwi keeps the first ${MAX_TEST_TAGS} of each and drops the rest:`,
  ];
  for (const test of found.examples) {
    const where = test.line != null ? `${test.filePath}:${test.line}` : test.filePath;
    const cut = test.dropped === 1 ? '1 tag dropped' : `${test.dropped} tags dropped`;
    lines.push(`  ${where}  ${[...(test.suitePath ?? []), test.title].join(' › ')} (${cut})`);
  }
  if (found.tests > found.examples.length) lines.push(`  and ${found.tests - found.examples.length} more`);
  lines.push(
    "Playwright lists config and describe tags first and the test's own tag option last: keep config and describe tags few, or put the tags that matter in the test title.",
  );
  return lines;
}

/**
 * Lock names declared on a test or its `describe` (`{ lock: 'db' }`), read off
 * the private `TestCase._locks` array Playwright populates only for in-process
 * reporters. There is no public property and the tele protocol carries none, so
 * blob-imported and merged runs yield nothing here — best effort by design.
 * Anything that is not an array of strings is treated as no locks.
 */
export function collectTestLocks(test: unknown): string[] {
  const locks = (test as { _locks?: unknown })?._locks;
  return normalizeTestLocks(locks);
}

/**
 * Ownership metadata declared via `piwi:` annotations, or `null` when the test
 * declared none. Takes the already-merged annotation list (`mergeAnnotations`)
 * so a `testInfo.annotations.push()` at runtime counts the same as a static
 * `{ annotation: … }` on the test.
 */
export function collectTestMetadata(annotations: TestAnnotation[]): TestMetadata | null {
  return parseTestMetadata(annotations);
}
