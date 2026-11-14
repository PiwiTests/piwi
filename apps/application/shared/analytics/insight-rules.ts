/**
 * Rule registry for the analytics insights feed. Every rule is a pure
 * function over the already-computed widget aggregates — no DB access — so
 * rules are trivially unit-testable and adding one is a single entry here.
 *
 * A rule computes the facts of its finding (`InsightFactsByRule`); the
 * sentences are written from those facts by a phrasebook, one sentence writer
 * per rule. The English phrasebook below writes the `message` and `detail` the
 * analytics page shows; a quality report in another language rewrites the
 * same facts with its own phrasebook (`FR_INSIGHTS` in `shared/reports/sentences.fr.ts`).
 */

import type {
  AnalyticsCiTimeTrend,
  AnalyticsClusterLandscape,
  AnalyticsFlakyDebt,
  AnalyticsFlakyRow,
  AnalyticsInsight,
  AnalyticsOwnership,
  AnalyticsPortfolioRow,
  AnalyticsRegressionVelocity,
  AnalyticsSlowEndpoints,
  AnalyticsSuiteGrowth,
  AnalyticsTimeToFix,
  AnalyticsTimeoutHygiene,
  AnalyticsWastedTime,
} from './types';
import type { AnalyticsScope } from './scope';
import type { CalendarUnit } from './period';
import { getMetric, type MetricId } from './metrics';
import type { ProjectTargetVerdict } from './targets';

export interface InsightContext {
  scope: AnalyticsScope;
  portfolio: AnalyticsPortfolioRow[];
  ciTime: AnalyticsCiTimeTrend;
  wastedTime: AnalyticsWastedTime;
  clusters: AnalyticsClusterLandscape;
  flakyTests: AnalyticsFlakyRow[];
  regressionVelocity: AnalyticsRegressionVelocity;
  slowEndpoints: AnalyticsSlowEndpoints;
  timeoutHygiene: AnalyticsTimeoutHygiene;
  /** The targets of the projects in scope over the period, met or missed. */
  targets?: ProjectTargetVerdict[];
  timeToFix?: AnalyticsTimeToFix;
  suiteGrowth?: AnalyticsSuiteGrowth;
  flakyDebt?: AnalyticsFlakyDebt;
  ownership?: AnalyticsOwnership;
}

export interface InsightRule {
  id: InsightRuleId;
  evaluate(ctx: InsightContext): AnalyticsInsight[];
}

const SEVERITY_ORDER: Record<AnalyticsInsight['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

// ── Facts ─────────────────────────────────────────────────────────────────────

/** The period a change is measured against, as an insight names it. */
export type InsightComparison =
  | { kind: 'year' }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'previous-unit'; unit: CalendarUnit }
  | { kind: 'previous-release' }
  | { kind: 'previous-sprint' }
  | { kind: 'previous-days'; days: number }
  | { kind: 'previous-period' };

/** The values each rule writes its sentences from, by rule. */
export interface InsightFactsByRule {
  'pass-rate-drop': { project: string; points: number; passRate: number; runs: number; vs: InsightComparison };
  'pass-rate-recovery': { project: string; points: number; passRate: number; runs: number; vs: InsightComparison };
  'failing-streak': { project: string; streak: number; latestRun: { id: number; status: string } | null };
  'stale-cluster': { title: string; ageDays: number; occurrences: number; project: string; errorType: string | null };
  'ci-time-growth': { deltaPct: number; minutes: number; runs: number; vs: InsightComparison };
  'wasted-ci-time': { hours: number; worst: { project: string; minutes: number } | null };
  'top-flaky-impact': { title: string; minutes: number; project: string; retryPassRuns: number; totalRuns: number };
  'regression-surge': { deltaPct: number; total: number; previous: number; vs: InsightComparison };
  'slow-shared-endpoint': {
    method: string;
    route: string;
    p90Ms: number;
    projects: number;
    requests: number;
    errorRate: number;
  };
  'timeout-hygiene': {
    title: string;
    project: string;
    /** Still marked `test.slow()` though it runs well under its budget; otherwise an oversized timeout. */
    staleSlow: boolean;
    timeoutMs: number;
    p95Ms: number;
    recommendedMs: number;
    savingMs: number;
  };
  'target-missed': { project: string; metric: MetricId; direction: 'min' | 'max'; actual: number; target: number };
  'time-to-fix-growth': { days: number; previousDays: number; fixed: number; vs: InsightComparison };
  'suite-shrank': { lost: number; previous: number; now: number; vs: InsightComparison };
  'quarantine-debt-growth': { added: number; now: number; previous: number; vs: InsightComparison };
  'owner-load': { owner: string; open: number; total: number; share: number };
}

