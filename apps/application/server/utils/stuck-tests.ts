import { eq } from 'drizzle-orm';
import { resolveBrowserName } from '#shared/browser-name';
import { runningTestHistory, type RunningTestHistory } from '#shared/handlers/stuck-tests';
import { STUCK_FLOOR_MS, stuckAttempt, testStuckEventData } from '#shared/stuck-tests';
import type { DbClient } from '../database';
import { testRuns } from '../database/schema';
import { emitTestStuck } from './notifications/run-notifications';
import { runEventBus } from './run-events';

/** How often the server checks the running tests of its live runs. */
export const STUCK_CHECK_MS = 15_000;

/** A running attempt's test history, read once per attempt, by its begin payload: a retry's begin is another. */
const histories = new WeakMap<object, RunningTestHistory>();
/** How long a run found not running is left unchecked: an interrupted run keeps its running cases, and may revive. */
const NOT_RUNNING_RECHECK_MS = 5 * 60_000;
/** The runs found not running, and when to look at them again. */
const notRunningUntil = new Map<number, number>();

/**
 * Check the running attempts of this server's live runs (`runEventBus`) against `#shared/stuck-tests`, and tell each
 * attempt stuck once: its begin payload carries it (`stuck`, for a page that connects later), the run's stream says it
 * (`test-stuck`), and `test.stuck` goes to the project's notification channels. An attempt that has run less than
 * `STUCK_FLOOR_MS` costs no query; past it, its test's history is read once. Returns how many were found stuck.
 */
export async function checkStuckTests(db: DbClient, now = Date.now()): Promise<number> {
  const entries = [...runEventBus.runningCaseEntries()];
  const live = new Set(entries.map(([runId]) => runId));
  for (const runId of notRunningUntil.keys()) if (!live.has(runId)) notRunningUntil.delete(runId);
  const projectOf = new Map<number, number | null>();
  let found = 0;
  for (const [runId, data] of entries) {
    const startedAt = typeof data.startedAt === 'number' ? data.startedAt : null;
    if (data.stuck || startedAt === null || now - startedAt < STUCK_FLOOR_MS) continue;
    if ((notRunningUntil.get(runId) ?? 0) > now) continue;
    let projectId = projectOf.get(runId);
    if (projectId === undefined) {
      const [run] = await db
        .select({ projectId: testRuns.projectId, status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      projectId = run?.status === 'running' ? run.projectId : null;
      if (projectId === null) notRunningUntil.set(runId, now + NOT_RUNNING_RECHECK_MS);
      else notRunningUntil.delete(runId);
      projectOf.set(runId, projectId);
    }
    if (projectId === null) continue;

    const title = typeof data.title === 'string' ? data.title : '';
    const suitePath = Array.isArray(data.suitePath) ? data.suitePath.filter((s) => typeof s === 'string') : null;
    const browserName = resolveBrowserName(data.browser);
    let history = histories.get(data);
    if (!history) {
      history = await runningTestHistory(db, {
        projectId,
        filePath: typeof data.filePath === 'string' ? data.filePath : '',
        suitePath,
        title,
        browserName,
      });
      histories.set(data, history);
    }
    const stuck = stuckAttempt(now - startedAt, history.passingDurations);
    if (!stuck) continue;

    data.stuck = stuck;
    runEventBus.publish(runId, { type: 'test-stuck', data: testStuckEventData(data, stuck) });
    found++;
    await emitTestStuck(db, runId, {
      testTitle: title,
      ...(suitePath?.length ? { suitePath } : {}),
      ...(typeof data.location === 'string' ? { location: data.location } : {}),
      ...(browserName ? { browserName } : {}),
      ...(typeof data.workerIndex === 'number' ? { workerIndex: data.workerIndex } : {}),
      ...(typeof data.shardIndex === 'number' ? { shardIndex: data.shardIndex } : {}),
      startedAt,
      ...stuck,
      owner: history.owner,
    });
  }
  return found;
}
