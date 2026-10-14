/**
 * The database reads behind the coverage insights (`#shared/coverage-insights`):
 * a failing execution against the test's last passing execution with coverage,
 * a test's recent executions against each other and the tests that finished
 * before them in their runs, the code only some tests run among the other
 * tests' latest coverage on the default branch, and which target lines a
 * test's execution ran. Shared by the server endpoints, their demo mirror, the
 * MCP tools, the AI context and flaky classification.
 *
 * Every read is bounded: per test, the latest executions by the
 * `(test_case_id, created_at)` index; per run, the executions of the compared
 * runs by `test_run_id`; per file, the fragments by `(project_id, path)` and
 * their tests by `fragment_id`.
 */
import { aliasedTable, and, desc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import {
  decodeFunctionRanges,
  decodeLineRanges,
  type CoverageCapture,
  type CoverageFile,
  type LineRange,
} from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import {
  coverageFragments,
  quarantinedTests,
  testCases,
  testCoverage,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import { getExecutableLines, getExecutionsCoverage, getFileCoverage } from '../../server/utils/coverage';
import { asRuntime } from '../../server/utils/code-reach';
import { projectDefaultBranch } from '../../server/utils/scm/stored-default-branch';
import { notLabRun } from '../run-eligibility';
import { FAILED_STATUS_KEYS, isFailedStatus } from '../utils/test-counts';
import {
  EXPLANATION_MIN_SIDE,
  MAX_LOSS_TESTS,
  MAX_VARIATION_EXECUTIONS,
  MAX_VARYING_GROUPS,
  bestExplanation,
  coverageLoss,
  divergeCaptures,
  emptyLossSummary,
  explainableGroups,
  failuresFollow,
  nearestTest,
  reachOfTargets,
  unavailableDivergence,
  unavailableVariation,
  varyingCode,
  type CoverageBaseline,
  type CoverageDivergenceAnswer,
  type CoverageLossAnswer,
  type CoverageReachAnswer,
  type ExplanationCandidate,
  type LossTest,
  type NearestTest,
  type OtherFragment,
  type PathVariationAnswer,
  type VariationExecution,
} from '../coverage-insights';
import type { DrizzleDB } from './db';

/** Statuses of an execution that ran. */
const RAN_STATUSES = ['passed', ...FAILED_STATUS_KEYS, 'interrupted'];

/** Passing executions read when looking for a divergence's baseline, at most. */
const BASELINE_CANDIDATES = 100;

/** Baselines of the best tier whose coverage is read, newest first, to find a complete one. */
const BASELINE_TRIES = 3;

/** A test's latest executions with coverage read before keeping one Playwright project's, at most. */
const VARIATION_READ = 60;

/** Earlier tests whose order a path variation reads, at most, most evenly split first. */
const MAX_CANDIDATES = 200;

const ID_CHUNK = 500;
const PATH_CHUNK = 100;

/** An input a coverage insight refuses, such as an execution of another test. */
export class CoverageInsightInputError extends Error {}

/** Whether the project recorded any coverage. */
export async function projectRecordsCoverage(db: DrizzleDB, projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: coverageFragments.id })
    .from(coverageFragments)
    .where(eq(coverageFragments.projectId, projectId))
    .limit(1);
  return Boolean(row);
}

/** The facts of one execution an insight reads. */
interface ExecutionFacts {
  id: number;
  testCaseId: number;
  runId: number;
  projectId: number;
  status: string;
  coveragePayloadId: number | null;
  project: string | null;
  /** The execution's start, else its run's, in ms. */
  startedAt: number;
  runStart: Date;
  branch: string | null;
  commit: string | null;
}

const EXECUTION_COLUMNS = {
  id: testRunsCases.id,
  testCaseId: testRunsCases.testCaseId,
  runId: testRunsCases.testRunId,
  status: testRunsCases.status,
  coveragePayloadId: testRunsCases.coveragePayloadId,
  browserName: testRunsCases.browserName,
  browser: testRunsCases.browser,
  startedAt: testRunsCases.startedAt,
  projectId: testRuns.projectId,
  runStart: testRuns.startTime,
  branch: testRuns.branch,
  metadata: testRuns.metadata,
};

type ExecutionRow = {
  id: number;
  testCaseId: number;
  runId: number;
  status: string;
  coveragePayloadId: number | null;
  browserName: string | null;
  browser: unknown;
  startedAt: number | null;
  projectId: number;
  runStart: Date;
  branch: string | null;
  metadata: unknown;
};

