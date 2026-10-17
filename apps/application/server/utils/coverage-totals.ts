/**
 * Combined coverage of a commit, from the database: the inputs of
 * `combineCoverage` (`#shared/coverage-combine`) loaded for one commit, and
 * the totals it computes stored per suite (`coverage_totals`) and per day
 * (`coverage_daily`).
 *
 * - The commit's **reports** are its uploaded suites; their inventories,
 *   united, are the commit's file inventory.
 * - The **`e2e` suite** is the union of the run coverage of the commit's
 *   complete Playwright runs (no lab run, no partial run), per runtime: server
 *   files with their executed lines, browser files with the functions that ran
 *   and every function known in their version. A run whose server coverage is
 *   incomplete (a backend restarted or was unreachable) joins the union: it
 *   adds only lines that ran, against executable lines a span table gives per
 *   file version. The suite is incomplete when every run is.
 * - The commit **arrived** when its coverage first did: its first report or
 *   complete run with coverage, kept on its totals. Commits follow that order:
 *   the latest commit with coverage, the day a commit counts on in
 *   `coverage_daily`, the commits a suite is carried forward from.
 * - A suite the commit lacks is **carried forward** from the newest commit
 *   that arrived before it with that suite, on the commit's branch, then on the
 *   default branch, file by file where the file's blob is the one the commit's
 *   inventory names; without an inventory nothing is carried. An `e2e` suite
 *   carried forward is the union of that commit's complete runs.
 * - The **span table** of each file version is `coverage_executable`'s server
 *   lines.
 * - A commit's branch is the default branch ('') when any of its reports or
 *   runs ran there.
 * - Off the default branch, per suite only the report of the commit whose
 *   coverage arrived last is kept ({@link pruneSupersededReports}). A commit
 *   that lost its reports keeps its totals, final from then on: they are never
 *   computed again.
 */
