/**
 * Whether Piwi's hand-backs work: what happened to the locator heals, the
 * auto-heal pull requests, the AI diagnoses, the gate verdicts, the Flake Lab
 * verify runs and the fix attempts of the projects in scope over a period.
 *
 * The outcome counts are read with `readOutcomeCounts`, the rows still stored
 * plus the daily counters of the rows retention pruned, so they cover any
 * period. Ratings come from the diagnoses and their earlier versions, and the
 * diagnosed fixes from the failure clusters.
 *
 * Each kind follows the capability it belongs to in every project: a project
 * that declined it adds nothing to that kind, and with none left the kind is
 * null. Outcomes carry no branch or environment, so only the project filters
 * narrow them.
 */
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  failureClusters,
  failureDiagnoses,
  failureDiagnosisVersions,
  projects,
  testRuns,
  testRunsCases,
} from '../../../server/database/schema';
import { readOutcomeCounts } from '../../../server/utils/outcomes';
import { CAPABILITY_BY_ID, parseProjectDecisions, type CapabilityId } from '../../capabilities';
import type { HandbackKind, HandbackOutcome } from '../../handback-outcomes';
import { getMetric, HANDBACK_MIN_SAMPLE, type MetricId } from '../../analytics/metrics';
import type { AnalyticsHandbacks, AnalyticsSeriesPoint } from '../../analytics/types';
import type { AnalyticsScope } from '../../analytics/scope';
import type { DrizzleDB } from '../db';
import { resolveProjectStates } from '../capabilities';
import { getInstanceDecisions } from '../setup-status';
import {
  dayRange,
  getAnalyticsContext,
  makeTimeBuckets,
  roundRate,
  type AnalyticsContext,
  type ProjectAccess,
} from './common';

/** The hand-back metrics, read by this module. */
export const HANDBACK_METRIC_IDS = [
  'heal-adoption',
  'heal-pr-merge-rate',
  'diagnosis-helpful-rate',
  'diagnosis-verified-rate',
  'gate-blocked-merges',
  'gate-overrides',
  'flakes-verified-fixed',
] as const satisfies readonly MetricId[];

export type HandbackMetricId = (typeof HANDBACK_METRIC_IDS)[number];

export function isHandbackMetric(id: MetricId): id is HandbackMetricId {
  return (HANDBACK_METRIC_IDS as readonly MetricId[]).includes(id);
}

/** The capability each outcome kind follows; a kind with none is never hidden. */
const KIND_CAPABILITY: Partial<Record<HandbackKind, CapabilityId>> = {
  'locator-heal': 'locator-healing',
  'auto-heal-pr': 'auto-heal',
  diagnosis: 'ai',
  'flake-verify': 'flake-lab',
};

/** The outcome kinds the metrics count by outcome. */
const COUNTED_KINDS: HandbackKind[] = [
  'locator-heal',
  'auto-heal-pr',
  'diagnosis',
  'gate',
  'flake-verify',
  'fix-attempt',
];

/** The outcome kind and outcome a count metric counts, for its series. */
const COUNT_METRIC_CELLS: Partial<Record<HandbackMetricId, { kind: HandbackKind; outcome: HandbackOutcome }>> = {
  'heal-adoption': { kind: 'locator-heal', outcome: 'applied' },
  'gate-blocked-merges': { kind: 'gate', outcome: 'suggested' },
  'gate-overrides': { kind: 'gate', outcome: 'rejected' },
  'flakes-verified-fixed': { kind: 'flake-verify', outcome: 'verified' },
};

type OutcomeTally = Record<HandbackOutcome, number>;

const emptyTally = (): OutcomeTally => ({ suggested: 0, applied: 0, verified: 0, rejected: 0, regressed: 0 });

/** What the hand-backs of a period came to; a kind is null where its capability is declined everywhere. */
export interface HandbackCounts {
  outcomes: Partial<Record<HandbackKind, OutcomeTally>>;
  /** Diagnoses written in the period, those rated, and those rated helpful. Null where `ai` is declined. */
  ratings: { written: number; rated: number; helpful: number } | null;
  /** Failure clusters fixed in the period that carry a completed diagnosis. Null where `ai` is declined. */
  diagnosedFixes: number | null;
}

/** Per capability, the projects of the scope that have not declined it. */
async function projectsByCapability(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  capabilities: CapabilityId[],
): Promise<Map<CapabilityId, number[]>> {
  const rows = await db
    .select({ id: projects.id, capabilities: projects.capabilities })
    .from(projects)
    .where(ctx.allowed === 'all' ? undefined : inArray(projects.id, ctx.allowed));
  const instance = await getInstanceDecisions(db);
  // A capability, or the one it rides on, that any decision declines.
  const watched = (id: CapabilityId): CapabilityId[] => {
    const follows = CAPABILITY_BY_ID[id].follows;
    return follows ? [id, follows] : [id];
  };
  const out = new Map<CapabilityId, number[]>(capabilities.map((c) => [c, []]));
  for (const row of rows) {
    const decisions = parseProjectDecisions(row.capabilities ?? null);
    const mayDecline = capabilities.some((c) =>
      watched(c).some((w) => decisions[w] === 'declined' || instance[w] === 'declined'),
    );
    const states = mayDecline ? await resolveProjectStates(db, row.id) : null;
    for (const c of capabilities) {
      if (states?.[c] !== 'declined') out.get(c)!.push(row.id);
    }
  }
  return out;
}

