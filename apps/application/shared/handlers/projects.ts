import {
  projects,
  testRuns,
  testRunsCases,
  testCases,
  files,
  tags,
  projectTags,
  failureClusters,
  failureDiagnoses,
  casePayloads,
  coverageDaily,
  coverageReports,
  coverageTotals,
  entityLinks,
  bugReports,
  analyticsDailyRollups,
  handbackOutcomes,
  handbackOutcomeRollups,
  mcpToolCalls,
} from '../../server/database/schema';
import {
  asc,
  desc,
  eq,
  exists,
  sql,
  and,
  or,
  inArray,
  gte,
  lte,
  isNull,
  isNotNull,
  count,
  ne,
  notInArray,
  type SQL,
} from 'drizzle-orm';
import { jsonArrayContainsAll, parseLockFilter, parseTagFilter } from '../utils/tag-filter';
import { publicRunColumns } from './public-run';
import { testSearchConditions } from '#shared/utils/test-search-sql';
import {
  CATALOG_SEARCH_FIELDS,
  collectTestSearchValues,
  parseTestSearch,
  type TestSearchValues,
} from '#shared/test-search';
import { splitSuitePath } from '#shared/utils/suites';
import { notLabExecutionInProject, notLabRun } from './probes';
import { resolveStoredDefaultBranch } from '../../server/utils/scm/stored-default-branch';
import { projectRunScopeConditions, scopedExecutionInProject, scopedExecutionInProjectJoin } from './project-run-scope';
import { parseProjectRunScope, type ProjectRunScope } from '../project-run-scope';
import { eligibleRunSql } from '../run-eligibility';
import { isFailedStatus } from '../utils/test-counts';
import { getHoldingVerifiedFixes } from './flake-verified';
import { fixmeSkipPredicate } from '../utils/skip-kind';
import { TEST_PRIORITIES } from '@piwitests/core/test-meta';

import type { DrizzleDB } from './db';
import {
  detectTimeoutOpportunity,
  hasSlowMark,
  type TimeoutOpportunity,
  type TimeoutThresholds,
} from '../analytics/timeout-hygiene';
import { parseProjectDecisions } from '#shared/capabilities';
import { normalizeProjectTargets } from '#shared/analytics/targets';
import { parseCoverageAreas, parseCoverageScope, type CoverageScope } from '@piwitests/core/coverage-scope';
import { repositoryUrlFromRemote } from '../../server/utils/scm/git-url';

type ProjectScope = 'all' | Set<number>;

/**
 * `test.fixme()` skips per run, for runs with any skipped test — the subset of
 * `skippedTests` the status bars draw in their second grey. Counted from the
 * cases' annotations in one grouped query; a run missing from the map has none.
 */
async function fixmeTestsByRunId(
  db: DrizzleDB,
  runs: ReadonlyArray<{ id: number; skippedTests?: number | null }>,
): Promise<Map<number, number>> {
  const runIds = runs.filter((r) => (r.skippedTests ?? 0) > 0).map((r) => r.id);
  const out = new Map<number, number>();
  if (runIds.length === 0) return out;
  const rows: Array<{ testRunId: number; n: number }> = await db
    .select({ testRunId: testRunsCases.testRunId, n: count() })
    .from(testRunsCases)
    .where(
      and(
        inArray(testRunsCases.testRunId, runIds),
        fixmeSkipPredicate(testRunsCases.status, testRunsCases.testAnnotations),
      ),
    )
    .groupBy(testRunsCases.testRunId);
  for (const r of rows) out.set(r.testRunId, Number(r.n));
  return out;
}

// ─── listProjects ────────────────────────────────────────────────

async function getProjects(db: DrizzleDB, scope: ProjectScope = 'all') {
  let allProjects: any[] = await db.select().from(projects).orderBy(desc(projects.updatedAt));

  if (scope !== 'all') {
    if (scope.size === 0) return { projects: [], ids: [] };
    allProjects = allProjects.filter((p: any) => scope.has(p.id));
  }

  if (allProjects.length === 0) return { projects: [], ids: [] };

  return {
    projects: allProjects,
    ids: allProjects.map((p: any) => p.id),
  };
}

