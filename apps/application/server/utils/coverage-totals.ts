/**
 * Combined coverage of a commit, from the database: the inputs of
 * `combineCoverage` (`#shared/coverage-combine`) loaded for one commit, and
 * the totals it computes stored per suite (`coverage_totals`) and per day
 * (`coverage_daily`).
 *
 * - The commit's **reports** are its uploaded suites; their inventories,
 *   united, are the commit's file inventory.
 * - The **`e2e` suite** is the union of the run coverage of the commit's
 *   complete Playwright runs (no lab run, no partial run): server files with
 *   their executed lines, browser files with the functions that ran and every
 *   function known in their version.
 * - A suite the commit lacks is **carried forward** from its newest report on
 *   the commit's branch, then on the default branch, file by file where the
 *   file's blob is the one the commit's inventory names; without an inventory
 *   nothing is carried.
 * - The **span table** of each file version is `coverage_executable`'s server
 *   lines.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { normalizeFunctionRanges, normalizeLineRanges, type LineRange } from '@piwitests/core/coverage';
import {
  DEFAULT_COVERAGE_SCOPE,
  compileCoverageAreas,
  compileCoverageScope,
  parseCoverageAreas,
  parseCoverageScope,
  type CoverageArea,
  type CoverageScope,
} from '@piwitests/core/coverage-scope';
import { coverageDaily, coverageReports, coverageTotals, projects, runCoverage, testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import {
  COMBINED_SUITE,
  E2E_SUITE,
  areaCoverage,
  combineCoverage,
  type AreaCoverage,
  type CombinedCoverage,
  type CoverageCounts,
  type SuiteFile,
  type SuiteInput,
} from '#shared/coverage-combine';
import { eligibleRunSql } from '#shared/run-eligibility';
import { getFileVersions, getRunCoverage, type RunCoverageFile } from './coverage';
import { getReportFiles, getReportInventories, type ReportFileUpload } from './coverage-reports';
import { locatorBranchTag } from './locator-usages';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** How far back a commit looks for a suite to carry forward, in reports per suite. */
const CARRY_CANDIDATES = 5;

/** A commit's coverage as loaded and combined. */
export interface CommitCoverage {
  commit: string;
  /** The branch the commit's coverage ran on; '' for the default branch. */
  branch: string;
  scope: CoverageScope;
  scopeVersion: number;
  combined: CombinedCoverage;
  /** The project's named areas, and the commit's coverage of each. */
  areas: AreaCoverage[];
  /** The area a repository-relative path belongs to; null outside every area. */
  areaOf: (path: string) => string | null;
  /** The complete runs whose coverage makes the `e2e` suite. */
  runIds: number[];
}

function reportFileToSuiteFile(file: ReportFileUpload): SuiteFile {
  return {
    path: file.path,
    ...(file.blob ? { blob: file.blob } : {}),
    executable: file.executable,
    lines: file.lines,
    functions: file.functions,
    allFunctions: file.allFunctions,
    linesRecorded: true,
  };
}

function runFileToSuiteFile(file: RunCoverageFile): SuiteFile {
  return {
    path: file.path,
    ...(file.blob ? { blob: file.blob } : {}),
    executable: [],
    lines: file.lines ?? [],
    functions: file.functions ?? [],
    allFunctions: file.allFunctions ?? [],
    // A browser file names the functions that ran; a server file at `lines`, its lines too.
    linesRecorded: file.runtime === 'server' && (file.lines?.length ?? 0) > 0,
  };
}

/** The run coverage of several runs, united per path: the e2e suite of a commit. */
async function runSuiteFiles(db: DrizzleDB, runIds: number[]): Promise<SuiteFile[]> {
  const byPath = new Map<string, SuiteFile>();
  for (const runId of runIds) {
    const coverage = await getRunCoverage(db, runId);
    for (const file of coverage?.files ?? []) {
      const next = runFileToSuiteFile(file);
      const known = byPath.get(file.path);
      if (!known) {
        byPath.set(file.path, next);
        continue;
      }
      // Runs of one commit test one version; a run that names another keeps out of the union.
      if (known.blob && next.blob && known.blob !== next.blob) continue;
      const blob = known.blob ?? next.blob;
      byPath.set(file.path, {
        ...known,
        ...(blob ? { blob } : {}),
        lines: normalizeLineRanges([...known.lines, ...next.lines]),
        functions: normalizeFunctionRanges([...known.functions, ...next.functions]),
        allFunctions: normalizeFunctionRanges([...known.allFunctions, ...next.allFunctions]),
        linesRecorded: known.linesRecorded || next.linesRecorded,
      });
    }
  }
  return [...byPath.values()];
}

