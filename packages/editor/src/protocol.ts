/**
 * The Piwi editor service's own requests, beside the language server protocol.
 * Diagnostics, quick fixes and hover go through the protocol; what the two
 * editors render differently (the lines above a file, a test or a locator)
 * goes through these requests, and each client draws them natively: CodeLens
 * in VS Code, Code Vision in the JetBrains IDEs.
 */

/** A command a summary line runs when clicked. Clients implement each `command` id. */
export interface PiwiCommand {
  title: string;
  /**
   * `piwi.openInDashboard` (arguments: `[url]`), `piwi.runTests` (arguments: `[RunTestsArgs]`),
   * `piwi.openTrace` (arguments: `[TraceParams]`), `piwi.openScreenshot` (arguments: `[ScreenshotParams]`),
   * `piwi.runCommand` (arguments: `[RunCommandArgs]`), `piwi.copyText` (arguments: `[text]`) or
   * `piwi.desktopJob` (arguments: `[DesktopJobParams]`).
   */
  command:
    | 'piwi.openInDashboard'
    | 'piwi.runTests'
    | 'piwi.openTrace'
    | 'piwi.openScreenshot'
    | 'piwi.runCommand'
    | 'piwi.copyText'
    | 'piwi.desktopJob';
  arguments: unknown[];
}

/** An edit of a file, as the language server protocol's `TextEdit`: `newText` in place of `range` (0-based). */
export interface FileEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

/** One line of text shown above a line of a file. */
export interface SummaryLine {
  /** 0-based line the text sits above. */
  line: number;
  title: string;
  command?: PiwiCommand;
  /**
   * On a test's line: its latest result, which the clients show in the gutter, with `title`
   * as its tooltip, rather than as text above the line. Absent on other lines.
   */
  status?: TestLineStatus;
  /** On a test's line: the 0-based line its `test(…)` call ends on, for the background of a failing test. */
  endLine?: number;
  /** On the line of a test that failed in the latest run the service reads: where and why. */
  failure?: TestFailure;
  /** On a test's line: the test's id, for a client's own **Run** (`RunTestsArgs.testIds`). Absent on other lines. */
  testCaseId?: number;
}

/**
 * A test's latest result: `failed` when it failed in the latest run the service reads; `running` while the run in
 * progress the service follows runs it, and that run's result as soon as it ends the test.
 */
export type TestLineStatus = 'passed' | 'failed' | 'flaky' | 'skipped' | 'running' | 'unknown';

/**
 * Where and why a test failed. The lines above `line` (the reason, the screenshot, the trace) are
 * ordinary summary lines.
 */
export interface TestFailure {
  /**
   * 0-based line of this file the failure went through, followed through the edits since the run: the innermost
   * frame of the error's stack within the test, else within this file, else the `test(…)` line.
   */
  line: number;
  /** One line on why it failed. */
  headline: string | null;
  /** The error without its stack trace, shortened; null when the instance does not send it. */
  message: string | null;
  executionId: number;
  /** The execution's page in the dashboard. */
  url: string;
  /**
   * `edited` once the line the run failed at changed since (the test stays `failed` until a run covers it),
   * `failing` otherwise. Absent from an older service.
   */
  state?: 'failing' | 'edited';
}

/**
 * `piwi/fileSummary`: what to show above a file and above its test and locator lines, and above each function of an
 * application file its tests ran.
 */
export interface FileSummaryParams {
  uri: string;
}

export interface FileSummary {
  /** The line shown at the top of the file; null when Piwi knows nothing about it. */
  file: SummaryLine | null;
  lines: SummaryLine[];
}

export const FILE_SUMMARY_REQUEST = 'piwi/fileSummary';

/** A test as the editors list it. */
export interface EditorTest {
  id: number;
  title: string;
  file: string;
  status: 'passed' | 'flaky' | 'failed' | 'skipped' | null;
  /** The test's page in the dashboard. */
  url: string;
}

/** `piwi/testsForFile`: the tests that reach a file (application code), or that a test file defines. */
export interface TestsForFileParams {
  uri: string;
}

export interface TestsForFile {
  tests: EditorTest[];
  /** How the tests were found: `defined` in a spec file, `reach` through code reach, `locators` through call sites. */
  basis: 'defined' | 'reach' | 'locators' | 'none';
}

export const TESTS_FOR_FILE_REQUEST = 'piwi/testsForFile';

/** `piwi/testAt`: the test whose `test(…)` call holds a position of a spec, and the spec's tests. */
export interface TestAtParams {
  uri: string;
  /** 0-based position. */
  line: number;
  character: number;
}

export interface TestAtResult {
  /** The test whose `test(…)` call spans `line`; null outside every test Piwi knows. */
  test: EditorTest | null;
  /** The spec's tests Piwi knows, which `piwi/runArgs` runs; null for a file that is not a spec or holds none of them. */
  spec: { uri: string; testIds: number[] } | null;
}

export const TEST_AT_REQUEST = 'piwi/testAt';

/** `piwi/coverage`: the lines of an application file the project's tests ran, placed on the file as it stands. */
export interface CoverageParams {
  uri: string;
}

/** Lines `start` to `end`, 0-based and inclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

/** Lines the tests ran, and how many tests ran each. */
export interface ExecutedSpan extends LineSpan {
  tests: number;
}