/** The Playwright project an execution ran in, when known. */
function projectOf(row: Pick<ExecutionRow, 'browserName' | 'browser'>): string | null {
  const browser = row.browser as { projectName?: string; browserName?: string } | null;
  return row.browserName || browser?.projectName || browser?.browserName || null;
}

function factsOf(row: ExecutionRow): ExecutionFacts {
  const metadata = row.metadata as { scm?: { commit?: string } } | null;
  const runStart = new Date(row.runStart);
  return {
    id: row.id,
    testCaseId: row.testCaseId,
    runId: row.runId,
    projectId: row.projectId,
    status: row.status,
    coveragePayloadId: row.coveragePayloadId,
    project: projectOf(row),
    startedAt: row.startedAt != null ? Number(row.startedAt) : runStart.getTime(),
    runStart,
    branch: row.branch?.trim() || null,
    commit: metadata?.scm?.commit ?? null,
  };
}

async function loadExecution(db: DrizzleDB, executionId: number): Promise<ExecutionFacts | null> {
  const [row] = await db
    .select(EXECUTION_COLUMNS)
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, executionId));
  return row ? factsOf(row as ExecutionRow) : null;
}

// ── Divergence ───────────────────────────────────────────────────────────────

/**
 * How a failing execution's coverage differs from the test's last passing
 * execution with coverage that started before it: in the same Playwright
 * project on the same branch first, then the same project on the default
 * branch, then any project on the same branch, then any project on the
 * default branch, newest first, a complete capture before an incomplete one
 * among the newest three of that tier. Null when there is no such execution.
 */
export async function getCoverageDivergence(
  db: DrizzleDB,
  executionId: number,
): Promise<CoverageDivergenceAnswer | null> {
  const execution = await loadExecution(db, executionId);
  if (!execution) return null;
  if (!isFailedStatus(execution.status)) return unavailableDivergence(executionId, 'not-failing');
  if (execution.coveragePayloadId == null) return unavailableDivergence(executionId, 'no-coverage');

  const defaultBranch = await projectDefaultBranch(db, execution.projectId);
  const rows = (await db
    .select(EXECUTION_COLUMNS)
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, execution.testCaseId),
        sql`${testRunsCases.status} = 'passed'`,
        isNotNull(testRunsCases.coveragePayloadId),
        ne(testRunsCases.id, executionId),
        notLabRun(testRuns.origin),
        lte(testRuns.startTime, execution.runStart),
      ),
    )
    .orderBy(desc(testRunsCases.createdAt), desc(testRunsCases.id))
    .limit(BASELINE_CANDIDATES)) as ExecutionRow[];

  const branchOf = (branch: string | null) => branch || defaultBranch;
  const ownBranch = branchOf(execution.branch);
  const tierOf = (c: ExecutionFacts): number | null => {
    const sameProject = c.project === execution.project;
    const sameBranch = branchOf(c.branch) === ownBranch;
    const onDefault = branchOf(c.branch) === defaultBranch;
    if (sameProject && sameBranch) return 0;
    if (sameProject && onDefault) return 1;
    if (sameBranch) return 2;
    if (onDefault) return 3;
    return null;
  };
  const candidates = rows
    .map(factsOf)
    .filter((c) => c.startedAt < execution.startedAt)
    .map((c) => ({ c, tier: tierOf(c) }))
    .filter((c): c is { c: ExecutionFacts; tier: number } => c.tier !== null)
    .sort((a, b) => a.tier - b.tier || b.c.startedAt - a.c.startedAt || b.c.id - a.c.id);
  const best = candidates[0]?.tier;
  const tried = candidates
    .filter((c) => c.tier === best)
    .slice(0, BASELINE_TRIES)
    .map((c) => c.c);

  const coverage = await getExecutionsCoverage(db, [executionId, ...tried.map((c) => c.id)]);
  const here = coverage.get(executionId);
  if (!here || here.files.length === 0) return unavailableDivergence(executionId, 'no-coverage');
  const withFiles = tried.filter((c) => (coverage.get(c.id)?.files.length ?? 0) > 0);
  const chosen = withFiles.find((c) => !coverage.get(c.id)!.incomplete) ?? withFiles[0];
  if (!chosen) return unavailableDivergence(executionId, 'no-baseline');
  const baselineCapture = coverage.get(chosen.id)!;

  const baseline: CoverageBaseline = {
    executionId: chosen.id,
    runId: chosen.runId,
    startedAt: new Date(chosen.startedAt).toISOString(),
    branch: chosen.branch,
    commit: chosen.commit,
    project: chosen.project,
    sameProject: chosen.project === execution.project,
    sameBranch: branchOf(chosen.branch) === ownBranch,
  };
  const incomplete = { execution: here.incomplete === true, baseline: baselineCapture.incomplete === true };
  const known = { baseline, ...(incomplete.execution || incomplete.baseline ? { incomplete } : {}) };
  if (incomplete.execution && incomplete.baseline) return unavailableDivergence(executionId, 'incomplete', known);
  return { available: true, executionId, ...known, ...divergeCaptures(here, baselineCapture) };
}

