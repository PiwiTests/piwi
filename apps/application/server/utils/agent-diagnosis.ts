/**
 * The server side of recording an agent's diagnosis: the patch is validated
 * against the source files it names, read through the project's SCM provider
 * at the commit of the run the failure was seen in, and the stored diagnosis
 * notifies like one Piwi produced. The write itself is the shared handler.
 */
import type { AgentDiagnosisInput, AgentDiagnosisTarget } from '#shared/agent-diagnosis';
import type { HandbackActor } from '#shared/handback-outcomes';
import {
  agentDiagnosisEvent,
  recordAgentDiagnosis,
  type RecordAgentDiagnosisResult,
  type ResolvedDiagnosisTarget,
} from '#shared/handlers/agent-diagnosis';
import { isDiagnosisRunning, isDiagnosisRunningForExecution } from './ai-diagnosis';
import { emitNotification } from './notifications/emit';
import { enqueueDiagnosisPolicies } from './integrations/policies';
import { loadRunSources } from './run-sources';
import type { DbClient } from '../database';

/**
 * Record an agent's diagnosis on a cluster or a failure and send
 * `diagnosis.completed`; `resolved` is the target when the caller already resolved it.
 */
export async function recordAgentDiagnosisOn(
  db: DbClient,
  target: AgentDiagnosisTarget,
  input: AgentDiagnosisInput,
  actor: HandbackActor,
  resolved?: ResolvedDiagnosisTarget,
): Promise<RecordAgentDiagnosisResult> {
  const running =
    target.scope === 'cluster'
      ? isDiagnosisRunning(target.clusterId)
      : isDiagnosisRunningForExecution(target.executionId);
  if (running) return { ok: false, error: 'running' };
  const result = await recordAgentDiagnosis(db, target, input, {
    actor,
    loadSources: (runId, paths) => loadRunSources(db, runId, paths),
    resolved,
  });
  const event = result.ok ? agentDiagnosisEvent(target, result, input) : null;
  if (event) {
    emitNotification(db, 'diagnosis.completed', event);
    enqueueDiagnosisPolicies(db, event).catch((e) => console.error('[integrations] diagnosis policies failed', e));
  }
  return result;
}
