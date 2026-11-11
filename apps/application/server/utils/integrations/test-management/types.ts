/**
 * The neutral interface every test management client implements, next to the `IssueTracker` of the trackers. A
 * provider's file turns these types into its own endpoints and formats; the rest of the server reads only these.
 */
import type { TestManagementProviderName } from '#shared/integrations/registry';

/** A project of the test management tool. */
export interface TmProject {
  id: string;
  key: string;
  /** False for a project the tool lists but has not switched the test management app on for. */
  enabled: boolean;
}

/** A test case of a project's catalog. */
export interface TmCase {
  id: string;
  /** The tool's ID of the test case, `SHOP-T123` in Zephyr Scale. */
  key: string;
  name: string;
  /** The test case's status name, or null when the status list could not name it. */
  status: string | null;
  /** The folder's ID: the tool lists folders apart from cases. Null for a case at the project's root. */
  folderId: string | null;
}

/** A status a result can carry. */
export interface TmStatus {
  id: string;
  name: string;
  /** True for the status the tool gives a new result. */
  isDefault: boolean;
}

/** A folder test runs are filed under. */
export interface TmFolder {
  id: string;
  name: string;
  /** The parent folder's ID, null for a folder at the project's root. */
  parentId: string | null;
}

/** Where a paged read resumes. `null` starts at the first page. */
export type PageCursor = string | null;

/** One page of a paged read; `next` is null on the last page. */
export interface TmPage<T> {
  items: T[];
  next: PageCursor;
}

/** One result of a run: a test case's status. */
export interface TmResult {
  key: string;
  status: string;
  comment?: string;
}

/** What a client needs to create a test run with every result at once. */
export interface UploadRunInput {
  projectKey: string;
  name: string;
  description: string;
  folderId?: string;
  version?: string;
  results: TmResult[];
}

/** A test run in the tool. */
export interface TmRun {
  key: string;
  id: string;
  /** The run's page in the tool, or '' when the tool names none. Zephyr Scale answers with an API address only. */
  url: string;
}

/** The facts a retry uses to recognize a run an earlier attempt created. */
export interface RunMarker {
  runId: number;
  /** When to start looking for the run, an ISO time: the run's start, or the attempt's when the run has none. */
  startedAt: string;
  /** A test case the run reported on, whose last execution leads to the run. */
  testCaseKey: string;
  /** The name the run was given. */
  name: string;
}

export interface TestManagementProvider {
  readonly provider: TestManagementProviderName;
  whoAmI(): Promise<{ id: string; displayName: string }>;
  listProjects(): Promise<TmProject[]>;
  /** One page of a project's test cases per call: pass the previous page's `next` to read on. */
  listCases(projectKey: string, page: PageCursor): Promise<TmPage<TmCase>>;
  listStatuses(projectKey: string): Promise<TmStatus[]>;
  /** The folders a test run can be filed under. */
  listFolders(projectKey: string): Promise<TmFolder[]>;
  uploadRun?(input: UploadRunInput): Promise<TmRun>;
  findRun?(projectKey: string, marker: RunMarker): Promise<TmRun | null>;
  linkRun?(run: Pick<TmRun, 'key'>, link: { url: string; title: string }): Promise<void>;
  /** The web address of a test case, or null when the tool documents none. */
  caseUrl?(key: string): string | null;
}

/** The credential shape a test management client is constructed with. */
export interface TestManagementCredentials {
  apiToken: string;
}
