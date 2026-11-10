import { eq } from 'drizzle-orm';
import { readTagsTruncated, type TagsTruncated } from '@piwitests/core/test-meta';
import { projects, testCases, testRunsCases } from '../../server/database/schema';
import { readTestManagementBinding } from '../../server/utils/integrations/test-management/binding';
import { readCatalogInfo, readCatalogKeys } from '../../server/utils/integrations/test-management/catalog';
import { resolveTagKeyPatterns } from '../integrations/tag-keys';
import {
  defaultTestCaseKeyPattern,
  summarizeTestCaseMapping,
  type MappingTest,
  type TestCaseMappingSummary,
} from '../integrations/test-management-mapping';
import type { TestManagementKeySources } from '../integrations/test-management-binding';
import { lastCompleteRun } from './tag-key-overlap';
import type { DrizzleDB } from './db';

export type TestManagementSummaryReport =
  | { bound: false }
  | {
      bound: true;
      /** The run the tests were read from; null when the project has no complete run. */
      runId: number | null;
      /** The key pattern in use, and whether it is the default for the project rather than the project's own. */
      pattern: string;
      patternIsDefault: boolean;
      keySources: TestManagementKeySources;
      summary: TestCaseMappingSummary;
      /** The tests of that run whose tags were cut; show its count through `formatTagsTruncatedTests`. */
      tagsTruncated: TagsTruncated | null;
    };

/** The tests of a run, once each: a test's tags are those of all its results, so a retry does not hide one. */
async function runTests(db: DrizzleDB, runId: number): Promise<MappingTest[]> {
  const rows: Array<{ caseId: number; title: string; file: string; externalId: string | null; tags: unknown }> =
    await db
      .select({
        caseId: testRunsCases.testCaseId,
        title: testCases.title,
        file: testCases.filePath,
        externalId: testCases.externalId,
        tags: testRunsCases.tags,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .where(eq(testRunsCases.testRunId, runId))
      .orderBy(testRunsCases.testCaseId);
  const byCase = new Map<number, MappingTest & { tagSet: Set<string> }>();
  for (const row of rows) {
    let test = byCase.get(row.caseId);
    if (!test) {
      test = { title: row.title, file: row.file, tags: [], externalId: row.externalId, tagSet: new Set() };
      byCase.set(row.caseId, test);
    }
    if (Array.isArray(row.tags)) for (const tag of row.tags) if (typeof tag === 'string') test.tagSet.add(tag);
  }
  return [...byCase.values()].map(({ tagSet, ...test }) => ({ ...test, tags: [...tagSet] }));
}

/**
 * How the tests of a project's last complete run map onto its bound test management project: reads the run, the binding
 * and the stored catalog, and nothing from the tool. `{ bound: false }` while the project has no binding.
 */
export async function testManagementMappingSummary(
  db: DrizzleDB,
  projectId: number,
): Promise<TestManagementSummaryReport> {
  const binding = await readTestManagementBinding(db as never, projectId);
  if (binding.connectionId === null || binding.providerProjectKey === null) return { bound: false };

  const [project] = await db.select({ tagKeys: projects.tagKeys }).from(projects).where(eq(projects.id, projectId));
  const own = resolveTagKeyPatterns(project?.tagKeys).testCase;
  const pattern = own ?? defaultTestCaseKeyPattern(binding.providerProjectKey);

  const run = await lastCompleteRun(db, projectId);
  const tests = run ? await runTests(db, run.id) : [];
  const [keys, info] = await Promise.all([
    readCatalogKeys(db as never, binding.connectionId, binding.providerProjectKey),
    readCatalogInfo(db as never, binding.connectionId, binding.providerProjectKey),
  ]);
  return {
    bound: true,
    runId: run?.id ?? null,
    pattern,
    patternIsDefault: own === null,
    keySources: binding.keySources,
    summary: summarizeTestCaseMapping({
      tests,
      pattern,
      keySources: binding.keySources,
      catalog: { keys, fetchedAt: info.fetchedAt },
    }),
    tagsTruncated: readTagsTruncated((run?.metadata as Record<string, unknown> | null)?.tagsTruncated),
  };
}
