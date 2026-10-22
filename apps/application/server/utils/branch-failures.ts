/**
 * The latest complete run on a branch and its failed executions at their
 * failing lines: what an editor shows in its Problems panel and status bar.
 * With overlays, the finished runs of that branch started after it (a test
 * re-run from the editor, a run on a developer's machine) are laid over it,
 * per test and Playwright project: the newest result wins. The editor may
 * choose another baseline: a run by its id, or a developer's own runs only.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, max, notInArray, or, sql, sum, type SQL } from 'drizzle-orm';
import { extractStackFrames, stripAnsi, withoutStackFrames } from '@piwitests/core/error-parse';
import { failureClusters, files, testCases, testRuns, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { caseHeadline } from '#shared/failure-verdict';
import { failurePageFirst, isScreenshotFileRow } from '#shared/file-classify';
import { extractErrorLocation } from './locator-healing';
import { lastAttempts } from '#shared/status-classify';
import {
  CI_RUN_ORIGINS,
  LOCAL_RUN_ORIGINS,
  UNFINISHED_RUN_STATUSES,
  eligibleRunSql,
  runOriginIn,
  type RunOriginKind,
} from '#shared/run-eligibility';
import type { RunMetadata } from './run-json-types';

/** Failed executions listed per run, and failures listed as resolved. */
export const MAX_BRANCH_FAILURES = 200;

/** Runs laid over the latest complete run, at most. */
export const MAX_BRANCH_OVERLAYS = 20;

/** The error message of a failure is cut after this many lines, then after this many characters. */
const MESSAGE_MAX_LINES = 12;
const MESSAGE_MAX_CHARS = 1000;
/** Stack frames listed per failure. */
const MAX_FRAMES = 10;

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

/** The stored files a failure lists its traces and screenshot from. */
const EVIDENCE_TYPES = ['trace', 'screenshot', 'attachment'];

export interface BranchRun {
  id: number;
  status: string;
  branch: string | null;
  /** ISO 8601. */
  startTime: string;
  /** What launched it (`test_runs.origin`): `ci`, `ci-rerun`, `local`, `desktop`… */
  origin: string;
  /** The commit it ran at (`metadata.scm.commit`); null when the reporter recorded none. */
  commit: string | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  skippedTests: number;
}

/** A finished run of the branch started after the latest complete run, laid over it. */
export interface BranchOverlay {
  id: number;
  status: string;
  /** What launched it (`test_runs.origin`): `editor`, `local`, `desktop`, `ci`… */
  origin: string;
  /** Whether it ran the whole suite. */
  isFullRun: boolean;
  /** ISO 8601. */
  startTime: string;
  /** The commit it ran at (`metadata.scm.commit`); null when the reporter recorded none. */
  commit: string | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  skippedTests: number;
}

export interface BranchFailure {
  executionId: number;
  testCaseId: number;
  /** The failure cluster the execution belongs to (its fix plan: `GET /api/failure-clusters/:id/fix-plan`); null when none. */
  clusterId: number | null;
  title: string;
  /** The spec file and the line of the `test(…)` call. */
  file: string;
  line: number | null;
  status: string;
  /** One line on why it failed; null without an error. */
  headline: string | null;
  /** The failing call in the error's first frame outside `node_modules`, `file:line:col`; null when the error names none. */
  location: string | null;
  /** The error without its stack trace (call log, expected and received included), shortened; null without an error. */
  message: string | null;
  /** The error's frames outside `node_modules`, innermost first, `file:line:col`: the failing call, then its callers. */
  frames: string[];
  /** Stored trace paths, downloadable from `/api/files/<path>`. */
  traces: string[];
  /** The failure screenshot's stored path; null without one. */
  screenshot: string | null;
  /** `baseline` for an execution of the latest complete run, `overlay` for one of a run laid over it. */
  source: 'baseline' | 'overlay';
  /** The run the execution belongs to. */
  runId: number;
  /** The Playwright project the execution ran in; null when unknown. */
  browserName: string | null;
  /** In milliseconds; null when not recorded. */
  duration: number | null;
  /**
   * For the latest complete run, whether the failure is a new regression there (the test passed in its baseline);
   * for an overlay, whether the test did not fail on this project in the latest complete run.
   */
  isNew: boolean;
  /** The failure cluster's title; null without a cluster or a title. */
  clusterTitle: string | null;
  /** The test's owner (`piwi:owner`); null when none. */
  owner: string | null;
  /** What a run laid over the latest complete run says about the test on another project: `passed on chromium in run #124`. */
  note?: string;
}

