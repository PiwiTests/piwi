/**
 * One metric cut by a dimension of the catalog: "wasted CI minutes by
 * browser", "pass rate by project tag", "open failure causes by assignee".
 *
 * Each source is read once for the range and partitioned in memory: the
 * rollup cells (run dimensions, no test filter), the executions (test
 * dimensions, or any dimension under a test filter), the failure clusters or
 * the quarantine. A group's value is computed from its own items exactly as
 * the whole metric is, so a group of one reads the same number as the widget
 * without a breakdown. The top groups are kept, and *Other* holds every item
 * that belongs to none of them.
 */
import { and, eq, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { projects, projectTags, quarantinedTests, tags, testCases } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { DIMENSIONS, getMetric, type DimensionId, type MetricId } from '../../analytics/metrics';
import type { CiCost } from '../../ci-cost';
import type { AnalyticsSeriesPoint } from '../../analytics/types';
import {
  dayRange,
  fetchContextRuns,
  fetchFilteredExecutions,
  makeTimeBuckets,
  type AnalyticsContext,
  type FilteredExecution,
  type ScopedRun,
} from './common';
import { emptyRollupTotals, readRollupCells, type RollupDayRow } from './rollups';
import { groupRows, rowsFromExecutions } from './scalar-rows';
import {
  clusterValue,
  hasMetricSeries,
  isClusterMetric,
  isRollupMetric,
  loadClusters,
  rollupMetricValue,
  type ClusterRow,
} from './metric-values';

/** The key of the group of items that carry no value for the dimension (no owner, no tag, unknown branch). */
export const NONE_KEY = '';
/** The key of the group holding every item outside the top groups. */
export const OTHER_KEY = '\u0000other';

export interface BreakdownGroup {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  /** The group's series over the period; null when not asked for, or for a metric without one. */
  points: AnalyticsSeriesPoint[] | null;
  other: boolean;
  /** How many groups the *Other* group holds. */
  rest?: number;
}

export interface BreakdownRequest {
  metric: MetricId;
  dimension: DimensionId;
  from: number;
  to: number;
  compare: { from: number; to: number } | null;
  top: number;
  series: boolean;
  cost: CiCost | null;
}

const NONE_LABELS: Partial<Record<DimensionId, string>> = {
  'project-tag': 'No project tag',
  environment: 'No environment',
  branch: 'Unknown branch',
  browser: 'Unknown browser',
  'test-tag': 'No tag',
  owner: 'No owner',
  priority: 'No priority',
  feature: 'No feature',
  'error-type': 'Unknown error type',
  assignee: 'Unassigned',
};

const RUN_KIND_LABELS: Record<string, string> = { full: 'Full runs', partial: 'Partial runs' };

const CLUSTER_STATUS_LABELS: Record<string, string> = { open: 'Open', resolved: 'Resolved', ignored: 'Ignored' };

/** The group labels Piwi writes (the others are names from the data), which a report translates. */
export const BREAKDOWN_GROUP_LABELS: readonly string[] = [
  'Other',
  'None',
  ...Object.values(NONE_LABELS),
  ...Object.values(RUN_KIND_LABELS),
  ...Object.values(CLUSTER_STATUS_LABELS),
];

// ── Items: what a group is made of ───────────────────────────────────────────

/** A source read over a range, with each item's groups and the metric's value over any subset. */
interface Partition<T> {
  items: T[];
  keysOf: (item: T) => string[];
  value: (items: T[]) => number | null;
  series: ((items: T[]) => AnalyticsSeriesPoint[]) | null;
}

interface TestAttributes {
  tags: string[];
  owner: string | null;
  priority: string | null;
  feature: string | null;
  directory: string;
}

interface Lookups {
  projectLabels: Map<number, string>;
  projectTagsOf: Map<number, string[]>;
  testsOf: (projectId: number, testCaseId: number) => TestAttributes | undefined;
}

const TEST_DIMENSIONS = new Set<DimensionId>(['browser', 'test-tag', 'owner', 'priority', 'feature', 'spec-directory']);

function directoryOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
}

async function loadProjectLookups(db: DrizzleDB, ids: number[]) {
  const labels = new Map<number, string>();
  const tagsOf = new Map<number, string[]>();
  if (ids.length === 0) return { labels, tagsOf };
  const rows: { id: number; name: string; label: string | null }[] = await db
    .select({ id: projects.id, name: projects.name, label: projects.label })
    .from(projects)
    .where(inArray(projects.id, ids));
  for (const r of rows) labels.set(r.id, r.label || r.name);
  const tagRows: { projectId: number; text: string }[] = await db
    .select({ projectId: projectTags.projectId, text: tags.text })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, ids));
  for (const r of tagRows) tagsOf.set(r.projectId, [...(tagsOf.get(r.projectId) ?? []), r.text]);
  return { labels, tagsOf };
}