import { and, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
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
import { readRunCoverageGaps } from '#shared/run-coverage-gaps';
import {
  fileVersionKey,
  getFileVersions,
  getRunsCoverageFiles,
  withFileVersion,
  type FileVersion,
  type RunCoverageFile,
} from './coverage';
import { getReportFiles, getReportInventories, markDetailRemoved, type ReportFileUpload } from './coverage-reports';
import { locatorBranchTag } from './locator-usages';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** How far back a commit looks for a suite to carry forward, in commits per suite and branch. */
const CARRY_CANDIDATES = 5;
/** Runs read per branch to find the commits an `e2e` suite may be carried forward from. */
const CARRY_RUNS = 50;
/** Totals and daily rows one insert writes at most. */
const ROW_CHUNK = 100;

/** A commit's coverage as loaded and combined. */
export interface CommitCoverage {
  commit: string;
  /** The branch the commit's coverage ran on; '' for the default branch. */
  branch: string;
  /** When the commit's coverage first arrived: its first report or complete run with coverage. */
  seenAt: Date;
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

/**
 * The run coverage of several runs, united per runtime and path: an `e2e`
 * suite. A file the server and the browser both ran stays two entries, so the
 * browser's functions keep their undetermined lines beside the server's lines.
 */
function runSuiteFiles(runs: RunCoverageFile[][]): SuiteFile[] {
  const byFile = new Map<string, SuiteFile>();
  for (const files of runs) {
    for (const file of files) {
      const key = `${file.runtime}\0${file.path}`;
      const next = runFileToSuiteFile(file);
      const known = byFile.get(key);
      if (!known) {
        byFile.set(key, next);
        continue;
      }
      // Runs of one commit test one version; a run that names another keeps out of the union.
      if (known.blob && next.blob && known.blob !== next.blob) continue;
      const blob = known.blob ?? next.blob;
      byFile.set(key, {
        ...known,
        ...(blob ? { blob } : {}),
        lines: normalizeLineRanges([...known.lines, ...next.lines]),
        functions: normalizeFunctionRanges([...known.functions, ...next.functions]),
        allFunctions: normalizeFunctionRanges([...known.allFunctions, ...next.allFunctions]),
        linesRecorded: known.linesRecorded || next.linesRecorded,
      });
    }
  }
  return [...byFile.values()];
}

/**
 * Whether the run coverage of a commit's runs leaves part of the suite out:
 * when every run's server coverage is incomplete (a backend restarted or was
 * unreachable). A complete run of the commit ran the whole suite, and an
 * incomplete one adds only lines that ran, so one complete run keeps the
 * union whole.
 */
function runsIncomplete(runs: Array<{ gaps: unknown }>): boolean {
  return runs.length > 0 && runs.every((r) => readRunCoverageGaps(r.gaps).length > 0);
}

/** The complete runs of a commit that recorded run coverage, newest first, with their server coverage gaps. */
async function commitRuns(
  db: DrizzleDB,
  projectId: number,
  commit: string,
): Promise<Array<{ id: number; branch: string | null; startTime: Date; gaps: unknown }>> {
  return db
    .select({
      id: testRuns.id,
      branch: testRuns.branch,
      startTime: testRuns.startTime,
      gaps: testRuns.serverCoverageGaps,
    })
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
export async function projectScope(
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
function carried<T extends { path: string; blob?: string }>(files: T[], inventory: ReadonlyMap<string, string>): T[] {
  return files.filter((file) => file.blob && inventory.get(file.path) === file.blob);
}

/** The branch tag of a commit whose reports and runs carry these tags: the default branch's when any ran there. */
function commitBranch(tags: string[]): string {
  return tags.includes('') ? '' : (tags.find((tag) => tag !== '') ?? '');
}

/** When the commit's coverage first arrived, from what its totals keep and its reports' and runs' times. */
async function commitSeenAt(db: DrizzleDB, projectId: number, commit: string, times: Date[]): Promise<Date> {
  const [kept] = await db
    .select({ seenAt: coverageTotals.commitSeenAt })
    .from(coverageTotals)
    .where(
      and(
        eq(coverageTotals.projectId, projectId),
        eq(coverageTotals.commit, commit),
        eq(coverageTotals.suite, COMBINED_SUITE),
        eq(coverageTotals.area, ''),
      ),
    );
  const all = [...times, ...(kept?.seenAt ? [kept.seenAt] : [])].map((t) => new Date(t).getTime());
  return new Date(Math.min(...all));
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
  const branch = commitBranch([
    ...reports.map((r) => r.branch),
    ...runs.map((r) => locatorBranchTag(r.branch, defaultBranch)),
  ]);
  const seenAt = await commitSeenAt(db, projectId, commit, [
    ...reports.map((r) => r.createdAt),
    ...runs.map((r) => r.startTime),
  ]);

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
  const runFiles = [...(await getRunsCoverageFiles(db, runIds)).values()];
  const carriedSuites = inventory
    ? await carryForward(db, projectId, commit, branch, defaultBranch, seenAt, inventory, [
        ...suites.map((s) => s.name),
        ...(runIds.length > 0 ? [E2E_SUITE] : []),
      ])
    : { reports: [], e2e: null };

  // What every file version holds, read once: the span table, and the functions known in each browser file.
  const allRunFiles = [...runFiles, ...(carriedSuites.e2e?.runs ?? [])].flat();
  const reportFiles = [...suites, ...carriedSuites.reports].flatMap((s) => s.files);
  const versions = new Map<string, FileVersion>();
  for (const v of await getFileVersions(db, projectId, [
    ...allRunFiles.flatMap((f) => (f.blob ? [{ path: f.path, runtime: f.runtime, blob: f.blob }] : [])),
    ...[...allRunFiles, ...reportFiles].flatMap((f) =>
      f.blob ? [{ path: f.path, runtime: 'server' as const, blob: f.blob }] : [],
    ),
  ])) {
    versions.set(fileVersionKey(v), v);
  }
  const withVersions = (files: RunCoverageFile[]) =>
    files.map((f) => withFileVersion(f, f.blob ? versions.get(fileVersionKey({ ...f, blob: f.blob })) : undefined));

  if (runIds.length > 0)
    suites.push({
      name: E2E_SUITE,
      kind: 'e2e',
      files: runSuiteFiles(runFiles.map(withVersions)),
      incomplete: runsIncomplete(runs),
    });
  suites.push(...carriedSuites.reports);
  if (carriedSuites.e2e) {
    const files = runSuiteFiles(carriedSuites.e2e.runs.map(withVersions));
    suites.push({
      name: E2E_SUITE,
      kind: 'e2e',
      files,
      carriedFrom: carriedSuites.e2e.commit,
      carriedFiles: new Set(files.map((f) => f.path)).size,
      incomplete: carriedSuites.e2e.incomplete,
    });
  }

  const spanTable = new Map<string, LineRange[]>();
  for (const v of versions.values()) {
    if (v.runtime === 'server' && v.lines.length > 0) spanTable.set(`${v.path}\0${v.blob}`, v.lines);
  }

  const combined = combineCoverage({ inventory, inScope: compileCoverageScope(scope), spanTable, suites });
  const areaOf = compileCoverageAreas(areas);
  const byArea = areaCoverage(
    combined,
    areas.map((a) => a.name),
    areaOf,
  );
  return { commit, branch, seenAt, scope, scopeVersion: version, combined, areas: byArea, areaOf, runIds };
}

/** A run's branch as a branch tag, in SQL: '' for none or the default branch. */
function runBranchIs(tag: string, defaultBranch: string | null): SQL {
  return tag === ''
    ? sql`coalesce(trim(${testRuns.branch}), '') IN ('', ${defaultBranch ?? ''})`
    : sql`trim(${testRuns.branch}) = ${tag}`;
}

/** An `e2e` suite carried forward: its commit, the run coverage of its runs, and whether it is incomplete. */
interface CarriedRuns {
  commit: string;
  runs: RunCoverageFile[][];
  incomplete: boolean;
}

/**
 * The suites the commit lacks, from the newest commit that arrived before it
 * with each, on the commit's branch, then on the default branch: the files
 * whose blob the inventory names. A candidate whose files the inventory names
 * none of gives way to the next. The project's suites are those of its
 * reports, and `e2e` once a run recorded run coverage; an `e2e` suite comes
 * back as the runs of its commit, to be read with their versions.
 */
async function carryForward(
  db: DrizzleDB,
  projectId: number,
  commit: string,
  branch: string,
  defaultBranch: string | null,
  seenAt: Date,
  inventory: ReadonlyMap<string, string>,
  present: string[],
): Promise<{ reports: SuiteInput[]; e2e: CarriedRuns | null }> {
  const have = new Set(present);
  const branches = branch ? [branch, ''] : [''];
  const out: { reports: SuiteInput[]; e2e: CarriedRuns | null } = {
    reports: [],
    e2e: null,
  };
  const known = await db
    .selectDistinct({ suite: coverageReports.suite, kind: coverageReports.kind })
    .from(coverageReports)
    .where(
      and(
        eq(coverageReports.projectId, projectId),
        ne(coverageReports.commit, commit),
        lt(coverageReports.createdAt, seenAt),
      ),
    );
  for (const { suite, kind } of known) {
    if (have.has(suite)) continue;
    have.add(suite);
    search: for (const b of branches) {
      // A report that arrived before the commit's coverage is of a commit that arrived before it.
      const candidates = await db
        .select()
        .from(coverageReports)
        .where(
          and(
            eq(coverageReports.projectId, projectId),
            eq(coverageReports.suite, suite),
            ne(coverageReports.commit, commit),
            eq(coverageReports.branch, b),
            lt(coverageReports.createdAt, seenAt),
          ),
        )
        .orderBy(desc(coverageReports.createdAt), desc(coverageReports.id))
        .limit(CARRY_CANDIDATES);
      for (const source of candidates) {
        const files = carried(
          ((await getReportFiles(db, [source.id])).get(source.id) ?? []).map(reportFileToSuiteFile),
          inventory,
        );
        if (files.length === 0) continue;
        out.reports.push({
          name: suite,
          kind: kind === 'e2e' ? 'e2e' : 'unit',
          files,
          carriedFrom: source.commit,
          carriedFiles: files.length,
          incomplete: !!source.incomplete,
        });
        break search;
      }
    }
  }

  if (have.has(E2E_SUITE)) return out;
  for (const b of branches) {
    const runs = await db
      .select({ commit: testRuns.commit })
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, projectId),
          sql`${testRuns.commit} IS NOT NULL`,
          ne(testRuns.commit, commit),
          lt(testRuns.startTime, seenAt),
          runBranchIs(b, defaultBranch),
          eligibleRunSql('change-coverage'),
          sql`EXISTS (SELECT 1 FROM ${runCoverage} WHERE ${runCoverage.runId} = ${testRuns.id})`,
        ),
      )
      .orderBy(desc(testRuns.startTime), desc(testRuns.id))
      .limit(CARRY_RUNS);
    const commits = [...new Set(runs.map((r) => r.commit!))].slice(0, CARRY_CANDIDATES);
    for (const source of commits) {
      const sourceRuns = await commitRuns(db, projectId, source);
      const files = [
        ...(
          await getRunsCoverageFiles(
            db,
            sourceRuns.map((r) => r.id),
          )
        ).values(),
      ]
        .map((list) => carried(list, inventory))
        .filter((list) => list.length > 0);
      if (files.length === 0) continue;
      out.e2e = { commit: source, runs: files, incomplete: runsIncomplete(sourceRuns) };
      return out;
    }
  }
  return out;
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
 * named areas, replacing what the commit held, and the `coverage_daily` rows
 * of the day the commit arrived, unless a commit that arrived later that day
 * holds them. A computation that started before the one that last wrote the
 * commit's totals writes nothing, and so does one of a commit whose detail
 * was removed: its totals are final. `now` is when the computation starts.
 * Returns the coverage, or null when the commit has none or its totals are
 * final.
 */
export async function storeCommitTotals(
  db: DrizzleDB,
  projectId: number,
  commit: string,
  now: Date = new Date(),
): Promise<CommitCoverage | null> {
  const ofCommit = and(eq(coverageTotals.projectId, projectId), eq(coverageTotals.commit, commit))!;
  const notNewer = or(isNull(coverageTotals.computationStartedAt), lt(coverageTotals.computationStartedAt, now))!;
  if (await commitDetailRemoved(db, projectId, commit)) return null;
  const coverage = await loadCommitCoverage(db, projectId, commit);
  if (!coverage) {
    await db.delete(coverageTotals).where(and(ofCommit, notNewer));
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
    commitSeenAt: coverage.seenAt,
    computationStartedAt: now,
    computedAt: now,
  }));

  const stored = await db.transaction(async (tx) => {
    const [newer] = await tx
      .select({ id: coverageTotals.id })
      .from(coverageTotals)
      .where(and(ofCommit, gt(coverageTotals.computationStartedAt, now)))
      .limit(1);
    if (newer) return false;
    // Totals whose detail went while this computation ran stay as they were.
    const [final] = await tx
      .select({ id: coverageTotals.id })
      .from(coverageTotals)
      .where(and(ofCommit, isNotNull(coverageTotals.detailRemovedAt)))
      .limit(1);
    if (final) return false;
    for (let i = 0; i < rows.length; i += ROW_CHUNK) {
      await tx
        .insert(coverageTotals)
        .values(rows.slice(i, i + ROW_CHUNK))
        .onConflictDoUpdate({
          target: [coverageTotals.projectId, coverageTotals.commit, coverageTotals.suite, coverageTotals.area],
          set: fromExcluded(coverageTotals, [
            'projectId',
            'commit',
            'suite',
            'area',
            'detailRemovedAt',
            'supersededBy',
          ]),
          setWhere: sql`${coverageTotals.computationStartedAt} IS NULL OR excluded.computation_started_at >= ${coverageTotals.computationStartedAt}`,
        });
    }
    // The suites and areas this computation no longer counts.
    await tx.delete(coverageTotals).where(and(ofCommit, notNewer));
    if (coverage.branch === '') {
      // A commit that ran on the default branch keeps its reports when another branch's pull request closes.
      await tx
        .update(coverageReports)
        .set({ branch: '' })
        .where(
          and(
            eq(coverageReports.projectId, projectId),
            eq(coverageReports.commit, commit),
            ne(coverageReports.branch, ''),
          ),
        );
    }
    return true;
  });
  if (stored) await storeCommitDaily(db, projectId, coverage, rows);
  return coverage;
}

