/**
 * Type declarations for the demo runs' project list. See `demo-run-projects.mjs`.
 */

export interface DemoRunProject {
  name: string;
  use?: { baseURL: string };
}

export declare function demoHtmlReport(
  projectNames: Iterable<unknown>,
  baseURL?: string | null,
): { projects: DemoRunProject[] };