export type InsightRuleId = keyof InsightFactsByRule;

/** An insight's facts, with the rule they belong to. */
export type InsightFacts = { [K in InsightRuleId]: { rule: K } & InsightFactsByRule[K] }[InsightRuleId];

export interface InsightText {
  message: string;
  detail?: string;
}

/** One sentence writer per rule; a language implements them all. */
export type InsightPhrasebook<Args extends unknown[] = []> = {
  [K in InsightRuleId]: (facts: InsightFactsByRule[K], ...args: Args) => InsightText;
};

/** Write an insight's sentences with a phrasebook. */
export function writeInsight<Args extends unknown[]>(
  book: InsightPhrasebook<Args>,
  facts: InsightFacts,
  ...args: Args
): InsightText {
  const write = book[facts.rule] as (facts: InsightFacts, ...args: Args) => InsightText;
  return write(facts, ...args);
}

/** How an insight names the period a change is measured against. */
export function insightComparison(scope: AnalyticsScope): InsightComparison {
  const { period, comparison } = scope;
  if (comparison.kind === 'year') return { kind: 'year' };
  if (comparison.kind === 'range') return { kind: 'range', from: comparison.from, to: comparison.to };
  if (comparison.kind === 'previous-unit') {
    if (period.kind === 'calendar') return { kind: 'previous-unit', unit: period.unit };
    if (period.kind === 'release') return { kind: 'previous-release' };
    if (period.kind === 'sprint') return { kind: 'previous-sprint' };
  }
  if (period.kind === 'rolling') return { kind: 'previous-days', days: period.days };
  return { kind: 'previous-period' };
}

// ── English sentences ─────────────────────────────────────────────────────────

function englishComparison(vs: InsightComparison): string {
  switch (vs.kind) {
    case 'year':
      return 'the same period a year earlier';
    case 'range':
      return `${vs.from} to ${vs.to}`;
    case 'previous-unit':
      return `the previous ${vs.unit}`;
    case 'previous-release':
      return 'the previous release cycle';
    case 'previous-sprint':
      return 'the previous sprint';
    case 'previous-days':
      return `the previous ${vs.days} days`;
    case 'previous-period':
      return 'the previous period';
  }
}

