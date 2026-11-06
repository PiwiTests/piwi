/**
 * Type declarations for the demo runs' project list. See `demo-run-projects.mjs`.
 */

export interface DemoRunProject {
  name: string;
  use: { browserName?: string; baseURL?: string; viewport?: unknown };
}

export declare function demoHtmlReport(
  browsers: Iterable<{ projectName?: unknown; browserName?: unknown; viewport?: unknown } | null | undefined>,
  baseURL?: string | null,
): { projects: DemoRunProject[] };
