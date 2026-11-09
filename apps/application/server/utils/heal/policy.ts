/**
 * Decide whether a finished run should open a heal PR, and enqueue it.
 *
 * Mirrors `postRunPrFeedbackInBackground`'s resolution of the run's repository,
 * branch and commit — but writes to the repo, so the bar is higher: the feature
 * must be enabled, the project explicitly allowlisted, the run a full run on the
 * default branch (never a heal branch — that would feed on itself), and every
 * edit backed by high-confidence captured evidence. An edit a heal PR closed
 * without merging already proposed is left out, unless a person picked the
 * replacement in the snapshot picker after the PR closed. The chosen edit set
 * is snapshotted into a durable `heal_actions` row; the dispatcher does the
 * writes.
 */
import { isEligibleRun, runOrigin } from '#shared/run-eligibility';
import { and, count, eq, inArray } from 'drizzle-orm';
import { healActions, projects, testCases, testRuns, testRunsCases } from '../../database/schema';
import { getLocatorHealingBatch } from '../locator-healing';
import { createScmProvider } from '../scm';
import { resolveOwners } from '../scm/ownership';
import { resolveDefaultBranch } from '../scm/default-branch';
import { resolveRunBranch } from '../run-branch';
import { normalizeGitUrl } from '../scm/git-url';
import { getAutoHealSettings, resolveHealSiteUrl } from './settings';
import { refreshOpenHealActions } from './pr-state';
import { listOutcomes } from '../outcomes';
import { recordHealBranchRun } from './branch-runs';
import { buildRetryCommand, buildTitleGrepFlag } from '#shared/retry-command';
import {
  healBranchName,
  healDedupeKey,
  healEditKey,
  healSignature,
  isHealBranch,
  type AutoHealSettings,
  type HealActionPayload,
  type HealEditPayload,
} from '#shared/auto-heal';
import type { LocatorHealingResult } from '#shared/locator-healing.types';
import type { RunMetadata } from '../run-json-types';
import type { DbClient } from '../../database';

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

/**
 * Healing rungs backed by evidence (safe to threshold on): stored snapshots,
 * whose scores are stability scores, and the run's own diff renaming the string.
 */
const ELIGIBLE_SOURCES = new Set<LocatorHealingResult['source']>([
  'diff-rename',
  'prior-run',
  'fingerprint',
  'cross-test',
]);

/** One failing execution considered for healing. */
export interface HealCandidateRow {
  executionId: number;
  testCaseId: number;
  title: string;
  filePath: string;
  clusterId: number | null;
  owner: string | null;
}

/**
 * From the failing executions and their healing results, choose the edits that
 * qualify — deterministic locator-line rewrites backed by a stored snapshot,
 * scoring at or above `minScore` (or a user's confirmed pick), one per call
 * site. Pure, so the decision is unit-testable without a database.
 */
export function selectHealEdits(
  rows: HealCandidateRow[],
  healing: Map<number, LocatorHealingResult>,
  opts: { minScore: number },
): HealEditPayload[] {
  const edits: HealEditPayload[] = [];
  const seenCallSites = new Set<string>();

  for (const row of rows) {
    const h = healing.get(row.executionId);
    const rec = h?.recommendation?.recommended;
    const edit = h?.edit;
    if (!h || h.applicable === false || !rec || !edit || !edit.unifiedDiff || !edit.filePath) continue;

    // Real captured evidence only — ARIA-snapshot guesses never open a PR.
    if (!ELIGIBLE_SOURCES.has(h.source)) continue;
    // A provably-stale prior name means the stored alternatives are suspect.
    if (h.priorNameMayBeStale && !rec.pickedByUser) continue;
    // Score gate, waived for a human's confirmed pick.
    if (!rec.pickedByUser && (rec.score ?? 0) < opts.minScore) continue;

    const key = `${edit.filePath}:${edit.line}`;
    if (seenCallSites.has(key)) continue;
    seenCallSites.add(key);

    edits.push({
      filePath: edit.filePath,
      line: edit.line,
      oldLine: edit.oldLine,
      newLine: edit.newLine,
      failingLocator: h.failingLocator ? `${h.failingLocator.method}(${JSON.stringify(h.failingLocator.args)})` : null,
      suggestedLocator: rec.locator,
      score: rec.score ?? null,
      source: h.source,
      pickedByUser: rec.pickedByUser === true,
      pickedAt: rec.pickedByUser === true ? (rec.pickedAt ?? null) : null,
      clusterId: row.clusterId,
      executionId: row.executionId,
      testTitle: row.title,
      owner: row.owner,
    });
  }

  return edits;
}

/**
 * Leave out the edits a pull request closed without merging already proposed
 * (`rejected` maps each edit key to when its PR was closed), unless a person
 * picked the replacement in the snapshot picker after that. Pure.
 */
