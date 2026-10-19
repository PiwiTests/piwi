import { describe, expect, test } from 'vitest';
import { trackerSyncToast } from '../../app/utils/tracker-sync';

describe('trackerSyncToast', () => {
  test('says when no link was due', () => {
    expect(trackerSyncToast({ refreshed: 0, failed: 0, skipped: 0 })).toEqual({
      title: 'Statuses synced',
      description: 'No linked issue was due for a refresh.',
      color: 'success',
    });
  });

  test('counts the links it refreshed', () => {
    expect(trackerSyncToast({ refreshed: 1, failed: 0, skipped: 0 })).toEqual({
      title: 'Statuses synced',
      description: 'Refreshed 1 link.',
      color: 'success',
    });
  });

  test('counts failed and skipped links together as unread, as a warning', () => {
    expect(trackerSyncToast({ refreshed: 3, failed: 1, skipped: 1 })).toEqual({
      title: 'Statuses synced',
      description: 'Refreshed 3 links. Could not read 2 links: test the connection to see why.',
      color: 'warning',
    });
  });
});