/** Compact ms → human string for insight copy (e.g. 90000 → "90s"). */
function fmtMs(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms)}ms`;
}

/** How far off a target a value is, rounded to the metric's precision. */
export function targetGapValue(facts: InsightFactsByRule['target-missed']): number {
  const def = getMetric(facts.metric);
  const gap = Math.abs(facts.actual - facts.target);
  return Math.round(gap * 10 ** def.precision) / 10 ** def.precision;
}

/** How far off a target a value is, in the metric's unit ("1.2 pts", "3 days"). */
function targetGap(facts: InsightFactsByRule['target-missed']): string {
  const def = getMetric(facts.metric);
  const rounded = targetGapValue(facts);
  const unit = def.unit === 'percent' ? 'pts' : def.unit === 'days' ? 'days' : def.unit === 'minutes' ? 'min' : '';
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

function targetValue(metric: MetricId, value: number): string {
  const def = getMetric(metric);
  if (def.unit === 'percent') return `${value}%`;
  if (def.unit === 'days') return `${value} days`;
  if (def.unit === 'minutes') return `${value} min`;
  return String(value);
}

/** The sentences of the analytics page. */
export const EN_INSIGHTS: InsightPhrasebook = {
  'pass-rate-drop': (f) => ({
    message: `${f.project} pass rate dropped ${f.points} pts vs ${englishComparison(f.vs)}`,
    detail: `Now at ${f.passRate}% over ${f.runs} runs.`,
  }),
  'pass-rate-recovery': (f) => ({
    message: `${f.project} pass rate improved ${f.points} pts vs ${englishComparison(f.vs)}`,
    detail: `Now at ${f.passRate}% over ${f.runs} runs.`,
  }),
  'failing-streak': (f) => ({
    message: `${f.project} has failed ${f.streak} runs in a row`,
    detail: f.latestRun ? `Latest run #${f.latestRun.id} ${f.latestRun.status}.` : undefined,
  }),
  'stale-cluster': (f) => ({
    message: `"${f.title}" has been open for ${f.ageDays} days (${f.occurrences} occurrences)`,
    detail: `${f.project} · ${f.errorType ?? 'unknown'} error.`,
  }),
  'ci-time-growth': (f) => ({
    message: `CI time grew ${f.deltaPct}% vs ${englishComparison(f.vs)}`,
    detail: `${f.minutes} minutes across ${f.runs} runs this period.`,
  }),
  'wasted-ci-time': (f) => ({
    message: `${f.hours} h of CI time went to waits and failed attempts this period`,
    detail: f.worst ? `${f.worst.project} alone accounts for ${f.worst.minutes} minutes.` : undefined,
  }),
  'top-flaky-impact': (f) => ({
    message: `"${f.title}" wasted ${f.minutes} CI minutes on flaky retries`,
    detail: `${f.project} · flaked in ${f.retryPassRuns} of ${f.totalRuns} recent runs.`,
  }),
  'regression-surge': (f) => ({
    message: `New regressions rose ${f.deltaPct}% vs ${englishComparison(f.vs)}`,
    detail: `${f.total} this period, up from ${f.previous}.`,
  }),
  'slow-shared-endpoint': (f) => ({
    message: `${f.method} ${f.route} is slow (p90 ${f.p90Ms} ms) across ${f.projects} projects`,
    detail: `${f.requests} requests this period${f.errorRate > 0 ? ` · ${f.errorRate}% errored` : ''}.`,
  }),
  'timeout-hygiene': (f) => ({
    message: f.staleSlow
      ? `"${f.title}" is still marked test.slow() but runs well under budget`
      : `"${f.title}" has an oversized timeout (${fmtMs(f.timeoutMs)} vs p95 ${fmtMs(f.p95Ms)})`,
    detail:
      `${f.project} · ` +
      (f.staleSlow
        ? `remove test.slow() to reclaim ~${fmtMs(f.savingMs)} per failing run.`
        : `lower it toward ${fmtMs(f.recommendedMs)} to reclaim ~${fmtMs(f.savingMs)} per failing run.`),
  }),
  'target-missed': (f) => ({
    message: `${f.project} ${getMetric(f.metric).label.toLowerCase()} is ${targetGap(f)} ${f.direction === 'min' ? 'under' : 'over'} its target`,
    detail: `${targetValue(f.metric, f.actual)} against a target of ${f.direction === 'min' ? 'at least' : 'at most'} ${targetValue(f.metric, f.target)}.`,
  }),
  'time-to-fix-growth': (f) => ({
    message: `Median time to fix grew to ${f.days} days vs ${englishComparison(f.vs)}`,
    detail: `Up from ${f.previousDays} days, over ${f.fixed} failure clusters fixed this period.`,
  }),
  'suite-shrank': (f) => ({
    message: `The suite shrank by ${f.lost} tests vs ${englishComparison(f.vs)}`,
    detail: `From ${f.previous} to ${f.now} tests; check nothing was skipped or deleted by mistake.`,
  }),
  'quarantine-debt-growth': (f) => ({
    message: `${f.added} more tests in quarantine vs ${englishComparison(f.vs)}`,
    detail: `${f.now} tests are in quarantine now, up from ${f.previous}.`,
  }),
  'owner-load': (f) => ({
    message: `${f.owner} holds ${f.open} of the ${f.total} open failure clusters`,
    detail: `${f.share}% of the open failure clusters wait on one owner.`,
  }),
};

// ── Rules ─────────────────────────────────────────────────────────────────────

function projectDisplay(row: { name: string; label: string | null }): string {
  return row.label || row.name;
}