/**
 * Where the marks come from: `exact`, the coverage was recorded on the file as it stands (its git blob id); `mapped`,
 * on another version, the file as saved or one the repository holds, whose lines are placed on the file through the
 * diff between the two; `other-version`, only on versions the repository does not hold, so no line is marked; `none`,
 * no coverage names lines of this file (a test file, coverage turned off, file-level coverage only, or an instance
 * without coverage).
 */
export type CoverageState = 'exact' | 'mapped' | 'other-version' | 'none';

export interface CoverageResult {
  uri: string;
  state: CoverageState;
  /** The lines the tests ran; consecutive lines run by as many tests are one span. */
  executed: ExecutedSpan[];
  /** The executable lines no test ran; empty unless a run recorded the executable lines of the version shown. */
  notRun: LineSpan[];
  /** The lines changed since the version the coverage was recorded on, with `mapped`: what runs them is not known. */
  changed: LineSpan[];
  /** The tests whose coverage the marks show: those that recorded the version shown, or with `other-version`, any. */
  tests: number;
  /** The lines marked as run. */
  executedLines: number;
  /** The executable lines of the version shown, as placed on the file; null when no run recorded them. */
  executableLines: number | null;
  /** The git blob id of the version the marks come from; null with `other-version` and `none`. */
  blob: string | null;
  /**
   * The marks in a few words, for a tooltip: `41 of 63 lines run by 6 tests · 3 lines changed since the coverage run`,
   * `6 tests ran another version of this file`; null with `none`.
   */
  label: string | null;
}

export const COVERAGE_REQUEST = 'piwi/coverage';

/**
 * `piwi/coverageChanged` (notification, server to client): the marks of a file the client asked `piwi/coverage` about
 * changed: an edit moved them, the coverage was read again (a refresh, a run that ended), or it arrived after the
 * request was answered. Carries `CoverageResult`, which replaces what the client holds for its `uri`.
 */
export const COVERAGE_NOTIFICATION = 'piwi/coverageChanged';

/** A line breakpoint of the editor: the file and its 0-based line. */
export interface EditorBreakpoint {
  uri: string;
  line: number;
}

/** `piwi/runArgs`: the command line that runs tests, as `piwi run` builds it. */
export interface RunTestsArgs {
  /** Any file of the workspace the tests belong to, to pick the Playwright config when `root` does not name it. */
  uri: string;
  /** The folder of the Playwright config to run them with, as `WorkspaceFailure.root` names it. */
  root?: string;
  testIds: number[];
  /**
   * The editor's enabled line breakpoints. Those in files under the Playwright config's folder pause the run before a
   * locator action or assertion on their line, headed, with Piwi's pause bar (`PIWI_PAUSE_AT` in `RunCommand.env`).
   */
  breakpoints?: EditorBreakpoint[];
  /**
   * The coverage the run records, so it refreshes the marks of the file whose coverage lens started it: `server`, the
   * backend's by line (`PIWI_COVERAGE_SERVER=lines` in `RunCommand.env`); `browser`, the browser's by function
   * (`PIWI_COVERAGE_BROWSER=functions`). The reporter reads them when the Playwright config leaves `coverage` unset.
   * Set by those lenses; absent otherwise.
   */
  coverage?: 'server' | 'browser';
}

export interface RunCommand {
  /** The directory to run it in: the Playwright config's. */
  cwd: string;
  /** The whole command, ready for a terminal. */
  command: string;
  /** The arguments after `playwright test`. */
  args: string[];
  /** Environment variables to set on the command's process. */
  env?: Record<string, string>;
  /**
   * The ref the run carries (`PIWI_ORIGIN_REF` in `env`), by which the service finds and follows it: the client
   * names it in `piwi/commandEnded` once the command ends. Absent from an older service.
   */
  ref?: string;
  /**
   * A sentence for the client to show once as a warning while the command runs anyway: breakpoints were passed to a
   * project whose `@piwitests/reporter` does not pause at them. Absent otherwise.
   */
  notice?: string;
}

export const RUN_ARGS_REQUEST = 'piwi/runArgs';

/** `piwi.runCommand`'s argument: a command line to run in a terminal. */
export interface RunCommandArgs {
  cwd: string;
  command: string;
  /** Environment variables to set on the command's process. */
  env?: Record<string, string>;
}

export type ConnectionSource = 'environment' | 'dotenv' | 'desktop' | 'editor';

/**
 * What keeps a context from the instance's data: no instance named (`not-configured`), no project chosen or found
 * (`no-project`), a key missing or refused (`refused`), or an instance that did not answer, or answered with an error
 * (`unreachable`).
 */
export type ProblemKind = 'not-configured' | 'no-project' | 'refused' | 'unreachable';

/** `piwi/status`: what the service is connected to, per workspace context. */
export interface StatusResult {
  contexts: Array<{
    /** The Playwright config's directory. */
    root: string;
    /**
     * That directory as the editor names it: relative to the workspace folder holding it, after the folder's name when
     * the workspace has several; the folder's name for a config at its root. Absent from an older service.
     */
    label?: string;
    connected: boolean;
    serverUrl: string | null;
    /**
     * Where `serverUrl` came from: the environment, the workspace `.env`, the
     * editor's own settings, or the desktop app.
     */
    source: ConnectionSource | null;
    projectId: number | null;
    projectName: string | null;
    branch: string | null;
    locators: number;
    reachedFiles: number;
    /** Why it is not connected, in one sentence. */
    problem: string | null;
    /** What `problem` is about; null with no problem. */
    problemKind?: ProblemKind | null;
    /**
     * The instance the environment, the workspace `.env` or the editor's
     * settings name, in use or not: Connect offers it beside the desktop app.
     * Null when none does.
     */
    instance?: { serverUrl: string; source: ConnectionSource } | null;
  }>;
  /** The address of the desktop app running on this machine; null when it does not run. */
  desktopUrl?: string | null;
}

