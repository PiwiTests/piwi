/**
 * Running Piwi's AI diagnosis on one failing execution (execution scope). The
 * execution's cluster, when it has one, grounds the diagnosis in the cluster's
 * evidence. Shared by `POST /api/test-run-cases/:id/diagnose` and the MCP tool
 * `run_execution_diagnosis`.
 */
import { isVisibleRun } from '#shared/run-eligibility';
import { and, eq } from 'drizzle-orm';
import { failureClusters, failureDiagnoses, testRuns, testRunsCases } from '../database/schema';
import type { FailureCluster, FailureDiagnosis } from '../database/schema';
import { hasFailureToDiagnose } from '#shared/ai-diagnosis';
import { resolveAiConfig, type AiAttachedImage } from './ai-provider';
import { runExecutionDiagnosis, isDiagnosisRunningForExecution, isDiagnosisStale } from './ai-diagnosis';
import type { DbClient } from '../database';

/** An execution as its diagnosis reads it: its project, its cluster and whether it failed. */
export interface ExecutionForDiagnosis {
  id: number;
  projectId: number;
  clusterId: number | null;
  status: string;
  error: string | null;
}

export interface ExecutionDiagnosisOptions {
  /** Re-run even when a completed diagnosis exists. */
  force?: boolean;
  additionalContext?: string;
  images?: AiAttachedImage[];
  baseCommit?: string;
  selectedCommitShas?: string[];
}

export type ExecutionDiagnosisOutcome =
  | { ok: true; diagnosis: FailureDiagnosis }
  | { ok: false; error: 'not-failed' | 'not-configured' | 'running' };

/** Load an execution for its diagnosis; null when it does not exist, or is of a run `viewerId` does not see. */
export async function loadExecutionForDiagnosis(
  db: DbClient,
  executionId: number,
  viewerId: number | null,
): Promise<ExecutionForDiagnosis | null> {
  const [execution] = await db
    .select({
      id: testRunsCases.id,
      projectId: testRuns.projectId,
      clusterId: testRunsCases.failureClusterId,
      status: testRunsCases.status,
      error: testRunsCases.error,
      run: { origin: testRuns.origin, requesterId: testRuns.requesterId },
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .where(eq(testRunsCases.id, executionId))
    .limit(1);
  if (!execution || !isVisibleRun(execution.run, viewerId)) return null;
  const { run: _run, ...found } = execution;
  return found;
}

/**
 * Diagnose a failing execution, or return its completed diagnosis unless
 * `force` is set. Refuses an execution that did not fail, and while a
 * diagnosis of the execution is running.
 */
export async function diagnoseExecution(
  db: DbClient,
  execution: ExecutionForDiagnosis,
  opts: ExecutionDiagnosisOptions = {},
): Promise<ExecutionDiagnosisOutcome> {
  if (!hasFailureToDiagnose(execution)) return { ok: false, error: 'not-failed' };
  if (isDiagnosisRunningForExecution(execution.id)) return { ok: false, error: 'running' };

  if (!opts.force) {
    const [existing] = await db
      .select()
      .from(failureDiagnoses)
      .where(and(eq(failureDiagnoses.testRunsCaseId, execution.id), eq(failureDiagnoses.scope, 'execution')))
      .limit(1);
    if (existing?.status === 'running' && !isDiagnosisStale(existing)) return { ok: false, error: 'running' };
    if (existing?.status === 'completed') return { ok: true, diagnosis: existing };
  }

  const config = await resolveAiConfig(db);
  if (!config) return { ok: false, error: 'not-configured' };

  let cluster: FailureCluster | null = null;
  if (execution.clusterId) {
    [cluster = null] = await db.select().from(failureClusters).where(eq(failureClusters.id, execution.clusterId));
  }

  const diagnosis = await runExecutionDiagnosis(
    db,
    { id: execution.id, projectId: execution.projectId, cluster },
    config,
    {
      additionalContext: opts.additionalContext,
      images: opts.images,
      baseCommit: opts.baseCommit,
      selectedCommitShas: opts.selectedCommitShas,
    },
  );
  return { ok: true, diagnosis };
}
