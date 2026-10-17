/**
 * Response payload shapes for the analytics widgets — shared between the
 * handlers (`shared/handlers/analytics/`), the demo router, and the client
 * components, so there is exactly one definition per widget payload.
 */

import type { InsightFacts } from './insight-rules';
import type { MetricId, MetricUnit } from './metrics';
import type { ProjectTargetVerdict } from './targets';

export interface AnalyticsTagInfo {
  id: number;
  text: string;
  color: string;
}

export interface AnalyticsSparkRun {
  id: number;
  status: string;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  totalTests: number;
  startTime: string | Date;
}

// ── Portfolio scorecard ──────────────────────────────────────────────────────

export interface AnalyticsPortfolioRow {
  projectId: number;
  name: string;
  label: string | null;
  tags: AnalyticsTagInfo[];
  /** Terminal runs inside the period. */
  runCount: number;
  /** Tests passed / tests run across all period runs, 0–100. Null when no tests ran. */
  passRate: number | null;
  /** Percentage-point change vs the previous equal-length period. Null without a baseline. */
  passRateDelta: number | null;
  /** Sum of flaky test occurrences across period runs. */
  flakyTests: number;
  avgRunDurationMs: number | null;
  openClusters: number;
  /** Consecutive failing runs at the newest end of the period. */
  failingStreak: number;
  latestRun: { id: number; status: string; startTime: string | Date } | null;
  /** Last runs of the period (oldest → newest), for the trend bars. */
  recentRuns: AnalyticsSparkRun[];
  /** The project's targets over the period, met or missed; empty when it has none. */
  targets: ProjectTargetVerdict[];
}

// ── Pass-rate heatmap ────────────────────────────────────────────────────────

export interface AnalyticsHeatmap {
  /** Bucket start dates (ISO `YYYY-MM-DD`), oldest → newest. */
  buckets: string[];
  /** Days covered by one bucket (1 = daily, 7 = weekly, 30 = monthly). */
  bucketDays: number;
  /** True when a cell is a calendar month. */
  monthly?: boolean;
  rows: Array<{
    projectId: number;
    name: string;
    label: string | null;
    /** Pass rate (0–100) per bucket; null = no runs in that bucket. */
    cells: Array<number | null>;
  }>;
}

// ── CI time trend ────────────────────────────────────────────────────────────

export interface AnalyticsCiTimePoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  totalMinutes: number;
  runCount: number;
}

export interface AnalyticsCiTimeTrend {
  points: AnalyticsCiTimePoint[];
  bucketDays: number;
  totalMinutes: number;
  runCount: number;
  /** Total minutes in the previous equal-length period. Null without a baseline. */
  prevTotalMinutes: number | null;
  /** Percent change vs the previous period. Null without a baseline. */
  deltaPct: number | null;
  avgRunMinutes: number | null;
}

// ── Wasted CI time ───────────────────────────────────────────────────────────

export interface AnalyticsWastedTimePoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  /** Minutes spent inside wait steps (waitFor*, timeouts). */
  waitMinutes: number;
  /** Minutes spent executing attempts that ended failed or timed out. */
  failedExecMinutes: number;
}

export interface AnalyticsWastedTime {
  points: AnalyticsWastedTimePoint[];
  bucketDays: number;
  totalWaitMinutes: number;
  totalFailedExecMinutes: number;
  byProject: Array<{
    projectId: number;
    name: string;
    label: string | null;
    waitMinutes: number;
    failedExecMinutes: number;
  }>;
  /**
   * Timeout-hygiene tie-in: much of the "failed attempts" time is tests hitting
   * an oversized timeout, so this is the wait reclaimable (upper bound) by
   * tightening oversized timeouts and removing stale `test.slow()` marks in
   * scope. Null when no opportunities were found.
   */
  /**
   * The wasted minutes as money, when a cost of a CI minute is configured
   * (Settings → Performance, `PIWI_CI_MINUTE_COST`); null otherwise.
   */
  cost: { amount: number; currency: string } | null;
  timeoutReclaimable: {
    /** Sum of per-failure savings across opportunities, in minutes. */
    estimatedMinutes: number;
    oversizedCount: number;
    staleSlowCount: number;
    /** Project of the highest-impact opportunity (for a deep link). */
    topProjectId: number | null;
  } | null;
}

// ── Global flaky leaderboard ─────────────────────────────────────────────────

