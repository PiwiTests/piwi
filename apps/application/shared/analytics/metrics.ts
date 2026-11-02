/**
 * The metric catalog: one definition per number the analytics widgets, quality
 * reports, MCP tools and exports show. Every surface reads the label, the unit,
 * the direction and the one-sentence definition from here, so a number means
 * the same thing wherever it appears.
 *
 * `source: 'rollup'` metrics are read from the daily rollups and work over any
 * window; `source: 'live'` metrics read the stored rows, so the ones about test
 * identities only reach as far back as retention keeps runs. Days are UTC.
 */
import type { CapabilityId } from '#shared/capabilities';

/** A breakdown a metric can be cut by. */
export const DIMENSIONS = [
  { id: 'project', label: 'Project', grain: 'run' },
  { id: 'project-tag', label: 'Project tag', grain: 'run' },
  { id: 'environment', label: 'Environment', grain: 'run' },
  { id: 'branch', label: 'Branch', grain: 'run' },
  { id: 'run-kind', label: 'Run kind', grain: 'run' },
  { id: 'browser', label: 'Browser', grain: 'test' },
  { id: 'test-tag', label: 'Test tag', grain: 'test' },
  { id: 'owner', label: 'Owner', grain: 'test' },
  { id: 'priority', label: 'Priority', grain: 'test' },
  { id: 'feature', label: 'Feature', grain: 'test' },
  { id: 'spec-directory', label: 'Spec directory', grain: 'test' },
  { id: 'error-type', label: 'Error type', grain: 'cluster' },
  { id: 'cluster-status', label: 'Failure cause status', grain: 'cluster' },
  { id: 'assignee', label: 'Assignee', grain: 'cluster' },
  { id: 'gap-class', label: 'Gap class', grain: 'gap' },
  { id: 'gap-feature', label: 'Feature', grain: 'gap' },
] as const;

export type DimensionId = (typeof DIMENSIONS)[number]['id'];
export type MetricGrain = 'run' | 'test' | 'cluster' | 'gap' | 'handback';
export type MetricUnit = 'percent' | 'count' | 'minutes' | 'ms' | 'days' | 'money';

export interface MetricDef {
  id: string;
  /** Sentence case, as shown. */
  label: string;
  unit: MetricUnit;
  betterWhen: 'higher' | 'lower' | 'neutral';
  /** One plain sentence, shown in help hints and report footers. */
  definition: string;
  /** `rollup`: any window; `live`: only as far back as the stored rows go. */
  source: 'rollup' | 'live';
  /** What one counted item is. */
  grain: MetricGrain;
  /** The breakdowns a widget may offer for this metric. */
  dimensions: readonly DimensionId[];
  /** Decimal places shown. */
  precision: number;
  /** Capability the metric depends on; hidden where the capability is declined. */
  capability?: CapabilityId;
  /**
   * For a rate: the fewest items it is computed over. Below it the value is
   * null and the surfaces say the sample is too small.
   */
  minSample?: number;
}

/** The fewest ratings, pull requests or fixes a hand-back rate is computed over. */
export const HANDBACK_MIN_SAMPLE = 10;

const RUN_DIMENSIONS = ['project', 'project-tag', 'environment', 'branch', 'run-kind'] as const;
const TEST_DIMENSIONS = [
  ...RUN_DIMENSIONS,
  'browser',
  'test-tag',
  'owner',
  'priority',
  'feature',
  'spec-directory',
] as const;
const CLUSTER_DIMENSIONS = ['project', 'project-tag', 'error-type', 'cluster-status', 'assignee'] as const;
const GAP_DIMENSIONS = ['project', 'project-tag', 'gap-class', 'gap-feature'] as const;

