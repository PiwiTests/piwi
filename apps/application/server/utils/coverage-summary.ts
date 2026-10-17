/**
 * A commit's combined coverage as the API, the coverage page and the MCP tool
 * read it: the totals of every suite together and of each suite, the files
 * without coverage data, and one folder's breakdown. Computed from the stored
 * reports and run coverage on read, and kept a minute per commit unless an
 * upload or a run coverage of the commit arrives.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { CoverageScope } from '@piwitests/core/coverage-scope';
import { writeCobertura, writeLcov } from '@piwitests/core/coverage-writers';
import { runCoverage, testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import {
  areaCoverage,
  coveragePercent,
  coverageTreeLevel,
  folderBreakdown,
  leastCoveredFiles,
  type TreeEntry,
  type CombinedFile,
  type CoverageCounts,
  type CoverageSuiteKind,
  type FolderEntry,
} from '#shared/coverage-combine';
import { eligibleRunSql } from '#shared/run-eligibility';
import { latestCoverageCommit, loadCommitCoverage, scheduleCommitTotals, type CommitCoverage } from './coverage-totals';
import { locatorBranchTag } from './locator-usages';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** Paths of files without coverage data an answer lists at most. */
const MAX_LISTED_PATHS = 100;
/** Files the least-covered list names at most. */
const LEAST_COVERED_FILES = 20;
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 50;

/** Counts with their ratios. */
export interface CoverageRatios extends CoverageCounts {
  /** Executed lines over executable lines, a percentage with one decimal; null without executable lines. */
  linePercent: number | null;
  /** Run functions over known functions. */
  functionPercent: number | null;
  /** Undetermined lines over executable lines. */
  undeterminedPercent: number | null;
}

/** A project's combined coverage at one commit. */
export interface CoverageSummary {
  commit: string;
  /** The branch the commit's coverage ran on; null for the default branch. */
  branch: string | null;
  scope: CoverageScope;
  totals: CoverageRatios;
  suites: Array<
    CoverageRatios & {
      name: string;
      kind: CoverageSuiteKind;
      carriedFrom: string | null;
      carriedFiles: number;
      incomplete: boolean;
    }
  >;
  /** Files of the commit's inventory in scope no suite names: their count (null without an inventory) and the first 100. */
  filesWithoutData: { count: number | null; paths: string[] };
  /** Files whose reference lines are a report's, no run having recorded the span table of their version. */
  filesReferencedByReports: number;
  /** The project's named areas: each one's totals and each suite's share of its lines. */
  areas: Array<
    CoverageRatios & { name: string; suites: Array<CoverageRatios & { name: string; kind: CoverageSuiteKind }> }
  >;
  /** The area the breakdown, the least-covered files and the files without data keep to; null for every file. */
  area: string | null;
  /** The folder broken down ('' for the repository root) and its direct children. */
  folder: string;
  /** The folder's own totals, in the area when one is given, and each suite's share of its lines. */
  folderTotals: CoverageRatios & {
    unrunLines: number;
    suites: Array<CoverageRatios & { name: string; kind: CoverageSuiteKind }>;
  };
  entries: Array<FolderEntry & CoverageRatios>;
  /** The folder's files with the most lines no suite ran, the most first, at most 20. */
  leastCovered: Array<FolderEntry & CoverageRatios & { unrunLines: number }>;
  /** With `file`, that file's lines: their classes and the lines each suite ran; null when no suite names it. */
  file?: CombinedFile | null;
}

function ratios<T extends CoverageCounts>(counts: T): T & CoverageRatios {
  return {
    ...counts,
    linePercent: coveragePercent(counts.executedLines, counts.executableLines),
    functionPercent: coveragePercent(counts.runFunctions, counts.knownFunctions),
    undeterminedPercent: coveragePercent(counts.undeterminedLines, counts.executableLines),
  };
}

const cache = new Map<string, { at: number; coverage: Promise<CommitCoverage | null> }>();

/** Forget a commit's cached coverage, as an upload or a run coverage of it arrives. */
export function invalidateCommitCoverage(projectId: number, commit: string | null | undefined): void {
  if (commit) cache.delete(`${projectId}\0${commit}`);
}

/**
 * After a change of the project's coverage scope or areas: forget its cached
 * coverage, and recount its newest commit with coverage on the default branch
 * a few seconds from now, so the stored totals and the trend follow.
 */
export async function recountProjectCoverage(db: DrizzleDB, projectId: number): Promise<void> {
  for (const key of [...cache.keys()]) if (key.startsWith(`${projectId}\0`)) cache.delete(key);
  const commit = await latestCoverageCommit(db, projectId, '');
  if (commit) scheduleCommitTotals(async () => db, projectId, commit);
}

