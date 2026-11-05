/**
 * The Playwright projects a demo run's metadata lists (`htmlReport.projects`),
 * for the seed generator and the run simulator: the projects the run's own
 * executions ran, so the list and the executions' `browser_name` agree.
 * Deterministic (no randomness), so the seed stays byte-stable. Pure plain JS,
 * run under Node for the generator and in the browser for the simulator.
 */

/**
 * A run's `htmlReport`: one project per distinct project name of its
 * executions, in the order they first appear, each with the run's `baseURL`
 * when it has one. Values that are not a non-empty string are skipped.
 *
 * @param {Iterable<unknown>} projectNames the project name of each execution of the run
 * @param {string | null} [baseURL] the `use.baseURL` of the run's projects
 */
export function demoHtmlReport(projectNames, baseURL = null) {
  const names = new Set();
  for (const name of projectNames) if (typeof name === 'string' && name) names.add(name);
  return { projects: [...names].map((name) => (baseURL ? { name, use: { baseURL } } : { name })) };
}
