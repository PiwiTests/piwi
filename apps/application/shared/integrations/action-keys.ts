/**
 * The integration outbox's action kinds and their dedupe keys. A key is the
 * identity of a write: a second click, a re-emitted event or a re-run enqueues
 * the same key and is a no-op. Pure and centralized so the callers and the tests
 * agree on the exact string.
 */
import type { IntegrationKind } from './registry';

/**
 * The integration kind each outbox action belongs to. The outbox checks the project's binding for that kind and
 * builds that kind's client; an action kind missing here is never run.
 */
export const ACTION_INTEGRATION_KINDS = {
  'create-issue': 'tracker',
  comment: 'tracker',
  'update-issue': 'tracker',
  attach: 'tracker',
  transition: 'tracker',
} as const satisfies Record<string, IntegrationKind>;

/** The integration kind of an outbox action, or null for an action kind the outbox does not run. */
export function integrationKindOf(actionKind: string): IntegrationKind | null {
  return Object.prototype.hasOwnProperty.call(ACTION_INTEGRATION_KINDS, actionKind)
    ? ACTION_INTEGRATION_KINDS[actionKind as keyof typeof ACTION_INTEGRATION_KINDS]
    : null;
}

/**
 * One create-issue per (entity, connection) — a second click never files twice.
 * The entity is the cluster for a cluster and its executions, so the cluster
 * page and an execution page share one filing.
 */
export function createIssueKey(entityType: string, entityId: number, connectionId: number): string {
  return `create-issue:${entityType}:${entityId}:conn${connectionId}`;
}

/**
 * One create-issue per submission of the create dialog, for an entity that may
 * get several issues (a run, an execution with no failure cluster): the same
 * submission sent twice files once, a new one files again.
 */
export function createIssueSubmissionKey(
  entityType: string,
  entityId: number,
  connectionId: number,
  submissionId: string,
): string {
  return `${createIssueKey(entityType, entityId, connectionId)}:s${submissionId}`;
}

/** Whether an action's error is an Outcome unknown: the create may have reached the tracker. */
export function isOutcomeUnknownError(error: string | null | undefined): boolean {
  return !!error?.startsWith('Outcome unknown:');
}

/** Whether a dedupe key names one submission of the create dialog (`createIssueSubmissionKey`). */
export function isSubmissionKey(key: string): boolean {
  return /:s[0-9a-f-]{36}$/i.test(key);
}

/** One comment per submission on an issue already filed, where a person's words go instead of a second issue. */
export function commentOnFiledIssueKey(issueKey: string, submissionId: string): string {
  return `comment:issue:${issueKey}:s${submissionId}`;
}

/** One fix comment per cluster per run. */
export function fixCommentKey(clusterId: number, runId: number): string {
  return `comment:failure_cluster:${clusterId}:fixed:r${runId}`;
}

/** One fix transition per cluster per run. */
export function fixTransitionKey(clusterId: number, runId: number): string {
  return `transition:failure_cluster:${clusterId}:fixed:r${runId}`;
}

/** One regression comment per cluster per run. */
export function regressionCommentKey(clusterId: number, runId: number): string {
  return `comment:failure_cluster:${clusterId}:regressed:r${runId}`;
}

/** One reopen transition per cluster per run. */
export function reopenTransitionKey(clusterId: number, runId: number): string {
  return `transition:failure_cluster:${clusterId}:reopen:r${runId}`;
}

/** One still-failing comment per cluster per note window (`2026-10-08` for a day, `2026-W41` for a week). */
export function occurrencesCommentKey(clusterId: number, window: string): string {
  return `comment:failure_cluster:${clusterId}:occurrences:${window}`;
}

/** One diagnosis comment per cluster per completed diagnosis (`completedAt`, epoch ms). */
export function diagnosisCommentKey(clusterId: number, completedAt: number): string {
  return `comment:failure_cluster:${clusterId}:diagnosis:${completedAt}`;
}

/** One description update per cluster and reason: `day:2026-10-08`, `diagnosis:<epoch ms>`. */
export function updateIssueKey(clusterId: number, reason: string): string {
  return `update-issue:failure_cluster:${clusterId}:${reason}`;
}

/** The daily description update's reason for a moment: its UTC date. */
export function dailyUpdateReason(at: Date): string {
  return `day:${at.toISOString().slice(0, 10)}`;
}

/** One merge comment per (cluster, other cluster) pair. */
export function mergeCommentKey(clusterId: number, otherClusterId: number): string {
  return `comment:failure_cluster:${clusterId}:merge:${otherClusterId}`;
}

/** One attachment per issue and file. */
export function attachKey(bugReportId: number, issueKey: string, fileName: string): string {
  return `attach:bug_report:${bugReportId}:${issueKey}:${fileName}`;
}

/** One looks-fixed comment per bug report per run. */
export function bugLooksFixedCommentKey(bugReportId: number, runId: number): string {
  return `comment:bug-looks-fixed:${bugReportId}:run${runId}`;
}

/** One fix transition per bug report per run. */
export function bugFixTransitionKey(bugReportId: number, runId: number): string {
  return `transition:bug-fix:${bugReportId}:run${runId}`;
}