// ── Path variation ───────────────────────────────────────────────────────────

/**
 * The earlier tests whose order varies across the placed executions: for each
 * test that finished before some of them started, in the same run, the bits of
 * those executions, and of those on the same worker (and shard). Only tests
 * that finished first before at least {@link EXPLANATION_MIN_SIDE} of them and
 * not before as many others, by either relation, are read, at most
 * {@link MAX_CANDIDATES}.
 */
async function explanationCandidates(
  db: DrizzleDB,
  executions: VariationExecution[],
  universe: number,
): Promise<ExplanationCandidate[]> {
  const placed = executions.flatMap((e, i) => (universe & (1 << i) ? [{ id: e.id, bit: 1 << i }] : []));
  const ids = placed.map((p) => p.id);
  const bitOf = new Map(placed.map((p) => [p.id, p.bit]));
  const low = EXPLANATION_MIN_SIDE;
  const high = placed.length - EXPLANATION_MIN_SIDE;
  if (high < low) return [];

  const other = aliasedTable(testRunsCases, 'other');
  const sameWorker = sql`(${other.workerIndex} = ${testRunsCases.workerIndex} AND COALESCE(${other.shardIndex}, -1) = COALESCE(${testRunsCases.shardIndex}, -1))`;
  const finishedBefore = and(
    eq(other.testRunId, testRunsCases.testRunId),
    ne(other.testCaseId, testRunsCases.testCaseId),
    isNotNull(other.startedAt),
    isNotNull(other.duration),
    inArray(other.status, RAN_STATUSES),
    sql`${other.startedAt} + ${other.duration} <= ${testRunsCases.startedAt}`,
  );
  const inRun = sql`count(DISTINCT ${testRunsCases.id})`;
  const onWorker = sql`count(DISTINCT CASE WHEN ${sameWorker} THEN ${testRunsCases.id} END)`;
  const shortlisted = await db
    .select({ testCaseId: other.testCaseId })
    .from(testRunsCases)
    .innerJoin(other, finishedBefore)
    .where(inArray(testRunsCases.id, ids))
    .groupBy(other.testCaseId)
    .having(sql`(${inRun} BETWEEN ${low} AND ${high}) OR (${onWorker} BETWEEN ${low} AND ${high})`)
    .orderBy(sql`abs(2 * ${inRun} - ${placed.length})`, other.testCaseId)
    .limit(MAX_CANDIDATES);
  if (shortlisted.length === 0) return [];

  const pairs = await db
    .selectDistinct({
      testCaseId: other.testCaseId,
      executionId: testRunsCases.id,
      sameWorker: sql<number>`CASE WHEN ${sameWorker} THEN 1 ELSE 0 END`,
    })
    .from(testRunsCases)
    .innerJoin(
      other,
      and(
        finishedBefore,
        inArray(
          other.testCaseId,
          shortlisted.map((r) => r.testCaseId),
        ),
      ),
    )
    .where(inArray(testRunsCases.id, ids));
  const candidates = new Map<number, ExplanationCandidate>();
  for (const pair of pairs) {
    const bit = bitOf.get(pair.executionId) ?? 0;
    const candidate = candidates.get(pair.testCaseId) ?? { testCaseId: pair.testCaseId, run: 0, worker: 0 };
    candidate.run |= bit;
    if (Number(pair.sameWorker) === 1) candidate.worker |= bit;
    candidates.set(pair.testCaseId, candidate);
  }
  return [...candidates.values()].sort((a, b) => a.testCaseId - b.testCaseId);
}

