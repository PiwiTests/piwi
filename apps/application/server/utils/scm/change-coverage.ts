/**
 * Change coverage at finish time — resolve the diff between the run-baseline
 * ladder's commit and the run's commit, join the changed files to observed
 * reach, persist `changes` edges and changed-unreached gaps, and hand the pull
 * request comment its "Uncovered changes" section.
 *
 * Everything here is best-effort: a run with no repository, no baseline commit
 * or no SCM token yields no section and no gaps, never an error.
 */

import { desc, eq } from 'drizzle-orm';
import { projects, testRuns, failureClusters } from '../../database/schema';
import type { DbClient } from '../../database';
import type { RunMetadata } from '../run-json-types';
import { normalizeGitUrl, FALLBACK_DEFAULT_BRANCH } from './git-url';
import { resolveRunBranch } from '../run-branch';
import { resolveDefaultBranch } from './default-branch';
import { resolveFallbackBranch } from '#shared/handlers/baseline-scope';
import { selectBaselineRun } from '../branch-baseline';
import { createScmProvider } from './index';
import { MAX_SCM_FILES } from './ScmProvider';
import type { ScmChanges, ScmProvider } from './ScmProvider';
import {
  computeChangeCoverage,
  extractTicketIds,
  ticketPrefix,
  type ChangeCoverage,
  type ChangedFileInput,
  type CommitCoverageInput,
} from '#shared/handlers/change-coverage';
import { patchChangedLines } from '#shared/patch-coverage';
import { cachedCommitCoverage } from '../coverage-summary';
import { readProjectIntegration } from '../integrations/binding';
import {
  detectChangedUnreached,
  rankGap,
  upsertScenarioGaps,
  type ChangedFileReach,
  type ExposureInputs,
  type FileExposure,
} from '#shared/handlers/scenario-gaps';
import { ingestChangesEdges, deleteBranchGraphRows, ingestImportEdges } from '../graph-ingest';
import { deleteBranchCoverageRows } from '../coverage';
import { loadMutedDetectors } from '#shared/handlers/detector-precision';
import { extractImports, type ImportPair } from '#shared/graph';
import type { PrChangeCoverage, PrLocatorBreaks } from '#shared/pr-feedback';
import {
  loadRanTestCaseIds,
  predictPatchBreaks,
  storeRunLocatorBreaks,
  toPrLocatorBreaks,
  toRunLocatorBreak,
  type PatchedFile,
} from '#shared/handlers/locator-breaks';
import { getLocatorIndex } from '../locator-usages';

/** Recent commits scanned per run to estimate churn, age and escape history. */
const CHURN_COMMIT_SCAN = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;

/**
 * Exposure cache, so the finish path and the comment share one commit scan. Keyed
 * by project, head commit and the file set, and bounded with least-recently-used
 * eviction so it cannot grow without limit or serve one project's scan to another.
 */
const EXPOSURE_CACHE_MAX = 128;
const exposureCache = new Map<string, Map<string, FileExposure>>();

function exposureCacheKey(projectId: number, headSha: string, files: string[]): string {
  return `${projectId}\x00${headSha}\x00${[...files].sort().join('\n')}`;
}

function exposureCacheGet(key: string): Map<string, FileExposure> | undefined {
  const value = exposureCache.get(key);
  if (value) {
    // Touch: move to most-recently-used.
    exposureCache.delete(key);
    exposureCache.set(key, value);
  }
  return value;
}

function exposureCacheSet(key: string, value: Map<string, FileExposure>): void {
  exposureCache.set(key, value);
  while (exposureCache.size > EXPOSURE_CACHE_MAX) {
    const oldest = exposureCache.keys().next().value;
    if (oldest === undefined) break;
    exposureCache.delete(oldest);
  }
}

export interface RunChangeCoverage {
  coverage: ChangeCoverage;
  /** Null when the changed-unreached detector muted itself: rows are still persisted, but the pull-request section is withheld. */
  pr: PrChangeCoverage | null;
  /** The locators the diff breaks that this run did not exercise; null when the patches were not available. */
  locatorBreaks: PrLocatorBreaks | null;
}

/**
 * Predict the locators the diff breaks, against the locator index of the
 * branch the change is compared with, and store them on the run for locator
 * healing. Returns the comment's section; null when the provider sent no
 * patches or the index is empty.
 */
