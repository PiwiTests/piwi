/**
 * The cluster state: one sentence with one verb that says whether a failure
 * cluster is still failing, fixed, regressed, resolved, ignored, snoozed or
 * quarantined — and the single control that changes it, as one line the reader
 * can act on.
 *
 * Pure: it reads the cluster's stored fields and the project's run order (which
 * run is latest, how recent the last occurrence is) and never queries anything.
 */
import type { SituationPart } from '#shared/situation';
import { isCurrentlySnoozed } from '#shared/inbox-queues';
import { relativeTimeAgo, durationApprox, toEpochMs } from '#shared/relative-time';
import { shortCommit } from '#shared/scm-urls';

export type ClusterStateKind =
  | 'failing'
  | 'failing-assigned'
  | 'quiet'
  | 'fix-verified-open'
  | 'fix-unconfirmed'
  | 'stopped-failing-open'
  | 'ticket-done'
  | 'regressed'
  | 'resolved'
  | 'ignored'
  | 'snoozed'
  | 'quarantined';

export type ClusterStateAction = 'mark-resolved' | 'reopen' | 'unsnooze' | 'release' | null;

export interface ClusterState {
  kind: ClusterStateKind;
  sentence: string;
  action: ClusterStateAction;
  /** The sentence split into typed spans, so the UI can link the run references. */
  parts: SituationPart[];
}

export interface ClusterStateCluster {
  status: string;
  assignee?: string | null;
  fixVerification?: string | null;
  fixCommit?: string | null;
  fixLandedRunId?: number | null;
  /** A run that passed every affected test at the commit the cluster last failed at. */
  flakeEvidenceRunId?: number | null;
  lastSeenRunId: number;
  lastSeenAt?: string | Date | number | null;
  updatedAt?: string | Date | number | null;
  triageNote?: string | null;
  snoozedUntil?: string | Date | null;
  snoozeMode?: string | null;
  /** The run the failure came back in, when it regressed. */
  regressedSinceRunId?: number | null;
  /** How many tests the cluster spans, and how many of them are currently quarantined. */
  affectedTests: number;
  quarantinedTests: number;
  /** The cluster's known tracker issue, when one is pinned (its status drives the reconcile). */
  knownIssue?: { key: string; statusCategory?: string | null } | null;
  /**
   * The diagnosed patch still applied to the code at the verified fix's commit,
   * checked when the fix was verified: the change that fixed the failure was
   * another one, and the diagnosed change may not be in the code yet.
   */
  diagnosedPatchApplies?: boolean;
}

export interface ClusterStateProject {
  /** The project's run ids, newest first (by start time). */
  runIdsNewestFirst: number[];
  /**
   * Whether the failure goes on (`failureGoesOn`). A Done ticket is reconciled
   * only once it stopped; unset reads as going on.
   */
  failureGoesOn?: boolean;
  now?: Date;
}

/** A run as the failure-goes-on rule reads it: its id and its start time. */
export interface RunPoint {
  id: number;
  startTime: string | Date | number | null;
}

/**
 * Whether run `a` started after run `b`: by start time, then by id when two
 * started in the same second. A run with no known start time sorts first.
 */
export function runStartedAfter(a: RunPoint, b: RunPoint): boolean {
  const aStart = toEpochMs(a.startTime) ?? -Infinity;
  const bStart = toEpochMs(b.startTime) ?? -Infinity;
  return aStart > bStart || (aStart === bStart && a.id > b.id);
}

/**
 * Whether a cluster's failure goes on: it was last seen in the project's latest
 * finished run or in a later one, or no run has finished yet. A run still in
 * progress never counts as one the failure skipped. Runs are ordered by start
 * time, then by id when two started in the same second.
 */
export function failureGoesOn(
  lastSeen: RunPoint | null | undefined,
  latestFinished: RunPoint | null | undefined,
): boolean {
  if (!latestFinished) return true;
  if (!lastSeen) return false;
  return lastSeen.id === latestFinished.id || runStartedAfter(lastSeen, latestFinished);
}