export async function listProjects(db: DrizzleDB, scope: ProjectScope = 'all') {
  const { ids: projectIds, projects: allProjects } = await getProjects(db, scope);

  // 1. Run counts per project
  const runStats: any[] = await db
    .select({
      projectId: testRuns.projectId,
      count: count(),
    })
    .from(testRuns)
    .where(inArray(testRuns.projectId, projectIds))
    .groupBy(testRuns.projectId);

  const runCountByProjectId = new Map<number, number>();
  for (const r of runStats) {
    runCountByProjectId.set(r.projectId, r.count);
  }

  // Latest run id per project, ranked by start_time (id as a deterministic
  // tiebreaker): rows can be ingested out of chronological order (historical
  // uploads on the server; the demo seed inserts runs newest-first).
  const rankedRuns = db.$with('ranked_latest_runs').as(
    db
      .select({
        id: testRuns.id,
        projectId: testRuns.projectId,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRuns.projectId} ORDER BY ${testRuns.startTime} DESC, ${testRuns.id} DESC)`.as(
          'rn',
        ),
      })
      .from(testRuns)
      .where(inArray(testRuns.projectId, projectIds)),
  );
  const latestIdRows: any[] = await db
    .with(rankedRuns)
    .select({ id: rankedRuns.id })
    .from(rankedRuns)
    .where(eq(rankedRuns.rn, 1));
  const latestRunIds: number[] = latestIdRows.map((r) => r.id);

  // 2. Fetch the latest run rows
  const latestRuns: any[] =
    latestRunIds.length > 0
      ? await db.select(publicRunColumns()).from(testRuns).where(inArray(testRuns.id, latestRunIds))
      : [];
  const fixmeByRunId = await fixmeTestsByRunId(db, latestRuns);
  const latestRunByProjectId = new Map<number, any>();
  for (const r of latestRuns) {
    latestRunByProjectId.set(r.projectId, { ...r, fixmeTests: fixmeByRunId.get(r.id) ?? 0 });
  }

  // 3. Total test cases per project (batched GROUP BY)
  const caseCounts: any[] = await db
    .select({
      projectId: testCases.projectId,
      count: count(),
    })
    .from(testCases)
    .where(inArray(testCases.projectId, projectIds))
    .groupBy(testCases.projectId);

  const caseCountByProjectId = new Map<number, number>();
  for (const r of caseCounts) {
    caseCountByProjectId.set(r.projectId, r.count);
  }

  // 4. Reports for all latest runs (batched)
  const reportRows: any[] =
    latestRunIds.length > 0
      ? await db
          .select()
          .from(files)
          .where(and(inArray(files.testRunId, latestRunIds), eq(files.type, 'report')))
      : [];
  const reportsByRunId = new Map<
    number,
    { id: number; type: string; label: string; path: string; size: number | null }[]
  >();
  for (const r of reportRows) {
    const list = reportsByRunId.get(r.testRunId!) ?? [];
    list.push({ id: r.id, type: r.subtype || r.type, label: r.label || r.type, path: r.path, size: r.size });
    reportsByRunId.set(r.testRunId!, list);
  }

  // 5. Tags per project (batched)
  const tagRows: any[] = await db
    .select({
      projectId: projectTags.projectId,
      tag: tags,
    })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, projectIds));

  const tagsByProjectId = new Map<number, any[]>();
  for (const r of tagRows) {
    const list = tagsByProjectId.get(r.projectId) ?? [];
    list.push(r.tag);
    tagsByProjectId.set(r.projectId, list);
  }

  return allProjects.map((project: any) => {
    const latestRun = latestRunByProjectId.get(project.id) ?? null;
    return {
      ...project,
      latestRun: latestRun ? { ...latestRun, reports: reportsByRunId.get(latestRun.id) ?? [] } : null,
      totalRuns: runCountByProjectId.get(project.id) ?? 0,
      totalTestCases: caseCountByProjectId.get(project.id) ?? 0,
      tags: tagsByProjectId.get(project.id) ?? [],
    };
  });
}

// ─── getProject ──────────────────────────────────────────────────

/** The run-list columns: everything the table shows, no wide JSON besides the metadata it slims. */
const RUN_SUMMARY_COLUMNS = {
  id: testRuns.id,
  projectId: testRuns.projectId,
  status: testRuns.status,
  startTime: testRuns.startTime,
  duration: testRuns.duration,
  totalTests: testRuns.totalTests,
  passedTests: testRuns.passedTests,
  failedTests: testRuns.failedTests,
  skippedTests: testRuns.skippedTests,
  didNotRunTests: testRuns.didNotRunTests,
  flakyTests: testRuns.flakyTests,
  avgTestDuration: testRuns.avgTestDuration,
  p90TestDuration: testRuns.p90TestDuration,
  shardTotal: testRuns.shardTotal,
  shardsFinished: testRuns.shardsFinished,
  environment: testRuns.environment,
  branch: testRuns.branch,
  label: testRuns.label,
  instanceId: testRuns.instanceId,
  playwrightVersion: testRuns.playwrightVersion,
  reporterVersion: testRuns.reporterVersion,
  isFullRun: testRuns.isFullRun,
  filterDetails: testRuns.filterDetails,
  metadata: testRuns.metadata,
  keptAt: testRuns.keptAt,
  keepSource: testRuns.keepSource,
  keepReason: testRuns.keepReason,
  createdAt: testRuns.createdAt,
  updatedAt: testRuns.updatedAt,
};

/** Clamp a requested run-list size to 1–1000, 200 by default. */
function clampRunLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 200, 1), 1000);
}

/**
 * Shape run-list rows for the runs table: attach each run's reports and
 * browsers, and slim the metadata JSON down to the SCM branch and commit.
 */
async function toRunSummaries(db: DrizzleDB, runs: any[]) {
  // Fetch reports for all runs in a single query
  const runIds: number[] = runs.map((r: any) => r.id);
  const reportResults: any[] =
    runIds.length > 0
      ? await db
          .select()
          .from(files)
          .where(and(inArray(files.testRunId, runIds), eq(files.type, 'report')))
      : [];

  const reportsByRunId = new Map<
    number,
    { id: number; type: string; label: string; path: string; size: number | null }[]
  >();
  for (const r of reportResults) {
    const list = reportsByRunId.get(r.testRunId!) ?? [];
    list.push({ id: r.id, type: r.subtype || r.type, label: r.label || r.type, path: r.path, size: r.size });
    reportsByRunId.set(r.testRunId!, list);
  }

  // Aggregate distinct browsers per run from the scalar column — the wide
  // `browser` JSON is only needed for full configs, not the name list.
  const browserRows: any[] =
    runIds.length > 0
      ? await db
          .selectDistinct({ testRunId: testRunsCases.testRunId, browserName: testRunsCases.browserName })
          .from(testRunsCases)
          .where(and(inArray(testRunsCases.testRunId, runIds), isNotNull(testRunsCases.browserName)))
      : [];

  const fixmeByRunId = await fixmeTestsByRunId(db, runs);

  const browsersByRunId = new Map<number, string[]>();
  for (const row of browserRows) {
    const name = row.browserName as string | null;
    if (!name) continue;
    const list = browsersByRunId.get(row.testRunId) ?? [];
    if (!list.includes(name)) list.push(name);
    browsersByRunId.set(row.testRunId, list);
  }

  return runs.map((r: any) => {
    // Slim the wide metadata JSON down to just the SCM branch/commit shown in the run list
    const scm = (r.metadata as { scm?: { branch?: string | null; commit?: string | null } } | null)?.scm;
    return {
      ...r,
      isFullRun: r.isFullRun === 1,
      metadata: scm?.branch || scm?.commit ? { scm: { branch: scm.branch ?? null, commit: scm.commit ?? null } } : null,
      reports: reportsByRunId.get(r.id) ?? [],
      browsers: browsersByRunId.get(r.id) ?? [],
      fixmeTests: fixmeByRunId.get(r.id) ?? 0,
    };
  });
}

export async function getProject(db: DrizzleDB, id: number, options?: { runLimit?: number }) {
  // Bounds the run list (and the charts derived from it) — projects grow
  // unboundedly, so an uncapped select scales with total history.
  const runLimit = clampRunLimit(options?.runLimit);

  const projectResults: any[] = await db.select().from(projects).where(eq(projects.id, id));
  const project = projectResults[0];

  if (!project) throw new Error('Project not found');

  // Select only the columns needed for the run list — omit wide JSON columns
  const runs: any[] = await db
    .select(RUN_SUMMARY_COLUMNS)
    .from(testRuns)
    .where(eq(testRuns.projectId, id))
    .orderBy(desc(testRuns.startTime))
    .limit(runLimit);

  // Get tags for this project
  const projectTagRows: any[] = await db
    .select({ tag: tags })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(eq(projectTags.projectId, id));

  return {
    ...project,
    // The branch a project run scope reads when no branch is picked.
    effectiveDefaultBranch: await resolveStoredDefaultBranch(db, project),
    hasScmToken: !!project.scmToken,
    // Validated per-project capability decisions, so the edit form preselects a
    // stored "declined"/"enabled" rather than always reading "instance default".
    capabilities: parseProjectDecisions(project.capabilities ?? null),
    tags: projectTagRows.map((r: any) => r.tag),
    testRuns: await toRunSummaries(db, runs),
  };
}

// ─── listKeptRuns ────────────────────────────────────────────────

/**
 * A project's kept runs, newest first, in the run-list shape. Kept runs are
 * mostly old ones, past the window `getProject` loads, so they list on their own.
 */
export async function listKeptRuns(db: DrizzleDB, projectId: number, options?: { limit?: number }) {
  const where = and(eq(testRuns.projectId, projectId), isNotNull(testRuns.keptAt));
  const runs: any[] = await db
    .select(RUN_SUMMARY_COLUMNS)
    .from(testRuns)
    .where(where)
    .orderBy(desc(testRuns.startTime))
    .limit(clampRunLimit(options?.limit));
  const [total] = await db.select({ n: count() }).from(testRuns).where(where);
  return { items: await toRunSummaries(db, runs), total: Number(total?.n ?? 0) };
}

// ─── createProject ───────────────────────────────────────────────

export async function createProject(
  db: DrizzleDB,
  name: string,
  label?: string | null,
  description?: string | null,
  tagIds?: number[],
) {
  const existing: any[] = await db.select().from(projects).where(eq(projects.name, name));
  if (existing.length > 0) throw new Error('A project with this name already exists');

  const uniqueTagIds = tagIds ? await validTagIds(db, tagIds) : [];

  const project = await db.transaction(async (tx) => {
    const result: any[] = await tx.insert(projects).values({ name, label, description }).returning();
    const created = result[0]!;
    if (uniqueTagIds.length > 0) {
      await tx.insert(projectTags).values(uniqueTagIds.map((tagId) => ({ projectId: created.id, tagId })));
    }
    return created;
  });

  return { success: true, project };
}

/** The distinct tag ids, or throws when one of them names no tag. */
async function validTagIds(db: DrizzleDB, tagIds: number[]): Promise<number[]> {
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return unique;
  const existingTags: any[] = await db.select({ id: tags.id }).from(tags).where(inArray(tags.id, unique));
  if (existingTags.length !== unique.length) {
    throw new Error('One or more tag IDs are invalid');
  }
  return unique;
}

// ─── updateProject ───────────────────────────────────────────────

/** The error `updateProject` throws for a repository URL `repositoryUrlFromRemote` refuses. */
export const INVALID_REPOSITORY_URL = 'repositoryUrl must be a repository URL, such as https://host/owner/repo';

/** The error `updateProject` throws for a coverage scope `parseCoverageScope` refuses. */
export const INVALID_COVERAGE_SCOPE =
  'coverageScope must be { include?: string[], exclude?: string[] }: at most 200 patterns each, 300 characters and 20 "*" a pattern, no "!" negation';

/** The error `updateProject` throws for coverage areas `parseCoverageAreas` refuses. */
export const INVALID_COVERAGE_AREAS =
  'coverageAreas must be a list of at most 20 { name, include: string[] }: distinct names of 1 to 40 letters, digits, spaces, ".", "_" or "-", each with at least one pattern';

export async function updateProject(
  db: DrizzleDB,
  id: number,
  data: {
    label?: string | null;
    description?: string | null;
    diagnosisInstructions?: string | null;
    aiLanguage?: string | null;
    scmToken?: string | null;
    /** The repository the project's SCM calls read; null or '' clears it, and the next run that names one pins it. */
    repositoryUrl?: string | null;
    defaultBranch?: string | null;
    openApiUrl?: string | null;
    serverProbes?: unknown;
    ciRerun?: unknown;
    /** Whether a quarantined failure turns the run's commit status red. */
    quarantineFailsStatus?: boolean;
    /** Whether each gate evaluation also posts the `<statusContext>/gate` commit status. */
    gateStatus?: boolean;
    /** `GeneratedSpecSettings`; null clears them. */
    generatedSpecs?: unknown;
    /** Per-project targets (`ProjectTargets`); null clears them. */
    targets?: unknown;
    /** The files coverage totals count (`CoverageScope`); null restores the default excludes. */
    coverageScope?: unknown;
    /** Named areas of the code (`CoverageArea[]`), each counted apart; null or [] removes them. */
    coverageAreas?: unknown;
    tagIds?: number[];
  },
) {
  const projectResults: any[] = await db.select().from(projects).where(eq(projects.id, id));
  if (!projectResults[0]) throw new Error('Project not found');

  const {
    label,
    description,
    diagnosisInstructions,
    aiLanguage,
    scmToken,
    repositoryUrl,
    defaultBranch,
    openApiUrl,
    serverProbes,
    ciRerun,
    quarantineFailsStatus,
    gateStatus,
    generatedSpecs,
    targets,
    coverageScope,
    coverageAreas,
    tagIds: dataTagIds,
  } = data;
  // null or '' clears the repository; any other value must name one.
  const repository =
    repositoryUrl === undefined ? undefined : repositoryUrl?.trim() ? repositoryUrlFromRemote(repositoryUrl) : null;
  if (repository === null && repositoryUrl?.trim()) throw new Error(INVALID_REPOSITORY_URL);
  const areas =
    coverageAreas === undefined || coverageAreas === null ? coverageAreas : parseCoverageAreas(coverageAreas);
  if (areas === null && coverageAreas !== null) throw new Error(INVALID_COVERAGE_AREAS);
  const scope: CoverageScope | null | undefined =
    coverageScope === undefined || coverageScope === null ? coverageScope : parseCoverageScope(coverageScope);
  if (scope === null && coverageScope !== null) throw new Error(INVALID_COVERAGE_SCOPE);
  const scopeChanged =
    scope !== undefined && JSON.stringify(scope) !== JSON.stringify(projectResults[0].coverageScope ?? null);
  const storedAreas = areas === undefined ? undefined : areas && areas.length > 0 ? areas : null;
  const areasChanged =
    storedAreas !== undefined &&
    JSON.stringify(storedAreas) !== JSON.stringify(projectResults[0].coverageAreas ?? null);
  const resolvedTargets = targets === undefined ? undefined : normalizeProjectTargets(targets);
  const uniqueTagIds = dataTagIds === undefined ? undefined : await validTagIds(db, dataTagIds);

  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        label,
        description,
        diagnosisInstructions: diagnosisInstructions !== undefined ? diagnosisInstructions || null : undefined,
        aiLanguage: aiLanguage !== undefined ? aiLanguage?.trim() || null : undefined,
        scmToken: scmToken !== undefined ? scmToken : undefined,
        repositoryUrl: repository,
        defaultBranch: defaultBranch !== undefined ? defaultBranch : undefined,
        openApiUrl: openApiUrl !== undefined ? openApiUrl : undefined,
        serverProbes: serverProbes !== undefined ? (serverProbes as any) : undefined,
        ciRerun: ciRerun !== undefined ? (ciRerun as any) : undefined,
        quarantineFailsStatus,
        gateStatus,
        generatedSpecs: generatedSpecs !== undefined ? (generatedSpecs as any) : undefined,
        targets: resolvedTargets,
        ...(scopeChanged ? { coverageScope: scope } : {}),
        // Totals counted under another scope or other areas read as stale.
        ...(scopeChanged || areasChanged ? { coverageScopeVersion: sql`${projects.coverageScopeVersion} + 1` } : {}),
        ...(storedAreas !== undefined ? { coverageAreas: storedAreas } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id));

    if (areasChanged) {
      // An area the project no longer names leaves the trend and the totals.
      const names = (storedAreas ?? []).map((a) => a.name);
      for (const table of [coverageDaily, coverageTotals]) {
        await tx
          .delete(table)
          .where(
            and(
              eq(table.projectId, id),
              ne(table.area, ''),
              names.length > 0 ? notInArray(table.area, names) : undefined,
            ),
          );
      }
    }

    if (uniqueTagIds !== undefined) {
      await tx.delete(projectTags).where(eq(projectTags.projectId, id));
      if (uniqueTagIds.length > 0) {
        await tx.insert(projectTags).values(uniqueTagIds.map((tagId) => ({ projectId: id, tagId })));
      }
    }
  });

  // Get updated project with tags
  const updatedProject: any[] = await db.select().from(projects).where(eq(projects.id, id));
  const projectTagRows: any[] = await db
    .select({ tag: tags })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(eq(projectTags.projectId, id));

  const { scmToken: _scmToken, ...updatedProjectPublic } = updatedProject[0];

  return {
    success: true,
    project: {
      ...updatedProjectPublic,
      tags: projectTagRows.map((r: any) => r.tag),
    },
  };
}

// ─── deleteProjectData ───────────────────────────────────────────
// Cascading DB-only delete with no storage operations, called by the server
// (via server/utils/delete-project.ts, which also clears storage) and by demo
// mode (against the in-browser DB). This module must not import
// server/storage: its LocalStorageAdapter calls Node fs/util at import time,
// which the demo service worker does not have.

/**
 * Where a project deletion stands. `files` removes the stored reports and
 * evidence, `runs` deletes the test runs in batches (`runsDeleted` counts up to
 * `totalRuns`), `project` removes the test cases, clusters and the project row.
 */
export interface ProjectDeletionProgress {
  phase: 'files' | 'runs' | 'project';
  totalRuns: number;
  runsDeleted: number;
}

/** Runs deleted per batch — keeps every `IN (…)` list far below SQLite's bound-parameter limit. */
const DELETE_RUN_BATCH = 50;

export async function deleteProjectData(
  db: DrizzleDB,
  projectId: number,
  onProgress?: (progress: ProjectDeletionProgress) => void,
) {
  // Run IDs, to delete the dependent rows that lack a DB-level cascade
  const runRows: { id: number }[] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));
  const runIds = runRows.map((r) => r.id);
  const totalRuns = runIds.length;
  onProgress?.({ phase: 'runs', totalRuns, runsDeleted: 0 });

  for (let i = 0; i < totalRuns; i += DELETE_RUN_BATCH) {
    const batch = runIds.slice(i, i + DELETE_RUN_BATCH);
    const batchCaseIds = db
      .select({ id: testRunsCases.id })
      .from(testRunsCases)
      .where(inArray(testRunsCases.testRunId, batch));
    await db.delete(files).where(inArray(files.testRunsCaseId, batchCaseIds));
    await db.delete(files).where(inArray(files.testRunId, batch));
    await db.delete(testRunsCases).where(inArray(testRunsCases.testRunId, batch));
    await db.delete(testRuns).where(inArray(testRuns.id, batch));
    onProgress?.({ phase: 'runs', totalRuns, runsDeleted: i + batch.length });
  }

  onProgress?.({ phase: 'project', totalRuns, runsDeleted: totalRuns });

  await db.delete(testCases).where(eq(testCases.projectId, projectId));
  await db.delete(coverageReports).where(eq(coverageReports.projectId, projectId));
  await db.delete(casePayloads).where(eq(casePayloads.projectId, projectId));

  // Entity links pinned to this project's clusters (a known-issue link Piwi
  // created, or a URL a person pinned) are not covered by the cluster cascade,
  // so remove them before the cluster rows go.
  const projectClusterRows = await db
    .select({ id: failureClusters.id })
    .from(failureClusters)
    .where(eq(failureClusters.projectId, projectId));
  const projectClusterIds = projectClusterRows.map((r: { id: number }) => r.id);
  if (projectClusterIds.length > 0) {
    await db.delete(entityLinks).where(inArray(entityLinks.failureClusterId, projectClusterIds));
  }
  const projectBugReports = await db
    .select({ id: bugReports.id })
    .from(bugReports)
    .where(eq(bugReports.projectId, projectId));
  if (projectBugReports.length > 0) {
    await db.delete(entityLinks).where(
      inArray(
        entityLinks.bugReportId,
        projectBugReports.map((r: { id: number }) => r.id),
      ),
    );
  }

  await db.delete(analyticsDailyRollups).where(eq(analyticsDailyRollups.projectId, projectId));
  await db.delete(handbackOutcomes).where(eq(handbackOutcomes.projectId, projectId));
  await db.delete(handbackOutcomeRollups).where(eq(handbackOutcomeRollups.projectId, projectId));
  await db.delete(mcpToolCalls).where(eq(mcpToolCalls.projectId, projectId));

  // Deleting the project row cascades to: projectTags, failureClusters,
  // failureDiagnoses, traceBlobs, traceResources
  await db.delete(projects).where(eq(projects.id, projectId));
}

// ─── getProjectMenu ──────────────────────────────────────────────

export async function getProjectMenu(
  db: DrizzleDB,
  scope: ProjectScope = 'all',
): Promise<{ id: number; name: string; label: string | null }[]> {
  if (scope !== 'all' && scope.size === 0) return [];
  const query = db
    .select({ id: projects.id, name: projects.name, label: projects.label })
    .from(projects)
    .orderBy(desc(projects.updatedAt));
  const rows = await query;
  if (scope === 'all') return rows;
  return rows.filter((p) => scope.has(p.id));
}

// ─── getProjectPerformance ───────────────────────────────────────

export async function getProjectPerformance(
  db: DrizzleDB,
  projectId: number,
  limit: number,
  from?: string,
  to?: string,
  fullRunsOnly: boolean = true,
  /** The project page's run scope; replaces `fullRunsOnly`. */
  scope?: ProjectRunScope | null,
) {
  // Verify project exists
  const projectResults: any[] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!projectResults[0]) throw new Error('Project not found');

  // Build conditions
  const conditions = [eq(testRuns.projectId, projectId), notLabRun(testRuns.origin)];
  if (scope) {
    conditions.push(...(await projectRunScopeConditions(db, projectId, scope)));
  } else if (fullRunsOnly) {
    conditions.push(eq(testRuns.isFullRun, 1));
  }
  if (from) {
    const fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) throw new Error('Invalid from date');
    conditions.push(gte(testRuns.startTime, fromDate));
  }
  if (to) {
    const toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) throw new Error('Invalid to date');
    toDate.setDate(toDate.getDate() + 1);
    conditions.push(lte(testRuns.startTime, toDate));
  }

  const runs: any[] = await db
    .select({
      id: testRuns.id,
      startTime: testRuns.startTime,
      duration: testRuns.duration,
      avgTestDuration: testRuns.avgTestDuration,
      p90TestDuration: testRuns.p90TestDuration,
      status: testRuns.status,
      totalTests: testRuns.totalTests,
      metadata: testRuns.metadata,
      isFullRun: testRuns.isFullRun,
    })
    .from(testRuns)
    .where(and(...conditions))
    .orderBy(desc(testRuns.startTime))
    .limit(Math.min(limit, 200));

  // Reverse so oldest → newest for the trend chart
  runs.reverse();

  // Extract SCM info from metadata for each run
  return runs.map((run: any) => {
    const metadata = run.metadata as Record<string, unknown> | null;
    const scm = metadata?.scm as Record<string, unknown> | undefined;

    return {
      id: run.id,
      startTime: run.startTime,
      duration: run.duration,
      avgTestDuration: run.avgTestDuration,
      p90TestDuration: run.p90TestDuration,
      status: run.status,
      totalTests: run.totalTests,
      commit: (scm?.commit as string | null) || null,
      branch: (scm?.branch as string | null) || null,
      isFullRun: run.isFullRun === 1,
    };
  });
}

// ─── getProjectTestCases ─────────────────────────────────────────

export const TEST_CASE_SORTS = ['file', 'lastRun', 'title', 'totalRuns', 'passRate', 'avgDuration', 'status'] as const;
export type TestCasesSort = (typeof TEST_CASE_SORTS)[number];

/** Filterable per-case status categories (the derived `status` field, not raw run statuses). */
export const TEST_CASE_STATUS_FILTERS = ['passed', 'failed', 'flaky', 'skipped', 'didnotrun'] as const;

export interface TestCasesQuery {
  limit: number;
  offset: number;
  /** A test-list search (`#shared/test-search`): words, phrases and qualifiers such as `file:` or `-tag:`. */
  q?: string;
  /** Exact spec file path, as the test case stores it. */
  file?: string;
  statuses?: string[];
  /** Every tag here must be present on a case for it to match. */
  tags?: string[];
  /** Every lock here must be present on a case for it to match. */
  locks?: string[];
  owner?: string;
  priority?: string;
  maxAgeDays: number;
  sort: TestCasesSort;
  dir: 'asc' | 'desc';
  /** The project page's run scope: only its runs' executions count. */
  scope?: ProjectRunScope | null;
}

/**
 * Parse and clamp the test-cases catalog query parameters. Shared by the REST
 * endpoint (`getQuery` record) and the demo router (`URLSearchParams`) so both
 * apply identical defaults: limit 50 (max 1000), `maxAgeDays` 0 = all time
 * (the UI sends its own default), sort by last run, newest first.
 */
export function parseTestCasesQuery(input?: URLSearchParams | Record<string, unknown> | null): TestCasesQuery {
  const get = (key: string): string | undefined => {
    if (!input) return undefined;
    const value = input instanceof URLSearchParams ? input.get(key) : (input as Record<string, unknown>)[key];
    if (value == null) return undefined;
    return String(Array.isArray(value) ? value[0] : value);
  };
  const num = (key: string, fallback: number): number => {
    const n = Number(get(key));
    return Number.isFinite(n) ? n : fallback;
  };
  const statuses = (get('status') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (TEST_CASE_STATUS_FILTERS as readonly string[]).includes(s));
  const rawSort = get('sort') ?? '';
  const tags = parseTagFilter(get('tags'));
  const locks = parseLockFilter(get('locks'));
  const rawPriority = (get('priority') ?? '').trim().toLowerCase();
  const priorities = TEST_PRIORITIES as readonly string[];
  return {
    limit: Math.min(1000, Math.max(1, Math.floor(num('limit', 50)))),
    offset: Math.max(0, Math.floor(num('offset', 0))),
    q: get('q')?.trim() || undefined,
    file: get('file')?.trim() || undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    tags: tags.length > 0 ? tags : undefined,
    locks: locks.length > 0 ? locks : undefined,
    owner: get('owner')?.trim() || undefined,
    priority: priorities.includes(rawPriority) ? rawPriority : undefined,
    maxAgeDays: Math.max(0, num('maxAgeDays', 0)),
    sort: (TEST_CASE_SORTS as readonly string[]).includes(rawSort) ? (rawSort as TestCasesSort) : 'lastRun',
    dir: get('dir') === 'asc' ? 'asc' : 'desc',
    scope: parseProjectRunScope(input) ?? undefined,
  };
}

/**
 * Test cases of `projectId` with an execution (outside lab runs, in the run
 * scope's runs when `scopeConditions` is set) in the last `maxAgeDays` days.
 */
function executedWithin(db: DrizzleDB, projectId: number, maxAgeDays: number, scopeConditions: SQL[] | null = null) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  return exists(
    db
      .select({ one: sql`1` })
      .from(testRunsCases)
      .where(
        and(
          eq(testRunsCases.testCaseId, testCases.id),
          gte(testRunsCases.createdAt, cutoff),
          executionInProject(projectId, scopeConditions),
        ),
      ),
  );
}