/**
 * How one test's coverage varies across its latest executions with coverage
 * (non-lab runs, at most {@link MAX_VARIATION_EXECUTIONS} of the Playwright
 * project that has most of the last {@link VARIATION_READ}), compared on the
 * files they ran at one version, and the earlier test whose having run before
 * predicts the variation. Incomplete captures are left out. With
 * `titles: false` the explanation's title and file are left empty, for a
 * caller that only reads `orderDependent`. Null when there is no such test.
 */
export async function getPathVariation(
  db: DrizzleDB,
  testCaseId: number,
  opts: { titles?: boolean } = {},
): Promise<PathVariationAnswer | null> {
  const [test] = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.id, testCaseId));
  if (!test) return null;
  const rows = await db
    .select({
      id: testRunsCases.id,
      status: testRunsCases.status,
      startedAt: testRunsCases.startedAt,
      browserName: testRunsCases.browserName,
      browser: testRunsCases.browser,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, testCaseId),
        isNotNull(testRunsCases.coveragePayloadId),
        inArray(testRunsCases.status, RAN_STATUSES),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRunsCases.createdAt), desc(testRunsCases.id))
    .limit(VARIATION_READ);
  if (rows.length === 0) return unavailableVariation(testCaseId, 'no-coverage');

  const perProject = new Map<string, number>();
  for (const row of rows) {
    const key = projectOf(row) ?? '';
    perProject.set(key, (perProject.get(key) ?? 0) + 1);
  }
  // The project with most executions; on a tie, the newest execution's.
  let project = projectOf(rows[0]!) ?? '';
  for (const [key, count] of perProject) if (count > perProject.get(project)!) project = key;
  const chosen = rows.filter((r) => (projectOf(r) ?? '') === project).slice(0, MAX_VARIATION_EXECUTIONS);
  const coverage = await getExecutionsCoverage(
    db,
    chosen.map((r) => r.id),
  );
  const executions: VariationExecution[] = [];
  let incomplete = 0;
  for (const row of chosen) {
    const capture = coverage.get(row.id);
    if (!capture || capture.incomplete) {
      incomplete++;
      continue;
    }
    executions.push({
      id: row.id,
      failed: isFailedStatus(row.status),
      startedAt: row.startedAt != null ? Number(row.startedAt) : null,
      capture,
    });
  }
  const counts = {
    compared: executions.length,
    incomplete,
    failed: executions.filter((e) => e.failed).length,
  };
  if (executions.length < 2) {
    return { ...unavailableVariation(testCaseId, 'too-few-executions', counts), project: project || null };
  }

  const { groups, files } = varyingCode(executions);
  const universe = executions.reduce((m, e, i) => (e.startedAt !== null ? m | (1 << i) : m), 0);
  const explainable = explainableGroups(groups, universe);
  const found =
    explainable.length > 0
      ? bestExplanation(groups, explainable, await explanationCandidates(db, executions, universe), universe)
      : null;
  const follow = failuresFollow(groups, executions, found?.varying ?? null);

  // The listed groups: the first ones, and any group the explanation or the failures name.
  const listed = groups.slice(0, MAX_VARYING_GROUPS).map((_, i) => i);
  for (const index of [found?.varying, follow?.varying]) {
    if (index !== undefined && !listed.includes(index)) listed.push(index);
  }
  const position = new Map(listed.map((index, i) => [index, i]));
  const answer: PathVariationAnswer = {
    available: true,
    testCaseId,
    project: project || null,
    executions: counts,
    files,
    varying: listed.map((index) => groups[index]!.code),
    orderDependent: Boolean(found && follow && follow.varying === found.varying),
  };
  if (groups.length > listed.length) answer.moreVarying = groups.length - listed.length;
  if (found) {
    let title = '';
    let filePath = '';
    if (opts.titles !== false) {
      const [other] = await db
        .select({ title: testCases.title, filePath: testCases.filePath })
        .from(testCases)
        .where(eq(testCases.id, found.testCaseId));
      title = other?.title ?? '';
      filePath = other?.filePath ?? '';
    }
    answer.explanation = { ...found, varying: position.get(found.varying)!, title, filePath };
  }
  if (follow) answer.failuresFollow = { ...follow, varying: position.get(follow.varying)! };
  return answer;
}