/** The complete runs of a commit that recorded run coverage, newest first. */
async function commitRuns(
  db: DrizzleDB,
  projectId: number,
  commit: string,
): Promise<Array<{ id: number; branch: string | null }>> {
  return db
    .select({ id: testRuns.id, branch: testRuns.branch })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        eq(testRuns.commit, commit),
        eligibleRunSql('change-coverage'),
        sql`EXISTS (SELECT 1 FROM ${runCoverage} WHERE ${runCoverage.runId} = ${testRuns.id})`,
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id));
}

/** The project's coverage scope, its version and its named areas. */
async function projectScope(
  db: DrizzleDB,
  projectId: number,
): Promise<{ scope: CoverageScope; version: number; areas: CoverageArea[] }> {
  const [row] = await db
    .select({ scope: projects.coverageScope, version: projects.coverageScopeVersion, areas: projects.coverageAreas })
    .from(projects)
    .where(eq(projects.id, projectId));
  return {
    scope: (row?.scope ? parseCoverageScope(row.scope) : null) ?? DEFAULT_COVERAGE_SCOPE,
    version: row?.version ?? 0,
    areas: (row?.areas ? parseCoverageAreas(row.areas) : null) ?? [],
  };
}

/** The files of a suite's earlier coverage whose version the commit's inventory names. */
function carried(files: SuiteFile[], inventory: ReadonlyMap<string, string>): SuiteFile[] {
  return files.filter((file) => file.blob && inventory.get(file.path) === file.blob);
}

/**
 * Load and combine a commit's coverage. Null when the commit has neither a
 * report nor a complete run with coverage.
 */
export async function loadCommitCoverage(
  db: DrizzleDB,
  projectId: number,
  commit: string,
): Promise<CommitCoverage | null> {
  const [reports, runs, { scope, version, areas }] = await Promise.all([
    db
      .select()
      .from(coverageReports)
      .where(and(eq(coverageReports.projectId, projectId), eq(coverageReports.commit, commit))),
    commitRuns(db, projectId, commit),
    projectScope(db, projectId),
  ]);
  if (reports.length === 0 && runs.length === 0) return null;

  const defaultBranch = await projectDefaultBranch(db, projectId);
  const branch =
    reports.find((r) => r.branch)?.branch ?? locatorBranchTag(runs.find((r) => r.branch)?.branch, defaultBranch);

  const inventories = await getReportInventories(db, reports);
  const inventory = inventories.size > 0 ? new Map<string, string>() : null;
  for (const entries of inventories.values()) for (const [path, blob] of entries) inventory!.set(path, blob);

  const filesOf = await getReportFiles(
    db,
    reports.map((r) => r.id),
  );
  const suites: SuiteInput[] = reports.map((report) => ({
    name: report.suite,
    kind: report.kind === 'e2e' ? 'e2e' : 'unit',
    files: (filesOf.get(report.id) ?? []).map(reportFileToSuiteFile),
    incomplete: !!report.incomplete,
  }));
  const runIds = runs.map((r) => r.id);
  if (runIds.length > 0) suites.push({ name: E2E_SUITE, kind: 'e2e', files: await runSuiteFiles(db, runIds) });

  if (inventory) await carryForward(db, projectId, commit, branch, inventory, suites);

  const versions = new Map<string, { path: string; runtime: 'server'; blob: string }>();
  for (const suite of suites) {
    for (const file of suite.files) {
      if (file.blob)
        versions.set(`${file.path}\0${file.blob}`, { path: file.path, runtime: 'server', blob: file.blob });
    }
  }
  const spanTable = new Map<string, LineRange[]>();
  for (const v of await getFileVersions(db, projectId, [...versions.values()])) {
    if (v.lines.length > 0) spanTable.set(`${v.path}\0${v.blob}`, v.lines);
  }

  const combined = combineCoverage({ inventory, inScope: compileCoverageScope(scope), spanTable, suites });
  const areaOf = compileCoverageAreas(areas);
  const byArea = areaCoverage(
    combined,
    areas.map((a) => a.name),
    areaOf,
  );
  return { commit, branch, scope, scopeVersion: version, combined, areas: byArea, areaOf, runIds };
}

/**
 * Add the suites the commit lacks, from their newest coverage on the commit's
 * branch, then on the default branch: the files whose blob the inventory
 * names. The project's suites are those of its reports, and `e2e` once a run
 * recorded run coverage.
 */
