/**
 * Compare with team instance, on the desktop app's pages: nothing shows while the comparison is not set up (no
 * connection, no folder, no team project); a problem a person can act on shows one sentence; a refusal shows the team
 * instance's own message.
 */
import { describe, expect, test } from 'vitest';
import { teamComparisonProblem, teamComparisonShown } from '~/utils/team-comparison';
import type { DesktopTeamComparison, DesktopTeamComparisonProblem } from '~~/server/utils/desktop-team-comparison';

const unavailable = (problem: DesktopTeamComparisonProblem, message = 'Compare with team instance is off.') =>
  ({ status: 'unavailable', problem, message }) as DesktopTeamComparison;

describe('teamComparisonProblem', () => {
  test('says nothing while the comparison is not set up', () => {
    for (const problem of ['not-connected', 'no-folder', 'no-team-project'] as const) {
      expect(teamComparisonProblem(unavailable(problem))).toBeNull();
      expect(teamComparisonShown(unavailable(problem))).toBe(false);
    }
    expect(teamComparisonShown(null)).toBe(false);
  });

  test('says what a person can act on', () => {
    expect(teamComparisonProblem(unavailable('reconnect'))).toMatch(/connect it again/);
    expect(teamComparisonProblem(unavailable('not-supported'))).toMatch(/newer Piwi/);
    expect(teamComparisonProblem(unavailable('unreachable'))).toBe('The team instance did not answer.');
    expect(teamComparisonShown(unavailable('unreadable'))).toBe(true);
  });

  test('shows the team instance’s own refusal', () => {
    expect(teamComparisonProblem(unavailable('refused'))).toBe('Compare with team instance is off.');
  });

  test('shows a comparison, with no problem', () => {
    const ok = { status: 'ok' } as DesktopTeamComparison;
    expect(teamComparisonProblem(ok)).toBeNull();
    expect(teamComparisonShown(ok)).toBe(true);
  });
});
