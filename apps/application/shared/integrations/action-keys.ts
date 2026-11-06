/**
 * The dedupe keys for every integration outbox action. A key is the identity of
 * a write: a second click, a re-emitted event or a re-run enqueues the same key
 * and is a no-op. Pure and centralized so the callers and the tests agree on the
 * exact string.
 */

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
