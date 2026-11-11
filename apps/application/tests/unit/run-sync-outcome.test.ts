import { describe, expect, test } from 'vitest';
import { outcomeUnknownLines } from '../../app/utils/run-sync-outcome';

/** What the run's sync panel says when an upload's outcome is unknown. */
describe('an upload whose outcome is unknown', () => {
  test('tells a reader who can send it again what Sync again does', () => {
    expect(outcomeUnknownLines('Piwi #12 main', true)).toEqual({
      status: 'Outcome unknown: the upload may have reached the tool.',
      next: 'Sync again looks there for the test run “Piwi #12 main” first and links it when it exists.',
    });
  });

  test('names no button to a reader who cannot send it again', () => {
    const lines = outcomeUnknownLines('Piwi #12 main', false);
    expect(lines.next).toBe(
      'Check there for the test run “Piwi #12 main”. A project Maintainer can send the results again.',
    );
    expect(`${lines.status} ${lines.next}`).not.toMatch(/Sync again/);
  });

  test.each([true, false])('names the test run once (can send again: %s)', (canSendAgain) => {
    const { status, next } = outcomeUnknownLines('Piwi #12 main', canSendAgain);
    expect(`${status} ${next}`.split('Piwi #12 main')).toHaveLength(2);
  });

  test('reads without a name when the run has none', () => {
    expect(outcomeUnknownLines(null, false).next).toBe(
      'Check there for the test run. A project Maintainer can send the results again.',
    );
  });
});
