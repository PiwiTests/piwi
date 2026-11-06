import { describe, expect, test } from 'vitest';
import { runReadEndedNotice } from '../../app/utils/run-read-ended';

describe('runReadEndedNotice', () => {
  test('a deleted run says so, for a running run and a finished one alike, and offers nothing', () => {
    for (const authEnabled of [true, false]) {
      const notice = runReadEndedNotice('gone', authEnabled);
      expect(notice).toMatchObject({ title: 'This run no longer exists', action: null });
      expect(notice.description).not.toMatch(/follow/);
    }
  });

  test('with Piwi’s authentication on, an ended session or a removed access offers to sign in again', () => {
    expect(runReadEndedNotice('signed-out', true)).toMatchObject({
      title: 'Your session has ended',
      action: 'sign-in',
    });
    expect(runReadEndedNotice('forbidden', true)).toMatchObject({
      title: 'Your access to this run was removed',
      action: 'sign-in',
    });
  });

  test('without it, nothing offers to sign in: the page offers to load itself again', () => {
    for (const failure of ['signed-out', 'forbidden'] as const) {
      const notice = runReadEndedNotice(failure, false);
      expect(notice.action).toBe('reload');
      expect(`${notice.title} ${notice.description}`).not.toMatch(/sign in|session/i);
    }
  });
});