export interface AnalyticsFlakyRow {
  projectId: number;
  projectName: string;
  projectLabel: string | null;
  testCaseId: number;
  latestRunsCaseId: number;
  title: string;
  filePath: string;
  totalRuns: number;
  retryPassRuns: number;
  alternations: number;
  score: number;
  rootCause: string | null;
  impact: number;
  wastedCiMinutes: number;
  lastFlakeAt: string | Date | null;
}

// ── Failure-cluster landscape ────────────────────────────────────────────────

export interface AnalyticsClusterRow {
  id: number;
  projectId: number;
  projectName: string;
  projectLabel: string | null;
  title: string | null;
  signature: string;
  errorType: string | null;
  selector: string | null;
  occurrences: number;
  ageDays: number;
  firstSeenAt: string | Date;
}

export interface AnalyticsClusterLandscape {
  totalOpen: number;
  /** Clusters resolved inside the period (by `updatedAt`). */
  resolvedInPeriod: number;
  byErrorType: Array<{ errorType: string; count: number }>;
  /** Top open clusters by occurrences. */
  clusters: AnalyticsClusterRow[];
}

// ── Regression velocity ──────────────────────────────────────────────────────

export interface AnalyticsRegressionPoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  /** Executions first failing this period (`isNewRegression`). */
  regressions: number;
  /** Executions newly flaky this period (`isNewFlaky`). */
  newFlaky: number;
}

export interface AnalyticsRegressionVelocity {
  points: AnalyticsRegressionPoint[];
  bucketDays: number;
  totalRegressions: number;
  totalNewFlaky: number;
  /** Regressions in the previous equal-length period. Null without a baseline. */
  prevRegressions: number | null;
  deltaPct: number | null;
}

// ── Browser matrix ───────────────────────────────────────────────────────────

export interface AnalyticsBrowserMatrix {
  /** Browser identities present in the period (column order). */
  browsers: string[];
  rows: Array<{
    projectId: number;
    name: string;
    label: string | null;
    /** Pass rate (0–100) per browser; null = the project ran no tests on it. */
    cells: Array<number | null>;
  }>;
}

// ── Slow endpoints ───────────────────────────────────────────────────────────

export interface AnalyticsSlowEndpointRow {
  method: string;
  route: string;
  requests: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  /** Share of requests with a 4xx/5xx status, 0–100. */
  errorRate: number;
  /** Distinct projects that hit this endpoint (shared-backend signal). */
  projectCount: number;
}

export interface AnalyticsSlowEndpoints {
  endpoints: AnalyticsSlowEndpointRow[];
  totalRequests: number;
}

// ── Insights feed ────────────────────────────────────────────────────────────

export type AnalyticsInsightSeverity = 'critical' | 'warning' | 'info' | 'positive';

export interface AnalyticsInsight {
  /** Stable id (`ruleId:subject`) so the client can key the list. */
  id: string;
  ruleId: string;
  severity: AnalyticsInsightSeverity;
  message: string;
  detail?: string;
  /** In-app route the insight deep-links to. */
  to?: string;
  projectId?: number;
  /** The values `message` and `detail` are written from, so a report can write them in its own language. */
  facts?: InsightFacts;
}

// ── Timeout hygiene ───────────────────────────────────────────────────────────

/** One cross-project timeout-reduction opportunity (see `timeout-hygiene.ts`). */
export interface AnalyticsTimeoutRow {
  projectId: number;
  projectName: string;
  projectLabel: string | null;
  testCaseId: number;
  title: string;
  filePath: string;
  kind: 'oversized-timeout' | 'stale-slow';
  timeout: number | null;
  p95: number;
  recommendedTimeout: number | null;
  estimatedSavingMs: number;
  impact: number;
  hasSlowAnnotation: boolean;
}

export interface AnalyticsTimeoutHygiene {
  rows: AnalyticsTimeoutRow[];
  oversizedCount: number;
  staleSlowCount: number;
  totalEstimatedSavingMs: number;
  /** Project of the highest-impact opportunity (for a deep link). */
  topProjectId: number | null;
}

// ── Scope summary ────────────────────────────────────────────────────────────

