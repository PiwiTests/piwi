import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { testCases, testRuns, testRunsCases } from '../../server/database/schema';
import { eligibleRunSql } from '../run-eligibility';
import { makeTagKeyMatcher, type TagKeyPatterns } from '../integrations/tag-keys';
import type { DrizzleDB } from './db';

/** How many overlapping tags the settings section lists. */
export const MAX_LISTED_TAG_OVERLAPS = 20;

/** A tag both key patterns match, and a test of the run that carries it. */
export interface TagKeyOverlap {
  tag: string;
  testTitle: string;
}

export interface TagKeyOverlapReport {
  /** The run the tags were read from; null when the project has no complete run. */
  runId: number | null;
  /** The tags both patterns match, in the order of the tests that carry them (by test case id), each once. */
  overlaps: TagKeyOverlap[];
}

/**
 * The tags of the project's last complete run (the whole suite, finished) that both patterns match, each with a test
 * that carries it. Empty while either pattern is off or the project has no complete run. Reads only.
 */
export async function lastCompleteRunTagOverlap(
  db: DrizzleDB,
  projectId: number,
  patterns: TagKeyPatterns,
  limit = MAX_LISTED_TAG_OVERLAPS,
): Promise<TagKeyOverlapReport> {
  if (!patterns.issue || !patterns.testCase) return { runId: null, overlaps: [] };

  const [run] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), eligibleRunSql('run-baseline')))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(1);
  if (!run) return { runId: null, overlaps: [] };

  const rows: Array<{ caseId: number; title: string; tags: unknown }> = await db
    .selectDistinct({ caseId: testRunsCases.testCaseId, title: testCases.title, tags: testRunsCases.tags })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(and(eq(testRunsCases.testRunId, run.id), isNotNull(testRunsCases.tags)))
    .orderBy(testRunsCases.testCaseId);

  const asIssue = makeTagKeyMatcher(patterns.issue);
  const asTestCase = makeTagKeyMatcher(patterns.testCase);
  const firstTitle = new Map<string, string>();
  for (const row of rows) {
    if (!Array.isArray(row.tags)) continue;
    for (const tag of row.tags) {
      if (typeof tag === 'string' && !firstTitle.has(tag)) firstTitle.set(tag, row.title);
    }
  }
  const overlaps: TagKeyOverlap[] = [];
  for (const [tag, testTitle] of firstTitle) {
    if (!asIssue(tag) || !asTestCase(tag)) continue;
    overlaps.push({ tag, testTitle });
    if (overlaps.length >= limit) break;
  }
  return { runId: run.id, overlaps };
}