async function carryForward(
  db: DrizzleDB,
  projectId: number,
  commit: string,
  branch: string,
  inventory: ReadonlyMap<string, string>,
  suites: SuiteInput[],
): Promise<void> {
  const present = new Set(suites.map((s) => s.name));
  const branches = branch ? [branch, ''] : [''];
  const known = await db
    .selectDistinct({ suite: coverageReports.suite, kind: coverageReports.kind })
    .from(coverageReports)
    .where(and(eq(coverageReports.projectId, projectId), ne(coverageReports.commit, commit)));
  for (const { suite, kind } of known) {
    if (present.has(suite)) continue;
    present.add(suite);
    const earlier = await db
      .select()
      .from(coverageReports)
      .where(
        and(
          eq(coverageReports.projectId, projectId),
          eq(coverageReports.suite, suite),
          ne(coverageReports.commit, commit),
          inArray(coverageReports.branch, branches),
        ),
      )
      .orderBy(desc(coverageReports.updatedAt), desc(coverageReports.id))
      .limit(CARRY_CANDIDATES * branches.length);
    // The commit's own branch first, then the default branch.
    const ordered = branches.flatMap((b) => earlier.filter((r) => r.branch === b));
    const source = ordered[0];
    if (!source) continue;
    const files = carried(
      ((await getReportFiles(db, [source.id])).get(source.id) ?? []).map(reportFileToSuiteFile),
      inventory,
    );
    if (files.length === 0) continue;
    suites.push({
      name: suite,
      kind: kind === 'e2e' ? 'e2e' : 'unit',
      files,
      carriedFrom: source.commit,
      carriedFiles: files.length,
      incomplete: !!source.incomplete,
    });
  }

  if (present.has(E2E_SUITE)) return;
  const defaultBranch = await projectDefaultBranch(db, projectId);
  const runs = await db
    .select({ id: testRuns.id, commit: testRuns.commit, branch: testRuns.branch })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        ne(testRuns.commit, commit),
        eligibleRunSql('change-coverage'),
        sql`EXISTS (SELECT 1 FROM ${runCoverage} WHERE ${runCoverage.runId} = ${testRuns.id})`,
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(50);
  const source = branches
    .flatMap((b) => runs.filter((r) => locatorBranchTag(r.branch, defaultBranch) === b))
    .find((r) => r.commit);
  if (!source) return;
  const files = carried(await runSuiteFiles(db, [source.id]), inventory);
  if (files.length === 0) return;
  suites.push({ name: E2E_SUITE, kind: 'e2e', files, carriedFrom: source.commit, carriedFiles: files.length });
}

function countColumns(counts: CoverageCounts) {
  return {
    executableLines: counts.executableLines,
    executedLines: counts.executedLines,
    undeterminedLines: counts.undeterminedLines,
    knownFunctions: counts.knownFunctions,
    runFunctions: counts.runFunctions,
    files: counts.files,
    unitOnlyLines: counts.unitOnlyLines,
    e2eOnlyLines: counts.e2eOnlyLines,
    bothLines: counts.bothLines,
  };
}

/**
 * Compute and store a commit's totals: one `coverage_totals` row per suite and
 * one for every suite combined, for every file and for each of the project's
 * named areas, replacing what the commit held, and the day's `coverage_daily`
 * rows. Returns the coverage, or null when the commit has none.
 */