/** A failure of the latest complete run whose newest result on its project, in a run laid over it, is a pass. */
export interface BranchResolved {
  testCaseId: number;
  title: string;
  /** The spec file and the line of the `test(…)` call, as the passing run reported them. */
  file: string;
  line: number | null;
  browserName: string | null;
  /** The run that passed it, and its passing execution. */
  runId: number;
  executionId: number;
  /** The execution that failed in the latest complete run. */
  baselineExecutionId: number;
}

export interface BranchFailures {
  /** The baseline; null when none is found, and with `origin: 'local'` the overlays alone are read. */
  run: BranchRun | null;
  /** The runs laid over `run`, newest first; empty without overlays. */
  overlays: BranchOverlay[];
  failures: BranchFailure[];
  /** The failures of `run` a run laid over it passed; empty without overlays. */
  resolved: BranchResolved[];
}

/** Which run is the baseline, and which runs are laid over it. */
export interface BranchFailuresOptions {
  /** Lay the finished runs of the baseline's branch started after it over it. */
  overlays?: boolean;
  /** This run is the baseline, whatever its branch, origin or completeness; the branch asked for is not read. */
  run?: number;
  /**
   * `local`: a developer's own runs only (`LOCAL_RUN_ORIGINS`). The baseline is the branch's newest complete local
   * run, and only local runs are laid over it; without one, the finished local runs of the branch are the overlays
   * alone.
   */
  origin?: 'local';
}

/** A chosen baseline run the project does not hold: missing (404) or another project's (400). */
export class BranchFailuresRunError extends Error {
  constructor(
    readonly statusCode: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = 'BranchFailuresRunError';
  }
}

/** The query of `GET /api/projects/:id/branch-failures`, read the same way by the server and the demo. */
export function parseBranchFailuresQuery(
  query: Record<string, unknown>,
): { ok: true; branch: string | null; options: BranchFailuresOptions } | { ok: false; message: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const branch = text(query.branch);
  if (branch.length > 255) return { ok: false, message: 'branch is at most 255 characters' };
  const flag = text(query.overlays);
  const options: BranchFailuresOptions = { overlays: flag === '1' || flag === 'true' };
  const run = text(query.run);
  if (run) {
    if (!/^\d{1,15}$/.test(run) || Number(run) < 1) return { ok: false, message: 'run is a test run ID' };
    options.run = Number(run);
  }
  const origin = text(query.origin);
  if (origin) {
    if (origin !== 'local') return { ok: false, message: 'origin is local or omitted' };
    if (options.run !== undefined) return { ok: false, message: 'run and origin cannot be combined' };
    options.origin = 'local';
  }
  return { ok: true, branch: branch || null, options };
}

/** `GET /api/projects/:id/branch-failures` once its runs are read: what its answer is computed from, and the answer. */
export interface BranchFailuresRead {
  /**
   * What the answer is computed from, read without computing it: the same version gives the same answer. Read before
   * the answer, it is never newer than the answer.
   */
  version(): Promise<unknown>;
  answer(): Promise<BranchFailures>;
}

/**
 * `GET /api/projects/:id/branch-failures` from its query, read the same way by the server and the demo: its runs
 * first, then its version or its answer. A query it refuses and a chosen run the project does not hold are thrown as
 * `toHttpError` builds the HTTP error.
 */
export async function readBranchFailures(
  db: DrizzleDB,
  projectId: number,
  rawQuery: Record<string, unknown>,
  toHttpError: (statusCode: 400 | 404, message: string) => Error,
): Promise<BranchFailuresRead> {
  const query = parseBranchFailuresQuery(rawQuery);
  if (!query.ok) throw toHttpError(400, query.message);
  let runs: BranchFailuresRuns;
  try {
    runs = await branchFailuresRuns(db, projectId, query.branch, query.options);
  } catch (error) {
    if (error instanceof BranchFailuresRunError) throw toHttpError(error.statusCode, error.message);
    throw error;
  }
  return {
    version: () => branchFailuresVersion(db, { projectId, branch: query.branch, ...query.options }, runs),
    answer: () => failuresOfRuns(db, runs),
  };
}

