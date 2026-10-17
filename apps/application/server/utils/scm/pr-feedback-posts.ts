/**
 * The pull-request feedback record: one row per run that reached its pull
 * request or commit, naming the host, the pull request, Piwi's comment and
 * every commit status context the host accepted. Written by
 * `postRunPrFeedback` and by the gate's commit status; Setup reads it to mark
 * pull-request feedback active.
 */
import { eq } from 'drizzle-orm';
import { prFeedbackPosts } from '../../database/schema';
import { detectScmHost } from '#shared/scm-urls';
import type { DbClient } from '../../database';
import type { VerifiedFix } from '../fix-verification';

export interface PrFeedbackPostInput {
  projectId: number;
  runId: number;
  repositoryUrl: string;
  prNumber?: number | null;
  commentId?: string | null;
  /** Commit status contexts the host accepted. */
  statuses?: string[];
  /** The clusters the comment reported fixed; kept when this post names none. */
  fixes?: VerifiedFix[];
}

export interface PrFeedbackPost {
  runId: number;
  provider: string;
  repositoryUrl: string;
  prNumber: number | null;
  commentId: string | null;
  statuses: string[];
  /** The clusters the run verified as fixed, as its comment reported them. */
  fixes: VerifiedFix[];
}

/** A run's pull-request number from its SCM metadata, when the CI provider exposed one. */
export function runPrNumber(metadata: unknown): number | null {
  const raw = (metadata as { scm?: { prNumber?: unknown } | null } | null)?.scm?.prNumber;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The feedback record of a run, or null when nothing was posted for it. */
export async function readPrFeedbackPost(db: DbClient, runId: number): Promise<PrFeedbackPost | null> {
  const [row] = await db.select().from(prFeedbackPosts).where(eq(prFeedbackPosts.runId, runId));
  if (!row) return null;
  return {
    runId: row.runId,
    provider: row.provider,
    repositoryUrl: row.repositoryUrl,
    prNumber: row.prNumber ?? null,
    commentId: row.commentId ?? null,
    statuses: Array.isArray(row.statuses) ? (row.statuses as string[]) : [],
    fixes: Array.isArray(row.fixes) ? (row.fixes as VerifiedFix[]) : [],
  };
}

/**
 * Record what was posted for a run, merged into its existing record: the
 * status contexts add up, and a pull request or comment id already known is
 * kept when this post names none.
 */
export async function recordPrFeedbackPost(db: DbClient, input: PrFeedbackPostInput): Promise<void> {
  const existing = await readPrFeedbackPost(db, input.runId);
  const statuses = [...new Set([...(existing?.statuses ?? []), ...(input.statuses ?? [])])];
  const prNumber = input.prNumber ?? existing?.prNumber ?? null;
  const commentId = input.commentId ?? existing?.commentId ?? null;
  const fixes = input.fixes ?? existing?.fixes ?? null;
  const now = new Date();
  if (existing) {
    await db
      .update(prFeedbackPosts)
      .set({ prNumber, commentId, statuses, fixes, updatedAt: now })
      .where(eq(prFeedbackPosts.runId, input.runId));
    return;
  }
  await db
    .insert(prFeedbackPosts)
    .values({
      projectId: input.projectId,
      runId: input.runId,
      provider: detectScmHost(input.repositoryUrl) ?? 'other',
      repositoryUrl: input.repositoryUrl,
      prNumber,
      commentId,
      statuses,
      fixes,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: prFeedbackPosts.runId,
      set: { prNumber, commentId, statuses, fixes, updatedAt: now },
    });
}