/** The executions a project read counts: outside lab runs, and in the run scope's runs when it has one. */
function executionInProject(projectId: number, scopeConditions: SQL[] | null): SQL {
  return scopeConditions
    ? scopedExecutionInProject(projectId, testRunsCases.testRunId, scopeConditions)
    : notLabExecutionInProject(projectId, testRunsCases.testRunId);
}

/** The column of a test case's latest execution (outside lab runs), as a correlated subquery. */
function latestExecutionColumn(projectId: number, column: typeof testRunsCases.line | typeof testRunsCases.column) {
  return sql<number | null>`(
      SELECT ${column}
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testCaseId} = ${testCases.id}
        AND ${notLabExecutionInProject(projectId, testRunsCases.testRunId)}
      ORDER BY ${testRunsCases.createdAt} DESC
      LIMIT 1
    )`;
}

/**
 * Epoch milliseconds of a `MAX(created_at)` aggregate mapped to a Date. A demo
 * database whose seed stored Unix seconds yields a date in January 1970, so a
 * value below 1e12 ms is read as seconds.
 */
function toEpochMs(value: Date | null): number | null {
  if (value == null) return null;
  const ms = value.getTime();
  return ms < 1e12 ? ms * 1000 : ms;
}

/**
 * Paginated test-case catalog for a project with per-case aggregates.
 *
 * Timed-out runs (both the raw `timedOut` Playwright spelling and the declared
 * lowercase `timedout`) are folded into `failedRuns`, matching how the rest of
 * the UI treats timeouts. `passRate` is computed over executed runs only
 * (passed + failed; skipped/didnotrun excluded) and is null when nothing ran.
 * The derived `status` category is what the status filter and sort operate on:
 * `flaky` when any of the last 10 executions is a retry-pass, otherwise the
 * latest run's status (timeouts shown as failed), or `never-run`. Executions
 * of lab runs (probes, flake experiments) stay out of every aggregate.
 */
