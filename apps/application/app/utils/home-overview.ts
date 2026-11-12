import type { ProjectOverview } from '~~/types/api';
import type { RecentRunCount } from '#shared/handlers/test-runs';
import { projectHealth } from '#shared/project-health';

/**
 * The project overview within home's environment filter: each project's trend
 * runs of the picked environments, and its latest full run and tendency read
 * again from those runs (`projectHealth`), so the stat strip and the Project
 * health table count what the bars show. A project with no run there drops out;
 * with no environment picked every project stays as the server sent it.
 */
export function overviewInEnvironments(projects: ProjectOverview[], environments: string[]): ProjectOverview[] {
  if (environments.length === 0) return projects;
  return projects
    .map((project) => {
      const recentRuns = project.recentRuns.filter((r) => !!r.environment && environments.includes(r.environment));
      const { latest, tendency } = projectHealth(recentRuns);
      return {
        ...project,
        recentRuns,
        latestFullRun: latest
          ? {
              id: latest.id,
              status: latest.status,
              startTime: latest.startTime,
              duration: latest.duration ?? null,
              passedTests: latest.passedTests,
              failedTests: latest.failedTests,
              flakyTests: latest.flakyTests,
              totalTests: latest.totalTests,
            }
          : null,
        tendency,
      };
    })
    .filter((project) => project.recentRuns.length > 0);
}

/**
 * How many of the counted runs home's recent activity lists: the picked environments (every one when none), full runs
 * only when it says so, the viewer's own runs whatever the run kind.
 */
export function runsInFilters(
  counts: readonly RecentRunCount[],
  filters: { environments: string[]; fullRunsOnly: boolean },
): number {
  let runs = 0;
  for (const c of counts) {
    if (filters.fullRunsOnly && !c.isFullRun && !c.mine) continue;
    if (filters.environments.length > 0 && !(c.environment && filters.environments.includes(c.environment))) continue;
    runs += c.runs;
  }
  return runs;
}
