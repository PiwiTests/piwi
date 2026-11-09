/**
 * Pass reuse: plan which tests of a selection a run executes, and which it
 * reuses from an earlier pass whose code has not changed.
 *
 * A **source** of a test is its newest run, at most 14 days old, in which every
 * one of its results (each Playwright project and repetition) passed on its
 * first attempt with complete coverage naming its file versions, from a clean
 * checkout of a commit, with the same Playwright version as the planned run.
 * A test is **reused** when it has a source at commit _C_, the impact of the
 * change _C_ → working tree does not select it and does not widen to the whole
 * suite, and no file the source's coverage names is among the changed files. A
 * test that is quarantined, in an open failure cluster, failed or was retried
 * in its last 20 executions on any branch, or tagged `@no-reuse`, always runs.
 *
 * Uncertainty runs the test: no source, a source commit the client could not
 * diff, an unmapped change.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { sameFilePath } from '@piwitests/core/locator-break';
import { coverageFragments, failureClusters, runPlans, testCases, testRuns, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleRunSql, runCommit } from '#shared/run-eligibility';
import { getQuarantinedCaseIds } from '#shared/handlers/quarantine';
import { getSelection, resolveSelectionDefinition } from '#shared/handlers/selections';
import { finalAttempts, isFailedStatus } from '#shared/utils/test-counts';
import type { ResolvedSelection, SelectionDefinition, SelectionFormat, SelectionRankBy } from '#shared/selection';
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
/** Executions of a test read for the flaky exclusion, on any branch. */
export const FLAKY_WINDOW = 20;
/** The tag that keeps a test out of reuse. */
export const NO_REUSE_TAG = 'no-reuse';
/** The selection key that plans the whole suite. */
export const FULL_SELECTION_KEY = 'full';
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
  | 'changed';

/** What the planned run must match in a source: the Playwright version, when the client knows it. */
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
}

/** A plan as stored in `run_plans.plan`. */
export interface StoredRunPlan {
  selection: { key: string; version: number | null };
  /** The tests the run executes. */
  run: number[];
  reused: ReusedTest[];
  /** How many tests each reason accounts for. */
  reasons: Partial<Record<PlanReason, number>>;
  fingerprint: ReuseFingerprint;
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
async function exclusions(db: DrizzleDB, projectId: number, testCaseIds: number[]): Promise<Map<number, PlanReason>> {
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
        .where(and(inArray(testRunsCases.testCaseId, chunk), eligibleRunSql('pass-reuse'))),
    );
    const recent = await db
      .with(ranked)
      .select({
        testCaseId: ranked.testCaseId,
        status: ranked.status,
        passedAfterFailure: ranked.passedAfterFailure,
      })
      .from(ranked)
      .where(sql`${ranked.rn} <= ${FLAKY_WINDOW}`);
    for (const row of recent) {
      const unstable = isFailedStatus(row.status) || row.passedAfterFailure;
      if (unstable && !out.has(row.testCaseId)) out.set(row.testCaseId, 'flaky');
    }
  }
  return out;
}

interface SourceRow {
  id: number;
  runId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number | null;
  status: string;
  passedAfterFailure: boolean;
  payloadId: number | null;
  startTime: Date;
  metadata: unknown;
}