const TEST_BATCH = 500;

async function loadTestAttributes(db: DrizzleDB, ids: number[]): Promise<Map<number, TestAttributes>> {
  const out = new Map<number, TestAttributes>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += TEST_BATCH) {
    const rows: any[] = await db
      .select({
        id: testCases.id,
        tags: testCases.tags,
        owner: testCases.owner,
        priority: testCases.priority,
        feature: testCases.feature,
        filePath: testCases.filePath,
      })
      .from(testCases)
      .where(inArray(testCases.id, unique.slice(i, i + TEST_BATCH)));
    for (const r of rows) {
      out.set(r.id, {
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
        owner: r.owner?.trim() || null,
        priority: r.priority || null,
        feature: r.feature?.trim() || null,
        directory: directoryOf(r.filePath ?? ''),
      });
    }
  }
  return out;
}

/** The groups of an item described by its project, run and test. */
function keysFor(
  dimension: DimensionId,
  lookups: Lookups,
  item: { projectId: number; environment?: string | null; branch?: string | null; fullRun?: boolean | null },
  test?: { testCaseId: number; browserName?: string | null },
): string[] {
  switch (dimension) {
    case 'project':
      return [String(item.projectId)];
    case 'project-tag':
      return lookups.projectTagsOf.get(item.projectId) ?? [NONE_KEY];
    case 'environment':
      return [item.environment || NONE_KEY];
    case 'branch':
      return [item.branch || NONE_KEY];
    case 'run-kind':
      return [item.fullRun ? 'full' : 'partial'];
    case 'browser':
      return [test?.browserName || NONE_KEY];
    default: {
      const attrs = test ? lookups.testsOf(item.projectId, test.testCaseId) : undefined;
      if (dimension === 'test-tag') return attrs?.tags.length ? attrs.tags : [NONE_KEY];
      if (dimension === 'owner') return [attrs?.owner ?? NONE_KEY];
      if (dimension === 'priority') return [attrs?.priority ?? NONE_KEY];
      if (dimension === 'feature') return [attrs?.feature ?? NONE_KEY];
      if (dimension === 'spec-directory') return [attrs?.directory ?? NONE_KEY];
      return [NONE_KEY];
    }
  }
}

function bucketedRows(ctx: AnalyticsContext, from: number, to: number, id: MetricId, cost: CiCost | null) {
  const buckets = makeTimeBuckets(from, to, ctx.scope.granularity);
  return (rows: RollupDayRow[]): AnalyticsSeriesPoint[] => {
    const byBucket = groupRows(rows, (row) => buckets.keyFor(row.day));
    return buckets.keys.map((date) => {
      const totals = byBucket.get(date);
      return { date, value: totals && totals.runs > 0 ? rollupMetricValue(id, totals, cost) : null };
    });
  };
}

function totalsOf(rows: RollupDayRow[]) {
  return groupRows(rows, () => 'all').get('all') ?? emptyRollupTotals();
}

interface ExecutionItem {
  run: ScopedRun;
  execution: FilteredExecution;
}

async function executionPartition(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
  from: number,
  to: number,
  lookups: Omit<Lookups, 'testsOf'>,
): Promise<Partition<ExecutionItem>> {
  const { fromDay, toDay } = dayRange(from, to);
  const runs = await fetchContextRuns(
    db,
    ctx,
    Date.parse(`${fromDay}T00:00:00Z`),
    Date.parse(`${toDay}T00:00:00Z`) + 24 * 60 * 60 * 1000,
  );
  const executions = await fetchFilteredExecutions(db, ctx, runs);
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const items = executions.map((execution) => ({ run: runOf.get(execution.testRunId)!, execution }));
  const attributes = TEST_DIMENSIONS.has(req.dimension)
    ? await loadTestAttributes(
        db,
        executions.map((e) => e.testCaseId),
      )
    : new Map<number, TestAttributes>();
  const full: Lookups = { ...lookups, testsOf: (_projectId, testCaseId) => attributes.get(testCaseId) };
  const keysOf = (item: ExecutionItem) =>
    keysFor(
      req.dimension,
      full,
      {
        projectId: item.run.projectId,
        environment: item.run.environment,
        branch: item.run.branch,
        fullRun: item.run.isFullRun === 1,
      },
      item.execution,
    );
  const rowsOf = (list: ExecutionItem[]) => {
    const subset = new Set(list.map((i) => i.run.id));
    return rowsFromExecutions(
      runs.filter((r) => subset.has(r.id)),
      list.map((i) => i.execution),
    );
  };

  if (req.metric === 'flaky-tests') {
    return {
      items,
      keysOf,
      value: (list) => {
        if (list.length === 0) return null;
        const flaky = new Set<string>();
        for (const { run, execution } of list) {
          const t = new Date(run.startTime).getTime();
          if (t < from || (to < ctx.now && t >= to)) continue;
          if (execution.passedAfterFailure) {
            flaky.add(`${run.projectId}:${execution.testCaseId}`);
          }
        }
        return flaky.size;
      },
      series: null,
    };
  }
  const bucket = bucketedRows(ctx, from, to, req.metric, req.cost);
  return {
    items,
    keysOf,
    value: (list) => rollupMetricValue(req.metric, totalsOf(rowsOf(list)), req.cost),
    series: hasMetricSeries(req.metric) ? (list) => bucket(rowsOf(list)) : null,
  };
}

