/**
 * The flake lab's records: the plan `piwi flake` runs, the experiments it
 * reports back, and what the rest of the dashboard reads from them.
 *
 * A plan turns a test's flake profile into arms: a control with no condition,
 * then one arm per suspect, untested suspects first, each condition in the plan-file shape
 * (`@piwitests/core/flake-plan`), with the other test of an `alongside` or
 * `after` suspect named by file, title and describe path. It carries the error
 * signatures of the test's failures in the profile's window, so the command
 * line counts only failures that match history. A `verify` plan reruns the
 * reproducing arm of the test's latest reproduced experiment and its control.
 *
 * The results store the arms' counts; the verdicts are computed here from those
 * counts with `@piwitests/core/flake-verdict`, never taken from the client.
 */
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  describeFlakeArm,
  flakeErrorSignature,
  parseFlakePlan,
  type FlakeCondition as PlanCondition,
  type FlakePlanTest,
  type FlakeTestRef,
} from '@piwitests/core/flake-plan';
import { flakeArmVerdict, flakeFixVerified, flakeVerifyRuns } from '@piwitests/core/flake-verdict';
import {
  flakeArms,
  flakeExperiments,
  projects,
  testCases,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import { FAILED_STATUS_KEYS, isFailedStatus } from '../utils/test-counts';
import {
  FLAKE_PROFILE_MAX_ATTEMPTS,
  FLAKE_PROFILE_WINDOW_DAYS,
  getFlakeProfile,
  getFlakeProfileSummaries,
  getTopFlakeSuspects,
  TOP_SUSPECTS_MAX_TESTS,
  type FlakeCondition as ProfileCondition,
  type TopFlakeSuspect,
  type FlakeProfile,
} from './flake-profile';
import { notLabRun } from './probes';
import { getVerifiedFixes, type VerifiedFix } from './flake-verified';
import { TERMINAL_STATUSES, getProjectFlakyTestsWithVerified } from './projects';
import type { DrizzleDB } from './db';
import type { ProjectRunScope } from '../project-run-scope';
import { isPassiveCapabilityDeclined } from './capabilities';
import type { FlakeLabStepFacts } from '../next-step';
import { recordOutcome } from '../../server/utils/outcomes';
import type { HandbackActor } from '../handback-outcomes';
import {
  FLAKE_LAB_STATE_ORDER,
  flakeLabNextCommand,
  flakeLabNextStep,
  flakeLabTestState,
  flakeSuspectLabNote,
  flakeSuspectLabShort,
  flakeSuspectStanding,
  latestSuspectResults,
  planFlakeSuspectOrder,
  topFlakeSuspect,
  type FlakeArmRecord,
  type FlakeArmVerdictValue,
  type FlakeExperimentKind,
  type FlakeExperimentRecord,
  type FlakeExperimentSource,
  type FlakeLabTestState,
  type FlakeReproduceVerdict,
  type FlakeSuspectResult,
  type FlakeSuspectStanding,
  type FlakeVerifyVerdict,
} from '../flake-lab';
import { median } from '../utils/stats';

export * from '../flake-lab';

/** Runs of the control arm, by default. */
export const FLAKE_CONTROL_RUNS = 10;
/** The most runs of a condition arm, by default; it stops earlier at 3 matching failures. */
export const FLAKE_ARM_RUNS = 10;
/** The most error signatures a plan carries. */
const MAX_SIGNATURES = 20;

export const FLAKE_EXPERIMENT_SOURCES: readonly FlakeExperimentSource[] = ['cli', 'desktop', 'ci'];

// ─── Plan ─────────────────────────────────────────────────────────────────────

/** One arm of a plan, as the command line runs it. */
export interface FlakeLabArmPlan {
  /** `control`, `suspect-<rank>`, `combined` or `verify`. */
  id: string;
  label: string;
  /** The profile suspect it tests. */
  suspectId: string | null;
  /** The suspect's rank in the profile, from 1. */
  rank: number | null;
  conditions: PlanCondition[];
  /** The most runs. */
  runs: number;
  /** Stop at this many matching failures; null runs every run. */
  stopAt: number | null;
}

/** A suspect as the command line prints it. */
export interface FlakeLabPlanSuspect {
  rank: number;
  id: string;
  label: string;
  sentence: string;
  counts: { failuresWith: number; failures: number; passesWith: number; passes: number };
  conditionLabel: string;
  sharedRoutes?: string[];
  /** Why the suspect has no arm (its other test is gone), or null. */
  skipped: string | null;
  /** Its latest lab result and what it says; null when no experiment tested it. */
  lab: { verdict: FlakeReproduceVerdict; matchingFailures: number; runs: number; note: string } | null;
}

export interface FlakeExperimentPlan {
  version: 1;
  /** The experiment record, or null when the plan was read without recording one. */
  experimentId: string | null;
  kind: FlakeExperimentKind;
  projectId: number;
  testCaseId: number;
  test: FlakePlanTest;
  /** Describe path and title (`checkout › pays with a saved card`). */
  displayTitle: string;
  windowDays: number;
  failures: number;
  passes: number;
  /** The commit of the test's latest failure, when its run recorded one. */
  failureCommit: string | null;
  /** The median duration of the test's passing attempts in the window, ms. */
  medianDurationMs: number | null;
  errorSignatures: string[];
  suspects: FlakeLabPlanSuspect[];
  control: FlakeLabArmPlan;
  arms: FlakeLabArmPlan[];
  /** All the arms' conditions at once, for `--all` when none reproduces alone. */
  combined: FlakeLabArmPlan | null;
  /** For a verify plan: the arm it reruns. */
  verifies: {
    experimentId: number;
    armId: number;
    label: string;
    /** The arm's rate of matching failures when it reproduced. */
    rate: number;
    commit: string | null;
    finishedAt: string | null;
  } | null;
}

export interface FlakePlanOptions {
  kind?: FlakeExperimentKind;
  /** Create the experiment record (the plan endpoint does; the MCP tool does not). */
  record?: boolean;
  commit?: string | null;
  source?: FlakeExperimentSource;
  machine?: string | null;
  /**
   * Runs of the control and of each arm; a verify plan defaults to
   * `flakeVerifyRuns` of the rate the test reproduced at.
   */
  runs?: number | null;
  now?: Date;
}

/** Why a plan cannot be built, with the status the endpoint answers. */
export class FlakePlanUnavailable extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function splitSuite(suitePath: string | null | undefined): string[] {
  return suitePath ? suitePath.split('\x1f').filter(Boolean) : [];
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function scmCommit(metadata: unknown): string | null {
  const scm = (metadata as { scm?: { commit?: unknown } } | null)?.scm;
  return typeof scm?.commit === 'string' && scm.commit.trim() ? scm.commit.trim() : null;
}

/**
 * A profile condition in the plan-file shape: a route condition matches every
 * request, and the other test of an `alongside` or `after` condition is named
 * by file, title and describe path. Null when that test is not known.
 */
function toPlanCondition(condition: ProfileCondition, tests: Map<number, FlakeTestRef>): PlanCondition | null {
  switch (condition.kind) {
    case 'delay':
      return { kind: 'delay', route: condition.route, ms: condition.ms, match: 'all' };
    case 'fail':
      return 'abort' in condition
        ? { kind: 'fail', route: condition.route, abort: true, match: 'all' }
        : { kind: 'fail', route: condition.route, status: condition.status, match: 'all' };
    case 'cpu':
      return { kind: 'cpu', rate: condition.rate };
    case 'alongside':
    case 'after': {
      const test = tests.get(condition.testCaseId);
      return test ? { kind: condition.kind, test } : null;
    }
    case 'project':
      return { kind: 'project', name: condition.name };
  }
}

/**
 * The conditions of several arms applied at once: every page condition (one
 * per route and kind), the first command condition that sets the workers
 * (`alongside` or `after`), and the first project. Null with fewer than two arms.
 */
export function combineFlakeArms(arms: Array<{ conditions: PlanCondition[] }>): PlanCondition[] | null {
  if (arms.length < 2) return null;
  const out: PlanCondition[] = [];
  const seen = new Set<string>();
  let workers = false;
  let project = false;
  for (const c of arms.flatMap((a) => a.conditions)) {
    if (c.kind === 'alongside' || c.kind === 'after') {
      if (workers) continue;
      workers = true;
    } else if (c.kind === 'project') {
      if (project) continue;
      project = true;
    } else {
      const key = c.kind === 'delay' || c.kind === 'fail' ? `${c.kind}:${c.route}` : c.kind;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(c);
  }
  return out;
}

interface PlanInput {
  testCaseId: number;
  projectId: number;
  test: FlakePlanTest;
  profile: FlakeProfile;
  /** Other tests the suspects name, by test case id. */
  others: Map<number, FlakeTestRef>;
  failureCommit: string | null;
  medianDurationMs: number | null;
  errorSignatures: string[];
  runs?: number | null;
  /** Each suspect's latest lab result, by suspect id. */
  results?: ReadonlyMap<string, FlakeSuspectResult>;
}

/**
 * The reproduce plan for a profile: the control, then one arm per suspect (a
 * suspect whose other test is unknown gets none and says why), then the
 * combination. Suspects are listed in rank order; arms run in the lab's order:
 * untested suspects first, one that did not reproduce last, none dropped. Pure.
 */
export function buildFlakeReproducePlan(input: PlanInput): FlakeExperimentPlan {
  const runs = input.runs ?? null;
  const results = input.results ?? new Map<string, FlakeSuspectResult>();
  const suspects: FlakeLabPlanSuspect[] = [];
  const armBySuspect = new Map<string, FlakeLabArmPlan>();
  input.profile.suspects.forEach((s, i) => {
    const rank = i + 1;
    const condition = toPlanCondition(s.condition, input.others);
    const result = results.get(s.id);
    suspects.push({
      rank,
      id: s.id,
      label: s.label,
      sentence: s.sentence,
      counts: s.counts,
      conditionLabel: s.conditionLabel,
      ...(s.sharedRoutes?.length ? { sharedRoutes: s.sharedRoutes } : {}),
      skipped: condition ? null : `test #${s.testCaseId} is no longer in the catalog`,
      lab: result
        ? {
            verdict: result.verdict,
            matchingFailures: result.matchingFailures,
            runs: result.runs,
            note: flakeSuspectLabNote(result)!,
          }
        : null,
    });
    if (!condition) return;
    const conditions = [condition];
    armBySuspect.set(s.id, {
      id: `suspect-${rank}`,
      label: describeFlakeArm(conditions),
      suspectId: s.id,
      rank,
      conditions,
      runs: runs ?? FLAKE_ARM_RUNS,
      stopAt: 3,
    });
  });
  const arms = planFlakeSuspectOrder(input.profile.suspects, results).flatMap((s) => {
    const arm = armBySuspect.get(s.id);
    return arm ? [arm] : [];
  });
  const combinedConditions = combineFlakeArms(arms);
  return {
    version: 1,
    experimentId: null,
    kind: 'reproduce',
    projectId: input.projectId,
    testCaseId: input.testCaseId,
    test: input.test,
    displayTitle: [...input.test.suite, input.test.title].join(' › '),
    windowDays: input.profile.windowDays,
    failures: input.profile.failures,
    passes: input.profile.passes,
    failureCommit: input.failureCommit,
    medianDurationMs: input.medianDurationMs,
    errorSignatures: input.errorSignatures,
    suspects,
    control: {
      id: 'control',
      label: 'control',
      suspectId: null,
      rank: null,
      conditions: [],
      runs: runs ?? FLAKE_CONTROL_RUNS,
      stopAt: null,
    },
    arms,
    combined: combinedConditions
      ? {
          id: 'combined',
          label: describeFlakeArm(combinedConditions),
          suspectId: null,
          rank: null,
          conditions: combinedConditions,
          runs: runs ?? FLAKE_ARM_RUNS,
          stopAt: 3,
        }
      : null,
    verifies: null,
  };
}

/** What a plan needs from history beyond the profile. */
async function loadPlanHistory(db: DrizzleDB, testCaseId: number, now: Date) {
  const since = new Date(now.getTime() - FLAKE_PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      error: testRunsCases.error,
      project: testRunsCases.browserName,
      metadata: testRuns.metadata,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        eq(testRunsCases.testCaseId, testCaseId),
        gte(testRunsCases.createdAt, since),
        inArray(testRunsCases.status, ['passed', ...FAILED_STATUS_KEYS]),
        inArray(testRuns.status, TERMINAL_STATUSES),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRunsCases.createdAt))
    .limit(FLAKE_PROFILE_MAX_ATTEMPTS);
  const failed = rows.filter((r) => isFailedStatus(r.status));
  const signatures: string[] = [];
  for (const r of failed) {
    if (!r.error) continue;
    const signature = flakeErrorSignature(r.error);
    if (signature && !signatures.includes(signature)) signatures.push(signature);
    if (signatures.length >= MAX_SIGNATURES) break;
  }
  const projectCounts = new Map<string, number>();
  for (const r of failed) if (r.project) projectCounts.set(r.project, (projectCounts.get(r.project) ?? 0) + 1);
  const project = [...projectCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    errorSignatures: signatures,
    failureCommit: failed.map((r) => scmCommit(r.metadata)).find((c) => c) ?? null,
    medianDurationMs: roundOrNull(
      median(rows.filter((r) => r.status === 'passed' && r.duration != null).map((r) => r.duration as number)),
    ),
    project,
  };
}

async function loadTestRefs(db: DrizzleDB, ids: number[]): Promise<Map<number, FlakeTestRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: testCases.id, filePath: testCases.filePath, suitePath: testCases.suitePath, title: testCases.title })
    .from(testCases)
    .where(inArray(testCases.id, ids));
  return new Map(rows.map((r) => [r.id, { file: r.filePath, title: r.title, suite: splitSuite(r.suitePath) }]));
}

