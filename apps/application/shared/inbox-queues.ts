/**
 * The failure inbox — pure logic shared by the server handler, the demo mirror,
 * the Home inbox card and the unit tests. Nothing here touches the database or
 * the DOM: it is the single source of truth for what each queue means, when a
 * snooze hides a cluster, and how a cluster is matched to the signed-in user.
 */

import type { FailureClueStrength } from './failure-clues';

/** The inbox queues, in display order. `all` is the default. */
export const INBOX_QUEUES = [
  'all',
  'new',
  'mine',
  'needs-ticket',
  'regressions',
  'fix-didnt-hold',
  'quarantine-ready',
  'merge-suggestions',
] as const;

export type InboxQueue = (typeof INBOX_QUEUES)[number];

export function isInboxQueue(value: unknown): value is InboxQueue {
  return typeof value === 'string' && (INBOX_QUEUES as readonly string[]).includes(value);
}

/** A far-future deadline stands in for "snoozed until it recurs" — no time wakes it. */
export const SNOOZE_FOREVER_MS = Date.UTC(9999, 0, 1);

/** The snooze options the triage menu offers. */
export type SnoozeOption = '1-day' | '1-week' | 'until-recurs';

export const SNOOZE_OPTIONS: readonly SnoozeOption[] = ['1-day', '1-week', 'until-recurs'];