async function rollupPartition(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
  from: number,
  to: number,
  lookups: Omit<Lookups, 'testsOf'>,
): Promise<Partition<RollupDayRow & { environment: string; branch: string; fullRun: boolean }>> {
  const { fromDay, toDay } = dayRange(from, to);
  const items =
    ctx.allowed !== 'all' && ctx.allowed.length === 0
      ? []
      : await readRollupCells(db, {
          projectIds: ctx.allowed,
          fromDay,
          toDay,
          environments: ctx.scope.environments,
          branchPolicy: ctx.branchPolicy,
          fullRunsOnly: ctx.scope.fullRunsOnly,
        });
  const bucket = bucketedRows(ctx, from, to, req.metric, req.cost);
  return {
    items,
    keysOf: (row) => keysFor(req.dimension, { ...lookups, testsOf: () => undefined }, row),
    value: (list) => rollupMetricValue(req.metric, totalsOf(list), req.cost),
    series: hasMetricSeries(req.metric) ? (list) => bucket(list) : null,
  };
}

async function clusterPartition(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
  from: number,
  to: number,
  lookups: Omit<Lookups, 'testsOf'>,
): Promise<Partition<ClusterRow>> {
  const clusters = await loadClusters(db, ctx, from);
  const keysOf = (c: ClusterRow): string[] => {
    if (req.dimension === 'error-type') return [c.errorType || NONE_KEY];
    if (req.dimension === 'cluster-status') return [c.status];
    if (req.dimension === 'assignee') return [c.assignee?.trim() || NONE_KEY];
    return keysFor(req.dimension, { ...lookups, testsOf: () => undefined }, c);
  };
  const buckets = makeTimeBuckets(from, to, ctx.scope.granularity);
  const series =
    req.metric === 'failure-causes-opened' || req.metric === 'failure-causes-fixed'
      ? (list: ClusterRow[]) => {
          const counts = new Map<string, number>();
          for (const c of list) {
            const at = req.metric === 'failure-causes-opened' ? c.createdAt : c.fixLandedAt;
            const t = at ? new Date(at).getTime() : null;
            if (t === null || t < from || t >= to) continue;
            const key = buckets.keyFor(t);
            if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return buckets.keys.map((date) => ({ date, value: counts.get(date) ?? 0 }));
        }
      : null;
  return {
    items: clusters,
    keysOf,
    value: (list) => clusterValue(req.metric, list, from, to, ctx.now),
    series,
  };
}

async function quarantinePartition(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
  to: number,
  lookups: Omit<Lookups, 'testsOf'>,
): Promise<Partition<{ projectId: number; testCaseId: number }>> {
  const end = new Date(Math.min(to, ctx.now + 1));
  const conditions: SQL[] = [
    lt(quarantinedTests.createdAt, end),
    or(isNull(quarantinedTests.releasedAt), gte(quarantinedTests.releasedAt, end))!,
  ];
  if (ctx.allowed !== 'all') conditions.push(inArray(quarantinedTests.projectId, ctx.allowed));
  let rows: { projectId: number; testCaseId: number }[] =
    ctx.allowed !== 'all' && ctx.allowed.length === 0
      ? []
      : await db
          .select({ projectId: quarantinedTests.projectId, testCaseId: quarantinedTests.testCaseId })
          .from(quarantinedTests)
          .where(and(...conditions));
  const ids = ctx.testFilter?.testCaseIds;
  if (ids) rows = rows.filter((r) => ids.get(r.projectId)?.has(r.testCaseId));
  const attributes = await loadTestAttributes(
    db,
    rows.map((r) => r.testCaseId),
  );
  const full: Lookups = { ...lookups, testsOf: (_p, testCaseId) => attributes.get(testCaseId) };
  return {
    items: rows,
    keysOf: (r) => keysFor(req.dimension, full, r, { testCaseId: r.testCaseId }),
    value: (list) => list.length,
    series: null,
  };
}

async function partitionFor(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
  from: number,
  to: number,
  lookups: Omit<Lookups, 'testsOf'>,
): Promise<Partition<any> | null> {
  if (isClusterMetric(req.metric)) return clusterPartition(db, ctx, req, from, to, lookups);
  if (req.metric === 'quarantine-debt') return quarantinePartition(db, ctx, req, to, lookups);
  if (req.metric === 'flaky-tests') return executionPartition(db, ctx, req, from, to, lookups);
  if (!isRollupMetric(req.metric)) return null;
  // One code path per filter kind: run dimensions read the rollups, test dimensions and test filters the executions.
  return TEST_DIMENSIONS.has(req.dimension) || ctx.testFilter
    ? executionPartition(db, ctx, req, from, to, lookups)
    : rollupPartition(db, ctx, req, from, to, lookups);
}

function groupItems<T>(partition: Partition<T>): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of partition.items) {
    for (const key of new Set(partition.keysOf(item))) {
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
  }
  return groups;
}

