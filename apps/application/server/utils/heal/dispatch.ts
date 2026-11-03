/**
 * Turn queued heal actions into pull requests.
 *
 * `applyHealAction` is the provider sequence — adopt an existing PR, guard every
 * edit against the current file, create the branch, commit, open the PR — with
 * no database, so it is unit-testable against a fake provider. `sweepHealActions`
 * is the durable orchestration around it, mirroring the notifications outbox:
 * bounded attempts, progressive backoff, and every failure recorded on the row
 * (provider writes throw with their own message rather than swallowing it). An
 * opened PR records the `auto-heal-pr` hand-back as `suggested`.
 *
 * Idempotency is layered: the unique dedupe key stops duplicate actions, PR
 * adoption stops duplicate PRs, and `applyLineEdit`'s already-applied result
 * makes re-running an action a no-op once its commit has landed.
 */
import { and, eq, inArray, lt, lte } from 'drizzle-orm';
import { healActions, projects } from '../../database/schema';
import { createScmProvider } from '../scm';
import { emitNotification } from '../notifications/emit';
import { recordOutcome } from '../outcomes';
import { getAutoHealSettings, resolveHealSiteUrl } from './settings';
import { applyLineEdit } from '#shared/heal-edit';
import { buildHealPrBody, buildHealPrTitle } from '#shared/heal-pr';
import { HEAL_COMMIT_TRAILER } from '#shared/commit-trailers';
import type { HealActionPayload, HealActionResult } from '#shared/auto-heal';
import type { ScmProvider, ScmFileEdit } from '../scm/ScmProvider';
import type { DbClient } from '../../database';
import {
  claimOutboxRows,
  failAbandonedOutboxRows,
  nextAttempt,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_SWEEPABLE_STATUSES,
} from '../outbox';

const MAX_ATTEMPTS = OUTBOX_MAX_ATTEMPTS;

export type ApplyOutcome = { status: 'opened'; result: HealActionResult } | { status: 'skipped'; reason: string };

/**
 * Run one heal action against a provider. Throws on any provider write failure
 * (the caller records the message and retries); returns `skipped` only when
 * there is genuinely nothing to open.
 */
export async function applyHealAction(
  provider: ScmProvider,
  action: { dedupeKey: string; payload: HealActionPayload },
  siteUrl: string | null,
): Promise<ApplyOutcome> {
  const p = action.payload;

  const baseHead = await provider.getBranchHead(p.baseBranch);
  if (!baseHead) throw new Error(`base branch '${p.baseBranch}' not found`);
  const branchHead = await provider.getBranchHead(p.branch);
  const existing = await provider.findPullRequestForBranch(p.branch);

  // Head-content guard: rebuild each file from what the repo has right now, so a
  // drifted line is dropped rather than mis-patched. Read at the resolved commit
  // SHA (the heal branch's once it exists — a prior attempt may have committed
  // there — else the base's). A SHA is immutable, so the file cache can never
  // serve pre-write content on a retry.
  const ref = branchHead ?? baseHead;
  const byFile = new Map<string, HealActionPayload['edits']>();
  for (const e of p.edits) {
    const list = byFile.get(e.filePath);
    if (list) list.push(e);
    else byFile.set(e.filePath, [e]);
  }

  const toWrite: ScmFileEdit[] = [];
  let dropped = 0;
  for (const [path, edits] of byFile) {
    const file = await provider.fetchFileAtRef(path, ref);
    if (!file || file.truncated) {
      dropped += edits.length;
      continue;
    }
    let content = file.content;
    let changed = false;
    for (const e of edits) {
      const r = applyLineEdit(content, { line: e.line, oldLine: e.oldLine, newLine: e.newLine });
      if (r.kind === 'applied') {
        content = r.content;
        changed = true;
      } else if (r.kind === 'stale') {
        dropped++;
      }
      // 'already-applied' — the file already carries the fix; nothing to write.
    }
    if (changed) toWrite.push({ path, content });
  }

  const openPr = async (commitSha: string): Promise<ApplyOutcome> => {
    const pr =
      existing ??
      (await provider.createPullRequest({
        title: buildHealPrTitle(p),
        body: buildHealPrBody(p, siteUrl),
        head: p.branch,
        base: p.baseBranch,
        draft: p.draft,
      }));
    return {
      status: 'opened',
      result: { prNumber: pr.number, prUrl: pr.url, commitSha, branch: p.branch, droppedEdits: dropped },
    };
  };

  // Nothing new to write: either a prior attempt already committed (open/adopt
  // the PR), or every edit was stale/already-applied upstream (nothing to do).
  if (toWrite.length === 0) {
    const branchHasWork = branchHead != null && branchHead !== baseHead;
    if (existing || branchHasWork) return openPr(branchHead ?? baseHead);
    return { status: 'skipped', reason: dropped > 0 ? 'all edits were stale' : 'all edits were already applied' };
  }

  if (!branchHead) await provider.createBranch(p.branch, baseHead);
  const message = `${p.commitMessage}\n\n${HEAL_COMMIT_TRAILER}: ${action.dedupeKey}`;
  const commitSha = await provider.commitFiles(p.branch, message, toWrite);
  return openPr(commitSha);
}