/**
 * Whether a test's failures follow the code an earlier test predicts, the
 * evidence flaky classification reads as an order dependency. False when the
 * test recorded too little coverage to tell.
 */
export async function isOrderDependent(db: DrizzleDB, testCaseId: number): Promise<boolean> {
  return (await getPathVariation(db, testCaseId, { titles: false }))?.orderDependent ?? false;
}

// ── Coverage loss ────────────────────────────────────────────────────────────

type FragmentRow = {
  id: number;
  runtime: string;
  path: string;
  blob: string | null;
  functions: string | null;
  lines: string | null;
};

/** A fragment row as a coverage file: its blob kept only with ranges, as stored fragments are read. */
function fragmentAsFile(row: FragmentRow): CoverageFile {
  const file: CoverageFile = { path: row.path, runtime: asRuntime(row.runtime) };
  const functions = decodeFunctionRanges(row.functions);
  const lines = decodeLineRanges(row.lines);
  if (row.blob && (functions.length > 0 || lines.length > 0)) file.blob = row.blob;
  if (functions.length > 0) file.functions = functions;
  if (lines.length > 0) file.lines = lines;
  return file;
}

/**
 * The code only the given tests of a project run among the other tests'
 * latest coverage on the default branch, ignoring quarantined tests: per file
 * and version, the lines and functions no other trusted (not quarantined)
 * test runs, those only flaky tests run besides them, and the files no other
 * trusted test runs at all. Null when none of the ids is a test of the project.
 */