export function dropRejectedEdits(
  edits: HealEditPayload[],
  rejected: Map<string, Date>,
): { kept: HealEditPayload[]; dropped: HealEditPayload[] } {
  const kept: HealEditPayload[] = [];
  const dropped: HealEditPayload[] = [];
  for (const edit of edits) {
    const closedAt = rejected.get(healEditKey(edit));
    const pickedAt = edit.pickedByUser && edit.pickedAt ? Date.parse(edit.pickedAt) : NaN;
    if (closedAt && !(pickedAt > closedAt.getTime())) dropped.push(edit);
    else kept.push(edit);
  }
  return { kept, dropped };
}

/**
 * The edits of the project's heal PRs closed without merging, each with the
 * latest time one of those PRs closed: read from the closed actions still
 * stored and from the `rejected` outcomes, which outlive them.
 */
export async function rejectedHealEdits(db: DbClient, projectId: number): Promise<Map<string, Date>> {
  const rejected = new Map<string, Date>();
  const note = (key: string, at: Date) => {
    const known = rejected.get(key);
    if (!known || known < at) rejected.set(key, at);
  };
  const closed = await db
    .select({ payload: healActions.payload, updatedAt: healActions.updatedAt })
    .from(healActions)
    .where(and(eq(healActions.projectId, projectId), eq(healActions.status, 'closed')));
  for (const row of closed) {
    for (const edit of (row.payload as HealActionPayload | null)?.edits ?? []) note(healEditKey(edit), row.updatedAt);
  }
  const outcomes = await listOutcomes(db, { projectId, kind: 'auto-heal-pr', outcomes: ['rejected'] });
  for (const outcome of outcomes) {
    const keys = outcome.details?.editKeys;
    if (!Array.isArray(keys)) continue;
    for (const key of keys) if (typeof key === 'string') note(key, outcome.createdAt);
  }
  return rejected;
}

/** Build the verify command shown in the PR body — exactly the affected tests. */
function buildVerifyCommand(edits: HealEditPayload[], rows: HealCandidateRow[]): string {
  const byExecution = new Map(rows.map((r) => [r.executionId, r] as const));
  const cases = edits
    .map((e) => byExecution.get(e.executionId))
    .filter((r): r is HealCandidateRow => !!r)
    .map((r) => ({ filePath: r.filePath, title: r.title }));
  const fileCmd = buildRetryCommand(cases, { mode: 'file' });
  const grep = buildTitleGrepFlag([...new Set(cases.map((c) => c.title))].slice(0, 5));
  return `${fileCmd || 'npx playwright test'}${grep}`;
}

async function countOpenHealActions(db: DbClient, projectId: number): Promise<number> {
  const [{ value } = { value: 0 }] = await db
    .select({ value: count() })
    .from(healActions)
    .where(and(eq(healActions.projectId, projectId), eq(healActions.status, 'opened')));
  return value;
}

/**
 * Whether the project is under its open-PR cap. Once the recorded open count
 * reaches the cap, the SCM is asked which of those PRs are still open, so a
 * merged or closed PR frees its slot at once.
 */
export async function hasOpenPrCapacity(db: DbClient, projectId: number, maxOpenPrs: number): Promise<boolean> {
  let open = await countOpenHealActions(db, projectId);
  if (open > 0 && open >= maxOpenPrs) {
    await refreshOpenHealActions(db, { projectId });
    open = await countOpenHealActions(db, projectId);
  }
  return open < maxOpenPrs;
}

type EnqueueResult = { enqueued: true; dedupeKey: string; edits: number } | { enqueued: false; reason: string };

/**
 * Enqueue a heal action for a finished run when it qualifies. Best-effort and
 * non-throwing at the call sites — every early return names why nothing was done.
 */
