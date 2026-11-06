/**
 * The Playwright projects a demo run's metadata lists (`htmlReport.projects`),
 * for the seed generator and the run simulator: the projects the run's own
 * executions ran, so the list and the executions' `browser_name` agree.
 * Deterministic (no randomness), so the seed stays byte-stable. Pure plain JS,
 * run under Node for the generator and in the browser for the simulator.
 */

/**
 * A run's `htmlReport`: one project per distinct project name of its
 * executions' browser configs, in the order they first appear, each with the
 * `use` the reporter records for a project: its `browserName`, the run's
 * `baseURL` when it has one, and its `viewport` when the config sets one. A
 * config whose `projectName` is not a non-empty string is skipped.
 *
 * @param {Iterable<{ projectName?: unknown, browserName?: unknown, viewport?: unknown } | null | undefined>} browsers
 *   the browser config of each execution of the run
 * @param {string | null} [baseURL] the `use.baseURL` of the run's projects
 */
export function demoHtmlReport(browsers, baseURL = null) {
  const projects = new Map();
  for (const browser of browsers) {
    const name = browser?.projectName;
    if (typeof name !== 'string' || !name || projects.has(name)) continue;
    const use = {};
    if (typeof browser.browserName === 'string' && browser.browserName) use.browserName = browser.browserName;
    if (baseURL) use.baseURL = baseURL;
    if (browser.viewport !== undefined) use.viewport = browser.viewport;
    projects.set(name, { name, use });
  }
  return { projects: [...projects.values()] };
}
