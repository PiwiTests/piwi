/**
 * Compare with team instance, in the desktop app's pages: the sentence that says why the app cannot compare, for the
 * problems a person can act on or should hear of. Nothing shows while the app is connected to no team instance, or
 * the folder is linked to no project of it: the comparison is not set up, which is no problem.
 */
import type { DesktopTeamComparison } from '~~/server/utils/desktop-team-comparison';

/** The sentence a page shows when the app cannot compare; null when it compared, or when it shows nothing. */
export function teamComparisonProblem(comparison: DesktopTeamComparison | null): string | null {
  if (!comparison || comparison.status === 'ok') return null;
  switch (comparison.problem) {
    case 'not-connected':
    case 'no-folder':
    case 'no-team-project':
      return null;
    case 'reconnect':
      return 'The connection to the team instance was made before the app could compare: connect it again in Settings → Desktop app.';
    case 'not-supported':
      return 'The team instance cannot compare yet: it needs a newer Piwi.';
    case 'unreachable':
      return 'The team instance did not answer.';
    case 'unreadable':
      return 'The team instance answered something this app cannot read.';
    default:
      return comparison.message;
  }
}

/** Whether a page shows the comparison: it compared, or the app cannot and says why. */
export function teamComparisonShown(comparison: DesktopTeamComparison | null): boolean {
  return comparison?.status === 'ok' || teamComparisonProblem(comparison) !== null;
}
