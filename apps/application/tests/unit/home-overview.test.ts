import { describe, expect, test } from 'vitest';
import { overviewInEnvironments } from '../../app/utils/home-overview';
import type { ProjectOverview, ProjectOverviewRun } from '../../types/api';

let nextId = 1;
function run(environment: string, status: string, passedTests = 10): ProjectOverviewRun {
  return {
    id: nextId++,
    status,
    passedTests,
    failedTests: 10 - passedTests,
    flakyTests: 0,
    totalTests: 10,
    startTime: new Date(Date.UTC(2026, 10, 1, nextId)),
    environment,
    duration: 60_000,
  };
}

/** A project whose staging runs pass while production fails, as the server sends it: every environment counted. */
function shop(): ProjectOverview {
  const recentRuns = [run('staging', 'passed'), run('production', 'failed', 4), run('staging', 'passed')];
  recentRuns.push(run('production', 'failed', 2));
  const latest = recentRuns.at(-1)!;
  return {
    id: 1,
    name: 'shop',
    label: null,
    tags: [],
    totalFullRuns: 4,
    latestFullRun: { ...latest, duration: latest.duration ?? null },
    recentRuns,
    tendency: 'failing',
  };
}

describe('overviewInEnvironments', () => {
  test('reads the latest run and the tendency from the runs of the picked environments', () => {
    const [project] = overviewInEnvironments([shop()], ['staging']);
    expect(project!.recentRuns.every((r) => r.environment === 'staging')).toBe(true);
    expect(project!.tendency).toBe('passing');
    expect(project!.latestFullRun).toMatchObject({
      status: 'passed',
      passedTests: 10,
      totalTests: 10,
      duration: 60_000,
    });
  });

  test('leaves out a run still in progress there', () => {
    const project = shop();
    project.recentRuns.push(run('staging', 'running', 0));
    const [filtered] = overviewInEnvironments([project], ['staging']);
    expect(filtered!.latestFullRun).toMatchObject({ status: 'passed', passedTests: 10 });
  });

  test('drops a project with no run there, and keeps every project as it is with no environment picked', () => {
    expect(overviewInEnvironments([shop()], ['qa'])).toEqual([]);
    const projects = [shop()];
    expect(overviewInEnvironments(projects, [])).toBe(projects);
  });
});