/** A commit's coverage, from the cache when computed within the last minute. */
export function cachedCommitCoverage(db: DrizzleDB, projectId: number, commit: string): Promise<CommitCoverage | null> {
  const key = `${projectId}\0${commit}`;
  const known = cache.get(key);
  if (known && Date.now() - known.at < CACHE_MS) return known.coverage;
  const coverage = loadCommitCoverage(db, projectId, commit);
  cache.set(key, { at: Date.now(), coverage });
  coverage.catch(() => cache.delete(key));
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return coverage;
}

/** The newest complete run with run coverage on a branch tag, for a project whose runs alone record coverage. */
async function latestRunCommit(db: DrizzleDB, projectId: number, tag: string): Promise<string | null> {
  const defaultBranch = await projectDefaultBranch(db, projectId);
  const runs = await db
    .select({ commit: testRuns.commit, branch: testRuns.branch })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        sql`${testRuns.commit} IS NOT NULL`,
        eligibleRunSql('change-coverage'),
        sql`EXISTS (SELECT 1 FROM ${runCoverage} WHERE ${runCoverage.runId} = ${testRuns.id})`,
      ),
    )
    .orderBy(desc(testRuns.startTime), desc(testRuns.id))
    .limit(50);
  return runs.find((r) => locatorBranchTag(r.branch, defaultBranch) === tag)?.commit ?? null;
}

/** The query of a summary: a commit, else the newest on a branch (the default branch when none), and a folder. */
export interface CoverageSummaryQuery {
  commit: string | null;
  branch: string | null;
  folder: string;
  /** A repository-relative file whose lines to add. */
  file?: string | null;
  /** A named area the folder's breakdown keeps to. */
  area?: string | null;
}

const COMMIT = /^[0-9a-f]{7,64}$/;

/** The `commit`, `branch`, `folder`, `file` and `area` of a summary read, checked. */
export function parseCoverageSummaryQuery(
  commit: unknown,
  branch: unknown,
  folder: unknown,
  file?: unknown,
  area?: unknown,
): CoverageSummaryQuery | { error: string } {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const text = (value: unknown) => (typeof first(value) === 'string' ? (first(value) as string).trim() : '');
  const sha = text(commit).toLowerCase();
  if (sha && !COMMIT.test(sha)) return { error: 'commit must be 7 to 64 hexadecimal characters' };
  const name = text(branch);
  if (name.length > 255) return { error: 'branch is at most 255 characters' };
  const dir = text(folder).replace(/^\/+|\/+$/g, '');
  if (dir.length > 500 || dir.split('/').includes('..'))
    return { error: 'folder must be a repository-relative folder' };
  const path = text(file).replace(/^\/+/, '');
  if (path.length > 500 || path.split('/').includes('..')) return { error: 'file must be a repository-relative path' };
  const areaName = text(area);
  if (areaName.length > 40) return { error: 'area is at most 40 characters' };
  return {
    commit: sha || null,
    branch: name || null,
    folder: dir,
    ...(path ? { file: path } : {}),
    ...(areaName ? { area: areaName } : {}),
  };
}

/** The coverage of the query's commit, else of the newest commit with coverage on its branch. */
async function queriedCommitCoverage(
  db: DrizzleDB,
  projectId: number,
  query: Pick<CoverageSummaryQuery, 'commit' | 'branch'>,
): Promise<CommitCoverage | null> {
  let commit = query.commit;
  if (!commit) {
    const tag = locatorBranchTag(query.branch, await projectDefaultBranch(db, projectId));
    commit = (await latestCoverageCommit(db, projectId, tag)) ?? (await latestRunCommit(db, projectId, tag));
  }
  return commit ? cachedCommitCoverage(db, projectId, commit) : null;
}

/** The formats a commit's combined coverage is exported in. */
export type CoverageExportFormat = 'lcov' | 'cobertura';

/** The `format` of an export, checked: `lcov` when absent. */
export function parseCoverageExportFormat(format: unknown): CoverageExportFormat | { error: string } {
  const value = (Array.isArray(format) ? format[0] : format) ?? 'lcov';
  if (value === 'lcov' || value === 'cobertura') return value;
  return { error: 'format must be lcov or cobertura' };
}

/** An exported report, ready to send. */
export interface CoverageExport {
  commit: string;
  filename: string;
  contentType: string;
  body: string;
}

/**
 * A commit's combined coverage as an LCOV tracefile or a Cobertura report:
 * per file, its reference lines, hit when any suite ran them, and its
 * functions. Null when the commit has no coverage.
 */
