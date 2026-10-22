import { and, eq, gte, inArray, isNotNull, lt, ne, type SQL } from 'drizzle-orm';
import { markers, projects, testRuns, testRunsCases, projectTags, tags } from '../../../server/database/schema';
import type { DrizzleDB } from '../db';
import { notLabRun } from '../probes';
import { getSelection, loadSelectionCatalog, resolveSelectionDefinition } from '../selections';
import type { SelectionDefinition } from '../../selection/types';
import { distinctRunCountsFromAttempts } from '../../utils/test-counts';
import { hasTestFilter, type AnalyticsScope } from '../../analytics/scope';
import {
  resolveComparison,
  resolvePeriod,
  type Granularity,
  type PeriodMarker,
  type ResolvedPeriod,
} from '../../analytics/period';
import type { AnalyticsTagInfo } from '../../analytics/types';
import { branchPolicyCondition, defaultBranchPolicy, type BranchPolicy } from './branch-policy';
import { resolveStoredDefaultBranches } from '../../../server/utils/scm/stored-default-branch';

export type ProjectAccess = 'all' | Set<number>;

export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'timedout', 'interrupted'];
export const FAILING_RUN_STATUSES = ['failed', 'timedout', 'interrupted'];

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Intersect the requested project filter with the caller's access scope.
 * Returns `'all'` (no restriction) or the allowed project id list (possibly empty).
 */
export function resolveAllowedProjects(scope: AnalyticsScope, access: ProjectAccess): 'all' | number[] {
  if (!scope.projectIds || scope.projectIds.length === 0) {
    return access === 'all' ? 'all' : [...access];
  }
  if (access === 'all') return scope.projectIds;
  return scope.projectIds.filter((id) => access.has(id));
}

// ── The resolved scope ───────────────────────────────────────────────────────

/** A test filter resolved per project. */
export interface ResolvedTestFilter {
  /** Matching test ids per project; null when only browsers filter. */
  testCaseIds: Map<number, Set<number>> | null;
  /** Browsers (Playwright project names) an execution must run on; null for any. */
  browsers: string[] | null;
}

/**
 * Everything a widget needs to answer a scope, resolved once per request: the
 * projects it may read, the period and comparison as instants, the buckets,
 * the branch policy and the test filter.
 */
export interface AnalyticsContext {
  scope: AnalyticsScope;
  /** The instant the scope was resolved at. */
  now: number;
  /** Allowed project ids after project access, the project filter and project tags. */
  allowed: 'all' | number[];
  period: ResolvedPeriod;
  comparison: ResolvedPeriod | null;
  buckets: TimeBuckets;
  branchPolicy: BranchPolicy;
  testFilter: ResolvedTestFilter | null;
  /** Things the reader should know about how the scope resolved ("checkout has no selection smoke"). */
  notes: string[];
}

const contextCache = new WeakMap<AnalyticsScope, Map<string, Promise<AnalyticsContext>>>();

function accessKey(access: ProjectAccess): string {
  return access === 'all' ? 'all' : [...access].sort((a, b) => a - b).join(',');
}

/**
 * The resolved context of a scope, memoized per scope object and project
 * access, so the insights widget (which calls every other handler) resolves
 * the scope once.
 */
export function getAnalyticsContext(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess = 'all',
  now = Date.now(),
): Promise<AnalyticsContext> {
  let byAccess = contextCache.get(scope);
  if (!byAccess) {
    byAccess = new Map();
    contextCache.set(scope, byAccess);
  }
  const key = accessKey(access);
  let pending = byAccess.get(key);
  if (!pending) {
    pending = resolveAnalyticsContext(db, scope, access, now);
    byAccess.set(key, pending);
  }
  return pending;
}