export const STATUS_REQUEST = 'piwi/status';

/**
 * `piwi/statusChanged` (notification, server to client): what `piwi/status`
 * answers changed, such as a connection, a project, or the desktop app starting
 * or quitting; carries `StatusResult`.
 */
export const STATUS_NOTIFICATION = 'piwi/statusChanged';

/**
 * `piwi/desktop`: the desktop app running on this machine, for Connect to offer
 * it: its address, the projects its token opens, and the one linked there to
 * the folder of the first Playwright config. `url` is null when it does not run.
 */
export interface DesktopResult {
  url: string | null;
  projects: Array<{ id: number; name: string }>;
  linked: { id: number; name: string } | null;
}

export const DESKTOP_REQUEST = 'piwi/desktop';

/** `piwi/refresh`: fetch every index again now. */
export const REFRESH_REQUEST = 'piwi/refresh';

/**
 * `piwi/refreshRun`: read each context's latest run, its failures and the run in progress again now, not the indexes
 * `piwi/refresh` fetches; answers `RunStatusResult`.
 */
export const REFRESH_RUN_REQUEST = 'piwi/refreshRun';

/**
 * `piwi/setCredentials` (notification): the connection the editor's own
 * settings hold, the API key from its secret store. `serverUrl` comes after
 * the environment and the workspace `.env`, and before the desktop app; with
 * `desktop`, the desktop app comes first while it runs.
 */
export interface EditorCredentials {
  serverUrl?: string | null;
  apiKey?: string | null;
  project?: string | null;
  /**
   * Read the desktop app while it runs, before every other source: the choice
   * made with Connect, kept on this machine only. The other sources count again
   * when the app quits.
   */
  desktop?: boolean | null;
  /** The desktop app's project with `desktop`; without one, the project linked there to the folder. */
  desktopProject?: string | null;
  /**
   * The baseline chosen for each context, by its root (`piwi/setBaseline`), kept on this machine by the client and
   * sent again with every `piwi/setCredentials` and in the initialization options, so a restarted service has it. When
   * present, it replaces every choice the service holds: a context it does not name reads the ladder. Absent, the
   * choices stay.
   */
  baselines?: Record<string, BaselineChoice> | null;
  /**
   * The severity of a `ci-failure` diagnostic: a failure of a run on the checked-out branch gets it, one of a run on
   * another branch is a warning at most, one whose line changed since its run an information; `off` publishes none,
   * while `piwi/failures` and `piwi/fileSummary` still give the failures. `error` when absent.
   */
  failureSeverity?: FailureSeverity | null;
}

/** The severity of a failure's diagnostic, as the editor's setting chooses it. */
export type FailureSeverity = 'error' | 'warning' | 'information' | 'off';

export const SET_CREDENTIALS_NOTIFICATION = 'piwi/setCredentials';

/**
 * The run the workspace is compared with: `ladder`, the latest complete run of the checked-out branch, a CI run first,
 * else the default branch's, else the newest of any branch; `branch`, that branch's latest complete run; `run`, that
 * run (its id, 1 to 2147483647: `piwi/runId` reads one typed); `local`, a developer's own runs only (a machine, the desktop app, an editor), the newest complete one on the
 * checked-out branch, else those runs alone with no baseline. Each reads the runs laid over it.
 */
export type BaselineChoice =
  | { kind: 'ladder' }
  | { kind: 'branch'; branch: string }
  | { kind: 'run'; runId: number }
  | { kind: 'local' };

/** The baseline in force for a context, and the run it found, in a few words. */
export interface Baseline {
  choice: BaselineChoice;
  /**
   * `CI run #120 on feature/x`, `run #118 on main`, `your local runs only`, `local run #110 on feature/x`, `CI run #41,
   * the newest run of any branch`; ending with `(no run)` when the choice found none: `release (no run)`.
   */
  label: string;
}

/**
 * `piwi/setBaseline` (notification, client to server): the baseline chosen for the context at `root`, which the
 * service reads at once. The client keeps it and sends it again in `EditorCredentials.baselines`.
 */
export interface SetBaselineParams {
  root: string;
  choice: BaselineChoice;
}

export const SET_BASELINE_NOTIFICATION = 'piwi/setBaseline';

/** `piwi/trace`: download an execution's trace and return the command that opens it in Playwright's trace viewer. */
export interface TraceParams {
  /** Any file of the workspace the execution belongs to, to pick the Playwright config. */
  uri: string;
  executionId: number;
}

export interface TraceResult {
  /** The downloaded trace archive. */
  path: string;
  /** The directory to run the command in: the Playwright config's, so its Playwright opens it. */
  cwd: string;
  command: string;
}

export const TRACE_REQUEST = 'piwi/trace';

