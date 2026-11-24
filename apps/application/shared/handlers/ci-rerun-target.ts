/**
 * The database reads a CI dispatch makes, shared by the server's dispatch
 * (`server/utils/ci-rerun.ts`) and the demo's: the place a source names (its
 * project, its tests and the run they come from, with that run's repository,
 * branch, environment and dispatch), the branches the project's runs reported,
 * and the values a CI server template is filled with. What a dispatch records
 * is `ci-dispatches.ts`. Nothing here sends a request.
 */
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { failureClusters, projects, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { normalizeGitUrl, repositoryUrlFromRemote } from '../../server/utils/scm/git-url';
import { mostCommonRunBranch } from '../../server/utils/scm/stored-default-branch';
import type { CiServerTarget, CiTemplateValues } from '#shared/ci-server';
import type { CiActionKind } from '#shared/ci-actions';
import { flakeLabCiArgs } from '#shared/ci-rerun';
import type { CiDispatchView } from '#shared/ci-dispatches';
import {
  ciDispatchSourceKind,
  ciServerTakesBranch,
  type CiDispatchSource,
  type CiDispatchStart,
} from '#shared/ci-dispatch-request';
import { buildRetryArgs, toPosixPath, type RetryCase } from '#shared/retry-command';
import { isVisibleRun, notLabRun, notPrivateRun, runCommit } from '#shared/run-eligibility';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';
import { clusterRerunCases, MAX_RERUN_TESTS } from './cluster-rerun-cases';
import { clusterLastDispatch, runDispatchAction, testLastFlakeLabDispatch } from './ci-dispatches';
import type { DrizzleDB } from './db';

/** An execution's run, cluster and the one case a re-run of it runs, or null when it does not exist. */
export async function executionRerunTarget(db: DrizzleDB, executionId: number) {
  const [row] = await db
    .select({
      projectId: testRuns.projectId,
      runId: testRunsCases.testRunId,
      clusterId: testRunsCases.failureClusterId,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
      title: testCases.title,
      filePath: testCases.filePath,
      origin: testRuns.origin,
      requesterId: testRuns.requesterId,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, executionId));
  if (!row) return null;
  const rerunCase: RetryCase = {
    filePath: row.filePath,
    title: row.title,
    line: row.line,
    projectName: row.projectName || null,
  };
  return {
    projectId: row.projectId,
    runId: row.runId,
    clusterId: row.clusterId,
    rerunCase,
    run: { origin: row.origin, requesterId: row.requesterId },
  };
}

/**
 * Each test that failed in a run, in each Playwright project it failed in, at
 * the line of its final attempt, by file and line, at most
 * {@link MAX_RERUN_TESTS} cases.
 */
export async function runFailedRerunCases(db: DrizzleDB, runId: number): Promise<RetryCase[]> {
  const rows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      line: testRunsCases.line,
      projectName: testRunsCases.browserName,
      title: testCases.title,
      filePath: testCases.filePath,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(
      and(
        eq(testRunsCases.testRunId, runId),
        eq(testRunsCases.finalAttempt, true),
        inArray(testRunsCases.status, [...FAILED_STATUS_KEYS]),
      ),
    )
    .orderBy(testCases.filePath, testRunsCases.line, testRunsCases.id)
    .limit(MAX_RERUN_TESTS * 10);
  const cases = new Map<string, RetryCase>();
  for (const r of rows) {
    const key = `${r.testCaseId}|${r.projectName ?? ''}`;
    if (cases.has(key)) continue;
    cases.set(key, { filePath: r.filePath, title: r.title, line: r.line, projectName: r.projectName || null });
    if (cases.size >= MAX_RERUN_TESTS) break;
  }
  return [...cases.values()];
}

/**
 * The run of a test's newest execution in a team run, whose repository and
 * branch a Flake Lab dispatch uses: a lab run and a private run are left out.
 */
async function latestTestRunId(db: DrizzleDB, testCaseId: number): Promise<number | null> {
  const [row] = await db
    .select({ testRunId: testRunsCases.testRunId })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(eq(testRunsCases.testCaseId, testCaseId), notLabRun(testRuns.origin)))
    .orderBy(desc(testRunsCases.id))
    .limit(1);
  return row?.testRunId ?? null;
}

