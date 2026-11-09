/**
 * The pass reuse forecast of a project, read from the results and the coverage
 * already stored (`#shared/reuse-forecast` holds the rule). Served by
 * `GET /api/projects/:id/selections/reuse-forecast`, its demo mirror and the
 * `get_reuse_forecast` MCP tool.
 */
import { and, desc, eq, gte, inArray, lte, max } from 'drizzle-orm';
import { coverageFragments, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import { resolveCasePayloadContents } from '../../server/utils/case-payloads';
import { parseCoveragePayload } from '../../server/utils/coverage';
import { projectDefaultBranch } from '../../server/utils/scm/stored-default-branch';
import { CI_RUN_ORIGINS, eligibleRunSql } from '../run-eligibility';
import {
  fileVersionId,
  forecastReuse,
  REUSE_FORECAST_MAX_SOURCE_AGE_DAYS,
  REUSE_FORECAST_WINDOW_DAYS,
  REUSE_SCOPES,
  type ForecastResult,
  type ReuseOutcome,
  type ReuseScope,
  type ReuseScopeForecast,
} from '../reuse-forecast';
import { attemptKey, finalAttempts, isFailedStatus } from '../utils/test-counts';
import type { DrizzleDB } from './db';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Attempts the forecast reads at most, from the most recent run back. */
const MAX_ATTEMPTS = 100_000;
/** Tests with identical-code failures the answer lists at most. */
const MAX_LISTED_TESTS = 20;
const ID_CHUNK = 500;
const CI_ORIGINS: ReadonlySet<string> = new Set(CI_RUN_ORIGINS);

export interface ReuseForecastTest {
  testCaseId: number;
  title: string;
  filePath: string;
  /** The Playwright project; '' when unknown. */
  browserName: string;
  /** Results that failed with the code they ran unchanged since a pass. */
  failed: number;
  /** Results that passed only after a failed attempt, with the code unchanged. */
  flaky: number;
  lastExecutionId: number;
  sourceExecutionId: number;
}

export interface ReuseForecast {
  windowDays: number;
  maxSourceAgeDays: number;
  /** Start of the window the counts cover, ISO 8601; later than `windowDays` before `to` when the read was truncated. */
  from: string;
  /** End of the window: the start of the project's latest run, ISO 8601. */
  to: string;
  /** The branch whose results count as `default-branch`. */
  defaultBranch: string;
  total: ReuseScopeForecast;
  scopes: Array<ReuseScopeForecast & { scope: ReuseScope }>;
  /** Tests with identical-code failures, the most such results first. */
  tests: ReuseForecastTest[];
  /** Tests with identical-code failures beyond those listed. */
  moreTests: number;
  /** True when the window held more attempts than the forecast reads, so it covers the most recent runs only. */
  truncated: boolean;
}

interface AttemptRow {
  id: number;
  runId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number | null;
  status: string;
  passedAfterFailure: boolean;
  duration: number | null;
  payloadId: number | null;
  /** When the attempt started, in milliseconds; null from an older reporter. */
  startedAt: number | null;
  startTime: Date;
  branch: string | null;
  commit: string | null;
  origin: string;
}

function outcomeOf(row: AttemptRow): ReuseOutcome | null {
  if (row.status === 'passed') return row.passedAfterFailure ? 'flaky' : 'passed';
  return isFailedStatus(row.status) ? 'failed' : null;
}

/**
 * The file versions each coverage payload names, or null when they cannot be
 * compared. Versions are interned as numbers, and payloads naming the same
 * versions share one set.
 */
async function loadPayloadVersions(
  db: DrizzleDB,
  payloadIds: number[],
): Promise<Map<number, ReadonlySet<number> | null>> {
  const contents = await resolveCasePayloadContents(db, payloadIds);
  const parsed = new Map<number, number[] | null>();
  for (const id of payloadIds) {
    const payload = parseCoveragePayload(contents.get(id));
    parsed.set(id, payload && !payload.incomplete && payload.fragmentIds.length > 0 ? payload.fragmentIds : null);
  }
  // In storage order, so a version's interned number grows with the age of its fragment.
  const fragmentIds = [...new Set([...parsed.values()].flatMap((ids) => ids ?? []))].sort((a, b) => a - b);
  const interned = new Map<string, number>();
  const versions = new Map<number, number | null>();
  for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: coverageFragments.id,
        runtime: coverageFragments.runtime,
        path: coverageFragments.path,
        blob: coverageFragments.blob,
      })
      .from(coverageFragments)
      .where(inArray(coverageFragments.id, fragmentIds.slice(i, i + ID_CHUNK)))
      .orderBy(coverageFragments.id);
    for (const row of rows) {
      if (!row.blob) {
        versions.set(row.id, null);
        continue;
      }
      const key = fileVersionId(row.runtime, row.path, row.blob);
      let version = interned.get(key);
      if (version === undefined) interned.set(key, (version = interned.size));
      versions.set(row.id, version);
    }
  }
  const shared = new Map<string, ReadonlySet<number>>();
  const out = new Map<number, ReadonlySet<number> | null>();
  for (const [payloadId, ids] of parsed) {
    const set: number[] = [];
    for (const id of ids ?? []) {
      const version = versions.get(id);
      if (version == null) break;
      set.push(version);
    }
    if (!ids || set.length < ids.length) {
      out.set(payloadId, null);
      continue;
    }
    const key = [...new Set(set)].sort((a, b) => a - b).join(',');
    let versionSet = shared.get(key);
    if (!versionSet) shared.set(key, (versionSet = new Set(set)));
    out.set(payloadId, versionSet);
  }
  return out;
}

/**
 * How much of a project's recent test time ran code identical to an earlier
 * pass, on its default branch and on the others, and the tests that failed
 * with their code unchanged.
 */