export async function getProjectTestCases(db: DrizzleDB, projectId: number, options: Partial<TestCasesQuery> = {}) {
  const {
    limit = 50,
    offset = 0,
    q,
    file,
    statuses,
    tags,
    locks,
    owner,
    priority,
    maxAgeDays = 0,
    sort = 'lastRun',
    dir = 'desc',
    scope = null,
  } = options;

  const scopeConditions = scope ? await projectRunScopeConditions(db, projectId, scope) : null;
  const realExecution = executionInProject(projectId, scopeConditions);

  // PostgreSQL returns COUNT and SUM (int8) and AVG and the pass-rate division
  // (numeric) as strings, and a timestamp aggregate unparsed: each selected
  // aggregate is mapped so both dialects agree.
  const passed = sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' THEN 1 ELSE 0 END)`.mapWith(Number);
  const failed =
    sql<number>`SUM(CASE WHEN ${testRunsCases.status} IN ('failed', 'timedOut', 'timedout') THEN 1 ELSE 0 END)`.mapWith(
      Number,
    );
  const recentFlaky = sql<number>`(
      SELECT COUNT(*) FROM (
        SELECT ${testRunsCases.status} AS s, ${testRunsCases.retries} AS r
        FROM ${testRunsCases}
        WHERE ${testRunsCases.testCaseId} = ${testCases.id}
          AND ${realExecution}
        ORDER BY ${testRunsCases.createdAt} DESC
        LIMIT 10
      ) AS recent WHERE s = 'passed' AND r > 0
    )`.mapWith(Number);
  const lastStatus = sql<string | null>`(
      SELECT ${testRunsCases.status}
      FROM ${testRunsCases}
      WHERE ${testRunsCases.testCaseId} = ${testCases.id}
        AND ${realExecution}
      ORDER BY ${testRunsCases.createdAt} DESC
      LIMIT 1
    )`;
  const category = sql<string>`CASE
      WHEN ${recentFlaky} > 0 THEN 'flaky'
      WHEN ${lastStatus} IN ('timedOut', 'timedout') THEN 'failed'
      ELSE COALESCE(${lastStatus}, 'never-run')
    END`;
  const passRate = sql<
    number | null
  >`CASE WHEN (${passed} + ${failed}) > 0 THEN (${passed} * 1.0) / (${passed} + ${failed}) END`.mapWith(Number);

  const conditions = [eq(testCases.projectId, projectId)];
  if (q) {
    conditions.push(
      ...testSearchConditions(parseTestSearch(q, CATALOG_SEARCH_FIELDS), {
        title: testCases.title,
        describe: testCases.suitePath,
        file: testCases.filePath,
        tag: testCases.tags,
        lock: testCases.locks,
        owner: testCases.owner,
        priority: testCases.priority,
        feature: testCases.feature,
      }),
    );
  }
  if (file) {
    // The reporter stores paths from the CI working directory, which may sit above the Playwright config the
    // caller's path starts from: `e2e/tests/cart.spec.ts` answers for `tests/cart.spec.ts`.
    const suffix = `%/${file.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
    conditions.push(or(eq(testCases.filePath, file), sql`${testCases.filePath} LIKE ${suffix} ESCAPE '\\'`)!);
  }
  if (maxAgeDays > 0) conditions.push(executedWithin(db, projectId, maxAgeDays, scopeConditions));
  if (statuses && statuses.length > 0) {
    conditions.push(inArray(category, statuses));
  }
  if (tags && tags.length > 0) {
    conditions.push(...jsonArrayContainsAll(testCases.tags, tags));
  }
  if (locks && locks.length > 0) {
    conditions.push(...jsonArrayContainsAll(testCases.locks, locks));
  }
  if (owner) {
    conditions.push(eq(testCases.owner, owner));
  }
  if (priority) {
    conditions.push(eq(testCases.priority, priority));
  }
  const where = and(...conditions);

  // Every predicate above is per-case (correlated on testCases.id only), so the
  // total is a plain count over test_cases — no join or grouping needed.
  const countRows: any[] = await db.select({ total: count() }).from(testCases).where(where);
  const total = Number(countRows[0]?.total ?? 0);

  // Where the test sits in its file, as its latest execution reported it.
  const line = latestExecutionColumn(projectId, testRunsCases.line);
  const column = latestExecutionColumn(projectId, testRunsCases.column);

  // Each sort is a list of keys; `file` is the order the tests are declared in,
  // file by file, which is the order Playwright lists and runs them.
  const sortExpressions: Record<TestCasesSort, SQL[]> = {
    file: [sql`lower(${testCases.filePath})`, line, column, sql`lower(${testCases.title})`],
    lastRun: [sql`MAX(${testRunsCases.createdAt})`],
    title: [sql`lower(${testCases.title})`],
    totalRuns: [sql`COUNT(${testRunsCases.id})`],
    passRate: [passRate],
    avgDuration: [
      sql`AVG(CASE WHEN ${testRunsCases.status} NOT IN ('skipped', 'didnotrun') THEN ${testRunsCases.duration} END)`,
    ],
    status: [category],
  };
  const direction = sql.raw(dir === 'asc' ? 'ASC' : 'DESC');
  const orderBy = [...sortExpressions[sort].map((key) => sql`${key} ${direction} NULLS LAST`), asc(testCases.id)];

  // A sort on the test cases' own columns picks the page first, so only the
  // executions of that page's tests are aggregated; a sort on an aggregate
  // needs every test's.
  let pageIds: number[] | null = null;
  if (sort === 'file' || sort === 'title') {
    const page: Array<{ id: number }> = await db
      .select({ id: testCases.id })
      .from(testCases)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);
    pageIds = page.map((r) => r.id);
    if (pageIds.length === 0) return { items: [], total, limit, offset };
  }

  const rows: any[] = await db
    .select({
      id: testCases.id,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      tags: testCases.tags,
      locks: testCases.locks,
      owner: testCases.owner,
      priority: testCases.priority,
      feature: testCases.feature,
      link: testCases.link,
      status: category,
      totalRuns: sql<number>`COUNT(${testRunsCases.id})`.mapWith(Number),
      passedRuns: passed,
      failedRuns: failed,
      skippedRuns: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'skipped' THEN 1 ELSE 0 END)`.mapWith(Number),
      fixmeRuns:
        sql<number>`SUM(CASE WHEN ${fixmeSkipPredicate(testRunsCases.status, testRunsCases.testAnnotations)} THEN 1 ELSE 0 END)`.mapWith(
          Number,
        ),
      didNotRunRuns: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'didnotrun' THEN 1 ELSE 0 END)`.mapWith(
        Number,
      ),
      flakyRuns:
        sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' AND ${testRunsCases.retries} > 0 THEN 1 ELSE 0 END)`.mapWith(
          Number,
        ),
      recentFlakyRuns: recentFlaky,
      passRate,
      avgDuration: sql<
        number | null
      >`AVG(CASE WHEN ${testRunsCases.status} NOT IN ('skipped', 'didnotrun') THEN ${testRunsCases.duration} END)`.mapWith(
        Number,
      ),
      lastRun: sql<Date | null>`MAX(${testRunsCases.createdAt})`.mapWith(testRunsCases.createdAt),
      lastStatus,
      line,
      column,
    })
    .from(testCases)
    .leftJoin(
      testRunsCases,
      and(
        eq(testCases.id, testRunsCases.testCaseId),
        scopedExecutionInProjectJoin(projectId, testRunsCases.testRunId, scopeConditions ?? []),
        // PostgreSQL does not carry the page's ids across the join: named on the executions too,
        // they are read through the test case index instead of a scan of every execution.
        pageIds ? inArray(testRunsCases.testCaseId, pageIds) : undefined,
      ),
    )
    .where(pageIds ? inArray(testCases.id, pageIds) : where)
    .groupBy(testCases.id, testCases.filePath, testCases.suitePath, testCases.title)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(pageIds ? 0 : offset);

  return {
    items: rows.map((row) => ({ ...row, lastRun: toEpochMs(row.lastRun) })),
    total,
    limit,
    offset,
  };
}