async function computeRunLocatorBreaks(
  db: DbClient,
  run: { id: number; projectId: number },
  files: PatchedFile[],
  baseBranch: string | null,
): Promise<PrLocatorBreaks | null> {
  if (!files.some((f) => f.patch)) return null;
  const index = await getLocatorIndex(db, run.projectId, { branch: baseBranch });
  if (!index || index.locators.length === 0) return null;
  const breaks = predictPatchBreaks(files, index).map(toRunLocatorBreak);
  await storeRunLocatorBreaks(db, run.id, run.projectId, breaks);
  return toPrLocatorBreaks(breaks, await loadRanTestCaseIds(db, run.id), baseBranch);
}

/** Two repo-relative paths match when equal or one is a path-suffix of the other. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
}

/**
 * Estimate per-file churn (commits in ~90 days), age (oldest scanned commit) and
 * escape history (a commit that also fixed a failure cluster), from a bounded
 * scan of recent commits. Cached per head commit.
 */
async function computeFileExposure(
  db: DbClient,
  projectId: number,
  provider: ScmProvider,
  headSha: string,
  baseBranch: string | null,
  files: string[],
): Promise<ExposureInputs> {
  const cacheKey = exposureCacheKey(projectId, headSha, files);
  const cached = exposureCacheGet(cacheKey);
  if (cached) return { files: cached };

  const fixCommits = new Set<string>();
  const clusters = await db
    .select({ fixCommit: failureClusters.fixCommit })
    .from(failureClusters)
    .where(eq(failureClusters.projectId, projectId));
  for (const c of clusters) if (c.fixCommit) fixCommits.add(c.fixCommit);

  const perFile = new Map<string, FileExposure>();
  try {
    const commits = await provider.listCommits(CHURN_COMMIT_SCAN, baseBranch ?? undefined);
    const now = Date.now();
    for (const commit of commits) {
      const when = Date.parse(commit.date);
      if (Number.isFinite(when) && now - when > NINETY_DAYS_MS) continue;
      const diff = await provider.fetchCommitDiff(commit.sha);
      if (!diff) continue;
      const isFix = fixCommits.has(commit.sha);
      for (const changed of diff.files) {
        for (const file of files) {
          if (!pathsMatch(changed.filename, file)) continue;
          const fx = perFile.get(file) ?? { churn: 0, ageDays: 0, escaped: false };
          fx.churn = (fx.churn ?? 0) + 1;
          if (Number.isFinite(when)) fx.ageDays = Math.max(fx.ageDays ?? 0, Math.round((now - when) / DAY_MS));
          if (isFix) fx.escaped = true;
          perFile.set(file, fx);
        }
      }
    }
  } catch {
    // Rate limit or a token-less repo — exposure degrades to the neutral floor.
  }

  exposureCacheSet(cacheKey, perFile);
  return { files: perFile };
}

/** Commits scanned to attach each changed file to the ticket that changed it. */
const FILE_TICKET_COMMIT_SCAN = 20;

/** A repo-relative path normalized for suffix matching. */
function normalizeTicketPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Map each changed file to the ticket named in the commit that changed it, so a
 * pull request touching several tickets attributes files individually rather
 * than lumping them all under the first id. A bounded per-commit diff scan,
 * best-effort — an unresolved file falls back to the primary ticket. Only worth
 * running when more than one ticket is in play.
 */
async function buildFileTickets(
  provider: ScmProvider,
  commits: Array<{ sha: string; message: string }>,
  ticketKey: string | null,
): Promise<Record<string, string>> {
  const fileTickets: Record<string, string> = {};
  for (const commit of commits.slice(0, FILE_TICKET_COMMIT_SCAN)) {
    const ids = extractTicketIds([commit.message], { ticketKey });
    if (ids.length === 0) continue;
    const ticket = ticketKey ? (ids.find((t) => ticketPrefix(t) === ticketKey.toUpperCase()) ?? ids[0]!) : ids[0]!;
    const diff = await provider.fetchCommitDiff(commit.sha).catch(() => null);
    if (!diff) continue;
    for (const f of diff.files) {
      const path = normalizeTicketPath(f.filename);
      // First commit that names a ticket wins, so the earliest attribution holds.
      if (path && !(path in fileTickets)) fileTickets[path] = ticket;
    }
  }
  return fileTickets;
}

/**
 * A shallow one-level import scan at the run's ref: for each changed file no test
 * reached, resolve its relative imports against the repository tree and record an
 * `imports` edge from the changed file to each file it imports, so an unreached
 * changed file is still connected into the graph through its own dependencies.
 * Capped by the SCM file budget; best-effort — a token-less or failing fetch
 * yields no edges.
 */