export async function storeCommitTotals(
  db: DrizzleDB,
  projectId: number,
  commit: string,
  now: Date = new Date(),
): Promise<CommitCoverage | null> {
  const coverage = await loadCommitCoverage(db, projectId, commit);
  if (!coverage) {
    await db
      .delete(coverageTotals)
      .where(and(eq(coverageTotals.projectId, projectId), eq(coverageTotals.commit, commit)));
    return null;
  }
  const { combined } = coverage;
  const withoutData = combined.filesWithoutData?.length ?? null;
  const rows = [
    {
      area: '',
      suite: COMBINED_SUITE,
      kind: COMBINED_SUITE,
      counts: combined.totals,
      filesWithoutData: withoutData,
      filesCarriedForward: combined.suites.reduce((n, s) => n + s.carriedFiles, 0),
      carriedFrom: combined.suites.find((s) => s.carriedFrom)?.carriedFrom ?? null,
      incomplete: combined.suites.some((s) => s.incomplete),
    },
    ...[{ name: '', suites: combined.suites }, ...coverage.areas].flatMap((area) => [
      ...(area.name
        ? [
            {
              area: area.name,
              suite: COMBINED_SUITE,
              kind: COMBINED_SUITE,
              counts: (area as AreaCoverage).totals,
              filesWithoutData: null,
              filesCarriedForward: 0,
              carriedFrom: null,
              incomplete: combined.suites.some((s) => s.incomplete),
            },
          ]
        : []),
      ...area.suites.map((s) => ({
        area: area.name,
        suite: s.name,
        kind: s.kind,
        counts: s as CoverageCounts,
        filesWithoutData: null,
        filesCarriedForward: area.name ? 0 : s.carriedFiles,
        carriedFrom: s.carriedFrom,
        incomplete: s.incomplete,
      })),
    ]),
  ].map((r) => ({
    projectId,
    commit,
    branch: coverage.branch,
    area: r.area,
    suite: r.suite,
    kind: r.kind,
    ...countColumns(r.counts),
    filesWithoutData: r.filesWithoutData,
    filesCarriedForward: r.filesCarriedForward,
    carriedFrom: r.carriedFrom,
    incomplete: r.incomplete,
    scopeVersion: coverage.scopeVersion,
    computedAt: now,
  }));
  await db
    .delete(coverageTotals)
    .where(and(eq(coverageTotals.projectId, projectId), eq(coverageTotals.commit, commit)));
  await db.insert(coverageTotals).values(rows);

  const day = now.toISOString().slice(0, 10);
  for (const row of rows) {
    const daily = {
      branch: row.branch,
      suite: row.suite,
      area: row.area,
      commit: row.commit,
      executableLines: row.executableLines,
      executedLines: row.executedLines,
      undeterminedLines: row.undeterminedLines,
      knownFunctions: row.knownFunctions,
      runFunctions: row.runFunctions,
      files: row.files,
      unitOnlyLines: row.unitOnlyLines,
      e2eOnlyLines: row.e2eOnlyLines,
      bothLines: row.bothLines,
      computedAt: now,
    };
    await db
      .insert(coverageDaily)
      .values({ ...daily, projectId, day })
      .onConflictDoUpdate({
        target: [
          coverageDaily.projectId,
          coverageDaily.day,
          coverageDaily.branch,
          coverageDaily.suite,
          coverageDaily.area,
        ],
        set: { ...daily },
      });
  }
  return coverage;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a commit's totals wait for more uploads and runs before they are computed. */
export const TOTALS_DELAY_MS = 5000;

/**
 * Compute a commit's totals a few seconds from now, once for every upload and
 * run coverage arriving meanwhile: four shards and three suites trigger one
 * computation; `after` runs once they are stored. A failure is logged, never
 * thrown.
 */
export function scheduleCommitTotals<D extends DrizzleDB>(
  db: () => Promise<D>,
  projectId: number,
  commit: string,
  after?: (db: D, projectId: number, commit: string) => Promise<void>,
): void {
  const key = `${projectId}\0${commit}`;
  const known = pending.get(key);
  if (known) clearTimeout(known);
  const timer = setTimeout(() => {
    pending.delete(key);
    db()
      .then(async (database) => {
        await storeCommitTotals(database, projectId, commit);
        await after?.(database, projectId, commit);
      })
      .catch((error) => console.error(`[coverage] Could not compute the totals of ${commit}:`, error));
  }, TOTALS_DELAY_MS);
  timer.unref?.();
  pending.set(key, timer);
}

/** The commit a project's coverage is shown for: the newest with totals on the branch, else the newest with a report. */
export async function latestCoverageCommit(
  db: DrizzleDB,
  projectId: number,
  branch: string = '',
): Promise<string | null> {
  const [totals] = await db
    .select({ commit: coverageTotals.commit })
    .from(coverageTotals)
    .where(
      and(
        eq(coverageTotals.projectId, projectId),
        eq(coverageTotals.branch, branch),
        eq(coverageTotals.suite, COMBINED_SUITE),
      ),
    )
    .orderBy(desc(coverageTotals.computedAt), desc(coverageTotals.id))
    .limit(1);
  if (totals) return totals.commit;
  const [report] = await db
    .select({ commit: coverageReports.commit })
    .from(coverageReports)
    .where(and(eq(coverageReports.projectId, projectId), eq(coverageReports.branch, branch)))
    .orderBy(desc(coverageReports.updatedAt), desc(coverageReports.id))
    .limit(1);
  return report?.commit ?? null;
}