/**
 * Every value the catalog's search qualifiers can take in a project — spec
 * files, describe blocks, tags, locks, owners, priorities and features — with
 * how many test cases carry each, for the search box's completion. With
 * `maxAgeDays` it covers the cases the catalog shows for that window.
 */
export async function getProjectTestCaseFacets(
  db: DrizzleDB,
  projectId: number,
  options: { maxAgeDays?: number; scope?: ProjectRunScope | null } = {},
): Promise<{ values: TestSearchValues }> {
  const maxAgeDays = options.maxAgeDays ?? 0;
  const conditions = [eq(testCases.projectId, projectId)];
  if (maxAgeDays > 0) {
    const scopeConditions = options.scope ? await projectRunScopeConditions(db, projectId, options.scope) : null;
    conditions.push(executedWithin(db, projectId, maxAgeDays, scopeConditions));
  }
  const rows: any[] = await db
    .select({
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      tags: testCases.tags,
      locks: testCases.locks,
      owner: testCases.owner,
      priority: testCases.priority,
      feature: testCases.feature,
    })
    .from(testCases)
    .where(and(...conditions));
  const subjects = rows.map((row) => ({
    title: '',
    filePath: row.filePath as string,
    suitePath: splitSuitePath(row.suitePath),
    tags: (row.tags as string[] | null) ?? [],
    locks: (row.locks as string[] | null) ?? [],
    owner: row.owner as string | null,
    priority: row.priority as string | null,
    feature: row.feature as string | null,
  }));
  return { values: collectTestSearchValues(subjects, CATALOG_SEARCH_FIELDS) };
}

/**
 * Group a project's recent test executions by spec-file prefix and compute
 * pass rate, flaky rate, failure count, execution count, and average duration over
 * the last `days` days. Shared by the REST spec-health endpoint and the MCP
 * `get_spec_health` tool.
 */
export async function getProjectSpecHealth(db: DrizzleDB, projectId: number, days: number) {
  const boundedDays = Math.min(90, Math.max(1, days));
  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);

  const projRows: any[] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (projRows.length === 0) throw new Error('Project not found');

  // Lab runs (probes, flake experiments) inject faults and conditions, so their
  // executions never count toward spec health.
  const recentRuns: any[] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), gte(testRuns.startTime, since), notLabRun(testRuns.origin)))
    .orderBy(desc(testRuns.startTime))
    .limit(100);
  if (recentRuns.length === 0) return { specs: [] };
  const runIds: number[] = recentRuns.map((r: any) => r.id);
  const rows: any[] = await db
    .select({
      filePath: testCases.filePath,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      retries: testRunsCases.retries,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(inArray(testRunsCases.testRunId, runIds));

  const specMap = new Map<
    string,
    { testCount: number; passCount: number; failCount: number; flakyCount: number; durations: number[] }
  >();

  for (const row of rows) {
    const prefix = row.filePath.split(/[\\/]/).slice(0, 2).join('/');
    if (!specMap.has(prefix)) {
      specMap.set(prefix, { testCount: 0, passCount: 0, failCount: 0, flakyCount: 0, durations: [] });
    }
    const spec = specMap.get(prefix)!;
    spec.testCount++;
    if (row.status === 'passed') {
      spec.passCount++;
      if ((row.retries ?? 0) > 0) spec.flakyCount++;
    } else if (row.status === 'failed' || row.status === 'timedOut' || row.status === 'timedout') {
      spec.failCount++;
    }
    if (row.duration != null) spec.durations.push(row.duration);
  }

  const specs = [...specMap.entries()]
    .map(([prefix, data]) => ({
      prefix,
      passRate: data.testCount > 0 ? Math.round((data.passCount / data.testCount) * 100) / 100 : 0,
      flakyRate: data.testCount > 0 ? Math.round((data.flakyCount / data.testCount) * 100) / 100 : 0,
      failureCount: data.failCount,
      testCount: data.testCount,
      avgDuration:
        data.durations.length > 0 ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length) : 0,
    }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));

  return { specs };
}

// ─── getProjectAiStepCoverage ─────────────────────────────────────────

/**
 * Aggregate AI-step *liveness* over a project's recent runs: for each committed
 * AI-step artifact (`page.piwiLocator` / `page.piwiRun`) that was replayed, how
 * many distinct tests exercise it, how often, and when it was last seen. Powers
 * the project "AI steps" panel — a committed artifact that stops showing up is a
 * candidate for `piwi ai prune`. Reads the per-execution `aiUsage` manifest
 * (`{ entries: string[] }`) the reporter attaches while replaying.
 */
export async function getProjectAiStepCoverage(db: DrizzleDB, projectId: number, days: number) {
  const boundedDays = Math.min(90, Math.max(1, days));
  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);

  const projRows: any[] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (projRows.length === 0) throw new Error('Project not found');

  const empty = { summary: { artifactCount: 0, testCount: 0, runCount: 0, replayCount: 0 }, artifacts: [] as const };

  const recentRuns: any[] = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), gte(testRuns.startTime, since)))
    .orderBy(desc(testRuns.startTime))
    .limit(100);
  if (recentRuns.length === 0) return empty;

  const runStart = new Map<number, number>();
  for (const r of recentRuns) runStart.set(r.id, new Date(r.startTime as any).getTime());
  const runIds: number[] = recentRuns.map((r: any) => r.id);

  const rows: any[] = await db
    .select({
      aiUsage: testRunsCases.aiUsage,
      testCaseId: testRunsCases.testCaseId,
      testRunId: testRunsCases.testRunId,
    })
    .from(testRunsCases)
    .where(inArray(testRunsCases.testRunId, runIds));

  const artifactMap = new Map<string, { tests: Set<number>; replayCount: number; lastSeen: number }>();
  const usingTests = new Set<number>();

  for (const row of rows) {
    const usage = row.aiUsage as { entries?: unknown } | null;
    const entries = usage && Array.isArray(usage.entries) ? usage.entries : null;
    if (!entries || entries.length === 0) continue;
    const seen = runStart.get(row.testRunId) ?? 0;
    usingTests.add(row.testCaseId);
    for (const raw of entries) {
      if (typeof raw !== 'string') continue;
      let a = artifactMap.get(raw);
      if (!a) {
        a = { tests: new Set(), replayCount: 0, lastSeen: 0 };
        artifactMap.set(raw, a);
      }
      a.tests.add(row.testCaseId);
      a.replayCount++;
      if (seen > a.lastSeen) a.lastSeen = seen;
    }
  }

  const artifacts = [...artifactMap.entries()]
    .map(([entry, d]) => ({
      entry,
      testCount: d.tests.size,
      replayCount: d.replayCount,
      lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
    }))
    .sort((a, b) => a.entry.localeCompare(b.entry));

  return {
    summary: {
      artifactCount: artifacts.length,
      testCount: usingTests.size,
      runCount: recentRuns.length,
      replayCount: artifacts.reduce((sum, a) => sum + a.replayCount, 0),
    },
    artifacts,
  };
}

// ─── getProjectSlowTests ─────────────────────────────────────────

