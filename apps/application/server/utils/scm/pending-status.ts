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
 * once a minute, the latest tally winning. The run's final status replaces it; a run that ends without one (cancelled,
 * interrupted, an environment incident, a run the final feedback leaves out) gets a closing `error` status instead
 * (`closePendingStatus`), so no commit stays pending.
 */

/** The least time between two pending statuses of one run. */
export const PENDING_STATUS_MS = 60_000;

/** How many ended runs are remembered, so a late tally of one posts nothing. */
const ENDED_KEPT = 1000;

interface PendingRun {
  latest: RunProgressBroadcast | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void>;
  posted: boolean;
}

export class PendingStatuses {
  private readonly runs = new Map<number, PendingRun>();
  private readonly ended = new Set<number>();

  constructor(
    private readonly post: (progress: RunProgressBroadcast) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly everyMs: number = PENDING_STATUS_MS,
  ) {}

  /** A run's tally: its pending status goes now, or once a minute after the last one, with the latest tally. */
  progress(progress: RunProgressBroadcast): void {
    if (this.ended.has(progress.runId)) return;
    let run = this.runs.get(progress.runId);
    if (!run) {
      run = { latest: null, sentAt: -Infinity, timer: null, inFlight: Promise.resolve(), posted: false };
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
   * The run ended: no pending status of it goes from now on, and the one on its way has arrived when this resolves.
   * True when one of them went out.
   */
  async stop(runId: number): Promise<boolean> {
    this.ended.add(runId);
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!);
    const run = this.runs.get(runId);
    if (!run) return false;
    this.runs.delete(runId);
    if (run.timer) clearTimeout(run.timer);
    await run.inFlight;
    return run.posted;
  }

  private send(run: PendingRun): void {
    run.timer = null;
    const progress = run.latest;
    if (!progress || this.ended.has(progress.runId)) return;
    run.latest = null;
    run.sentAt = this.now();
    run.inFlight = run.inFlight
      .then(() => this.post(progress))
      .then((posted) => {
        if (posted) run.posted = true;
      })
      .catch((e) => console.error('[pr-feedback] pending status failed', e));
  }
}

/** Where a run's statuses go: its commit, through its project's provider, under the configured context. */
interface StatusTarget {
  provider: ScmProvider;
  commit: string;
  branch: string | null;
  context: string;
  runUrl: string;
}

/**
 * The target of a CI run's commit status, when the project posts one: PR feedback and its status on, the site URL
 * set, the run naming its commit and a repository the project's provider reaches.
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

/** What a pending status says: how many of the run's tests ended, and how many failed. */
export function pendingStatusDescription(progress: RunProgressBroadcast): string {
  const done = progress.passedTests + progress.failedTests + progress.skippedTests + progress.didNotRunTests;
  const failed = progress.failedTests > 0 ? `, ${progress.failedTests} failed` : '';
  return `Running: ${done} of ${progress.totalTests} tests${failed}`.slice(0, 140);
}

/** What a closing status says of a run that ended with no final status. */
export function closingStatusDescription(runId: number, status: string | null): string {
  if (status === 'cancelled') return `Run #${runId} was cancelled before it ended`;
  if (status === 'interrupted') return `Run #${runId} was interrupted before it ended`;
  return `Run #${runId} ended with no result to report`;
}

async function postStatus(target: StatusTarget, status: Omit<ScmCommitStatus, 'context' | 'ref'>): Promise<boolean> {
  return target.provider.postCommitStatus(target.commit, { ...status, context: target.context, ref: target.branch });
}

/** Post a CI run's pending status with its tally. False when the project posts none for the run. */
async function postPendingStatus(progress: RunProgressBroadcast): Promise<boolean> {
  const db = await getDatabase();
  const target = await statusTarget(db, progress.runId, true);
  if (!target) return false;
  return postStatus(target, {
    state: 'pending',
    description: pendingStatusDescription(progress),
    targetUrl: target.runUrl,
  });
}

/** The instance's pending statuses, fed by the run-progress bus (`server/plugins/pending-pr-status.ts`). */
export const pendingStatuses = new PendingStatuses(postPendingStatus);

/**
 * A run ended with no final status to replace its pending one: when a pending status went out, a closing `error`
 * status takes its place, saying how the run ended.
 */
export async function closePendingStatus(db: DbClient, runId: number): Promise<void> {
  if (await pendingStatuses.stop(runId)) await postClosingStatus(db, runId);
}

/** The closing `error` status of a run whose pending status went out and that ended with no final status. */
export async function postClosingStatus(db: DbClient, runId: number): Promise<void> {
  const target = await statusTarget(db, runId, false);
  if (!target) return;
  const [run] = await db.select({ status: testRuns.status }).from(testRuns).where(eq(testRuns.id, runId));
  await postStatus(target, {
    state: 'error',
    description: closingStatusDescription(runId, run?.status ?? null),
    targetUrl: target.runUrl,
  });
}