/** {@link readBranchFailures}'s answer. */
export async function branchFailuresOrError(
  db: DrizzleDB,
  projectId: number,
  rawQuery: Record<string, unknown>,
  toHttpError: (statusCode: 400 | 404, message: string) => Error,
): Promise<BranchFailures> {
  return (await readBranchFailures(db, projectId, rawQuery, toHttpError)).answer();
}

/** An error as an editor quotes it: without ANSI codes and stack frames, at most {@link MESSAGE_MAX_LINES} lines. */
export function errorMessage(error: string | null): string | null {
  if (!error) return null;
  const lines = withoutStackFrames(stripAnsi(error).replace(/\r\n?/g, '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n');
  let text = lines.slice(0, MESSAGE_MAX_LINES).join('\n');
  if (text.length > MESSAGE_MAX_CHARS) text = text.slice(0, MESSAGE_MAX_CHARS).trimEnd();
  return !text ? null : text.length < lines.join('\n').length ? `${text}\n…` : text;
}

/** An error's frames outside `node_modules` as `file:line:col`, innermost first, without repeats. */
export function errorFrames(error: string | null): string[] {
  if (!error) return [];
  const frames = extractStackFrames(stripAnsi(error)).map((f) => `${f.file}:${f.line}:${f.column}`);
  return [...new Set(frames)].slice(0, MAX_FRAMES);
}

function iso(value: Date | number | string | null | undefined): string {
  if (value == null) return new Date(0).toISOString();
  const d = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** The commit a run's metadata records; null without one. */
function commitOf(metadata: unknown): string | null {
  const commit = (metadata as RunMetadata | null)?.scm?.commit;
  return typeof commit === 'string' && commit.trim() ? commit.trim() : null;
}

/** A test on one Playwright project: what the newest result is kept per. */
function testKey(row: { testCaseId: number; browserName: string | null }): string {
  return `${row.testCaseId}\x00${row.browserName ?? ''}`;
}

/** One execution as a failure is listed from. */
interface ExecutionRow {
  executionId: number;
  runId: number;
  testCaseId: number;
  repeatEachIndex: number;
  retries: number | null;
  browserName: string | null;
  clusterId: number | null;
  clusterTitle: string | null;
  status: string;
  error: string | null;
  steps: unknown;
  line: number | null;
  duration: number | null;
  isNewRegression: number | null;
  title: string;
  file: string;
  owner: string | null;
}

/** An attempt of a test on one project in a run laid over the latest complete run. */
interface OverlayAttempt {
  executionId: number;
  runId: number;
  testCaseId: number;
  repeatEachIndex: number;
  retries: number | null;
  browserName: string | null;
  status: string;
  file: string;
  line: number | null;
}

/** A failure to list: an execution, where it comes from, and where it is. */
interface Listed {
  executionId: number;
  source: BranchFailure['source'];
  isNew: boolean;
  note?: string;
  file: string;
  line: number | null;
}

/**
 * The newest complete run of a project on `branch` (any branch when null) and
 * the tests whose last attempt in it failed, one execution per test and browser
 * project. A complete run ran the whole suite and finished: a filtered or
 * selection run and a run still in progress are passed over, as is every run
 * the `branch-failures` use leaves out. A CI run is preferred: a local run
 * stands in only while the branch has no CI run.
 *
 * With `overlays`, the finished runs of that run's branch started after it,
 * whole or partial, that the `editor-overlay` use reads (at most
 * {@link MAX_BRANCH_OVERLAYS}, newest first) are laid over it. For each test
 * and Playwright project, the newest last attempt that passed or failed wins: a
 * failure passed later moves to `resolved`, a failure that failed again is
 * listed from the later execution, and a test that fails only in a later run is
 * listed as new. A pass on another project resolves nothing; it is noted on the
 * failure. Of the overlays, only the attempts of the tests that failed in the
 * complete run or in an overlay are read: no other test can change the answer.
 *
 * With `run`, that run of the project is the baseline instead, and the runs of
 * its branch started after it are laid over it; a run of another project or
 * none throws {@link BranchFailuresRunError}. With `origin: 'local'`, only a
 * developer's own runs are read: the newest complete one on `branch` is the
 * baseline, and without one the finished local runs of the branch are laid over
 * no baseline, each failure new.
 */
export async function getBranchFailures(
  db: DrizzleDB,
  projectId: number,
  branch: string | null,
  options: BranchFailuresOptions = {},
): Promise<BranchFailures> {
  return failuresOfRuns(db, await branchFailuresRuns(db, projectId, branch, options));
}

/** The columns of a run the answer reads. */
function runColumns() {
  return {
    id: testRuns.id,
    status: testRuns.status,
    branch: testRuns.branch,
    startTime: testRuns.startTime,
    origin: testRuns.origin,
    metadata: testRuns.metadata,
    totalTests: testRuns.totalTests,
    passedTests: testRuns.passedTests,
    failedTests: testRuns.failedTests,
    flakyTests: testRuns.flakyTests,
    skippedTests: testRuns.skippedTests,
  };
}

/** The runs {@link getBranchFailures} reads: the baseline, null when none, and the runs laid over it, newest first. */
type BranchFailuresRuns = Awaited<ReturnType<typeof branchFailuresRuns>>;

/**
 * The baseline and the runs laid over it, as {@link getBranchFailures} chooses them: small queries on the runs of the
 * project (`idx_test_runs_project_branch_start`, `idx_test_runs_project_start`), at most
 * {@link MAX_BRANCH_OVERLAYS} + 1 rows.
 */
async function branchFailuresRuns(
  db: DrizzleDB,
  projectId: number,
  branch: string | null,
  options: BranchFailuresOptions,
) {
  const newest = (origins: readonly RunOriginKind[] | null) =>
    db
      .select(runColumns())
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, projectId),
          branch ? eq(testRuns.branch, branch) : undefined,
          eligibleRunSql('branch-failures'),
          origins ? runOriginIn(testRuns.origin, origins) : undefined,
        ),
      )
      .orderBy(desc(testRuns.startTime), desc(testRuns.id))
      .limit(1);
  const local = options.origin === 'local';
  let run: Awaited<ReturnType<typeof newest>>[number] | undefined;
  if (options.run !== undefined) {
    const [found] = await db
      .select({ ...runColumns(), projectId: testRuns.projectId })
      .from(testRuns)
      .where(eq(testRuns.id, options.run))
      .limit(1);
    if (!found) throw new BranchFailuresRunError(404, `Test run ${options.run} not found`);
    if (found.projectId !== projectId) {
      throw new BranchFailuresRunError(400, `Test run ${options.run} belongs to another project`);
    }
    const { projectId: _project, ...row } = found;
    run = row;
  } else if (local) {
    [run] = await newest(LOCAL_RUN_ORIGINS);
  } else {
    const ciRuns = await newest(CI_RUN_ORIGINS);
    [run] = ciRuns.length ? ciRuns : await newest(null);
  }
  if (!run && !(local && options.overlays)) return { run: null, overlays: [] };

  const overlayBranch = run
    ? run.branch
      ? eq(testRuns.branch, run.branch)
      : isNull(testRuns.branch)
    : branch
      ? eq(testRuns.branch, branch)
      : undefined;
  const overlays = options.overlays
    ? await db
        .select({ ...runColumns(), isFullRun: testRuns.isFullRun })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.projectId, projectId),
            overlayBranch,
            run
              ? or(
                  gt(testRuns.startTime, run.startTime),
                  and(eq(testRuns.startTime, run.startTime), gt(testRuns.id, run.id)),
                )
              : undefined,
            notInArray(testRuns.status, [...UNFINISHED_RUN_STATUSES]),
            eligibleRunSql('editor-overlay'),
            local ? runOriginIn(testRuns.origin, LOCAL_RUN_ORIGINS) : undefined,
          ),
        )
        .orderBy(desc(testRuns.startTime), desc(testRuns.id))
        .limit(MAX_BRANCH_OVERLAYS)
    : [];
  return { run: run ?? null, overlays };
}

