/**
 * A commit's combined coverage as the API, the coverage page and the MCP tool
 * read it: the totals of every suite together and of each suite, the files
 * without coverage data, and one folder's breakdown. Computed from the stored
 * reports and run coverage on read, and kept a minute per commit unless an
 * upload or a run coverage of the commit arrives.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { CoverageScope } from '@piwitests/core/coverage-scope';
import { runCoverage, testRuns } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import {
  coveragePercent,
  folderBreakdown,
  type CombinedFile,
  type CoverageCounts,
  type CoverageSuiteKind,
  type FolderEntry,
} from '#shared/coverage-combine';
import { eligibleRunSql } from '#shared/run-eligibility';
import { latestCoverageCommit, loadCommitCoverage, type CommitCoverage } from './coverage-totals';
import { locatorBranchTag } from './locator-usages';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** Paths of files without coverage data an answer lists at most. */
const MAX_LISTED_PATHS = 100;
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
  /** The folder broken down ('' for the repository root) and its direct children. */
  folder: string;
  entries: Array<FolderEntry & CoverageRatios>;
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
}

const COMMIT = /^[0-9a-f]{7,64}$/;

/** The `commit`, `branch` and `folder` of a summary read, checked. */
export function parseCoverageSummaryQuery(
  commit: unknown,
  branch: unknown,
  folder: unknown,
  file?: unknown,
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
  return { commit: sha || null, branch: name || null, folder: dir, ...(path ? { file: path } : {}) };
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
  let commit = query.commit;
  if (!commit) {
    const tag = locatorBranchTag(query.branch, await projectDefaultBranch(db, projectId));
    commit = (await latestCoverageCommit(db, projectId, tag)) ?? (await latestRunCommit(db, projectId, tag));
  }
  if (!commit) return null;
  const coverage = await cachedCommitCoverage(db, projectId, commit);
  if (!coverage) return null;
  const { combined } = coverage;
  return {
    commit: coverage.commit,
    branch: coverage.branch || null,
    scope: coverage.scope,
    totals: ratios(combined.totals),
    suites: combined.suites.map((s) => ratios(s)),
    filesWithoutData: {
      count: combined.filesWithoutData?.length ?? null,
      paths: (combined.filesWithoutData ?? [])
        .filter((p) => !query.folder || p.startsWith(`${query.folder}/`))
        .slice(0, MAX_LISTED_PATHS),
    },
    filesReferencedByReports: combined.filesReferencedByReports,
    folder: query.folder,
    entries: folderBreakdown(combined.files, query.folder).map((e) => ratios(e)),
    ...(query.file ? { file: combined.files.find((f) => f.path === query.file) ?? null } : {}),
  };
}