/** An insight from a rule's facts: its English sentences, and the facts for another language. */
function insight<K extends InsightRuleId>(
  rule: K,
  facts: InsightFactsByRule[K],
  meta: Pick<AnalyticsInsight, 'id' | 'severity' | 'to' | 'projectId'>,
): AnalyticsInsight {
  const all = { rule, ...facts } as InsightFacts;
  const text = writeInsight(EN_INSIGHTS, all);
  return { ...meta, ruleId: rule, message: text.message, detail: text.detail, facts: all };
}

const passRateDrop: InsightRule = {
  id: 'pass-rate-drop',
  evaluate: ({ portfolio, scope }) =>
    portfolio
      .filter((p) => p.passRateDelta !== null && p.passRateDelta <= -5 && p.runCount >= 3)
      .map((p) =>
        insight(
          'pass-rate-drop',
          {
            project: projectDisplay(p),
            points: Math.abs(p.passRateDelta!),
            passRate: p.passRate!,
            runs: p.runCount,
            vs: insightComparison(scope),
          },
          {
            id: `pass-rate-drop:${p.projectId}`,
            severity: p.passRateDelta! <= -15 ? 'critical' : 'warning',
            to: `/projects/${p.projectId}`,
            projectId: p.projectId,
          },
        ),
      ),
};

const passRateRecovery: InsightRule = {
  id: 'pass-rate-recovery',
  evaluate: ({ portfolio, scope }) =>
    portfolio
      .filter((p) => p.passRateDelta !== null && p.passRateDelta >= 10 && p.runCount >= 3)
      .map((p) =>
        insight(
          'pass-rate-recovery',
          {
            project: projectDisplay(p),
            points: p.passRateDelta!,
            passRate: p.passRate!,
            runs: p.runCount,
            vs: insightComparison(scope),
          },
          {
            id: `pass-rate-recovery:${p.projectId}`,
            severity: 'positive',
            to: `/projects/${p.projectId}`,
            projectId: p.projectId,
          },
        ),
      ),
};

const failingStreak: InsightRule = {
  id: 'failing-streak',
  evaluate: ({ portfolio }) =>
    portfolio
      .filter((p) => p.failingStreak >= 3)
      .map((p) =>
        insight(
          'failing-streak',
          {
            project: projectDisplay(p),
            streak: p.failingStreak,
            latestRun: p.latestRun ? { id: p.latestRun.id, status: p.latestRun.status } : null,
          },
          {
            id: `failing-streak:${p.projectId}`,
            severity: 'critical',
            to: `/projects/${p.projectId}`,
            projectId: p.projectId,
          },
        ),
      ),
};

const staleCluster: InsightRule = {
  id: 'stale-cluster',
  evaluate: ({ clusters }) =>
    clusters.clusters
      .filter((c) => c.ageDays >= 14 && c.occurrences >= 10)
      .slice(0, 3)
      .map((c) =>
        insight(
          'stale-cluster',
          {
            title: c.title || c.signature,
            ageDays: c.ageDays,
            occurrences: c.occurrences,
            project: projectDisplay({ name: c.projectName, label: c.projectLabel }),
            errorType: c.errorType ?? null,
          },
          {
            id: `stale-cluster:${c.id}`,
            severity: c.ageDays >= 30 ? 'critical' : 'warning',
            to: `/failure-clusters/${c.id}`,
            projectId: c.projectId,
          },
        ),
      ),
};

const ciTimeGrowth: InsightRule = {
  id: 'ci-time-growth',
  evaluate: ({ ciTime, scope }) => {
    if (ciTime.deltaPct === null || ciTime.deltaPct < 25 || ciTime.totalMinutes < 30) return [];
    return [
      insight(
        'ci-time-growth',
        {
          deltaPct: ciTime.deltaPct,
          minutes: Math.round(ciTime.totalMinutes),
          runs: ciTime.runCount,
          vs: insightComparison(scope),
        },
        { id: 'ci-time-growth', severity: ciTime.deltaPct >= 50 ? 'warning' : 'info' },
      ),
    ];
  },
};