/**
 * The set of an upsert that takes every column but the key's from the row it
 * tried to insert.
 */
function fromExcluded(table: typeof coverageTotals | typeof coverageDaily, key: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => name !== 'id' && !key.includes(name))
      .map(([name, column]) => [name, sql.raw(`excluded.${column.name}`)]),
  );
}

/**
 * The commit's rows of `coverage_daily`, on the day it arrived: they replace
 * the day's rows on its branch unless a commit that arrived later holds them.
 */
async function storeCommitDaily(
  db: DrizzleDB,
  projectId: number,
  coverage: CommitCoverage,
  rows: Array<ReturnType<typeof countColumns> & { branch: string; suite: string; area: string; commit: string }>,
): Promise<void> {
  const day = coverage.seenAt.toISOString().slice(0, 10);
  const ofDay = and(
    eq(coverageDaily.projectId, projectId),
    eq(coverageDaily.day, day),
    eq(coverageDaily.branch, coverage.branch),
  )!;
  const now = new Date();
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ seenAt: coverageDaily.commitSeenAt })
      .from(coverageDaily)
      .where(and(ofDay, gt(coverageDaily.commitSeenAt, coverage.seenAt)))
      .limit(1);
    if (owner) return;
    await tx.delete(coverageDaily).where(ofDay);
    for (let i = 0; i < rows.length; i += ROW_CHUNK) {
      await tx
        .insert(coverageDaily)
        .values(
          rows.slice(i, i + ROW_CHUNK).map((row) => ({
            ...countColumns(row),
            projectId,
            day,
            branch: row.branch,
            suite: row.suite,
            area: row.area,
            commit: row.commit,
            commitSeenAt: coverage.seenAt,
            computedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            coverageDaily.projectId,
            coverageDaily.day,
            coverageDaily.branch,
            coverageDaily.suite,
            coverageDaily.area,
          ],
          set: fromExcluded(coverageDaily, ['projectId', 'day', 'branch', 'suite', 'area']),
          setWhere: sql`${coverageDaily.commitSeenAt} IS NULL OR excluded.commit_seen_at >= ${coverageDaily.commitSeenAt}`,
        });
    }
  });
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** The commits whose totals are being computed. */
const computing = new Set<string>();
/** How long a commit's totals wait for more uploads and runs before they are computed. */
export const TOTALS_DELAY_MS = 5000;