/**
 * The plan for one test: a reproduce plan from its profile, or a verify plan
 * rerunning the arm that last reproduced it. Records the experiment when asked.
 * Throws {@link FlakePlanUnavailable} for a missing test case, or a verify plan
 * with nothing reproduced to rerun.
 */
export async function getFlakeExperimentPlan(
  db: DrizzleDB,
  testCaseId: number,
  opts: FlakePlanOptions = {},
): Promise<FlakeExperimentPlan> {
  const now = opts.now ?? new Date();
  const [tc] = await db
    .select({
      id: testCases.id,
      projectId: testCases.projectId,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
    })
    .from(testCases)
    .where(eq(testCases.id, testCaseId));
  if (!tc) throw new FlakePlanUnavailable(404, 'Test case not found');

  const [profile, history] = await Promise.all([
    getFlakeProfile(db, testCaseId, { now, summary: true }),
    loadPlanHistory(db, testCaseId, now),
  ]);
  const results = opts.kind === 'verify' ? undefined : await getFlakeSuspectResults(db, testCaseId);
  if (!profile) throw new FlakePlanUnavailable(404, 'Test case not found');
  const test: FlakePlanTest = {
    file: tc.filePath,
    title: tc.title,
    suite: splitSuite(tc.suitePath),
    project: history.project,
  };
  const otherIds = profile.suspects
    .map((s) => (s.condition.kind === 'alongside' || s.condition.kind === 'after' ? s.condition.testCaseId : null))
    .filter((id): id is number => id != null);
  const plan = buildFlakeReproducePlan({
    testCaseId,
    projectId: tc.projectId,
    test,
    profile,
    others: await loadTestRefs(db, otherIds),
    failureCommit: history.failureCommit,
    medianDurationMs: history.medianDurationMs,
    errorSignatures: history.errorSignatures,
    runs: opts.runs,
    results,
  });

  let verifiesArmId: number | null = null;
  if (opts.kind === 'verify') {
    const last = await lastReproducingArm(db, testCaseId);
    if (!last) {
      throw new FlakePlanUnavailable(
        409,
        'No experiment has reproduced this test yet: run `piwi flake` first, then verify the fix.',
      );
    }
    const conditions = parseConditions(last.conditions);
    const runs = opts.runs ?? flakeVerifyRuns(last.rate);
    plan.kind = 'verify';
    plan.test = { ...test, project: last.playwrightProject ?? test.project };
    plan.control = { ...plan.control, runs };
    // One matching failure is enough to say the fix did not hold.
    plan.arms = [
      { id: 'verify', label: last.label, suspectId: last.suspectId, rank: null, conditions, runs, stopAt: 1 },
    ];
    plan.combined = null;
    plan.verifies = {
      experimentId: last.experimentId,
      armId: last.armId,
      label: last.label,
      rate: last.rate,
      commit: last.commit,
      finishedAt: last.finishedAt,
    };
    verifiesArmId = last.armId;
  }

  if (opts.record) {
    const [row] = await db
      .insert(flakeExperiments)
      .values({
        projectId: tc.projectId,
        testCaseId,
        kind: plan.kind,
        commit: opts.commit ?? null,
        failureCommit: plan.failureCommit,
        source: opts.source ?? 'cli',
        machine: opts.machine ?? null,
        playwrightProject: plan.test.project,
        verifiesArmId,
        createdAt: now,
      })
      .returning({ id: flakeExperiments.id });
    plan.experimentId = String(row!.id);
  }
  return plan;
}