/**
 * Process queued heal actions that are due now, including a claimed one whose
 * lease ran out. Each is claimed first and skipped when another sweep holds it;
 * one whose last allowed attempt never finished is given up first. Mirrors the
 * notifications sweeper.
 */
export async function sweepHealActions(db: DbClient): Promise<{ opened: number; failed: number; skipped: number }> {
  const now = new Date();
  let opened = 0;
  let failed = await failAbandonedOutboxRows(db, healActions, { updatedAt: now });
  let skipped = 0;

  const settings = await getAutoHealSettings(db);
  // A master-switch flip to off should stop pending actions from firing.
  if (!settings.enabled) return { opened, failed, skipped };

  const siteUrl = resolveHealSiteUrl();
  const due = await db
    .select()
    .from(healActions)
    .where(
      and(
        inArray(healActions.status, OUTBOX_SWEEPABLE_STATUSES),
        lte(healActions.scheduledFor, now),
        lt(healActions.attempts, MAX_ATTEMPTS),
      ),
    );

  for (const action of due) {
    const claimed = await claimOutboxRows(db, healActions, [action.id]);
    if (!claimed.has(action.id)) continue;
    const payload = action.payload as HealActionPayload;
    const attempts = action.attempts + 1;
    try {
      const provider = await createScmProvider(payload.repositoryUrl, db, action.projectId);
      if (!provider) {
        await db
          .update(healActions)
          .set({
            status: 'skipped',
            error: `unsupported SCM host for ${payload.repositoryUrl}`,
            attempts,
            updatedAt: now,
          })
          .where(eq(healActions.id, action.id));
        skipped++;
        continue;
      }

      const outcome = await applyHealAction(provider, { dedupeKey: action.dedupeKey, payload }, siteUrl);
      if (outcome.status === 'skipped') {
        await db
          .update(healActions)
          .set({ status: 'skipped', error: outcome.reason, attempts, updatedAt: now })
          .where(eq(healActions.id, action.id));
        skipped++;
      } else {
        await db
          .update(healActions)
          .set({ status: 'opened', result: outcome.result, error: null, attempts, updatedAt: now })
          .where(eq(healActions.id, action.id));
        opened++;
        await recordOutcome(db, {
          projectId: action.projectId,
          kind: 'auto-heal-pr',
          subjectType: 'heal-action',
          subjectId: action.id,
          suggestionKey: action.dedupeKey,
          outcome: 'suggested',
          runId: action.runId,
          commit: outcome.result.commitSha,
          details: { prNumber: outcome.result.prNumber, prUrl: outcome.result.prUrl },
        }).catch((e) => console.error(`[auto-heal] PR outcome failed for action ${action.id}`, e));
        const [proj] = await db
          .select({ label: projects.label, name: projects.name })
          .from(projects)
          .where(eq(projects.id, action.projectId));
        await emitNotification(db, 'auto_heal.pr_opened', {
          projectId: action.projectId,
          projectName: proj?.label || proj?.name || `project ${action.projectId}`,
          runId: action.runId ?? 0,
          prNumber: outcome.result.prNumber,
          prUrl: outcome.result.prUrl,
          branch: outcome.result.branch,
          editCount: payload.edits.length,
        }).catch((e) => console.error('[auto-heal] emitNotification failed', e));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const next = nextAttempt(attempts, now, action.scheduledFor);
      await db
        .update(healActions)
        .set({
          status: next.status,
          attempts,
          error: message,
          scheduledFor: next.scheduledFor,
          updatedAt: now,
        })
        .where(eq(healActions.id, action.id));
      console.error(`[auto-heal] action ${action.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${message}`);
      failed++;
    }
  }

  return { opened, failed, skipped };
}