/** Whether a commit's totals are waiting to be computed, or being computed, in this process. */
function totalsInFlight(projectId: number, commit: string): boolean {
  const key = `${projectId}\0${commit}`;
  return pending.has(key) || computing.has(key);
}

/**
 * Compute a commit's totals a few seconds from now, once for every upload and
 * run coverage arriving meanwhile: four shards and three suites trigger one
 * computation; `after` runs once they are stored. Off the default branch, the
 * reports superseded on the commit's branch go next, the commit's own when a
 * newer commit's arrived meanwhile. Nothing is computed for a commit whose
 * totals are final. A failure is logged, never thrown.
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
    computing.add(key);
    db()
      .then(async (database) => {
        const coverage = await storeCommitTotals(database, projectId, commit);
        if (!coverage) return;
        try {
          await after?.(database, projectId, commit);
        } finally {
          // The commit's totals are stored: it may supersede an earlier commit, or be superseded already.
          if (coverage.branch !== '') {
            await pruneSupersededReports(database, new Date(), { projectId, branch: coverage.branch, ready: commit });
          }
        }
      })
      .catch((error) => console.error(`[coverage] Could not compute the totals of ${commit}:`, error))
      .finally(() => computing.delete(key));
  }, TOTALS_DELAY_MS);
  timer.unref?.();
  pending.set(key, timer);
}

/** A commit whose detail was removed: when, and the newer commit that superseded it. */
export interface DetailRemoved {
  at: Date;
  supersededBy: string | null;
}