export const METRICS = [
  {
    id: 'test-pass-rate',
    label: 'Test pass rate',
    unit: 'percent',
    betterWhen: 'higher',
    definition:
      'Tests passed divided by tests passed or failed (timed out included), summed over the runs of the period. Skipped, did-not-run and interrupted tests count in neither, and a pass on a retry counts as passed.',
    source: 'rollup',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'run-success-rate',
    label: 'Run success rate',
    unit: 'percent',
    betterWhen: 'higher',
    definition: 'Share of finished runs whose status is passed.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'runs',
    label: 'Runs',
    unit: 'count',
    betterWhen: 'neutral',
    definition: 'Finished runs in the period.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'suite-size',
    label: 'Suite size',
    unit: 'count',
    betterWhen: 'neutral',
    definition: 'The highest number of tests a single run of the period reported.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'flaky-occurrences',
    label: 'Flaky occurrences',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Tests that passed only on a retry, summed over the runs of the period.',
    source: 'rollup',
    grain: 'test',
    dimensions: RUN_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'flaky-tests',
    label: 'Flaky tests',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Distinct tests that passed only on a retry at least once in the period.',
    source: 'live',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'wasted-ci-minutes',
    label: 'Wasted CI minutes',
    unit: 'minutes',
    betterWhen: 'lower',
    definition: 'Minutes spent inside wait steps plus minutes spent executing attempts that ended failed or timed out.',
    source: 'rollup',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'wasted-ci-cost',
    label: 'Wasted CI cost',
    unit: 'money',
    betterWhen: 'lower',
    definition: 'Wasted CI minutes multiplied by the configured cost of a CI minute; shown only when a cost is set.',
    source: 'rollup',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 2,
  },
  {
    id: 'ci-time',
    label: 'CI time',
    unit: 'minutes',
    betterWhen: 'lower',
    definition: 'Sum of the durations of the runs of the period.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'new-regressions',
    label: 'New regressions',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Executions of a test that failed after passing in its previous run.',
    source: 'rollup',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'newly-flaky',
    label: 'Newly flaky',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Executions of a test that became flaky in that run.',
    source: 'rollup',
    grain: 'test',
    dimensions: TEST_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'average-run-duration',
    label: 'Average run duration',
    unit: 'ms',
    betterWhen: 'lower',
    definition: 'Sum of the run durations divided by the number of runs.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'average-p90-test-duration',
    label: 'Average p90 test duration',
    unit: 'ms',
    betterWhen: 'lower',
    definition: 'Sum of each run’s 90th-percentile test duration divided by the number of runs.',
    source: 'rollup',
    grain: 'run',
    dimensions: RUN_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'open-failure-causes',
    label: 'Open failure causes',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Failure clusters that are open and not snoozed at the end of the period.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'failure-causes-opened',
    label: 'Failure causes opened',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Failure clusters created inside the period.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'failure-causes-fixed',
    label: 'Failure causes fixed',
    unit: 'count',
    betterWhen: 'higher',
    definition: 'Failure clusters whose fix landed inside the period.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'median-time-to-fix',
    label: 'Median time to fix',
    unit: 'days',
    betterWhen: 'lower',
    definition: 'Median time from first failure to fix over the failure clusters fixed in the period.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'oldest-open-failure-cause',
    label: 'Oldest open failure cause',
    unit: 'days',
    betterWhen: 'lower',
    definition: 'Age of the oldest open failure cluster.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 0,
  },
  {
    id: 'fixes-that-held',
    label: 'Fixes that held',
    unit: 'percent',
    betterWhen: 'higher',
    definition: 'Failure clusters fixed in the period and not regressed since, over the clusters fixed.',
    source: 'live',
    grain: 'cluster',
    dimensions: CLUSTER_DIMENSIONS,
    precision: 1,
  },
  {
    id: 'quarantine-debt',
    label: 'Quarantine debt',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Tests in quarantine.',
    source: 'live',
    grain: 'test',
    dimensions: ['project', 'project-tag', 'owner', 'test-tag'],
    precision: 0,
  },
  {
    id: 'open-scenario-gaps',
    label: 'Open scenario gaps',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Open scenario gaps, by class: blind spot, false comfort, fragile.',
    source: 'live',
    grain: 'gap',
    dimensions: GAP_DIMENSIONS,
    precision: 0,
    capability: 'test-map',
  },
  {
    id: 'gaps-closed',
    label: 'Gaps closed',
    unit: 'count',
    betterWhen: 'higher',
    definition: 'Scenario gaps closed inside the period.',
    source: 'live',
    grain: 'gap',
    dimensions: GAP_DIMENSIONS,
    precision: 0,
    capability: 'test-map',
  },
  {
    id: 'accepted-but-unwritten',
    label: 'Accepted but unwritten',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Gaps accepted more than a week ago whose feature still has no trusted test.',
    source: 'live',
    grain: 'gap',
    dimensions: GAP_DIMENSIONS,
    precision: 0,
    capability: 'test-map',
  },
  {
    id: 'open-resilience-findings',
    label: 'Open resilience findings',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Open findings from server probes in the unhandled and degraded classes.',
    source: 'live',
    grain: 'gap',
    dimensions: GAP_DIMENSIONS,
    precision: 0,
    capability: 'test-map',
  },
  {
    id: 'heal-adoption',
    label: 'Heals adopted',
    unit: 'count',
    betterWhen: 'higher',
    definition:
      'Failing locator call sites whose code went on to use the locator Piwi recommended, seen in the period, whoever made the change.',
    source: 'rollup',
    grain: 'handback',
    dimensions: [],
    precision: 0,
    capability: 'locator-healing',
  },
  {
    id: 'heal-pr-merge-rate',
    label: 'Auto-heal merge rate',
    unit: 'percent',
    betterWhen: 'higher',
    definition: 'Auto-heal pull requests merged in the period, over those merged or closed without merging.',
    source: 'rollup',
    grain: 'handback',
    dimensions: [],
    precision: 1,
    capability: 'auto-heal',
    minSample: HANDBACK_MIN_SAMPLE,
  },
  {
    id: 'diagnosis-helpful-rate',
    label: 'Diagnoses rated helpful',
    unit: 'percent',
    betterWhen: 'higher',
    definition: 'Diagnoses written in the period and rated helpful, over those rated helpful or unhelpful.',
    source: 'live',
    grain: 'handback',
    dimensions: [],
    precision: 1,
    capability: 'ai',
    minSample: HANDBACK_MIN_SAMPLE,
  },
  {
    id: 'diagnosis-verified-rate',
    label: 'Diagnoses verified by the fix',
    unit: 'percent',
    betterWhen: 'higher',
    definition:
      'Diagnosed failure causes fixed in the period whose fix changed the files the diagnosis named, over the diagnosed failure causes fixed in the period.',
    source: 'live',
    grain: 'handback',
    dimensions: [],
    precision: 1,
    capability: 'ai',
    minSample: HANDBACK_MIN_SAMPLE,
  },
  {
    id: 'gate-blocked-merges',
    label: 'Merges the gate blocked',
    unit: 'count',
    betterWhen: 'neutral',
    definition: 'Gate evaluations that failed in the period, each one holding back a merge.',
    source: 'rollup',
    grain: 'handback',
    dimensions: [],
    precision: 0,
  },
  {
    id: 'gate-overrides',
    label: 'Gate overrides',
    unit: 'count',
    betterWhen: 'lower',
    definition: 'Pull requests merged in the period while their last gate evaluation failed.',
    source: 'rollup',
    grain: 'handback',
    dimensions: [],
    precision: 0,
  },
  {
    id: 'flakes-verified-fixed',
    label: 'Flakes verified fixed',
    unit: 'count',
    betterWhen: 'higher',
    definition: 'Flaky tests a Flake Lab verify run proved fixed in the period.',
    source: 'rollup',
    grain: 'handback',
    dimensions: [],
    precision: 0,
    capability: 'flake-lab',
  },
] as const satisfies readonly MetricDef[];

export type MetricId = (typeof METRICS)[number]['id'];

const METRICS_BY_ID = new Map<string, MetricDef>(METRICS.map((m) => [m.id, m]));

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === 'string' && METRICS_BY_ID.has(value);
}

export function getMetric(id: MetricId): MetricDef {
  return METRICS_BY_ID.get(id)!;
}