async function resolveAnalyticsContext(
  db: DrizzleDB,
  scope: AnalyticsScope,
  access: ProjectAccess,
  now: number,
): Promise<AnalyticsContext> {
  const notes: string[] = [];
  let allowed = resolveAllowedProjects(scope, access);
  if (scope.projectTags && scope.projectTags.length > 0)
    allowed = await filterByProjectTags(db, allowed, scope.projectTags);

  const timeZone = scope.timeZone || 'UTC';
  const periodMarkers = await loadPeriodMarkers(db, scope, allowed);
  const resolveCtx = { now, timeZone, locale: scope.locale, markers: periodMarkers };
  const period = resolvePeriod(scope.period, resolveCtx);
  if (period.fallback) notes.push(`${period.fallback} Showing the last 30 days instead.`);
  const comparison = resolveComparison(scope.comparison, scope.period, period, resolveCtx);

  const branchPolicy = await resolveBranchPolicy(db, scope, allowed);
  const testFilter = await resolveTestFilter(db, scope, allowed, notes);
  if (testFilter?.testCaseIds) {
    allowed = [...testFilter.testCaseIds.keys()];
  }

  return {
    scope,
    now,
    allowed,
    period,
    comparison,
    buckets: makeTimeBuckets(period.from.getTime(), period.to.getTime(), scope.granularity),
    branchPolicy,
    testFilter,
    notes,
  };
}

async function allowedProjectIds(db: DrizzleDB, allowed: 'all' | number[]): Promise<number[]> {
  if (allowed !== 'all') return allowed;
  const rows: { id: number }[] = await db.select({ id: projects.id }).from(projects);
  return rows.map((r) => r.id);
}

export async function filterByProjectTags(
  db: DrizzleDB,
  allowed: 'all' | number[],
  tagTexts: string[],
): Promise<number[]> {
  if (allowed !== 'all' && allowed.length === 0) return [];
  const rows: { projectId: number }[] = await db
    .select({ projectId: projectTags.projectId })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(and(inArray(tags.text, tagTexts), allowed === 'all' ? undefined : inArray(projectTags.projectId, allowed)));
  return [...new Set(rows.map((r) => r.projectId))];
}

/** The markers a period may anchor on: those of the projects in scope. */
async function loadPeriodMarkers(
  db: DrizzleDB,
  scope: AnalyticsScope,
  allowed: 'all' | number[],
): Promise<PeriodMarker[]> {
  const kind = scope.period.kind;
  const comparisonNeedsMarkers = scope.comparison.kind === 'previous-unit' && kind === 'release';
  if (kind !== 'since-marker' && kind !== 'between-markers' && kind !== 'release' && !comparisonNeedsMarkers) return [];
  if (allowed !== 'all' && allowed.length === 0) return [];
  const conditions: SQL[] = [];
  if (allowed !== 'all') conditions.push(inArray(markers.projectId, allowed));
  if (kind === 'release') conditions.push(eq(markers.category, 'release'));
  if (kind === 'since-marker') conditions.push(eq(markers.id, scope.period.markerId));
  if (kind === 'between-markers')
    conditions.push(inArray(markers.id, [scope.period.fromMarkerId, scope.period.toMarkerId]));
  const rows: any[] = await db
    .select({ id: markers.id, label: markers.label, category: markers.category, occurredAt: markers.occurredAt })
    .from(markers)
    .where(and(...conditions));
  return rows;
}

/**
 * The branch policy of a scope: the branches chosen by hand, every branch, or
 * each project's default branch (`resolveStoredDefaultBranches`: the project's
 * setting, else the branch most of its runs are on, else `main`), as the
 * project tabs read it. The unknown branch counts only in projects that never
 * recorded a branch on a run.
 */
export async function resolveBranchPolicy(
  db: DrizzleDB,
  scope: AnalyticsScope,
  allowed: 'all' | number[],
): Promise<BranchPolicy> {
  if (scope.branches && scope.branches.length > 0) return { kind: 'list', branches: scope.branches };
  if (!scope.defaultBranchOnly) return { kind: 'any' };
  if (allowed !== 'all' && allowed.length === 0) return { kind: 'default', groups: [], unknownProjectIds: [] };

  const rows: { id: number; defaultBranch: string | null }[] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(allowed === 'all' ? undefined : inArray(projects.id, allowed));
  const defaults = await resolveStoredDefaultBranches(db, rows);
  const withBranch = await projectsWithKnownBranch(
    db,
    rows.map((row) => row.id),
  );
  return defaultBranchPolicy(
    defaults,
    rows.map((row) => row.id).filter((id) => !withBranch.has(id)),
  );
}