/** Whether a run came from a clean checkout of a commit, with the Playwright version of the planned run. */
function runQualifies(metadata: unknown, fingerprint: ReuseFingerprint): boolean {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const scm = meta.scm && typeof meta.scm === 'object' ? (meta.scm as Record<string, unknown>) : {};
  if (scm.worktree !== 'clean') return false;
  if (fingerprint.playwrightVersion && meta.playwrightVersion !== fingerprint.playwrightVersion) return false;
  return true;
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

/** Each candidate test's newest source, among the project's runs of the last 14 days. */
export async function findReuseSources(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
  fingerprint: ReuseFingerprint,
  now: Date = new Date(),
): Promise<Map<number, TestSource>> {
  const rows: SourceRow[] = [];
  for (let i = 0; i < testCaseIds.length; i += ID_CHUNK) {
    rows.push(
      ...(await db
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
          startTime: testRuns.startTime,
          metadata: testRuns.metadata,
        })
        .from(testRuns)
        .innerJoin(testRunsCases, eq(testRunsCases.testRunId, testRuns.id))
        .where(
          and(
            eq(testRuns.projectId, projectId),
            gte(testRuns.startTime, new Date(now.getTime() - MAX_SOURCE_AGE_MS)),
            eligibleRunSql('pass-reuse'),
            inArray(testRunsCases.testCaseId, testCaseIds.slice(i, i + ID_CHUNK)),
          ),
        )
        .orderBy(desc(testRuns.startTime), desc(testRuns.id))),
    );
  }

  const byTestRun = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const key = `${row.testCaseId}\x00${row.runId}`;
    const list = byTestRun.get(key);
    if (list) list.push(row);
    else byTestRun.set(key, [row]);
  }
  const files = await payloadFiles(db, [...new Set(rows.flatMap((r) => (r.payloadId == null ? [] : [r.payloadId])))]);

  const sources = new Map<number, TestSource>();
  for (const attempts of byTestRun.values()) {
    const first = attempts[0]!;
    const known = sources.get(first.testCaseId);
    if (known && known.startedAt >= first.startTime.getTime()) continue;
    const commit = runCommit(first.metadata);
    if (!commit || !runQualifies(first.metadata, fingerprint)) continue;
    const finals = finalAttempts(attempts);
    const passedFirst = finals.every((r) => r.status === 'passed' && !r.passedAfterFailure && (r.retries ?? 0) === 0);
    if (!passedFirst) continue;
    const covered = finals.map((r) => (r.payloadId == null ? null : (files.get(r.payloadId) ?? null)));
    if (covered.some((f) => f == null || f.length === 0)) continue;
    sources.set(first.testCaseId, {
      testCaseId: first.testCaseId,
      runId: first.runId,
      commit,
      startedAt: first.startTime.getTime(),
      executionIds: finals.map((r) => r.id),
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

/** The candidate tests of a selection, the ones that always run, and the sources of the others. */
async function planInputs(db: DrizzleDB, projectId: number, key: string, fingerprint: ReuseFingerprint, now: Date) {
  const { definition, version } = await planDefinition(db, projectId, key);
  const resolved = await resolveSelectionDefinition(db, projectId, definition, { key, version });
  const candidates = resolved.tests.map((t) => t.testCaseId);
  const excluded = await exclusions(db, projectId, candidates);
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
): Promise<{ plan: StoredRunPlan; resolved: ResolvedSelection }> {
  const { resolved, version, candidates, excluded, sources } = await planInputs(db, projectId, key, fingerprint, now);
  const chosen = new Set(chooseSourceCommits(sources.values()).map((c) => c.commit));

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

  const run: number[] = [];
  const reused: ReusedTest[] = [];
  const reasons: Partial<Record<PlanReason, number>> = {};
  const count = (reason: PlanReason) => (reasons[reason] = (reasons[reason] ?? 0) + 1);
  for (const testCaseId of candidates) {
    const reason = decide(testCaseId);
    count(reason);
    if (reason !== 'reused') {
      run.push(testCaseId);
      continue;
    }
    const source = sources.get(testCaseId)!;
    reused.push({
      testCaseId,
      sourceRunId: source.runId,
      sourceCommit: source.commit,
      sourceExecutionIds: source.executionIds,
    });
  }

  function decide(testCaseId: number): PlanReason {
    const exclusion = excluded.get(testCaseId);
    if (exclusion) return exclusion;
    const source = sources.get(testCaseId);
    if (!source) return 'no-source';
    if (!impactByCommit.has(source.commit)) return 'commit-unavailable';
    const impact = impactByCommit.get(source.commit);
    if (!impact) return 'widened';
    if (impact.impacted.has(testCaseId)) return 'changed';
    if (source.files.some((file) => impact.changed.some((changed) => sameFilePath(file, changed)))) return 'changed';
    return 'reused';
  }

  return { plan: { selection: { key, version }, run, reused, reasons, fingerprint }, resolved };
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

/** The Playwright arguments of a plan's tests to run, or of one shard of them; null when the plan runs no test. */
export async function materializePlan(
  db: DrizzleDB,
  projectId: number,
  plan: StoredRunPlan,
  opts: { format?: SelectionFormat; shard?: { index: number; total: number }; order?: SelectionRankBy } = {},
): Promise<ResolvedSelection | null> {
  if (plan.run.length === 0) return null;
  return resolveSelectionDefinition(
    db,
    projectId,
    { include: [{ ids: plan.run }] },
    { key: plan.selection.key, version: plan.selection.version, ...opts },
  );
}
