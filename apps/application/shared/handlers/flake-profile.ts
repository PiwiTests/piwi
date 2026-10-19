/**
 * The flake profile of one test: the suspects its history points at, ranked,
 * each with the raw counts behind it and the condition a lab would apply to
 * test it.
 *
 * The window is the test's last 30 days, at most 200 attempts, from the runs
 * the flaky leaderboard reads (finished, not lab runs, on the default branch
 * or no branch). Every attempt is compared on the same factors: the slowest
 * duration of each route the passes call too, the routes that failed, how many tests of its shard
 * ran at the same time, the other tests running beside it, the test that ran
 * just before it on its worker, and its browser project. A factor value is a
 * suspect when at least 3 failures show it and its smoothed lift is at least 2;
 * at most 5 are kept, ranked by lift × supporting failures. Factors a lab
 * cannot apply (first attempt or retry, hour of day, another run on the same
 * environment) are returned as context.
 *
 * `buildFlakeProfile` is pure; `getFlakeProfile` loads its input. Nothing is
 * stored: the profile is computed on each read. Shared by the REST endpoint,
 * the demo mirror, the MCP tool and the clue engine.
 */
import { aliasedTable, and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { projects, testCases, testRuns, testRunsCases, networkRequests } from '../../server/database/schema';
import { FAILED_STATUS_KEYS, isFailedStatus } from '../utils/test-counts';
import { requestRouteKey } from '../utils/route';
import { notLabRun } from './probes';
import { eligibleRunSql } from '../run-eligibility';
import { TERMINAL_STATUSES } from './projects';
import type { DrizzleDB } from './db';
import { topFlakeSuspect, type FlakeSuspectResult } from '../flake-lab';
import { median } from '../utils/stats';

/** How far back the profile reads, in days. */
export const FLAKE_PROFILE_WINDOW_DAYS = 30;
/** The most attempts the profile reads, newest first. */
export const FLAKE_PROFILE_MAX_ATTEMPTS = 200;
/** A factor needs at least this many failures showing it. */
export const FLAKE_SUSPECT_MIN_FAILURES = 3;
/** A factor needs at least this smoothed lift. */
export const FLAKE_SUSPECT_MIN_LIFT = 2;
/** The most suspects a profile lists. */
export const FLAKE_SUSPECT_MAX = 5;
/** The CPU slowdown a load suspect asks the lab to apply. */
const LOAD_CPU_RATE = 4;
/** Hours of the day are compared in blocks of this many hours, in UTC. */
const HOUR_BLOCK = 6;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ─── Input ────────────────────────────────────────────────────────────────────

export interface FlakeProfileRequest {
  method?: string | null;
  url?: string | null;
  status?: number | null;
  duration?: number | null;
  /** Why the request failed without a response (`net::ERR_CONNECTION_RESET`). */
  failure?: string | null;
}

/** Another execution of the same run that overlapped the attempt in time. */
export interface FlakeProfileOverlap {
  executionId: number;
  testCaseId: number;
  shardIndex: number | null;
}

export interface FlakeProfileAttempt {
  /** The execution row (`test_runs_cases.id`). */
  id: number;
  runId: number;
  status: 'passed' | 'failed';
  /** 0 on a first attempt. */
  retry: number;
  /** Epoch ms. */
  startedAt: number | null;
  duration: number | null;
  shardIndex: number | null;
  workerIndex: number | null;
  /** The Playwright project (or browser) it ran on. */
  project: string | null;
  requests: FlakeProfileRequest[];
  overlaps: FlakeProfileOverlap[];
  /** The execution that ran last before it on the same shard and worker. */
  before: { executionId: number; testCaseId: number } | null;
  /** Other runs on the same environment in progress while it ran; null when unknown. */
  concurrentRuns?: number | null;
}

export interface FlakeProfileInput {
  testCaseId: number;
  /** Newest first or in any order; only passed and failed attempts belong here. */
  attempts: FlakeProfileAttempt[];
  /** Titles of the other tests a suspect may name, by test case id. */
  titles?: Record<number, string>;
  /** Write route keys (`POST /api/products`) per execution id, for the shared-route line. */
  writeRoutes?: Record<number, string[]>;
  windowDays?: number;
}

// ─── Output ───────────────────────────────────────────────────────────────────

export type FlakeSuspectKind = 'slow-route' | 'failed-route' | 'alongside' | 'before' | 'load' | 'project';

/** What the lab would apply to test a suspect. */
export type FlakeCondition =
  | { kind: 'delay'; route: string; ms: number }
  | { kind: 'fail'; route: string; status: number }
  | { kind: 'fail'; route: string; abort: true }
  | { kind: 'cpu'; rate: number }
  | { kind: 'alongside'; testCaseId: number; title: string }
  | { kind: 'after'; testCaseId: number; title: string }
  | { kind: 'project'; name: string };

/** Failures and passes with the factor, out of all failures and passes in the window. */
export interface FlakeCounts {
  failuresWith: number;
  failures: number;
  passesWith: number;
  passes: number;
}

export interface FlakeSuspect {
  /**
   * Stable across profiles: the kind and the factor (`slow-route:GET /api/cart`), never a
   * threshold, so a lab result stays attached when the threshold moves. The load suspect is `load`.
   */
  id: string;
  kind: FlakeSuspectKind;
  /** A short name (`GET /api/cart slower (≥1.6 s)`). */
  label: string;
  /** One sentence with the counts, for an agent or a clue. */
  sentence: string;
  counts: FlakeCounts;
  /** `(fw + 1)/(f + 2) ÷ (pw + 1)/(p + 2)`. */
  lift: number;
  condition: FlakeCondition;
  /** The condition in a few words (`delay to 1.8 s`). */
  conditionLabel: string;
  /** The route key, for a route suspect. */
  route?: string;
  /** The duration from which a route counts as slow, in ms. */
  thresholdMs?: number;
  /** The number of other tests from which the shard counts as loaded. */
  thresholdCount?: number;
  /** The other test, for an alongside or before suspect. */
  testCaseId?: number;
  title?: string;
  /** The Playwright project, for a project suspect. */
  project?: string;
  /** Paths both tests write to (POST, PUT, PATCH, DELETE) in the attempts they shared. */
  sharedRoutes?: string[];
  /** Alongside only: some overlaps were on another shard, whose clock agrees only roughly. */
  approximate?: boolean;
  /** The failing executions that show this factor. */
  executionIds: number[];
}

export type FlakeContextKind = 'attempt' | 'hour' | 'concurrent-run';

/** A factor with no condition the lab can apply, shown for a human to weigh. */
export interface FlakeContextItem {
  kind: FlakeContextKind;
  label: string;
  counts: FlakeCounts;
  lift: number;
}

export interface FlakeProfile {
  testCaseId: number;
  windowDays: number;
  maxAttempts: number;
  /** Attempts read: failures plus passes. */
  attempts: number;
  failures: number;
  passes: number;
  /** Start of the oldest and newest attempt read, epoch ms. */
  from: number | null;
  to: number | null;
  suspects: FlakeSuspect[];
  context: FlakeContextItem[];
}

// ─── Pure build ───────────────────────────────────────────────────────────────

/** The smoothed lift of a factor: its rate among failures over its rate among passes. */
export function flakeLift(failuresWith: number, failures: number, passesWith: number, passes: number): number {
  return (failuresWith + 1) / (failures + 2) / ((passesWith + 1) / (passes + 2));
}

/** A duration for a label: `800 ms`, `1.7 s`, `2 s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/** A threshold for a label, rounded down so "or more" stays true: 1792 ms is `1.7 s`. */
function formatThreshold(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)} ms`;
  return `${Math.floor(ms / 100) / 10} s`;
}

function requestFailed(r: FlakeProfileRequest): boolean {
  const s = r.status ?? 0;
  return Boolean(r.failure) || s <= 0 || s >= 500;
}

function pathOf(routeKey: string): string {
  const space = routeKey.indexOf(' ');
  return space === -1 ? routeKey : routeKey.slice(space + 1);
}

/** The most frequent value, the first seen on a tie. */
function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

interface Split {
  failed: FlakeProfileAttempt[];
  passed: FlakeProfileAttempt[];
}

function countWith(split: Split, has: (a: FlakeProfileAttempt) => boolean): FlakeCounts {
  return {
    failuresWith: split.failed.filter(has).length,
    failures: split.failed.length,
    passesWith: split.passed.filter(has).length,
    passes: split.passed.length,
  };
}

function liftOf(c: FlakeCounts): number {
  return flakeLift(c.failuresWith, c.failures, c.passesWith, c.passes);
}

function passesBar(c: FlakeCounts): boolean {
  return c.failuresWith >= FLAKE_SUSPECT_MIN_FAILURES && liftOf(c) >= FLAKE_SUSPECT_MIN_LIFT;
}

/**
 * The threshold that separates failures from passes best: among the values the
 * failures take (at least `min`), the one maximizing the share of failures at
 * or above it minus the share of passes at or above it, the lowest on a tie,
 * with at least 3 failures at or above it. Undefined when none qualifies.
 */
function bestThreshold(
  split: Split,
  valueOf: (a: FlakeProfileAttempt) => number | undefined,
  min: number,
): number | undefined {
  const failValues = split.failed.map(valueOf).filter((v): v is number => v != null && v >= min);
  const passValues = split.passed.map(valueOf).filter((v): v is number => v != null);
  const candidates = [...new Set(failValues)].sort((a, b) => a - b);
  let best: number | undefined;
  let bestScore = -Infinity;
  for (const t of candidates) {
    const fw = failValues.filter((v) => v >= t).length;
    if (fw < FLAKE_SUSPECT_MIN_FAILURES) continue;
    const pw = passValues.filter((v) => v >= t).length;
    const score = fw / split.failed.length - pw / Math.max(1, split.passed.length);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** Every route key an attempt called, with its slowest answered duration and its failures. */
function routesOf(a: FlakeProfileAttempt): Map<string, { slowest?: number; failures: FlakeProfileRequest[] }> {
  const map = new Map<string, { slowest?: number; failures: FlakeProfileRequest[] }>();
  for (const r of a.requests) {
    const key = requestRouteKey(r.method, r.url);
    const entry = map.get(key) ?? { failures: [] };
    if (requestFailed(r)) entry.failures.push(r);
    else if (r.duration != null) entry.slowest = Math.max(entry.slowest ?? 0, r.duration);
    map.set(key, entry);
  }
  return map;
}

function sameShard(a: number | null, b: number | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Ranking tiebreak: the more specific factor first. */
const KIND_ORDER: Record<FlakeSuspectKind, number> = {
  'slow-route': 0,
  'failed-route': 1,
  alongside: 2,
  before: 3,
  load: 4,
  project: 5,
};

function countsText(c: FlakeCounts): string {
  return `${c.failuresWith} of ${c.failures} failures and ${c.passesWith} of ${c.passes} passes`;
}

export function buildFlakeProfile(input: FlakeProfileInput): FlakeProfile {
  const attempts = input.attempts;
  const split: Split = {
    failed: attempts.filter((a) => a.status === 'failed'),
    passed: attempts.filter((a) => a.status === 'passed'),
  };
  const starts = attempts.map((a) => a.startedAt).filter((v): v is number => v != null);
  const profile: FlakeProfile = {
    testCaseId: input.testCaseId,
    windowDays: input.windowDays ?? FLAKE_PROFILE_WINDOW_DAYS,
    maxAttempts: FLAKE_PROFILE_MAX_ATTEMPTS,
    attempts: split.failed.length + split.passed.length,
    failures: split.failed.length,
    passes: split.passed.length,
    from: starts.length ? Math.min(...starts) : null,
    to: starts.length ? Math.max(...starts) : null,
    suspects: [],
    context: [],
  };
  if (split.failed.length === 0 || split.passed.length === 0) return profile;

  const titleOf = (id: number) => input.titles?.[id] ?? `test #${id}`;
  const routes = new Map(attempts.map((a) => [a.id, routesOf(a)]));
  const candidates: FlakeSuspect[] = [];
  const add = (suspect: Omit<FlakeSuspect, 'lift' | 'executionIds'>, has: (a: FlakeProfileAttempt) => boolean) => {
    if (!passesBar(suspect.counts)) return;
    candidates.push({
      ...suspect,
      lift: liftOf(suspect.counts),
      executionIds: split.failed.filter(has).map((a) => a.id),
    });
  };

  // ── Routes: slow, and failed ──────────────────────────────────────────────
  const routeKeys = new Set<string>();
  for (const a of split.failed) for (const key of routes.get(a.id)!.keys()) routeKeys.add(key);
  for (const route of [...routeKeys].sort()) {
    const slowest = (a: FlakeProfileAttempt) => routes.get(a.id)!.get(route)?.slowest;
    // Slower needs something to be slower than: the passes must call the route too.
    const threshold = split.passed.some((a) => slowest(a) != null) ? bestThreshold(split, slowest, 1) : undefined;
    if (threshold != null) {
      const has = (a: FlakeProfileAttempt) => (slowest(a) ?? -1) >= threshold;
      const counts = countWith(split, has);
      const ms = Math.round(median(split.failed.filter(has).map((a) => slowest(a)!))! / 100) * 100;
      add(
        {
          id: `slow-route:${route}`,
          kind: 'slow-route',
          label: `${route} slower (≥${formatThreshold(threshold)})`,
          sentence: `${route} took ${formatThreshold(threshold)} or more in ${countsText(counts)}.`,
          counts,
          condition: { kind: 'delay', route, ms },
          conditionLabel: `delay to ${formatDuration(ms)}`,
          route,
          thresholdMs: threshold,
        },
        has,
      );
    }

    const failuresOf = (a: FlakeProfileAttempt) => routes.get(a.id)!.get(route)?.failures ?? [];
    const failedHas = (a: FlakeProfileAttempt) => failuresOf(a).length > 0;
    const failedCounts = countWith(split, failedHas);
    if (passesBar(failedCounts)) {
      const seen = split.failed.filter(failedHas).flatMap(failuresOf);
      const status = mostCommon(seen.map((r) => r.status ?? 0).filter((s) => s >= 500));
      const reason = mostCommon(seen.map((r) => r.failure || String(r.status ?? 0)))!;
      const condition: FlakeCondition =
        status != null ? { kind: 'fail', route, status } : { kind: 'fail', route, abort: true };
      add(
        {
          id: `failed-route:${route}`,
          kind: 'failed-route',
          label: `${route} failed (${reason})`,
          sentence: `${route} failed (${reason}) in ${countsText(failedCounts)}.`,
          counts: failedCounts,
          condition,
          conditionLabel: status != null ? `fail with ${status}` : 'abort the request',
          route,
        },
        failedHas,
      );
    }
  }

  // ── Load: other tests of the same shard running at the same time ─────────
  const loadOf = (a: FlakeProfileAttempt) => a.overlaps.filter((o) => sameShard(o.shardIndex, a.shardIndex)).length;
  const loadThreshold = bestThreshold(split, loadOf, 1);
  if (loadThreshold != null) {
    const has = (a: FlakeProfileAttempt) => loadOf(a) >= loadThreshold;
    const counts = countWith(split, has);
    add(
      {
        id: 'load',
        kind: 'load',
        label: `${loadThreshold} or more other tests running at once`,
        sentence: `${loadThreshold} or more other tests were running at once in ${countsText(counts)}.`,
        counts,
        condition: { kind: 'cpu', rate: LOAD_CPU_RATE },
        conditionLabel: `CPU ×${LOAD_CPU_RATE}`,
        thresholdCount: loadThreshold,
      },
      has,
    );
  }

  // ── Alongside: another test overlapping in time, on any shard ───────────
  const neighborIds = new Set<number>();
  for (const a of split.failed) for (const o of a.overlaps) neighborIds.add(o.testCaseId);
  neighborIds.delete(input.testCaseId);
  for (const neighbor of [...neighborIds].sort((x, y) => x - y)) {
    const has = (a: FlakeProfileAttempt) => a.overlaps.some((o) => o.testCaseId === neighbor);
    const counts = countWith(split, has);
    if (!passesBar(counts)) continue;
    const title = titleOf(neighbor);
    const approximate = attempts.some((a) =>
      a.overlaps.some((o) => o.testCaseId === neighbor && !sameShard(o.shardIndex, a.shardIndex)),
    );
    const pairs = split.failed
      .filter(has)
      .map((a) => ({ own: a, other: a.overlaps.filter((o) => o.testCaseId === neighbor).map((o) => o.executionId) }));
    const sharedRoutes = sharedWritePaths(pairs, input.writeRoutes);
    add(
      {
        id: `alongside:${neighbor}`,
        kind: 'alongside',
        label: `${title} alongside`,
        sentence:
          `${title} was running in ${countsText(counts)}` +
          (sharedRoutes.length ? `, and both write ${sharedRoutes.join(', ')}.` : '.'),
        counts,
        condition: { kind: 'alongside', testCaseId: neighbor, title },
        conditionLabel: 'run together',
        testCaseId: neighbor,
        title,
        sharedRoutes,
        approximate,
      },
      has,
    );
  }

  // ── Before: the test that ran last on the same worker ────────────────────
  const beforeIds = new Set<number>();
  for (const a of split.failed) if (a.before) beforeIds.add(a.before.testCaseId);
  beforeIds.delete(input.testCaseId);
  for (const previous of [...beforeIds].sort((x, y) => x - y)) {
    const has = (a: FlakeProfileAttempt) => a.before?.testCaseId === previous;
    const counts = countWith(split, has);
    if (!passesBar(counts)) continue;
    const title = titleOf(previous);
    const pairs = split.failed.filter(has).map((a) => ({ own: a, other: [a.before!.executionId] }));
    const sharedRoutes = sharedWritePaths(pairs, input.writeRoutes);
    add(
      {
        id: `before:${previous}`,
        kind: 'before',
        label: `${title} just before`,
        sentence:
          `${title} ran just before it on the same worker in ${countsText(counts)}` +
          (sharedRoutes.length ? `, and both write ${sharedRoutes.join(', ')}.` : '.'),
        counts,
        condition: { kind: 'after', testCaseId: previous, title },
        conditionLabel: 'run it first',
        testCaseId: previous,
        title,
        sharedRoutes,
      },
      has,
    );
  }

  // ── Browser or project: only when the window covers more than one ────────
  const projectNames = [...new Set(attempts.map((a) => a.project).filter((p): p is string => !!p))].sort();
  if (projectNames.length > 1) {
    for (const name of projectNames) {
      const has = (a: FlakeProfileAttempt) => a.project === name;
      const counts = countWith(split, has);
      add(
        {
          id: `project:${name}`,
          kind: 'project',
          label: `on ${name}`,
          sentence: `It ran on ${name} in ${countsText(counts)}.`,
          counts,
          condition: { kind: 'project', name },
          conditionLabel: `run on ${name}`,
          project: name,
        },
        has,
      );
    }
  }

  profile.suspects = candidates
    .sort(
      (x, y) =>
        y.lift * y.counts.failuresWith - x.lift * x.counts.failuresWith ||
        KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
        x.id.localeCompare(y.id),
    )
    .slice(0, FLAKE_SUSPECT_MAX);

  profile.context = buildContext(split);
  return profile;
}