/** The projects among `projectIds` holding at least one run with a known branch. */
async function projectsWithKnownBranch(db: DrizzleDB, projectIds: number[]): Promise<Set<number>> {
  const found = new Set<number>();
  for (let i = 0; i < projectIds.length; i += 500) {
    const rows: { projectId: number }[] = await db
      .selectDistinct({ projectId: testRuns.projectId })
      .from(testRuns)
      .where(
        and(
          inArray(testRuns.projectId, projectIds.slice(i, i + 500)),
          isNotNull(testRuns.branch),
          ne(testRuns.branch, ''),
        ),
      );
    for (const row of rows) found.add(row.projectId);
  }
  return found;
}

/**
 * The test filter of a scope, per project: a selection key resolves to that
 * project's selection with that key (a project without it is left out and
 * named in the notes), inline predicates resolve as an ad-hoc selection, and
 * both together intersect. A test filter means the tests that match it today,
 * with their whole history.
 */
async function resolveTestFilter(
  db: DrizzleDB,
  scope: AnalyticsScope,
  allowed: 'all' | number[],
  notes: string[] = [],
): Promise<ResolvedTestFilter | null> {
  if (!hasTestFilter(scope)) return null;
  const browsers = scope.browsers && scope.browsers.length > 0 ? scope.browsers : null;
  if (!scope.selection && !scope.tests) return { testCaseIds: null, browsers };

  const projectIds = await allowedProjectIds(db, allowed);
  const nameRows: { id: number; name: string }[] =
    projectIds.length > 0
      ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))
      : [];
  const names = new Map(nameRows.map((r) => [r.id, r.name]));
  const testCaseIds = new Map<number, Set<number>>();
  const missing: string[] = [];

  for (const projectId of projectIds) {
    const definitions: SelectionDefinition[] = [];
    if (scope.selection) {
      const selection = await getSelection(db, projectId, scope.selection);
      if (!selection) {
        missing.push(names.get(projectId) ?? `Project ${projectId}`);
        continue;
      }
      definitions.push(selection.definition);
    }
    if (scope.tests) definitions.push({ include: [scope.tests] });

    const catalog = await loadSelectionCatalog(db, projectId, { withFailRanks: true });
    const sets: Set<number>[] = [];
    for (const definition of definitions) {
      const resolved = await resolveSelectionDefinition(db, projectId, definition, { catalog });
      sets.push(new Set(resolved.tests.map((t) => t.testCaseId)));
    }
    const [first = new Set<number>(), ...rest] = sets;
    testCaseIds.set(projectId, new Set([...first].filter((id) => rest.every((set) => set.has(id)))));
  }
  if (missing.length > 0) {
    notes.push(
      `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no selection "${scope.selection}" and ${
        missing.length === 1 ? 'is' : 'are'
      } left out.`,
    );
  }
  return { testCaseIds, browsers };
}

// ── Run conditions ───────────────────────────────────────────────────────────

/**
 * The `test_runs` conditions every live query shares: terminal runs starting
 * inside `[fromMs, toMs)` (open-ended when the range ends now), in the allowed projects, matching the scope's run
 * filters and branch policy, and never a lab run (probe or flake experiment).
 */
export function contextRunConditions(ctx: AnalyticsContext, fromMs: number, toMs: number): SQL[] {
  // A range that ends now has no upper bound: a run stamped this very second counts.
  return runConditions(ctx.scope, ctx.allowed, ctx.branchPolicy, fromMs, toMs >= ctx.now ? null : toMs);
}