/** `piwi/screenshot`: download an execution's failure screenshot and return where it is, for the editor to open. */
export type ScreenshotParams = TraceParams;

export interface ScreenshotResult {
  path: string;
}

export const SCREENSHOT_REQUEST = 'piwi/screenshot';

/**
 * The latest run on the checked-out branch of one workspace context: its latest complete run, and the later runs of
 * that branch the service lays over it (a test re-run from an editor, a run on a developer's machine).
 */
export interface RunStatus {
  /** The Playwright config's directory. */
  root: string;
  /** The branch whose runs are read; null reads the newest run of any branch. */
  branch: string | null;
  /**
   * The branch checked out in the workspace. When it has no run yet, `branch` is the
   * project's default branch, or null for the newest run of any branch.
   */
  checkedOut?: string | null;
  run: {
    id: number;
    status: string;
    /** ISO 8601. */
    startTime: string;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    flakyTests: number;
    skippedTests: number;
    /** The run's page in the dashboard. */
    url: string;
  } | null;
  /** Failed executions the Problems panel lists for this run, as the runs laid over it leave them. */
  failures: number;
  /** The tests among those failures: a test failing on several Playwright projects counts once. */
  failingTests?: number;
  /** The tests that failed in `run` and passed since in a run laid over it, on every project they failed on. */
  resolved?: number;
  /** The runs of the branch since `run` that the service lays over it. */
  overlays?: number;
  /**
   * The run in progress the context follows: the editor's own (`own`), wherever it runs, else one on `branch` or the
   * checked-out branch. Null while none runs; it goes back to null in the notification that carries the failures read
   * once it ended.
   */
  live?: LiveRun | null;
  /**
   * `live` while the instance's event stream is connected: the service learns that a run ended within a second, and
   * reads the latest run every five minutes besides; `polling` otherwise, every minute.
   */
  stream?: 'live' | 'polling';
  /** When the latest run was last read (ISO 8601); absent before the first read. */
  updatedAt?: string;
  /**
   * The tests `live` began or ended, as its stream says, until the latest run is read once it ended; absent while it
   * has none, and from an older service.
   */
  liveTests?: LiveTest[];
  /**
   * The version of `@piwitests/reporter` the project installs, read from `node_modules` at each refresh; null when
   * none is found. Absent from an older service.
   */
  reporterVersion?: string | null;
  /** The baseline chosen for this context and what it found; absent from an older service. */
  baseline?: Baseline;
  /**
   * The branches a baseline can be chosen from: the default branch, then the branches with runs the project's locator
   * index knows. Absent from an older service.
   */
  branches?: string[];
}

/** A test of the run in progress: `running` once it began, then its result. */
export type LiveTestStatus = 'running' | 'passed' | 'failed' | 'flaky' | 'skipped';

export interface LiveTest {
  testCaseId: number;
  status: LiveTestStatus;
}

/** A run in progress, as its events count it. */
export interface LiveRun {
  runId: number;
  /** `running`, `initializing` or `finalizing`. */
  status: string;
  /** The tests that ended (passed, failed, flaky, skipped or not run) out of `total`. */
  done: number;
  total: number;
  failed: number;
  /** ISO 8601. */
  startedAt: string;
  /** Whether the editor started it: a command of `piwi/runArgs` or `piwi/runSelection`. */
  own: boolean;
}

/** `piwi/runStatus`: the latest run of each context, for the status bar. */
export interface RunStatusResult {
  contexts: RunStatus[];
}

export const RUN_STATUS_REQUEST = 'piwi/runStatus';

/** `piwi/runStatusChanged` (notification, server to client): a context's latest run changed; carries `RunStatusResult`. */
export const RUN_STATUS_NOTIFICATION = 'piwi/runStatusChanged';

/**
 * `piwi/commandStarted` (notification, client to server): the client sent the command of a `RunCommand` built with
 * `ref` to a terminal or a task. `terminalRef` is the ref of that terminal's environment when it is another one, which the run
 * carries instead: the service does not look for `ref`, and recognizes the run by `terminalRef`.
 */
export interface CommandStartedParams {
  ref: string;
  terminalRef?: string;
}

export const COMMAND_STARTED_NOTIFICATION = 'piwi/commandStarted';

/**
 * `piwi/commandEnded` (notification, client to server): the command of a `RunCommand` with a `ref` ended, with its exit
 * code when the client knows it. The service reads the run once more, and says in `piwi/notice` when no run carries
 * the ref.
 */
export interface CommandEndedParams {
  ref: string;
  exitCode: number | null;
}

export const COMMAND_ENDED_NOTIFICATION = 'piwi/commandEnded';

/**
 * `piwi/runEnded` (notification, server to client): a run the editor started ended, and the latest run was read again
 * with it. `fixed` counts the tests failing before it that it passed; `stillFailing` names the tests failing before it
 * that it failed again, `newFailures` those it failed that were not failing before, each as `login.spec.ts › logs in`,
 * at most five, with their counts in `stillFailingCount` and `newFailureCount`.
 */
export interface RunEnded {
  root: string;
  runId: number;
  /** The run's page in the dashboard. */
  url: string;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  fixed: number;
  stillFailing: string[];
  newFailures: string[];
  stillFailingCount: number;
  newFailureCount: number;
}

export const RUN_ENDED_NOTIFICATION = 'piwi/runEnded';