export async function getReuseForecast(
  db: DrizzleDB,
  projectId: number,
  opts: { now?: Date; maxAttempts?: number } = {},
): Promise<ReuseForecast> {
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const projectRuns = and(
    eq(testRuns.projectId, projectId),
    lte(testRuns.startTime, now),
    eligibleRunSql('pass-reuse'),
  );
  // The window ends at the project's latest run, so a project that stopped running still has its last 30 days.
  const [latest] = await db
    .select({ at: max(testRuns.startTime) })
    .from(testRuns)
    .where(projectRuns);
  const end = latest?.at ? new Date(latest.at).getTime() : now.getTime();
  const windowFrom = end - REUSE_FORECAST_WINDOW_DAYS * DAY_MS;
  const maxSourceAgeMs = REUSE_FORECAST_MAX_SOURCE_AGE_DAYS * DAY_MS;

  const fetched: AttemptRow[] = await db
    .select({
      id: testRunsCases.id,
      runId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      retries: testRunsCases.retries,
      status: testRunsCases.status,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      duration: testRunsCases.duration,
      payloadId: testRunsCases.coveragePayloadId,
      startedAt: testRunsCases.startedAt,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
      commit: testRuns.commit,
      origin: testRuns.origin,
    })
    .from(testRuns)
    .innerJoin(testRunsCases, eq(testRunsCases.testRunId, testRuns.id))
    .where(and(projectRuns, gte(testRuns.startTime, new Date(windowFrom - maxSourceAgeMs))))
    .orderBy(desc(testRuns.startTime), desc(testRuns.id), desc(testRunsCases.id))
    .limit(maxAttempts + 1);
  const truncated = fetched.length > maxAttempts;
  // A truncated read keeps whole runs: the last run it reached is dropped, being partly read, unless it is the only one.
  const wholeRuns = truncated ? fetched.filter((row) => row.runId !== fetched[fetched.length - 1]!.runId) : fetched;
  const attempts = wholeRuns.length > 0 ? wholeRuns : fetched.slice(0, maxAttempts);

  const byRun = new Map<number, AttemptRow[]>();
  for (const row of attempts) {
    const rows = byRun.get(row.runId);
    if (rows) rows.push(row);
    else byRun.set(row.runId, [row]);
  }

  // Each result: its final attempt, and the time of all its attempts.
  const results: Array<{ final: AttemptRow; outcome: ReuseOutcome; durationMs: number }> = [];
  for (const rows of byRun.values()) {
    const durations = new Map<string, number>();
    for (const row of rows) durations.set(attemptKey(row), (durations.get(attemptKey(row)) ?? 0) + (row.duration ?? 0));
    for (const final of finalAttempts(rows)) {
      const outcome = outcomeOf(final);
      if (outcome) results.push({ final, outcome, durationMs: durations.get(attemptKey(final)) ?? 0 });
    }
  }

  const defaultBranch = await projectDefaultBranch(db, projectId);
  const payloadIds = [...new Set(results.flatMap((r) => (r.final.payloadId == null ? [] : [r.final.payloadId])))];
  const versions = await loadPayloadVersions(db, payloadIds);

  const forecastResults: ForecastResult[] = results.map(({ final, outcome, durationMs }) => ({
    executionId: final.id,
    runId: final.runId,
    testCaseId: final.testCaseId,
    browserName: final.browserName ?? '',
    at: final.startedAt ?? final.startTime.getTime(),
    scope: !final.branch || final.branch === defaultBranch ? 'default-branch' : 'other-branches',
    outcome,
    durationMs,
    versions: final.payloadId == null ? null : (versions.get(final.payloadId) ?? null),
    ciCommit: final.commit && CI_ORIGINS.has(final.origin) ? final.commit : null,
  }));

  // A truncated read counts the results with a full source window read behind them; when the read is shorter than a
  // source window, the second half of it, whose results have at least the first half behind them.
  const oldest = attempts.length > 0 ? attempts[attempts.length - 1]!.startTime.getTime() : windowFrom;
  const withSources = Math.max(windowFrom, oldest + maxSourceAgeMs);
  const from = truncated
    ? withSources <= end
      ? withSources
      : Math.max(windowFrom, oldest + (end - oldest) / 2)
    : windowFrom;
  const core = forecastReuse(forecastResults, { from, maxSourceAgeMs });

  const listed = core.tests.slice(0, MAX_LISTED_TESTS);
  const caseRows =
    listed.length === 0
      ? []
      : await db
          .select({ id: testCases.id, title: testCases.title, filePath: testCases.filePath })
          .from(testCases)
          .where(
            inArray(
              testCases.id,
              listed.map((t) => t.testCaseId),
            ),
          );
  const cases = new Map(caseRows.map((c) => [c.id, c]));

  return {
    windowDays: REUSE_FORECAST_WINDOW_DAYS,
    maxSourceAgeDays: REUSE_FORECAST_MAX_SOURCE_AGE_DAYS,
    from: new Date(from).toISOString(),
    to: new Date(end).toISOString(),
    defaultBranch,
    total: core.total,
    scopes: REUSE_SCOPES.map((scope) => ({ scope, ...core.scopes[scope] })),
    tests: listed.map((t) => ({
      testCaseId: t.testCaseId,
      title: cases.get(t.testCaseId)?.title ?? '',
      filePath: cases.get(t.testCaseId)?.filePath ?? '',
      browserName: t.browserName,
      failed: t.failed,
      flaky: t.flaky,
      lastExecutionId: t.lastExecutionId,
      sourceExecutionId: t.sourceExecutionId,
    })),
    moreTests: Math.max(0, core.tests.length - listed.length),
    truncated,
  };
}