/** When a commit's detail was removed, its totals final from then on; null while its reports are kept. */
export async function commitDetailRemoved(
  db: DrizzleDB,
  projectId: number,
  commit: string,
): Promise<DetailRemoved | null> {
  const [row] = await db
    .select({ at: coverageTotals.detailRemovedAt, supersededBy: coverageTotals.supersededBy })
    .from(coverageTotals)
    .where(
      and(
        eq(coverageTotals.projectId, projectId),
        eq(coverageTotals.commit, commit),
        eq(coverageTotals.suite, COMBINED_SUITE),
        eq(coverageTotals.area, ''),
      ),
    );
  return row?.at ? { at: new Date(row.at), supersededBy: row.supersededBy } : null;
}

/** A commit's final totals, as stored: every suite's and area's row, in the order they were computed. */
export interface FinalCommitTotals extends DetailRemoved {
  commit: string;
  branch: string;
  scopeVersion: number;
  rows: Array<typeof coverageTotals.$inferSelect>;
}

/** The stored totals of a commit whose detail was removed; null while its reports are kept. */
export async function finalCommitTotals(
  db: DrizzleDB,
  projectId: number,
  commit: string,
): Promise<FinalCommitTotals | null> {
  const removed = await commitDetailRemoved(db, projectId, commit);
  if (!removed) return null;
  const rows = await db
    .select()
    .from(coverageTotals)
    .where(and(eq(coverageTotals.projectId, projectId), eq(coverageTotals.commit, commit)))
    .orderBy(coverageTotals.id);
  const combined = rows.find((r) => r.suite === COMBINED_SUITE && r.area === '');
  if (!combined) return null;
  return { ...removed, commit, branch: combined.branch, scopeVersion: combined.scopeVersion, rows };
}

