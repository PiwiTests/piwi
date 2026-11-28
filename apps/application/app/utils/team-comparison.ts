/**
 * Compare with team instance, in the desktop app's pages: the sentence that says why the app cannot compare, for the
 * problems a person can act on or should hear of. Nothing shows while the app is connected to no team instance: the
 * comparison is not set up, which is no problem. Connected, a project whose folder is linked to no team project says
 * so, with a link to Settings → Team instance (`teamComparisonNeedsLink`).
 */
import type { DesktopTeamComparison } from '~~/server/utils/desktop-team-comparison';

/** The sentence a page shows when the app cannot compare; null when it compared, or when it shows nothing. */
export function teamComparisonProblem(comparison: DesktopTeamComparison | null): string | null {
  if (!comparison || comparison.status === 'ok') return null;
  switch (comparison.problem) {
    case 'not-connected':
      return null;
    case 'no-folder':
      return 'This project has no folder on this machine: link it under Project → Settings → Local folder, then pick its team project on Settings → Team instance.';
    case 'no-team-project':
      return 'This project’s folder is linked to no project of the team instance.';
    case 'reconnect':
      return 'The connection to the team instance was made before the app could compare: connect it again in Settings → Team instance.';
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

/** Whether the app is connected and the project's folder still needs linking to a team project, on Settings → Team instance. */
export function teamComparisonNeedsLink(comparison: DesktopTeamComparison | null): boolean {
  return comparison?.status === 'unavailable' && comparison.problem === 'no-team-project';
}