/** A baseline run as the answer shows it. */
function branchRun(run: NonNullable<BranchFailuresRuns['run']>): BranchRun {
  return {
    id: run.id,
    status: run.status,
    branch: run.branch ?? null,
    startTime: iso(run.startTime),
    origin: run.origin,
    commit: commitOf(run.metadata),
    totalTests: run.totalTests,
    passedTests: run.passedTests,
    failedTests: run.failedTests,
    flakyTests: run.flakyTests,
    skippedTests: run.skippedTests,
  };
}

/** A run laid over the baseline as the answer shows it. */
function branchOverlay(o: BranchFailuresRuns['overlays'][number]): BranchOverlay {
  return {
    id: o.id,
    status: o.status,
    origin: o.origin,
    isFullRun: Boolean(o.isFullRun),
    startTime: iso(o.startTime),
    commit: commitOf(o.metadata),
    totalTests: o.totalTests,
    passedTests: o.passedTests,
    failedTests: o.failedTests,
    flakyTests: o.flakyTests,
    skippedTests: o.skippedTests,
  };
}

/**
 * What the answer for `runs` is computed from, read without computing it: the request (`query`), the runs as the
 * answer shows them, then, for those runs, two small queries on `idx_test_runs_cases_test_run_id`:
 * - each run's executions: how many, the newest (a result stored since: another test, attempt, project or
 *   repetition) and the sum of their test ids (an execution moved to another test by a merge);
 * - each failed execution, with what may change once it is stored: its test, failure cluster and whether it is a new
 *   regression, the cluster's title, its test's title, file and owner, and its stored files (how many, the newest,
 *   on `idx_files_test_runs_case_id`).
 *
 * The rest of an execution (its status, error, steps, line, duration, attempt, project, repetition) never changes
 * once stored. Never reads an error, steps or a file's content.
 */
