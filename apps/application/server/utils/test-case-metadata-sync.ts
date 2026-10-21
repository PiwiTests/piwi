import { eq, inArray } from 'drizzle-orm';
import { testCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { sanitizeTestMetadata, type TestMetadata } from '@piwitests/core/test-meta';

/** Latest-known tags, locks + `piwi:` metadata for one test case, as stored. */
export interface CaseMetaSnapshot {
  tags: string[];
  locks: string[];
  meta: TestMetadata | null;
  /** The title without the test's external ID, when the reporter removed it. */
  displayTitle: string | null;
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameSnapshot(stored: CaseMetaSnapshot, incoming: CaseMetaSnapshot): boolean {
  if (!sameStringList(stored.tags, incoming.tags)) return false;
  if (!sameStringList(stored.locks, incoming.locks)) return false;
  if (stored.displayTitle !== incoming.displayTitle) return false;
  const a = stored.meta ?? {};
  const b = incoming.meta ?? {};
  return a.owner === b.owner && a.priority === b.priority && a.feature === b.feature && a.link === b.link;
}

/**
 * Mirror each reported test's tags and `piwi:` metadata onto its `test_cases`
 * row, so project-wide views can filter by tag or owner without joining every
 * run. The per-execution values on `test_runs_cases` stay the record of what a
 * given run saw; these columns only track the most recent declaration.
 *
 * Reads the current values first and writes only the rows that actually
 * changed — in steady state a run costs one SELECT and no UPDATEs, and a tag
 * removed from a spec still propagates (the incoming empty value differs from
 * the stored one).
 */
export async function syncTestCaseMetadata(db: DrizzleDB, incoming: Map<number, CaseMetaSnapshot>): Promise<void> {
  if (incoming.size === 0) return;

  const ids = [...incoming.keys()];
  const stored = await db
    .select({
      id: testCases.id,
      tags: testCases.tags,
      locks: testCases.locks,
      owner: testCases.owner,
      priority: testCases.priority,
      feature: testCases.feature,
      link: testCases.link,
      displayTitle: testCases.displayTitle,
    })
    .from(testCases)
    .where(inArray(testCases.id, ids));

  const storedById = new Map<number, CaseMetaSnapshot>(
    stored.map((row) => [
      row.id,
      {
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        locks: Array.isArray(row.locks) ? (row.locks as string[]) : [],
        meta: sanitizeTestMetadata({
          owner: row.owner,
          priority: row.priority,
          feature: row.feature,
          link: row.link,
        }),
        displayTitle: row.displayTitle ?? null,
      },
    ]),
  );

  for (const [caseId, next] of incoming) {
    const current = storedById.get(caseId);
    if (current && sameSnapshot(current, next)) continue;

    await db
      .update(testCases)
      .set({
        tags: next.tags.length ? next.tags : null,
        locks: next.locks.length ? next.locks : null,
        owner: next.meta?.owner ?? null,
        priority: next.meta?.priority ?? null,
        feature: next.meta?.feature ?? null,
        link: next.meta?.link ?? null,
        displayTitle: next.displayTitle,
        updatedAt: new Date(),
      })
      .where(eq(testCases.id, caseId));
  }
}