/** The place a source names, and what a dispatch from it follows. */
export interface CiDispatchPlace {
  projectId: number;
  kind: CiActionKind;
  /** The run the tests come from, whose repository, branch, environment and dispatch a dispatch follows; null for the project's whole suite. */
  runId: number | null;
  /** The cluster a `tests` dispatch is recorded with, as its last re-run. */
  clusterId: number | null;
  /** The test of a Flake Lab dispatch. */
  testCaseId: number | null;
  /** The tests a `tests` dispatch runs; null for a whole suite and a Flake Lab experiment. */
  cases: RetryCase[] | null;
  /** The arguments handed to CI: the tests' `file:line` and projects, the `piwi flake` command, or none for a whole suite. */
  args: string;
  /** The repository a repository host's action dispatches to: the run's, else (the project's whole suite) the pinned one. */
  repositoryUrl: string | null;
  /** The environment the run's label resolved to, and the label. */
  environmentId: number | null;
  environment: string | null;
  /** The action whose dispatch started the run, and the values it sent. */
  started: CiDispatchStart | null;
  /** The branch a dispatch runs on when it names none: the run's, else (the project's whole suite) the project's default. */
  branch: string | null;
  /** The run's commit. */
  commit: string | null;
}

/** What {@link resolveCiDispatchPlace} found: the place, or why there is none (an id outside the project answers 404). */
export type CiDispatchPlaceResult =
  | { ok: true; place: CiDispatchPlace }
  | { ok: false; error: 'not-found' | 'invalid'; message: string };

const notFound = (what: string): CiDispatchPlaceResult => ({
  ok: false,
  error: 'not-found',
  message: `${what} not found`,
});

/** Whether a run is in the project and `viewerId` sees it (`isVisibleRun`): another person's private run is missing. */
async function runInProject(db: DrizzleDB, runId: number, projectId: number, viewerId: number | null) {
  const [run] = await db
    .select({ projectId: testRuns.projectId, origin: testRuns.origin, requesterId: testRuns.requesterId })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return Boolean(run && run.projectId === projectId && isVisibleRun(run, viewerId));
}

/**
 * The place a source names in a project: a cluster's affected tests on its
 * last run; an execution's test, or its cluster's affected tests, on its run;
 * a run's failed tests, or the whole suite on its branch; a test's Flake Lab
 * experiment on the run of its newest execution; or the project's whole suite
 * on its pinned repository and default branch. An id of another project, and
 * a run `viewerId` does not see, are not found.
 */