function parseConditions(value: unknown): PlanCondition[] {
  const conditions = Array.isArray(value) ? value : [];
  return parseFlakePlan({
    version: 1,
    experimentId: 'stored',
    test: { file: 'stored', title: 'stored' },
    arm: { id: 'stored', conditions },
  }).arm.conditions;
}

/** The arm of the test's latest finished reproduce experiment that reproduced it. */
async function lastReproducingArm(db: DrizzleDB, testCaseId: number) {
  const [row] = await db
    .select({
      experimentId: flakeExperiments.id,
      armId: flakeArms.id,
      label: flakeArms.label,
      suspectId: flakeArms.suspectId,
      conditions: flakeArms.conditions,
      runs: flakeArms.runs,
      matchingFailures: flakeArms.matchingFailures,
      commit: flakeExperiments.commit,
      playwrightProject: flakeExperiments.playwrightProject,
      finishedAt: flakeExperiments.finishedAt,
    })
    .from(flakeExperiments)
    .innerJoin(flakeArms, eq(flakeArms.id, flakeExperiments.reproducingArmId))
    .where(
      and(
        eq(flakeExperiments.testCaseId, testCaseId),
        eq(flakeExperiments.kind, 'reproduce'),
        eq(flakeExperiments.verdict, 'reproduced'),
        isNotNull(flakeExperiments.finishedAt),
      ),
    )
    .orderBy(desc(flakeExperiments.finishedAt), desc(flakeExperiments.id))
    .limit(1);
  if (!row || row.runs <= 0 || row.matchingFailures <= 0) return null;
  return {
    ...row,
    rate: row.matchingFailures / row.runs,
    finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
  };
}

/**
 * The arm that last reproduced a test, as a bisect step names it: the test
 * and the arm's label. Null when no experiment has reproduced it.
 */