export async function getProjectSlowTests(
  db: DrizzleDB,
  projectId: number,
  runsCount: number,
  /** The project page's run scope: the recent runs are the scope's. */
  scope?: ProjectRunScope | null,
) {
  // Verify project exists
  const projectResults: any[] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!projectResults[0]) throw new Error('Project not found');

  const effectiveLimit = Math.min(runsCount, 100);
  const scopeConditions = scope ? await projectRunScopeConditions(db, projectId, scope) : [];

  // Get recent test run IDs for this project
  const recentRuns: any[] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), notLabRun(testRuns.origin), ...scopeConditions))
    .orderBy(desc(testRuns.startTime))
    .limit(effectiveLimit);

  const runIds: number[] = recentRuns.map((r: any) => r.id);
  if (runIds.length === 0) return [];

  // Get all test case results from these runs, joining startTime so we can sort chronologically
  const results: any[] = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      duration: testRunsCases.duration,
      testRunId: testRunsCases.testRunId,
      startTime: testRuns.startTime,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(inArray(testRunsCases.testRunId, runIds), eq(testCases.projectId, projectId)));

  // Group by test case and compute aggregates
  const testCaseMap = new Map<
    number,
    {
      id: number;
      title: string;
      filePath: string;
      entries: Array<{ startTime: Date; duration: number }>;
    }
  >();

  for (const row of results) {
    if (row.duration === null || row.duration === undefined) continue;

    if (!testCaseMap.has(row.testCaseId)) {
      testCaseMap.set(row.testCaseId, {
        id: row.testCaseId,
        title: row.title,
        filePath: row.filePath,
        entries: [],
      });
    }

    const entry = testCaseMap.get(row.testCaseId)!;
    entry.entries.push({ startTime: row.startTime, duration: row.duration });
  }

  // Compute stats and sort by average duration desc (slowest first)
  return Array.from(testCaseMap.values())
    .map(
      (entry: {
        id: number;
        title: string;
        filePath: string;
        entries: Array<{ startTime: Date; duration: number }>;
      }) => {
        // Sort entries chronologically so latestDuration and trend are correct
        const chronological = [...entry.entries].sort(
          (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
        );
        const durations = chronological.map((e) => e.duration);

        const sorted = [...durations].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const avgDuration = Math.round(sum / sorted.length);
        const maxDuration = sorted[sorted.length - 1] || 0;
        const minDuration = sorted[0] || 0;
        const latestDuration = durations[durations.length - 1] || 0;

        // Compute trend: compare first half average vs second half average
        let trend: 'faster' | 'slower' | 'stable' = 'stable';
        if (durations.length >= 4) {
          const mid = Math.floor(durations.length / 2);
          const firstHalf = durations.slice(0, mid);
          const secondHalf = durations.slice(mid);
          const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
          const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

          const changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
          if (changePercent > 10) trend = 'slower';
          else if (changePercent < -10) trend = 'faster';
        }

        return {
          id: entry.id,
          title: entry.title,
          filePath: entry.filePath,
          avgDuration,
          maxDuration,
          minDuration,
          runCount: durations.length,
          trend,
          latestDuration,
        };
      },
    )
    .sort((a, b) => b.avgDuration - a.avgDuration)
    .slice(0, 20);
}

// ─── getProjectTimeoutOpportunities ──────────────────────────────

/**
 * Rank tests whose configured per-test timeout is far larger than their real
 * duration (so failures/hangs waste time), or that still carry a `test.slow()`
 * mark they no longer need. Pure detection lives in
 * `#shared/analytics/timeout-hygiene`; this handler only assembles each test's
 * duration history + latest timeout + latest annotations from recent runs.
 */
export async function getProjectTimeoutOpportunities(
  db: DrizzleDB,
  projectId: number,
  runsCount: number,
  thresholds?: TimeoutThresholds,
  /** The project page's run scope: the recent runs are the scope's. */
  scope?: ProjectRunScope | null,
): Promise<TimeoutOpportunity[]> {
  const projectResults: any[] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
  if (!projectResults[0]) throw new Error('Project not found');

  const effectiveLimit = Math.min(runsCount, 100);
  const scopeConditions = scope ? await projectRunScopeConditions(db, projectId, scope) : [];

  const recentRuns: any[] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), ...scopeConditions))
    .orderBy(desc(testRuns.startTime))
    .limit(effectiveLimit);

  const runIds: number[] = recentRuns.map((r: any) => r.id);
  if (runIds.length === 0) return [];

  const results: any[] = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      duration: testRunsCases.duration,
      timeout: testRunsCases.timeout,
      status: testRunsCases.status,
      testAnnotations: testRunsCases.testAnnotations,
      startTime: testRuns.startTime,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(inArray(testRunsCases.testRunId, runIds), eq(testCases.projectId, projectId)));

  type Acc = {
    testCaseId: number;
    title: string;
    filePath: string;
    durations: number[];
    failCount: number;
    latestTime: number;
    timeout: number | null;
    hasSlowAnnotation: boolean;
  };
  const byCase = new Map<number, Acc>();

  for (const row of results) {
    let acc = byCase.get(row.testCaseId);
    if (!acc) {
      acc = {
        testCaseId: row.testCaseId,
        title: row.title,
        filePath: row.filePath,
        durations: [],
        failCount: 0,
        latestTime: -Infinity,
        timeout: null,
        hasSlowAnnotation: false,
      };
      byCase.set(row.testCaseId, acc);
    }
    if (row.duration !== null && row.duration !== undefined) acc.durations.push(row.duration);
    if (row.status === 'failed' || row.status === 'timedout' || row.status === 'timedOut') acc.failCount++;
    // Latest execution wins for the "current" timeout + slow annotation state.
    const t = new Date(row.startTime).getTime();
    if (t >= acc.latestTime) {
      acc.latestTime = t;
      acc.timeout = row.timeout ?? null;
      acc.hasSlowAnnotation = hasSlowMark(row.testAnnotations as Array<{ type?: string }> | null);
    }
  }

  const opportunities: TimeoutOpportunity[] = [];
  for (const acc of byCase.values()) {
    const opp = detectTimeoutOpportunity(
      {
        testCaseId: acc.testCaseId,
        title: acc.title,
        filePath: acc.filePath,
        durations: acc.durations,
        timeout: acc.timeout,
        hasSlowAnnotation: acc.hasSlowAnnotation,
        failCount: acc.failCount,
      },
      thresholds,
    );
    if (opp) opportunities.push(opp);
  }

  return opportunities.sort((a, b) => b.impact - a.impact).slice(0, 50);
}

// ─── getProjectFailureClusters ───────────────────────────────────

/** The columns of a failure cluster the project's cluster list reads. */
const CLUSTER_LIST_COLUMNS = {
  id: failureClusters.id,
  fingerprint: failureClusters.fingerprint,
  signature: failureClusters.signature,
  title: failureClusters.title,
  errorType: failureClusters.errorType,
  selector: failureClusters.selector,
  sampleError: failureClusters.sampleError,
  status: failureClusters.status,
  triageNote: failureClusters.triageNote,
  firstSeenRunId: failureClusters.firstSeenRunId,
  lastSeenRunId: failureClusters.lastSeenRunId,
  occurrences: failureClusters.occurrences,
  fixLandedRunId: failureClusters.fixLandedRunId,
  fixLandedAt: failureClusters.fixLandedAt,
  fixCommit: failureClusters.fixCommit,
  timeToResolutionMs: failureClusters.timeToResolutionMs,
  fixVerification: failureClusters.fixVerification,
  assignee: failureClusters.assignee,
  snoozedUntil: failureClusters.snoozedUntil,
  snoozeMode: failureClusters.snoozeMode,
};

/**
 * A project's failure clusters, newest seen first (at most 100). With a run
 * scope the list holds the clusters seen in the scope's runs, and their
 * occurrences, affected tests and last-seen run are counted over those runs.
 */
export async function getProjectFailureClusters(
  db: DrizzleDB,
  projectId: number,
  statusFilter?: string,
  scope?: ProjectRunScope | null,
) {
  const projectResults: any[] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));

  if (!projectResults[0]) throw new Error('Project not found');

  const whereClauses = [eq(failureClusters.projectId, projectId)];
  if (statusFilter && ['open', 'resolved', 'ignored'].includes(statusFilter)) {
    whereClauses.push(eq(failureClusters.status, statusFilter));
  }

  let clusters: any[];
  let affectedById: Map<number, number>;
  if (scope) {
    const scopeConditions = await projectRunScopeConditions(db, projectId, scope);
    const seen = db
      .select({
        clusterId: testRunsCases.failureClusterId,
        occurrences: sql<number>`count(*)`.as('scoped_occurrences'),
        affectedTests: sql<number>`count(distinct ${testRunsCases.testCaseId})`.as('scoped_affected_tests'),
        lastSeenRunId: sql<number>`max(${testRunsCases.testRunId})`.as('scoped_last_seen_run_id'),
      })
      .from(testRunsCases)
      .where(
        and(
          isNotNull(testRunsCases.failureClusterId),
          scopedExecutionInProject(projectId, testRunsCases.testRunId, scopeConditions),
        ),
      )
      .groupBy(testRunsCases.failureClusterId)
      .as('seen');
    const rows: any[] = await db
      .select({
        ...CLUSTER_LIST_COLUMNS,
        scopedOccurrences: seen.occurrences,
        scopedAffectedTests: seen.affectedTests,
        scopedLastSeenRunId: seen.lastSeenRunId,
      })
      .from(failureClusters)
      .innerJoin(seen, eq(seen.clusterId, failureClusters.id))
      .where(and(...whereClauses))
      .orderBy(desc(seen.lastSeenRunId))
      .limit(100);
    clusters = rows.map(({ scopedOccurrences, scopedAffectedTests, scopedLastSeenRunId, ...cluster }) => ({
      ...cluster,
      occurrences: Number(scopedOccurrences),
      lastSeenRunId: Number(scopedLastSeenRunId),
      affectedTests: Number(scopedAffectedTests),
    }));
    affectedById = new Map(clusters.map((c: any) => [c.id, c.affectedTests]));
  } else {
    clusters = await db
      .select(CLUSTER_LIST_COLUMNS)
      .from(failureClusters)
      .where(and(...whereClauses))
      .orderBy(desc(failureClusters.lastSeenRunId))
      .limit(100);

    if (clusters.length === 0) return [];

    // Distinct affected test cases per cluster (occurrences counts retries too)
    const counts: any[] = await db
      .select({
        clusterId: testRunsCases.failureClusterId,
        affectedTests: sql<number>`count(distinct ${testRunsCases.testCaseId})`,
      })
      .from(testRunsCases)
      .where(
        inArray(
          testRunsCases.failureClusterId,
          clusters.map((c: any) => c.id),
        ),
      )
      .groupBy(testRunsCases.failureClusterId);
    affectedById = new Map(counts.map((c: any) => [c.clusterId, Number(c.affectedTests)]));
  }

  if (clusters.length === 0) return [];
  const clusterIds: number[] = clusters.map((c: any) => c.id);

  // Resolve lastSeen run status and start time
  const lastSeenRunIds: number[] = [...new Set(clusters.map((c: any) => c.lastSeenRunId))] as number[];
  const lastSeenRuns: any[] = await db
    .select({
      id: testRuns.id,
      status: testRuns.status,
      startTime: testRuns.startTime,
    })
    .from(testRuns)
    .where(inArray(testRuns.id, lastSeenRunIds));

  const runDataById = new Map(lastSeenRuns.map((r: any) => [r.id, { status: r.status, startTime: r.startTime }]));

  // Attach compact diagnosis subset
  const diagnosisRows: any[] =
    clusterIds.length > 0
      ? await db
          .select({
            clusterId: failureDiagnoses.clusterId,
            status: failureDiagnoses.status,
            category: failureDiagnoses.category,
            confidence: failureDiagnoses.confidence,
            summary: failureDiagnoses.summary,
          })
          .from(failureDiagnoses)
          .where(inArray(failureDiagnoses.clusterId, clusterIds))
      : [];
  const diagnosisById = new Map(diagnosisRows.map((d: any) => [d.clusterId, d]));

  // A pinned known-issue link per cluster (newest wins), carried into the list as
  // a compact chip so a triaged cluster shows what is already tracking it.
  const linkRows: any[] = await db
    .select({
      clusterId: entityLinks.failureClusterId,
      id: entityLinks.id,
      url: entityLinks.url,
      provider: entityLinks.provider,
      key: entityLinks.key,
    })
    .from(entityLinks)
    .where(inArray(entityLinks.failureClusterId, clusterIds))
    .orderBy(desc(entityLinks.id));
  const issueByCluster = new Map<number, { url: string; provider: string; key: string | null }>();
  for (const row of linkRows) {
    if (row.clusterId != null && !issueByCluster.has(row.clusterId)) {
      issueByCluster.set(row.clusterId, { url: row.url, provider: row.provider, key: row.key ?? null });
    }
  }

  return clusters.map((c: any) => {
    const runData = runDataById.get(c.lastSeenRunId) as { status: string; startTime: Date } | undefined;
    return {
      ...c,
      affectedTests: affectedById.get(c.id) ?? 0,
      lastSeenRunStatus: runData?.status ?? null,
      lastSeenAt: runData?.startTime ?? null,
      diagnosis: diagnosisById.get(c.id) ?? null,
      issueLink: issueByCluster.get(c.id) ?? null,
    };
  });
}