const wastedCiTime: InsightRule = {
  id: 'wasted-ci-time',
  evaluate: ({ wastedTime }) => {
    const totalWasted = wastedTime.totalWaitMinutes + wastedTime.totalFailedExecMinutes;
    if (totalWasted < 60) return [];
    const worst = wastedTime.byProject[0];
    return [
      insight(
        'wasted-ci-time',
        {
          hours: Math.round((totalWasted / 60) * 10) / 10,
          worst: worst
            ? { project: projectDisplay(worst), minutes: Math.round(worst.waitMinutes + worst.failedExecMinutes) }
            : null,
        },
        {
          id: 'wasted-ci-time',
          severity: totalWasted >= 240 ? 'warning' : 'info',
          to: worst ? `/projects/${worst.projectId}` : undefined,
          projectId: worst?.projectId,
        },
      ),
    ];
  },
};

const topFlakyImpact: InsightRule = {
  id: 'top-flaky-impact',
  evaluate: ({ flakyTests }) =>
    flakyTests
      .filter((t) => t.wastedCiMinutes >= 10)
      .slice(0, 2)
      .map((t) =>
        insight(
          'top-flaky-impact',
          {
            title: t.title,
            minutes: Math.round(t.wastedCiMinutes),
            project: projectDisplay({ name: t.projectName, label: t.projectLabel }),
            retryPassRuns: t.retryPassRuns,
            totalRuns: t.totalRuns,
          },
          {
            id: `top-flaky-impact:${t.testCaseId}`,
            severity: 'warning',
            to: `/test-cases/${t.testCaseId}`,
            projectId: t.projectId,
          },
        ),
      ),
};

const regressionSurge: InsightRule = {
  id: 'regression-surge',
  evaluate: ({ regressionVelocity, scope }) => {
    const { totalRegressions, prevRegressions, deltaPct } = regressionVelocity;
    // A change is measured only against a previous period that had regressions.
    if (totalRegressions < 5 || deltaPct === null || prevRegressions === null || deltaPct < 50) return [];
    return [
      insight(
        'regression-surge',
        { deltaPct, total: totalRegressions, previous: prevRegressions, vs: insightComparison(scope) },
        { id: 'regression-surge', severity: deltaPct >= 100 ? 'warning' : 'info' },
      ),
    ];
  },
};

const slowSharedEndpoint: InsightRule = {
  id: 'slow-shared-endpoint',
  evaluate: ({ slowEndpoints }) =>
    slowEndpoints.endpoints
      // A slow call hit by several projects points at a shared backend, not one flaky test.
      .filter((ep) => ep.projectCount >= 2 && ep.p90Ms >= 1000)
      .slice(0, 2)
      .map((ep) =>
        insight(
          'slow-shared-endpoint',
          {
            method: ep.method,
            route: ep.route,
            p90Ms: ep.p90Ms,
            projects: ep.projectCount,
            requests: ep.requests,
            errorRate: ep.errorRate,
          },
          { id: `slow-shared-endpoint:${ep.method}:${ep.route}`, severity: 'warning' },
        ),
      ),
};

const timeoutHygiene: InsightRule = {
  id: 'timeout-hygiene',
  evaluate: ({ timeoutHygiene }) =>
    timeoutHygiene.rows
      // Only surface materially wasteful budgets in the cross-project feed;
      // the per-project table shows the long tail.
      .filter((r) => r.estimatedSavingMs >= 15_000)
      .slice(0, 2)
      .map((r) =>
        insight(
          'timeout-hygiene',
          {
            title: r.title,
            project: projectDisplay({ name: r.projectName, label: r.projectLabel }),
            staleSlow: r.kind === 'stale-slow',
            timeoutMs: r.timeout ?? 0,
            p95Ms: r.p95,
            recommendedMs: r.recommendedTimeout ?? 0,
            savingMs: r.estimatedSavingMs,
          },
          {
            id: `timeout-hygiene:${r.testCaseId}`,
            severity: r.estimatedSavingMs >= 60_000 ? 'warning' : 'info',
            to: `/test-cases/${r.testCaseId}`,
            projectId: r.projectId,
          },
        ),
      ),
};

const targetMissed: InsightRule = {
  id: 'target-missed',
  evaluate: ({ targets = [] }) =>
    targets
      .filter((t) => t.met === false && t.actual !== null)
      .map((t) =>
        insight(
          'target-missed',
          { project: t.projectName, metric: t.metric, direction: t.direction, actual: t.actual!, target: t.target },
          {
            id: `target-missed:${t.projectId}:${t.key}`,
            // A pass rate target missed by more than 5 points is critical; the rest warn.
            severity: t.metric === 'test-pass-rate' && t.target - (t.actual ?? 0) > 5 ? 'critical' : 'warning',
            to: `/projects/${t.projectId}?tab=settings&section=targets`,
            projectId: t.projectId,
          },
        ),
      ),
};