async function scanImportEdges(provider: ScmProvider, ref: string, unreachedFiles: string[]): Promise<ImportPair[]> {
  if (unreachedFiles.length === 0) return [];
  const tree = await provider.fetchTree(ref).catch(() => null);
  if (!tree || tree.length === 0) return [];
  const knownFiles = new Set(tree.map((p) => p.replace(/\\/g, '/')));
  const pairs: ImportPair[] = [];
  for (const file of unreachedFiles.slice(0, MAX_SCM_FILES)) {
    const content = await provider.fetchFileAtRef(file, ref).catch(() => null);
    if (!content?.content) continue;
    for (const to of extractImports(file, content.content, knownFiles)) {
      pairs.push({ from: file, to });
    }
  }
  return pairs;
}

/** The changed files of a diff, each with its changed lines when the provider sent its patch. */
function toChangedFiles(changes: ScmChanges): ChangedFileInput[] {
  return changes.files.map((f) => ({
    filePath: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    ...(!changes.patchesOmitted && f.patch && f.status !== 'removed' && f.status !== 'deleted'
      ? { changedLines: patchChangedLines(f.filename, f.patch) }
      : {}),
  }));
}

/** The head commit's combined coverage, as change coverage reads it; null when it has none. */
async function headCommitCoverage(
  db: DbClient,
  projectId: number,
  headSha: string,
): Promise<CommitCoverageInput | null> {
  const coverage = await cachedCommitCoverage(db, projectId, headSha).catch((e) => {
    console.error(`[change-coverage] could not read the coverage of ${headSha}`, e);
    return null;
  });
  if (!coverage) return null;
  return { commit: coverage.commit, files: coverage.combined.files, suites: coverage.combined.suites };
}

/** A generic, honest draft suggestion for an uncovered changed file. */
function draftTitleFor(filePath: string): string {
  const base = filePath.split('/').pop() || filePath;
  return `a scenario that exercises ${base}`;
}

/**
 * The ref a run's diff is taken against: for a pull-request run, its base branch
 * (the provider's compare then gives the merge-base … head diff — the whole PR);
 * otherwise the commit of the last passing run on the same branch. Returns null
 * when neither is available.
 */
async function resolveDiffBase(
  db: DbClient,
  run: { projectId: number; startTime: Date; environment: string | null },
  meta: RunMetadata | null,
  branch: string | null,
  fallbackBranch: string,
  prNumber: number | null,
): Promise<string | null> {
  if (prNumber != null) return fallbackBranch || null;
  const baseline = await selectBaselineRun(db, {
    projectId: run.projectId,
    before: run.startTime,
    branch,
    environment: run.environment ?? null,
    fallbackBranch,
  });
  return ((baseline?.run.metadata as RunMetadata | null)?.scm?.commit ?? null)?.trim() || null;
}

/**
 * Compute change coverage for a finished, pull-request-stamped run: resolve the
 * diff, persist `changes` edges and changed-unreached gaps, and return the data
 * the comment renders. Returns null when there is no diff to report.
 */
