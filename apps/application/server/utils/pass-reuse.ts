/**
 * Pass reuse: plan which tests of a selection a run skips, because an earlier
 * pass ran their code and the code has not changed since.
 *
 * A **source** of a test is its newest run, at most 14 days old, from a clean
 * checkout of a commit with the planned run's Playwright version, in which every
 * one of its results passed on its first attempt with complete coverage naming
 * its file versions. A test is **reused** when it has a source at commit _C_,
 * the impact of the change _C_ → working tree does not select it and does not
 * widen to the whole suite, and no file the source's coverage names is among
 * the changed files. It is skipped only in the Playwright projects its source
 * ran it in; every other project runs it. A test that is quarantined, in an open
 * failure cluster, failed or was retried in its last 20 executions of the last
 * 90 days on any branch, or tagged `@no-reuse`, always runs.
 *
 * A plan names the tests to skip, never the tests to run, so a test the
 * dashboard has not seen yet (new, renamed, moved) runs. Uncertainty runs the
 * test: no source, a source commit the client could not diff, an unmapped
 * change, a name a test list cannot state exactly.
 */
import path from 'node:path';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { sameFilePath } from '@piwitests/core/locator-break';
import {
  coverageFragments,
  failureClusters,
  reusedResults,
  runPlans,
  testCases,
  testRuns,
  testRunsCases,
} from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleRunSql, runCommit } from '#shared/run-eligibility';
import { runPlanId } from '#shared/run-plan';
import { getQuarantinedCaseIds } from '#shared/handlers/quarantine';
import { getSelection, resolveSelectionDefinition } from '#shared/handlers/selections';
import { splitSuitePath } from '#shared/utils/suites';
import { finalAttempts, isFailedStatus } from '#shared/utils/test-counts';
import type { ResolvedSelection, ResolvedTest, SelectionDefinition } from '#shared/selection';
import { resolveCasePayloadContents } from './case-payloads';
import { parseCoveragePayload } from './coverage';
import { resolveImpact, type ImpactChange } from './selection-impact';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The oldest pass that may stand in for a test. */
export const MAX_SOURCE_AGE_MS = 14 * DAY_MS;
/** How long a stored plan stays readable. */
export const PLAN_TTL_MS = DAY_MS;
/** Source commits a plan diffs against at most; tests whose source is on another commit run. */
export const MAX_SOURCE_COMMITS = 8;
/** Executions of a test read for the flaky exclusion, on any branch, within `FLAKY_LOOKBACK_MS`. */
export const FLAKY_WINDOW = 20;
export const FLAKY_LOOKBACK_MS = 90 * DAY_MS;
/** The tag that keeps a test out of reuse. */
export const NO_REUSE_TAG = 'no-reuse';
/** The selection key that plans the whole suite. */
export const FULL_SELECTION_KEY = 'full';
/** The separator of a Playwright test list line. */
const TEST_LIST_SEP = ' › ';
const ID_CHUNK = 500;

/** Why a test of a plan runs, or that it is reused. */
export type PlanReason =
  | 'reused'
  | 'no-source'
  | 'quarantined'
  | 'open-cluster'
  | 'flaky'
  | 'no-reuse-tag'
  | 'commit-unavailable'
  | 'widened'
  | 'changed'
  | 'serial';

/** What the planned run must match in a source: its Playwright version; null finds no source. */
export interface ReuseFingerprint {
  playwrightVersion: string | null;
}

/** A test's newest source. */
export interface TestSource {
  testCaseId: number;
  runId: number;
  commit: string;
  startedAt: number;
  /** Its final attempts, one per Playwright project and repetition. */
  executionIds: number[];
  /** The Playwright projects it passed in. */
  projects: string[];
  /** Playwright's root in its run, relative to the folder test paths are stored from: what test lists name files from. */
  rootDir: string;
  /** The spec files of its run holding a serial group, whose tests are never skipped one by one. */
  serialFiles: ReadonlySet<string>;
  /** The files its coverage names, over every result. */
  files: string[];
}

/** The change from one source commit to the working tree, as the client computed it. */
export interface SourceDiff {
  commit: string;
  changedFiles: string[];
  changes: ImpactChange[];
}

export interface ReusedTest {
  testCaseId: number;
  sourceRunId: number;
  sourceCommit: string;
  sourceExecutionIds: number[];
  /** The Playwright projects it is skipped in. */
  projects: string[];
  /** Its lines of the Playwright test list to skip, one per project. */
  skip: string[];
}