const timeToFixGrowth: InsightRule = {
  id: 'time-to-fix-growth',
  evaluate: ({ timeToFix, scope }) => {
    if (!timeToFix || timeToFix.fixed < 3) return [];
    const { medianDays: now, previousMedianDays: before } = timeToFix;
    // Half again as long, and at least a day longer: a fix now waits noticeably more.
    if (now === null || before === null || before <= 0 || now < before * 1.5 || now - before < 1) return [];
    return [
      insight(
        'time-to-fix-growth',
        { days: now, previousDays: before, fixed: timeToFix.fixed, vs: insightComparison(scope) },
        { id: 'time-to-fix-growth', severity: now >= before * 2 ? 'warning' : 'info' },
      ),
    ];
  },
};

const suiteShrank: InsightRule = {
  id: 'suite-shrank',
  evaluate: ({ suiteGrowth, scope }) => {
    if (!suiteGrowth || suiteGrowth.delta === null || suiteGrowth.previousSuiteSize === null) return [];
    const lost = -suiteGrowth.delta;
    // Five tests or five percent, whichever is more: a rename or two is not a shrink.
    if (lost < Math.max(5, suiteGrowth.previousSuiteSize * 0.05)) return [];
    return [
      insight(
        'suite-shrank',
        {
          lost,
          previous: suiteGrowth.previousSuiteSize,
          now: suiteGrowth.suiteSize!,
          vs: insightComparison(scope),
        },
        { id: 'suite-shrank', severity: lost >= suiteGrowth.previousSuiteSize * 0.2 ? 'warning' : 'info' },
      ),
    ];
  },
};

const quarantineDebtGrowth: InsightRule = {
  id: 'quarantine-debt-growth',
  evaluate: ({ flakyDebt, scope }) => {
    if (!flakyDebt || flakyDebt.previousQuarantined === null) return [];
    const added = flakyDebt.quarantined - flakyDebt.previousQuarantined;
    if (added < 3 && !(added > 0 && flakyDebt.previousQuarantined > 0 && added >= flakyDebt.previousQuarantined * 0.5))
      return [];
    return [
      insight(
        'quarantine-debt-growth',
        {
          added,
          now: flakyDebt.quarantined,
          previous: flakyDebt.previousQuarantined,
          vs: insightComparison(scope),
        },
        { id: 'quarantine-debt-growth', severity: added >= 10 ? 'warning' : 'info' },
      ),
    ];
  },
};

const ownerLoad: InsightRule = {
  id: 'owner-load',
  evaluate: ({ ownership }) => {
    if (!ownership || ownership.totalOpenClusters < 4) return [];
    const top = ownership.rows
      .filter((r) => r.owner !== null)
      .reduce<AnalyticsOwnership['rows'][number] | null>(
        (best, r) => (best === null || r.openClusters > best.openClusters ? r : best),
        null,
      );
    if (!top || top.openClusters * 2 <= ownership.totalOpenClusters) return [];
    return [
      insight(
        'owner-load',
        {
          owner: top.owner!,
          open: top.openClusters,
          total: ownership.totalOpenClusters,
          share: Math.round((top.openClusters / ownership.totalOpenClusters) * 100),
        },
        { id: `owner-load:${top.owner}`, severity: 'warning' },
      ),
    ];
  },
};

export const INSIGHT_RULES: InsightRule[] = [
  targetMissed,
  ownerLoad,
  timeToFixGrowth,
  suiteShrank,
  quarantineDebtGrowth,
  failingStreak,
  passRateDrop,
  staleCluster,
  topFlakyImpact,
  regressionSurge,
  slowSharedEndpoint,
  wastedCiTime,
  timeoutHygiene,
  ciTimeGrowth,
  passRateRecovery,
];

export function evaluateInsightRules(ctx: InsightContext): AnalyticsInsight[] {
  return INSIGHT_RULES.flatMap((rule) => rule.evaluate(ctx)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
