import { notificationTargetPath, type TestStuckPayload } from '#shared/notification-events';
import { durationShort } from '#shared/relative-time';

/**
 * What a notification event shows as an OS notification: in a browser tab (`useNotificationStream`), and in the
 * desktop app, whose shell shows the ones its server renders (`server/api/desktop/notifications.get.ts`).
 */

/** The title every such notification carries. */
export const NOTIFICATION_MESSAGE_TITLE = 'Piwi Dashboard';

/** A notification event as the notification stream sends it: its type and the fields of its payload the message reads. */
export interface NotificationEventData {
  type: string;
  projectId?: number;
  projectName?: string;
  runId?: number;
  status?: string;
  failedTests?: number;
  totalTests?: number;
  branch?: string;
  signature?: string;
  title?: string | null;
  verification?: string;
  origin?: string;
  clusterId?: number;
  executionId?: number;
  summary?: string | null;
  rootCause?: string | null;
  category?: string | null;
  confidence?: string | null;
  topFailures?: { title: string }[];
  affectedCases?: number;
  snapshotId?: number;
  tests?: { title: string }[];
  reason?: string;
  testTitle?: string;
  elapsedMs?: number;
  usualMs?: number;
}

/** The text of the notification an event shows: one line per fact, empty for an event that shows none. */
export function notificationMessageBody(data: NotificationEventData): string {
  const lines: string[] = [];
  switch (data.type) {
    case 'run.finished':
    case 'run.failed':
    case 'run.failed.default_branch':
    case 'run.interrupted':
    case 'flakiness.spike':
    case 'perf.regression': {
      const name = data.projectName ?? `Project #${data.projectId}`;
      const branchSuffix = data.branch && data.type !== 'perf.regression' ? ` on ${data.branch}` : '';
      if (data.type === 'run.finished') lines.push(`${name}${branchSuffix}: ${data.status ?? 'finished'}`);
      else if (data.type === 'run.failed')
        lines.push(`${name}${branchSuffix}: ${data.failedTests ?? 0}/${data.totalTests ?? 0} tests failed`);
      else if (data.type === 'run.interrupted')
        lines.push(`${name}${branchSuffix}: interrupted before it finished, the reporter stopped sending`);
      else if (data.type === 'run.failed.default_branch')
        lines.push(`${name}: ${data.failedTests ?? 0} failures on default branch`);
      else if (data.type === 'flakiness.spike') lines.push(`${name}: flakiness spike detected`);
      else if (data.type === 'perf.regression') lines.push(`${name}: performance regression detected`);
      if (data.failedTests) lines.push(`${data.failedTests} failed, ${data.totalTests} total`);
      if (data.topFailures?.length) {
        const [first, ...rest] = data.topFailures;
        lines.push(rest.length ? `${first!.title} +${rest.length} more` : first!.title);
      }
      break;
    }
    case 'cluster.new':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: new failure cluster`);
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'cluster.fixed':
      lines.push(
        `${data.projectName ?? `Project #${data.projectId}`}: ${data.verification === 'diagnosis-verified' ? 'diagnosis verified' : 'cluster stopped failing'}`,
      );
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'cluster.regressed':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: a fixed cluster is failing again`);
      if (data.title || data.signature) lines.push(data.title || data.signature || '');
      break;
    case 'bug.looks_fixed':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: a test marked to fail now passes`);
      if (data.tests?.length) lines.push(data.tests.map((t) => t.title).join(', '));
      break;
    case 'environment.incident':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: environment incident`);
      if (data.reason) lines.push(data.reason);
      break;
    case 'test.stuck':
      lines.push(`${data.projectName ?? `Project #${data.projectId}`}: a test may be stuck`);
      if (data.testTitle) lines.push(data.testTitle);
      if (data.elapsedMs != null && data.usualMs != null) {
        lines.push(`Running for ${durationShort(data.elapsedMs)}, ${durationShort(data.usualMs)} at most usually`);
      }
      break;
    case 'report.ready':
      lines.push(`Your quality report is ready: ${data.title ?? 'open it in Piwi'}`);
      break;
    case 'diagnosis.completed':
      lines.push(data.summary || data.rootCause || '');
      if (data.category) lines.push(`Category: ${data.category}`);
      if (data.confidence) lines.push(`Confidence: ${data.confidence}`);
      break;
  }
  return lines.filter(Boolean).join('\n');
}

/** The dashboard page a click on the notification opens, `null` when it is about no page. */
export function notificationMessagePath(data: NotificationEventData): string | null {
  if (data.snapshotId) return `/reports/${data.snapshotId}`;
  if (data.type === 'test.stuck' && data.runId && data.testTitle) {
    return notificationTargetPath('test.stuck', data as unknown as TestStuckPayload);
  }
  if (data.type === 'diagnosis.completed' && data.executionId) return `/test-run-cases/${data.executionId}`;
  if (data.clusterId) return `/failure-clusters/${data.clusterId}`;
  if (data.runId && data.projectId) return `/test-runs/${data.runId}`;
  return null;
}

/**
 * The tag that makes a notification replace an earlier one about the same thing: a run, a cluster, a report. A stuck
 * test is one of several a run may have, so each keeps its own.
 */
export function notificationMessageTag(data: NotificationEventData): string {
  const key =
    data.type === 'test.stuck'
      ? `${data.runId}-${data.testTitle}`
      : (data.snapshotId ?? data.executionId ?? data.clusterId ?? data.runId ?? data.signature ?? data.type);
  return `piwi-${data.type}-${key}`;
}
