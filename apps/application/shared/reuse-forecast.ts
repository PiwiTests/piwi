/**
 * The pass reuse forecast: how many of a project's recent test results ran
 * code identical to an earlier pass, and how many of those failed anyway.
 *
 * A result is **reusable** when an earlier result of the same test, in the
 * same Playwright project and another run, passed on its first attempt, at
 * most `maxSourceAgeMs` before it, and every file version that pass's
 * coverage recorded (runtime, path, git blob) is among the versions the
 * result's own coverage recorded: the code the pass ran had not changed. A
 * reusable result that failed, or passed only on a retry, failed with the
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
  /** When it ran, in milliseconds. */
  at: number;
  scope: ReuseScope;
  outcome: ReuseOutcome;
  /** The summed duration of its attempts, in milliseconds. */
  durationMs: number;
  /**
   * The file versions its coverage recorded, as `fileVersionId` keys; null when
   * they cannot be compared: no coverage, incomplete coverage, or a file
   * without its blob.
   */
  versions: ReadonlySet<string> | null;
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

/** The key of a file version in a result's `versions`. */
export function fileVersionId(runtime: string, path: string, blob: string): string {
  return `${runtime}\x00${path}\x00${blob}`;
}

function emptyScope(): ReuseScopeForecast {
  return { results: 0, comparable: 0, reusable: 0, durationMs: 0, reusableDurationMs: 0, failed: 0, flaky: 0 };
}

function isSubset(source: ReadonlySet<string>, result: ReadonlySet<string>): boolean {
  for (const version of source) if (!result.has(version)) return false;
  return true;
}

/** Whether a result may stand in for a later one: a first-attempt pass whose coverage can be compared. */
function isSource(result: ForecastResult): boolean {
  return result.outcome === 'passed' && result.versions != null && result.versions.size > 0;
}

/**
 * Forecast reuse over `results`: those from `from` on are counted, the earlier
 * ones serve only as passes for them. Each result is compared with the most
 * recent qualifying pass of its test and Playwright project in another run.
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

  const groups = new Map<string, ForecastResult[]>();
  for (const result of results) {
    const key = `${result.testCaseId}\x00${result.browserName}`;
    const group = groups.get(key);
    if (group) group.push(result);
    else groups.set(key, [result]);
  }

  for (const [key, group] of groups) {
    group.sort((a, b) => a.at - b.at || a.executionId - b.executionId);
    // The most recent source, and the most recent one of a run other than its run.
    let latest: ForecastResult | null = null;
    let latestOtherRun: ForecastResult | null = null;
    for (const result of group) {
      if (result.at >= opts.from) {
        const source = latest && latest.runId === result.runId ? latestOtherRun : latest;
        const comparable = result.versions != null && result.versions.size > 0;
        const reusable =
          comparable &&
          source != null &&
          result.at - source.at <= opts.maxSourceAgeMs &&
          isSubset(source.versions!, result.versions!);
        for (const tally of [total, scopes[result.scope]]) {
          tally.results++;
          tally.durationMs += result.durationMs;
          if (comparable) tally.comparable++;
          if (!reusable) continue;
          tally.reusable++;
          tally.reusableDurationMs += result.durationMs;
          if (result.outcome === 'failed') tally.failed++;
          if (result.outcome === 'flaky') tally.flaky++;
        }
        if (reusable && result.outcome !== 'passed') {
          const entry = tests.get(key) ?? {
            testCaseId: result.testCaseId,
            browserName: result.browserName,
            failed: 0,
            flaky: 0,
            lastExecutionId: result.executionId,
            sourceExecutionId: source!.executionId,
          };
          if (result.outcome === 'failed') entry.failed++;
          else entry.flaky++;
          entry.lastExecutionId = result.executionId;
          entry.sourceExecutionId = source!.executionId;
          tests.set(key, entry);
        }
      }
      if (isSource(result)) {
        if (!latest || latest.runId !== result.runId) latestOtherRun = latest;
        latest = result;
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