export async function getCoverageLoss(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
): Promise<CoverageLossAnswer | null> {
  const ids = [...new Set(testCaseIds)].slice(0, MAX_LOSS_TESTS);
  if (ids.length === 0) return null;
  const tests = await db
    .select({ id: testCases.id, title: testCases.title, filePath: testCases.filePath })
    .from(testCases)
    .where(and(eq(testCases.projectId, projectId), inArray(testCases.id, ids)));
  if (tests.length === 0) return null;
  const known = tests.map((t) => t.id);
  const unknownTestIds = ids.filter((id) => !known.includes(id));

  const [branch, quarantined, own] = await Promise.all([
    projectDefaultBranch(db, projectId),
    db
      .select({ testCaseId: quarantinedTests.testCaseId })
      .from(quarantinedTests)
      .where(
        and(
          eq(quarantinedTests.projectId, projectId),
          inArray(quarantinedTests.testCaseId, known),
          isNull(quarantinedTests.releasedAt),
        ),
      ),
    db
      .select({ testCaseId: testCoverage.testCaseId, fragmentId: testCoverage.fragmentId })
      .from(testCoverage)
      .where(and(inArray(testCoverage.testCaseId, known), eq(testCoverage.branch, ''))),
  ]);
  const quarantinedIds = new Set(quarantined.map((q) => q.testCaseId));
  const covered = new Set(own.map((r) => r.testCaseId));
  const lossTests: LossTest[] = tests
    .map((t) => ({
      testCaseId: t.id,
      title: t.title,
      filePath: t.filePath,
      quarantined: quarantinedIds.has(t.id),
      hasCoverage: covered.has(t.id),
    }))
    .sort((a, b) => a.testCaseId - b.testCaseId);
  const base = {
    projectId,
    branch,
    tests: lossTests,
    ...(unknownTestIds.length > 0 ? { unknownTestIds } : {}),
  };
  if (own.length === 0) {
    return { available: false, reason: 'no-coverage', ...base, summary: emptyLossSummary(), files: [] };
  }

  const fragmentIds = [...new Set(own.map((r) => r.fragmentId))];
  const ours: CoverageFile[] = [];
  for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: coverageFragments.id,
        runtime: coverageFragments.runtime,
        path: coverageFragments.path,
        blob: coverageFragments.blob,
        functions: coverageFragments.functions,
        lines: coverageFragments.lines,
      })
      .from(coverageFragments)
      .where(inArray(coverageFragments.id, fragmentIds.slice(i, i + ID_CHUNK)));
    ours.push(...rows.map(fragmentAsFile));
  }

  const notQuarantined = sql`${quarantinedTests.id} IS NULL`;
  const steadyTest = sql`${notQuarantined} AND ${testCases.flakyRootCause} IS NULL`;
  const flakyTest = sql`${notQuarantined} AND ${testCases.flakyRootCause} IS NOT NULL`;
  const paths = [...new Set(ours.map((f) => f.path))];
  const others: OtherFragment[] = [];
  const otherTests = new Map<string, { steady: number; flaky: number }>();
  const otherTestsOf = (chunk: string[]) =>
    and(
      eq(coverageFragments.projectId, projectId),
      inArray(coverageFragments.path, chunk),
      notInArray(testCoverage.testCaseId, known),
    );
  const testOfFragment = and(eq(testCoverage.fragmentId, coverageFragments.id), eq(testCoverage.branch, ''));
  const activeQuarantine = and(
    eq(quarantinedTests.testCaseId, testCoverage.testCaseId),
    isNull(quarantinedTests.releasedAt),
  );
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const chunk = paths.slice(i, i + PATH_CHUNK);
    const [fragmentRows, fileRows] = await Promise.all([
      db
        .select({
          id: coverageFragments.id,
          runtime: coverageFragments.runtime,
          path: coverageFragments.path,
          blob: coverageFragments.blob,
          functions: coverageFragments.functions,
          lines: coverageFragments.lines,
          steady: sql<number>`sum(CASE WHEN ${steadyTest} THEN 1 ELSE 0 END)`,
          flaky: sql<number>`sum(CASE WHEN ${flakyTest} THEN 1 ELSE 0 END)`,
        })
        .from(coverageFragments)
        .innerJoin(testCoverage, testOfFragment)
        .innerJoin(testCases, eq(testCases.id, testCoverage.testCaseId))
        .leftJoin(quarantinedTests, activeQuarantine)
        .where(otherTestsOf(chunk))
        .groupBy(
          coverageFragments.id,
          coverageFragments.runtime,
          coverageFragments.path,
          coverageFragments.blob,
          coverageFragments.functions,
          coverageFragments.lines,
        ),
      db
        .select({
          runtime: coverageFragments.runtime,
          path: coverageFragments.path,
          steady: sql<number>`count(DISTINCT CASE WHEN ${steadyTest} THEN ${testCoverage.testCaseId} END)`,
          flaky: sql<number>`count(DISTINCT CASE WHEN ${flakyTest} THEN ${testCoverage.testCaseId} END)`,
        })
        .from(coverageFragments)
        .innerJoin(testCoverage, testOfFragment)
        .innerJoin(testCases, eq(testCases.id, testCoverage.testCaseId))
        .leftJoin(quarantinedTests, activeQuarantine)
        .where(otherTestsOf(chunk))
        .groupBy(coverageFragments.runtime, coverageFragments.path),
    ]);
    for (const row of fragmentRows) {
      others.push({ ...fragmentAsFile(row), steady: Number(row.steady ?? 0), flaky: Number(row.flaky ?? 0) });
    }
    for (const row of fileRows) {
      otherTests.set(`${asRuntime(row.runtime)}\x00${row.path}`, {
        steady: Number(row.steady ?? 0),
        flaky: Number(row.flaky ?? 0),
      });
    }
  }

  return { available: true, ...base, ...coverageLoss(ours, others, otherTests) };
}

// ── Coverage reach ───────────────────────────────────────────────────────────

/** The entry of a capture matching a file: line granularity first, then functions, then an exact path, then server. */
function matchingEntry(capture: CoverageCapture, file: string): CoverageFile | null {
  const rank = (f: CoverageFile) =>
    (f.lines?.length ? 0 : f.functions?.length ? 4 : 8) + (f.path === file ? 0 : 2) + (f.runtime === 'server' ? 0 : 1);
  return (
    capture.files
      .filter((f) => sameFilePath(f.path, file))
      .sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1))[0] ?? null
  );
}

/** The latest execution with coverage of a test, outside lab runs; null when it has none. */
async function latestCoveredExecution(db: DrizzleDB, testCaseId: number): Promise<ExecutionFacts | null> {
  const [row] = await db
    .select(EXECUTION_COLUMNS)
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, testCaseId),
        isNotNull(testRunsCases.coveragePayloadId),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRunsCases.createdAt), desc(testRunsCases.id))
    .limit(1);
  return row ? factsOf(row as ExecutionRow) : null;
}

/** The id of a test's latest execution with coverage, outside lab runs; null when it has none. */
export async function latestCoveredExecutionId(db: DrizzleDB, testCaseId: number): Promise<number | null> {
  return (await latestCoveredExecution(db, testCaseId))?.id ?? null;
}

