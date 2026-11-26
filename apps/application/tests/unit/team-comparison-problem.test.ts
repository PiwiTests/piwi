/**
 * Compare with team instance, on the desktop app's pages: nothing shows while the app is connected to no team instance;
 * connected, a folder that still needs linking to a team project says so, with a link to Settings → Team instance; a
 * problem a person can act on shows one sentence; a refusal shows the team instance's own message.
 */
import { describe, expect, test } from 'vitest';
import { teamComparisonNeedsLink, teamComparisonProblem, teamComparisonShown } from '~/utils/team-comparison';
import type { DesktopTeamComparison, DesktopTeamComparisonProblem } from '~~/server/utils/desktop-team-comparison';

const unavailable = (problem: DesktopTeamComparisonProblem, message = 'Compare with team instance is off.') =>
  ({ status: 'unavailable', problem, message }) as DesktopTeamComparison;

describe('teamComparisonProblem', () => {
  test('says nothing while the app is connected to no team instance', () => {
    expect(teamComparisonProblem(unavailable('not-connected'))).toBeNull();
    expect(teamComparisonShown(unavailable('not-connected'))).toBe(false);
    expect(teamComparisonNeedsLink(unavailable('not-connected'))).toBe(false);
    expect(teamComparisonShown(null)).toBe(false);
  });

  test('says when the project’s folder still needs linking to a team project, and links the page that does it', () => {
    expect(teamComparisonProblem(unavailable('no-team-project'))).toMatch(/linked to no project of the team instance/);
    expect(teamComparisonProblem(unavailable('no-folder'))).toMatch(/no folder on this machine/);
    for (const problem of ['no-folder', 'no-team-project'] as const) {
      expect(teamComparisonShown(unavailable(problem))).toBe(true);
      expect(teamComparisonNeedsLink(unavailable(problem))).toBe(true);
    }
    expect(teamComparisonNeedsLink(unavailable('reconnect'))).toBe(false);
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