export async function resolveCiDispatchPlace(
  db: DrizzleDB,
  projectId: number,
  source: CiDispatchSource,
  viewerId: number | null,
): Promise<CiDispatchPlaceResult> {
  let runId: number | null = null;
  let clusterId: number | null = null;
  let testCaseId: number | null = null;
  let cases: RetryCase[] | null = null;
  let args = '';
  switch (source.from) {
    case 'cluster': {
      const [cluster] = await db
        .select({ projectId: failureClusters.projectId, lastSeenRunId: failureClusters.lastSeenRunId })
        .from(failureClusters)
        .where(eq(failureClusters.id, source.clusterId));
      if (!cluster || cluster.projectId !== projectId) return notFound('Failure cluster');
      runId = cluster.lastSeenRunId;
      clusterId = source.clusterId;
      cases = await clusterRerunCases(db, clusterId);
      break;
    }
    case 'execution': {
      const target = await executionRerunTarget(db, source.executionId);
      if (!target || target.projectId !== projectId || !isVisibleRun(target.run, viewerId)) {
        return notFound('Test run case');
      }
      runId = target.runId;
      clusterId = target.clusterId;
      if (source.scope === 'test') cases = [target.rerunCase];
      else if (clusterId == null) {
        return { ok: false, error: 'invalid', message: 'This execution belongs to no failure cluster.' };
      } else cases = await clusterRerunCases(db, clusterId);
      break;
    }
    case 'run-failed':
    case 'run-suite': {
      if (!(await runInProject(db, source.runId, projectId, viewerId))) return notFound('Test run');
      runId = source.runId;
      if (source.from === 'run-failed') {
        cases = await runFailedRerunCases(db, runId);
        if (cases.length === 0) return { ok: false, error: 'invalid', message: 'No test failed in this run.' };
      }
      break;
    }
    case 'flake-lab': {
      const [test] = await db
        .select({ projectId: testCases.projectId })
        .from(testCases)
        .where(eq(testCases.id, source.testCaseId));
      if (!test || test.projectId !== projectId) return notFound('Test case');
      testCaseId = source.testCaseId;
      runId = await latestTestRunId(db, testCaseId);
      args = flakeLabCiArgs(testCaseId, source.flakeLab);
      break;
    }
    case 'project':
      break;
  }
  if (cases) args = buildRetryArgs(cases);

  const place: CiDispatchPlace = {
    projectId,
    kind: ciDispatchSourceKind(source),
    runId,
    clusterId,
    testCaseId,
    cases,
    args,
    repositoryUrl: null,
    environmentId: null,
    environment: null,
    started: null,
    branch: null,
    commit: null,
  };
  if (runId != null) {
    const [run] = await db
      .select({
        metadata: testRuns.metadata,
        branch: testRuns.branch,
        environment: testRuns.environment,
        environmentId: testRuns.environmentId,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    const remoteUrl = (run?.metadata as { scm?: { remoteUrl?: string | null } } | null)?.scm?.remoteUrl;
    place.repositoryUrl = normalizeGitUrl(remoteUrl ?? null);
    place.environmentId = run?.environmentId ?? null;
    place.environment = run?.environment?.trim() || null;
    place.branch = run ? (run.branch ?? resolveRunBranch(run.metadata) ?? null) : null;
    place.commit = run ? (runCommit(run.metadata) ?? null) : null;
    place.started = await runDispatchAction(db, runId);
  } else if (source.from === 'project') {
    const [project] = await db
      .select({ repositoryUrl: projects.repositoryUrl, defaultBranch: projects.defaultBranch })
      .from(projects)
      .where(eq(projects.id, projectId));
    place.repositoryUrl = repositoryUrlFromRemote(project?.repositoryUrl);
    place.branch = project?.defaultBranch?.trim() || (await mostCommonRunBranch(db, projectId));
  }
  return { ok: true, place };
}

/** A place's last dispatch the provider took: its cluster's last re-run, its test's last Flake Lab one, else none. */
export async function ciPlaceLastDispatch(db: DrizzleDB, place: CiDispatchPlace): Promise<CiDispatchView | null> {
  if (place.kind === 'flakeLab' && place.testCaseId != null) return testLastFlakeLabDispatch(db, place.testCaseId);
  if (place.kind === 'tests') return clusterLastDispatch(db, place.clusterId);
  return null;
}

/** How many of a project's run branches a branch list reads. */
const RUN_BRANCHES_READ = 500;

/** The branches a project's runs reported, the most recently run first; another person's private run left out. */
export async function projectRunBranches(db: DrizzleDB, projectId: number): Promise<string[]> {
  const rows = await db
    .select({ branch: testRuns.branch })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        isNotNull(testRuns.branch),
        ne(testRuns.branch, ''),
        notPrivateRun(testRuns.origin),
      ),
    )
    .groupBy(testRuns.branch)
    .orderBy(sql`max(${testRuns.id}) desc`)
    .limit(RUN_BRANCHES_READ);
  return rows.map((r) => r.branch?.trim() ?? '').filter(Boolean);
}

/**
 * The values a CI server template is filled with: the branch asked, else the
 * target's `ref` field; none for a request that names no branch, whose job
 * runs its configured branch, so its dispatch records none.
 */
export function ciServerTemplateValues(
  target: CiServerTarget,
  args: string,
  dispatchId: string,
  ref: string | null,
  commit: string | null,
): CiTemplateValues {
  const branch = ciServerTakesBranch(target) ? (ref ?? target.rerun.ref ?? '') : '';
  return { args, dispatchId, ref: branch, commit: commit ?? '' };
}

/** The spec files a dispatch re-runs, as its record lists them. */
export function rerunFiles(cases: RetryCase[]): string[] {
  return [...new Set(cases.map((c) => toPosixPath(c.filePath)))].sort();
}