/**
 * Prune the reports newer commits superseded, off the default branch: per
 * project, branch and suite, only the report of the commit whose coverage
 * arrived last stays, the one a later commit carries the suite forward from.
 * A commit that loses a report keeps its totals, marked final with the newest
 * commit that superseded it; one with no totals yet has them computed first,
 * and one whose totals are being computed keeps its reports until the next
 * prune, unless it is `only.ready`, the commit whose computation just stored
 * them. `only` keeps to one project's branch. Returns how many reports went.
 */
export async function pruneSupersededReports(
  db: DrizzleDB,
  now: Date = new Date(),
  only?: { projectId: number; branch: string; ready?: string },
): Promise<number> {
  if (only?.branch === '') return 0;
  const reports = await db
    .select({
      id: coverageReports.id,
      projectId: coverageReports.projectId,
      commit: coverageReports.commit,
      branch: coverageReports.branch,
      suite: coverageReports.suite,
      createdAt: coverageReports.createdAt,
    })
    .from(coverageReports)
    .where(
      only
        ? and(eq(coverageReports.projectId, only.projectId), eq(coverageReports.branch, only.branch))
        : ne(coverageReports.branch, ''),
    );
  if (reports.length < 2) return 0;

  // A commit arrived when its totals say, else with its first report; its first report breaks a tie.
  const commits = new Map<
    string,
    { projectId: number; commit: string; at: number; first: number; totals: boolean; final: boolean }
  >();
  for (const r of reports) {
    const key = `${r.projectId}\0${r.commit}`;
    const at = new Date(r.createdAt).getTime();
    const known = commits.get(key);
    if (known) Object.assign(known, { at: Math.min(known.at, at), first: Math.min(known.first, r.id) });
    else commits.set(key, { projectId: r.projectId, commit: r.commit, at, first: r.id, totals: false, final: false });
  }
  const byProject = new Map<number, string[]>();
  for (const c of commits.values()) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c.commit]);
  for (const [projectId, list] of byProject) {
    for (let i = 0; i < list.length; i += ROW_CHUNK) {
      const kept = await db
        .select({
          commit: coverageTotals.commit,
          seenAt: coverageTotals.commitSeenAt,
          final: coverageTotals.detailRemovedAt,
        })
        .from(coverageTotals)
        .where(
          and(
            eq(coverageTotals.projectId, projectId),
            inArray(coverageTotals.commit, list.slice(i, i + ROW_CHUNK)),
            eq(coverageTotals.suite, COMBINED_SUITE),
            eq(coverageTotals.area, ''),
          ),
        );
      for (const row of kept) {
        const c = commits.get(`${projectId}\0${row.commit}`)!;
        c.totals = true;
        c.final = row.final !== null;
        if (row.seenAt) c.at = new Date(row.seenAt).getTime();
      }
    }
  }

  const arrival = (r: (typeof reports)[number]) => commits.get(`${r.projectId}\0${r.commit}`)!.at;
  // A commit already superseded never supersedes another, whatever a late upload of it brought.
  const later = (a: (typeof reports)[number], b: (typeof reports)[number]) => {
    const [ca, cb] = [commits.get(`${a.projectId}\0${a.commit}`)!, commits.get(`${b.projectId}\0${b.commit}`)!];
    if (ca.final !== cb.final) return cb.final;
    return ca.at !== cb.at ? ca.at > cb.at : ca.first > cb.first;
  };
  const newest = new Map<string, (typeof reports)[number]>();
  for (const r of reports) {
    const key = `${r.projectId}\0${r.branch}\0${r.suite}`;
    const top = newest.get(key);
    if (!top || later(r, top)) newest.set(key, r);
  }
  const superseded = new Map<string, { ids: number[]; by: string; byAt: number }>();
  for (const r of reports) {
    const top = newest.get(`${r.projectId}\0${r.branch}\0${r.suite}`)!;
    if (top.commit === r.commit) continue;
    const key = `${r.projectId}\0${r.commit}`;
    const entry = superseded.get(key) ?? { ids: [], by: top.commit, byAt: arrival(top) };
    entry.ids.push(r.id);
    if (arrival(top) > entry.byAt) Object.assign(entry, { by: top.commit, byAt: arrival(top) });
    superseded.set(key, entry);
  }

  let pruned = 0;
  for (const [key, entry] of superseded) {
    const { projectId, commit, totals } = commits.get(key)!;
    if (commit !== only?.ready && totalsInFlight(projectId, commit)) continue;
    if (!totals) await storeCommitTotals(db, projectId, commit);
    await markDetailRemoved(db, projectId, commit, entry.by, now);
    for (let i = 0; i < entry.ids.length; i += ROW_CHUNK) {
      await db.delete(coverageReports).where(inArray(coverageReports.id, entry.ids.slice(i, i + ROW_CHUNK)));
    }
    pruned += entry.ids.length;
  }
  return pruned;
}