/** Worst first: the groups that need attention lead the list. */
function attentionOrder(metric: MetricId) {
  const def = getMetric(metric);
  return (a: { value: number | null; label: string }, b: { value: number | null; label: string }) => {
    if (a.value === null || b.value === null) return a.value === null ? (b.value === null ? 0 : 1) : -1;
    const diff = def.betterWhen === 'higher' ? a.value - b.value : b.value - a.value;
    return diff !== 0 ? diff : a.label.localeCompare(b.label);
  };
}

function labelOf(dimension: DimensionId, key: string, projectLabels: Map<number, string>): string {
  if (key === NONE_KEY) return NONE_LABELS[dimension] ?? 'None';
  if (dimension === 'project') return projectLabels.get(Number(key)) ?? `Project #${key}`;
  if (dimension === 'run-kind') return RUN_KIND_LABELS[key] ?? key;
  if (dimension === 'cluster-status') return CLUSTER_STATUS_LABELS[key] ?? key;
  if (dimension === 'test-tag') return `@${key}`;
  return key;
}

/** The label of a dimension, as the widget titles its breakdown. */
export function dimensionLabel(dimension: DimensionId): string {
  return DIMENSIONS.find((d) => d.id === dimension)?.label ?? dimension;
}

/** A metric cut by a dimension: the top groups worst first, then *Other* when groups were left out. */
export async function computeMetricBreakdown(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  req: BreakdownRequest,
): Promise<BreakdownGroup[]> {
  const allowed =
    ctx.allowed === 'all'
      ? (await db.select({ id: projects.id }).from(projects)).map((r: { id: number }) => r.id)
      : ctx.allowed;
  const { labels, tagsOf } = await loadProjectLookups(db, allowed);
  const lookups = { projectLabels: labels, projectTagsOf: tagsOf };

  const current = await partitionFor(db, ctx, req, req.from, req.to, lookups);
  if (!current) return [];
  const previous = req.compare ? await partitionFor(db, ctx, req, req.compare.from, req.compare.to, lookups) : null;
  const currentGroups = groupItems(current);
  const previousGroups = previous ? groupItems(previous) : new Map<string, unknown[]>();

  const ranked = [...currentGroups.entries()]
    .map(([key, items]) => ({ key, items, label: labelOf(req.dimension, key, labels), value: current.value(items) }))
    .sort(attentionOrder(req.metric));
  const top = ranked.slice(0, req.top);
  const topKeys = new Set(top.map((g) => g.key));
  const groups: BreakdownGroup[] = top.map((g) => ({
    key: g.key,
    label: g.label,
    value: g.value,
    previous: previous ? previous.value((previousGroups.get(g.key) as any[]) ?? []) : null,
    points: req.series && current.series ? current.series(g.items) : null,
    other: false,
  }));

  if (ranked.length > top.length) {
    const outside = <T>(p: Partition<T>) => p.items.filter((item) => !p.keysOf(item).some((k) => topKeys.has(k)));
    const rest = outside(current);
    groups.push({
      key: OTHER_KEY,
      label: `Other (${ranked.length - top.length})`,
      value: current.value(rest),
      previous: previous ? previous.value(outside(previous)) : null,
      points: req.series && current.series ? current.series(rest) : null,
      other: true,
      rest: ranked.length - top.length,
    });
  }
  return groups;
}