/**
 * The key of the Done ticket to reconcile the cluster with, or null: the cluster
 * is open, not snoozed, its fix did not regress, its known ticket is Done and the
 * failure stopped. The cluster state then offers to mark it resolved, and so
 * does the next step on both failure pages.
 */
export function ticketReconcileKey(
  cluster: Pick<ClusterStateCluster, 'status' | 'fixVerification' | 'snoozedUntil' | 'snoozeMode' | 'knownIssue'>,
  opts: { failureGoesOn: boolean; now?: Date },
): string | null {
  if (cluster.status !== 'open' || cluster.fixVerification === 'regressed' || opts.failureGoesOn) return null;
  const snooze = { snoozedUntil: cluster.snoozedUntil ?? null, snoozeMode: cluster.snoozeMode ?? null };
  if (isCurrentlySnoozed(snooze, opts.now ?? new Date())) return null;
  const issue = cluster.knownIssue;
  return issue?.key && issue.statusCategory === 'done' ? issue.key : null;
}

/**
 * A cluster is *failing* when its last occurrence is the project's latest run,
 * or within the last few runs — recent enough that the next run is expected to
 * fail too. Beyond that window an open cluster is *quiet*: still open, but it
 * has not been seen for a while.
 */
const FAILING_RUN_WINDOW = 3;