export async function maybeEnqueueHealAction(db: DbClient, runId: number): Promise<EnqueueResult> {
  const skip = (reason: string): EnqueueResult => ({ enqueued: false, reason });

  const settings: AutoHealSettings = await getAutoHealSettings(db);
  if (!settings.enabled) return skip('disabled');

  const siteUrl = resolveHealSiteUrl();
  if (!siteUrl) return skip('PIWI_SITE_URL is not set');

  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return skip('run not found');
  if (!settings.projects.includes(run.projectId)) return skip('project not allowlisted');
  if (run.isFullRun === 0) return skip('not a full run');
  if (!isEligibleRun(run, 'auto-heal')) return skip(`a ${runOrigin(run.metadata)} run`);

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const branch = run.branch ?? resolveRunBranch(run.metadata);
  const commit = meta?.scm?.commit?.trim() || null;
  const repositoryUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
  if (!repositoryUrl) return skip('run has no repository URL in its SCM metadata');

  // Resolve the default branch through the shared chain (project setting → SCM
  // provider → reporter hint → 'main') so the "not the default branch" guard
  // fires even when the reporter recorded no `defaultBranch` in its metadata.
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  if (!project) return skip('project not found');
  const defaultBranch = await resolveDefaultBranch(db, project, run.metadata);

  const baseBranch = defaultBranch || branch;
  if (!baseBranch) return skip('run has no branch to target');
  if (branch && branch !== defaultBranch) return skip('run is not on the default branch');
  if (isHealBranch(branch, settings.branchPrefix)) return skip('run is on a heal branch');

  const provider = await createScmProvider(repositoryUrl, db, run.projectId);
  if (!provider?.provider) return skip(`unsupported SCM host for ${repositoryUrl}`);

  const rows: HealCandidateRow[] = (
    await db
      .select({
        executionId: testRunsCases.id,
        testCaseId: testRunsCases.testCaseId,
        status: testRunsCases.status,
        title: testCases.title,
        filePath: testCases.filePath,
        clusterId: testRunsCases.failureClusterId,
        owner: testCases.owner,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(eq(testRunsCases.testRunId, runId))
  )
    .filter((r) => FAIL_STATUSES.includes(r.status))
    .map((r) => ({
      executionId: r.executionId,
      testCaseId: r.testCaseId,
      title: r.title,
      filePath: r.filePath,
      clusterId: r.clusterId,
      owner: r.owner,
    }));
  if (rows.length === 0) return skip('run has no failing tests');

  // Fill each row's owner from CODEOWNERS when the test carries no annotation,
  // so the PR body can name a responsible team even on an un-annotated suite.
  const owners = await resolveOwners(db, run.projectId, rows).catch(() => new Map());
  const ownedRows = rows.map((r) => ({ ...r, owner: owners.get(r)?.owner ?? r.owner }));

  const healing = await getLocatorHealingBatch(
    db,
    ownedRows.map((r) => r.executionId),
  ).catch(() => new Map<number, LocatorHealingResult>());

  const qualifying = selectHealEdits(ownedRows, healing, { minScore: settings.minScore });
  if (qualifying.length === 0) return skip('no qualifying locator edits');
  const { kept: edits } = dropRejectedEdits(qualifying, await rejectedHealEdits(db, run.projectId));
  if (edits.length === 0) return skip('every qualifying edit was in a heal PR closed without merging');

  if (!(await hasOpenPrCapacity(db, run.projectId, settings.maxOpenPrs))) {
    return skip('max open heal PRs reached for this project');
  }

  const signature = healSignature(edits);
  const dedupeKey = healDedupeKey(run.projectId, signature);
  const branchName = healBranchName(settings.branchPrefix, runId, signature);

  const payload: HealActionPayload = {
    repositoryUrl,
    provider: provider.provider,
    baseBranch,
    baseSha: commit,
    branch: branchName,
    commitMessage: settings.commitMessage,
    title: settings.commitMessage,
    draft: settings.draft,
    verifyCommand: buildVerifyCommand(edits, rows),
    edits,
  };

  if (!(await queueHealAction(db, { projectId: run.projectId, runId, dedupeKey, payload }))) {
    return skip('an identical heal action is already queued');
  }

  return { enqueued: true, dedupeKey, edits: edits.length };
}

/**
 * Settled states whose dedupe key is free to reuse: the ones that gave nothing
 * to the repository, and a PR closed without merging. Its edits reach the queue
 * again only once a person picked them after the close (`dropRejectedEdits`).
 */
const RETRYABLE_STATUSES = ['failed', 'skipped', 'closed'];

/**
 * Queue a heal action under its dedupe key. A row that already holds the key
 * and ended failed, skipped or closed is reset to pending with the new run and
 * payload; a pending, processing, opened or merged one keeps it. Returns
 * whether the action was queued.
 */
export async function queueHealAction(
  db: DbClient,
  action: { projectId: number; runId: number; dedupeKey: string; payload: HealActionPayload },
): Promise<boolean> {
  const inserted = await db
    .insert(healActions)
    .values({
      projectId: action.projectId,
      runId: action.runId,
      dedupeKey: action.dedupeKey,
      kind: 'open-pr',
      status: 'pending',
      attempts: 0,
      payload: action.payload,
      scheduledFor: new Date(),
    })
    .onConflictDoNothing({ target: healActions.dedupeKey })
    .returning({ id: healActions.id });
  if (inserted.length > 0) return true;

  const requeued = await db
    .update(healActions)
    .set({
      runId: action.runId,
      status: 'pending',
      attempts: 0,
      payload: action.payload,
      result: null,
      error: null,
      scheduledFor: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(healActions.dedupeKey, action.dedupeKey), inArray(healActions.status, RETRYABLE_STATUSES)))
    .returning({ id: healActions.id });
  return requeued.length > 0;
}

/**
 * Fire-and-forget wrapper for the run-finalize paths: a run on a heal branch is
 * recorded on its heal action, and a run on the default branch may enqueue one.
 */
export function maybeEnqueueHealActionInBackground(db: DbClient, runId: number): void {
  recordHealBranchRun(db, runId).catch((e) => console.error('[auto-heal] recordHealBranchRun failed', e));
  maybeEnqueueHealAction(db, runId)
    .then(async (result) => {
      if (result.enqueued) {
        // Opportunistic dispatch; the scheduled sweeper is the safety net.
        const { sweepHealActions } = await import('./dispatch');
        await sweepHealActions(db);
      } else if (result.reason !== 'disabled') {
        console.info(`[auto-heal] nothing enqueued for run #${runId}: ${result.reason}`);
      }
    })
    .catch((e) => console.error('[auto-heal] maybeEnqueueHealAction failed', e));
}