/**
 * What follows an upload or a run coverage of a commit: its totals computed a
 * few seconds later, then `after`. A commit whose totals are final keeps them:
 * a late upload of it (a CI job run again) is pruned again at once. Returns
 * the commit that superseded it, or null when its totals are computed.
 */
export async function settleCommitCoverage<D extends DrizzleDB>(
  db: () => Promise<D>,
  projectId: number,
  commit: string,
  after?: (db: D, projectId: number, commit: string) => Promise<void>,
): Promise<{ by: string | null } | null> {
  const database = await db();
  const removed = await commitDetailRemoved(database, projectId, commit);
  if (!removed) {
    scheduleCommitTotals(db, projectId, commit, after);
    return null;
  }
  const [row] = await database
    .select({ branch: coverageTotals.branch })
    .from(coverageTotals)
    .where(and(eq(coverageTotals.projectId, projectId), eq(coverageTotals.commit, commit)))
    .limit(1);
  if (row && row.branch !== '') await pruneSupersededReports(database, new Date(), { projectId, branch: row.branch });
  return { by: removed.supersededBy };
}

/** The order of commits by arrival, newest first; a commit with no arrival kept goes by when it was computed. */
const newestArrivalFirst = [
  desc(sql`coalesce(${coverageTotals.commitSeenAt}, ${coverageTotals.computedAt})`),
  desc(coverageTotals.id),
];

