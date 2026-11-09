/**
 * The pass reuse forecast: how many of a project's recent test results ran
 * code identical to an earlier pass, and how many of those failed anyway.
 *
 * A **source** is a result that passed on its first attempt and whose coverage
 * names its file versions (runtime, path, git blob). A later result of the
 * same test, in the same Playwright project and another run, is
 * **reusable** when a source at most `maxSourceAgeMs` older:
 *  - recorded file versions that are all among the versions the result ran,
 *    so the code that pass ran had not changed; or
 *  - ran at the same commit, both on CI, where the commit is the code. This
 *    counts a failure that stopped before reaching code its pass ran.
 * A reusable result that failed, or passed only on a retry, failed with the
 * code it ran unchanged: the test, its data or its environment caused it.
 *
 * The forecast is an upper bound of what reuse would skip: it sees only the
 * files coverage records, not test-side code, configuration or dependencies,
 * whose changes would run more tests.
 */

/** Days of results the forecast reads, and the oldest pass that may stand in for a later result. */
export const REUSE_FORECAST_WINDOW_DAYS = 30;
export const REUSE_FORECAST_MAX_SOURCE_AGE_DAYS = 14;

/** Where a result ran: on the project's default branch, or on any other. */
export type ReuseScope = 'default-branch' | 'other-branches';
export const REUSE_SCOPES: readonly ReuseScope[] = ['default-branch', 'other-branches'];

/** A result's outcome: passed on its first attempt, passed after a failed attempt, or failed. */
export type ReuseOutcome = 'passed' | 'flaky' | 'failed';

/** One test result: a test, in one Playwright project, run, and repetition. */
export interface ForecastResult {
  /** The id of its final attempt. */
  executionId: number;
  runId: number;
  testCaseId: number;
  /** The Playwright project; '' when unknown. */
  browserName: string;
  /** When it started, in milliseconds. */
  at: number;
  scope: ReuseScope;
  outcome: ReuseOutcome;
  /** The summed duration of its attempts, in milliseconds. */
  durationMs: number;
  /**
   * The file versions its coverage recorded, one key per runtime, path and
   * blob; null when they cannot be compared: no coverage, incomplete
   * coverage, or a file without its blob. Results that recorded the same
   * versions may share one set.
   */
  versions: ReadonlySet<string | number> | null;
  /** The commit of its run when the run came from CI, where the commit is the code it ran; null otherwise. */
  ciCommit: string | null;
}

/** The forecast of one scope, or of all of them. */
export interface ReuseScopeForecast {
  /** Results of the window. */
  results: number;
  /** Results whose coverage could be compared. */
  comparable: number;
  /** Results that ran code identical to an earlier pass. */
  reusable: number;
  /** Test time of every result of the window, in milliseconds. */
  durationMs: number;
  /** Test time of the reusable results, in milliseconds. */
  reusableDurationMs: number;
  /** Reusable results that failed. */
  failed: number;
  /** Reusable results that passed only after a failed attempt. */
  flaky: number;
}

/** A test whose results failed, or passed after a failure, with the code it ran unchanged since a pass. */
export interface IdenticalCodeFailure {
  testCaseId: number;
  browserName: string;
  failed: number;
  flaky: number;
  /** The final attempt of its most recent such result. */
  lastExecutionId: number;
  /** The pass whose code that result ran unchanged. */
  sourceExecutionId: number;
}

export interface ReuseForecastCore {
  total: ReuseScopeForecast;
  scopes: Record<ReuseScope, ReuseScopeForecast>;
  /** Every test with an identical-code failure, the most such results first. */
  tests: IdenticalCodeFailure[];
}

/** The key of a file version. */
export function fileVersionId(runtime: string, path: string, blob: string): string {
  return `${runtime}\x00${path}\x00${blob}`;
}

function emptyScope(): ReuseScopeForecast {
  return { results: 0, comparable: 0, reusable: 0, durationMs: 0, reusableDurationMs: 0, failed: 0, flaky: 0 };
}

function isSubset(source: ReadonlySet<string | number>, result: ReadonlySet<string | number>): boolean {
  if (source.size > result.size) return false;
  for (const version of source) if (!result.has(version)) return false;
  return true;
}

/** Whether a result may stand in for a later one: a first-attempt pass whose coverage can be compared. */
function isSource(result: ForecastResult): boolean {
  return result.outcome === 'passed' && result.versions != null && result.versions.size > 0;
}

/** The newest source of one kind (one set of versions, or one commit), and the newest of another run than it. */
interface Newest {
  latest: ForecastResult;
  otherRun: ForecastResult | null;
}

function advance(known: Newest | undefined, source: ForecastResult): Newest {
  if (!known) return { latest: source, otherRun: null };
  return { latest: source, otherRun: known.latest.runId !== source.runId ? known.latest : known.otherRun };
}

function remember<K>(map: Map<K, Newest>, key: K, source: ForecastResult): void {
  map.set(key, advance(map.get(key), source));
}

/**
 * The sources of one test, indexed by the highest-ranked file version each one
 * ran, usually its newest: a result can only have run every version of a source
 * if it ran that one, so a lookup probes one bucket per version the result ran
 * instead of scanning every source.
 */
class VersionSources {
  private byVersions = new Map<ReadonlySet<string | number>, Newest>();
  private buckets = new Map<string | number, Array<ReadonlySet<string | number>>>();

  constructor(private rank: (version: string | number) => number) {}