/** `piwi/notice` (notification, server to client): a sentence for the client to show once, about the context at `root`. */
export interface Notice {
  root: string;
  severity: 'information' | 'warning';
  message: string;
}

export const NOTICE_NOTIFICATION = 'piwi/notice';

/** An MCP server the editor's agent can register: Piwi's, with the connection the service already has. */
export interface McpServerDefinition {
  label: string;
  /** The streamable HTTP endpoint. */
  url: string;
  headers: Record<string, string>;
}

/** `piwi/mcp`: one definition per Piwi instance the workspace is connected to. */
export interface McpServersResult {
  servers: McpServerDefinition[];
}

export const MCP_REQUEST = 'piwi/mcp';

/** A saved test selection of the project, resolved against the catalog. */
export interface SelectionItem {
  key: string;
  name: string;
  /** Tests it selects now. */
  count: number;
  /** Whether it selects a test defined in the file asked about. */
  includesFile: boolean;
}

/** `piwi/selections`: the project's saved selections; `uri` marks those selecting a test of that file. */
export interface SelectionsParams {
  uri?: string;
}

export interface SelectionsResult {
  items: SelectionItem[];
}

export const SELECTIONS_REQUEST = 'piwi/selections';

/** `piwi/runSelection`: the command line that runs a saved selection, as `piwi run <key>` resolves it. */
export interface RunSelectionParams {
  /** Any file of the workspace, to pick the Playwright config. */
  uri: string;
  key: string;
  /** The editor's enabled line breakpoints, as in `RunTestsArgs`. */
  breakpoints?: EditorBreakpoint[];
}

export const RUN_SELECTION_REQUEST = 'piwi/runSelection';

/**
 * A failure of the latest run, where it shows in the workspace, or a failure of that run that a later run passed
 * (`state: 'fixed-locally'`), at its `test(…)` line.
 */
export interface WorkspaceFailure {
  /** The file the failure shows in: its failing call, else its `test(…)` line. */
  uri: string;
  /** The folder of the Playwright config the test belongs to, which runs it (`RunTestsArgs.root`). */
  root?: string;
  /** 0-based, followed through the edits since the run. */
  line: number;
  title: string;
  /** Null for a failure fixed since. */
  headline: string | null;
  /** The execution that failed, or for a failure fixed since, the execution that passed. */
  executionId: number;
  /** The run of `executionId`. */
  runId: number;
  /** The execution's page in the dashboard. */
  url: string;
  hasTrace: boolean;
  /**
   * `ci` when `runId` is a CI run, `own` when this editor started it, `local` when it ran elsewhere on a developer's
   * machine, in the desktop app or an editor.
   */
  source?: 'ci' | 'local' | 'own';
  /**
   * `failing`; `edited` once the line the run failed at changed since; `fixed-locally` when a run laid over the
   * latest complete run passed the test since.
   */
  state?: 'failing' | 'edited' | 'fixed-locally';
  /** The Playwright project; null when unknown. */
  browserName?: string | null;
  /** The test's spec, relative to the Playwright config's folder, with forward slashes. */
  file?: string;
  /** How the execution failed: `failed` or `timedOut`. Absent for a failure fixed since. */
  status?: 'failed' | 'timedOut';
  testCaseId?: number;
  /** The failure cluster the execution belongs to, and its title; null when it has none. */
  clusterId?: number | null;
  clusterTitle?: string | null;
  /** The test's owner (`piwi:owner`, CODEOWNERS); null when it has none. */
  owner?: string | null;
  /** A new regression in the latest complete run, or a test that did not fail on this project there. */
  isNew?: boolean;
  /** In milliseconds; null when not recorded. */
  duration?: number | null;
  hasScreenshot?: boolean;
}

/** The latest complete run a context reads, as `piwi/failures` names it. */
export interface FailuresRun {
  id: number;
  branch: string | null;
  status: string;
  /** ISO 8601. */
  startTime: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  flakyTests: number;
  skippedTests: number;
  /** The run's page in the dashboard. */
  url: string;
  /** What launched it: `ci`, `ci-rerun`, `local`, `desktop`, `editor`…; absent from an older instance. */
  origin?: string;
  /** Whether the editor started it. */
  own?: boolean;
}

/** A run laid over the latest complete run: a test re-run from an editor, a run on a developer's machine. */
export interface FailuresOverlay {
  id: number;
  origin: string;
  /** ISO 8601. */
  startTime: string;
  status: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  /** The run's page in the dashboard. */
  url: string;
  /** Whether the editor started it. */
  own: boolean;
}

/** How the failures tree groups the failures under the run: by spec, failure cluster or owner, or not at all. */
export type FailuresGrouping = 'file' | 'cluster' | 'owner' | 'flat';

/**
 * What a node of the failures tree shows as its icon: `context` a Playwright config, `run` the run, `history` the runs
 * laid over it, `failed` and `passed` one of those runs, `file`, `cluster` and `owner` a group, `failing`, `edited` and
 * `fixed` a failure's state.
 */
export type FailureTreeIcon =
  | 'context'
  | 'run'
  | 'history'
  | 'failed'
  | 'passed'
  | 'file'
  | 'cluster'
  | 'owner'
  | 'failing'
  | 'edited'
  | 'fixed';