async function branchFailuresVersion(
  db: DrizzleDB,
  query: { projectId: number; branch: string | null } & BranchFailuresOptions,
  runs: BranchFailuresRuns,
): Promise<unknown> {
  const shown = {
    query,
    run: runs.run ? branchRun(runs.run) : null,
    overlays: runs.overlays.map(branchOverlay),
  };
  const runIds = [...(runs.run ? [runs.run.id] : []), ...runs.overlays.map((o) => o.id)];
  if (!runIds.length) return shown;
  const ofRuns = inArray(testRunsCases.testRunId, runIds);
  const executions = await db
    .select({
      runId: testRunsCases.testRunId,
      count: count(),
      newest: max(testRunsCases.id),
      tests: sum(testRunsCases.testCaseId),
    })
    .from(testRunsCases)
    .where(ofRuns)
    .groupBy(testRunsCases.testRunId)
    .orderBy(asc(testRunsCases.testRunId));
  const evidenceOf = (aggregate: SQL) =>
    sql`(select ${aggregate} from ${files} where ${files.testRunsCaseId} = ${testRunsCases.id} and ${inArray(files.type, EVIDENCE_TYPES)})`;
  const failed = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      clusterId: testRunsCases.failureClusterId,
      isNewRegression: testRunsCases.isNewRegression,
      clusterTitle: failureClusters.title,
      title: testCases.title,
      file: testCases.filePath,
      owner: testCases.owner,
      files: evidenceOf(sql`count(*)`).mapWith(Number),
      newestFile: evidenceOf(sql`max(${files.id})`).mapWith(Number),
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .leftJoin(failureClusters, eq(failureClusters.id, testRunsCases.failureClusterId))
    .where(and(ofRuns, inArray(testRunsCases.status, FAIL_STATUSES)))
    .orderBy(asc(testRunsCases.id));
  return {
    ...shown,
    executions: executions.map((e) => [e.runId, e.count, e.newest, e.tests]),
    failed: failed.map((f) => [
      f.id,
      f.testCaseId,
      f.clusterId,
      f.isNewRegression,
      f.clusterTitle,
      f.title,
      f.file,
      f.owner,
      f.files,
      f.newestFile,
    ]),
  };
}