export function isSnoozeOption(value: unknown): value is SnoozeOption {
  return typeof value === 'string' && (SNOOZE_OPTIONS as readonly string[]).includes(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `snoozedUntil` / `snoozeMode` a snooze option resolves to at `now`.
 * "Until it recurs" parks the deadline far in the future so no clock wakes it —
 * only a new occurrence does, by clearing `snoozedUntil` (see `wakeOnRecurrence`).
 */
export function computeSnooze(
  option: SnoozeOption,
  now: Date = new Date(),
): { snoozedUntil: Date; snoozeMode: string } {
  switch (option) {
    case '1-day':
      return { snoozedUntil: new Date(now.getTime() + DAY_MS), snoozeMode: 'until' };
    case '1-week':
      return { snoozedUntil: new Date(now.getTime() + 7 * DAY_MS), snoozeMode: 'until' };
    case 'until-recurs':
      return { snoozedUntil: new Date(SNOOZE_FOREVER_MS), snoozeMode: 'until-recurs' };
  }
}

/** The snooze fields a cluster row carries into the queue logic. */
export interface SnoozeState {
  snoozedUntil?: string | Date | null;
  snoozeMode?: string | null;
}

function asTime(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A cluster is hidden from every queue while its snooze deadline is still ahead. */
export function isCurrentlySnoozed(cluster: SnoozeState, now: Date = new Date()): boolean {
  const until = asTime(cluster.snoozedUntil);
  return until != null && until > now.getTime();
}

/**
 * A cluster that was snoozed "until it recurs" and has since recurred — its
 * deadline was cleared by `wakeOnRecurrence`, but the mode marks where it came
 * from. Drives the "snoozed, back" badge in the *New since you last looked* queue.
 */
export function isSnoozedBack(cluster: SnoozeState): boolean {
  return cluster.snoozeMode === 'until-recurs' && asTime(cluster.snoozedUntil) == null;
}

/**
 * The snooze fields to write when a snoozed cluster gets a fresh occurrence.
 * Only an "until it recurs" snooze wakes this way; a timed snooze rides out its
 * deadline. Returns `null` when nothing should change, so the bump path can skip
 * the write for the common (not-snoozed) case.
 */
export function wakeOnRecurrence(cluster: SnoozeState): { snoozedUntil: null } | null {
  if (cluster.snoozeMode === 'until-recurs' && isCurrentlySnoozed(cluster)) {
    return { snoozedUntil: null };
  }
  return null;
}

/** The signed-in identity a "Mine" match is tested against (any field may be absent). */
export interface UserIdentity {
  name?: string | null;
  username?: string | null;
  email?: string | null;
}

/**
 * The identity "Mine" matches for a signed-in user, the same in the dashboard
 * and over MCP: their name, username and email. None without a user
 * (authentication off).
 */
export function inboxIdentity(
  user: { name?: string | null; username?: string | null; email?: string | null } | null | undefined,
): UserIdentity | null {
  return user ? { name: user.name ?? null, username: user.username ?? null, email: user.email ?? null } : null;
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Whether a name/email string names the signed-in user — best effort, matching
 * any of the user's name, username or email case-insensitively.
 */
export function personIsUser(person: string | null | undefined, user: UserIdentity | null): boolean {
  const p = norm(person);
  if (!p || !user) return false;
  return p === norm(user.name) || p === norm(user.username) || p === norm(user.email);
}

/** The fields the queue predicates read from a cluster row. */
export interface InboxClusterLike extends SnoozeState {
  firstSeenAt?: string | Date | null;
  lastSeenAt?: string | Date | null;
  assignee?: string | null;
  owner?: { name: string } | null;
  fixVerification?: string | null;
  regressionOnDefault?: boolean;
  quarantineReadyCount?: number;
  mergeSuggestionPending?: boolean;
  /** On the project's default branch — a needs-ticket candidate must be. */
  onDefaultBranch?: boolean;
  /** Already carries a tracker issue — excluded from needs-ticket. */
  hasKnownIssue?: boolean;
  /** Days a cluster may sit open with no ticket before needs-ticket lists it (from the binding). */
  needsTicketAfterDays?: number;
}

/** The default age, in days, before an untracked open cluster shows in needs-ticket. */
export const DEFAULT_NEEDS_TICKET_AFTER_DAYS = 2;

/**
 * A cluster the team should file a ticket for: open on the default branch, older
 * than the configured age, with no known issue. Pure so the client, the server
 * and the tests agree; the age threshold rides on the row from the binding.
 */
export function needsTicket(cluster: InboxClusterLike, now: Date = new Date()): boolean {
  if (cluster.onDefaultBranch !== true || cluster.hasKnownIssue === true) return false;
  const first = asTime(cluster.firstSeenAt);
  if (first == null) return false;
  const days = cluster.needsTicketAfterDays ?? DEFAULT_NEEDS_TICKET_AFTER_DAYS;
  return now.getTime() - first >= days * DAY_MS;
}

/** The assignee, or the owner the row falls back to when unassigned. */
export function effectiveAssignee(cluster: InboxClusterLike): string | null {
  return cluster.assignee ?? cluster.owner?.name ?? null;
}

/** A cluster belongs to the signed-in user when its assignee or owner names them. */
export function isMine(cluster: InboxClusterLike, user: UserIdentity | null): boolean {
  if (!user) return false;
  return personIsUser(cluster.assignee, user) || personIsUser(cluster.owner?.name, user);
}

/**
 * "New since you last looked": first seen, or most recently recurred, after the
 * per-viewer last-visit timestamp (epoch ms). A `null` cut treats every cluster
 * as new — the first visit shows the whole queue.
 */
export function isNewSince(cluster: InboxClusterLike, lastVisitMs: number | null): boolean {
  if (lastVisitMs == null) return true;
  const first = asTime(cluster.firstSeenAt);
  const last = asTime(cluster.lastSeenAt);
  return (first != null && first > lastVisitMs) || (last != null && last > lastVisitMs);
}

/**
 * Whether a cluster belongs in a queue. `all` is every returned row (the server
 * has already excluded currently-snoozed clusters). The predicate is pure over
 * the row plus the per-viewer context, so the client and the tests agree.
 */
export function clusterInQueue(
  cluster: InboxClusterLike,
  queue: InboxQueue,
  ctx: { user?: UserIdentity | null; lastVisitMs?: number | null; now?: Date } = {},
): boolean {
  switch (queue) {
    case 'all':
      return true;
    case 'new':
      return isNewSince(cluster, ctx.lastVisitMs ?? null);
    case 'mine':
      return isMine(cluster, ctx.user ?? null);
    case 'needs-ticket':
      return needsTicket(cluster, ctx.now ?? new Date());
    case 'regressions':
      return cluster.regressionOnDefault === true;
    case 'fix-didnt-hold':
      return cluster.fixVerification === 'regressed';
    case 'quarantine-ready':
      return (cluster.quarantineReadyCount ?? 0) > 0;
    case 'merge-suggestions':
      return cluster.mergeSuggestionPending === true;
  }
}

/** The environment-incident run a cluster first appeared in. */
export interface InboxIncidentRunLike {
  runId: number;
  reason: string;
  host: string | null;
  startedAt?: string | Date | null;
}

/** One inbox row standing for every cluster an environment incident opened. */
export interface InboxIncidentRow<T> {
  runId: number;
  projectId: number;
  reason: string;
  host: string | null;
  startedAt: string | Date | null;
  clusters: T[];
}

/**
 * Take the clusters an environment-incident run opened out of the inbox list
 * and group them into one row per run: an outage that opened a cluster per
 * failing page reads as one thing to look at, not a page of triage. Clusters
 * that were already open before the incident stay rows of their own.
 */
export function groupIncidentClusters<
  T extends { id: number; projectId: number; incidentRun?: InboxIncidentRunLike | null },
>(clusters: T[]): { clusters: T[]; incidents: Array<InboxIncidentRow<T>> } {
  const rest: T[] = [];
  const byRun = new Map<number, InboxIncidentRow<T>>();
  for (const cluster of clusters) {
    const run = cluster.incidentRun;
    if (!run) {
      rest.push(cluster);
      continue;
    }
    let row = byRun.get(run.runId);
    if (!row) {
      row = {
        runId: run.runId,
        projectId: cluster.projectId,
        reason: run.reason,
        host: run.host,
        startedAt: run.startedAt ?? null,
        clusters: [],
      };
      byRun.set(run.runId, row);
    }
    row.clusters.push(cluster);
  }
  return { clusters: rest, incidents: [...byRun.values()] };
}

/** Count how many of `clusters` fall into each queue, for the tab badges. */
export function countQueues(
  clusters: InboxClusterLike[],
  ctx: { user?: UserIdentity | null; lastVisitMs?: number | null } = {},
): Record<InboxQueue, number> {
  const counts = Object.fromEntries(INBOX_QUEUES.map((q) => [q, 0])) as Record<InboxQueue, number>;
  for (const cluster of clusters) {
    for (const queue of INBOX_QUEUES) {
      if (clusterInQueue(cluster, queue, ctx)) counts[queue] += 1;
    }
  }
  return counts;
}

/** A one-line cause hint for a row (cluster C in the audit). */
export interface ClusterClue {
  text: string;
  strength: FailureClueStrength;
}

/**
 * A cheap, batch-safe cause hint derived from a cluster's own fields — the
 * muted second line on an inbox row. The full deterministic clue engine
 * (`buildFailureClues`) needs an execution's loaded evidence and stays on the
 * cluster and execution pages; here one query over the cluster table must serve
 * every row, so the hint is read from the fingerprint's own signals.
 */
export function clusterClue(cluster: {
  errorType?: string | null;
  selector?: string | null;
  fixVerification?: string | null;
}): ClusterClue | null {
  if (cluster.fixVerification === 'regressed') {
    return { text: 'A landed fix regressed — the failure is back', strength: 'strong' };
  }
  const selector = cluster.selector?.trim() || null;
  switch (cluster.errorType) {
    case 'timeout':
      return {
        text: selector ? `Timed out waiting for ${selector}` : 'Timed out waiting for the app',
        strength: 'medium',
      };
    case 'strict-mode':
      return {
        text: selector ? `${selector} matched more than one element` : 'The locator matched more than one element',
        strength: 'strong',
      };
    case 'assertion':
      return { text: 'An assertion did not hold', strength: 'medium' };
    case 'navigation':
      return { text: 'A navigation did not complete', strength: 'medium' };
    case 'crash':
      return { text: 'The page crashed during the test', strength: 'strong' };
    default:
      return null;
  }
}

/** Validate a batch-triage request body: ids present, all numeric, within a cap. */
export const BULK_TRIAGE_MAX = 200;

export function parseBulkIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BULK_TRIAGE_MAX) return null;
  const ids: number[] = [];
  for (const value of raw) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0) return null;
    ids.push(n);
  }
  return [...new Set(ids)];
}