/** The commit a project's coverage is shown for: the latest to arrive with totals on the branch, else with a report. */
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
        eq(coverageTotals.area, ''),
      ),
    )
    .orderBy(...newestArrivalFirst)
    .limit(1);
  if (totals) return totals.commit;
  const [report] = await db
    .select({ commit: coverageReports.commit })
    .from(coverageReports)
    .where(and(eq(coverageReports.projectId, projectId), eq(coverageReports.branch, branch)))
    .orderBy(desc(coverageReports.createdAt), desc(coverageReports.id))
    .limit(1);
  return report?.commit ?? null;
}

/** Commits recounted at most after a change of the project's coverage scope or areas. */
const MAX_RECOUNTED_COMMITS = 200;

/**
 * The project's commits whose totals were computed under another version of
 * its coverage scope and areas, and are not final: the default branch's
 * first, then by arrival, the latest first, at most `limit`.
 */
export async function staleCoverageCommits(
  db: DrizzleDB,
  projectId: number,
  limit: number = MAX_RECOUNTED_COMMITS,
): Promise<string[]> {
  const { version } = await projectScope(db, projectId);
  const rows = await db
    .select({ commit: coverageTotals.commit })
    .from(coverageTotals)
    .where(
      and(
        eq(coverageTotals.projectId, projectId),
        eq(coverageTotals.suite, COMBINED_SUITE),
        eq(coverageTotals.area, ''),
        ne(coverageTotals.scopeVersion, version),
        isNull(coverageTotals.detailRemovedAt),
      ),
    )
    .orderBy(sql`CASE WHEN ${coverageTotals.branch} = '' THEN 0 ELSE 1 END`, ...newestArrivalFirst)
    .limit(limit);
  return rows.map((r) => r.commit);
}

const recounts = new Map<number, { again: boolean }>();

/**
 * Recount, one after the other, the project's commits whose totals are
 * stale ({@link staleCoverageCommits}). A call while a recount of the project
 * runs makes it look again once done. A commit that fails is logged and
 * skipped.
 */
export async function recountStaleCommits(db: DrizzleDB, projectId: number): Promise<void> {
  const running = recounts.get(projectId);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: false };
  recounts.set(projectId, state);
  try {
    do {
      state.again = false;
      for (const commit of await staleCoverageCommits(db, projectId)) {
        await storeCommitTotals(db, projectId, commit).catch((error) =>
          console.error(`[coverage] Could not recount the totals of ${commit}:`, error),
        );
      }
    } while (state.again);
  } finally {
    recounts.delete(projectId);
  }
}