/** The answer for the runs {@link branchFailuresRuns} chose. */
async function failuresOfRuns(
  db: DrizzleDB,
  { run, overlays: overlayRuns }: BranchFailuresRuns,
): Promise<BranchFailures> {
  if (!run && !overlayRuns.length) return { run: null, overlays: [], failures: [], resolved: [] };

  const executions = (where: SQL | undefined): Promise<ExecutionRow[]> =>
    db
      .select({
        executionId: testRunsCases.id,
        runId: testRunsCases.testRunId,
        testCaseId: testRunsCases.testCaseId,
        repeatEachIndex: testRunsCases.repeatEachIndex,
        retries: testRunsCases.retries,
        browserName: testRunsCases.browserName,
        clusterId: testRunsCases.failureClusterId,
        clusterTitle: failureClusters.title,
        status: testRunsCases.status,
        error: testRunsCases.error,
        steps: testRunsCases.steps,
        line: testRunsCases.line,
        duration: testRunsCases.duration,
        isNewRegression: testRunsCases.isNewRegression,
        title: testCases.title,
        file: testCases.filePath,
        owner: testCases.owner,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .leftJoin(failureClusters, eq(failureClusters.id, testRunsCases.failureClusterId))
      .where(where)
      .orderBy(asc(testCases.filePath), asc(testRunsCases.line), asc(testRunsCases.id));

  // Every attempt of each test that failed at least once, so a pass on a retry drops the test.
  const attempts = run
    ? await executions(
        and(
          eq(testRunsCases.testRunId, run.id),
          inArray(
            testRunsCases.testCaseId,
            db
              .select({ id: testRunsCases.testCaseId })
              .from(testRunsCases)
              .where(and(eq(testRunsCases.testRunId, run.id), inArray(testRunsCases.status, FAIL_STATUSES))),
          ),
        ),
      )
    : [];
  // A test failed on a project when one of its repetitions' last attempts failed: one failure per test and project.
  const baselineByTest = new Map<string, ExecutionRow>();
  for (const r of lastAttempts(attempts.map((a) => ({ ...a, id: a.executionId })))) {
    if (FAIL_STATUSES.includes(r.status) && !baselineByTest.has(testKey(r))) baselineByTest.set(testKey(r), r);
  }
  const baseline = [...baselineByTest.values()];

  // The last attempt of each test on each project in each overlay; the newest run that passed or failed it wins.
  const overlayIds = overlayRuns.map((o) => o.id);
  let overlayAttempts: OverlayAttempt[] = [];
  if (overlayIds.length) {
    const failedBefore = [...new Set(baseline.map((r) => r.testCaseId))];
    const failedInOverlay = inArray(
      testRunsCases.testCaseId,
      db
        .select({ id: testRunsCases.testCaseId })
        .from(testRunsCases)
        .where(and(inArray(testRunsCases.testRunId, overlayIds), inArray(testRunsCases.status, FAIL_STATUSES))),
    );
    overlayAttempts = await db
      .select({
        executionId: testRunsCases.id,
        runId: testRunsCases.testRunId,
        testCaseId: testRunsCases.testCaseId,
        repeatEachIndex: testRunsCases.repeatEachIndex,
        retries: testRunsCases.retries,
        browserName: testRunsCases.browserName,
        status: testRunsCases.status,
        file: testCases.filePath,
        line: testRunsCases.line,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .where(
        and(
          inArray(testRunsCases.testRunId, overlayIds),
          failedBefore.length ? or(inArray(testRunsCases.testCaseId, failedBefore), failedInOverlay) : failedInOverlay,
        ),
      )
      .orderBy(asc(testCases.filePath), asc(testRunsCases.line), asc(testRunsCases.id));
  }
  const newer = new Map<string, OverlayAttempt>();
  for (const id of overlayIds) {
    const ofRun = overlayAttempts.filter((a) => a.runId === id).map((a) => ({ ...a, id: a.executionId }));
    for (const attempt of lastAttempts(ofRun)) {
      if (attempt.status !== 'passed' && !FAIL_STATUSES.includes(attempt.status)) continue;
      const key = testKey(attempt);
      const seen = newer.get(key);
      // Within a run, a repetition that failed decides over one that passed.
      if (!seen || (seen.runId === id && seen.status === 'passed' && attempt.status !== 'passed')) {
        newer.set(key, attempt);
      }
    }
  }
  const overlayRank = new Map(overlayIds.map((id, rank) => [id, rank]));
  const passes = [...newer.values()]
    .filter((a) => a.status === 'passed')
    .sort((a, b) => overlayRank.get(a.runId)! - overlayRank.get(b.runId)!);

  const listed: Listed[] = [];
  const resolved: BranchResolved[] = [];
  const fromOverlay = (later: OverlayAttempt, isNew: boolean): Listed => ({
    executionId: later.executionId,
    source: 'overlay',
    isNew,
    file: later.file,
    line: later.line,
  });
  for (const failure of baseline) {
    const later = newer.get(testKey(failure));
    if (!later) {
      const elsewhere = passes.find((p) => p.testCaseId === failure.testCaseId);
      listed.push({
        executionId: failure.executionId,
        source: 'baseline',
        isNew: !!failure.isNewRegression,
        ...(elsewhere
          ? { note: `passed${elsewhere.browserName ? ` on ${elsewhere.browserName}` : ''} in run #${elsewhere.runId}` }
          : {}),
        file: failure.file,
        line: failure.line,
      });
    } else if (later.status === 'passed') {
      resolved.push({
        testCaseId: failure.testCaseId,
        title: failure.title,
        file: failure.file,
        line: later.line ?? failure.line ?? null,
        browserName: failure.browserName ?? null,
        runId: later.runId,
        executionId: later.executionId,
        baselineExecutionId: failure.executionId,
      });
    } else {
      listed.push(fromOverlay(later, false));
    }
  }
  const failedKeys = new Set(baseline.map(testKey));
  for (const [key, later] of newer) {
    if (later.status !== 'passed' && !failedKeys.has(key)) listed.push(fromOverlay(later, true));
  }
  if (listed.some((l) => l.source === 'overlay')) {
    // In file order, then line order; the sort is stable, so equal places keep the order they were listed in.
    listed.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
  }
  const shown = listed.slice(0, MAX_BRANCH_FAILURES);

  const overlayShown = shown.filter((l) => l.source === 'overlay').map((l) => l.executionId);
  const rowsById = new Map<number, ExecutionRow>(
    [...baseline, ...(overlayShown.length ? await executions(inArray(testRunsCases.id, overlayShown)) : [])].map(
      (r) => [r.executionId, r],
    ),
  );

  const ids = shown.map((l) => l.executionId);
  const evidence =
    ids.length > 0
      ? await db
          .select({
            id: files.id,
            testRunsCaseId: files.testRunsCaseId,
            type: files.type,
            subtype: files.subtype,
            label: files.label,
            path: files.path,
          })
          .from(files)
          .where(and(inArray(files.testRunsCaseId, ids), inArray(files.type, EVIDENCE_TYPES)))
          .orderBy(desc(files.id))
      : [];
  const traces = new Map<number, string[]>();
  const caseShots = new Map<number, typeof evidence>();
  for (const f of evidence) {
    if (f.testRunsCaseId == null) continue;
    if (f.type === 'trace') traces.set(f.testRunsCaseId, [...(traces.get(f.testRunsCaseId) ?? []), f.path]);
    else if (isScreenshotFileRow(f)) caseShots.set(f.testRunsCaseId, [...(caseShots.get(f.testRunsCaseId) ?? []), f]);
  }
  // The page the test failed on when it is known, else the newest screenshot.
  const screenshots = new Map<number, string>();
  for (const [caseId, shots] of caseShots) screenshots.set(caseId, failurePageFirst(shots, (f) => f.subtype)[0]!.path);

  return {
    run: run ? branchRun(run) : null,
    overlays: overlayRuns.map(branchOverlay),
    failures: shown.map((l) => {
      const r = rowsById.get(l.executionId)!;
      return {
        executionId: r.executionId,
        testCaseId: r.testCaseId,
        clusterId: r.clusterId ?? null,
        title: r.title,
        file: r.file,
        line: r.line ?? null,
        status: r.status,
        headline: caseHeadline(r)?.headline ?? null,
        location: r.error ? extractErrorLocation(r.error) : null,
        message: errorMessage(r.error),
        frames: errorFrames(r.error),
        traces: (traces.get(r.executionId) ?? []).reverse(),
        screenshot: screenshots.get(r.executionId) ?? null,
        source: l.source,
        runId: r.runId,
        browserName: r.browserName ?? null,
        duration: r.duration ?? null,
        isNew: l.isNew,
        clusterTitle: r.clusterTitle ?? null,
        owner: r.owner ?? null,
        ...(l.note ? { note: l.note } : {}),
      };
    }),
    resolved: resolved.slice(0, MAX_BRANCH_FAILURES),
  };
}
