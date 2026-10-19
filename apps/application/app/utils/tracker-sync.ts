/** The counts one status-sync sweep answers with (`POST /api/integrations/sync`). */
export interface TrackerSyncCounts {
  refreshed: number;
  failed: number;
  skipped: number;
}

export interface TrackerSyncToast {
  title: string;
  description: string;
  color: 'success' | 'warning';
}

const links = (n: number) => `${n} link${n === 1 ? '' : 's'}`;

/** The toast a status sync run from the settings page shows: what it refreshed, and what it could not read. */
export function trackerSyncToast(result: TrackerSyncCounts): TrackerSyncToast {
  const unread = result.failed + result.skipped;
  if (result.refreshed === 0 && unread === 0) {
    return { title: 'Statuses synced', description: 'No linked issue was due for a refresh.', color: 'success' };
  }
  const parts = [`Refreshed ${links(result.refreshed)}.`];
  if (unread > 0) parts.push(`Could not read ${links(unread)}: test the connection to see why.`);
  return { title: 'Statuses synced', description: parts.join(' '), color: unread > 0 ? 'warning' : 'success' };
}