/** A timeline marker drawn on a trend, labeled with its project across projects. */
export interface AnalyticsMarker {
  id: number;
  projectId: number;
  projectName: string | null;
  occurredAt: string | Date;
  /** What the marker is, led by its project's name when the scope spans several projects. */
  label: string;
  /** The marker's label as it was entered, without the project; a report joins the two in its own language. */
  ownLabel?: string;
  description: string | null;
  category: string;
  environment: string | null;
  source: string;
  runId: number | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

export interface AnalyticsResolvedPeriod {
  /** ISO instants; `to` is exclusive. */
  from: string;
  to: string;
  label: string;
  /** Why the definition could not be used and the default period was shown instead. */
  fallback: string | null;
}

/** How a scope resolved: what the scope bar and the trend charts show around the widgets. */
export interface AnalyticsScopeSummary {
  period: AnalyticsResolvedPeriod;
  comparison: AnalyticsResolvedPeriod | null;
  notes: string[];
  /** Markers inside the period: every marker with one project in scope, else releases, infra and incidents. */
  markers: AnalyticsMarker[];
  /** Recent markers of the projects in scope, for the periods anchored on a marker. */
  anchors: AnalyticsMarker[];
  /** Selection keys known in the projects in scope, built-ins included. */
  selections: Array<{ key: string; name: string }>;
  /** Browsers the recent runs in scope ran on. */
  browsers: string[];
  /** Oldest UTC day of rollup data inside the period, null when there is none. */
  dataStartsAt: string | null;
  projectCount: number;
}

// ── Metric values (stats, metric, verdict) ───────────────────────────────────

/** One point of a metric series; null = nothing to count in that bucket. */
export interface AnalyticsSeriesPoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  value: number | null;
}

/** A metric's value over the period, with its comparison. */
export interface AnalyticsMetricValue {
  metric: MetricId;
  label: string;
  unit: MetricUnit;
  betterWhen: 'higher' | 'lower' | 'neutral';
  definition: string;
  precision: number;
  source: 'rollup' | 'live';
  value: number | null;
  /** The value over the comparison period. Null without a comparison or a baseline. */
  previous: number | null;
  /** `value - previous`, in points for a percentage. */
  delta: number | null;
  /** Relative change in percent, for units other than a percentage. */
  deltaPct: number | null;
  /** Whether the change reads as better or worse given the metric's direction. */
  trend: 'better' | 'worse' | 'same' | null;
  /** Currency of a money metric. */
  currency: string | null;
  /**
   * For a rate with a sample floor: how many items it is computed over, and the
   * floor. The value is null while `size` is under `min`.
   */
  sample?: { size: number; min: number } | null;
}

/** The target mark of a tile: how many projects in scope meet the metric's target. */
export interface AnalyticsTileTarget {
  /** The target over the period, when one project is in scope; null across projects. */
  target: number | null;
  direction: 'min' | 'max';
  /** Projects meeting and missing the target; a project with nothing to judge counts in neither. */
  met: number;
  missed: number;
}

export interface AnalyticsStatTile extends AnalyticsMetricValue {
  /** A second number shown under the tile (the cost of wasted minutes, the median time to fix). */
  companion: AnalyticsMetricValue | null;
  /** The metric's target, when a project in scope sets one. */
  target: AnalyticsTileTarget | null;
}

export interface AnalyticsStats {
  tiles: AnalyticsStatTile[];
  /** Label of the comparison period; null when the scope compares with nothing. */
  comparisonLabel: string | null;
}

/** One group of a metric breakdown, with its value and change like the whole metric's. */
export interface AnalyticsBreakdownGroup {
  key: string;
  label: string;
  value: AnalyticsMetricValue;
  /** The group's series over the period (line, bar over time and heatmap displays); null otherwise. */
  points: AnalyticsSeriesPoint[] | null;
  /** The group of everything outside the top groups. */
  other: boolean;
  /** How many groups the *Other* group holds. */
  rest?: number;
}

export interface AnalyticsMetricWidget {
  /** The display drawn: `stat` when the metric has no series to draw the one asked for. */
  display: 'line' | 'stat' | 'bar' | 'table' | 'heatmap';
  value: AnalyticsMetricValue;
  bucketDays: number;
  /** The series over the period; empty for the stat display or a metric with no series. */
  points: AnalyticsSeriesPoint[];
  /** The comparison period's series, aligned bucket for bucket; null when off or absent. */
  previousPoints: AnalyticsSeriesPoint[] | null;
  comparisonLabel: string | null;
  /** The metric cut by a dimension, top groups first; null without a breakdown. */
  breakdown: { dimension: string; label: string; groups: AnalyticsBreakdownGroup[] } | null;
  /**
   * The target line, with the target switch on and one project in scope that
   * sets a target on the metric; a weekly target is scaled to one bucket.
   */
  target: { value: number; direction: 'min' | 'max'; met: boolean | null } | null;
}