export async function exportCommitCoverage(
  db: DrizzleDB,
  projectId: number,
  query: Pick<CoverageSummaryQuery, 'commit' | 'branch'>,
  format: CoverageExportFormat,
): Promise<CoverageExport | null> {
  const coverage = await queriedCommitCoverage(db, projectId, query);
  if (!coverage) return null;
  const files = coverage.combined.files.map((f) => ({
    path: f.path,
    executable: f.executable,
    lines: f.executed,
    allFunctions: f.knownFunctions,
    functions: f.runFunctions,
  }));
  const name = `piwi-coverage-${coverage.commit.slice(0, 12)}`;
  return format === 'lcov'
    ? {
        commit: coverage.commit,
        filename: `${name}.info`,
        contentType: 'text/plain; charset=utf-8',
        body: writeLcov(files),
      }
    : {
        commit: coverage.commit,
        filename: `${name}.xml`,
        contentType: 'application/xml; charset=utf-8',
        body: writeCobertura(files, Date.now() / 1000),
      };
}

/** A folder's totals over `files` ('' for every file), and each suite's share of its lines. */
function folderTotalsOf(
  files: CommitCoverage['combined']['files'],
  suites: CommitCoverage['combined']['suites'],
  folder: string,
): CoverageSummary['folderTotals'] {
  const prefix = folder ? `${folder}/` : '';
  const [totals] = areaCoverage({ files, suites }, ['folder'], (path) => (path.startsWith(prefix) ? 'folder' : null));
  return {
    ...ratios(totals!.totals),
    unrunLines: totals!.totals.executableLines - totals!.totals.executedLines - totals!.totals.undeterminedLines,
    suites: totals!.suites.map((s) => ({ ...ratios(s), name: s.name, kind: s.kind })),
  };
}

/** One level of a commit's coverage tree: the children of a folder, in the area when one is given. */
export interface CoverageTree {
  commit: string;
  folder: string;
  area: string | null;
  entries: Array<TreeEntry & CoverageRatios>;
}

/**
 * The children of a folder in the coverage tree, each with its counts, its
 * lines no suite ran and its files without data, at a commit (or the newest
 * with coverage on the branch). Null when there is no coverage.
 */
export async function getCoverageTree(
  db: DrizzleDB,
  projectId: number,
  query: CoverageSummaryQuery,
): Promise<CoverageTree | null> {
  const coverage = await queriedCommitCoverage(db, projectId, query);
  if (!coverage) return null;
  const area = query.area && coverage.areas.some((a) => a.name === query.area) ? query.area : null;
  const inArea = (path: string) => area === null || coverage.areaOf(path) === area;
  const files = coverage.combined.files.filter((f) => inArea(f.path));
  const withoutData = (coverage.combined.filesWithoutData ?? []).filter(inArea);
  return {
    commit: coverage.commit,
    folder: query.folder,
    area,
    entries: coverageTreeLevel(files, withoutData, query.folder).map((e) => ratios(e)),
  };
}

/**
 * A project's combined coverage at a commit, or at the newest commit with
 * coverage on the branch. Null when there is none.
 */
export async function getCoverageSummary(
  db: DrizzleDB,
  projectId: number,
  query: CoverageSummaryQuery,
): Promise<CoverageSummary | null> {
  const coverage = await queriedCommitCoverage(db, projectId, query);
  if (!coverage) return null;
  const { combined } = coverage;
  const area = query.area && coverage.areas.some((a) => a.name === query.area) ? query.area : null;
  const inArea = (path: string) => area === null || coverage.areaOf(path) === area;
  const files = area === null ? combined.files : combined.files.filter((f) => inArea(f.path));
  return {
    commit: coverage.commit,
    branch: coverage.branch || null,
    scope: coverage.scope,
    totals: ratios(combined.totals),
    suites: combined.suites.map((s) => ratios(s)),
    filesWithoutData: {
      count: combined.filesWithoutData?.length ?? null,
      paths: (combined.filesWithoutData ?? [])
        .filter((p) => (!query.folder || p.startsWith(`${query.folder}/`)) && inArea(p))
        .slice(0, MAX_LISTED_PATHS),
    },
    filesReferencedByReports: combined.filesReferencedByReports,
    areas: coverage.areas.map((a) => ({
      ...ratios(a.totals),
      name: a.name,
      suites: a.suites.map((s) => ({ ...ratios(s), name: s.name, kind: s.kind })),
    })),
    area,
    folder: query.folder,
    folderTotals: folderTotalsOf(files, combined.suites, query.folder),
    entries: folderBreakdown(files, query.folder).map((e) => ratios(e)),
    leastCovered: leastCoveredFiles(files, query.folder, LEAST_COVERED_FILES).map((e) => ratios(e)),
    ...(query.file ? { file: combined.files.find((f) => f.path === query.file) ?? null } : {}),
  };
}