/**
 * A node of the failures tree both clients draw: the run (`Run #120 · CI · feature/x · 3 failing · 1 fixed locally`,
 * or `Your local runs · 1 failing` with a developer's own runs alone), the runs laid over it under `Your runs since`,
 * then the failures grouped as `FailuresResult.grouping` says, failing first, then edited, then fixed locally. When
 * several Playwright configs have a run, runs laid over none or failures, each has a `context` node at the root
 * (`apps/admin`, its project and its counts beside it) holding that tree for its config alone, or its run alone without
 * a failure.
 */
export interface FailureTreeNode {
  /** Stable across answers: a client keeps a node's expansion and selection by it. */
  key: string;
  kind: 'context' | 'run' | 'runs' | 'overlay' | 'group' | 'failure';
  label: string;
  /**
   * Beside the label: a context's project and counts, a group's counts, a failure's place (`tests/login.spec.ts:42 ·
   * chromium · new`). A client adds the age of `startTime`, and on the `run` node of the context running the editor's
   * own run shows that run in progress instead.
   */
  description: string;
  /** When the run a `run` or `overlay` node stands for started (ISO 8601). */
  startTime?: string | null;
  /** What the node's hover says, one line each, as plain text: a failure's title first. */
  tooltip: string[];
  /**
   * On a failure, what it says about its run when that is not the tree's run failing as it stands: `your run #124`,
   * `local run #124`, `edited since run #120`, `fixed locally in run #124`, `run #125`.
   */
  note?: string | null;
  icon: FailureTreeIcon;
  /** Whether a node with children opens expanded. */
  expanded: boolean;
  /** The page a run opens (a `context` node's run too), a failure's execution page. */
  url: string | null;
  /**
   * On a `context` node and a `run` node: the folder of the Playwright config they stand for, whose failures **Re-run
   * the failing tests** runs from them (`FailuresResult.rerun` with this `root`) and whose baseline **Compare with…**
   * chooses. Absent from an older service.
   */
  root?: string;
  /** On a failure: the `executionId` of its item in `FailuresResult.items`. */
  executionId?: number;
  children: FailureTreeNode[];
}

/**
 * `piwi/failures`: `grouping` is how the tree groups the failures (`file` when absent); the service keeps it for the
 * `piwi/failuresChanged` it sends after.
 */
export interface FailuresParams {
  grouping?: FailuresGrouping | null;
}

/**
 * `piwi/failures`: the failures of each context's latest run, for a client that lists them natively (the JetBrains
 * IDEs publish diagnostics of open files only). The same failures are published as `ci-failure` diagnostics, an
 * `edited` one as an information; a failure whose test's `test(…)` call left its spec is in neither. The failures a
 * later run fixed (`fixed-locally`) follow them and publish none.
 */
export interface FailuresResult {
  items: WorkspaceFailure[];
  /**
   * The baseline run of the one context that has a run, runs laid over none (a developer's own runs only) or failures;
   * null when only overlays are read. Absent when several contexts do, each `context` node of the tree carrying its
   * own, and from an older service.
   */
  run?: FailuresRun | null;
  /** The runs of its branch laid over it, newest first; absent with `run`. */
  overlays?: FailuresOverlay[];
  /** The baseline chosen for that context and what it found; absent with `run`. */
  baseline?: Baseline;
  /** When it was last read (ISO 8601); with several contexts, the latest of their reads. */
  updatedAt?: string;
  /** How `tree` groups the failures. */
  grouping: FailuresGrouping;
  /**
   * The failures as a tree: with one context, empty without a failure, the groups alone without a run; with several,
   * one `context` node each.
   */
  tree: FailureTreeNode[];
  /**
   * The run in a few words, as the tree's `run` node names it, with or without a failure: `Run #120 · CI · feature/x ·
   * 0 failing`, `Your local runs · 1 failing`; null without a run, and with several contexts.
   */
  runLabel: string | null;
  /** How many tests still fail, edited since their run or not; a test failing on several projects counts once. */
  failing: number;
  /**
   * What **Re-run the failing tests** runs: every test still failing or edited since its run, one run per Playwright
   * config (`WorkspaceFailure.root`), in the order of their first failure; none when none fails.
   */
  rerun: RunTestsArgs[];
}

export const FAILURES_REQUEST = 'piwi/failures';

/** `piwi/runId`: the run id typed for **A run by id…** (`118`, `#118`). */
export interface RunIdParams {
  text: string;
}

/** The run id, from 1 to 2147483647 (a run id of the instance); null when the text is not one. */
export interface RunIdResult {
  runId: number | null;
}

export const RUN_ID_REQUEST = 'piwi/runId';

/**
 * `piwi/failuresChanged` (notification, server to client): what `piwi/failures` answers changed, such as a failure's
 * line or state after an edit, or the failures of a run read again; carries `FailuresResult`.
 */
export const FAILURES_NOTIFICATION = 'piwi/failuresChanged';

/** `piwi/agentContext`: one block about a failure for a coding agent: the failure, its healing and its fix plan. */
export interface AgentContextParams {
  /** Any file of the workspace the failure belongs to, to pick the Playwright config. */
  uri: string;
  executionId: number;
}

export interface AgentContextResult {
  text: string;
}

export const AGENT_CONTEXT_REQUEST = 'piwi/agentContext';

/**
 * `piwi/renderSteps`: a flow recorded in Piwi Picker (a steps document, as `piwi codegen` reads it) rendered as the
 * body of a test, for the file at `uri`: with the project's functions and the locators its tests already use, as
 * `piwi codegen --body` renders it.
 */