  remember(source: ForecastResult): void {
    const versions = source.versions!;
    const known = this.byVersions.get(versions);
    this.byVersions.set(versions, advance(known, source));
    if (known) return;
    let key: string | number | undefined;
    for (const version of versions) if (key === undefined || this.rank(version) > this.rank(key)) key = version;
    const bucket = this.buckets.get(key!);
    if (bucket) bucket.push(versions);
    else this.buckets.set(key!, [versions]);
  }

  /** The newest source whose versions `result` all ran, of another run and young enough, or `best` when none is newer. */
  match(result: ForecastResult, maxSourceAgeMs: number, best: ForecastResult | null): ForecastResult | null {
    const ran = result.versions!;
    // Probe the smaller side: the result's versions, or the keys of the sources.
    const keys = this.buckets.size < ran.size ? [...this.buckets.keys()].filter((key) => ran.has(key)) : ran;
    for (const version of keys) {
      const bucket = this.buckets.get(version);
      if (!bucket) continue;
      for (let i = bucket.length - 1; i >= 0; i--) {
        const versions = bucket[i]!;
        const newest = this.byVersions.get(versions)!;
        if (result.at - newest.latest.at > maxSourceAgeMs) {
          // Results come in time order: a source too old for this one is too old for every later one.
          bucket.splice(i, 1);
          this.byVersions.delete(versions);
          continue;
        }
        if (best && newest.latest.at <= best.at) continue;
        const source = usable(newest, result, maxSourceAgeMs);
        if (source && (!best || source.at > best.at) && isSubset(versions, ran)) best = source;
      }
      if (bucket.length === 0) this.buckets.delete(version);
    }
    return best;
  }
}

/** The newest source of `newest` that is of another run than `result` and young enough, or null. */
function usable(newest: Newest, result: ForecastResult, maxSourceAgeMs: number): ForecastResult | null {
  const source = newest.latest.runId === result.runId ? newest.otherRun : newest.latest;
  return source && result.at - source.at <= maxSourceAgeMs ? source : null;
}

/** The newest source `result` ran the code of, or null. */
function matchingSource(
  result: ForecastResult,
  byVersions: VersionSources,
  byCommit: Map<string, Newest>,
  maxSourceAgeMs: number,
): ForecastResult | null {
  let best: ForecastResult | null = null;
  if (result.ciCommit) {
    const newest = byCommit.get(result.ciCommit);
    if (newest) best = usable(newest, result, maxSourceAgeMs);
  }
  if (result.versions && result.versions.size > 0) best = byVersions.match(result, maxSourceAgeMs, best);
  return best;
}

/**
 * Forecast reuse over `results`: those from `from` on are counted, the earlier
 * ones serve only as sources for them.
 */
export function forecastReuse(
  results: readonly ForecastResult[],
  opts: { from: number; maxSourceAgeMs: number },
): ReuseForecastCore {
  const total = emptyScope();
  const scopes: Record<ReuseScope, ReuseScopeForecast> = {
    'default-branch': emptyScope(),
    'other-branches': emptyScope(),
  };
  const tests = new Map<string, IdenticalCodeFailure>();

  // Each version's rank, its index key: a number ranks as itself (the handler interns versions in the order their
  // coverage fragments were stored, so the highest is the newest); a string by the order it was first seen in.
  const ranks = new Map<string, number>();
  for (const result of [...results].sort((a, b) => a.at - b.at)) {
    for (const version of result.versions ?? []) {
      if (typeof version === 'string' && !ranks.has(version)) ranks.set(version, ranks.size);
    }
  }
  const rank = (version: string | number) => (typeof version === 'number' ? version : (ranks.get(version) ?? -1));

  const groups = new Map<string, ForecastResult[]>();
  for (const result of results) {
    const key = `${result.testCaseId}\x00${result.browserName}`;
    const group = groups.get(key);
    if (group) group.push(result);
    else groups.set(key, [result]);
  }

  for (const [key, group] of groups) {
    group.sort((a, b) => a.at - b.at || a.executionId - b.executionId);
    const byVersions = new VersionSources(rank);
    const byCommit = new Map<string, Newest>();
    for (const result of group) {
      if (result.at >= opts.from) {
        const source = matchingSource(result, byVersions, byCommit, opts.maxSourceAgeMs);
        const comparable = result.versions != null && result.versions.size > 0;
        for (const tally of [total, scopes[result.scope]]) {
          tally.results++;
          tally.durationMs += result.durationMs;
          if (comparable) tally.comparable++;
          if (!source) continue;
          tally.reusable++;
          tally.reusableDurationMs += result.durationMs;
          if (result.outcome === 'failed') tally.failed++;
          if (result.outcome === 'flaky') tally.flaky++;
        }
        if (source && result.outcome !== 'passed') {
          const entry = tests.get(key) ?? {
            testCaseId: result.testCaseId,
            browserName: result.browserName,
            failed: 0,
            flaky: 0,
            lastExecutionId: result.executionId,
            sourceExecutionId: source.executionId,
          };
          if (result.outcome === 'failed') entry.failed++;
          else entry.flaky++;
          entry.lastExecutionId = result.executionId;
          entry.sourceExecutionId = source.executionId;
          tests.set(key, entry);
        }
      }
      if (isSource(result)) {
        byVersions.remember(result);
        if (result.ciCommit) remember(byCommit, result.ciCommit, result);
      }
    }
  }

  return {
    total,
    scopes,
    tests: [...tests.values()].sort(
      (a, b) => b.failed + b.flaky - (a.failed + a.flaky) || b.failed - a.failed || a.testCaseId - b.testCaseId,
    ),
  };
}
