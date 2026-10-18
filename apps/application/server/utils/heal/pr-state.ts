/**
 * Keep `opened` heal actions in step with their pull request on the SCM. A PR
 * the SCM reports merged or closed moves its action to `merged` / `closed`, so
 * the per-project open-PR cap counts only PRs that are still open and the
 * "Piwi opened a PR" chips stop showing once the PR is settled.
 *
 * Best-effort per row: a project with no SCM token, an unsupported host, a
 * failed lookup or a PR the SCM still reports open leaves the row opened. Every
 * row looked at has its `updatedAt` moved to the check time, so each pass takes
 * the least recently checked rows and a long-open PR never holds the batch.
 *
 * A merged PR records the `auto-heal-pr` hand-back as `applied`, with the tests
 * its edits heal (the next eligible run that passes them records `verified`,
 * see `server/utils/outcome-inference.ts`); a PR closed without merging records
 * `rejected` with the keys of its edits, which auto-heal does not propose again
 * (`rejectedHealEdits` in `./policy.ts`).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { healActions, testRunsCases } from '../../database/schema';
import { resolveScmToken, scmProviderForUrl } from '../scm';
import { projectRepositoryFor } from '../scm/project-repository';
import { recordOutcome } from '../outcomes';
import { healEditKey, type HealActionPayload, type HealActionResult } from '#shared/auto-heal';
import type { DbClient } from '../../database';

/** Opened actions checked in one pass. */
export const PR_STATE_BATCH = 50;

export interface PrStateRefresh {
  /** Pull requests looked up on the SCM. */
  checked: number;
  merged: number;
  closed: number;
}

/**
 * Ask the SCM about the least recently checked `opened` actions (all projects,
 * or one) and record the ones whose PR has been merged or closed.
 */
export async function refreshOpenHealActions(
  db: DbClient,
  opts: { projectId?: number; limit?: number } = {},
): Promise<PrStateRefresh> {
  const refresh: PrStateRefresh = { checked: 0, merged: 0, closed: 0 };

  const rows = await db
    .select()
    .from(healActions)
    .where(
      and(
        eq(healActions.status, 'opened'),
        opts.projectId != null ? eq(healActions.projectId, opts.projectId) : undefined,
      ),
    )
    .orderBy(asc(healActions.updatedAt))
    .limit(opts.limit ?? PR_STATE_BATCH);

  const tokens = new Map<number, string | null>();
  for (const row of rows) {
    await db
      .update(healActions)
      .set({ updatedAt: new Date() })
      .where(and(eq(healActions.id, row.id), eq(healActions.status, 'opened')));

    const prNumber = (row.result as HealActionResult | null)?.prNumber;
    if (!prNumber) continue;
    try {
      if (!tokens.has(row.projectId)) tokens.set(row.projectId, await resolveScmToken(db, row.projectId));
      const token = tokens.get(row.projectId);
      if (!token) continue;
      // Only the project's pinned repository is read with its token.
      const repository = await projectRepositoryFor(
        db,
        row.projectId,
        (row.payload as HealActionPayload).repositoryUrl,
      );
      const provider = repository ? scmProviderForUrl(repository, token) : null;
      if (!provider) continue;

      const state = (await provider.fetchPullRequest(prNumber))?.state;
      refresh.checked++;
      if (state !== 'merged' && state !== 'closed') continue;

      const settled = await db
        .update(healActions)
        .set({ status: state, updatedAt: new Date() })
        .where(and(eq(healActions.id, row.id), eq(healActions.status, 'opened')))
        .returning({ id: healActions.id });
      if (settled.length > 0) {
        await recordPrOutcome(db, row, state).catch((e) =>
          console.error(`[auto-heal] PR outcome failed for action ${row.id}`, e),
        );
      }
      refresh[state]++;
    } catch (err) {
      console.error(`[auto-heal] PR state refresh failed for action ${row.id}`, err);
    }
  }

  return refresh;
}

/** Record a settled heal PR as its hand-back outcome. */
async function recordPrOutcome(
  db: DbClient,
  row: { id: number; projectId: number; dedupeKey: string; payload: unknown; result: unknown },
  state: 'merged' | 'closed',
): Promise<void> {
  const payload = row.payload as HealActionPayload;
  const result = row.result as HealActionResult | null;
  const executionIds = [
    ...new Set((payload?.edits ?? []).map((edit) => edit.executionId).filter((id) => Number.isInteger(id))),
  ];
  const tests = executionIds.length
    ? await db
        .select({ testCaseId: testRunsCases.testCaseId })
        .from(testRunsCases)
        .where(inArray(testRunsCases.id, executionIds))
    : [];
  await recordOutcome(db, {
    projectId: row.projectId,
    kind: 'auto-heal-pr',
    subjectType: 'heal-action',
    subjectId: row.id,
    suggestionKey: row.dedupeKey,
    outcome: state === 'merged' ? 'applied' : 'rejected',
    commit: result?.commitSha ?? null,
    details: {
      prNumber: result?.prNumber ?? null,
      prUrl: result?.prUrl ?? null,
      testCaseIds: [...new Set(tests.map((t) => t.testCaseId))],
      ...(state === 'closed'
        ? { editKeys: [...new Set((payload?.edits ?? []).map((edit) => healEditKey(edit)))] }
        : {}),
    },
  });
}
