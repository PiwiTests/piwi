import { describe, it, expect } from 'vitest';
import {
  INBOX_QUEUES,
  isInboxQueue,
  computeSnooze,
  isCurrentlySnoozed,
  isSnoozedBack,
  wakeOnRecurrence,
  personIsUser,
  isMine,
  inboxIdentity,
  effectiveAssignee,
  isNewSince,
  clusterInQueue,
  countQueues,
  clusterClue,
  parseBulkIds,
  isSnoozeOption,
  SNOOZE_FOREVER_MS,
  type InboxClusterLike,
  groupIncidentClusters,
} from '#shared/inbox-queues';

describe('queue identity', () => {
  it('lists all open as the first queue', () => {
    expect(INBOX_QUEUES[0]).toBe('all');
  });
  it('recognizes valid queue ids', () => {
    expect(isInboxQueue('mine')).toBe(true);
    expect(isInboxQueue('nope')).toBe(false);
    expect(isInboxQueue(null)).toBe(false);
  });
});

describe('snooze', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  it('parks a timed snooze at the deadline', () => {
    const day = computeSnooze('1-day', now);
    expect(day.snoozeMode).toBe('until');
    expect(day.snoozedUntil.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    const week = computeSnooze('1-week', now);
    expect(week.snoozedUntil.getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  it('parks "until it recurs" far in the future', () => {
    const s = computeSnooze('until-recurs', now);
    expect(s.snoozeMode).toBe('until-recurs');
    expect(s.snoozedUntil.getTime()).toBe(SNOOZE_FOREVER_MS);
  });

  it('hides a cluster only while the deadline is ahead', () => {
    const future = new Date(now.getTime() + 1000);
    const past = new Date(now.getTime() - 1000);
    expect(isCurrentlySnoozed({ snoozedUntil: future }, now)).toBe(true);
    expect(isCurrentlySnoozed({ snoozedUntil: past }, now)).toBe(false);
    expect(isCurrentlySnoozed({ snoozedUntil: null }, now)).toBe(false);
  });

  it('wakes an until-recurs snooze on a fresh occurrence, clearing the deadline', () => {
    const snoozed = computeSnooze('until-recurs', now);
    expect(wakeOnRecurrence(snoozed)).toEqual({ snoozedUntil: null });
    // A timed snooze rides out its deadline instead of waking on recurrence.
    expect(wakeOnRecurrence(computeSnooze('1-day', now))).toBeNull();
    // Nothing snoozed → nothing to do.
    expect(wakeOnRecurrence({ snoozedUntil: null, snoozeMode: null })).toBeNull();
  });

  it('flags a recurred until-recurs cluster as "snoozed, back"', () => {
    expect(isSnoozedBack({ snoozeMode: 'until-recurs', snoozedUntil: null })).toBe(true);
    // Still snoozed → not back yet.
    expect(isSnoozedBack({ snoozeMode: 'until-recurs', snoozedUntil: new Date(SNOOZE_FOREVER_MS) })).toBe(false);
    // A timed wake is not a "back" badge.
    expect(isSnoozedBack({ snoozeMode: 'until', snoozedUntil: null })).toBe(false);
  });

  it('validates snooze options', () => {
    expect(isSnoozeOption('1-week')).toBe(true);
    expect(isSnoozeOption('forever')).toBe(false);
  });
});

describe('mine / user match', () => {
  const user = { name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' };

  it('matches on name, username or email, case-insensitively', () => {
    expect(personIsUser('ada@example.com', user)).toBe(true);
    expect(personIsUser('ADA', user)).toBe(true);
    expect(personIsUser('Ada Lovelace', user)).toBe(true);
    expect(personIsUser('someone else', user)).toBe(false);
    expect(personIsUser('', user)).toBe(false);
    expect(personIsUser('ada', null)).toBe(false);
  });

  it('is mine when the assignee or the owner names the user', () => {
    expect(isMine({ assignee: 'ada@example.com' }, user)).toBe(true);
    expect(isMine({ assignee: null, owner: { name: 'ada' } }, user)).toBe(true);
    expect(isMine({ assignee: 'bob', owner: { name: 'carol' } }, user)).toBe(false);
    expect(isMine({ assignee: 'ada' }, null)).toBe(false);
  });

  it("is one identity everywhere: the signed-in user's name, username and email", () => {
    const signedIn = inboxIdentity({ name: 'Ada Lovelace', username: 'ada', email: 'ada@example.com' });
    for (const assignee of ['Ada Lovelace', 'ada', 'ada@example.com']) {
      expect(isMine({ assignee }, signedIn), assignee).toBe(true);
    }
    expect(inboxIdentity(null)).toBeNull();
  });

  it('prefers the assignee over the owner for the effective owner line', () => {
    expect(effectiveAssignee({ assignee: 'bob', owner: { name: 'carol' } })).toBe('bob');
    expect(effectiveAssignee({ assignee: null, owner: { name: 'carol' } })).toBe('carol');
    expect(effectiveAssignee({ assignee: null, owner: null })).toBeNull();
  });
});

describe('new since', () => {
  const cut = Date.UTC(2026, 8, 1); // 2026-09-01

  it('is new when first seen or last recurred after the cut', () => {
    expect(isNewSince({ firstSeenAt: new Date(cut + 1000), lastSeenAt: new Date(cut + 1000) }, cut)).toBe(true);
    // Old first-seen but a recent recurrence still counts as new.
    expect(isNewSince({ firstSeenAt: new Date(cut - 5000), lastSeenAt: new Date(cut + 5000) }, cut)).toBe(true);
    // Entirely before the cut → not new.
    expect(isNewSince({ firstSeenAt: new Date(cut - 5000), lastSeenAt: new Date(cut - 1000) }, cut)).toBe(false);
  });

  it('treats every cluster as new on the first visit (null cut)', () => {
    expect(isNewSince({ firstSeenAt: new Date(0), lastSeenAt: new Date(0) }, null)).toBe(true);
  });
});

describe('queue membership + counts', () => {
  const user = { name: 'Ada', username: 'ada', email: 'ada@example.com' };
  const cut = Date.UTC(2026, 8, 1);
  const clusters: InboxClusterLike[] = [
    { firstSeenAt: new Date(cut + 1000), lastSeenAt: new Date(cut + 1000), assignee: 'ada' },
    { firstSeenAt: new Date(cut - 9000), lastSeenAt: new Date(cut - 9000), fixVerification: 'regressed' },
    { firstSeenAt: new Date(cut - 9000), lastSeenAt: new Date(cut - 9000), regressionOnDefault: true },
    { firstSeenAt: new Date(cut - 9000), lastSeenAt: new Date(cut - 9000), quarantineReadyCount: 2 },
    { firstSeenAt: new Date(cut - 9000), lastSeenAt: new Date(cut - 9000), mergeSuggestionPending: true },
  ];

  it('routes each cluster to the right queue', () => {
    expect(clusterInQueue(clusters[0]!, 'mine', { user })).toBe(true);
    expect(clusterInQueue(clusters[0]!, 'new', { lastVisitMs: cut })).toBe(true);
    expect(clusterInQueue(clusters[1]!, 'fix-didnt-hold')).toBe(true);
    expect(clusterInQueue(clusters[2]!, 'regressions')).toBe(true);
    expect(clusterInQueue(clusters[3]!, 'quarantine-ready')).toBe(true);
    expect(clusterInQueue(clusters[4]!, 'merge-suggestions')).toBe(true);
    // Every cluster is in "all".
    expect(clusters.every((c) => clusterInQueue(c, 'all'))).toBe(true);
  });

  it('counts each queue', () => {
    const counts = countQueues(clusters, { user, lastVisitMs: cut });
    expect(counts.all).toBe(5);
    expect(counts.new).toBe(1);
    expect(counts.mine).toBe(1);
    expect(counts.regressions).toBe(1);
    expect(counts['fix-didnt-hold']).toBe(1);
    expect(counts['quarantine-ready']).toBe(1);
    expect(counts['merge-suggestions']).toBe(1);
  });
});

describe('cluster clue', () => {
  it('flags a regressed fix first', () => {
    expect(clusterClue({ errorType: 'timeout', fixVerification: 'regressed' })?.strength).toBe('strong');
  });
  it('names the selector on a timeout', () => {
    expect(clusterClue({ errorType: 'timeout', selector: "getByRole('button')" })?.text).toContain('getByRole');
  });
  it('is null for an unknown error type with no signal', () => {
    expect(clusterClue({ errorType: 'unknown' })).toBeNull();
    expect(clusterClue({ errorType: null })).toBeNull();
  });
});

describe('bulk id validation', () => {
  it('accepts a list of positive integers and dedupes', () => {
    expect(parseBulkIds([1, 2, 2, 3])).toEqual([1, 2, 3]);
    expect(parseBulkIds(['4', 5])).toEqual([4, 5]);
  });
  it('rejects empty, non-array, non-positive, or oversized input', () => {
    expect(parseBulkIds([])).toBeNull();
    expect(parseBulkIds('nope')).toBeNull();
    expect(parseBulkIds([0])).toBeNull();
    expect(parseBulkIds([1.5])).toBeNull();
    expect(parseBulkIds([-1])).toBeNull();
    expect(parseBulkIds(Array.from({ length: 201 }, (_, i) => i + 1))).toBeNull();
  });
});

describe('groupIncidentClusters', () => {
  const incident = { runId: 930, reason: '41 of 44 tests failed', host: 'staging.example.test', startedAt: null };

  it('collapses the clusters an incident run opened into one row per run', () => {
    const clusters = [
      { id: 1, projectId: 1, incidentRun: null },
      { id: 2, projectId: 1, incidentRun: incident },
      { id: 3, projectId: 1, incidentRun: incident },
      { id: 4, projectId: 2, incidentRun: { ...incident, runId: 931 } },
      { id: 5, projectId: 1 },
    ];
    const { clusters: rest, incidents } = groupIncidentClusters(clusters);
    expect(rest.map((c) => c.id)).toEqual([1, 5]);
    expect(incidents.map((row) => [row.runId, row.projectId, row.clusters.map((c) => c.id)])).toEqual([
      [930, 1, [2, 3]],
      [931, 2, [4]],
    ]);
    expect(incidents[0]).toMatchObject({ reason: '41 of 44 tests failed', host: 'staging.example.test' });
  });

  it('leaves an inbox with no incident as it is', () => {
    const clusters = [{ id: 1, projectId: 1, incidentRun: null }];
    expect(groupIncidentClusters(clusters)).toEqual({ clusters, incidents: [] });
  });
});
