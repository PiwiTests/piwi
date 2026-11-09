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
import { eligibleRunSql } from '../run-eligibility';
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
import { isFailedStatus } from '../utils/test-counts';
import type { DrizzleDB } from './db';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Attempts the forecast reads at most, the most recent first. */
const MAX_ATTEMPTS = 100_000;
/** Tests with identical-code failures the answer lists at most. */
const MAX_LISTED_TESTS = 20;
const ID_CHUNK = 500;

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
  /** End of the window: the project's latest result, ISO 8601. */
  to: string;
  /** The branch whose results count as `default-branch`. */
  defaultBranch: string;
  total: ReuseScopeForecast;
  scopes: Array<ReuseScopeForecast & { scope: ReuseScope }>;
  /** Tests with identical-code failures, the most such results first. */
  tests: ReuseForecastTest[];
  /** Tests with identical-code failures beyond those listed. */
  moreTests: number;
  /** True when the window held more attempts than the forecast reads, so it covers the most recent ones only. */
  truncated: boolean;
}

interface AttemptRow {
  id: number;
  runId: number;
  testCaseId: number;
  browserName: string | null;
  repeatEachIndex: number;
  retries: number | null;
  finalAttempt: boolean;
  status: string;
  passedAfterFailure: boolean;
  duration: number | null;
  createdAt: Date;
  payloadId: number | null;
  branch: string | null;
}

function outcomeOf(row: AttemptRow): ReuseOutcome | null {
  if (row.status === 'passed') return row.passedAfterFailure ? 'flaky' : 'passed';
  return isFailedStatus(row.status) ? 'failed' : null;
}

/** The file versions each coverage payload names, or null when they cannot be compared. */
async function loadPayloadVersions(
  db: DrizzleDB,
  payloadIds: number[],
): Promise<Map<number, ReadonlySet<string> | null>> {
  const contents = await resolveCasePayloadContents(db, payloadIds);
  const parsed = new Map<number, number[] | null>();
  for (const id of payloadIds) {
    const payload = parseCoveragePayload(contents.get(id));
    parsed.set(id, payload && !payload.incomplete && payload.fragmentIds.length > 0 ? payload.fragmentIds : null);
  }
  const fragmentIds = [...new Set([...parsed.values()].flatMap((ids) => ids ?? []))];
  const versions = new Map<number, string | null>();
  for (let i = 0; i < fragmentIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({
        id: coverageFragments.id,
        runtime: coverageFragments.runtime,
        path: coverageFragments.path,
        blob: coverageFragments.blob,
      })
      .from(coverageFragments)
      .where(inArray(coverageFragments.id, fragmentIds.slice(i, i + ID_CHUNK)));
    for (const row of rows) versions.set(row.id, row.blob ? fileVersionId(row.runtime, row.path, row.blob) : null);
  }
  const out = new Map<number, ReadonlySet<string> | null>();
  for (const [payloadId, ids] of parsed) {
    if (!ids) {
      out.set(payloadId, null);
      continue;
    }
    const set = new Set<string>();
    let comparable = true;
    for (const id of ids) {
      const version = versions.get(id);
      if (!version) {
        comparable = false;
        break;
      }
      set.add(version);
    }
    out.set(payloadId, comparable ? set : null);
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
  opts: { now?: Date } = {},
): Promise<ReuseForecast> {
  const now = opts.now?.getTime() ?? Date.now();
  const projectResults = and(
    eq(testRuns.projectId, projectId),
    lte(testRunsCases.createdAt, new Date(now)),
    eligibleRunSql('pass-reuse'),
  );
  // The window ends at the project's latest result, so a project that stopped running still has its last 30 days.
  const [latest] = await db
    .select({ at: max(testRunsCases.createdAt) })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(projectResults);
  const end = latest?.at ? new Date(latest.at).getTime() : now;
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
      finalAttempt: testRunsCases.finalAttempt,
      status: testRunsCases.status,
      passedAfterFailure: testRunsCases.passedAfterFailure,
      duration: testRunsCases.duration,
      createdAt: testRunsCases.createdAt,
      payloadId: testRunsCases.coveragePayloadId,
      branch: testRuns.branch,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(and(projectResults, gte(testRunsCases.createdAt, new Date(windowFrom - maxSourceAgeMs))))
    .orderBy(desc(testRunsCases.id))
    .limit(MAX_ATTEMPTS + 1);
  const truncated = fetched.length > MAX_ATTEMPTS;
  const attempts = truncated ? fetched.slice(0, MAX_ATTEMPTS) : fetched;

  // One result per run, test, Playwright project and repetition: its final attempt, and the time of all its attempts.
  const results = new Map<string, { final: AttemptRow; durationMs: number }>();
  for (const row of attempts) {
    const key = `${row.runId}\x00${row.testCaseId}\x00${row.browserName ?? ''}\x00${row.repeatEachIndex}`;
    const entry = results.get(key);
    if (!entry) {
      results.set(key, { final: row, durationMs: row.duration ?? 0 });
      continue;
    }
    entry.durationMs += row.duration ?? 0;
    const isLater =
      (row.finalAttempt && !entry.final.finalAttempt) ||
      (row.finalAttempt === entry.final.finalAttempt && (row.retries ?? 0) > (entry.final.retries ?? 0));
    if (isLater) entry.final = row;
  }

  const defaultBranch = await projectDefaultBranch(db, projectId);
  const payloadIds = [
    ...new Set([...results.values()].flatMap((r) => (r.final.payloadId == null ? [] : [r.final.payloadId]))),
  ];
  const versions = await loadPayloadVersions(db, payloadIds);

  const forecastResults: ForecastResult[] = [];
  for (const { final, durationMs } of results.values()) {
    const outcome = outcomeOf(final);
    if (!outcome) continue;
    forecastResults.push({
      executionId: final.id,
      runId: final.runId,
      testCaseId: final.testCaseId,
      browserName: final.browserName ?? '',
      at: final.createdAt.getTime(),
      scope: !final.branch || final.branch === defaultBranch ? 'default-branch' : 'other-branches',
      outcome,
      durationMs,
      versions: final.payloadId == null ? null : (versions.get(final.payloadId) ?? null),
    });
  }

  // A truncated read covers the window from its oldest attempt on.
  const oldest = attempts.length > 0 ? attempts[attempts.length - 1]!.createdAt.getTime() : windowFrom;
  const from = truncated ? Math.max(windowFrom, oldest) : windowFrom;
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