/**
 * Paths both tests wrote to in the attempts they shared: for each pair, the
 * write paths of the attempt (its own requests and any recorded write routes)
 * that the other execution also wrote, in path order.
 */
function sharedWritePaths(
  pairs: Array<{ own: FlakeProfileAttempt; other: number[] }>,
  writeRoutes: Record<number, string[]> | undefined,
): string[] {
  const shared = new Set<string>();
  for (const { own, other } of pairs) {
    const ownPaths = new Set<string>();
    for (const r of own.requests) {
      const key = requestRouteKey(r.method, r.url);
      if (WRITE_METHODS.has(key.split(' ')[0]!)) ownPaths.add(pathOf(key));
    }
    for (const key of writeRoutes?.[own.id] ?? []) ownPaths.add(pathOf(key));
    for (const executionId of other) {
      for (const key of writeRoutes?.[executionId] ?? []) {
        const path = pathOf(key);
        if (ownPaths.has(path)) shared.add(path);
      }
    }
  }
  return [...shared].sort();
}

function buildContext(split: Split): FlakeContextItem[] {
  const out: FlakeContextItem[] = [];
  const item = (kind: FlakeContextKind, label: string, has: (a: FlakeProfileAttempt) => boolean) => {
    const counts = countWith(split, has);
    return { kind, label, counts, lift: liftOf(counts) };
  };

  out.push(item('attempt', 'on a first attempt', (a) => a.retry === 0));

  const blockOf = (a: FlakeProfileAttempt) =>
    a.startedAt == null ? null : Math.floor(new Date(a.startedAt).getUTCHours() / HOUR_BLOCK);
  const blocks = [...new Set(split.failed.map(blockOf).filter((b): b is number => b != null))].sort((x, y) => x - y);
  const hours = blocks
    .map((b) => {
      const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
      return item(
        'hour',
        `between ${pad(b * HOUR_BLOCK)} and ${pad((b + 1) * HOUR_BLOCK)} UTC`,
        (a) => blockOf(a) === b,
      );
    })
    .filter((c) => passesBar(c.counts))
    .sort((x, y) => y.lift * y.counts.failuresWith - x.lift * x.counts.failuresWith);
  if (hours[0]) out.push(hours[0]);

  const concurrent = item(
    'concurrent-run',
    'while another run was using the same environment',
    (a) => (a.concurrentRuns ?? 0) > 0,
  );
  if (passesBar(concurrent.counts)) out.push(concurrent);
  return out;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/** Statuses of an execution that ran. */
const RAN_STATUSES = ['passed', ...FAILED_STATUS_KEYS, 'interrupted'];

/** Coerce a stored `startedAt` (epoch ms number, bigint string or Date) to epoch ms. */
function epochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** The start of the window that ends at `now`. */
function windowStart(now: Date): Date {
  return new Date(now.getTime() - FLAKE_PROFILE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The attempts a profile reads, joined with their runs: the runs the flaky
 * leaderboard reads (finished, eligible for the `flakiness` use, and on the default branch or no
 * branch when the project names one), passed or failed, in the window.
 */
function windowAttempts(testCaseId: number, defaultBranch: string | null, since: Date) {
  return and(
    eq(testRunsCases.testCaseId, testCaseId),
    gte(testRunsCases.createdAt, since),
    inArray(testRunsCases.status, ['passed', ...FAILED_STATUS_KEYS]),
    inArray(testRuns.status, TERMINAL_STATUSES),
    eligibleRunSql('flakiness'),
    defaultBranch ? or(eq(testRuns.branch, defaultBranch), isNull(testRuns.branch)) : undefined,
  );
}

/**
 * Whether a test's history can name a suspect at all, from two counts: a
 * suspect needs at least {@link FLAKE_SUSPECT_MIN_FAILURES} failures, and a
 * lift of 2 needs a pass (with no pass the smoothed failure share is below 1,
 * so the lift is too). The clue engine asks this before loading a profile, so a
 * test that only ever failed, or failed once or twice, costs one count.
 *
 * Counts the whole window without the attempt cap, so it only says no when
 * the profile would find nothing.
 */
export async function mayHaveFlakeSuspects(
  db: DrizzleDB,
  testCaseId: number,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const [tc] = await db
    .select({ defaultBranch: projects.defaultBranch })
    .from(testCases)
    .innerJoin(projects, eq(testCases.projectId, projects.id))
    .where(eq(testCases.id, testCaseId));
  if (!tc) return false;
  const [counts] = await db
    .select({
      attempts: sql<number>`COUNT(*)`,
      passes: sql<number>`SUM(CASE WHEN ${testRunsCases.status} = 'passed' THEN 1 ELSE 0 END)`,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(windowAttempts(testCaseId, tc.defaultBranch, windowStart(opts.now ?? new Date())));
  // Postgres returns both as strings, and the sum as null over no rows.
  const passes = Number(counts?.passes ?? 0);
  const failures = Number(counts?.attempts ?? 0) - passes;
  return failures >= FLAKE_SUSPECT_MIN_FAILURES && passes >= 1;
}

export interface FlakeProfileOptions {
  /** The end of the window; defaults to now. */
  now?: Date;
  /**
   * Leave out what only the full view shows: the shared write routes and the
   * other runs on the same environment. The flaky list reads the top suspect
   * this way.
   */
  summary?: boolean;
}

/**
 * Load one test's attempts in its window and build its profile. Returns null
 * when the test case does not exist.
 *
 * Bounded by the attempt cap: one query for the attempts, one for their
 * requests, one for the executions of the same runs that overlapped them, one
 * for the execution just before each on its worker, and, for the suspects
 * found, the titles and write routes they name.
 */
export async function getFlakeProfile(
  db: DrizzleDB,
  testCaseId: number,
  opts: FlakeProfileOptions = {},
): Promise<FlakeProfile | null> {
  const [tc] = await db
    .select({ id: testCases.id, projectId: testCases.projectId, defaultBranch: projects.defaultBranch })
    .from(testCases)
    .innerJoin(projects, eq(testCases.projectId, projects.id))
    .where(eq(testCases.id, testCaseId));
  if (!tc) return null;

  const since = windowStart(opts.now ?? new Date());

  const rows = await db
    .select({
      id: testRunsCases.id,
      runId: testRunsCases.testRunId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      duration: testRunsCases.duration,
      startedAt: testRunsCases.startedAt,
      workerIndex: testRunsCases.workerIndex,
      shardIndex: testRunsCases.shardIndex,
      browser: testRunsCases.browser,
      browserName: testRunsCases.browserName,
      environment: testRuns.environment,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(windowAttempts(testCaseId, tc.defaultBranch, since))
    .orderBy(desc(testRunsCases.createdAt))
    .limit(FLAKE_PROFILE_MAX_ATTEMPTS);

  const ids = rows.map((r) => r.id);
  const attempts = new Map<number, FlakeProfileAttempt>();
  for (const r of rows) {
    const browser = r.browser as { projectName?: string; browserName?: string } | null;
    attempts.set(r.id, {
      id: r.id,
      runId: r.runId,
      status: isFailedStatus(r.status) ? 'failed' : 'passed',
      retry: r.retries ?? 0,
      startedAt: epochMs(r.startedAt),
      duration: r.duration ?? null,
      shardIndex: r.shardIndex ?? null,
      workerIndex: r.workerIndex ?? null,
      project: r.browserName ?? browser?.projectName ?? browser?.browserName ?? null,
      requests: [],
      overlaps: [],
      before: null,
      concurrentRuns: null,
    });
  }

  if (ids.length > 0) {
    const other = aliasedTable(testRunsCases, 'other');
    // The outer columns are spelled out: a single-table select renders an
    // interpolated column without its table, which inside the subquery would
    // name `prev`'s own column.
    const before = db
      .select({
        attemptId: testRunsCases.id,
        executionId: sql<number | null>`(
          SELECT prev.id FROM test_runs_cases prev
          WHERE prev.test_run_id = test_runs_cases.test_run_id
            AND prev.worker_index = test_runs_cases.worker_index
            AND COALESCE(prev.shard_index, -1) = COALESCE(test_runs_cases.shard_index, -1)
            AND prev.started_at < test_runs_cases.started_at
          ORDER BY prev.started_at DESC, prev.id DESC
          LIMIT 1
        )`.as('before_execution_id'),
      })
      .from(testRunsCases)
      .where(and(inArray(testRunsCases.id, ids), isNotNull(testRunsCases.startedAt)))
      .as('before');
    const [requestRows, overlapRows, beforeRows] = await Promise.all([
      db
        .select({
          executionId: networkRequests.testRunsCaseId,
          method: networkRequests.method,
          url: networkRequests.url,
          status: networkRequests.status,
          duration: networkRequests.duration,
          failure: networkRequests.failure,
        })
        .from(networkRequests)
        .where(inArray(networkRequests.testRunsCaseId, ids)),
      // Executions of the same run whose interval intersects the attempt's.
      db
        .select({
          attemptId: testRunsCases.id,
          executionId: other.id,
          testCaseId: other.testCaseId,
          shardIndex: other.shardIndex,
        })
        .from(testRunsCases)
        .innerJoin(
          other,
          and(eq(other.testRunId, testRunsCases.testRunId), ne(other.testCaseId, testRunsCases.testCaseId)),
        )
        .where(
          and(
            inArray(testRunsCases.id, ids),
            isNotNull(testRunsCases.startedAt),
            isNotNull(testRunsCases.duration),
            isNotNull(other.startedAt),
            isNotNull(other.duration),
            inArray(other.status, RAN_STATUSES),
            sql`${other.startedAt} < ${testRunsCases.startedAt} + ${testRunsCases.duration}`,
            sql`${other.startedAt} + ${other.duration} > ${testRunsCases.startedAt}`,
          ),
        ),
      // The execution that started last before the attempt on its shard and
      // worker, looked up attempt by attempt among the executions of its run.
      db
        .select({ attemptId: before.attemptId, executionId: other.id, testCaseId: other.testCaseId })
        .from(before)
        .innerJoin(other, eq(other.id, before.executionId)),
    ]);
    for (const r of requestRows) attempts.get(r.executionId)?.requests.push(r);
    for (const o of overlapRows) {
      attempts.get(o.attemptId)?.overlaps.push({
        executionId: o.executionId,
        testCaseId: o.testCaseId,
        shardIndex: o.shardIndex ?? null,
      });
    }
    for (const b of beforeRows) {
      const a = attempts.get(b.attemptId);
      if (a && !a.before) a.before = { executionId: b.executionId, testCaseId: b.testCaseId };
    }

    if (!opts.summary) await countConcurrentRuns(db, tc.projectId, rows, attempts, since);
  }

  const input: FlakeProfileInput = { testCaseId, attempts: [...attempts.values()] };
  const first = buildFlakeProfile(input);

  // The suspects name other tests: read their titles, and, for the full view,
  // the write routes of the executions they share with the failures.
  const named = first.suspects.filter((s) => s.kind === 'alongside' || s.kind === 'before');
  if (named.length === 0) return first;
  const titleRows = await db
    .select({ id: testCases.id, title: testCases.title })
    .from(testCases)
    .where(
      inArray(
        testCases.id,
        named.map((s) => s.testCaseId!),
      ),
    );
  input.titles = Object.fromEntries(titleRows.map((t) => [t.id, t.title]));

  if (!opts.summary) {
    const executionIds = new Set<number>();
    for (const s of named) {
      for (const id of s.executionIds) {
        const a = attempts.get(id)!;
        if (s.kind === 'alongside') {
          for (const o of a.overlaps) if (o.testCaseId === s.testCaseId) executionIds.add(o.executionId);
        } else if (a.before) executionIds.add(a.before.executionId);
      }
    }
    if (executionIds.size > 0) {
      const writeRows = await db
        .select({
          executionId: networkRequests.testRunsCaseId,
          method: networkRequests.method,
          url: networkRequests.url,
        })
        .from(networkRequests)
        .where(
          and(
            inArray(networkRequests.testRunsCaseId, [...executionIds]),
            inArray(networkRequests.method, [...WRITE_METHODS]),
          ),
        );
      const writeRoutes: Record<number, string[]> = {};
      for (const w of writeRows) (writeRoutes[w.executionId] ??= []).push(requestRouteKey(w.method, w.url));
      input.writeRoutes = writeRoutes;
    }
  }
  return buildFlakeProfile(input);
}

/**
 * For each attempt of a run with an environment, the other runs on that
 * environment in progress while it ran — from the project's runs in the
 * window, compared in memory on epoch ms.
 */
async function countConcurrentRuns(
  db: DrizzleDB,
  projectId: number,
  rows: Array<{ id: number; runId: number; environment: string | null }>,
  attempts: Map<number, FlakeProfileAttempt>,
  since: Date,
): Promise<void> {
  const environments = [...new Set(rows.map((r) => r.environment).filter((e): e is string => !!e))];
  if (environments.length === 0) return;
  // A run that started up to a day before the window can still overlap its first attempt.
  const from = new Date(since.getTime() - 24 * 60 * 60 * 1000);
  const runs = await db
    .select({
      id: testRuns.id,
      environment: testRuns.environment,
      startTime: testRuns.startTime,
      duration: testRuns.duration,
    })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.projectId, projectId),
        inArray(testRuns.environment, environments),
        gte(testRuns.startTime, from),
        notLabRun(testRuns.origin),
      ),
    )
    .orderBy(desc(testRuns.startTime))
    .limit(5000);
  const spans = runs.map((r) => {
    const start = epochMs(r.startTime) ?? 0;
    return { id: r.id, environment: r.environment, start, end: start + (r.duration ?? 0) };
  });
  for (const row of rows) {
    const a = attempts.get(row.id)!;
    if (!row.environment || a.startedAt == null) continue;
    const end = a.startedAt + (a.duration ?? 0);
    a.concurrentRuns = spans.filter(
      (s) => s.id !== row.runId && s.environment === row.environment && s.start < end && s.end > a.startedAt!,
    ).length;
  }
}

/** The most tests one call to {@link getTopFlakeSuspects} reads. */
export const TOP_SUSPECTS_MAX_TESTS = 50;

export interface TopFlakeSuspect {
  testCaseId: number;
  failures: number;
  passes: number;
  /**
   * The suspect it is shown with (`topFlakeSuspect`): the first-ranked one a lab run reproduced, else the
   * first-ranked untested one, else one that did not reproduce; null when the history names none.
   */
  suspect: FlakeSuspect | null;
}

/**
 * The top suspect of each listed test of a project, for the flaky list, picked
 * by `topFlakeSuspect` from the test's lab `results` (a reproduced suspect
 * first, one that did not reproduce last). Ids of tests outside the project are dropped; at most
 * {@link TOP_SUSPECTS_MAX_TESTS} are read in the summary view, by `profiles` when given (the
 * server keeps them between runs), else by {@link getFlakeProfileSummaries}.
 */
export async function getTopFlakeSuspects(
  db: DrizzleDB,
  projectId: number,
  testCaseIds: number[],
  opts: {
    now?: Date;
    results?: ReadonlyMap<number, ReadonlyMap<string, FlakeSuspectResult>>;
    profiles?: (testCaseIds: number[]) => Promise<FlakeProfile[]>;
  } = {},
): Promise<TopFlakeSuspect[]> {
  const wanted = [...new Set(testCaseIds)].slice(0, TOP_SUSPECTS_MAX_TESTS);
  if (wanted.length === 0) return [];
  const owned = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(and(eq(testCases.projectId, projectId), inArray(testCases.id, wanted)));
  const ownedIds = new Set(owned.map((r) => r.id));
  const ids = wanted.filter((id) => ownedIds.has(id));

  const profiles = await (opts.profiles?.(ids) ?? getFlakeProfileSummaries(db, ids, { now: opts.now }));
  return profiles.map((p) => ({
    testCaseId: p.testCaseId,
    failures: p.failures,
    passes: p.passes,
    suspect: topFlakeSuspect(p.suspects, opts.results?.get(p.testCaseId) ?? new Map()),
  }));
}

/** Several tests' profiles in the summary view, a few at a time, in the order asked; unknown tests are left out. */
export async function getFlakeProfileSummaries(
  db: DrizzleDB,
  testCaseIds: number[],
  opts: { now?: Date } = {},
): Promise<FlakeProfile[]> {
  const out: FlakeProfile[] = [];
  const BATCH = 5;
  for (let i = 0; i < testCaseIds.length; i += BATCH) {
    const profiles = await Promise.all(
      testCaseIds.slice(i, i + BATCH).map((id) => getFlakeProfile(db, id, { now: opts.now, summary: true })),
    );
    for (const p of profiles) if (p) out.push(p);
  }
  return out;
}