export interface RenderStepsParams {
  uri: string;
  steps: unknown;
  /**
   * 0-based caret position: the steps run on the page expression in use there (`piwi/pageCandidates`'s default), and
   * a page object already declared there before the caret is not instantiated again.
   */
  line?: number | null;
  character?: number | null;
  /**
   * `separate`: the import lines the code needs come in `imports`, for the client to add at the top of the file,
   * instead of as `// Needs: import …` comments in `code`.
   */
  imports?: 'comments' | 'separate' | null;
}

export interface RenderStepsResult {
  /**
   * The body, to go at the caret: with a `line`, its first line without indentation and the others indented as that
   * line is.
   */
  code: string;
  warnings: string[];
  /**
   * With `imports: 'separate'`: the edit that adds the import lines the code needs whose names the file's import
   * statements do not bind yet, as of the file's text the service holds: after its last top-level import statement,
   * else at its top followed by an empty line; null when it needs none. It is placed in the text before the code goes
   * in, and the client makes it with the code's insertion.
   */
  importEdit?: FileEdit | null;
}

export const RENDER_STEPS_REQUEST = 'piwi/renderSteps';

/**
 * Where a recording writes: `steps`, lines of the test, method or function the caret is in; `test`, a new `test(…)`
 * at the caret; `file`, a whole new spec.
 */
export type RecordInto = 'steps' | 'test' | 'file';

/**
 * `piwi/record`: open a browser through the Playwright of the file's config, with the `use` options of one of its
 * projects, and write the steps recorded there into the file, at the caret, until `piwi/stopRecording`. What is
 * written comes in `piwi/recordingChanged` notifications. A caret that does not fit `into` is refused with `ok: false`
 * and a sentence: `steps` needs the `test` or `function` context of `piwi/pageCandidates`, `test` needs `file`;
 * `file` is not checked.
 */
export interface RecordParams {
  uri: string;
  /** 0-based caret position: where the recorded block starts. */
  line: number;
  character: number;
  into: RecordInto;
  /** The Playwright project whose `use` options the browser gets; the config's only project when absent. */
  project?: string | null;
  /** A path on the project's `baseURL`, or an absolute URL; the `baseURL` when absent. */
  startUrl?: string | null;
  /** The test's title, for `test` and `file`. */
  title?: string | null;
  /** The page expression the steps run on; `piwi/pageCandidates`'s default when absent. */
  page?: string | null;
  /** The editor's display language, a BCP 47 tag such as `fr` or `pt-BR`, for the recorder's panel in the browser. */
  language?: string | null;
}

/**
 * Where the recorded block goes, decided from the file's text when the recording starts. The client writes the block
 * there on the first `piwi/recordingChanged`, then follows it through the edits around it.
 */
export interface RecordingPlacement {
  /** 0-based line the block's first line goes on. */
  line: number;
  /**
   * Whether that line is new: the client first inserts an empty line there, pushing the line that was there down.
   * Otherwise the line is empty (or blank) and the block takes its place.
   */
  newLine: boolean;
  /** What every line of the block starts with; an empty line of the block stays empty. */
  indent: string;
}

export interface RecordResult {
  ok: boolean;
  sessionId?: string;
  /** One sentence for the client to show when the recording did not start. */
  message: string;
  /** When the config has several projects and none was given: their names, for the client to ask which. */
  projects?: string[];
  /** Where the block goes; set when `ok`. For `file`, line 0 of the (empty) file, with no indent. */
  placement?: RecordingPlacement;
}

export const RECORD_REQUEST = 'piwi/record';

/** `piwi/stopRecording`: stop recording; the browser closes and a last `piwi/recordingChanged` says `stopped`. */
export interface StopRecordingParams {
  sessionId: string;
}

export const STOP_RECORDING_REQUEST = 'piwi/stopRecording';

/**
 * `piwi/recordingCommand`: `pause` stops writing what is done in the browser; `resume` writes again, and the service
 * sends the latest `piwi/recordingChanged` again, which rewrites the recorded block.
 */
export interface RecordingCommandParams {
  sessionId: string;
  command: 'pause' | 'resume';
}

export const RECORDING_COMMAND_REQUEST = 'piwi/recordingCommand';

/** A recorded step, as the recorded block holds it. */
export interface RecordingStep {
  /** The step in words, as the extension's review lists it. */
  words: string;
  /** 0-based line of `RecordingUpdate.code` the step starts on; the steps a function call stands for share it. */
  line: number;
  /** The locators the recorder verified for the step's element, best first; empty for a step without an element. */
  locators: string[];
  /** The index in `locators` of the one written; null when none could be written. */
  chosen: number | null;
  /** The project function the step is part of, when a catalog call stands for it. */
  functionName?: string | null;
}

/** Something about a recorded step the reader of the code should check: a brittle locator, a secret, a file. */
export interface RecordingWarning {
  /** Index of the step in `RecordingUpdate.steps`. */
  step: number;
  /** 0-based line of `RecordingUpdate.code` the warning is about. */
  line: number;
  message: string;
}

/**
 * `piwi/recordingChanged` (notification, server to client): what the recorded block holds now, and the session's
 * state. `code` is the whole block: lines joined with `\n`, no trailing newline, not indented; the client prefixes
 * every non-empty line with `RecordResult.placement.indent`.
 */
