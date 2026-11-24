/**
 * CI dispatches on the server: matching a run to the dispatch that started it,
 * as the run starts and again as it finishes, and the dispatches' upkeep (the
 * ones no run answered, and their retention). What a dispatch records, and the
 * matching rule, are `#shared/ci-dispatches`; storing one is
 * `#shared/handlers/ci-dispatches`.
 */
import { and, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';
import { ciDispatches, flakeExperiments, testCases, testRuns, testRunsCases } from '../database/schema';
import {
  CI_DISPATCH_CLOCK_SLACK_MS,
  CI_DISPATCH_MATCH_WINDOW_MS,
  flakeLabKindOfArgs,
  matchCiDispatch,
  type CiDispatchCandidate,
  type FlakeLabKind,
} from '#shared/ci-dispatches';
import type { CiActionKind } from '#shared/ci-actions';
import type { CiRerunProvider } from '#shared/ci-rerun';
import { toPosixPath } from '#shared/retry-command';
import {
  FLAKE_LAB_RUN_METADATA_KEY,
  RUN_ORIGIN_METADATA_KEY,
  runOrigin,
  runOriginRef,
  type RunOriginKind,
} from '#shared/run-eligibility';
import { safeHttpUrl } from '#shared/utils/safe-url';
import { resolveRunBranch } from './run-branch';
import { updateRunMetadata } from './run-metadata';
import type { RunMetadata } from './run-json-types';
import type { DbClient } from '../database';

/** The runs a dispatch can start: CI runs, and Flake Lab runs, whose CI metadata says where they ran. */
const DISPATCHED_RUN_ORIGINS: readonly string[] = ['ci', 'ci-rerun', 'flake-lab'] satisfies RunOriginKind[];

/** The origins a matched re-run's stamp replaces: a CI run's, never a lab run's. */
const CI_ORIGINS: readonly string[] = ['ci', 'ci-rerun'] satisfies RunOriginKind[];

/** The statuses of a run that will never finish: its dispatch can be answered again, by a retry of the same job. */
const ABANDONED_RUN_STATUSES = ['cancelled', 'interrupted'];

/** The provider each repository host's run reports in `ci.provider`, as the reporter names it. */
const CI_PROVIDER = { github: 'GitHub Actions', gitlab: 'GitLab CI', bitbucket: 'Bitbucket Pipelines' } as const;

const epoch = (d: Date | number | null | undefined) => (d instanceof Date ? d.getTime() : Number(d ?? 0));

/** The spec files a run executed, POSIX separators. */
async function runFiles(db: DbClient, runId: number): Promise<string[]> {
  const executed = await db
    .selectDistinct({ filePath: testCases.filePath })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId));
  return executed.map((r) => toPosixPath(r.filePath));
}

/** The experiment a Flake Lab run names: its test, its kind and when it was created; null for any other run. */
async function flakeLabExperiment(
  db: DbClient,
  projectId: number,
  metadata: unknown,
): Promise<{ testCaseId: number; kind: FlakeLabKind; at: number } | null> {
  const stamp = (metadata as Record<string, unknown> | null)?.[FLAKE_LAB_RUN_METADATA_KEY] as
    | { experimentId?: unknown }
    | undefined;
  const experimentId = Number(stamp?.experimentId);
  if (!Number.isSafeInteger(experimentId) || experimentId <= 0) return null;
  const [experiment] = await db
    .select({
      testCaseId: flakeExperiments.testCaseId,
      kind: flakeExperiments.kind,
      createdAt: flakeExperiments.createdAt,
    })
    .from(flakeExperiments)
    .where(and(eq(flakeExperiments.id, experimentId), eq(flakeExperiments.projectId, projectId)));
  if (!experiment) return null;
  return {
    testCaseId: experiment.testCaseId,
    kind: experiment.kind === 'verify' ? 'verify' : 'reproduce',
    at: epoch(experiment.createdAt),
  };
}

/** Stamp a CI run `ci-rerun`, with the dispatch id as its ref, unless it carries that stamp already. */
async function stampCiRerun(db: DbClient, runId: number, dispatchId: string): Promise<void> {
  await updateRunMetadata(db, runId, (metadata) => {
    if (!CI_ORIGINS.includes(runOrigin(metadata))) return null;
    if (runOrigin(metadata) === 'ci-rerun' && runOriginRef(metadata) === dispatchId) return null;
    return { ...metadata, [RUN_ORIGIN_METADATA_KEY]: { kind: 'ci-rerun', ref: dispatchId } };
  });
}

/**
 * Match a run to the dispatch that started it (`matchCiDispatch`), when it
 * starts (`start`: by the dispatch id, the provider's id for the run, or a
 * Flake Lab experiment) and when it finishes (`finish`: by those, then by its
 * spec files). A match records the run on the dispatch, which becomes
 * `running`, or `ended` once the run finished, and whose link becomes the
 * build the run recorded (`ci.buildUrl`) when it has one. A run matched to a
 * re-run of tests is stamped `ci-rerun`, with the dispatch id as its ref, and
 * stamped again at finish when the reporter's last metadata dropped the stamp;
 * a whole suite's run, and a run of tagged tests, keep the origin `ci`.
 * A dispatch whose run was cancelled or interrupted is open again. Returns the
 * dispatch the run answers, or null.
 */