// ─── getProjectFlakyTests ────────────────────────────────────────

/** Run statuses of a finished run; the flaky leaderboard and the flake profile read only these runs. */
export const TERMINAL_STATUSES = ['passed', 'failed', 'timedout', 'interrupted'];

/**
 * Resolve the `test_cases.id`s in a project matching a tag/owner/priority
 * filter, or `null` when no filter was requested (meaning "no restriction").
 */
async function resolveFilteredCaseIds(
  db: DrizzleDB,
  projectId: number,
  filter?: FlakyTestsFilter,
): Promise<Set<number> | null> {
  const conditions = [eq(testCases.projectId, projectId)];
  if (filter?.tags?.length) conditions.push(...jsonArrayContainsAll(testCases.tags, filter.tags));
  if (filter?.owner) conditions.push(eq(testCases.owner, filter.owner));
  if (filter?.priority) conditions.push(eq(testCases.priority, filter.priority));
  if (conditions.length === 1) return null;

  const rows: any[] = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(and(...conditions));
  return new Set(rows.map((r) => r.id as number));
}

/** Narrow the flaky leaderboard to the tests a team actually owns. */
export interface FlakyTestsFilter {
  /** Every tag must be present on the case. */
  tags?: string[];
  owner?: string;
  priority?: string;
}

export async function getProjectFlakyTests(
  db: DrizzleDB,
  projectId: number,
  runsLimit: number,
  environment?: string | null,
  filter?: FlakyTestsFilter,
  branch?: string | null,
) {
  return (await getProjectFlakyTestsWithVerified(db, projectId, runsLimit, environment, filter, branch)).items;
}

/**
 * The flaky leaderboard, and apart from it the tests a verified fix took off
 * it. A test whose Flake Lab `verify` experiment held, and that has not
 * retry-passed in a run started since (`getHoldingVerifiedFixes`), leaves the
 * ranking: every reader of `getProjectFlakyTests` (the MCP tools, quarantine
 * candidates, PR feedback, the analytics leaderboard) sees it gone. The
 * Failures tab lists it under `verifiedFixed`.
 */
export async function getProjectFlakyTestsWithVerified(
  db: DrizzleDB,
  projectId: number,
  runsLimit: number,
  environment?: string | null,
  filter?: FlakyTestsFilter,
  branch?: string | null,
  /** The project page's run scope; replaces `environment`, `branch` and the default-branch reading. */
  scope?: ProjectRunScope | null,
) {
  const projectResults: any[] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId));
  const project = projectResults[0];
  if (!project) throw new Error('Project not found');

  const effectiveLimit = Math.min(200, Math.max(1, runsLimit));

  // Step 1: Last N terminal runs. An explicit branch filter scopes to exactly
  // that branch. Otherwise the leaderboard reads the runs of the project's
  // default branch (`resolveStoredDefaultBranch`, as the project tabs do) plus
  // runs with no branch (local or pre-migration), so a work-in-progress branch
  // stops contaminating the project's health signal. Environment scopes
  // independently. A project run
  // scope replaces all three with the project page's filters. Only runs the
  // `flakiness` use reads count: lab runs inject faults and conditions,
  // bisect and reproduction runs replay an older commit, and an environment
  // incident fails every test at once.
  const runsConditions = [
    eq(testRuns.projectId, projectId),
    inArray(testRuns.status, TERMINAL_STATUSES),
    eligibleRunSql('flakiness'),
  ];
  if (scope) {
    runsConditions.push(...(await projectRunScopeConditions(db, projectId, scope)));
  } else {
    if (environment) runsConditions.push(eq(testRuns.environment, environment));
    if (branch) {
      runsConditions.push(eq(testRuns.branch, branch));
    } else {
      const defaultBranch = await resolveStoredDefaultBranch(db, project);
      runsConditions.push(or(eq(testRuns.branch, defaultBranch), isNull(testRuns.branch), eq(testRuns.branch, ''))!);
    }
  }
  const filteredRuns: any[] = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime })
    .from(testRuns)
    .where(and(...runsConditions))
    .orderBy(desc(testRuns.startTime))
    .limit(effectiveLimit);

  if (filteredRuns.length === 0) return { items: [], verifiedFixed: [] };
  const filteredRunIds: number[] = filteredRuns.map((r: any) => r.id);
  const runStartTimeById = new Map(filteredRuns.map((r: any) => [r.id, r.startTime]));

  // Step 2: All test_runs_cases for those runs
  const allRows: any[] = await db
    .select({
      id: testRunsCases.id,
      testRunId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      duration: testRunsCases.duration,
      browser: testRunsCases.browser,
    })
    .from(testRunsCases)
    .where(inArray(testRunsCases.testRunId, filteredRunIds));

  // Step 3: Per (testCaseId, runId, browserKey): group rows
  type BrowserGroup = { rows: any[]; finalStatus: string; retryPass: boolean };
  const runDataMap = new Map<number, Map<number, Map<string, BrowserGroup>>>();

  for (const row of allRows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = row.browser as any;
    const browserKey: string = b?.projectName ?? b?.browserName ?? '';

    let byRun = runDataMap.get(row.testCaseId);
    if (!byRun) {
      byRun = new Map();
      runDataMap.set(row.testCaseId, byRun);
    }
    let byBrowser = byRun.get(row.testRunId);
    if (!byBrowser) {
      byBrowser = new Map();
      byRun.set(row.testRunId, byBrowser);
    }
    let group = byBrowser.get(browserKey);
    if (!group) {
      group = { rows: [], finalStatus: '', retryPass: false };
      byBrowser.set(browserKey, group);
    }
    group.rows.push(row);
  }

  // Compute per-browser group finalStatus and retryPass
  for (const [, byRun] of runDataMap) {
    for (const [, byBrowser] of byRun) {
      for (const [, group] of byBrowser) {
        const sorted = group.rows.slice().sort((a: any, b: any) => (a.retries ?? 0) - (b.retries ?? 0));
        const maxRetryRow = sorted[sorted.length - 1];
        group.finalStatus = maxRetryRow?.status ?? 'unknown';
        const hasFailed = group.rows.some((r: any) => isFailedStatus(r.status));
        const hasPassed = group.rows.some((r: any) => r.status === 'passed');
        group.retryPass = hasFailed && hasPassed;
      }
    }
  }

  // Step 4: Per testCaseId: aggregate across runs
  type CaseAgg = {
    totalRuns: number;
    failedRuns: number;
    retryPassRuns: number;
    alternations: number;
    lastFlakeRunId: number | null;
    lastFlakeAt: Date | null;
    latestRunsCaseId: number;
    failedDurations: number[];
  };

  const caseAggMap = new Map<number, CaseAgg>();

  // Process runs oldest → newest
  const sortedRuns = [...filteredRuns].sort((a: any, b: any) => a.startTime.getTime() - b.startTime.getTime());

  for (const testCaseId of runDataMap.keys()) {
    const byRun = runDataMap.get(testCaseId)!;
    let prevFinalFailed: boolean | null = null;
    let alternations = 0;
    let totalRuns = 0;
    let failedRuns = 0;
    let retryPassRuns = 0;
    let lastFlakeRunId: number | null = null;
    let lastFlakeAt: Date | null = null;
    let latestRunsCaseId = 0;
    const failedDurations: number[] = [];

    for (const run of sortedRuns) {
      const byBrowser = byRun.get(run.id);
      if (!byBrowser) continue;

      totalRuns++;
      let runFinalFailed = false;
      let runRetryPass = false;

      for (const [, group] of byBrowser) {
        if (isFailedStatus(group.finalStatus)) runFinalFailed = true;
        if (group.retryPass) runRetryPass = true;

        for (const row of group.rows) {
          if (row.id > latestRunsCaseId) latestRunsCaseId = row.id;
          if (isFailedStatus(row.status) && row.duration != null) {
            failedDurations.push(row.duration);
          }
        }
      }

      if (runFinalFailed) failedRuns++;
      if (runRetryPass) {
        retryPassRuns++;
        lastFlakeRunId = run.id;
        lastFlakeAt = runStartTimeById.get(run.id) ?? null;
      }

      if (prevFinalFailed !== null && prevFinalFailed !== runFinalFailed) {
        alternations++;
        if (!runRetryPass) {
          lastFlakeRunId = run.id;
          lastFlakeAt = runStartTimeById.get(run.id) ?? null;
        }
      }
      prevFinalFailed = runFinalFailed;
    }

    caseAggMap.set(testCaseId, {
      totalRuns,
      failedRuns,
      retryPassRuns,
      alternations,
      lastFlakeRunId,
      lastFlakeAt,
      latestRunsCaseId,
      failedDurations,
    });
  }

  // Step 5: Filter candidates and compute scores
  const candidates: Array<{
    testCaseId: number;
    latestRunsCaseId: number;
    totalRuns: number;
    failedRuns: number;
    retryPassRuns: number;
    alternations: number;
    failureRate: number;
    score: number;
    lastFlakeAt: Date | null;
    avgFailedDurationMs: number;
    wastedCiMinutes: number;
    impact: number;
  }> = [];

  // Applied before ranking so the top-N slice is taken from matching tests
  // only — filtering the slice afterwards would return fewer than N rows.
  const allowedCaseIds = await resolveFilteredCaseIds(db, projectId, filter);

  for (const [testCaseId, agg] of caseAggMap) {
    if (allowedCaseIds && !allowedCaseIds.has(testCaseId)) continue;
    if (agg.totalRuns < 3) continue;
    if (agg.retryPassRuns < 1 && agg.alternations < 2) continue;

    const retryRate = agg.retryPassRuns / agg.totalRuns;
    const altRate = agg.alternations / Math.max(1, agg.totalRuns - 1);
    const score = Math.min(100, Math.max(1, Math.round(100 * (0.6 * retryRate + 0.4 * altRate))));
    const failureRate = agg.failedRuns / agg.totalRuns;

    const avgFailedDurationMs =
      agg.failedDurations.length > 0
        ? Math.round(agg.failedDurations.reduce((a, b) => a + b, 0) / agg.failedDurations.length)
        : 0;
    const wastedCiMinutes = (avgFailedDurationMs / 60000) * agg.retryPassRuns;
    const wastedCiMinutesVal = Math.round(wastedCiMinutes * 100) / 100;
    const impact = Math.round(wastedCiMinutesVal * 0.7 + agg.retryPassRuns * 30 * 0.3);

    candidates.push({
      testCaseId,
      latestRunsCaseId: agg.latestRunsCaseId,
      totalRuns: agg.totalRuns,
      failedRuns: agg.failedRuns,
      retryPassRuns: agg.retryPassRuns,
      alternations: agg.alternations,
      failureRate,
      score,
      lastFlakeAt: agg.lastFlakeAt,
      avgFailedDurationMs,
      wastedCiMinutes: wastedCiMinutesVal,
      impact,
    });
  }

  if (candidates.length === 0) return { items: [], verifiedFixed: [] };

  // A verified fix that still holds takes the test off the ranking.
  const verified = await getHoldingVerifiedFixes(
    db,
    candidates.map((c) => c.testCaseId),
  );
  const ranked = candidates.filter((c) => !verified.has(c.testCaseId));
  const verifiedCandidates = candidates.filter((c) => verified.has(c.testCaseId));

  ranked.sort((a, b) => b.impact - a.impact || b.score - a.score || b.retryPassRuns - a.retryPassRuns);
  const top = ranked.slice(0, 50);

  // Step 6: Join titles/filePaths + rootCause
  const testCaseIds: number[] = [...top, ...verifiedCandidates].map((c) => c.testCaseId);
  const testCaseRows: any[] = await db
    .select({
      id: testCases.id,
      title: testCases.title,
      filePath: testCases.filePath,
      flakyRootCause: testCases.flakyRootCause,
      tags: testCases.tags,
      owner: testCases.owner,
      priority: testCases.priority,
    })
    .from(testCases)
    .where(inArray(testCases.id, testCaseIds));
  const testCaseById = new Map(testCaseRows.map((t: any) => [t.id, t]));

  const items = top.map((c) => {
    const tc = testCaseById.get(c.testCaseId);
    return {
      testCaseId: c.testCaseId,
      latestRunsCaseId: c.latestRunsCaseId,
      title: tc?.title ?? '',
      filePath: tc?.filePath ?? '',
      totalRuns: c.totalRuns,
      failedRuns: c.failedRuns,
      retryPassRuns: c.retryPassRuns,
      alternations: c.alternations,
      failureRate: Math.round(c.failureRate * 100) / 100,
      score: c.score,
      lastFlakeAt: c.lastFlakeAt,
      rootCause: tc?.flakyRootCause ?? null,
      tags: (tc?.tags as string[] | null) ?? null,
      owner: tc?.owner ?? null,
      priority: tc?.priority ?? null,
      impact: c.impact,
      wastedCiMinutes: c.wastedCiMinutes,
      avgFailedDurationMs: c.avgFailedDurationMs,
    };
  });
  const verifiedFixed = verifiedCandidates
    .sort((a, b) => b.impact - a.impact)
    .map((c) => {
      const tc = testCaseById.get(c.testCaseId);
      return {
        testCaseId: c.testCaseId,
        title: tc?.title ?? '',
        filePath: tc?.filePath ?? '',
        retryPassRuns: c.retryPassRuns,
        lastFlakeAt: c.lastFlakeAt,
        verifiedFix: verified.get(c.testCaseId)!,
      };
    });
  return { items, verifiedFixed };
}