export async function getReproducingArm(
  db: DrizzleDB,
  testCaseId: number,
): Promise<{ testCaseId: number; label: string } | null> {
  const last = await lastReproducingArm(db, testCaseId);
  return last ? { testCaseId, label: last.label } : null;
}

// ─── Results ──────────────────────────────────────────────────────────────────

/** One arm's counts, as the command line posts them. */
export interface FlakeArmResultInput {
  id: string;
  label?: string | null;
  suspectId?: string | null;
  conditions: unknown[];
  runs: number;
  matchingFailures: number;
  otherFailures: number;
  discardedRounds?: number;
  stoppedEarly?: boolean;
}

export interface FlakeResultsInput {
  experimentId: string;
  commit?: string | null;
  playwrightProject?: string | null;
  arms: FlakeArmResultInput[];
}

/** An arm with the verdict the server gives it. */
export interface FlakeArmOutcome {
  id: string;
  verdict: FlakeArmVerdictValue | null;
  pValue: number | null;
  rate: number;
}

/** Why a results post is refused, with the status the endpoint answers. */
export class FlakeResultsRejected extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The verdicts of a reproduce experiment's arms against its control, and the
 * experiment's: reproduced by the first arm that reproduced (in the order
 * posted, the plan's order), else amplified, else not reproduced. Pure.
 */
export function judgeReproduce(arms: FlakeArmResultInput[]): {
  arms: FlakeArmOutcome[];
  verdict: FlakeReproduceVerdict;
  reproducingArm: string | null;
} {
  const control = arms.find((a) => a.id === 'control')!;
  const out = arms.map((a): FlakeArmOutcome => {
    const rate = a.runs > 0 ? a.matchingFailures / a.runs : 0;
    if (a.id === 'control') return { id: a.id, verdict: null, pValue: null, rate };
    const v = flakeArmVerdict(a, control);
    return { id: a.id, verdict: v.verdict, pValue: v.pValue, rate };
  });
  const reproduced = out.find((a) => a.verdict === 'reproduced');
  const verdict: FlakeReproduceVerdict = reproduced
    ? 'reproduced'
    : out.some((a) => a.verdict === 'amplified')
      ? 'amplified'
      : 'not-reproduced';
  return { arms: out, verdict, reproducingArm: reproduced?.id ?? null };
}

/**
 * The verdict of a verify experiment: verified when the rerun arm had no
 * matching failure in at least `flakeVerifyRuns` runs for the rate it reproduced
 * at, still failing when it had one, inconclusive with too few runs. Pure.
 */
function judgeVerify(
  arms: FlakeArmResultInput[],
  reproducedRate: number,
): { arms: FlakeArmOutcome[]; verdict: FlakeVerifyVerdict } {
  const verify = arms.find((a) => a.id === 'verify')!;
  const verdict: FlakeVerifyVerdict =
    verify.matchingFailures > 0
      ? 'still-fails'
      : flakeFixVerified(verify, reproducedRate)
        ? 'verified'
        : 'inconclusive';
  return {
    arms: arms.map((a) => ({
      id: a.id,
      verdict: a.id === 'verify' ? verdict : null,
      pValue: null,
      rate: a.runs > 0 ? a.matchingFailures / a.runs : 0,
    })),
    verdict,
  };
}

/**
 * Store the counts of an experiment's arms and the verdicts computed from them,
 * and finish the experiment. The experiment must belong to the project and be
 * unfinished; the arms must include the control (and the `verify` arm for a
 * verify experiment), with failures that fit in their runs and conditions a
 * plan file accepts. A `verified` verify records the `flake-verify` hand-back
 * as `verified`.
 */
export async function recordFlakeResults(
  db: DrizzleDB,
  projectId: number,
  input: FlakeResultsInput,
  opts: { now?: Date; actor?: HandbackActor } = {},
): Promise<{ experimentId: number; kind: FlakeExperimentKind; verdict: string; arms: FlakeArmOutcome[] }> {
  const id = Number(input.experimentId);
  if (!Number.isInteger(id) || id <= 0) throw new FlakeResultsRejected(400, 'experimentId must be a numeric id');
  const [experiment] = await db.select().from(flakeExperiments).where(eq(flakeExperiments.id, id));
  if (!experiment || experiment.projectId !== projectId) {
    throw new FlakeResultsRejected(404, 'Experiment not found in this project');
  }
  if (experiment.finishedAt) throw new FlakeResultsRejected(409, 'This experiment already has its results');

  const keys = new Set<string>();
  const conditionsById = new Map<string, PlanCondition[]>();
  for (const arm of input.arms) {
    if (keys.has(arm.id)) throw new FlakeResultsRejected(400, `Arm "${arm.id}" is listed twice`);
    keys.add(arm.id);
    if (arm.matchingFailures + arm.otherFailures > arm.runs) {
      throw new FlakeResultsRejected(400, `Arm "${arm.id}" has more failures than runs`);
    }
    try {
      conditionsById.set(arm.id, parseConditions(arm.conditions));
    } catch (error) {
      throw new FlakeResultsRejected(400, `Arm "${arm.id}": ${(error as Error).message}`);
    }
  }
  if (!keys.has('control')) throw new FlakeResultsRejected(400, 'The results must include the control arm');

  let verdict: string;
  let outcomes: FlakeArmOutcome[];
  let reproducingKey: string | null;
  if (experiment.kind === 'verify') {
    if (!keys.has('verify')) throw new FlakeResultsRejected(400, 'A verify experiment needs its verify arm');
    const [original] = experiment.verifiesArmId
      ? await db
          .select({ runs: flakeArms.runs, matchingFailures: flakeArms.matchingFailures })
          .from(flakeArms)
          .where(eq(flakeArms.id, experiment.verifiesArmId))
      : [];
    if (!original || original.runs <= 0 || original.matchingFailures <= 0) {
      throw new FlakeResultsRejected(409, 'The arm this experiment verifies no longer exists');
    }
    const judged = judgeVerify(input.arms, original.matchingFailures / original.runs);
    verdict = judged.verdict;
    outcomes = judged.arms;
    reproducingKey = 'verify';
  } else {
    const judged = judgeReproduce(input.arms);
    verdict = judged.verdict;
    outcomes = judged.arms;
    reproducingKey = judged.reproducingArm;
  }

  const now = opts.now ?? new Date();
  await db.transaction(async (tx) => {
    let reproducingArmId: number | null = null;
    for (const [position, arm] of input.arms.entries()) {
      const outcome = outcomes[position]!;
      const conditions = conditionsById.get(arm.id)!;
      const [row] = await tx
        .insert(flakeArms)
        .values({
          experimentId: id,
          armKey: arm.id,
          position,
          suspectId: arm.suspectId ?? null,
          label: arm.label?.trim() || describeFlakeArm(conditions),
          conditions,
          runs: arm.runs,
          matchingFailures: arm.matchingFailures,
          otherFailures: arm.otherFailures,
          discardedRounds: arm.discardedRounds ?? 0,
          stoppedEarly: arm.stoppedEarly ?? false,
          pValue: outcome.pValue,
          verdict: outcome.verdict,
        })
        .returning({ id: flakeArms.id });
      if (arm.id === reproducingKey) reproducingArmId = row!.id;
    }
    await tx
      .update(flakeExperiments)
      .set({
        verdict,
        reproducingArmId,
        finishedAt: now,
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.playwrightProject !== undefined ? { playwrightProject: input.playwrightProject } : {}),
      })
      .where(eq(flakeExperiments.id, id));
  });
  if (experiment.kind === 'verify' && verdict === 'verified') {
    await recordOutcome(db, {
      projectId,
      kind: 'flake-verify',
      subjectType: 'test-case',
      subjectId: experiment.testCaseId,
      suggestionKey: `experiment:${id}`,
      outcome: 'verified',
      actor: opts.actor ?? { channel: 'cli' },
      commit: input.commit ?? experiment.commit ?? null,
      details: { experimentId: id },
      at: now,
    });
  }
  return { experimentId: id, kind: experiment.kind as FlakeExperimentKind, verdict, arms: outcomes };
}