export async function computeRunChangeCoverage(db: DbClient, runId: number): Promise<RunChangeCoverage | null> {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return null;

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const headSha = meta?.scm?.commit?.trim() || null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  const prNumberRaw = meta?.scm?.prNumber;
  const prNumber = prNumberRaw != null && Number.isFinite(Number(prNumberRaw)) ? Number(prNumberRaw) : null;
  if (!headSha || !repositoryUrl) return null;

  const [project] = await db
    .select({ id: projects.id, name: projects.name, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  if (!project) return null;

  const branch = run.branch ?? resolveRunBranch(meta);
  const defaultBranch = await resolveDefaultBranch(db, project, meta).catch(() => FALLBACK_DEFAULT_BRANCH);
  const fallback = resolveFallbackBranch(meta, defaultBranch);

  // A pull request is diffed against its base branch (merge-base … head) so every
  // push reports the whole PR, not only its latest commits — the comment, edited
  // in place, then never drops a file an earlier push introduced. A run that is
  // not a pull request keeps the baseline-run comparison (what changed since the
  // last green run on its branch).
  const baseRef = await resolveDiffBase(db, run, meta, branch, fallback.branch, prNumber);
  if (!baseRef || baseRef === headSha) return null;

  const provider = await createScmProvider(repositoryUrl, db, run.projectId);
  if (!provider) return null;

  const changes = await provider.fetchChanges(baseRef, headSha).catch(() => null);
  if (!changes || changes.files.length === 0) return null;
  const baseSha = baseRef;

  const changedFiles = toChangedFiles(changes);

  const ticketKey = (await readProjectIntegration(db, run.projectId).catch(() => null))?.projectKey ?? null;
  const tickets = extractTicketIds(
    [branch, fallback.branch, ...changes.commits.map((c) => c.message), prNumber != null ? `#${prNumber}` : null],
    { ticketKey },
  );

  // Attribute files to the ticket that changed them only when several are in play.
  const fileTickets =
    tickets.length > 1 ? await buildFileTickets(provider, changes.commits, ticketKey).catch(() => ({})) : {};

  const coverage = await computeChangeCoverage(db, run.projectId, {
    changedFiles,
    runId,
    baseSha,
    headSha,
    baseBranch: fallback.branch,
    tickets,
    ticketKey,
    fileTickets,
    filesTruncated: changes.filesTruncated ?? false,
    totalChangedFiles: changes.totalChangedFiles ?? null,
    scmAvailable: true,
    commitCoverage: await headCommitCoverage(db, run.projectId, headSha),
  });

  // A run off the default branch tags its rows with its own branch; a
  // default-branch run writes canonical rows (branch null).
  const branchTag = branch && branch !== defaultBranch ? branch : null;

  // Persist the `changes` edges: the head commit and every ticket → each file.
  await ingestChangesEdges(
    db,
    run.projectId,
    runId,
    headSha,
    tickets,
    changedFiles.map((f) => f.filePath),
    { branch: branchTag, baseSha },
  ).catch(() => {});

  // When the SCM flow can see the pull request has closed or merged, drop this
  // branch's tagged rows now instead of waiting for the thirty-day sweep, so its
  // surface, code reach and coverage stop shadowing the default branch.
  if (branchTag && prNumber != null) {
    await provider
      .fetchPullRequest(prNumber)
      .then(async (pr) => {
        if (pr && (pr.state === 'closed' || pr.state === 'merged')) {
          return (
            (await deleteBranchGraphRows(db, run.projectId, branchTag)) +
            (await deleteBranchCoverageRows(db, run.projectId, branchTag))
          );
        }
        return 0;
      })
      .catch(() => 0);
  }

  // Rank and persist the changed-unreached gaps.
  const exposure = await computeFileExposure(
    db,
    run.projectId,
    provider,
    headSha,
    fallback.branch,
    changedFiles.map((f) => f.filePath),
  );
  const reaches: ChangedFileReach[] = coverage.files.map((f) => ({
    filePath: f.filePath,
    additions: f.additions,
    deletions: f.deletions,
    reachedInRun: f.reachedInRun,
    reachedCountHistory: f.reachedCountHistory,
    reachBasis: f.reachBasis,
    suites: f.suites,
    ticket: f.ticket,
  }));
  // A muted detector keeps writing its ledger rows — so it still collects triage
  // verdicts on the Gaps tab and can climb back above the threshold — but drops
  // out of the pull-request comment (see the return below).
  const muted = await loadMutedDetectors(db, run.projectId).catch(() => new Set<string>());
  const gaps = detectChangedUnreached(reaches, runId, coverage.windowRuns).map((g) => rankGap(g, exposure));
  await upsertScenarioGaps(db, run.projectId, gaps, { runId, prNumber }).catch(() => {});

  // Import edges for the changed files no test reached, from a shallow scan at the
  // run's ref — so an unreached file still connects to the files that import it.
  const unreached = coverage.files.filter((f) => !f.reachedInRun && f.reachedCountHistory === 0).map((f) => f.filePath);
  const importPairs = await scanImportEdges(provider, headSha, unreached).catch(() => []);
  await ingestImportEdges(db, run.projectId, runId, importPairs, { branch: branchTag }).catch(() => {});

  const locatorBreaks = changes.patchesOmitted
    ? null
    : await computeRunLocatorBreaks(db, { id: runId, projectId: run.projectId }, changes.files, fallback.branch).catch(
        (e) => {
          console.error('[locator-breaks] prediction failed', e);
          return null;
        },
      );

  // Withhold the pull-request "Uncovered changes" section when its detector is
  // muted; the rows are already persisted above so the detector can still recover.
  return { coverage, pr: muted.has('changed-unreached') ? null : toPrChangeCoverage(coverage), locatorBreaks };
}

/**
 * Read change coverage on demand for the API, without persisting anything.
 * `?run=` diffs a run against its baseline; `?base=&head=` diffs an explicit
 * range, resolving the repository from the project's most recent run.
 */
export async function readChangeCoverage(
  db: DbClient,
  projectId: number,
  query: { runId?: number | null; baseSha?: string | null; headSha?: string | null },
): Promise<ChangeCoverage> {
  const empty = (scmAvailable: boolean): ChangeCoverage => ({
    runId: query.runId ?? null,
    baseSha: query.baseSha ?? null,
    headSha: query.headSha ?? null,
    baseBranch: null,
    windowRuns: 30,
    files: [],
    tickets: [],
    reachedFiles: 0,
    uncoveredFiles: 0,
    patchCoverage: null,
    filesTruncated: false,
    totalChangedFiles: null,
    scmAvailable,
  });

  let repositoryUrl: string | null = null;
  let baseSha = query.baseSha ?? null;
  let headSha = query.headSha ?? null;
  let baseBranch: string | null = null;
  let runId = query.runId ?? null;

  if (runId != null) {
    const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
    if (!run || run.projectId !== projectId) return empty(false);
    const meta = (run.metadata as RunMetadata | null) ?? null;
    headSha = meta?.scm?.commit?.trim() || null;
    repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
    const branch = run.branch ?? resolveRunBranch(meta);
    const [project] = await db
      .select({ id: projects.id, name: projects.name, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    const defaultBranch = project
      ? await resolveDefaultBranch(db, project, meta).catch(() => FALLBACK_DEFAULT_BRANCH)
      : FALLBACK_DEFAULT_BRANCH;
    const fallback = resolveFallbackBranch(meta, defaultBranch);
    baseBranch = fallback.branch;
    const prNumberRaw = meta?.scm?.prNumber;
    const prNumber = prNumberRaw != null && Number.isFinite(Number(prNumberRaw)) ? Number(prNumberRaw) : null;
    // A pull-request run is diffed against its base branch (whole PR); otherwise
    // against the last passing run on its branch.
    baseSha = await resolveDiffBase(db, run, meta, branch, fallback.branch, prNumber);
  } else {
    // Explicit range — resolve the repository from the latest run that carries one.
    const runs = await db
      .select({ metadata: testRuns.metadata })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId))
      .orderBy(desc(testRuns.id))
      .limit(50);
    for (const r of runs) {
      const url = normalizeGitUrl((r.metadata as RunMetadata | null)?.scm?.remoteUrl ?? null);
      if (url) {
        repositoryUrl = url;
        break;
      }
    }
  }

  if (!repositoryUrl || !baseSha || !headSha || baseSha === headSha) return empty(false);

  const provider = await createScmProvider(repositoryUrl, db, projectId);
  if (!provider) return empty(false);

  const changes = await provider.fetchChanges(baseSha, headSha).catch(() => null);
  if (!changes) return empty(false);

  const changedFiles = toChangedFiles(changes);
  const ticketKey = (await readProjectIntegration(db, projectId).catch(() => null))?.projectKey ?? null;
  const tickets = extractTicketIds([baseBranch, ...changes.commits.map((c) => c.message)], { ticketKey });

  return computeChangeCoverage(db, projectId, {
    changedFiles,
    runId,
    baseSha,
    headSha,
    baseBranch,
    tickets,
    ticketKey,
    filesTruncated: changes.filesTruncated ?? false,
    totalChangedFiles: changes.totalChangedFiles ?? null,
    scmAvailable: true,
    commitCoverage: await headCommitCoverage(db, projectId, headSha),
  });
}

/** Shape the coverage for the pull-request comment builder. */
export function toPrChangeCoverage(coverage: ChangeCoverage): PrChangeCoverage {
  return {
    totalFiles: coverage.files.length,
    uncoveredFiles: coverage.uncoveredFiles,
    reachedFiles: coverage.reachedFiles,
    ticketCount: coverage.tickets.filter((t) => t.ticket).length,
    windowRuns: coverage.windowRuns,
    baseBranch: coverage.baseBranch,
    filesTruncated: coverage.filesTruncated,
    patchCoverage: coverage.patchCoverage,
    tickets: coverage.tickets.map((group) => ({
      ticket: group.ticket,
      files: group.files.map((f) => ({
        filePath: f.filePath,
        additions: f.additions,
        deletions: f.deletions,
        reachedInRun: f.reachedInRun,
        reachedCountHistory: f.reachedCountHistory,
        suites: f.suites,
        draftTitle: f.reachedInRun || f.suites.length > 0 ? null : draftTitleFor(f.filePath),
      })),
    })),
  };
}