export function computeClusterState(cluster: ClusterStateCluster, project: ClusterStateProject): ClusterState {
  const now = project.now ?? new Date();
  const runs = project.runIdsNewestFirst;
  const latestRunId = runs.length > 0 ? runs[0]! : null;
  const seenIndex = runs.indexOf(cluster.lastSeenRunId); // 0 = latest run
  const isFailing = cluster.lastSeenRunId === latestRunId || (seenIndex >= 0 && seenIndex < FAILING_RUN_WINDOW);
  const runsSinceLastSeen = seenIndex >= 0 ? seenIndex : runs.length;

  const parts: SituationPart[] = [];
  const t = (text: string) => parts.push({ kind: 'text', text });
  const run = (id: number | null | undefined) => {
    if (id == null) {
      t('a run');
      return;
    }
    parts.push({ kind: 'run', text: `run #${id}`, id, href: `/test-runs/${id}` });
  };
  const done = (kind: ClusterStateKind, action: ClusterStateAction): ClusterState => ({
    kind,
    action,
    sentence: parts
      .map((p) => p.text)
      .join('')
      .trim(),
    parts,
  });

  // Terminal human status wins.
  if (cluster.status === 'resolved') {
    const rel = relativeTimeAgo(cluster.updatedAt, now);
    t(`Resolved${rel ? ` ${rel}` : ''}`);
    if (cluster.assignee?.trim()) t(` by ${cluster.assignee.trim()}`);
    t(cluster.triageNote?.trim() ? `: "${cluster.triageNote.trim()}".` : '.');
    return done('resolved', null);
  }
  if (cluster.status === 'ignored') {
    t(cluster.triageNote?.trim() ? `Ignored: "${cluster.triageNote.trim()}".` : 'Ignored.');
    return done('ignored', null);
  }

  // A snooze the user set hides the cluster; it overrides the machine state.
  if (isCurrentlySnoozed({ snoozedUntil: cluster.snoozedUntil ?? null, snoozeMode: cluster.snoozeMode ?? null }, now)) {
    if (cluster.snoozeMode === 'until-recurs') {
      t('Snoozed until it recurs — open underneath.');
    } else {
      const until = toEpochMs(cluster.snoozedUntil ?? null);
      const when = until != null ? new Date(until).toISOString().slice(0, 10) : null;
      t(when ? `Snoozed until ${when} — open underneath.` : 'Snoozed — open underneath.');
    }
    return done('snoozed', 'unsnooze');
  }

  // Fix verification: a fix that regressed, held, or stopped the failures. It is
  // a stronger claim than the quarantine overlay below — a fix that landed
  // outranks tests that are merely parked.
  if (cluster.fixVerification === 'regressed') {
    const commit = cluster.fixCommit?.trim() ? shortCommit(cluster.fixCommit.trim()) : null;
    t(commit ? `Fixed by ${commit}, back since ` : 'Fixed earlier, back since ');
    run(cluster.regressedSinceRunId ?? cluster.lastSeenRunId);
    t(' — the fix did not hold.');
    return done('regressed', cluster.status === 'resolved' ? 'reopen' : null);
  }

  // The ticket closed and the failure stopped: the sentence says the failure
  // stopped, while the Issue line names the ticket and the Next line asks to
  // resolve; the state offers the reconcile (the resolve-on-close policy does it
  // automatically when it is on). A failure that goes on keeps its own sentence.
  const doneTicket = ticketReconcileKey(cluster, { failureGoesOn: project.failureGoesOn ?? true, now });
  if (doneTicket) {
    const rel = relativeTimeAgo(cluster.lastSeenAt, now);
    t(`Stopped failing, last seen${rel ? ` ${rel}` : ''} in `);
    run(cluster.lastSeenRunId);
    t('.');
    return done('ticket-done', 'mark-resolved');
  }

  // A verified fix at whose commit the diagnosed patch still applies may not be
  // the diagnosed change: no reconcile here, the Next line leads with the patch.
  if (cluster.fixVerification === 'diagnosis-verified') {
    t('Fixed in ');
    run(cluster.fixLandedRunId);
    const commit = cluster.fixCommit?.trim() ? shortCommit(cluster.fixCommit.trim()) : null;
    if (cluster.diagnosedPatchApplies) {
      t(
        `${commit ? ` (${commit})` : ''}, but the diagnosed patch still applies, so the change may not be in the code yet.`,
      );
      return done('fix-unconfirmed', null);
    }
    t(`${commit ? ` (${commit})` : ''} and verified, still marked open.`);
    return done('fix-verified-open', 'mark-resolved');
  }
  if (cluster.fixVerification === 'stopped-failing') {
    t('Stopped failing in ');
    run(cluster.fixLandedRunId);
    t(' — no fix identified, still open.');
    return done('stopped-failing-open', 'mark-resolved');
  }

  // Every test parked in quarantine: the cluster stays open until they are released.
  if (cluster.affectedTests > 0 && cluster.quarantinedTests >= cluster.affectedTests) {
    t(
      cluster.affectedTests === 1
        ? 'Its only test is quarantined; the cluster stays open until the test is released.'
        : `All ${cluster.affectedTests} tests are quarantined; the cluster stays open until they are released.`,
    );
    return done('quarantined', 'release');
  }

  // A pass at the failing commit proves no fix: say so after the state.
  const flakeEvidence = () => {
    const id = cluster.flakeEvidenceRunId;
    if (id == null || id <= cluster.lastSeenRunId) return;
    t(' Passed again at the same commit in ');
    run(id);
    t(', which is flake evidence, not a fix.');
  };

  // Still failing, or quiet-but-open.
  if (isFailing) {
    if (cluster.assignee?.trim()) {
      const since = relativeTimeAgo(cluster.updatedAt, now);
      const sinceDur = since && since !== 'just now' ? ` since ${since.replace(/ ago$/, '')}` : '';
      t(`Still failing — ${cluster.assignee.trim()} is on it${sinceDur}.`);
      flakeEvidence();
      return done('failing-assigned', null);
    }
    const rel = relativeTimeAgo(cluster.lastSeenAt, now);
    t(`Still failing — last seen${rel ? ` ${rel}` : ''} in `);
    run(cluster.lastSeenRunId);
    t('.');
    flakeEvidence();
    return done('failing', null);
  }

  const rel = toEpochMs(cluster.lastSeenAt ?? null);
  const span = rel != null ? durationApprox(now.getTime() - rel) : null;
  t(
    `Not seen for ${runsSinceLastSeen} run${runsSinceLastSeen === 1 ? '' : 's'}${span ? ` (${span})` : ''}, still open.`,
  );
  flakeEvidence();
  return done('quiet', 'mark-resolved');
}