// ─── Reading experiments ──────────────────────────────────────────────────────

/** The most experiments one read returns. */
export const FLAKE_EXPERIMENTS_MAX = 50;

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A test's finished experiments, newest first, with their arms in plan order. */
export async function listFlakeExperiments(
  db: DrizzleDB,
  testCaseId: number,
  opts: { limit?: number } = {},
): Promise<FlakeExperimentRecord[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), FLAKE_EXPERIMENTS_MAX);
  const rows = await db
    .select()
    .from(flakeExperiments)
    .where(and(eq(flakeExperiments.testCaseId, testCaseId), isNotNull(flakeExperiments.finishedAt)))
    .orderBy(desc(flakeExperiments.finishedAt), desc(flakeExperiments.id))
    .limit(limit);
  return hydrateExperiments(db, rows);
}

type ExperimentRow = typeof flakeExperiments.$inferSelect;

async function hydrateExperiments(db: DrizzleDB, rows: ExperimentRow[]): Promise<FlakeExperimentRecord[]> {
  if (rows.length === 0) return [];
  const armRows = await db
    .select()
    .from(flakeArms)
    .where(
      inArray(
        flakeArms.experimentId,
        rows.map((r) => r.id),
      ),
    );
  const verifiedIds = rows.map((r) => r.verifiesArmId).filter((v): v is number => v != null);
  const verifiedRows = verifiedIds.length
    ? await db
        .select({ id: flakeArms.id, experimentId: flakeArms.experimentId, label: flakeArms.label })
        .from(flakeArms)
        .where(inArray(flakeArms.id, verifiedIds))
    : [];
  const verified = new Map(verifiedRows.map((v) => [v.id, v]));
  return rows.map((r) => {
    const arms = armRows
      .filter((a) => a.experimentId === r.id)
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((a): FlakeArmRecord => ({
        id: a.id,
        key: a.armKey,
        label: a.label,
        suspectId: a.suspectId ?? null,
        conditions: (Array.isArray(a.conditions) ? a.conditions : []) as PlanCondition[],
        runs: a.runs,
        matchingFailures: a.matchingFailures,
        otherFailures: a.otherFailures,
        discardedRounds: a.discardedRounds,
        stoppedEarly: Boolean(a.stoppedEarly),
        pValue: a.pValue ?? null,
        verdict: (a.verdict as FlakeArmVerdictValue | null) ?? null,
      }));
    const v = r.verifiesArmId != null ? verified.get(r.verifiesArmId) : undefined;
    return {
      id: r.id,
      testCaseId: r.testCaseId,
      kind: r.kind as FlakeExperimentKind,
      verdict: r.verdict ?? null,
      commit: r.commit ?? null,
      failureCommit: r.failureCommit ?? null,
      source: r.source,
      machine: r.machine ?? null,
      playwrightProject: r.playwrightProject ?? null,
      createdAt: iso(r.createdAt)!,
      finishedAt: iso(r.finishedAt),
      reproducingArmId: r.reproducingArmId ?? null,
      verifies: v ? { experimentId: v.experimentId, armId: v.id, label: v.label } : null,
      arms,
    };
  });
}

/** The latest reproduced result of each suspect of a test, for the clue. */
export async function getFlakeSuspectResults(
  db: DrizzleDB,
  testCaseId: number,
): Promise<Map<string, FlakeSuspectResult>> {
  return latestSuspectResults(await listFlakeExperiments(db, testCaseId, { limit: 20 }));
}

/** The flaky list's lab line for one test: its latest finished reproduce experiment. */
export interface FlakeLabSummary {
  testCaseId: number;
  experimentId: number;
  verdict: FlakeReproduceVerdict;
  /** The reproducing arm's label, when it reproduced. */
  label: string | null;
  finishedAt: string | null;
}

/** The latest finished reproduce experiment of each listed test. */
export async function getFlakeLabSummaries(db: DrizzleDB, testCaseIds: number[]): Promise<FlakeLabSummary[]> {
  if (testCaseIds.length === 0) return [];
  const rows = await db
    .select({
      id: flakeExperiments.id,
      testCaseId: flakeExperiments.testCaseId,
      verdict: flakeExperiments.verdict,
      finishedAt: flakeExperiments.finishedAt,
      label: flakeArms.label,
    })
    .from(flakeExperiments)
    .leftJoin(flakeArms, eq(flakeArms.id, flakeExperiments.reproducingArmId))
    .where(
      and(
        inArray(flakeExperiments.testCaseId, testCaseIds),
        eq(flakeExperiments.kind, 'reproduce'),
        isNotNull(flakeExperiments.finishedAt),
        // The newest finished reproduce experiment of each test.
        sql`${flakeExperiments.id} = (SELECT MAX(e2.id) FROM flake_experiments e2 WHERE e2.test_case_id = ${flakeExperiments.testCaseId} AND e2.kind = 'reproduce' AND e2.finished_at IS NOT NULL)`,
      ),
    );
  return rows.map((r) => ({
    testCaseId: r.testCaseId,
    experimentId: r.id,
    verdict: (r.verdict ?? 'not-reproduced') as FlakeReproduceVerdict,
    label: r.label ?? null,
    finishedAt: iso(r.finishedAt),
  }));
}

