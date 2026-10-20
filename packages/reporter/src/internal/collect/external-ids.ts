/**
 * External IDs: the ID a test has in the team's own test management tool, which the dashboard matches the test on
 * before its file, describe path and title, so the test keeps its history when it is renamed or moved.
 *
 * Every ID is settled in `onBegin`, from the planned tests, before any test runs: a `piwi:id` annotation declared on
 * the test (never one added at runtime), else the `externalId.pattern` read from the title. An ID declared by tests
 * with different file, describe path or title is a duplicate: none of them sends it, and the run lists them.
 */
import {
  compileExternalIdPattern,
  mergeExternalIdDuplicates,
  parseExternalId,
  readExternalIdFromTitle,
  type ExternalIdDuplicate,
  type ExternalIdDuplicateTest,
} from '@piwitests/core/test-meta';
import type { PiwiDashboardOptions } from '../../public/options.js';

export type ExternalIdOptions = NonNullable<PiwiDashboardOptions['externalId']>;

/** A planned test, as this module reads it. */
export interface PlannedTest {
  /** Playwright's `TestCase.id`: one per test and Playwright project. */
  testId: string;
  /** Spec path relative to the config's folder, POSIX separators. */
  filePath: string;
  /** Describe-block titles, outermost first. */
  suitePath: string[];
  title: string;
  line: number;
  /** The annotations declared on the test and its describe blocks (`TestCase.annotations`). */
  annotations: ReadonlyArray<{ type: string; description?: string }>;
}

/** The ID a test sends, with its title without the ID when `stripFromTitle` is on. */
export interface TestExternalId {
  externalId: string;
  displayTitle?: string;
}

export interface ExternalIdPlan {
  /** By Playwright test id; a test without an ID, or with a duplicate one, is absent. */
  byTestId: Map<string, TestExternalId>;
  duplicates: ExternalIdDuplicate[];
  /** Why the pattern was not used: it does not compile. */
  patternError?: string;
}

function naturalKey(test: PlannedTest): string {
  return `${test.filePath}\u0000${test.suitePath.join('\u001f')}\u0000${test.title}`;
}

function duplicateTest(test: PlannedTest): ExternalIdDuplicateTest {
  return {
    filePath: test.filePath,
    ...(test.suitePath.length ? { suitePath: test.suitePath } : {}),
    title: test.title,
    line: test.line,
  };
}

/**
 * Settle the external ID of every planned test. The same test in several Playwright projects has one file, describe
 * path and title, so it is not a duplicate of itself.
 */
export function planExternalIds(tests: readonly PlannedTest[], options: ExternalIdOptions = {}): ExternalIdPlan {
  let pattern: RegExp | null = null;
  let patternError: string | undefined;
  if (options.pattern !== undefined && options.pattern !== '') {
    try {
      pattern = compileExternalIdPattern(options.pattern);
    } catch (error) {
      patternError = error instanceof Error ? error.message : String(error);
    }
  }

  const found = new Map<string, TestExternalId>();
  // ID → natural key → the first test seen with it
  const holders = new Map<string, Map<string, PlannedTest>>();
  for (const test of tests) {
    let id: TestExternalId | null = null;
    const declared = parseExternalId(test.annotations);
    if (declared) id = { externalId: declared };
    else if (pattern) {
      const read = readExternalIdFromTitle(test.title, pattern);
      if (read) id = options.stripFromTitle ? read : { externalId: read.externalId };
    }
    if (!id) continue;
    found.set(test.testId, id);
    let keys = holders.get(id.externalId);
    if (!keys) holders.set(id.externalId, (keys = new Map()));
    const key = naturalKey(test);
    if (!keys.has(key)) keys.set(key, test);
  }

  const duplicates: ExternalIdDuplicate[] = [];
  const duplicateIds = new Set<string>();
  for (const [externalId, keys] of holders) {
    if (keys.size < 2) continue;
    duplicateIds.add(externalId);
    duplicates.push({ externalId, tests: [...keys.values()].map(duplicateTest) });
  }

  const byTestId = new Map<string, TestExternalId>();
  for (const [testId, id] of found) if (!duplicateIds.has(id.externalId)) byTestId.set(testId, id);

  return {
    byTestId,
    duplicates: mergeExternalIdDuplicates(duplicates),
    ...(patternError ? { patternError } : {}),
  };
}

/** The console lines naming the duplicates, or none. */
export function formatExternalIdDuplicates(
  duplicates: ExternalIdDuplicate[],
  onDuplicate: 'report' | 'fail',
): string[] {
  if (duplicates.length === 0) return [];
  const lines: string[] = [];
  for (const { externalId, tests } of duplicates) {
    lines.push(
      `External ID ${externalId} is declared by ${tests.length} tests; this run matches them by file, describe path and title:`,
    );
    for (const test of tests) {
      const where = test.line != null ? `${test.filePath}:${test.line}` : test.filePath;
      lines.push(`  ${where}  ${[...(test.suitePath ?? []), test.title].join(' › ')}`);
    }
  }
  lines.push(
    onDuplicate === 'fail'
      ? 'Give each test its own ID: the run fails while two tests share one (externalId.onDuplicate: fail).'
      : "Give each test its own ID, or set externalId.onDuplicate: 'fail' to fail the run instead.",
  );
  return lines;
}
