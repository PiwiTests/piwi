import type { H3Event } from 'h3';
import { and, eq } from 'drizzle-orm';
import { getDatabase } from '../../../database';
import { testCases, testRuns, testRunsCases } from '../../../database/schema';
import { getCurrentUser, isAuthEnabled } from '../../../utils/auth';
import { canAccessProject } from '../../../utils/project-access';
import { FAILED_STATUS_KEYS } from '#shared/utils/test-counts';

/**
 * Resolve an execution from what the reporter knows before the server assigns
 * ids, and redirect to its page: the run id plus the test's spec file, title,
 * retry, Playwright project and `--repeat-each` repetition (`repeat`, absent
 * for the first). The reporter prints these links the moment a test fails, in
 * streaming and batch mode alike, so the link has to be computable without
 * waiting for an execution id.
 *
 * `retry`, `browser` and `repeat` are preferences, not filters: when the exact
 * attempt is missing (a retry that was never persisted, a project name that
 * changed) the closest execution of the same test still resolves rather than
 * 404ing.
 */
export default eventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');
  setResponseHeader(event, 'X-Robots-Tag', 'noindex, nofollow');

  const runId = Number.parseInt(getRouterParam(event, 'id') ?? '', 10);
  const query = getQuery(event);
  const file = queryString(query.file);
  const title = queryString(query.title);
  const retry = queryString(query.retry);
  const browser = queryString(query.browser);
  const repeat = queryString(query.repeat);
  const wantedRetry = retry !== null && /^\d+$/.test(retry) ? Number(retry) : null;
  const wantedRepeat = repeat !== null && /^\d+$/.test(repeat) ? Number(repeat) : 0;

  if (!Number.isInteger(runId) || runId <= 0 || !file || !title) {
    return notFoundPage(event, 'This link is missing the run, spec file or test title it should point at.', null);
  }

  if (isAuthEnabled(event) && !(await getCurrentUser(event))) {
    const url = getRequestURL(event);
    return sendRedirect(event, `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const db = await getDatabase();
  const [run] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  const user = isAuthEnabled(event) ? await getCurrentUser(event) : null;
  if (!run || !(await canAccessProject(db, user, run.projectId))) {
    return notFoundPage(event, `Run #${runId} does not exist, or it was deleted.`, null);
  }

  const candidates = await db
    .select({
      id: testRunsCases.id,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      browserName: testRunsCases.browserName,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(and(eq(testRunsCases.testRunId, runId), eq(testCases.filePath, file), eq(testCases.title, title)));

  const match = pickExecution(candidates, wantedRetry, browser, wantedRepeat);
  if (!match) {
    return notFoundPage(event, `Run #${runId} has no execution of "${title}" in ${file}.`, runId);
  }

  return sendRedirect(event, `/test-run-cases/${match.id}`);
});

interface Candidate {
  id: number;
  status: string;
  retries: number | null;
  repeatEachIndex?: number;
  browserName: string | null;
}

/**
 * The best execution for the requested attempt: the exact project, repetition
 * and retry when persisted, otherwise the failing one, otherwise the latest
 * attempt.
 */
export function pickExecution(
  candidates: Candidate[],
  retry: number | null,
  browser: string | null,
  repeat = 0,
): Candidate | null {
  const failed = new Set<string>(FAILED_STATUS_KEYS);
  const score = (c: Candidate): number[] => [
    browser !== null && c.browserName === browser ? 1 : 0,
    (c.repeatEachIndex ?? 0) === repeat ? 1 : 0,
    retry !== null && (c.retries ?? 0) === retry ? 1 : 0,
    failed.has(c.status) ? 1 : 0,
    c.retries ?? 0,
    c.id,
  ];
  let best: Candidate | null = null;
  let bestScore: number[] = [];
  for (const candidate of candidates) {
    const s = score(candidate);
    if (!best || compareScores(s, bestScore) > 0) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function queryString(value: unknown): string | null {
  if (Array.isArray(value)) value = value[0];
  return typeof value === 'string' && value !== '' ? value : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A readable 404 for someone who followed a link from a terminal or a CI log. */
function notFoundPage(event: H3Event, reason: string, runId: number | null): string {
  setResponseStatus(event, 404);
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');
  const runLink = runId ? `<p><a href="/test-runs/${runId}">Open run #${runId}</a> and find the test there.</p>` : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Test not found</title></head>' +
    '<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 36rem; text-align: center;">' +
    '<h1>Piwi could not find that test</h1>' +
    `<p>${escapeHtml(reason)}</p>` +
    `<p>The run may not have finished uploading yet, or its results may have been pruned by retention.</p>${runLink}` +
    '</body></html>'
  );
}