// ─── getProjectsOverview ─────────────────────────────────────────────────────

const FAILING_STATUSES = ['failed', 'timedout', 'interrupted'];

function deriveTendency(runs: { status: string; flakyTests: number }[]): 'passing' | 'flaky' | 'failing' | 'unknown' {
  if (runs.length < 2) return 'unknown';
  const latest = runs[runs.length - 1]!;
  if (FAILING_STATUSES.includes(latest.status)) return 'failing';
  const w = runs.slice(-5);
  const hasFlaky = w.some((r) => (r.flakyTests ?? 0) > 0);
  const anyFailed = w.some((r) => FAILING_STATUSES.includes(r.status));
  const anyPassed = w.some((r) => r.status === 'passed');
  if (hasFlaky || (anyFailed && anyPassed)) return 'flaky';
  if (w.every((r) => r.status === 'passed')) return 'passing';
  return 'unknown';
}

export async function getProjectsOverview(db: DrizzleDB, scope: ProjectScope = 'all') {
  const { ids: projectIds, projects: allProjects } = await getProjects(db, scope);

  // Tags per project (batched)
  const tagRows: any[] = await db
    .select({ projectId: projectTags.projectId, tag: tags })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, projectIds));

  const tagsByProjectId = new Map<number, any[]>();
  for (const r of tagRows) {
    const list = tagsByProjectId.get(r.projectId) ?? [];
    list.push(r.tag);
    tagsByProjectId.set(r.projectId, list);
  }

  // Total full run counts per project
  const fullRunStats: any[] = await db
    .select({
      projectId: testRuns.projectId,
      totalFullRuns: count(),
    })
    .from(testRuns)
    .where(and(inArray(testRuns.projectId, projectIds), eq(testRuns.isFullRun, 1), notLabRun(testRuns.origin)))
    .groupBy(testRuns.projectId);

  const totalFullRunsByProjectId = new Map<number, number>();
  for (const r of fullRunStats) {
    totalFullRunsByProjectId.set(r.projectId, Number(r.totalFullRuns));
  }

  // Last 20 full runs per project using a CTE with window function
  let recentFullRuns: any[] = [];
  if (projectIds.length > 0) {
    const rankedCte = db.$with('ranked_runs').as(
      db
        .select({
          id: testRuns.id,
          projectId: testRuns.projectId,
          status: testRuns.status,
          passedTests: testRuns.passedTests,
          failedTests: testRuns.failedTests,
          flakyTests: testRuns.flakyTests,
          totalTests: testRuns.totalTests,
          startTime: testRuns.startTime,
          duration: testRuns.duration,
          environment: testRuns.environment,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRuns.projectId} ORDER BY ${testRuns.startTime} DESC)`.as(
            'rn',
          ),
        })
        .from(testRuns)
        .where(and(inArray(testRuns.projectId, projectIds), eq(testRuns.isFullRun, 1), notLabRun(testRuns.origin))),
    );

    recentFullRuns = await db
      .with(rankedCte)
      .select({
        id: rankedCte.id,
        projectId: rankedCte.projectId,
        status: rankedCte.status,
        passedTests: rankedCte.passedTests,
        failedTests: rankedCte.failedTests,
        flakyTests: rankedCte.flakyTests,
        totalTests: rankedCte.totalTests,
        startTime: rankedCte.startTime,
        duration: rankedCte.duration,
        environment: rankedCte.environment,
      })
      .from(rankedCte)
      .where(lte(rankedCte.rn, 20))
      .orderBy(rankedCte.projectId, rankedCte.startTime);
  }

  // Group runs by projectId (each list is oldest → newest)
  const runsByProjectId = new Map<number, any[]>();
  for (const run of recentFullRuns) {
    const list = runsByProjectId.get(run.projectId) ?? [];
    list.push(run);
    runsByProjectId.set(run.projectId, list);
  }

  return allProjects.map((project: any) => {
    const runs = runsByProjectId.get(project.id) ?? [];
    const latest = runs.length > 0 ? runs[runs.length - 1] : null;
    return {
      id: project.id,
      name: project.name,
      label: project.label ?? null,
      tags: tagsByProjectId.get(project.id) ?? [],
      totalFullRuns: totalFullRunsByProjectId.get(project.id) ?? 0,
      latestFullRun: latest
        ? {
            id: latest.id,
            status: latest.status,
            startTime: latest.startTime,
            duration: latest.duration ?? null,
            passedTests: latest.passedTests ?? 0,
            failedTests: latest.failedTests ?? 0,
            flakyTests: latest.flakyTests ?? 0,
            totalTests: latest.totalTests ?? 0,
          }
        : null,
      recentRuns: runs.map((r: any) => ({
        id: r.id,
        status: r.status,
        passedTests: r.passedTests ?? 0,
        failedTests: r.failedTests ?? 0,
        flakyTests: r.flakyTests ?? 0,
        totalTests: r.totalTests ?? 0,
        startTime: r.startTime,
        environment: r.environment ?? null,
      })),
      tendency: deriveTendency(runs),
    };
  });
}