export interface RecordingUpdate {
  sessionId: string;
  /** The file the session writes into. */
  uri: string;
  into: RecordInto;
  state: 'starting' | 'recording' | 'paused' | 'stopped' | 'failed';
  code: string;
  /**
   * The edit that adds the import lines the code needs (a catalog call's page object or helper, `expect`) whose names
   * the file's import statements do not bind yet, as of the file's text the service holds when the block is rendered:
   * after its last top-level import statement, else at its top followed by an empty line. It is placed in that text,
   * the block of the previous update included, and the client makes it with the block's write. Null when the file
   * binds them all, and for `into: 'file'`, whose `code` holds its imports.
   */
  importEdit: FileEdit | null;
  steps: RecordingStep[];
  warnings: RecordingWarning[];
  /** One sentence on what happened: why the session failed, or what the client should know. */
  message?: string | null;
  /** An action the client offers with `message`, such as installing the browser (`piwi.runCommand`). */
  command?: PiwiCommand | null;
}

export const RECORDING_NOTIFICATION = 'piwi/recordingChanged';

/** `piwi/pageCandidates`: the page expressions the steps written at a position could run on. */
export interface PageCandidatesParams {
  uri: string;
  line: number;
  character: number;
}

export interface PageCandidate {
  expression: string;
  /** Why it is offered, in a few words: `used on line 12`, `fixture of this test`, `field of SignInPage`. */
  reason: string;
}

export interface PageCandidatesResult {
  /** Best first; the default is always among them. */
  candidates: PageCandidate[];
  default: string;
  /**
   * Where the position is: `test`, in the body of a test's or a hook's callback; `function`, in the body of another
   * function or method (a page object's method, a helper), even inside a class; `class`, in a class body between its
   * members; `file`, anywhere else (the top level, a `test.describe` callback between its tests). `file` takes a new
   * test (`into: 'test'`); `test` and `function` take steps (`into: 'steps'`); `class` takes neither.
   */
  context: 'test' | 'function' | 'class' | 'file';
}

export const PAGE_CANDIDATES_REQUEST = 'piwi/pageCandidates';

/**
 * What the desktop app is asked to do with a failure or a flaky test from the team instance: reproduce the failure,
 * bisect it, or run the test's Flake Lab experiment.
 */
export type DesktopJobKind = 'reproduce' | 'bisect' | 'flake-lab';

/**
 * `piwi/desktopJob`, and the arguments of the client command `piwi.desktopJob` that sends it: ask the desktop app
 * running on this machine to reproduce a failure of the instance the context reads (`root`), at its commit, to
 * bisect it, or to run Flake Lab on a test (`flake-lab`, with `testCaseId`; `executionId` names the failure it was
 * offered on, if any). The app shows the job in its window and runs nothing until the developer starts it there.
 */
export interface DesktopJobParams {
  root: string;
  /** The failure, for `reproduce` and `bisect`. */
  executionId?: number | null;
  /** The test, for `flake-lab`. */
  testCaseId?: number | null;
  kind: DesktopJobKind;
}

export interface DesktopJobResult {
  ok: boolean;
  /** One sentence for the client to show: where to confirm the job, or why it was not sent. */
  message: string;
  jobId?: string;
}

export const DESKTOP_JOB_REQUEST = 'piwi/desktopJob';

/**
 * `piwi/desktopJobChanged`, sent while the service follows a job: the developer started it in the desktop app
 * (`running`), it ended (`done`, with the verdict in `message`), or it was `declined`, `expired`, or the app quit
 * (`gone`). `share` names the instance the verdict can be shared on (`piwi/shareDesktopJob`): a bisect's first bad
 * commit, or the results of a Flake Lab run; null when there is nothing to share.
 */
export interface DesktopJobUpdate {
  jobId: string;
  kind: DesktopJobKind;
  status: 'running' | 'done' | 'declined' | 'expired' | 'gone';
  message: string;
  share: { label: string } | null;
}

export const DESKTOP_JOB_NOTIFICATION = 'piwi/desktopJobChanged';

/** `piwi/shareDesktopJob`: record a job's verdict on the instance the job came from, with the editor's key. */
export interface ShareDesktopJobParams {
  jobId: string;
}

export interface ShareDesktopJobResult {
  ok: boolean;
  message: string;
  /** The failure cluster's page, or the test's Flakiness tab, once shared. */
  url?: string;
}

export const SHARE_DESKTOP_JOB_REQUEST = 'piwi/shareDesktopJob';

/**
 * `piwi/applyPick`: the edit that puts a locator picked while a run was paused at a breakpoint in place of the locator
 * chain its line holds now. The file is `uri`, else `file`, a path relative to a Playwright config's folder as the run
 * reported it (`@piwitests/core/editor-send`'s `at`), looked for under each config's folder; `line` is 0-based.
 */
export interface ApplyPickParams {
  uri?: string;
  file?: string;
  line: number;
  locator: string;
}

/**
 * The file found (null when none is) and the edit on its line, as the file stands, open or saved: null when the line
 * holds no locator, which the client then inserts at the cursor.
 */
export interface ApplyPickResult {
  uri: string | null;
  edit: FileEdit | null;
}

export const APPLY_PICK_REQUEST = 'piwi/applyPick';