// ── Verdict, progress, risks ────────────────────────────────────────────────

export type VerdictTone = 'good' | 'mixed' | 'bad';

/** The numbers the rule-based verdict is built from. */
export interface VerdictFacts {
  runs: number;
  passRate: number | null;
  previousPassRate: number | null;
  /** Change in percentage points against the comparison period. */
  passRateDelta: number | null;
  fixed: number;
  opened: number;
  open: number;
  wastedMinutes: number;
  wastedCost: { amount: number; currency: string } | null;
  /** Which runs count: each project's default branch (named), every branch, or branches chosen by hand. */
  branch: { kind: 'default' | 'any' | 'list'; branches: string[] };
  comparison: 'previous' | 'previous-unit' | 'year' | 'custom' | 'none';
}

export interface AnalyticsVerdict {
  tone: VerdictTone;
  facts: VerdictFacts;
}

export interface AnalyticsClusterItem {
  id: number;
  projectId: number;
  projectName: string;
  title: string;
  /** Days since the cluster was first seen. */
  ageDays: number;
  assignee: string | null;
  occurrences: number;
}

export interface AnalyticsProgress {
  /** Failure causes whose fix landed in the period. */
  fixed: number;
  /** Of those, the ones that have not failed again. */
  held: number;
  /** Open failure causes someone is assigned to. */
  assigned: number;
  /** Open failure causes linked to a tracker ticket. */
  withTicket: number;
  releasedFromQuarantine: number;
  quarantined: number;
  /** Auto-heal pull requests opened in the period. */
  healPullRequests: number;
  /** The fixes of the period, newest first. */
  recentFixes: Array<AnalyticsClusterItem & { fixedAt: string; held: boolean }>;
}

export interface AnalyticsRiskMetric {
  metric: MetricId;
  label: string;
  unit: MetricUnit;
  value: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
}

export interface AnalyticsRisks {
  /** Metrics that moved the wrong way by more than their threshold. */
  worsening: AnalyticsRiskMetric[];
  /** Projects whose latest runs failed in a row, longest streak first. */
  failingProjects: Array<{ projectId: number; name: string; streak: number }>;
  /** The oldest open failure causes. */
  oldestOpen: AnalyticsClusterItem[];
  openCount: number;
  quarantine: { count: number; oldestDays: number | null };
  /** Targets the projects in scope missed over the period. */
  missedTargets: ProjectTargetVerdict[];
}

/** One hand-back metric in the Hand-back outcomes widget. */
export interface AnalyticsHandbackMetric {
  metric: MetricId;
  label: string;
  unit: MetricUnit;
  /** Null for a rate below its sample floor. */
  value: number | null;
  previous: number | null;
  /** The number of items a rate is computed over; null for a count. */
  sample: number | null;
}

/**
 * What became of Piwi's hand-backs over the period, per kind. A kind is null
 * when every project in scope declined the capability it belongs to.
 */
export interface AnalyticsHandbacks {
  /** The fewest items a rate is computed over. */
  minSample: number;
  /** Failing call sites given a replacement locator, those whose code then used it, and those a later run passed. */
  heals: { suggested: number; adopted: number; verified: number } | null;
  healPullRequests: { opened: number; merged: number; closed: number; verified: number } | null;
  /**
   * Diagnoses written and rated, the diagnosed failure causes fixed, those
   * whose fix changed the files the diagnosis named, and those that failed again.
   */
  diagnoses: {
    written: number;
    rated: number;
    helpful: number;
    diagnosedFixes: number;
    verified: number;
    regressed: number;
  } | null;
  /** Failed gate evaluations, pull requests merged despite one, and caught failures that came back. */
  gate: { blocked: number; overrides: number; escapes: number } | null;
  /** Flaky tests a Flake Lab verify run proved fixed, and those that flaked again. */
  flakes: { verified: number; regressed: number } | null;
  /** Fixes a person or an agent reported, and what the runs made of them. */
  fixAttempts: { reported: number; verified: number; regressed: number } | null;
  metrics: AnalyticsHandbackMetric[];
}