// ─── Test lookup ──────────────────────────────────────────────────────────────

/**
 * The test case a `file:line` names in a project: the test declared on that
 * line, else the last one declared before it in the file (the test whose body
 * holds the line). The file matches the stored path or its end from a folder
 * boundary. Lines come from the test's latest execution. Null when none fits.
 */
export async function resolveTestCaseByLocation(
  db: DrizzleDB,
  projectId: number,
  file: string,
  line: number,
): Promise<{ testCaseId: number; filePath: string; title: string; line: number } | null> {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const suffix = `%/${normalized.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = await db
    .select({
      testCaseId: testCases.id,
      filePath: testCases.filePath,
      title: testCases.title,
      line: sql<
        number | null
      >`(SELECT t2.line FROM test_runs_cases t2 WHERE t2.test_case_id = test_cases.id AND t2.line IS NOT NULL ORDER BY t2.id DESC LIMIT 1)`,
    })
    .from(testCases)
    .where(
      and(
        eq(testCases.projectId, projectId),
        sql`(${testCases.filePath} = ${normalized} OR ${testCases.filePath} LIKE ${suffix} ESCAPE '\\')`,
      ),
    );
  const candidates = rows
    .map((r) => ({ ...r, line: Number(r.line ?? 0) }))
    .filter((r) => r.line > 0 && r.line <= line)
    .sort((a, b) => b.line - a.line || a.testCaseId - b.testCaseId);
  return candidates[0] ?? null;
}

/**
 * The flaky list's read: each listed test's top suspect, and its latest lab
 * result. `profiles` reads the tests' summary profiles (see `getTopFlakeSuspects`).
 */
export async function getFlakyListSuspects(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
  opts: { profiles?: (testCaseIds: number[]) => Promise<FlakeProfile[]> } = {},
): Promise<Array<TopFlakeSuspect & { lab: FlakeLabSummary | null }>> {
  const summaries = await getFlakeLabSummaries(db, testCaseIds.slice(0, TOP_SUSPECTS_MAX_TESTS));
  const lab = new Map(summaries.map((l) => [l.testCaseId, l]));
  // A suspect the lab reproduced leads, whatever its rank; one that did not reproduce comes last.
  const results = new Map<number, Map<string, FlakeSuspectResult>>();
  for (const summary of summaries)
    results.set(summary.testCaseId, await getFlakeSuspectResults(db, summary.testCaseId));
  const items = await getTopFlakeSuspects(db, projectId, testCaseIds, { results, profiles: opts.profiles });
  return items.map((item) => ({ ...item, lab: lab.get(item.testCaseId) ?? null }));
}

// ─── The project's lab ────────────────────────────────────────────────────────

/** A test the project's lab lists: flaky in the runs read, or run through the lab. */
export interface FlakeLabTest {
  testCaseId: number;
  title: string;
  filePath: string;
  state: FlakeLabTestState;
  /** The command it needs next; null once its fix holds. */
  nextCommand: string | null;
  /** On the flaky ranking of the runs read. */
  flaky: boolean;
  /** Runs read in which it failed and then passed on a retry; null when it did not flake in them. */
  retryPassRuns: number | null;
  /** The condition that last reproduced it. */
  reproducedBy: string | null;
  /** When its newest experiment finished, ISO; null before any. */
  lastExperimentAt: string | null;
  experiments: number;
  verifiedFix: VerifiedFix | null;
  /** Share of the runs read in which it failed at least once (failed, or passed on a retry); null off the ranking. */
  flakeRate: number | null;
  /**
   * With `suspects`, on the first tests that need a step: the suspect it is shown with (see
   * `topFlakeSuspect`); null when its history names none.
   */
  suspect?: FlakeLabTopSuspect | null;
  /** With `suspects`: how many of its suspects no experiment tested yet. */
  untestedSuspects?: number;
}

/** A test's top suspect as the lab lists it. */
export interface FlakeLabTopSuspect {
  id: string;
  label: string;
  standing: FlakeSuspectStanding;
  /** The latest arm that tested it; null while untested. */
  matchingFailures: number | null;
  runs: number | null;
  /** Its standing in a few words (`reproduced 7 of 10`, `untested`). */
  lab: string;
}

/** An experiment of the project, with the test it ran. */
export interface ProjectFlakeExperiment extends FlakeExperimentRecord {
  title: string;
  filePath: string;
}

export interface ProjectFlakeLab {
  /** The runs the flaky ranking read. */
  runs: number;
  /** Tests in lab order: a fix to verify first, a fix that held last. */
  tests: FlakeLabTest[];
  /** The newest finished experiments, newest first. */
  experiments: ProjectFlakeExperiment[];
  counts: {
    /** Tests on the flaky ranking. */
    flaky: number;
    /** Flaky tests never run through the lab. */
    untested: number;
    /** Reproduced tests whose fix has not been verified. */
    awaitingFix: number;
    /** Tests whose verified fix holds. */
    verified: number;
    /** Every finished experiment of the project. */
    experiments: number;
  };
}

/**
 * The project's lab: every test on the flaky ranking of the last `runs` runs
 * (scoped like the Flaky view) or with a finished experiment, each with its lab
 * state and the command it needs next, and the newest experiments. Throws
 * `Project not found` like the ranking.
 */
export async function getProjectFlakeLab(
  db: DrizzleDB,
  projectId: number,
  opts: {
    runs?: number;
    environment?: string | null;
    branch?: string | null;
    /** The project page's run scope; replaces `environment` and `branch`. */
    scope?: ProjectRunScope | null;
    limit?: number;
    /** Also read each listed test's suspects, for the first {@link TOP_SUSPECTS_MAX_TESTS} tests that need a step. */
    suspects?: boolean;
    /** With `suspects`: read them for at most this many tests. */
    suspectLimit?: number;
    /** With `suspects`: reads the tests' profiles in the summary view (the server keeps them between runs); else {@link getFlakeProfileSummaries}. */
    profiles?: (testCaseIds: number[]) => Promise<FlakeProfile[]>;
    now?: Date;
  } = {},
): Promise<ProjectFlakeLab> {
  const runs = Math.min(200, Math.max(1, opts.runs ?? 50));
  const limit = Math.min(Math.max(1, opts.limit ?? 20), FLAKE_EXPERIMENTS_MAX);
  const { items: ranked, verifiedFixed } = await getProjectFlakyTestsWithVerified(
    db,
    projectId,
    runs,
    opts.environment,
    undefined,
    opts.branch,
    opts.scope,
  );

  // Every finished experiment, light: enough to place each test.
  const rows = await db
    .select({
      testCaseId: flakeExperiments.testCaseId,
      kind: flakeExperiments.kind,
      verdict: flakeExperiments.verdict,
      finishedAt: flakeExperiments.finishedAt,
      reproducedBy: flakeArms.label,
    })
    .from(flakeExperiments)
    .leftJoin(flakeArms, eq(flakeArms.id, flakeExperiments.reproducingArmId))
    .where(and(eq(flakeExperiments.projectId, projectId), isNotNull(flakeExperiments.finishedAt)))
    .orderBy(desc(flakeExperiments.finishedAt), desc(flakeExperiments.id));
  const experimentsByTest = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = experimentsByTest.get(r.testCaseId);
    if (list) list.push(r);
    else experimentsByTest.set(r.testCaseId, [r]);
  }
  const fixes = await getVerifiedFixes(db, [...experimentsByTest.keys()]);

  const known = new Map<number, { title: string; filePath: string; retryPassRuns: number }>();
  for (const t of [...ranked, ...verifiedFixed]) {
    known.set(t.testCaseId, { title: t.title, filePath: t.filePath, retryPassRuns: t.retryPassRuns });
  }
  const flakeRates = new Map(
    ranked.map((t) => [t.testCaseId, t.totalRuns > 0 ? (t.failedRuns + t.retryPassRuns) / t.totalRuns : null]),
  );
  const missing = [...experimentsByTest.keys()].filter((id) => !known.has(id));
  const titled = missing.length
    ? await db
        .select({ id: testCases.id, title: testCases.title, filePath: testCases.filePath })
        .from(testCases)
        .where(inArray(testCases.id, missing))
    : [];
  const titles = new Map(titled.map((t) => [t.id, t]));

  const rank = new Map(ranked.map((t, i) => [t.testCaseId, i]));
  const tests: FlakeLabTest[] = [];
  for (const testCaseId of new Set([...rank.keys(), ...known.keys(), ...experimentsByTest.keys()])) {
    const own = experimentsByTest.get(testCaseId) ?? [];
    const fix = fixes.get(testCaseId) ?? null;
    const state = flakeLabTestState(own, fix);
    const test = known.get(testCaseId);
    tests.push({
      testCaseId,
      title: test?.title ?? titles.get(testCaseId)?.title ?? '',
      filePath: test?.filePath ?? titles.get(testCaseId)?.filePath ?? '',
      state,
      nextCommand: flakeLabNextCommand(testCaseId, state),
      flaky: rank.has(testCaseId),
      retryPassRuns: test && test.retryPassRuns > 0 ? test.retryPassRuns : null,
      reproducedBy: own.find((e) => e.kind === 'reproduce' && e.verdict === 'reproduced')?.reproducedBy ?? null,
      lastExperimentAt: own[0] ? iso(own[0].finishedAt) : null,
      experiments: own.length,
      verifiedFix: fix,
      flakeRate: flakeRates.get(testCaseId) ?? null,
    });
  }
  const stateRank = (s: FlakeLabTestState) => FLAKE_LAB_STATE_ORDER.indexOf(s);
  tests.sort(
    (a, b) =>
      stateRank(a.state) - stateRank(b.state) ||
      (rank.get(a.testCaseId) ?? Infinity) - (rank.get(b.testCaseId) ?? Infinity) ||
      (b.lastExperimentAt ?? '').localeCompare(a.lastExperimentAt ?? '') ||
      a.testCaseId - b.testCaseId,
  );

  if (opts.suspects) await addTopSuspects(db, tests, opts);

  const newest = await db
    .select()
    .from(flakeExperiments)
    .where(and(eq(flakeExperiments.projectId, projectId), isNotNull(flakeExperiments.finishedAt)))
    .orderBy(desc(flakeExperiments.finishedAt), desc(flakeExperiments.id))
    .limit(limit);
  const byId = new Map(tests.map((t) => [t.testCaseId, t]));
  const experiments = (await hydrateExperiments(db, newest)).map((e) => ({
    ...e,
    title: byId.get(e.testCaseId)?.title ?? '',
    filePath: byId.get(e.testCaseId)?.filePath ?? '',
  }));

  return {
    runs,
    tests,
    experiments,
    counts: {
      flaky: ranked.length,
      untested: tests.filter((t) => t.state === 'untested').length,
      awaitingFix: tests.filter((t) => flakeLabNextStep(t.state) === 'verify').length,
      verified: tests.filter((t) => t.state === 'verified').length,
      experiments: rows.length,
    },
  };
}

/**
 * Set `suspect` and `untestedSuspects` on the first {@link TOP_SUSPECTS_MAX_TESTS}
 * tests that need a step, their profiles in the summary view read by `profiles` when given.
 */
async function addTopSuspects(
  db: DrizzleDB,
  tests: FlakeLabTest[],
  opts: { now?: Date; suspectLimit?: number; profiles?: (testCaseIds: number[]) => Promise<FlakeProfile[]> },
): Promise<void> {
  const wanted = tests
    .filter((t) => t.nextCommand)
    .slice(0, Math.min(opts.suspectLimit ?? TOP_SUSPECTS_MAX_TESTS, TOP_SUSPECTS_MAX_TESTS));
  const ids = wanted.map((t) => t.testCaseId);
  const profiles = new Map(
    (await (opts.profiles?.(ids) ?? getFlakeProfileSummaries(db, ids, { now: opts.now }))).map((p) => [
      p.testCaseId,
      p,
    ]),
  );
  const BATCH = 5;
  for (let i = 0; i < wanted.length; i += BATCH) {
    await Promise.all(
      wanted.slice(i, i + BATCH).map(async (test) => {
        const results = await getFlakeSuspectResults(db, test.testCaseId);
        const suspects = profiles.get(test.testCaseId)?.suspects ?? [];
        test.untestedSuspects = suspects.filter((sus) => !results.has(sus.id)).length;
        const top = topFlakeSuspect(suspects, results);
        const result = top ? results.get(top.id) : undefined;
        test.suspect = top
          ? {
              id: top.id,
              label: top.label,
              standing: flakeSuspectStanding(result),
              matchingFailures: result?.matchingFailures ?? null,
              runs: result?.runs ?? null,
              lab: flakeSuspectLabShort(result),
            }
          : null;
      }),
    );
  }
}

/**
 * A flaky test's Flake Lab facts for the next-step policy: its state's next
 * step and command, the condition that reproduced it, and, with a reproduce
 * step, its top suspect and how many suspects are untested. `ciAvailable` is
 * the caller's (a server-only check).
 */
export async function getFlakeLabStepFacts(
  db: DrizzleDB,
  testCaseId: number,
  opts: { ciAvailable?: boolean; now?: Date } = {},
): Promise<FlakeLabStepFacts> {
  const [own, fixes] = await Promise.all([
    db
      .select({ kind: flakeExperiments.kind, verdict: flakeExperiments.verdict, reproducedBy: flakeArms.label })
      .from(flakeExperiments)
      .leftJoin(flakeArms, eq(flakeArms.id, flakeExperiments.reproducingArmId))
      .where(and(eq(flakeExperiments.testCaseId, testCaseId), isNotNull(flakeExperiments.finishedAt)))
      .orderBy(desc(flakeExperiments.finishedAt), desc(flakeExperiments.id)),
    getVerifiedFixes(db, [testCaseId]),
  ]);
  const state = flakeLabTestState(own, fixes.get(testCaseId) ?? null);
  const nextStep = flakeLabNextStep(state);
  const facts: FlakeLabStepFacts = {
    testCaseId,
    nextStep,
    command: flakeLabNextCommand(testCaseId, state),
    reproducedBy: own.find((e) => e.kind === 'reproduce' && e.verdict === 'reproduced')?.reproducedBy ?? null,
    suspect: null,
    untestedSuspects: 0,
    ciAvailable: opts.ciAvailable ?? false,
  };
  if (nextStep !== 'reproduce') return facts;
  const [profile, results] = await Promise.all([
    getFlakeProfile(db, testCaseId, { now: opts.now, summary: true }),
    getFlakeSuspectResults(db, testCaseId),
  ]);
  const suspects = profile?.suspects ?? [];
  const top = topFlakeSuspect(suspects, results);
  facts.untestedSuspects = suspects.filter((sus) => !results.has(sus.id)).length;
  facts.suspect = top ? { id: top.id, label: top.label, standing: flakeSuspectStanding(results.get(top.id)) } : null;
  return facts;
}

/** A flaky test Home links to: one with an untested suspect, or a reproduction waiting for a verify. */
export interface FlakeLabInboxItem {
  projectId: number;
  projectName: string;
  testCaseId: number;
  title: string;
  filePath: string;
  step: FlakeExperimentKind;
  /** The step's command. */
  command: string;
  /** Reproduce: the top untested suspect. Verify: the condition that reproduced it. */
  detail: string | null;
  /** Reproduce: the suspects no experiment tested yet. */
  untestedSuspects: number;
  flakeRate: number | null;
}

/** Projects Home reads, the most recently run first. */
const FLAKE_LAB_INBOX_PROJECTS = 20;
/** Tests per project whose suspects Home reads. */
const FLAKE_LAB_INBOX_SUSPECTS = 10;
/** Items Home lists. */
export const FLAKE_LAB_INBOX_MAX = 10;

/**
 * The flaky tests Home links to across the listed projects (the most recently
 * run {@link FLAKE_LAB_INBOX_PROJECTS}, those that did not decline the Flake
 * Lab): each reproduced test waiting for a verify, then each test whose top
 * suspect the lab has not tested, in each project's lab order; at most
 * {@link FLAKE_LAB_INBOX_MAX}. `profiles` reads a project's tests' summary
 * profiles, as {@link getProjectFlakeLab}'s option of that name.
 */
export async function listFlakeLabInbox(
  db: DrizzleDB,
  projectIds: number[] | 'all',
  opts: { now?: Date; profiles?: (projectId: number, testCaseIds: number[]) => Promise<FlakeProfile[]> } = {},
): Promise<FlakeLabInboxItem[]> {
  if (projectIds !== 'all' && projectIds.length === 0) return [];
  const recent = await db
    .select({ projectId: testRuns.projectId, name: projects.name, label: projects.label })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(projectIds === 'all' ? undefined : inArray(testRuns.projectId, projectIds))
    .groupBy(testRuns.projectId, projects.name, projects.label)
    .orderBy(desc(sql`MAX(${testRuns.id})`))
    .limit(FLAKE_LAB_INBOX_PROJECTS);

  const { profiles } = opts;
  const items: FlakeLabInboxItem[] = [];
  for (const project of recent) {
    if (await isPassiveCapabilityDeclined(db, project.projectId, 'flake-lab')) continue;
    const lab = await getProjectFlakeLab(db, project.projectId, {
      limit: 1,
      suspects: true,
      suspectLimit: FLAKE_LAB_INBOX_SUSPECTS,
      profiles: profiles && ((testCaseIds) => profiles(project.projectId, testCaseIds)),
      now: opts.now,
    });
    items.push(...flakeLabInboxItems({ id: project.projectId, name: project.label || project.name }, lab.tests));
  }
  return [...items.filter((i) => i.step === 'verify'), ...items.filter((i) => i.step === 'reproduce')].slice(
    0,
    FLAKE_LAB_INBOX_MAX,
  );
}

/**
 * The tests of one project's lab Home links to, in lab order: a flaky test that
 * waits for a verify, or whose top suspect is untested. Pure.
 */
export function flakeLabInboxItems(project: { id: number; name: string }, tests: FlakeLabTest[]): FlakeLabInboxItem[] {
  const out: FlakeLabInboxItem[] = [];
  for (const t of tests) {
    if (!t.flaky || !t.nextCommand) continue;
    const base = {
      projectId: project.id,
      projectName: project.name,
      testCaseId: t.testCaseId,
      title: t.title,
      filePath: t.filePath,
      command: t.nextCommand,
      flakeRate: t.flakeRate,
    };
    if (flakeLabNextStep(t.state) === 'verify') {
      out.push({ ...base, step: 'verify', detail: t.reproducedBy, untestedSuspects: 0 });
    } else if (t.suspect?.standing === 'untested') {
      out.push({ ...base, step: 'reproduce', detail: t.suspect.label, untestedSuspects: t.untestedSuspects ?? 0 });
    }
  }
  return out;
}