/** Diagnoses written in `[from, to)`, current and earlier versions, with their rating and project. */
async function loadRatings(db: DrizzleDB, projectIds: number[], from: Date, to: Date) {
  if (projectIds.length === 0) return { written: 0, rated: 0, helpful: 0 };
  const read = async (table: typeof failureDiagnoses | typeof failureDiagnosisVersions) => {
    const projectId = sql<number>`coalesce(${failureClusters.projectId}, ${testRuns.projectId})`;
    const rows = await db
      .select({ feedback: table.feedback, projectId })
      .from(table)
      .leftJoin(failureClusters, eq(table.clusterId, failureClusters.id))
      .leftJoin(testRunsCases, eq(table.testRunsCaseId, testRunsCases.id))
      .leftJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(and(eq(table.status, 'completed'), gte(table.createdAt, from), lt(table.createdAt, to)));
    return rows.filter((r) => projectIds.includes(Number(r.projectId)));
  };
  const rows = [...(await read(failureDiagnoses)), ...(await read(failureDiagnosisVersions))];
  return {
    written: rows.length,
    rated: rows.filter((r) => r.feedback === 'up' || r.feedback === 'down').length,
    helpful: rows.filter((r) => r.feedback === 'up').length,
  };
}

/** Failure clusters whose fix landed in `[from, to)` and that carry a completed cluster diagnosis. */
async function countDiagnosedFixes(db: DrizzleDB, projectIds: number[], from: Date, to: Date): Promise<number> {
  if (projectIds.length === 0) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(failureClusters)
    .innerJoin(
      failureDiagnoses,
      and(
        eq(failureDiagnoses.clusterId, failureClusters.id),
        eq(failureDiagnoses.scope, 'cluster'),
        eq(failureDiagnoses.status, 'completed'),
      ),
    )
    .where(
      and(
        inArray(failureClusters.projectId, projectIds),
        gte(failureClusters.fixLandedAt, from),
        lt(failureClusters.fixLandedAt, to),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The projects each kind counts in; the kinds with no capability count in every project of the scope. */
async function kindProjects(
  db: DrizzleDB,
  ctx: AnalyticsContext,
): Promise<{ all: number[]; byKind: Map<HandbackKind, number[]>; ai: number[] }> {
  const capabilities = [...new Set(Object.values(KIND_CAPABILITY))];
  const byCapability = await projectsByCapability(db, ctx, capabilities);
  const all =
    ctx.allowed === 'all' ? (await db.select({ id: projects.id }).from(projects)).map((p) => p.id) : [...ctx.allowed];
  const byKind = new Map<HandbackKind, number[]>();
  for (const kind of COUNTED_KINDS) {
    const capability = KIND_CAPABILITY[kind];
    byKind.set(kind, capability ? byCapability.get(capability)! : all);
  }
  return { all, byKind, ai: byCapability.get('ai')! };
}

/** The hand-back counts of the scope over `[fromMs, toMs)`. */
export async function loadHandbackCounts(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<HandbackCounts> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return { outcomes: {}, ratings: null, diagnosedFixes: null };
  const { all, byKind, ai } = await kindProjects(db, ctx);
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const [cells, ratings, diagnosedFixes] = await Promise.all([
    readOutcomeCounts(db, { projectIds: all, ...dayRange(fromMs, toMs), kinds: COUNTED_KINDS }),
    ai.length > 0 ? loadRatings(db, ai, from, to) : Promise.resolve(null),
    ai.length > 0 ? countDiagnosedFixes(db, ai, from, to) : Promise.resolve(null),
  ]);
  const outcomes: HandbackCounts['outcomes'] = {};
  for (const kind of COUNTED_KINDS) {
    if (byKind.get(kind)!.length > 0) outcomes[kind] = emptyTally();
  }
  for (const cell of cells) {
    const tally = outcomes[cell.kind];
    if (tally && byKind.get(cell.kind)!.includes(cell.projectId)) tally[cell.outcome] += cell.count;
  }
  return { outcomes, ratings, diagnosedFixes };
}

/** A rate over a sample, null below the sample floor. */
function rateAbove(part: number, whole: number, min = HANDBACK_MIN_SAMPLE): number | null {
  return whole >= min ? roundRate(Math.min(part, whole), whole) : null;
}

/**
 * A hand-back metric's value and the size of the sample a rate is computed
 * over; the value is null where its capability is declined everywhere, and for
 * a rate below its sample floor.
 */
export function handbackMetricValue(
  id: HandbackMetricId,
  counts: HandbackCounts,
): { value: number | null; sample: number | null } {
  const o = counts.outcomes;
  switch (id) {
    case 'heal-adoption':
      return { value: o['locator-heal']?.applied ?? null, sample: null };
    case 'heal-pr-merge-rate': {
      const prs = o['auto-heal-pr'];
      if (!prs) return { value: null, sample: null };
      const settled = prs.applied + prs.rejected;
      return { value: rateAbove(prs.applied, settled), sample: settled };
    }
    case 'diagnosis-helpful-rate': {
      const r = counts.ratings;
      return r ? { value: rateAbove(r.helpful, r.rated), sample: r.rated } : { value: null, sample: null };
    }
    case 'diagnosis-verified-rate': {
      const fixes = counts.diagnosedFixes;
      const verified = o.diagnosis?.verified ?? 0;
      return fixes === null ? { value: null, sample: null } : { value: rateAbove(verified, fixes), sample: fixes };
    }
    case 'gate-blocked-merges':
      return { value: o.gate?.suggested ?? null, sample: null };
    case 'gate-overrides':
      return { value: o.gate?.rejected ?? null, sample: null };
    case 'flakes-verified-fixed':
      return { value: o['flake-verify']?.verified ?? null, sample: null };
  }
}

/** Whether a hand-back metric has a series over time: the counts do, the rates do not. */
export function hasHandbackSeries(id: HandbackMetricId): boolean {
  return id in COUNT_METRIC_CELLS;
}

/** A count metric bucketed over `[fromMs, toMs)`; null for a rate. */
export async function handbackMetricSeries(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  id: HandbackMetricId,
  fromMs: number,
  toMs: number,
): Promise<AnalyticsSeriesPoint[] | null> {
  const cell = COUNT_METRIC_CELLS[id];
  if (!cell) return null;
  const buckets = makeTimeBuckets(fromMs, toMs, ctx.scope.granularity);
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return buckets.keys.map((date) => ({ date, value: null }));
  const { all, byKind } = await kindProjects(db, ctx);
  const allowed = byKind.get(cell.kind)!;
  if (allowed.length === 0) return buckets.keys.map((date) => ({ date, value: null }));
  const cells = await readOutcomeCounts(db, { projectIds: all, ...dayRange(fromMs, toMs), kinds: [cell.kind] });
  const sums = new Map<string, number>();
  for (const c of cells) {
    if (c.outcome !== cell.outcome || !allowed.includes(c.projectId)) continue;
    const key = buckets.keyFor(c.day);
    if (key) sums.set(key, (sums.get(key) ?? 0) + c.count);
  }
  return buckets.keys.map((date) => ({ date, value: sums.get(date) ?? 0 }));
}

/**
 * The Hand-back outcomes widget: one row per kind of hand-back with what
 * became of it, and the hand-back metrics with their change. A kind whose
 * capability every project in scope declined is left out.
 */
export async function getAnalyticsHandbacks(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
): Promise<AnalyticsHandbacks> {
  const ctx = await getAnalyticsContext(db, scope, access);
  const [counts, previous] = await Promise.all([
    loadHandbackCounts(db, ctx, ctx.period.from.getTime(), ctx.period.to.getTime()),
    ctx.comparison
      ? loadHandbackCounts(db, ctx, ctx.comparison.from.getTime(), ctx.comparison.to.getTime())
      : Promise.resolve(null),
  ]);
  const o = counts.outcomes;
  const heals = o['locator-heal'];
  const prs = o['auto-heal-pr'];
  const gate = o.gate;
  const flakes = o['flake-verify'];
  const attempts = o['fix-attempt'];
  return {
    minSample: HANDBACK_MIN_SAMPLE,
    heals: heals ? { suggested: heals.suggested, adopted: heals.applied, verified: heals.verified } : null,
    healPullRequests: prs
      ? { opened: prs.suggested, merged: prs.applied, closed: prs.rejected, verified: prs.verified }
      : null,
    diagnoses:
      counts.ratings && counts.diagnosedFixes !== null
        ? {
            written: counts.ratings.written,
            rated: counts.ratings.rated,
            helpful: counts.ratings.helpful,
            diagnosedFixes: counts.diagnosedFixes,
            verified: o.diagnosis?.verified ?? 0,
            regressed: o.diagnosis?.regressed ?? 0,
          }
        : null,
    gate: gate ? { blocked: gate.suggested, overrides: gate.rejected, escapes: gate.regressed } : null,
    flakes: flakes ? { verified: flakes.verified, regressed: flakes.regressed } : null,
    fixAttempts: attempts
      ? { reported: attempts.applied, verified: attempts.verified, regressed: attempts.regressed }
      : null,
    metrics: HANDBACK_METRIC_IDS.map((id) => {
      const current = handbackMetricValue(id, counts);
      const before = previous ? handbackMetricValue(id, previous) : null;
      const def = getMetric(id);
      return {
        metric: id,
        label: def.label,
        unit: def.unit,
        value: current.value,
        previous: before?.value ?? null,
        sample: current.sample,
      };
    }).filter((m) => m.value !== null || m.sample !== null),
  };
}