/** Open scenario gaps of the projects in scope whose Test Map is active. Counts, never a coverage percentage. */
export interface AnalyticsScenarioGaps {
  /** Projects of the scope whose Test Map is active; the widget renders nothing when none is. */
  projects: number;
  /** Projects of the scope that declined the Test Map, left out. */
  declined: number;
  /** Open gaps (`kind = gap`), by class, most severe first. */
  byClass: Array<{ class: string; count: number }>;
  /** The features with the most open gaps. */
  byFeature: Array<{
    feature: string;
    projectId: number;
    projectName: string;
    count: number;
    worstClass: string | null;
  }>;
  /** Gaps closed inside the period. */
  closed: number;
  /** Gaps accepted more than a week ago whose test was never written. */
  acceptedUnwritten: number;
  /** Open resilience findings (`kind = finding`). */
  findings: number;
}

/** The Test Map's weekly digest: the top new gaps per project since the period started. */
export interface AnalyticsNewGaps {
  projects: number;
  items: Array<{
    projectId: number;
    projectName: string;
    /** `detector` names the check that found the gap, so a report can title it in its own language. */
    gaps: Array<{
      id: number;
      title: string;
      detector?: string;
      class: string;
      score: number | null;
      createdAt: number;
    }>;
  }>;
}

// ── List, events, note and the single-project analyses ──────────────────────

export interface AnalyticsListItem {
  id: number;
  title: string;
  /** One line of facts (status, counts, age), plain text. */
  detail: string;
  projectName: string;
  /** When the item happened or was last seen (ISO). */
  at: string | null;
  /** Where the item opens in the app. */
  href: string;
  /** The values `title` and `detail` are written from, so a report can write them in its own language. */
  facts?: AnalyticsListFacts;
}

/** What one list item says, by source. */
export type AnalyticsListFacts =
  | {
      source: 'runs';
      id: number;
      status: string;
      passed: number;
      total: number;
      branch: string | null;
      environment: string | null;
    }
  | {
      source: 'failure-clusters';
      id: number;
      title: string | null;
      occurrences: number;
      errorType: string | null;
      assignee: string | null;
    }
  | { source: 'flaky-tests'; score: number; alternations: number; totalRuns: number }
  | { source: 'scenario-gaps'; detector: string; gapClass: string };

export interface AnalyticsList {
  source: 'runs' | 'failure-clusters' | 'flaky-tests' | 'scenario-gaps';
  items: AnalyticsListItem[];
  /** Projects left out because they declined the Test Map (scenario gaps only). */
  declined: number;
}

export interface AnalyticsEvents {
  markers: AnalyticsMarker[];
}

export interface AnalyticsNote {
  /** The note rendered from Markdown, raw HTML escaped. */
  html: string;
  markdown: string;
}

/** The single-project analyses answer only when the scope resolves to one project. */
export type AnalyticsProjectAnalysis<T> =
  | { project: { id: number; name: string }; data: T }
  | { project: null; reason: string };

// ── Suite growth ─────────────────────────────────────────────────────────────

export interface AnalyticsSuiteGrowthPoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  /** Highest number of tests one run of the bucket reported; null without a run. */
  suiteSize: number | null;
  /** Skipped tests over tests reported, 0–100. */
  skippedPct: number | null;
  /** Tests that did not run over tests reported, 0–100. */
  didNotRunPct: number | null;
}

export interface AnalyticsSuiteGrowth {
  points: AnalyticsSuiteGrowthPoint[];
  bucketDays: number;
  /** Suite size over the period and over the comparison period. */
  suiteSize: number | null;
  previousSuiteSize: number | null;
  /** Tests gained (positive) or lost (negative) against the comparison period. */
  delta: number | null;
  skippedPct: number | null;
  didNotRunPct: number | null;
}

// ── Coverage trend ───────────────────────────────────────────────────────────

export interface AnalyticsCoverageTrendPoint {
  /** Bucket start date (ISO `YYYY-MM-DD`). */
  date: string;
  /** Lines every suite ran together over executable lines, 0–100, as of the bucket's end; null before any coverage. */
  linePercent: number | null;
  executedLines: number;
  executableLines: number;
  /** The day (`YYYY-MM-DD`) the value is carried from when no project has coverage in the bucket itself; else null. */
  carriedFrom: string | null;
  /** The value counts a commit whose `e2e` suite is incomplete: a backend restarted or was unreachable in every run it counts. */
  e2eIncomplete: boolean;
}

/** One dashed line of the coverage trend: a suite, or a named area of the code. */
export interface AnalyticsCoverageTrendSeries {
  name: string;
  points: Array<{ date: string; linePercent: number | null }>;
  /** At the period's end. */
  linePercent: number | null;
}