/** A plan as stored in `run_plans.plan`. */
export interface StoredRunPlan {
  selection: { key: string; version: number | null };
  /** The Playwright arguments of the selection; none for the whole suite. */
  args: string[];
  /** The selection's tests that run. */
  run: number[];
  reused: ReusedTest[];
  /** How many tests each reason accounts for. */
  reasons: Partial<Record<PlanReason, number>>;
  fingerprint: ReuseFingerprint;
  /** Whether the checkout the plan was made in matched its commit; a run elsewhere uses a plan of a clean one only. */
  worktree: 'clean' | 'dirty' | null;
}

export class PassReuseError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** The definition a selection key plans: the whole suite for `full`, else the saved or built-in selection's. */
async function planDefinition(
  db: DrizzleDB,
  projectId: number,
  key: string,
): Promise<{ definition: SelectionDefinition; version: number | null }> {
  if (key === FULL_SELECTION_KEY) return { definition: {}, version: null };
  const selection = await getSelection(db, projectId, key);
  if (!selection) throw new PassReuseError(404, `No selection "${key}" in this project`);
  return { definition: selection.definition, version: selection.version };
}

/** The candidate tests that always run, each with its reason. */
async function exclusions(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
  now: Date,
): Promise<Map<number, PlanReason>> {
  const out = new Map<number, PlanReason>();
  const quarantined = await getQuarantinedCaseIds(db, projectId);
  for (const id of testCaseIds) if (quarantined.has(id)) out.set(id, 'quarantined');

  for (let i = 0; i < testCaseIds.length; i += ID_CHUNK) {
    const chunk = testCaseIds.slice(i, i + ID_CHUNK);
    const tagged = await db
      .select({ id: testCases.id, tags: testCases.tags })
      .from(testCases)
      .where(inArray(testCases.id, chunk));
    for (const row of tagged) {
      const tags = Array.isArray(row.tags) ? (row.tags as unknown[]) : [];
      if (!out.has(row.id) && tags.some((t) => typeof t === 'string' && t.replace(/^@/, '') === NO_REUSE_TAG)) {
        out.set(row.id, 'no-reuse-tag');
      }
    }

    const inOpenCluster = await db
      .selectDistinct({ id: testRunsCases.testCaseId })
      .from(testRunsCases)
      .innerJoin(failureClusters, eq(failureClusters.id, testRunsCases.failureClusterId))
      .where(and(inArray(testRunsCases.testCaseId, chunk), eq(failureClusters.status, 'open')));
    for (const row of inOpenCluster) if (!out.has(row.id)) out.set(row.id, 'open-cluster');

    const ranked = db.$with('ranked').as(
      db
        .select({
          testCaseId: testRunsCases.testCaseId,
          status: testRunsCases.status,
          passedAfterFailure: testRunsCases.passedAfterFailure,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${testRunsCases.testCaseId} ORDER BY ${testRunsCases.createdAt} DESC, ${testRunsCases.id} DESC)`.as(
            'rn',
          ),
        })
        .from(testRunsCases)
        .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
        .where(
          and(
            inArray(testRunsCases.testCaseId, chunk),
            gte(testRunsCases.createdAt, new Date(now.getTime() - FLAKY_LOOKBACK_MS)),
            eligibleRunSql('pass-reuse'),
          ),
        ),
    );
    const recent = await db
      .with(ranked)
      .select({ testCaseId: ranked.testCaseId, status: ranked.status, passedAfterFailure: ranked.passedAfterFailure })
      .from(ranked)
      .where(sql`${ranked.rn} <= ${FLAKY_WINDOW}`);
    for (const row of recent) {
      const unstable = isFailedStatus(row.status) || row.passedAfterFailure;
      if (unstable && !out.has(row.testCaseId)) out.set(row.testCaseId, 'flaky');
    }
  }
  return out;
}

/** The files a coverage payload names, or null when it cannot vouch for a test: missing, incomplete, or without blobs. */
async function payloadFiles(db: DrizzleDB, payloadIds: number[]): Promise<Map<number, string[] | null>> {
  const contents = await resolveCasePayloadContents(db, payloadIds);
  const parsed = new Map<number, number[] | null>();
  for (const id of payloadIds) {
    const payload = parseCoveragePayload(contents.get(id));
    parsed.set(id, payload && !payload.incomplete && payload.fragmentIds.length > 0 ? payload.fragmentIds : null);
  }
  const fragmentIds = [...new Set([...parsed.values()].flatMap((ids) => ids ?? []))];
  const fragments = new Map<number, { path: string; blob: string | null }>();
  for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: coverageFragments.id, path: coverageFragments.path, blob: coverageFragments.blob })
      .from(coverageFragments)
      .where(inArray(coverageFragments.id, fragmentIds.slice(i, i + ID_CHUNK)));
    for (const row of rows) fragments.set(row.id, { path: row.path, blob: row.blob });
  }
  const out = new Map<number, string[] | null>();
  for (const [payloadId, ids] of parsed) {
    if (!ids) {
      out.set(payloadId, null);
      continue;
    }
    const files: string[] = [];
    let complete = true;
    for (const id of ids) {
      const fragment = fragments.get(id);
      if (!fragment?.blob) {
        complete = false;
        break;
      }
      files.push(normalizePath(fragment.path));
    }
    out.set(payloadId, complete ? files : null);
  }
  return out;
}

interface SourceRun {
  commit: string;
  startedAt: number;
  rootDir: string;
  serialFiles: ReadonlySet<string>;
}

/** The project's runs that may hold sources: the last 14 days, clean, at a commit, with the planned Playwright version. */
async function sourceRuns(
  db: DrizzleDB,
  projectId: number,
  fingerprint: ReuseFingerprint,
  now: Date,
): Promise<Map<number, SourceRun>> {
  const runs = new Map<number, SourceRun>();
  if (!fingerprint.playwrightVersion) return runs;
  const rows = await db
    .select({ id: testRuns.id, startTime: testRuns.startTime, metadata: testRuns.metadata })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        gte(testRuns.startTime, new Date(now.getTime() - MAX_SOURCE_AGE_MS)),
        eq(testRuns.playwrightVersion, fingerprint.playwrightVersion),
        eligibleRunSql('pass-reuse'),
      ),
    );
  for (const row of rows) {
    const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : {};
    const scm = meta.scm && typeof meta.scm === 'object' ? (meta.scm as Record<string, unknown>) : {};
    const config =
      meta.htmlReport && typeof meta.htmlReport === 'object' ? (meta.htmlReport as Record<string, unknown>) : {};
    const commit = runCommit(row.metadata);
    const serial = config.serialFiles;
    if (scm.worktree === 'clean' && commit && typeof config.rootDir === 'string' && Array.isArray(serial)) {
      runs.set(row.id, {
        commit,
        startedAt: row.startTime.getTime(),
        rootDir: config.rootDir,
        serialFiles: new Set(serial.filter((f): f is string => typeof f === 'string').map(normalizePath)),
      });
    }
  }
  return runs;
}

/** Each candidate test's newest source. */
export async function findReuseSources(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
  fingerprint: ReuseFingerprint,
  now: Date = new Date(),
): Promise<Map<number, TestSource>> {
  const runs = await sourceRuns(db, projectId, fingerprint, now);
  const wanted = new Set(testCaseIds);
  const runIds = [...runs.keys()];
  const rows: Array<{
    id: number;
    runId: number;
    testCaseId: number;
    browserName: string | null;
    repeatEachIndex: number;
    retries: number | null;
    status: string;
    passedAfterFailure: boolean;
    payloadId: number | null;
  }> = [];
  for (let i = 0; i < runIds.length; i += ID_CHUNK) {
    const found = await db
      .select({
        id: testRunsCases.id,
        runId: testRunsCases.testRunId,
        testCaseId: testRunsCases.testCaseId,
        browserName: testRunsCases.browserName,
        repeatEachIndex: testRunsCases.repeatEachIndex,
        retries: testRunsCases.retries,
        status: testRunsCases.status,
        passedAfterFailure: testRunsCases.passedAfterFailure,
        payloadId: testRunsCases.coveragePayloadId,
      })
      .from(testRunsCases)
      .where(inArray(testRunsCases.testRunId, runIds.slice(i, i + ID_CHUNK)));
    for (const row of found) if (wanted.has(row.testCaseId)) rows.push(row);
  }

  // Each test's results per run, then its newest run.
  const byTest = new Map<number, Map<number, typeof rows>>();
  for (const row of rows) {
    const perRun = byTest.get(row.testCaseId) ?? new Map<number, typeof rows>();
    const list = perRun.get(row.runId);
    if (list) list.push(row);
    else perRun.set(row.runId, [row]);
    byTest.set(row.testCaseId, perRun);
  }
  const newest = new Map<number, { runId: number; finals: typeof rows }>();
  for (const [testCaseId, perRun] of byTest) {
    const [runId, attempts] = [...perRun].sort((a, b) => runs.get(b[0])!.startedAt - runs.get(a[0])!.startedAt)[0]!;
    const finals = finalAttempts(attempts);
    const passedFirst = finals.every(
      (r) => r.status === 'passed' && !r.passedAfterFailure && (r.retries ?? 0) === 0 && r.browserName,
    );
    if (passedFirst) newest.set(testCaseId, { runId, finals });
  }

  const files = await payloadFiles(db, [
    ...new Set(
      [...newest.values()].flatMap((n) => n.finals.flatMap((r) => (r.payloadId == null ? [] : [r.payloadId]))),
    ),
  ]);
  const sources = new Map<number, TestSource>();
  for (const [testCaseId, { runId, finals }] of newest) {
    const covered = finals.map((r) => (r.payloadId == null ? null : (files.get(r.payloadId) ?? null)));
    if (covered.some((f) => f == null || f.length === 0)) continue;
    const run = runs.get(runId)!;
    sources.set(testCaseId, {
      testCaseId,
      runId,
      commit: run.commit,
      startedAt: run.startedAt,
      executionIds: finals.map((r) => r.id),
      projects: [...new Set(finals.map((r) => r.browserName!))],
      rootDir: run.rootDir,
      serialFiles: run.serialFiles,
      files: [...new Set(covered.flat() as string[])],
    });
  }
  return sources;
}

/** The source commits worth diffing: at most `MAX_SOURCE_COMMITS`, those that cover the most tests first. */
export function chooseSourceCommits(sources: Iterable<TestSource>): Array<{ commit: string; tests: number }> {
  const counts = new Map<string, number>();
  for (const source of sources) counts.set(source.commit, (counts.get(source.commit) ?? 0) + 1);
  return [...counts]
    .map(([commit, tests]) => ({ commit, tests }))
    .sort((a, b) => b.tests - a.tests || a.commit.localeCompare(b.commit))
    .slice(0, MAX_SOURCE_COMMITS);
}

/** A test's title path in a Playwright test list: its describes and title. */
function titlePath(test: Pick<ResolvedTest, 'suitePath' | 'title'>): string[] {
  return [...splitSuitePath(test.suitePath), test.title];
}

/** A name part a test list line cannot hold exactly: empty, padded (Playwright trims each part), or with a separator. */
function badListPart(part: string): boolean {
  return !part.trim() || part !== part.trim() || /[›>\r\n]/.test(part);
}

/**
 * The tests a test list cannot name exactly: a name holding a list separator or
 * a line break or padded with spaces, or a title path that is also the start of
 * another test's (a describe named like a test beside it), which a list line
 * would skip too.
 */
export function unnameable(
  tests: Array<Pick<ResolvedTest, 'testCaseId' | 'filePath' | 'suitePath' | 'title'>>,
): Set<number> {
  const prefixes = new Set<string>();
  for (const test of tests) {
    const path = [normalizePath(test.filePath), ...titlePath(test)];
    for (let i = 1; i < path.length; i++) prefixes.add(path.slice(0, i).join('\x1f'));
  }
  const out = new Set<number>();
  for (const test of tests) {
    const path = [normalizePath(test.filePath), ...titlePath(test)];
    const unsafe = path.some(badListPart);
    if (unsafe || prefixes.has(path.join('\x1f'))) out.add(test.testCaseId);
  }
  return out;
}

/** The test list lines that skip a test in each of `projects`, its file named from Playwright's root `rootDir`. */
export function skipLines(test: ResolvedTest, projects: string[], rootDir: string): string[] {
  // Both under one deep base, so a `..` never climbs past the filesystem root.
  const base = `/${'d/'.repeat(32)}`;
  const file = path.posix.relative(
    path.posix.join(base, normalizePath(rootDir)),
    path.posix.join(base, normalizePath(test.filePath)),
  );
  const rest = [file, ...titlePath(test)].join(TEST_LIST_SEP);
  return projects.map((project) => `[${project}]${TEST_LIST_SEP}${rest}`);
}

/** The candidate tests of a selection, the ones that always run, and the sources of the others. */
async function planInputs(db: DrizzleDB, projectId: number, key: string, fingerprint: ReuseFingerprint, now: Date) {
  const { definition, version } = await planDefinition(db, projectId, key);
  const resolved = await resolveSelectionDefinition(db, projectId, definition, { key, version, format: 'args' });
  const candidates = resolved.tests.map((t) => t.testCaseId);
  const excluded = await exclusions(db, projectId, candidates, now);
  const sources = await findReuseSources(
    db,
    projectId,
    candidates.filter((id) => !excluded.has(id)),
    fingerprint,
    now,
  );
  return { resolved, version, candidates, excluded, sources };
}

/** The source commits a client should diff its working tree against, for `piwi plan`. */
export async function getPlanSourceCommits(
  db: DrizzleDB,
  projectId: number,
  key: string,
  fingerprint: ReuseFingerprint,
  now: Date = new Date(),
): Promise<{ candidates: number; commits: Array<{ commit: string; tests: number }> }> {
  const { candidates, sources } = await planInputs(db, projectId, key, fingerprint, now);
  return { candidates: candidates.length, commits: chooseSourceCommits(sources.values()) };
}

/** Decide each test of a selection, from the client's diffs against its source commits. */
export async function decideRunPlan(
  db: DrizzleDB,
  projectId: number,
  key: string,
  fingerprint: ReuseFingerprint,
  diffs: SourceDiff[],
  now: Date = new Date(),
  worktree: 'clean' | 'dirty' | null = null,
): Promise<{ plan: StoredRunPlan; resolved: ResolvedSelection }> {
  const { resolved, version, excluded, sources } = await planInputs(db, projectId, key, fingerprint, now);
  const chosen = new Set(chooseSourceCommits(sources.values()).map((c) => c.commit));
  // Over every test of the project: a selection's arguments can run tests beyond it that a line would also skip.
  const unnamed = unnameable(
    await db
      .select({
        testCaseId: testCases.id,
        filePath: testCases.filePath,
        suitePath: testCases.suitePath,
        title: testCases.title,
      })
      .from(testCases)
      .where(eq(testCases.projectId, projectId)),
  );

  // Per source commit: the tests its change impacts, or null when the change widens to the whole suite.
  const impactByCommit = new Map<string, { impacted: Set<number>; changed: string[] } | null>();
  for (const diff of diffs) {
    if (!chosen.has(diff.commit) || impactByCommit.has(diff.commit)) continue;
    const changed = [...new Set(diff.changedFiles.map(normalizePath).filter(Boolean))];
    if (changed.length === 0) {
      impactByCommit.set(diff.commit, { impacted: new Set(), changed });
      continue;
    }
    const impact = await resolveImpact(db, projectId, changed, { changes: diff.changes });
    impactByCommit.set(
      diff.commit,
      impact.impact.widened ? null : { impacted: new Set(impact.tests.map((t) => t.testCaseId)), changed },
    );
  }

  const fileOf = new Map(resolved.tests.map((t) => [t.testCaseId, t.filePath]));
  function decide(testCaseId: number): PlanReason {
    const exclusion = excluded.get(testCaseId);
    if (exclusion) return exclusion;
    const source = sources.get(testCaseId);
    if (!source || unnamed.has(testCaseId) || source.projects.some(badListPart)) return 'no-source';
    if (source.serialFiles.has(normalizePath(fileOf.get(testCaseId)!))) return 'serial';
    if (!impactByCommit.has(source.commit)) return 'commit-unavailable';
    const impact = impactByCommit.get(source.commit);
    if (!impact) return 'widened';
    if (impact.impacted.has(testCaseId)) return 'changed';
    if (source.files.some((file) => impact.changed.some((changed) => sameFilePath(file, changed)))) return 'changed';
    return 'reused';
  }

  const run: number[] = [];
  const reused: ReusedTest[] = [];
  const reasons: Partial<Record<PlanReason, number>> = {};
  for (const test of resolved.tests) {
    const reason = decide(test.testCaseId);
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (reason !== 'reused') {
      run.push(test.testCaseId);
      continue;
    }
    const source = sources.get(test.testCaseId)!;
    reused.push({
      testCaseId: test.testCaseId,
      sourceRunId: source.runId,
      sourceCommit: source.commit,
      sourceExecutionIds: source.executionIds,
      projects: source.projects,
      skip: skipLines(test, source.projects, source.rootDir),
    });
  }

  const args = key === FULL_SELECTION_KEY ? [] : resolved.materialization.args;
  return { plan: { selection: { key, version }, args, run, reused, reasons, fingerprint, worktree }, resolved };
}

/** Store a plan, deleting the project's expired ones; returns its id and expiry. */
export async function storeRunPlan(
  db: DrizzleDB,
  projectId: number,
  plan: StoredRunPlan,
  meta: { commit: string | null; branch: string | null; createdBy: number | null },
  now: Date = new Date(),
): Promise<{ id: number; expiresAt: Date }> {
  await db.delete(runPlans).where(and(eq(runPlans.projectId, projectId), lt(runPlans.expiresAt, now)));
  const expiresAt = new Date(now.getTime() + PLAN_TTL_MS);
  const [row] = await db
    .insert(runPlans)
    .values({
      projectId,
      selectionKey: plan.selection.key,
      commit: meta.commit,
      branch: meta.branch,
      plan,
      createdBy: meta.createdBy,
      createdAt: now,
      expiresAt,
    })
    .returning({ id: runPlans.id });
  return { id: row!.id, expiresAt };
}

/** A stored plan of a project that has not expired, or null. */
export async function getRunPlan(
  db: DrizzleDB,
  projectId: number,
  planId: number,
  now: Date = new Date(),
): Promise<{ id: number; plan: StoredRunPlan; commit: string | null; expiresAt: Date } | null> {
  const [row] = await db
    .select({ id: runPlans.id, plan: runPlans.plan, commit: runPlans.commit, expiresAt: runPlans.expiresAt })
    .from(runPlans)
    .where(and(eq(runPlans.id, planId), eq(runPlans.projectId, projectId)));
  if (!row || row.expiresAt.getTime() < now.getTime()) return null;
  return { id: row.id, plan: row.plan as StoredRunPlan, commit: row.commit, expiresAt: row.expiresAt };
}

/**
 * Record the tests a finished run skipped under its plan as its reused results,
 * and their count on the run. A test counts only when the run executed it in
 * none of the projects the plan skipped it in, and only when the run is at the
 * plan's commit: a run elsewhere, or a list Playwright did not apply, records
 * nothing. Idempotent: a run finalized again keeps one row per test.
 */
export async function attachRunPlan(
  db: DrizzleDB,
  runId: number,
  run: { projectId: number; metadata?: unknown },
): Promise<number> {
  const planId = runPlanId(run.metadata);
  if (planId === null) return 0;
  const [row] = await db
    .select({ plan: runPlans.plan, commit: runPlans.commit })
    .from(runPlans)
    .where(and(eq(runPlans.id, planId), eq(runPlans.projectId, run.projectId)));
  if (!row?.commit || row.commit !== runCommit(run.metadata)) return 0;
  const plan = row.plan as StoredRunPlan;
  if (plan.reused.length === 0) return 0;

  const executed = new Set(
    (
      await db
        .selectDistinct({ testCaseId: testRunsCases.testCaseId, browserName: testRunsCases.browserName })
        .from(testRunsCases)
        .where(eq(testRunsCases.testRunId, runId))
    ).map((r) => `${r.testCaseId}\x00${r.browserName ?? ''}`),
  );
  const skipped = plan.reused.filter(
    (r) => !r.projects.some((project) => executed.has(`${r.testCaseId}\x00${project}`)),
  );
  for (let i = 0; i < skipped.length; i += ID_CHUNK) {
    await db
      .insert(reusedResults)
      .values(
        skipped.slice(i, i + ID_CHUNK).map((r) => ({
          runId,
          testCaseId: r.testCaseId,
          projects: r.projects,
          sourceRunId: r.sourceRunId,
          sourceExecutionIds: r.sourceExecutionIds,
          sourceCommit: r.sourceCommit,
          planId,
        })),
      )
      .onConflictDoNothing({ target: [reusedResults.runId, reusedResults.testCaseId] });
  }
  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(reusedResults)
    .where(eq(reusedResults.runId, runId));
  const count = Number(counted?.count ?? 0);
  await db.update(testRuns).set({ reusedCount: count }).where(eq(testRuns.id, runId));
  return count;
}
