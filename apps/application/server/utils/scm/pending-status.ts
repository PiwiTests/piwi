import { eq } from 'drizzle-orm';
import { CI_RUN_ORIGINS, runOrigin } from '#shared/run-eligibility';
import { testRuns } from '../../database/schema';
import { getDatabase, type DbClient } from '../../database';
import type { RunProgressBroadcast } from '../run-events';
import type { RunMetadata } from '../run-json-types';
import { getPrFeedbackSettings } from './pr-feedback-settings';
import { createScmProvider } from './index';
import { normalizeGitUrl } from './git-url';
import type { ScmCommitStatus, ScmProvider } from './ScmProvider';

/**
 * A CI run's pending commit status while it runs: under the context Piwi posts the run's final status with
 * (`prFeedback.status`), `pending` with how far the run is and a link to its page, the first at once and then at most
 * once a minute, the latest tally winning. Where the first one went is kept, so the closing status goes there whatever
 * the settings say later. The run's final status replaces it; every other end closes it with an `error` status saying
 * how the run ended (`closePendingStatus`): a run finished with no final status under that context, cancelled, deleted
 * or interrupted. A run interrupted for its silence may go on, and its pending status with it.
 */

/** The least time between two pending statuses of one run. */
export const PENDING_STATUS_MS = 60_000;

/** How many ended runs are remembered, so a late tally of one posts nothing. */
const ENDED_KEPT = 1000;

/** Where a run's statuses go: its commit, through its project's provider, under the configured context. */
export interface StatusTarget {
  provider: ScmProvider;
  commit: string;
  branch: string | null;
  context: string;
  runUrl: string;
}

interface PendingRun {
  latest: RunProgressBroadcast | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void>;
  /** Where its first pending status went, once one did. */
  target: StatusTarget | null;
}

/** How a pending status is posted: the run's target, or null when the project posts none for it. */
export interface PendingPoster {
  target(runId: number): Promise<StatusTarget | null>;
  post(target: StatusTarget, progress: RunProgressBroadcast): Promise<boolean>;
}

export class PendingStatuses {
  private readonly runs = new Map<number, PendingRun>();
  /** Runs that post no pending status: ended for good, or with no target. */
  private readonly ended = new Set<number>();
  /** Each run's stop under way, so a second caller learns what the first one did. */
  private readonly stopping = new Map<number, Promise<StatusTarget | null>>();

  constructor(
    private readonly poster: PendingPoster,
    private readonly now: () => number = Date.now,
    private readonly everyMs: number = PENDING_STATUS_MS,
  ) {}

  /** A run's tally: its pending status goes now, or once a minute after the last one, with the latest tally. */
  progress(progress: RunProgressBroadcast): void {
    if (this.ended.has(progress.runId)) return;
    let run = this.runs.get(progress.runId);
    if (!run) {
      run = { latest: null, sentAt: -Infinity, timer: null, inFlight: Promise.resolve(), target: null };
      this.runs.set(progress.runId, run);
    }
    run.latest = progress;
    if (run.timer) return;
    const wait = run.sentAt + this.everyMs - this.now();
    if (wait <= 0) return this.send(run);
    run.timer = setTimeout(() => this.send(run), wait);
    run.timer.unref?.();
  }

  /**
   * The run stopped: no pending status of it goes from now on, and the one on its way has arrived when this resolves,
   * with where its pending statuses went (null for none). `forGood` false lets a run interrupted for its silence post
   * again once it goes on. A second stop of the run resolves as the first.
   */
  stop(runId: number, forGood = true): Promise<StatusTarget | null> {
    if (forGood) this.end(runId);
    const under = this.stopping.get(runId);
    if (under) return under;
    const run = this.runs.get(runId);
    if (!run) return Promise.resolve(null);
    this.runs.delete(runId);
    if (run.timer) clearTimeout(run.timer);
    const stopped = run.inFlight.then(() => run.target);
    this.stopping.set(runId, stopped);
    void stopped.finally(() => this.stopping.delete(runId));
    return stopped;
  }