function runConditions(
  scope: AnalyticsScope,
  allowed: 'all' | number[],
  branchPolicy: BranchPolicy,
  fromMs: number,
  toMs: number | null,
): SQL[] {
  const conditions: SQL[] = [
    gte(testRuns.startTime, new Date(fromMs)),
    inArray(testRuns.status, TERMINAL_RUN_STATUSES),
    notLabRun(testRuns.origin),
  ];
  if (toMs != null) conditions.push(lt(testRuns.startTime, new Date(toMs)));
  if (allowed !== 'all') conditions.push(inArray(testRuns.projectId, allowed));
  if (scope.fullRunsOnly) conditions.push(eq(testRuns.isFullRun, 1));
  if (scope.environments && scope.environments.length > 0)
    conditions.push(inArray(testRuns.environment, scope.environments));
  const branch = branchPolicyCondition(
    branchPolicy,
    { branch: testRuns.branch, projectId: testRuns.projectId },
    'null',
  );
  if (branch) conditions.push(branch);
  return conditions;
}

// ── Projects and tags ────────────────────────────────────────────────────────

export interface ScopedProject {
  id: number;
  name: string;
  label: string | null;
}

export async function fetchContextProjects(db: DrizzleDB, ctx: AnalyticsContext): Promise<ScopedProject[]> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  const rows: any[] = await db
    .select({ id: projects.id, name: projects.name, label: projects.label })
    .from(projects)
    .where(ctx.allowed === 'all' ? undefined : inArray(projects.id, ctx.allowed));
  return rows;
}

export async function fetchTagsByProject(
  db: DrizzleDB,
  projectIds: number[],
): Promise<Map<number, AnalyticsTagInfo[]>> {
  const byProject = new Map<number, AnalyticsTagInfo[]>();
  if (projectIds.length === 0) return byProject;

  const rows: any[] = await db
    .select({ projectId: projectTags.projectId, id: tags.id, text: tags.text, color: tags.color })
    .from(projectTags)
    .innerJoin(tags, eq(projectTags.tagId, tags.id))
    .where(inArray(projectTags.projectId, projectIds));

  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? [];
    list.push({ id: row.id, text: row.text, color: row.color });
    byProject.set(row.projectId, list);
  }
  return byProject;
}

// ── Live runs ────────────────────────────────────────────────────────────────

export interface ScopedRun {
  id: number;
  projectId: number;
  status: string;
  startTime: Date;
  duration: number | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  environment: string | null;
  branch: string | null;
  isFullRun: number | null;
}

const SCOPED_RUN_FIELDS = {
  id: testRuns.id,
  projectId: testRuns.projectId,
  status: testRuns.status,
  startTime: testRuns.startTime,
  duration: testRuns.duration,
  totalTests: testRuns.totalTests,
  passedTests: testRuns.passedTests,
  failedTests: testRuns.failedTests,
  flakyTests: testRuns.flakyTests,
  environment: testRuns.environment,
  branch: testRuns.branch,
  isFullRun: testRuns.isFullRun,
};

/** Terminal runs of the context inside `[fromMs, toMs)`, oldest → newest. */
export async function fetchContextRuns(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  fromMs: number,
  toMs: number,
): Promise<ScopedRun[]> {
  if (ctx.allowed !== 'all' && ctx.allowed.length === 0) return [];
  const rows: any[] = await db
    .select(SCOPED_RUN_FIELDS)
    .from(testRuns)
    .where(and(...contextRunConditions(ctx, fromMs, toMs)))
    .orderBy(testRuns.startTime);
  return rows;
}

// ── Test-filtered executions ─────────────────────────────────────────────────

export interface FilteredExecution {
  testRunId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number | null;
  status: string;
  duration: number | null;
  wastedTimeMs: number | null;
  isNewRegression: number | null;
  isNewFlaky: number | null;
}

const RUN_BATCH = 400;

/**
 * The executions of the given runs that match the context's test filter.
 * Filtering happens in memory against the resolved test ids, so a selection of
 * any size costs no bound variables.
 */