/**
 * The test running most of the code around target lines of a file, from the
 * tests' latest coverage of it on a branch (`getFileCoverage`); see
 * `nearestTest`. Null when no other test ran the file.
 */
export async function getNearestTest(
  db: DrizzleDB,
  projectId: number,
  file: string,
  target: LineRange[],
  opts: { branch?: string | null; blob?: string | null; excludeTestId?: number } = {},
): Promise<NearestTest | null> {
  const view = await getFileCoverage(db, projectId, file, opts.branch);
  return nearestTest(view, target, { blob: opts.blob, excludeTestId: opts.excludeTestId });
}

/**
 * Which target lines of a file one execution of a test ran: the given
 * execution, else the test's latest execution with coverage. Against the
 * executable lines a run recorded for the same version, the target lines that
 * cannot run are set apart; when a target line did not run, the test running
 * most of the code around it is named. Null when there is no such test;
 * throws {@link CoverageInsightInputError} for an execution of another test.
 */
export async function getCoverageReach(
  db: DrizzleDB,
  testCaseId: number,
  input: { file: string; lines: LineRange[]; executionId?: number | null },
): Promise<CoverageReachAnswer | null> {
  const [test] = await db
    .select({ id: testCases.id, projectId: testCases.projectId })
    .from(testCases)
    .where(eq(testCases.id, testCaseId));
  if (!test) return null;
  let execution: ExecutionFacts | null;
  if (input.executionId != null) {
    execution = await loadExecution(db, input.executionId);
    if (!execution || execution.testCaseId !== testCaseId) {
      throw new CoverageInsightInputError(`Execution ${input.executionId} is not an execution of test ${testCaseId}`);
    }
  } else {
    execution = await latestCoveredExecution(db, testCaseId);
  }

  const base = { testCaseId, file: input.file, target: input.lines };
  const located = execution
    ? { executionId: execution.id, runId: execution.runId, startedAt: new Date(execution.startedAt).toISOString() }
    : {};
  if (!execution || execution.coveragePayloadId == null) {
    return {
      available: false,
      reason: 'no-coverage',
      ...base,
      ...located,
      reachedFile: false,
      complete: false,
      ran: [],
      notRan: [],
      unknown: input.lines,
      allRan: false,
    };
  }

  const capture = (await getExecutionsCoverage(db, [execution.id], { rangesFor: [input.file] })).get(execution.id) ?? {
    v: 1 as const,
    files: [],
  };
  const entry = matchingEntry(capture, input.file);
  const executable = entry?.blob
    ? ((
        await getExecutableLines(db, test.projectId, [{ path: entry.path, runtime: entry.runtime, blob: entry.blob }])
      )[0]?.lines ?? null)
    : null;
  const reach = reachOfTargets(entry, !capture.incomplete, input.lines, executable);
  const answer: CoverageReachAnswer = {
    available: true,
    ...base,
    ...located,
    reachedFile: Boolean(entry),
    ...(entry ? { path: entry.path, runtime: entry.runtime, ...(entry.blob ? { blob: entry.blob } : {}) } : {}),
    complete: !capture.incomplete,
    ...reach,
  };
  if (!reach.allRan) {
    answer.nearest = await getNearestTest(db, test.projectId, input.file, input.lines, {
      branch: execution.branch,
      blob: entry?.blob ?? null,
      excludeTestId: testCaseId,
    });
  }
  return answer;
}

/** A test of a project named by its spec file (a path or a suffix of one) and its title. */
export async function resolveTestByTitle(
  db: DrizzleDB,
  projectId: number,
  testFile: string,
  testTitle: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: testCases.id, filePath: testCases.filePath, suitePath: testCases.suitePath })
    .from(testCases)
    .where(and(eq(testCases.projectId, projectId), eq(testCases.title, testTitle)));
  const matches = rows.filter((r) => sameFilePath(r.filePath, testFile));
  if (matches.length > 1) {
    const listed = matches
      .slice(0, 5)
      .map((m) => `${m.id} (${[...m.suitePath.split('\x1f').filter(Boolean), testTitle].join(' › ')})`)
      .join(', ');
    throw new CoverageInsightInputError(`Several tests match that file and title: ${listed}; pass testCaseId`);
  }
  return matches[0]?.id ?? null;
}