export async function matchRunToCiDispatch(
  db: DbClient,
  runId: number,
  phase: 'start' | 'finish',
): Promise<string | null> {
  const [run] = await db
    .select({
      projectId: testRuns.projectId,
      origin: testRuns.origin,
      metadata: testRuns.metadata,
      branch: testRuns.branch,
      startTime: testRuns.startTime,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run || !DISPATCHED_RUN_ORIGINS.includes(run.origin)) return null;

  // A run answers one dispatch: one matched already ends with the run.
  const [matched] = await db
    .select({ id: ciDispatches.id, state: ciDispatches.state, kind: ciDispatches.kind })
    .from(ciDispatches)
    .where(eq(ciDispatches.runId, runId))
    .limit(1);
  if (matched) {
    if (phase === 'finish') {
      if (matched.state === 'running') {
        await db
          .update(ciDispatches)
          .set({ state: 'ended', updatedAt: new Date() })
          .where(eq(ciDispatches.id, matched.id));
      }
      if (matched.kind === 'tests' && run.origin === 'ci') await stampCiRerun(db, runId, matched.id);
    }
    return matched.id;
  }

  const startedAt = epoch(run.startTime);
  const inWindow = and(
    eq(ciDispatches.projectId, run.projectId),
    gte(ciDispatches.createdAt, new Date(startedAt - CI_DISPATCH_MATCH_WINDOW_MS)),
    lte(ciDispatches.createdAt, new Date(startedAt + CI_DISPATCH_CLOCK_SLACK_MS)),
  );
  const open = await db
    .select()
    .from(ciDispatches)
    .where(and(inWindow, eq(ciDispatches.state, 'dispatched'), isNull(ciDispatches.runId)));
  const abandoned = await db
    .select({ dispatch: ciDispatches })
    .from(ciDispatches)
    .innerJoin(testRuns, eq(testRuns.id, ciDispatches.runId))
    .where(and(inWindow, eq(ciDispatches.state, 'running'), inArray(testRuns.status, ABANDONED_RUN_STATUSES)));
  const rows = [...open, ...abandoned.map((r) => r.dispatch)];
  if (rows.length === 0) return null;

  const meta = (run.metadata as RunMetadata | null) ?? null;
  const ci = meta?.ci ?? null;
  const reportedBy = (provider: keyof typeof CI_PROVIDER) => ci?.provider === CI_PROVIDER[provider];
  const candidates: CiDispatchCandidate[] = rows.map((d) => ({
    id: d.id,
    kind: d.kind as CiActionKind,
    provider: d.provider as CiRerunProvider,
    ref: d.ref ?? null,
    files: Array.isArray(d.files) ? (d.files as string[]) : null,
    providerRunId: d.providerRunId ?? null,
    testCaseId: d.testCaseId ?? null,
    flakeLabKind: d.kind === 'flakeLab' ? flakeLabKindOfArgs(d.args) : null,
    // A dispatch whose run will never finish reads as open.
    state: 'dispatched',
    runId: null,
    at: epoch(d.createdAt),
  }));
  const match = matchCiDispatch(
    {
      originRef: runOriginRef(run.metadata),
      githubRunId: reportedBy('github') ? (ci?.runId ?? null) : null,
      pipelineId: reportedBy('gitlab') ? (ci?.pipelineId ?? null) : null,
      bitbucketBuildNumber: reportedBy('bitbucket') ? (ci?.buildNumber ?? null) : null,
      buildNumber: ci?.buildNumber ?? null,
      branch: run.branch ?? resolveRunBranch(run.metadata) ?? null,
      startedAt,
      files: phase === 'finish' ? await runFiles(db, runId) : null,
      // A Flake Lab run on a developer's machine never answers a dispatch to CI.
      flakeLab: run.origin === 'flake-lab' && ci ? await flakeLabExperiment(db, run.projectId, run.metadata) : null,
    },
    candidates,
  );
  if (!match) return null;
  const previous = rows.find((d) => d.id === match.id)!;

  const buildUrl = safeHttpUrl(ci?.buildUrl ?? null);
  const now = new Date();
  // Only while it is as it was read: two runs that match one dispatch at once leave it to the first.
  const claimed = await db
    .update(ciDispatches)
    .set({
      runId,
      matchedAt: now,
      state: phase === 'start' ? 'running' : 'ended',
      ...(buildUrl ? { url: buildUrl } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(ciDispatches.id, match.id),
        eq(ciDispatches.state, previous.state),
        previous.runId == null ? isNull(ciDispatches.runId) : eq(ciDispatches.runId, previous.runId),
      ),
    )
    .returning({ id: ciDispatches.id });
  if (claimed.length === 0) return null;

  if (match.kind === 'tests' && CI_ORIGINS.includes(run.origin)) await stampCiRerun(db, runId, match.id);
  return match.id;
}

/** Match a run that has just started; a failure is logged and never stops the run. */
export async function matchStartedRunToCiDispatch(db: DbClient, runId: number): Promise<void> {
  await matchRunToCiDispatch(db, runId, 'start').catch((e) =>
    console.error('[ci-dispatches] matching a started run failed', e),
  );
}

/** Mark `unreported` the dispatches no run answered within the matching window. Returns how many. */
export async function endUnreportedCiDispatches(db: DbClient, now = new Date()): Promise<number> {
  const ended = await db
    .update(ciDispatches)
    .set({ state: 'unreported', updatedAt: now })
    .where(
      and(
        eq(ciDispatches.state, 'dispatched'),
        isNull(ciDispatches.runId),
        lt(ciDispatches.createdAt, new Date(now.getTime() - CI_DISPATCH_MATCH_WINDOW_MS)),
      ),
    )
    .returning({ id: ciDispatches.id });
  return ended.length;
}

/** Delete the dispatches made more than `olderThanDays` days ago. Returns how many. */
export async function pruneCiDispatches(db: DbClient, olderThanDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(ciDispatches)
    .where(lt(ciDispatches.createdAt, cutoff))
    .returning({ id: ciDispatches.id });
  return deleted.length;
}