  private end(runId: number): void {
    this.ended.add(runId);
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!);
  }

  private send(run: PendingRun): void {
    run.timer = null;
    const progress = run.latest;
    if (!progress || this.ended.has(progress.runId)) return;
    run.latest = null;
    run.sentAt = this.now();
    run.inFlight = run.inFlight
      .then(async () => {
        const target = run.target ?? (await this.poster.target(progress.runId));
        if (!target) {
          // A run the project posts no status for is let go.
          this.end(progress.runId);
          if (this.runs.get(progress.runId) === run) this.runs.delete(progress.runId);
          return;
        }
        if (await this.poster.post(target, progress)) run.target = target;
      })
      .catch((e) => console.error('[pr-feedback] pending status failed', e));
  }
}

/**
 * The target of a run's commit status, when the project posts one: PR feedback and its status on, the site URL set,
 * the run naming its commit and a repository the project's provider reaches; with `ciOnly`, a CI run alone.
 */
async function statusTarget(db: DbClient, runId: number, ciOnly: boolean): Promise<StatusTarget | null> {
  const settings = await getPrFeedbackSettings(db);
  if (!settings.enabled || !settings.status) return null;
  const siteUrl = process.env.PIWI_SITE_URL?.trim().replace(/\/$/, '');
  if (!siteUrl) return null;
  const [run] = await db
    .select({ projectId: testRuns.projectId, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return null;
  if (ciOnly && !(CI_RUN_ORIGINS as readonly string[]).includes(runOrigin(run.metadata))) return null;
  const meta = (run.metadata as RunMetadata | null) ?? null;
  const commit = meta?.scm?.commit?.trim() || null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  if (!commit || !repositoryUrl) return null;
  const provider = await createScmProvider(repositoryUrl, db, run.projectId);
  if (!provider) return null;
  return {
    provider,
    commit,
    branch: meta?.scm?.branch?.trim() || null,
    context: settings.statusContext,
    runUrl: `${siteUrl}/test-runs/${runId}`,
  };
}

/**
 * What a pending status says: how many of the run's tests have a result, at most its total (its retries count again
 * until the run ends), or how many results came while the total is unknown, and how many results failed.
 */
export function pendingStatusDescription(progress: RunProgressBroadcast): string {
  const results = progress.passedTests + progress.failedTests + progress.skippedTests + progress.didNotRunTests;
  const total = Math.max(0, progress.totalTests);
  const done = total > 0 ? `${Math.min(results, total)} of ${total} tests` : `${results} done`;
  const failed = progress.failedTests > 0 ? `, ${progress.failedTests} failed` : '';
  return `Running: ${done}${failed}`.slice(0, 140);
}

/** What a closing status says of a run that ended with no final status. */
export function closingStatusDescription(runId: number, status: string | null): string {
  if (status === 'cancelled') return `Run #${runId} was cancelled before it ended`;
  if (status === 'interrupted') return `Run #${runId} was interrupted before it ended`;
  if (status === null) return `Run #${runId} was deleted before it ended`;
  return `Run #${runId} ended with no result to report`;
}

/** The instance's pending statuses, fed by the run-progress bus (`server/plugins/pending-pr-status.ts`). */
export const pendingStatuses = new PendingStatuses({
  target: async (runId) => statusTarget(await getDatabase(), runId, true),
  post: (target, progress) =>
    target.provider.postCommitStatus(target.commit, {
      state: 'pending',
      description: pendingStatusDescription(progress),
      targetUrl: target.runUrl,
      context: target.context,
      ref: target.branch,
    }),
});

/** Post a run's closing `error` status at `target`, saying how the run ended (`status`, null for a deleted run). */
export async function postClosingStatus(target: StatusTarget, runId: number, status: string | null): Promise<void> {
  const posted: Omit<ScmCommitStatus, 'ref'> = {
    state: 'error',
    description: closingStatusDescription(runId, status),
    targetUrl: target.runUrl,
    context: target.context,
  };
  await target.provider.postCommitStatus(target.commit, { ...posted, ref: target.branch });
}

/**
 * A run ended with no final status to replace its pending one (`status`: how; null for a deleted run): its pending
 * statuses stop, and when one went out, a closing `error` status takes its place. A run interrupted for its silence
 * (`forGood` false) may post pending statuses again once it goes on.
 */
export async function closePendingStatus(runId: number, status: string | null, forGood = true): Promise<void> {
  const target = await pendingStatuses.stop(runId, forGood);
  if (target) await postClosingStatus(target, runId, status);
}

/** The run's status as stored, null once it is gone. */
export async function storedRunStatus(db: DbClient, runId: number): Promise<string | null> {
  const [run] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, runId));
  return run?.status ?? null;
}
