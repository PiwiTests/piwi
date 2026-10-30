import { eq } from 'drizzle-orm';
import { resolveBrowserName } from '#shared/browser-name';
import { runningTestHistory, type RunningTestHistory } from '#shared/handlers/stuck-tests';
import { STUCK_FLOOR_MS, stuckAttempt, testStuckEventData } from '#shared/stuck-tests';
import { projects } from '~~/server/database/schema';
import { runningCaseKey } from '~~/server/utils/inserted-run-cases';
import type { getDemoDb } from '../db.client';
import { publishDemoNotificationEvent, publishDemoRunEvent } from '../run-events';

/**
 * The demo's stuck check, the server's (`server/utils/stuck-tests.ts`) on the demo's terms: the demo has no timer and
 * its simulator runs on a virtual clock, so each batch of a run's events checks the run's running tests at the latest
 * time its events reached. The rule and the history it reads are the server's (`#shared/stuck-tests`,
 * `#shared/handlers/stuck-tests`).
 */

type DemoDb = Awaited<ReturnType<typeof getDemoDb>>;

interface DemoAttempt {
  begin: Record<string, unknown>;
  startedAt: number;
  history?: RunningTestHistory;
  stuck: boolean;
}

/** Each live demo run's running tests, the latest time its events reached, and whether a check of it is under way. */
interface DemoRun {
  now: number;
  attempts: Map<string, DemoAttempt>;
  checking: boolean;
}
const runs = new Map<number, DemoRun>();

function runOf(runId: number): DemoRun {
  let run = runs.get(runId);
  if (!run) {
    run = { now: 0, attempts: new Map(), checking: false };
    runs.set(runId, run);
  }
  return run;
}

/** A test of the run began: its begin payload, as the run page reads it. */
export function noteDemoBegin(runId: number, begin: Record<string, unknown>): void {
  if (typeof begin.startedAt !== 'number') return;
  runOf(runId).attempts.set(runningCaseKey(begin as Parameters<typeof runningCaseKey>[0]), {
    begin,
    startedAt: begin.startedAt,
    stuck: false,
  });
}

/** A test of the run completed. */
export function noteDemoComplete(runId: number, tc: Parameters<typeof runningCaseKey>[0]): void {
  runs.get(runId)?.attempts.delete(runningCaseKey(tc));
}

/** The run ended: its running tests are forgotten. */
export function forgetDemoRun(runId: number): void {
  runs.delete(runId);
}

/**
 * Check the run's running tests at the latest time its events reached, `events` included, and tell each one stuck
 * once: on the run's stream (`test-stuck`) and as a `test.stuck` notification.
 */
export async function checkDemoStuckTests(
  db: DemoDb,
  run: { id: number; projectId: number },
  events: ReadonlyArray<{ startedAt?: unknown; duration?: unknown }>,
): Promise<void> {
  const state = runs.get(run.id);
  if (!state) return;
  for (const event of events) {
    if (typeof event.startedAt !== 'number') continue;
    state.now = Math.max(state.now, event.startedAt + (typeof event.duration === 'number' ? event.duration : 0));
  }
  // The service worker answers posts at once: one check of a run at a time, the next one sees what it told.
  if (state.checking) return;
  state.checking = true;
  try {
    await checkAttempts(db, run, state);
  } finally {
    state.checking = false;
  }
}

async function checkAttempts(db: DemoDb, run: { id: number; projectId: number }, state: DemoRun): Promise<void> {
  for (const attempt of state.attempts.values()) {
    const elapsedMs = state.now - attempt.startedAt;
    if (attempt.stuck || elapsedMs < STUCK_FLOOR_MS) continue;
    const { begin } = attempt;
    const title = typeof begin.title === 'string' ? begin.title : '';
    const browserName = resolveBrowserName(begin.browser);
    attempt.history ??= await runningTestHistory(db, {
      projectId: run.projectId,
      filePath: typeof begin.filePath === 'string' ? begin.filePath : '',
      suitePath: Array.isArray(begin.suitePath) ? begin.suitePath : null,
      title,
      browserName,
    });
    const stuck = stuckAttempt(elapsedMs, attempt.history.passingDurations);
    if (!stuck) continue;
    attempt.stuck = true;
    publishDemoRunEvent(run.id, { type: 'test-stuck', data: testStuckEventData(begin, stuck) });
    const [project] = await db
      .select({ name: projects.name, label: projects.label })
      .from(projects)
      .where(eq(projects.id, run.projectId));
    publishDemoNotificationEvent({
      type: 'test.stuck',
      runId: run.id,
      projectId: run.projectId,
      projectName: project?.label || project?.name,
      testTitle: title,
      location: begin.location ?? undefined,
      browserName: browserName ?? undefined,
      startedAt: attempt.startedAt,
      ...stuck,
    });
  }
}