export async function fetchFilteredExecutions(
  db: DrizzleDB,
  ctx: AnalyticsContext,
  runs: Array<{ id: number; projectId: number }>,
): Promise<FilteredExecution[]> {
  const filter = ctx.testFilter;
  const projectOf = new Map(runs.map((r) => [r.id, r.projectId]));
  const out: FilteredExecution[] = [];
  const ids = runs.map((r) => r.id);
  for (let i = 0; i < ids.length; i += RUN_BATCH) {
    const batch = ids.slice(i, i + RUN_BATCH);
    const conditions: SQL[] = [inArray(testRunsCases.testRunId, batch)];
    if (filter?.browsers) conditions.push(inArray(testRunsCases.browserName, filter.browsers));
    const rows: FilteredExecution[] = await db
      .select({
        testRunId: testRunsCases.testRunId,
        testCaseId: testRunsCases.testCaseId,
        browserName: testRunsCases.browserName,
        repeatEachIndex: testRunsCases.repeatEachIndex,
        retries: testRunsCases.retries,
        status: testRunsCases.status,
        duration: testRunsCases.duration,
        wastedTimeMs: testRunsCases.wastedTimeMs,
        isNewRegression: testRunsCases.isNewRegression,
        isNewFlaky: testRunsCases.isNewFlaky,
      })
      .from(testRunsCases)
      .where(and(...conditions));
    for (const row of rows) {
      const allowedIds = filter?.testCaseIds?.get(projectOf.get(row.testRunId)!);
      if (filter?.testCaseIds && !allowedIds?.has(row.testCaseId)) continue;
      out.push(row);
    }
  }
  return out;
}

export { distinctRunCountsFromAttempts };

// ── Time buckets ─────────────────────────────────────────────────────────────

/** ISO `YYYY-MM-DD` (UTC) for a date. */
export function dayKey(date: Date | string | number): string {
  return new Date(date).toISOString().slice(0, 10);
}

/** UTC day range `[fromDay, toDay]` (inclusive) covered by two instants. */
export function dayRange(fromMs: number, toMs: number): { fromDay: string; toDay: string } {
  return { fromDay: dayKey(fromMs), toDay: dayKey(Math.max(fromMs, toMs - 1)) };
}

export interface TimeBuckets {
  /** Days one bucket spans (1 = daily, 7 = weekly); 30 for calendar months. */
  bucketDays: number;
  /** Bucket start keys (`YYYY-MM-DD`, UTC midnight), oldest → newest. */
  keys: string[];
  /** Bucket key for an instant or a `YYYY-MM-DD` day; null outside the range. */
  keyFor(date: Date | string | number): string | null;
}

/**
 * Buckets over `[startMs, endMs)`, aligned to UTC midnight, the newest one
 * being the current day (or week, or month) so far. `auto` keeps about 31
 * buckets so a year-long period still renders a readable series.
 */
export function makeTimeBuckets(startMs: number, endMs: number, granularity: Granularity = 'auto'): TimeBuckets {
  const first = new Date(`${dayKey(startMs)}T00:00:00.000Z`).getTime();
  const end = Math.max(endMs, first + 1);
  const starts: number[] = [];
  let bucketDays: number;
  if (granularity === 'month') {
    bucketDays = 30;
    const d = new Date(first);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (t < end) {
      starts.push(t);
      const next = new Date(t);
      t = Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
    }
  } else {
    const days = Math.max(1, Math.ceil((end - first) / DAY_MS));
    bucketDays = granularity === 'day' ? 1 : granularity === 'week' ? 7 : Math.max(1, Math.ceil(days / 31));
    for (let t = first; t < end; t += bucketDays * DAY_MS) starts.push(t);
  }
  const keys = starts.map((t) => dayKey(t));
  const lowest = starts[0]!;
  return {
    bucketDays,
    keys,
    keyFor(date) {
      const ts =
        typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? Date.parse(`${date}T00:00:00Z`)
          : new Date(date).getTime();
      if (Number.isNaN(ts) || ts < lowest || ts >= end) return null;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= ts) lo = mid;
        else hi = mid - 1;
      }
      return keys[lo] ?? null;
    },
  };
}

/**
 * Index of the first non-empty entry, so long periods ("All time") don't
 * render years of empty leading buckets. Returns 0 when everything is empty.
 */
export function firstNonEmptyIndex<T>(items: T[], isEmpty: (item: T) => boolean): number {
  const index = items.findIndex((item) => !isEmpty(item));
  return index <= 0 ? 0 : index;
}

export function roundRate(passed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((passed / total) * 1000) / 10;
}

export function minutes(ms: number): number {
  return Math.round((ms / 60000) * 10) / 10;
}