export interface AnalyticsCoverageTrend {
  points: AnalyticsCoverageTrendPoint[];
  bucketDays: number;
  /** The combined line coverage at the period's end and at the comparison period's end. */
  linePercent: number | null;
  previousLinePercent: number | null;
  /** Percentage points gained (positive) or lost against the comparison period. */
  delta: number | null;
  executedLines: number;
  executableLines: number;
  /** What the dashed lines are: each suite's share of the same lines, or each area's share of its own lines. */
  split: 'suites' | 'areas';
  /** One per suite or area name, every project in scope summed. */
  series: AnalyticsCoverageTrendSeries[];
  /** Projects of the scope with coverage on; the widget shows nothing at 0. */
  projects: number;
  /** Projects of the scope that declined coverage, left out. */
  declined: number;
  /** Points whose value is carried from an earlier day. */
  carriedPoints: number;
  /** A point counts a commit whose totals were computed under an earlier coverage scope or areas. */
  earlierScope: boolean;
}

export interface AnalyticsFlakyDebtPoint {
  date: string;
  /** Flaky occurrences per run in the bucket; null without a run. */
  flakyPerRun: number | null;
  /** Distinct tests that passed only on a retry in the bucket (stored runs only). */
  flakyTests: number;
  /** Tests in quarantine at the end of the bucket. */
  quarantined: number;
}

export interface AnalyticsFlakyDebt {
  points: AnalyticsFlakyDebtPoint[];
  bucketDays: number;
  flakyPerRun: number | null;
  previousFlakyPerRun: number | null;
  /** Distinct flaky tests over the period. */
  flakyTests: number;
  /** Tests in quarantine at the end of the period, and at the end of the comparison period. */
  quarantined: number;
  previousQuarantined: number | null;
}

export interface AnalyticsTimeToFixPoint {
  date: string;
  opened: number;
  fixed: number;
}

export interface AnalyticsTimeToFix {
  points: AnalyticsTimeToFixPoint[];
  bucketDays: number;
  opened: number;
  fixed: number;
  /** Median and 90th percentile of the time to fix over the causes fixed in the period, in days. */
  medianDays: number | null;
  p90Days: number | null;
  /** The median over the comparison period. */
  previousMedianDays: number | null;
  /** Fixes of the period that have not regressed, 0–100. */
  fixesHeldPct: number | null;
  /** Open failure causes by age, youngest first. */
  openByAge: Array<{ label: string; count: number }>;
}

export interface AnalyticsOwnershipRow {
  /** The owner's name; null for the *Unowned* row. */
  owner: string | null;
  /** Open failure causes assigned to the owner. */
  openClusters: number;
  /** Distinct tests owned that passed only on a retry in the period. */
  flakyTests: number;
  /** Wasted CI minutes of the owner's tests in the period. */
  wastedMinutes: number;
  /** Median time to fix, in days, over the causes the owner fixed in the period. */
  medianTimeToFixDays: number | null;
}

export interface AnalyticsOwnership {
  rows: AnalyticsOwnershipRow[];
  /** Open failure causes in scope, for the share each owner holds. */
  totalOpenClusters: number;
}

export interface AnalyticsEnvironmentRow {
  /** The environment; empty for runs that named none. */
  environment: string;
  label: string;
  passRate: AnalyticsMetricValue;
  runSuccessRate: AnalyticsMetricValue;
  runs: number;
  /** Pass rate per bucket. */
  points: AnalyticsSeriesPoint[];
}

export interface AnalyticsEnvironmentComparison {
  rows: AnalyticsEnvironmentRow[];
  bucketDays: number;
}

export type AnalyticsMoverKind = 'became-flaky' | 'stopped-flaky' | 'slower' | 'faster';

export interface AnalyticsMover {
  testCaseId: number;
  projectId: number;
  projectName: string;
  title: string;
  filePath: string;
  /** Flaky executions over executions, or the average passed duration in ms, in each period. */
  before: number;
  after: number;
  /** Relative change in percent (durations), or null (flakiness). */
  changePct: number | null;
}

export interface AnalyticsMovers {
  groups: Array<{ kind: AnalyticsMoverKind; label: string; items: AnalyticsMover[] }>;
  /** Null when the scope compares with nothing, so there is nothing to move against. */
  comparisonLabel: string | null;
}
