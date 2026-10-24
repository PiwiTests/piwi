/**
 * The Piwi language server. VS Code and the JetBrains IDEs both run it, so
 * both show the same answers:
 *
 * - in test files, a warning on each brittle locator the index knows at that
 *   line (a hint for one worth a look), with the stable alternative stored at
 *   that call site as a quick fix, and a hover with its tests;
 * - in application files, a warning on each changed line whose string the
 *   project's locators find elements by, with the rewrite of every call site
 *   as a quick fix, as `piwi preflight` computes it for the unsaved buffer;
 * - the failures of the latest run on the checked-out branch, as errors at
 *   their failing lines in every file (the Problems panel), followed through
 *   the edits since the run (an information once the failing line changed),
 *   with the healing's edit as a quick fix and the test's run, the trace, the
 *   screenshot and the execution page one action away, read again as soon as
 *   a run ends (`run-watch.ts`);
 * - custom requests (`protocol.ts`) for the summary lines each editor draws
 *   natively above a file, a test and a locator line, the run status, a trace
 *   to open, and the MCP server to register;
 * - the lines of an application file the tests ran, placed on the file as it
 *   stands (`coverage.ts`), as marks the editors draw, a line above each
 *   function that ran, and the tests behind a line on hover.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeAction,
  type CompletionItem,
  type Connection,
  type Diagnostic,
  type Hover,
  type InitializeParams,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { renderSpec } from '@piwitests/core/codegen';
import { codegenConfigOf } from '@piwitests/core/piwi-config';
import type { DiffHunk } from '@piwitests/core/diff-anchors';
import { diffLines } from '@piwitests/core/line-diff';
import { canonicalLocator } from '@piwitests/core/locator-chain';
import { parseSteps, sessionFromSteps } from '@piwitests/core/steps';
import type { LocatorBreak } from '@piwitests/core/locator-break';
import { stabilityLabels } from '@piwitests/core/locator-stability';
import type { LocatorIndexTest } from '@piwitests/core/locator-index';
import {
  applyPatchFile,
  breakMessage,
  breakpointsNotice,
  breaksByAnchor,
  breaksOfChange,
  callEndLine,
  callsLocatorsFrom,
  filePages,
  flakeLabLens,
  functionSnippet,
  functionSuggestions,
  headedCommand,
  locatorCompletionSite,
  locatorRange,
  locatorSuggestions,
  locatorsInFile,
  pageSummary,
  parsePatch,
  pauseAtValue,
  pickEditOnLine,
  placeLine,
  reachFrom,
  replaceLocatorOnLine,
  rewriteEdits,
  stabilityFindings,
  stableReplacement,
  TEST_CALL,
  testCalls,
  caseOfCall,
  testsReaching,
  timeoutEdit,
  timeoutMessage,
  type LineLocator,
  type LineState,
  type TestCall,
} from './analysis.js';
import {
  BlobTexts,
  COVERAGE_MARKS_EXPLAINED,
  UNCOVERED_EXPLAINED,
  changedSince,
  uncoveredFile,
  chooseVersion,
  coverageIndexFor,
  coverageMarks,
  coverageNote,
  coverageResult,
  coverageVersions,
  mayHaveCoverage,
  type CoverageMarks,
} from './coverage.js';
import {
  CI_ORIGINS,
  PiwiContext,
  desktopConfigPath,
  linkedDesktopProject,
  parseBaselineChoice,
  pruneEvidence,
  readDesktopDiscovery,
  runIdOf,
  withServerUrl,
} from './context.js';
import { failuresAnswer, parseFailuresGrouping, type ContextFailures } from './failure-tree.js';
import {
  PiwiClient,
  forgetShared,
  type ResponseCache,
  type BranchFailure,
  type BranchResolved,
  type CatalogCase,
  type FileCoverage,
  type FixPlan,
  type FlakeLabEntry,
} from './piwi-client.js';
import {
  isTestLocation,
  playwrightArgsOf,
  playwrightTestCommand,
  repeatArgs,
  verificationCommand,
} from './commands.js';
import { DesktopJobs } from './desktop-jobs.js';
import { RunWatch, exitVerdict, newRunRef } from './run-watch.js';
import { declaredNamesAt, pageCandidates } from './recorder/page-candidates.js';
import { readProjectOptions, type ProjectOptions } from './recorder/project-options.js';
import { canonicalPath } from './recorder/playwright.js';
import {
  RecordingSessions,
  blockImports,
  indentBlock,
  originOf,
  repositoryCodegen,
  type LauncherFactory,
} from './recorder/sessions.js';
import { importInsertion } from './recorder/imports.js';
import {
  DESKTOP_JOB_NOTIFICATION,
  DESKTOP_JOB_REQUEST,
  SHARE_DESKTOP_JOB_REQUEST,
  type DesktopJobKind,
  type DesktopJobParams,
  type DesktopJobResult,
  type ShareDesktopJobParams,
  type ShareDesktopJobResult,
} from './protocol.js';
import {
  AGENT_CONTEXT_REQUEST,
  APPLY_PICK_REQUEST,
  COMMAND_ENDED_NOTIFICATION,
  COMMAND_STARTED_NOTIFICATION,
  COVERAGE_NOTIFICATION,
  COVERAGE_REQUEST,
  FAILURES_NOTIFICATION,
  FAILURES_REQUEST,
  FILE_SUMMARY_REQUEST,
  MCP_REQUEST,
  NOTICE_NOTIFICATION,
  PAGE_CANDIDATES_REQUEST,
  RECORD_REQUEST,
  RECORDING_COMMAND_REQUEST,
  RECORDING_NOTIFICATION,
  REFRESH_REQUEST,
  REFRESH_RUN_REQUEST,
  RENDER_STEPS_REQUEST,
  STOP_RECORDING_REQUEST,
  RUN_ENDED_NOTIFICATION,
  RUN_STATUS_NOTIFICATION,
  RUN_STATUS_REQUEST,
  RUN_SELECTION_REQUEST,
  RUN_ID_REQUEST,
  SCREENSHOT_REQUEST,
  SELECTIONS_REQUEST,
  TRACE_REQUEST,
  RUN_ARGS_REQUEST,
  SET_BASELINE_NOTIFICATION,
  SET_CREDENTIALS_NOTIFICATION,
  DESKTOP_REQUEST,
  STATUS_NOTIFICATION,
  STATUS_REQUEST,
  TESTS_FOR_FILE_REQUEST,
  TEST_AT_REQUEST,
  TEST_ITEMS_REQUEST,
  type AgentContextParams,
  type AgentContextResult,
  type ApplyPickParams,
  type ApplyPickResult,
  type CommandEndedParams,
  type CommandStartedParams,
  type CoverageParams,
  type CoverageResult,
  type LineSpan,
  type DesktopResult,
  type EditorBreakpoint,
  type EditorCredentials,
  type EditorTest,
  type FailureSeverity,
  type FailuresGrouping,
  type FailuresParams,
  type FailuresResult,
  type FileSummary,
  type FileSummaryParams,
  type McpServersResult,
  type Notice,
  type PageCandidatesParams,
  type PageCandidatesResult,
  type RecordParams,
  type RecordResult,
  type RecordingCommandParams,
  type RenderStepsParams,
  type RenderStepsResult,
  type RunCommand,
  type RunIdParams,
  type RunIdResult,
  type RunStatus,
  type RunStatusResult,
  type SetBaselineParams,
  type RunSelectionParams,
  type ScreenshotParams,
  type ScreenshotResult,
  type SelectionsParams,
  type SelectionsResult,
  type RunTestsArgs,
  type StatusResult,
  type StopRecordingParams,
  type SummaryLine,
  type TestAtParams,
  type TestAtResult,
  type TestFailure,
  type TestLineStatus,
  type TestsForFile,
  type TestsForFileParams,
  type TestItemsParams,
  type TestItemsResult,
  type SpecTests,
  type RunCommandArgs,
  type TraceParams,
  type TraceResult,
  type WorkspaceFailure,
} from './protocol.js';
import {
  contextLabel,
  findPlaywrightRoots,
  headFiles,
  playwrightConfigFile,
  relativeTo,
  repositoryRoot,
  resolveReportedFile,
  splitLocation,
} from './workspace.js';

/** How often every context fetches its indexes again. */
const REFRESH_MS = 5 * 60_000;
/** The first wait before an instance that did not answer is read again; doubled each time, up to `REFRESH_MS`. */
const UNREACHABLE_RETRY_MS = 15_000;
/** How often the latest run is read again while it runs, and otherwise. */
const RUN_POLL_ACTIVE_MS = 15_000;
const RUN_POLL_MS = 60_000;
/** While the instance's event stream is connected, the latest run is read this many times less often. */
const STREAM_POLL_FACTOR = 5;
/** How often the desktop app's discovery file is checked. */
const DESKTOP_WATCH_MS = 2_000;
/** How often the repositories' `HEAD` files are checked for a checkout or a commit. */
const GIT_WATCH_MS = 2_000;
const ACTIVE_RUN = new Set(['running', 'initializing', 'finalizing']);
/** Pause after a keystroke before an application file is compared with `HEAD`. */
const DEBOUNCE_MS = 500;
/** How long `piwi/renderSteps` waits for a config's project options before writing URLs as paths. */
const OPTIONS_WAIT_MS = 3_000;
/**
 * How long a quick fix or a hover waits for what it fetches from the instance: past it, it answers without, and the
 * fetch goes on, so the next ask has it.
 */
const LOOKUP_WAIT_MS = 1_500;
/** The latest commands that run each test several times whose end the service says, at most. */
const MAX_REPEATED_COMMANDS = 50;
const SPEC_FILE = /(?:^|\/)[^/]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

export interface ServerOptions {
  /** The environment the connection is read from; the process's by default. */
  env?: Record<string, string | undefined>;
  refreshMs?: number;
  /** The first wait before an instance that did not answer is read again. */
  unreachableRetryMs?: number;
  /** How long a quick fix or a hover waits for what it fetches from the instance. */
  lookupWaitMs?: number;
  debounceMs?: number;
  /**
   * How often the latest run is read while none runs; a quarter of it while one runs, and five times it while the
   * instance's event stream is connected.
   */
  runPollMs?: number;
  /** How often the instance is asked for the run of a command the service built; every 2 s by default. */
  ownRunPollMs?: number;
  /** How long after a command ends its run may take to reach the instance before a notice says it did not; 5 s. */
  commandEndWaitMs?: number;
  /** How often the desktop app's discovery file is checked for its start, stop and folder links. */
  desktopWatchMs?: number;
  /** How often the repositories' `HEAD` files are checked for a checkout or a commit. */
  gitWatchMs?: number;
  /**
   * The folder holding the files the language server ships beside itself: the recorder's launcher, its IDE bundle
   * and catalogs, and the reporter that reads a config's options. `PIWI_EDITOR_DIST`, else the folder of the running
   * bundle.
   */
  distDir?: string;
  /** Starts a recording's launcher; the bundled one by default. */
  launchRecorder?: LauncherFactory;
  /** Reads the resolved options of a config's projects; with the config's own Playwright by default. */
  readProjectOptions?: (configFile: string) => Promise<ProjectOptions>;
}

/** What the last analysis of an application file found, for its quick fixes and hover. */
interface AppAnalysis {
  context: PiwiContext;
  groups: Array<{ anchor: LocatorBreak['anchor']; breaks: LocatorBreak[] }>;
}

/** The folder of the running bundle, `dist/` in an installed client. */
function bundleDir(): string {
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/** The canonical locators a context's tests use, which a rendering prefers among a step's alternatives. */
function suiteLocators(context: PiwiContext | null): Set<string> {
  return new Set(
    (context?.index?.locators ?? []).flatMap((l) => {
      const canonical = canonicalLocator(l.locator);
      return canonical ? [canonical] : [];
    }),
  );
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * What a `ci-failure` diagnostic carries, for its quick fixes and hover: `edited` once its line changed since the run.
 */
interface FailureData {
  root: string;
  executionId: number;
  edited?: boolean;
}

/** A failure, or a failure a later run passed, as the service places it on the files. */
type Placeable = Pick<BranchFailure, 'executionId' | 'runId' | 'title' | 'file' | 'line'> &
  Partial<Pick<BranchFailure, 'location' | 'frames'>>;

/** Where a failure shows, followed through the edits since its run. */
interface Placement {
  /** The file it shows in, and its line there (1-based). */
  file: string;
  line: number;
  /** How the edits left that line; `gone` once the test's `test(…)` call left its spec. */
  state: LineState;
  /** The workspace files of its stack, innermost first, each at its line as the file stands. */
  frames: Array<{ file: string; line: number }>;
}

/** What a placing pass hands the next one: the texts it read, the files it diffed and where it placed each failure. */
interface PlacerSeed {
  texts: ReadonlyMap<string, string | null>;
  diffed: ReadonlySet<string>;
  placed: ReadonlyMap<Placeable, Placement | null>;
}

/** The `test(…)` call spanning a 0-based line of a file's lines: the line it starts on and its title; else null. */
function testCallAt(lines: string[], line: number): { line: number; title: string } | null {
  for (let i = 0; i <= Math.min(line, lines.length - 1); i++) {
    const m = TEST_CALL.exec(lines[i]!);
    if (!m) continue;
    const open = lines[i]!.indexOf('(', m.index);
    const end = (open >= 0 ? callEndLine(lines, i, open) : null) ?? i;
    if (end >= line) return { line: i, title: m[2]! };
    i = end;
  }
  return null;
}

/** The titles of the `test(…)` calls of a file's text. */
function testTitles(text: string): Set<string> {
  const titles = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = TEST_CALL.exec(line);
    if (m) titles.add(m[2]!);
  }
  return titles;
}

/**
 * The severity of a failure's diagnostic as the client's setting chooses it (`error` when unset): a warning at most for
 * a run on another branch, an information for a line edited since the run; null with `off`.
 */
function failureSeverity(
  setting: FailureSeverity | null | undefined,
  otherBranch: boolean,
  edited: boolean,
): DiagnosticSeverity | null {
  if (setting === 'off') return null;
  if (edited || setting === 'information') return DiagnosticSeverity.Information;
  if (setting === 'warning' || otherBranch) return DiagnosticSeverity.Warning;
  return DiagnosticSeverity.Error;
}

function toEditorTest(context: PiwiContext, t: LocatorIndexTest): EditorTest {
  return { id: t.id, title: t.title, file: t.file, status: t.status, url: context.client?.testUrl(t.id) ?? '' };
}

function caseToEditorTest(context: PiwiContext, c: CatalogCase): EditorTest {
  return {
    id: c.id,
    title: c.title,
    file: c.filePath,
    status: (['passed', 'failed', 'flaky', 'skipped'].includes(c.status ?? '')
      ? c.status
      : null) as EditorTest['status'],
    url: context.client?.testUrl(c.id) ?? '',
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Whether a run the context reads ran in CI: its baseline when the instance does not say (it is the CI run the editor
 * shows), a run laid over it by its origin.
 */
function isCiRun(context: PiwiContext, runId: number | undefined): boolean {
  const answer = context.failures;
  const overlay = runId === undefined ? undefined : answer?.overlays?.find((o) => o.id === runId);
  if (overlay && runId !== answer?.run?.id) return CI_ORIGINS.has(overlay.origin);
  if (!answer?.run || runId === undefined || runId === answer.run.id) {
    return !answer?.run?.origin || CI_ORIGINS.has(answer.run.origin);
  }
  return false;
}

/** Whether a failure is listed from a run that did not run in CI: a run laid over the baseline, or the baseline itself. */
function isLocalFailure(context: PiwiContext, f: BranchFailure): boolean {
  return !isCiRun(context, f.runId ?? context.failures?.run?.id);
}

/**
 * The commit whose files a run's failures are followed from: the commit of a run that ran in CI, whose checkout it is;
 * null for a run on a developer's machine, which ran their files as saved, and for a run that recorded none.
 */
function ciCommit(context: PiwiContext, runId: number | undefined): string | null {
  const answer = context.failures;
  if (!answer?.run || !isCiRun(context, runId)) return null;
  if (runId === undefined || runId === answer.run.id) return answer.run.commit ?? null;
  return answer.overlays?.find((o) => o.id === runId)?.commit ?? null;
}

/** Whether the editor started the run: a command of `piwi/runArgs` or `piwi/runSelection`. */
function isOwnRun(context: PiwiContext, runId: number | undefined): boolean {
  return runId !== undefined && context.ownRuns.has(runId);
}

/**
 * The run a failure is listed from: `run #120`, `your run #124` for a run the editor started, or `local run #124` for
 * another run that did not run in CI, the baseline included.
 */
function runLabel(context: PiwiContext, f: BranchFailure): string {
  const runId = f.runId ?? context.failures?.run?.id;
  if (isOwnRun(context, runId)) return `your run #${runId}`;
  return isLocalFailure(context, f) ? `local run #${runId ?? ''}` : `run #${runId ?? ''}`;
}

/**
 * What the lens of a test fixed since the latest complete run says: `fixed locally in run #124 (failing in run #120)`,
 * `fixed locally in your run #124 (…)` when the editor started that run.
 */
function fixedLabel(context: PiwiContext, r: BranchResolved): string {
  const where = isCiRun(context, r.runId) ? 'fixed' : 'fixed locally';
  const run = `${isOwnRun(context, r.runId) ? 'your ' : ''}run #${r.runId}`;
  return `${where} in ${run} (failing in run #${context.failures?.run?.id ?? ''})`;
}

/** What a `piwi/failures` item says launched its run. */
function failureSource(context: PiwiContext, runId: number | undefined): 'ci' | 'local' | 'own' {
  if (isOwnRun(context, runId)) return 'own';
  return isCiRun(context, runId) ? 'ci' : 'local';
}

/** A catalog status as a test line shows it. */
function testLineStatus(status: string | null | undefined): TestLineStatus {
  return status === 'passed' || status === 'failed' || status === 'flaky' || status === 'skipped' ? status : 'unknown';
}

/** Whether two absolute paths name the same file (case-insensitively on Windows). */
function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

function clip(text: string, max: number): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A Markdown code block around a text, its fence longer than any run of backticks in it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function testCounts(tests: Array<{ status: string | null }>): string {
  const failing = tests.filter((t) => t.status === 'failed').length;
  const flaky = tests.filter((t) => t.status === 'flaky').length;
  return [failing ? `${failing} failing` : null, flaky ? `${flaky} flaky` : null].filter(Boolean).join(' · ');
}

/** A test's latest result as a hover lists it. */
function statusIcon(status: string | null): string {
  return status === 'passed'
    ? '✓'
    : status === 'failed'
      ? '✗'
      : status === 'flaky'
        ? '~'
        : status === 'skipped'
          ? '−'
          : '·';
}

/** A hover's Markdown, empty without one. */
function hoverText(hover: Hover | null): string {
  return hover && typeof hover.contents === 'object' && 'value' in hover.contents ? hover.contents.value : '';
}

/**
 * The environment a test run adds for the coverage its lens asks for (`RunTestsArgs.coverage`): the backend's coverage
 * by line for a server file's lens, the browser's by function for a browser file's, which the reporter reads when the
 * Playwright config leaves it unset.
 */
function coverageRunEnv(coverage: RunTestsArgs['coverage']): Record<string, string> {
  if (coverage === 'server') return { PIWI_COVERAGE_SERVER: 'lines' };
  if (coverage === 'browser') return { PIWI_COVERAGE_BROWSER: 'functions' };
  return {};
}

/**
 * The environment of a test run the editor starts: the reporter records the run as started from an editor, with the
 * ref the service finds it by when there is one.
 */
export function editorRunEnv(ref?: string): Record<string, string> {
  return ref ? { PIWI_ORIGIN: 'editor', PIWI_ORIGIN_REF: ref } : { PIWI_ORIGIN: 'editor' };
}

/**
 * The folder a command of a context runs in: the config's folder as the file system spells it (`canonicalPath`), so
 * the project's Playwright and the config it loads resolve `@playwright/test` to one path whatever the case the
 * editor gave the folder in (`c:\…` for `C:\…` on Windows).
 */
export function commandFolder(context: PiwiContext): string {
  return canonicalPath(context.root);
}

/**
 * The Flake Lab lines above a flaky test: its flaky rate and top suspect, which
 * open its Flakiness tab, then the `piwi flake` commands it can run, each through
 * `piwi.runCommand` in the config's folder and reporting to the instance the
 * context reads. With `desktop`, while the desktop app runs beside a team
 * instance, the reproduction is also offered as a job for the app.
 */
export function flakeLabLines(
  context: PiwiContext,
  testCaseId: number,
  line: number,
  env: Record<string, string | undefined>,
  desktop = false,
): SummaryLine[] {
  const entry = context.flakeLab.get(testCaseId);
  const lens = entry && context.client ? flakeLabLens(testCaseId, entry) : null;
  if (!lens || !context.client) return [];
  const serverUrl = context.client.connection.serverUrl;
  return [
    {
      line,
      title: lens.title,
      command: {
        title: 'Open its Flakiness tab',
        command: 'piwi.openInDashboard',
        arguments: [context.client.flakinessUrl(testCaseId)],
      },
    },
    ...lens.actions.flatMap((a): SummaryLine[] => [
      {
        line,
        title: a.title,
        command: {
          title: a.title,
          command: 'piwi.runCommand',
          arguments: [
            {
              cwd: commandFolder(context),
              command: withServerUrl(a.command, serverUrl, context.root, env),
              env: editorRunEnv(),
            } satisfies RunCommandArgs,
          ],
        },
      },
      ...(desktop && a.kind === 'reproduce' ? [flakeLabJobLine(context, testCaseId, line)] : []),
    ]),
  ];
}

/** The line that passes a flaky test's Flake Lab run to the desktop app. */
function flakeLabJobLine(context: PiwiContext, testCaseId: number, line: number): SummaryLine {
  const title = 'Reproduce this flake in the desktop app';
  return {
    line,
    title,
    command: {
      title,
      command: 'piwi.desktopJob',
      arguments: [{ root: context.root, testCaseId, kind: 'flake-lab' } satisfies DesktopJobParams],
    },
  };
}

/** Whether a test's Flake Lab entry names a suspect no experiment tested yet. */
export function hasUntestedSuspect(entry: FlakeLabEntry | undefined): boolean {
  return !!entry && ((entry.untestedSuspects ?? 0) > 0 || entry.suspect?.standing === 'untested');
}

/** Start serving on a connection. Returns a function that stops the refresh timer. */
export function startServer(connection: Connection, options: ServerOptions = {}): () => void {
  const env = options.env ?? process.env;
  /** What `asked` settles with, or `fallback` once a quick fix or a hover has waited long enough. */
  const within = <T>(asked: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([
      asked,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), options.lookupWaitMs ?? LOOKUP_WAIT_MS).unref()),
    ]);
  const desktopFile = desktopConfigPath(env);
  const onDesktopFile = (now: fs.Stats, before: fs.Stats) => {
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) void refreshAll();
  };
  /** The `HEAD` files watched, with the listener of their repository. */
  const headWatches: Array<{ file: string; listener: (now: fs.Stats, before: fs.Stats) => void }> = [];
  const documents = new TextDocuments(TextDocument);
  const contexts: PiwiContext[] = [];
  /** The instance's answers the contexts share: the configs of a repository reading one project read its indexes once. */
  const answers: ResponseCache = new Map();
  let credentials: EditorCredentials = {};
  let folders: string[] = [];
  const appAnalyses = new Map<string, AppAnalysis>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** The next read of an instance that did not answer, and the wait before it. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryWait = 0;
  let runTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Diagnostics of the analysis of open documents, and of the latest run's failures, by URI. */
  const analysisDiagnostics = new Map<string, Diagnostic[]>();
  let failureDiagnostics = new Map<string, Diagnostic[]>();
  /** How the failures tree groups the failures: as the client last asked `piwi/failures`. */
  let failuresGrouping: FailuresGrouping = 'file';
  let lastRunStatus = '';
  /** Whether the client previews an edit whose change annotation asks for confirmation. */
  let previewsEdits = false;

  const publish = (uri: string) =>
    connection.sendDiagnostics({
      uri,
      diagnostics: [...(analysisDiagnostics.get(uri) ?? []), ...(failureDiagnostics.get(uri) ?? [])],
    });

  /** The open document of a file, whichever form of its URI the client sent (`file:///c%3A/…` on Windows). */
  const openDocument = (file: string): TextDocument | undefined =>
    documents.get(pathToFileURL(file).href) ??
    documents.all().find((d) => {
      const open = uriToPath(d.uri);
      return !!open && samePath(open, file);
    });

  const readText = (file: string): string | null => {
    const open = openDocument(file);
    if (open) return open.getText();
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  };

  const contextFor = (file: string): PiwiContext | null => {
    const owning = contexts
      .filter((c) => relativeTo(c.root, file) !== null)
      .sort((a, b) => b.root.length - a.root.length)[0];
    return owning ?? contexts.find((c) => relativeTo(c.repoRoot, file) !== null) ?? null;
  };

  /** Whether a file is test code: a spec, or a file the index calls locators from. */
  const isTestCode = (context: PiwiContext, relative: string | null): boolean => {
    if (!relative) return false;
    if (SPEC_FILE.test(relative)) return true;
    if (!context.index) return false;
    return callsLocatorsFrom(context.index, relative);
  };

  const lineOf = (file: string, line: number): string | null => {
    const text = readText(file);
    if (text === null) return null;
    return text.split(/\r?\n/)[line - 1] ?? null;
  };

  /** Where a failure shows: its failing call when that file is in the workspace, else its `test(…)` line. */
  const failureSite = (
    context: PiwiContext,
    f: Pick<Placeable, 'location' | 'file' | 'line'>,
  ): { file: string; line: number } | null => {
    const roots = [context.root, context.repoRoot];
    const at = f.location ? splitLocation(f.location) : null;
    const located = at ? resolveReportedFile(roots, at.file) : null;
    if (located && at) return { file: located, line: at.line };
    const spec = resolveReportedFile(roots, f.file);
    return spec ? { file: spec, line: f.line ?? 1 } : null;
  };

  /**
   * Where the run reported a failure in the workspace: its site, its stack's frames that are workspace files, innermost
   * first, and its test's spec. Kept until the run is read again, or the file of its site is deleted.
   */
  const reportedAt = new WeakMap<
    Placeable,
    {
      site: { file: string; line: number } | null;
      frames: Array<{ file: string; line: number }>;
      spec: string | null;
    }
  >();
  const reportedOf = (context: PiwiContext, f: Placeable) => {
    const known = reportedAt.get(f);
    // Resolved again once the file of its site is deleted.
    if (known && (!known.site || fs.existsSync(known.site.file) || openDocument(known.site.file))) return known;
    const roots = [context.root, context.repoRoot];
    const frames = (f.frames?.length ? f.frames : f.location ? [f.location] : []).flatMap((location) => {
      const at = splitLocation(location);
      const file = at ? resolveReportedFile(roots, at.file) : null;
      return file && at ? [{ file, line: at.line }] : [];
    });
    const reported = { site: failureSite(context, f), frames, spec: resolveReportedFile(roots, f.file) };
    reportedAt.set(f, reported);
    return reported;
  };

  /** A file's text as saved; null when it cannot be read. */
  const readSaved = (file: string): string | null => {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  };

  /**
   * The latest diffs of each file a failure goes through against the texts its failures are followed from, reused while
   * neither text changes: an edit diffs its own file again, not the others.
   */
  const diffs = new Map<string, Array<{ before: string; after: string; hunks: DiffHunk[] }>>();

  /**
   * One pass placing failures on the files as they stand (an open file's buffer, else the disk): each file is read
   * once, diffed against each text a failure is followed from when either changed, and scanned once for its tests.
   * `known` is a file's text the pass reads as given. `seed` is an earlier pass whose texts and placements this one
   * starts from: a file it read is not read again, a failure it placed is not placed again.
   */
  const placer = (known?: { file: string; text: string }, seed?: PlacerSeed) => {
    const texts = new Map<string, string | null>(seed?.texts ?? []);
    if (known) texts.set(known.file, known.text);
    const read = (file: string): string | null => {
      if (!texts.has(file)) texts.set(file, readText(file));
      return texts.get(file) ?? null;
    };
    const lines = new Map<string, string[]>();
    /** A line (1-based) of a file as it stands; null when the file has no such line. */
    const lineAt = (file: string, line: number): string | null => {
      if (!lines.has(file)) lines.set(file, read(file)?.split(/\r?\n/) ?? []);
      return lines.get(file)![line - 1] ?? null;
    };
    const saved = new Map<string, string | null>();
    /** The files this pass placed a line of. */
    const diffed = new Set<string>(seed?.diffed ?? []);
    const titles = new Map<string, Set<string>>();
    const titlesIn = (text: string): Set<string> => {
      if (!titles.has(text)) titles.set(text, testTitles(text));
      return titles.get(text)!;
    };
    const placed = new Map<Placeable, Placement | null>(seed?.placed ?? []);

    /**
     * The text a file had for the run a failure is listed from: at the run's commit when it ran in CI and the
     * repository holds that commit, else as saved when the service first placed the failure. The commit's file is read
     * once; until it is, the saved text stands in, and the failures are placed again once it is read.
     */
    const anchorOf = (context: PiwiContext, f: Placeable, file: string): string | null => {
      const commit = ciCommit(context, f.runId);
      const repoRelative = commit ? relativeTo(context.repoRoot, file) : null;
      if (commit && repoRelative) {
        const atCommit = context.textAtCommit(commit, repoRelative);
        if (typeof atCommit.text === 'string') return atCommit.text;
        if (atCommit.text === undefined) placeAgainOnRead(atCommit.read);
      }
      let anchors = context.failureAnchors.get(f.executionId);
      if (!anchors) context.failureAnchors.set(f.executionId, (anchors = new Map()));
      if (!anchors.has(file)) {
        if (!saved.has(file)) saved.set(file, readSaved(file));
        const text = saved.get(file) ?? null;
        if (text === null) return null;
        anchors.set(file, text);
      }
      return anchors.get(file)!;
    };

    /** Where a line (1-based) of a file, as the run reported it, is in the file as it stands. */
    const placeIn = (
      context: PiwiContext,
      f: Placeable,
      file: string,
      line: number,
    ): { line: number; state: LineState } => {
      const before = anchorOf(context, f, file);
      const after = read(file);
      if (before === null || after === null) return { line, state: 'same' };
      diffed.add(file);
      const done = diffs.get(file) ?? [];
      let hunks = done.find((d) => d.before === before && d.after === after)?.hunks;
      if (!hunks) {
        hunks = before === after ? [] : diffLines(file, before, after).hunks;
        diffs.set(file, [...done.filter((d) => d.before !== before), { before, after, hunks }]);
      }
      return placeLine(line, hunks);
    };

    /**
     * Whether a failure's test left its spec: its `test(…)` call is in the spec the run saw, not in the spec as it
     * stands.
     */
    const testLeft = (context: PiwiContext, f: Placeable): boolean => {
      const { spec } = reportedOf(context, f);
      const before = spec ? anchorOf(context, f, spec) : null;
      const current = spec ? read(spec) : null;
      return before !== null && current !== null && titlesIn(before).has(f.title) && !titlesIn(current).has(f.title);
    };

    /** Whether a config folder holds a spec (relative to a config, as a failure names it): checked once per pass. */
    const specsUnder = new Map<string, boolean>();
    const holdsSpec = (root: string, spec: string): boolean => {
      const key = `${root}\n${spec}`;
      if (!specsUnder.has(key)) specsUnder.set(key, resolveReportedFile([root], spec) !== null);
      return specsUnder.get(key)!;
    };

    /**
     * Whether another context shows `f`: its spec is not under this context's config folder, and is under another's.
     * The configs of a repository that read one project each list all its failures: each shows once, from the config
     * its spec belongs to.
     */
    const placedElsewhere = (context: PiwiContext, f: Placeable): boolean =>
      !holdsSpec(context.root, f.file) && contexts.some((c) => c !== context && holdsSpec(c.root, f.file));

    /** Where a failure shows; null when none of its files is in the workspace, or another context shows it. */
    const place = (context: PiwiContext, f: Placeable): Placement | null => {
      if (placed.has(f)) return placed.get(f)!;
      const { site, frames } = reportedOf(context, f);
      let result: Placement | null = null;
      if (site && !placedElsewhere(context, f)) {
        const here = placeIn(context, f, site.file, site.line);
        result = {
          file: site.file,
          line: Math.max(1, here.line),
          state: testLeft(context, f) ? 'gone' : here.state,
          frames: frames.map((frame) => ({
            file: frame.file,
            line: Math.max(1, placeIn(context, f, frame.file, frame.line).line),
          })),
        };
      }
      placed.set(f, result);
      return result;
    };

    return { place, lineAt, diffed, texts, placed };
  };
  type Placer = ReturnType<typeof placer>;

  /** The latest pass of `publishFailures`. */
  let lastPass: PlacerSeed | null = null;

  /**
   * The latest pass without the placements of the failures `file` holds: their site, a frame of their stack or their
   * spec, or a failure not placed yet. The files it read stand as they were, but `file`.
   */
  const seedWithout = (seed: PlacerSeed, file: string): PlacerSeed => {
    const placed = new Map(seed.placed);
    for (const context of contexts) {
      for (const f of [...(context.failures?.failures ?? []), ...(context.failures?.resolved ?? [])]) {
        const reported = reportedAt.get(f);
        const holds =
          !reported ||
          (!!reported.site && samePath(reported.site.file, file)) ||
          reported.frames.some((frame) => samePath(frame.file, file)) ||
          (!!reported.spec && samePath(reported.spec, file));
        if (holds) placed.delete(f);
      }
    }
    return { texts: seed.texts, diffed: seed.diffed, placed };
  };

  /** The commit reads whose end places the failures again. */
  const awaitedReads = new WeakSet<Promise<string | null>>();
  const placeAgainOnRead = (read: Promise<string | null>) => {
    if (awaitedReads.has(read)) return;
    awaitedReads.add(read);
    void read.then(() => placeAgainSoon());
  };
  let placeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the next placement places every failure again. */
  let placeAll = false;
  /** The URIs of the documents edited since the latest placement, by file. */
  const editedSincePlaced = new Map<string, string>();
  /**
   * Place the failures again on the next turn: once for the edits and the reads that ask meanwhile. With `edited`, a
   * document that changed, only the failures it holds are placed again, unless another caller asks for all of them.
   */
  const placeAgainSoon = (edited?: TextDocument) => {
    if (stopped) return;
    const file = edited ? uriToPath(edited.uri) : null;
    // A document that is no file holds no failure.
    if (edited && !file) return;
    if (edited && file) editedSincePlaced.set(file, edited.uri);
    else placeAll = true;
    if (placeTimer) return;
    placeTimer = setTimeout(() => {
      placeTimer = null;
      const edits = [...editedSincePlaced];
      editedSincePlaced.clear();
      if (placeAll || !lastPass) {
        placeAll = false;
        publishFailures();
        return;
      }
      for (const [file, uri] of edits) {
        const document = documents.get(uri);
        publishFailures(document ? { file, text: document.getText() } : undefined);
      }
    }, 0);
  };

  /**
   * The 0-based line of `file` a failure went through: its innermost frame within `from`–`to` (the test),
   * else within the file, else `from`.
   */
  const failureLine = (frames: Placement['frames'], file: string, from: number, to: number): number => {
    const here = frames.filter((frame) => samePath(frame.file, file)).map((frame) => frame.line - 1);
    return here.find((line) => line >= from && line <= to) ?? here[0] ?? from;
  };

  /** A failure's spec relative to the Playwright config's folder, with forward slashes, as the run reported it otherwise. */
  const specOf = (context: PiwiContext, f: Placeable): string => {
    const spec = reportedOf(context, f).spec;
    return (spec ? relativeTo(context.root, spec) : null) ?? f.file.replace(/\\/g, '/');
  };

  /**
   * Each context's failures where they show, then the failures a later run passed, at their `test(…)` line, with its
   * latest complete run, the runs laid over it and its baseline: one context's as the answer's, several under a node
   * each (`failuresAnswer`).
   */
  const failuresResult = (pass: Placer): FailuresResult => {
    const views = contexts.flatMap((context): ContextFailures[] => {
      const client = context.client;
      if (!client) return [];
      const failing = (context.failures?.failures ?? []).flatMap((f): WorkspaceFailure[] => {
        const at = pass.place(context, f);
        if (!at || at.state === 'gone') return [];
        return [
          {
            uri: pathToFileURL(at.file).href,
            root: context.root,
            line: at.line - 1,
            title: f.title,
            headline: f.headline,
            executionId: f.executionId,
            runId: f.runId ?? context.failures?.run?.id ?? 0,
            url: client.executionUrl(f.executionId),
            hasTrace: f.traces.length > 0,
            source: failureSource(context, f.runId ?? context.failures?.run?.id),
            state: at.state === 'edited' ? 'edited' : 'failing',
            browserName: f.browserName ?? null,
            file: specOf(context, f),
            status: f.status === 'timedOut' ? 'timedOut' : 'failed',
            testCaseId: f.testCaseId,
            clusterId: f.clusterId ?? null,
            clusterTitle: f.clusterTitle ?? null,
            owner: f.owner ?? null,
            isNew: f.isNew ?? false,
            duration: f.duration ?? null,
            hasScreenshot: !!f.screenshot,
          },
        ];
      });
      const fixed = (context.failures?.resolved ?? []).flatMap((r): WorkspaceFailure[] => {
        const at = pass.place(context, r);
        if (!at || at.state === 'gone') return [];
        const failed = context.failures?.failures.find((f) => f.testCaseId === r.testCaseId);
        return [
          {
            uri: pathToFileURL(at.file).href,
            root: context.root,
            line: at.line - 1,
            title: r.title,
            headline: null,
            executionId: r.executionId,
            runId: r.runId,
            url: client.executionUrl(r.executionId),
            hasTrace: false,
            source: failureSource(context, r.runId),
            state: 'fixed-locally',
            browserName: r.browserName,
            file: specOf(context, r),
            testCaseId: r.testCaseId,
            clusterId: null,
            clusterTitle: null,
            owner: failed?.owner ?? null,
            isNew: false,
            duration: null,
            hasScreenshot: false,
          },
        ];
      });
      const run = context.failures?.run;
      return [
        {
          root: context.root,
          label: contextLabel(context.root, folders),
          projectName: context.project?.name ?? null,
          items: [...failing, ...fixed],
          run: run
            ? {
                id: run.id,
                branch: run.branch,
                status: run.status,
                startTime: run.startTime,
                totalTests: run.totalTests,
                passedTests: run.passedTests,
                failedTests: run.failedTests,
                flakyTests: run.flakyTests,
                skippedTests: run.skippedTests,
                url: client.runUrl(run.id),
                ...(run.origin ? { origin: run.origin } : {}),
                own: isOwnRun(context, run.id),
              }
            : null,
          overlays: (context.failures?.overlays ?? []).map((o) => ({
            id: o.id,
            origin: o.origin,
            startTime: o.startTime,
            status: o.status,
            totalTests: o.totalTests,
            passedTests: o.passedTests,
            failedTests: o.failedTests,
            url: client.runUrl(o.id),
            own: isOwnRun(context, o.id),
          })),
          baseline: { choice: context.baseline, label: context.baselineLabel },
          ...(context.runReadAt !== null ? { updatedAt: new Date(context.runReadAt).toISOString() } : {}),
        },
      ];
    });
    return failuresAnswer(views, failuresGrouping);
  };
  /** The failures last sent in `piwi/failuresChanged`. */
  let failuresSent = JSON.stringify(failuresAnswer([], 'file'));

  /**
   * Place every context's failures on the files as they stand, publish the files whose failure diagnostics changed,
   * and send `piwi/failuresChanged` when the failures' list did. A failure whose test left its spec publishes nothing;
   * the others publish with the severity the credentials choose (`failureSeverity`), none with `off`. With `edited`, a
   * document's text as it stands, only the failures it holds are placed again, on the texts the latest pass read for
   * the other files.
   */
  const publishFailures = (edited?: { file: string; text: string }) => {
    const pass = edited && lastPass ? placer(edited, seedWithout(lastPass, edited.file)) : placer();
    lastPass = { texts: pass.texts, diffed: pass.diffed, placed: pass.placed };
    const next = new Map<string, Diagnostic[]>();
    for (const context of contexts) {
      for (const f of context.failures?.failures ?? []) {
        const at = pass.place(context, f);
        if (!at || at.state === 'gone') continue;
        const text = pass.lineAt(at.file, at.line) ?? '';
        const start = text.length - text.trimStart().length;
        const uri = pathToFileURL(at.file).href;
        const edited = at.state === 'edited';
        const otherBranch = context.runBranch !== context.checkedOutBranch;
        const severity = failureSeverity(credentials.failureSeverity, otherBranch, edited);
        if (severity === null) continue;
        const run = runLabel(context, f);
        const where = `${f.title}, ${run}${otherBranch ? ` on ${context.runBranch ?? 'another branch'}` : ''}`;
        const headline = f.headline ?? 'Failed';
        (next.get(uri) ?? next.set(uri, []).get(uri)!).push({
          range: {
            start: { line: at.line - 1, character: start },
            end: { line: at.line - 1, character: Math.max(start, text.trimEnd().length) },
          },
          severity,
          source: 'Piwi',
          code: 'ci-failure',
          codeDescription: context.client ? { href: context.client.executionUrl(f.executionId) } : undefined,
          message: edited ? `Edited since ${run}: ${headline} (${where})` : `${headline} (${where})`,
          data: {
            root: context.root,
            executionId: f.executionId,
            ...(edited ? { edited: true } : {}),
          } satisfies FailureData,
        });
      }
    }
    const previous = failureDiagnostics;
    failureDiagnostics = next;
    for (const uri of new Set([...previous.keys(), ...next.keys()])) {
      if (JSON.stringify(previous.get(uri) ?? []) !== JSON.stringify(next.get(uri) ?? [])) publish(uri);
    }
    const failures = failuresResult(pass);
    for (const file of diffs.keys()) if (!pass.diffed.has(file)) diffs.delete(file);
    // A read that changed nothing but its time is not a change.
    const serialized = JSON.stringify({ ...failures, updatedAt: undefined });
    if (serialized !== failuresSent) {
      failuresSent = serialized;
      void connection.sendNotification(FAILURES_NOTIFICATION, failures);
    }
  };

  /** The texts of the versions of the files the coverage names, beside the repository's. */
  const blobTexts = new BlobTexts();
  /**
   * The `piwi/coverage` answer the client holds for each document it asked about, serialized: a change is pushed
   * against it (`piwi/coverageChanged`).
   */
  const coverageHeld = new Map<string, string>();
  /** How many computations of each document's answer started: only the latest one is pushed. */
  const coverageTurns = new Map<string, number>();
  /** The latest marks of each file, by URI, for the text and the coverage they were computed from. */
  const marksKept = new Map<string, { text: string; coverage: FileCoverage; marks: Promise<CoverageMarks> }>();
  /** The URIs whose marks are kept at most; the least recently computed goes first. */
  const MAX_MARKS = 100;

  /** An application file the coverage may name: its context and repository-relative path; null for test code. */
  const coverageTarget = (uri: string): { file: string; context: PiwiContext; repoRelative: string } | null => {
    const file = uriToPath(uri);
    const context = file ? contextFor(file) : null;
    if (!file || !context?.client || !context.project || isTestCode(context, relativeTo(context.root, file)))
      return null;
    const repoRelative = relativeTo(context.repoRoot, file);
    return repoRelative ? { file, context, repoRelative } : null;
  };

  /**
   * A file's coverage as its context reads it; null without asking the instance when the instance has no coverage
   * route, or the code index says no coverage reaches the file.
   */
  const coverageOfTarget = (target: { context: PiwiContext; repoRelative: string }): Promise<FileCoverage | null> =>
    target.context.coverageRoute &&
    mayHaveCoverage(
      coverageIndexFor(
        target.context.codeIndex,
        target.context.branch,
        target.context.coverageBranch(),
        target.context.index?.defaultBranch ?? null,
      ),
      target.repoRelative,
    )
      ? target.context.coverage(target.repoRelative)
      : Promise.resolve(null);

  /**
   * The coverage of a file and its marks on the file as it stands, open or saved, computed once per text and coverage;
   * null when no coverage names the file.
   */
  const coverageMarksOf = async (uri: string): Promise<{ coverage: FileCoverage; marks: CoverageMarks } | null> => {
    const target = coverageTarget(uri);
    if (!target) return null;
    const coverage = await coverageOfTarget(target);
    const text = readText(target.file);
    if (!coverage?.fragments.length || text === null) return null;
    const kept = marksKept.get(uri);
    if (kept && kept.text === text && kept.coverage === coverage) return { coverage, marks: await kept.marks };
    const versions = coverageVersions(coverage);
    const marks = chooseVersion(
      versions,
      text,
      () => readSaved(target.file),
      (blob) => blobTexts.textOf(target.context.repoRoot, blob),
      (seen, blob) => blobTexts.remember(seen, blob),
    ).then((chosen) => coverageMarks(coverage, versions, chosen, text));
    marksKept.delete(uri);
    marksKept.set(uri, { text, coverage, marks });
    for (const oldest of [...marksKept.keys()].slice(0, Math.max(0, marksKept.size - MAX_MARKS)))
      marksKept.delete(oldest);
    return { coverage, marks: await marks };
  };

  /**
   * The uncovered changes of an application file as it stands, open or saved (`uncoveredFile`): its lines changed
   * since the change's base (`PiwiContext.atChangeBase`), and what they are in a few words; null when its changes are
   * not uncovered, or it has none.
   */
  const uncoveredOf = async (uri: string): Promise<{ uncovered: LineSpan[]; label: string } | null> => {
    const target = coverageTarget(uri);
    if (!target) return null;
    const { context, file, repoRelative } = target;
    const coverage = await coverageOfTarget(target).catch(() => null);
    if (!uncoveredFile(context.codeIndex, context.index, repoRelative, coverage)) return null;
    const text = readText(file);
    const base = text === null ? null : await context.atChangeBase(repoRelative);
    if (text === null || !base) return null;
    const uncovered = changedSince(base.text, text, repoRelative);
    const lines = uncovered.reduce((n, span) => n + span.end - span.start + 1, 0);
    if (!lines) return null;
    return { uncovered, label: `${plural(lines, 'line')} changed since ${base.branch}, and no test reaches this file` };
  };

  /** A document's `piwi/coverage` answer as it stands, computed in full: its coverage marks, else its uncovered changes. */
  const coverageNow = async (uri: string): Promise<CoverageResult> => {
    const marks = (await coverageMarksOf(uri).catch(() => null))?.marks ?? null;
    const result = coverageResult(uri, marks);
    if (result.state !== 'none') return result;
    const uncovered = await uncoveredOf(uri).catch(() => null);
    return uncovered ? { ...result, ...uncovered } : result;
  };

  const nextCoverageTurn = (uri: string): number => {
    const turn = (coverageTurns.get(uri) ?? 0) + 1;
    coverageTurns.set(uri, turn);
    return turn;
  };

  /** Tell the client a document's marks changed from the answer it holds, when no later computation started. */
  const pushCoverage = (uri: string, turn: number, result: CoverageResult) => {
    const held = coverageHeld.get(uri);
    if (coverageTurns.get(uri) !== turn || held === undefined) return;
    const serialized = JSON.stringify(result);
    if (serialized === held) return;
    coverageHeld.set(uri, serialized);
    void connection.sendNotification(COVERAGE_NOTIFICATION, result);
  };

  /**
   * The URIs the client holds an answer for that name the file of `uri`, whatever form of its URI each was asked with
   * (`file:///c%3A/…` and `file:///C:/…` on Windows), `uri` first.
   */
  const urisOf = (uri: string): string[] => {
    const file = uriToPath(uri);
    const held = [...coverageHeld.keys()].filter((other) => {
      const path = other === uri ? null : uriToPath(other);
      return !!file && !!path && samePath(path, file);
    });
    return [uri, ...held];
  };

  /** Compute the answers of `uris` again, and push those that changed from what the client holds. */
  const coverageAgain = (uris: string[]) => {
    for (const uri of uris) {
      const turn = nextCoverageTurn(uri);
      if (coverageHeld.has(uri)) void coverageNow(uri).then((result) => pushCoverage(uri, turn, result));
    }
  };

  /** The run each context's coverage was last read after, by the ids of its latest run and the runs laid over it. */
  const coverageRuns = new WeakMap<PiwiContext, string>();
  const rereading = new Set<PiwiContext>();
  const rereadAgain = new Set<PiwiContext>();
  /**
   * A run of the context ended: its code index and the coverage of the files the client holds are read again, with
   * their `ETag`, and the marks that changed are pushed. A run that ends meanwhile reads them once more after.
   */
  const coverageAfterRun = async (context: PiwiContext): Promise<void> => {
    if (rereading.has(context)) {
      rereadAgain.add(context);
      return;
    }
    rereading.add(context);
    try {
      do {
        rereadAgain.delete(context);
        await context.refreshCodeIndex();
        context.staleCoverage();
        coverageAgain([...coverageHeld.keys()].filter((uri) => coverageTarget(uri)?.context === context));
      } while (rereadAgain.has(context));
    } finally {
      rereading.delete(context);
    }
  };

  /** Read the coverage again after each context whose latest run or the runs laid over it changed since. */
  const coverageAfterRuns = () => {
    for (const c of contexts) {
      const key = JSON.stringify([c.failures?.run?.id ?? null, (c.failures?.overlays ?? []).map((o) => o.id)]);
      const before = coverageRuns.get(c);
      coverageRuns.set(c, key);
      if (before !== undefined && before !== key) void coverageAfterRun(c);
    }
  };

  /**
   * What the coverage says of a line (0-based): the tests that ran it, that none does, or that it changed since, then
   * what the marks mean; in a file without coverage, that the line is an uncovered change.
   */
  const coverageHover = async (uri: string, line: number): Promise<string | null> => {
    const target = coverageTarget(uri);
    const found = target
      ? await within(
          coverageMarksOf(uri).catch(() => null),
          null,
        )
      : null;
    const marks = found?.marks;
    if (target && !marks) {
      const uncovered = await within(
        uncoveredOf(uri).catch(() => null),
        null,
      );
      const marked = uncovered?.uncovered.some((span) => span.start <= line && line <= span.end);
      return marked
        ? `**Piwi** · uncovered change: ${uncovered!.label}. The pull request's change coverage will list it.\n\n${UNCOVERED_EXPLAINED}`
        : null;
    }
    if (!target || !found || !marks || (marks.state !== 'exact' && marks.state !== 'mapped')) return null;
    const at = line + 1;
    if (marks.changed.has(at)) {
      return `**Piwi coverage** · changed since the coverage run: no test has run this line as it stands yet\n\n${COVERAGE_MARKS_EXPLAINED}`;
    }
    const tests = (marks.executed.get(at) ?? []).flatMap((i) => found.coverage.tests[i] ?? []);
    if (tests.length) {
      const list = tests
        .slice(0, 10)
        .map(
          (t) =>
            `- ${statusIcon(t.status)} [${t.title.replace(/[[\]]/g, '')}](${target.context.client?.testUrl(t.id) ?? ''}) · \`${t.file}\``,
        );
      if (tests.length > 10) list.push(`- and ${tests.length - 10} more`);
      const where = marks.state === 'mapped' ? ' · recorded on another version of this file' : '';
      return `**Piwi coverage** · run by ${plural(tests.length, 'test')}${where}\n\n${list.join('\n')}\n\n${COVERAGE_MARKS_EXPLAINED}`;
    }
    return marks.notRun.has(at) ? `**Piwi coverage** · no test runs this line\n\n${COVERAGE_MARKS_EXPLAINED}` : null;
  };

  const runStatus = (): RunStatusResult => ({
    contexts: contexts
      .filter((c) => c.client && c.project)
      .map((c): RunStatus => {
        const run = c.failures?.run ?? null;
        const failing = new Set((c.failures?.failures ?? []).map((f) => f.testCaseId));
        const fixed = new Set((c.failures?.resolved ?? []).map((r) => r.testCaseId).filter((id) => !failing.has(id)));
        return {
          root: c.root,
          branch: c.runBranch,
          checkedOut: c.checkedOutBranch,
          run: run
            ? {
                id: run.id,
                status: run.status,
                startTime: run.startTime,
                totalTests: run.totalTests,
                passedTests: run.passedTests,
                failedTests: run.failedTests,
                flakyTests: run.flakyTests,
                skippedTests: run.skippedTests,
                url: c.client!.runUrl(run.id),
              }
            : null,
          failures: c.failures?.failures.length ?? 0,
          failingTests: failing.size,
          resolved: fixed.size,
          overlays: c.failures?.overlays?.length ?? 0,
          live: c.live ? { ...c.live } : null,
          stream: runWatch.isConnected(c) ? 'live' : 'polling',
          ...(c.runReadAt !== null ? { updatedAt: new Date(c.runReadAt).toISOString() } : {}),
          ...(c.liveTests.size
            ? { liveTests: [...c.liveTests].map(([testCaseId, status]) => ({ testCaseId, status })) }
            : {}),
          reporterVersion: c.reporterVersion,
          baseline: { choice: c.baseline, label: c.baselineLabel },
          branches: c.branches,
        };
      }),
  });

  /** Tell the client when the run status changed. */
  const sendRunStatus = () => {
    const status = runStatus();
    const serialized = JSON.stringify(status);
    if (serialized !== lastRunStatus) {
      lastRunStatus = serialized;
      void connection.sendNotification(RUN_STATUS_NOTIFICATION, status);
    }
  };

  /** Publish the failures, tell the client when the run status changed, and read the coverage again after a run. */
  const runChanged = () => {
    publishFailures();
    sendRunStatus();
    coverageAfterRuns();
  };

  /**
   * How often a context's latest run is read: every `runPollMs`, a quarter of it while a run is in progress, five times
   * it while the instance's event stream is connected, which says when a run ends. A live run is read a quarter of it
   * whatever the stream: its own stream may have closed for good.
   */
  const pollEvery = (c: PiwiContext): number => {
    const base = options.runPollMs ?? RUN_POLL_MS;
    const active = Math.min(base, RUN_POLL_ACTIVE_MS, Math.max(1, Math.floor(base / 4)));
    if (c.live) return active;
    if (runWatch.isConnected(c)) return base * STREAM_POLL_FACTOR;
    return ACTIVE_RUN.has(c.failures?.run?.status ?? '') ? active : base;
  };

  /** When each context was last polled, read or not. */
  const polledAt = new Map<PiwiContext, number>();
  const dueAt = (c: PiwiContext): number => {
    if (!polledAt.has(c)) polledAt.set(c, Date.now());
    return Math.max(polledAt.get(c)!, c.runReadAt ?? 0) + pollEvery(c);
  };

  /** Read each context's latest run again when its turn comes, and its live run with it. */
  const pollRuns = () => {
    if (stopped) return;
    if (runTimer) clearTimeout(runTimer);
    const now = Date.now();
    const next = contexts.length ? Math.min(...contexts.map(dueAt)) : now + (options.runPollMs ?? RUN_POLL_MS);
    runTimer = setTimeout(
      async () => {
        runTimer = null;
        const due = contexts.filter((c) => dueAt(c) <= Date.now());
        for (const c of due) polledAt.set(c, Date.now());
        // The due contexts read afresh, together: those of one project share each read.
        forgetShared(answers);
        const read = await Promise.all(
          due.map(async (c) => {
            const [changed, ended] = await Promise.all([c.refreshRun(), runWatch.readLive(c)]);
            if (ended) runWatch.end(c);
            return changed;
          }),
        );
        // A read that found the same runs and failures moves the time of the read and the run in progress alone.
        if (read.some(Boolean)) runChanged();
        else if (due.length) sendRunStatus();
        if (!runTimer) pollRuns();
      },
      Math.max(0, next - now),
    );
    runTimer.unref?.();
  };

  const runWatch = new RunWatch({
    contexts: () => contexts,
    changed: () => {
      runChanged();
      pollRuns();
    },
    // A run in progress moves no failure: its status alone.
    progressed: () => {
      sendRunStatus();
      pollRuns();
    },
    notice: (notice) => void connection.sendNotification(NOTICE_NOTIFICATION, notice),
    runEnded: (ended) => {
      void connection.sendNotification(RUN_ENDED_NOTIFICATION, ended);
      // The run may have recorded coverage: the files the client holds show it.
      const context = contextOfRoot(ended.root);
      if (context) void coverageAfterRun(context);
    },
    ownRunPollMs: options.ownRunPollMs,
    commandEndWaitMs: options.commandEndWaitMs,
  });

  /**
   * A fix plan as one workspace edit: its validated patch applied to each file it
   * names, else its locator rewrites whose line still reads as captured. Null when
   * nothing applies to the workspace as it is.
   */
  const fixPlanEdit = (context: PiwiContext, plan: FixPlan): { edit: WorkspaceEdit; files: number } | null => {
    const roots = [context.root, context.repoRoot];
    const next = new Map<string, string>();
    const patch = plan.diagnosis?.patch;
    const validation = plan.diagnosis?.patchValidation?.status;
    if (patch && validation !== 'stale-file' && validation !== 'invalid') {
      for (const file of parsePatch(patch)) {
        const target = resolveReportedFile(roots, file.path);
        const text = target ? (next.get(target) ?? readText(target)) : null;
        const patched = text !== null ? applyPatchFile(text, file) : null;
        if (!target || patched === null) return null;
        next.set(target, patched);
      }
    } else {
      for (const e of plan.edits) {
        if (!e.edit?.filePath) continue;
        const target = resolveReportedFile(roots, e.edit.filePath);
        const text = target ? (next.get(target) ?? readText(target)) : null;
        if (!target || text === null) continue;
        const lines = text.split(/\r?\n/);
        const current = lines[e.edit.line - 1];
        if (current === undefined || current.trim() !== e.edit.oldLine.trim()) continue;
        lines[e.edit.line - 1] =
          current.slice(0, current.length - current.trimStart().length) + e.edit.newLine.trimStart();
        next.set(target, lines.join(text.includes('\r\n') ? '\r\n' : '\n'));
      }
    }
    if (!next.size) return null;
    const whole = (text: string) => {
      const lines = text.split(/\r?\n/);
      return {
        start: { line: 0, character: 0 },
        end: { line: lines.length - 1, character: lines[lines.length - 1]!.length },
      };
    };
    const entries = [...next].map(([file, text]) => ({
      uri: pathToFileURL(file).href,
      range: whole(readText(file) ?? ''),
      newText: text,
    }));
    const edit: WorkspaceEdit = previewsEdits
      ? {
          documentChanges: entries.map((e) => ({
            textDocument: { uri: e.uri, version: null },
            edits: [{ range: e.range, newText: e.newText, annotationId: 'piwi.fixPlan' }],
          })),
          changeAnnotations: {
            'piwi.fixPlan': {
              label: `Piwi fix plan: ${plan.cluster.title ?? plan.cluster.signature}`,
              needsConfirmation: true,
            },
          },
        }
      : { changes: Object.fromEntries(entries.map((e) => [e.uri, [{ range: e.range, newText: e.newText }]])) };
    return { edit, files: next.size };
  };

  /** One block about a failure for a coding agent: the failure, its healing and its cluster's fix plan. */
  const agentContext = async (context: PiwiContext, failure: BranchFailure): Promise<string> => {
    const healing = await context.healing(failure.executionId);
    const plan = failure.clusterId ? await context.fixPlanText(failure.clusterId) : null;
    const recommended = healing?.recommendation?.recommended?.locator;
    return [
      `# Failing test: ${failure.title}`,
      '',
      failure.headline ?? 'Failed',
      failure.location ? `At ${failure.location}` : `In ${failure.file}${failure.line ? `:${failure.line}` : ''}`,
      context.client ? `Execution: ${context.client.executionUrl(failure.executionId)}` : null,
      recommended
        ? `\n## Locator healing\n\nReplace the failing locator with \`${recommended}\`${healing?.edit ? `:\n\n\`\`\`diff\n- ${healing.edit.oldLine.trim()}\n+ ${healing.edit.newLine.trim()}\n\`\`\`` : '.'}`
        : null,
      plan ? `\n${plan.trim()}` : null,
    ]
      .filter((part) => part !== null)
      .join('\n');
  };

  const contextOfRoot = (root: string) => contexts.find((c) => c.root === root) ?? null;

  const failureOf = (data: FailureData): { context: PiwiContext; failure: BranchFailure } | null => {
    const context = contextOfRoot(data.root);
    const failure = context?.failures?.failures.find((f) => f.executionId === data.executionId);
    return context && failure ? { context, failure } : null;
  };

  const isOpen = (document: TextDocument) => documents.get(document.uri) === document;

  const desktopJobs = new DesktopJobs(env, (update) => {
    void connection.sendNotification(DESKTOP_JOB_NOTIFICATION, update);
  });

  const distDir = options.distDir ?? (env.PIWI_EDITOR_DIST || bundleDir());
  const projectOptions =
    options.readProjectOptions ??
    ((configFile: string) => readProjectOptions(configFile, path.join(distDir, 'piwi-use-reporter.cjs')));
  const recordings = new RecordingSessions({
    distDir,
    notify: (update) => void connection.sendNotification(RECORDING_NOTIFICATION, update),
    readOptions: projectOptions,
    launch: options.launchRecorder,
    env,
    readText: (uri) => documents.get(uri)?.getText() ?? null,
  });

  /**
   * How a flow's URLs are written for a context: as paths when a project's `baseURL` is on the origin it was recorded
   * on, else whole; as paths when the config's options cannot be read within a few seconds.
   */
  const stepUrls = async (context: PiwiContext, origin: string | null): Promise<'relative' | 'absolute'> => {
    const configFile = playwrightConfigFile(context.root);
    if (!configFile) return 'relative';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      projectOptions(configFile).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OPTIONS_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!read) return 'relative';
    const bases = read.projects.map((p) => originOf(p.use.baseURL));
    return origin && bases.includes(origin) ? 'relative' : 'absolute';
  };

  /**
   * On a failure from a team instance, while the desktop app runs: reproduce or bisect it there, and run Flake Lab
   * on its test there when the test has a flake suspect no experiment tested.
   */
  const desktopJobActions = (context: PiwiContext, failure: BranchFailure, diagnostic: Diagnostic): CodeAction[] => {
    if (!desktopJobs.available(context)) return [];
    const job = (title: string, kind: DesktopJobKind): CodeAction => ({
      title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      command: {
        title,
        command: 'piwi.desktopJob',
        arguments: [
          {
            root: context.root,
            executionId: failure.executionId,
            ...(kind === 'flake-lab' ? { testCaseId: failure.testCaseId } : {}),
            kind,
          } satisfies DesktopJobParams,
        ],
      },
    });
    return [
      job('Reproduce in the desktop app', 'reproduce'),
      job('Find the breaking commit in the desktop app', 'bisect'),
      ...(hasUntestedSuspect(context.flakeLab.get(failure.testCaseId))
        ? [job('Run Flake Lab on its untested suspects in the desktop app', 'flake-lab')]
        : []),
    ];
  };

  async function validate(document: TextDocument): Promise<void> {
    const file = uriToPath(document.uri);
    const context = file ? contextFor(file) : null;
    if (!file || !context?.index) {
      analysisDiagnostics.delete(document.uri);
      publish(document.uri);
      return;
    }
    const lines = document.getText().split(/\r?\n/);
    const relative = relativeTo(context.root, file);
    const diagnostics: Diagnostic[] = [];
    if (isTestCode(context, relative)) {
      appAnalyses.delete(document.uri);
      if (SPEC_FILE.test(relative!) && context.timeouts.size) {
        const cases = new Map((await context.casesOf(relative!)).map((c) => [c.title, c]));
        lines.forEach((text, i) => {
          const m = TEST_CALL.exec(text);
          const found = m ? cases.get(m[2]!) : undefined;
          const advice = found ? context.timeouts.get(found.id) : undefined;
          if (!advice) return;
          const start = text.length - text.trimStart().length;
          diagnostics.push({
            range: { start: { line: i, character: start }, end: { line: i, character: text.trimEnd().length } },
            severity: DiagnosticSeverity.Information,
            source: 'Piwi',
            code: 'timeout',
            message: timeoutMessage(advice),
            data: { testCaseId: advice.testCaseId, line: i },
          });
        });
      }
      for (const finding of stabilityFindings(locatorsInFile(context.index, relative!))) {
        const text = lines[finding.line - 1] ?? '';
        const range = locatorRange(text, finding.locator);
        diagnostics.push({
          range: {
            start: { line: finding.line - 1, character: range.start },
            end: { line: finding.line - 1, character: range.end },
          },
          severity: finding.level === 'brittle' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Hint,
          source: 'Piwi',
          code: finding.level,
          message: finding.message,
          data: { locator: finding.locator, line: finding.line },
        });
      }
    } else {
      // Read once the file is open, so its marks and lenses have it when the client asks.
      const target = coverageTarget(document.uri);
      if (target) void coverageOfTarget(target);
      const repoRelative = relativeTo(context.repoRoot, file);
      const before = repoRelative ? await context.committed(repoRelative) : null;
      if (repoRelative && before !== null) {
        const maps = await context.translationMaps();
        const groups = breaksByAnchor(
          breaksOfChange(diffLines(repoRelative, before, document.getText()), context.index, {
            translations: (key, side) => (side === 'old' ? maps.old : maps.new).get(key),
            readFile: (_p, side) => (side === 'old' ? before : document.getText()),
            reach: reachFrom(context.codeIndex),
          }),
        );
        if (!isOpen(document)) return;
        appAnalyses.set(document.uri, { context, groups });
        for (const group of groups) {
          const line = Math.max(0, group.anchor.line - 1);
          const text = lines[line] ?? '';
          const at = text.indexOf(group.anchor.after ?? group.anchor.before);
          const likely = group.breaks.some((b) => b.confidence === 'likely');
          diagnostics.push({
            range: {
              start: { line, character: at >= 0 ? at : text.length - text.trimStart().length },
              end: { line, character: at >= 0 ? at + (group.anchor.after ?? group.anchor.before).length : text.length },
            },
            severity: likely ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
            source: 'Piwi',
            code: 'locator-break',
            message: breakMessage(group.anchor, group.breaks),
            data: { anchorLine: group.anchor.line, before: group.anchor.before },
          });
        }
      } else {
        appAnalyses.delete(document.uri);
      }
    }
    // Closed while the committed text, translations or cases were read: nothing to show.
    if (!isOpen(document)) return;
    analysisDiagnostics.set(document.uri, diagnostics);
    publish(document.uri);
  }

  const schedule = (document: TextDocument, delay = options.debounceMs ?? DEBOUNCE_MS) => {
    clearTimeout(timers.get(document.uri));
    timers.set(
      document.uri,
      setTimeout(() => {
        timers.delete(document.uri);
        // The failures and the coverage marks follow the edit: placed again on the edited buffer.
        placeAgainSoon(document);
        coverageAgain(urisOf(document.uri));
        void validate(document).catch((e) => connection.console.error(`Piwi: ${(e as Error).message}`));
      }, delay),
    );
  };

  const currentStatus = (): StatusResult => ({
    contexts: contexts.map((c) => ({
      root: c.root,
      label: contextLabel(c.root, folders),
      connected: !!c.index && !c.problem,
      serverUrl: c.client?.connection.serverUrl ?? null,
      source: c.source,
      projectId: c.project?.id ?? null,
      projectName: c.project?.name ?? null,
      branch: c.branch ?? c.index?.defaultBranch ?? null,
      locators: c.index?.locators.length ?? 0,
      reachedFiles: c.codeIndex?.files.length ?? 0,
      problem: c.problem,
      problemKind: c.problemKind,
      instance: c.instance,
    })),
    desktopUrl: readDesktopDiscovery(env)?.url ?? null,
  });

  let lastStatus = '';
  /**
   * The baselines the client keeps, applied to the contexts: every choice they name when the credentials carry them,
   * the ladder for a context they leave out; the choices held stay when the credentials carry none.
   */
  const applyBaselines = () => {
    const baselines = credentials.baselines;
    if (!baselines || typeof baselines !== 'object') return;
    for (const c of contexts) c.baseline = parseBaselineChoice(baselines[c.root]) ?? { kind: 'ladder' };
  };

  /** Tell the client the contexts' status when it changed. */
  const statusChanged = () => {
    const next = currentStatus();
    const serialized = JSON.stringify(next);
    if (serialized !== lastStatus) {
      lastStatus = serialized;
      void connection.sendNotification(STATUS_NOTIFICATION, next);
    }
  };

  /** The refresh running, and the one asked for meanwhile, which follows it. */
  let refreshing: Promise<void> | null = null;
  let refreshNext: Promise<void> | null = null;

  /**
   * Read every context's connection, latest run and indexes again. Refreshes never overlap: one asked for while another
   * runs follows it, once for all the asks meanwhile, and reads with the credentials of the latest.
   */
  function refreshAll(): Promise<void> {
    if (!refreshing) {
      refreshing = refreshContexts().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }
    refreshNext ??= refreshing
      .catch(() => undefined)
      .then(() => {
        refreshNext = null;
        return refreshAll();
      });
    return refreshNext;
  }

  async function refreshContexts(): Promise<void> {
    // The contexts read afresh, together: those of one project share each read.
    forgetShared(answers);
    // A context's failures are published once its run is read, without waiting for the indexes read after it.
    const runRead = () => {
      runChanged();
      statusChanged();
    };
    await Promise.all(contexts.map((c) => c.refresh(env, credentials, runRead)));
    runWatch.sync();
    // A key the instance refused may be valid again: the streams it refused are opened again on each refresh.
    runWatch.retryRefused();
    runChanged();
    statusChanged();
    // The coverage is asked again with its `ETag`: the open documents' marks as they are analyzed again, the others now.
    // A version the repository lacked may have been fetched since: the marks are placed again.
    void blobTexts.forgetMissing();
    marksKept.clear();
    for (const c of contexts) c.staleCoverage();
    for (const document of documents.all()) schedule(document, 0);
    coverageAgain([...coverageHeld.keys()].filter((uri) => !documents.get(uri)));
    retryUnreachable();
  }

  /** Read again soon while an instance does not answer: 15 s, then twice as long each time, up to the refresh's pace. */
  function retryUnreachable(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (stopped || !contexts.some((c) => c.problemKind === 'unreachable')) {
      retryWait = 0;
      return;
    }
    const refreshMs = options.refreshMs ?? REFRESH_MS;
    retryWait = Math.min(refreshMs, retryWait ? retryWait * 2 : (options.unreachableRetryMs ?? UNREACHABLE_RETRY_MS));
    if (retryWait >= refreshMs) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void refreshAll();
    }, retryWait);
    retryTimer.unref?.();
  }

  /**
   * A repository's `HEAD` moved, by a checkout or a commit: its contexts drop what `HEAD` gave them and read the latest
   * run again, the checked-out branch's, published when it changed, and the open documents are analyzed again, so the
   * locators a change breaks are compared with the new `HEAD`.
   */
  async function headMoved(members: PiwiContext[]): Promise<void> {
    forgetShared(answers);
    const changed = await Promise.all(
      members.map(async (c) => {
        await c.headMoved();
        return c.refreshRun();
      }),
    );
    if (stopped) return;
    if (changed.some(Boolean)) {
      runChanged();
      pollRuns();
    }
    for (const document of documents.all()) schedule(document, 0);
    // The uncovered changes of a file the client holds marks of are counted from the new base.
    coverageAgain([...coverageHeld.keys()].filter((uri) => !documents.get(uri)));
  }

  /**
   * Watch `HEAD` and `logs/HEAD` of each repository the contexts are in, as the desktop app's file is watched: a
   * checkout writes the first, a commit the second. A move while one is read is read once more after it.
   */
  async function watchRepositories(): Promise<void> {
    const byRoot = new Map<string, PiwiContext[]>();
    for (const c of contexts) {
      const root = await repositoryRoot(c.root);
      byRoot.set(root, [...(byRoot.get(root) ?? []), c]);
    }
    for (const [root, members] of byRoot) {
      const files = await headFiles(root);
      if (stopped) return;
      let moving: Promise<void> | null = null;
      let again = false;
      const listener = (now: fs.Stats, before: fs.Stats) => {
        if (now.mtimeMs === before.mtimeMs && now.size === before.size) return;
        if (moving) {
          again = true;
          return;
        }
        moving = (async () => {
          do {
            again = false;
            await headMoved(members);
          } while (again && !stopped);
        })().finally(() => {
          moving = null;
        });
      };
      for (const file of files) {
        fs.watchFile(file, { interval: options.gitWatchMs ?? GIT_WATCH_MS, persistent: false }, listener);
        headWatches.push({ file, listener });
      }
    }
  }

  connection.onInitialize((params: InitializeParams) => {
    folders = (params.workspaceFolders ?? []).map((f) => uriToPath(f.uri)).filter((f): f is string => !!f);
    if (!folders.length && params.rootUri) {
      const root = uriToPath(params.rootUri);
      if (root) folders = [root];
    }
    const workspaceEdit = params.capabilities.workspace?.workspaceEdit;
    previewsEdits = !!workspaceEdit?.documentChanges && !!workspaceEdit.changeAnnotationSupport;
    const init = params.initializationOptions as { credentials?: EditorCredentials } | undefined;
    credentials = init?.credentials ?? {};
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['.', '('] },
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      },
      serverInfo: { name: 'Piwi' },
    };
  });

  connection.onInitialized(() => {
    for (const folder of folders) {
      for (const root of findPlaywrightRoots(folder)) {
        if (!contexts.some((c) => c.root === root)) contexts.push(new PiwiContext(root, answers));
      }
    }
    applyBaselines();
    void refreshAll();
    void pruneEvidence();
    refreshTimer = setInterval(() => void refreshAll(), options.refreshMs ?? REFRESH_MS);
    refreshTimer.unref?.();
    pollRuns();
    // The desktop app writes its discovery file when it starts or a folder link
    // changes, and removes it on quit: read the connection again then.
    fs.watchFile(
      desktopFile,
      { interval: options.desktopWatchMs ?? DESKTOP_WATCH_MS, persistent: false },
      onDesktopFile,
    );
    // A checkout or a commit is read within seconds: the latest run and the diagnostics follow the new `HEAD`.
    void watchRepositories();
  });

  documents.onDidOpen((e) => schedule(e.document, 0));
  documents.onDidChangeContent((e) => schedule(e.document));
  documents.onDidClose((e) => {
    recordings.stopFile(e.document.uri);
    clearTimeout(timers.get(e.document.uri));
    timers.delete(e.document.uri);
    appAnalyses.delete(e.document.uri);
    analysisDiagnostics.delete(e.document.uri);
    for (const uri of urisOf(e.document.uri)) {
      coverageHeld.delete(uri);
      coverageTurns.delete(uri);
      marksKept.delete(uri);
    }
    publish(e.document.uri);
    // Its failures, on the file as saved.
    placeAgainSoon();
  });

  connection.onCodeAction(async (params, token): Promise<CodeAction[]> => {
    const file = uriToPath(params.textDocument.uri);
    const context = file ? contextFor(file) : null;
    const document = documents.get(params.textDocument.uri);
    if (!file || !context || !document) return [];
    const actions: CodeAction[] = [];
    const lines = document.getText().split(/\r?\n/);
    for (const diagnostic of params.context.diagnostics) {
      // A request the client canceled, as it does once the cursor moved, is not answered further.
      if (token.isCancellationRequested) return [];
      if (diagnostic.source !== 'Piwi') continue;
      if (diagnostic.code === 'brittle' || diagnostic.code === 'watch') {
        const { locator, line } = diagnostic.data as { locator: string; line: number };
        const relative = relativeTo(context.root, file);
        if (!relative) continue;
        const replacement = stableReplacement(locator, line, relative, await context.alternativesOf(relative));
        const text = lines[line - 1] ?? '';
        const next = replacement ? replaceLocatorOnLine(text, locator, replacement.locator) : null;
        if (!replacement || next === null) continue;
        actions.push({
          title: `Use ${replacement.locator} (as of the last passing run)`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: {
            changes: {
              [params.textDocument.uri]: [
                {
                  range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: text.length } },
                  newText: next,
                },
              ],
            },
          },
        });
      } else if (diagnostic.code === 'timeout') {
        const { testCaseId, line } = diagnostic.data as { testCaseId: number; line: number };
        const advice = context.timeouts.get(testCaseId);
        const change = advice ? timeoutEdit(lines, line, advice) : null;
        if (!advice || !change) continue;
        const current = lines[change.line] ?? '';
        actions.push({
          title:
            advice.kind === 'stale-slow' ? 'Remove test.slow()' : `Set the timeout to ${advice.recommendedTimeout} ms`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: {
            changes: {
              [params.textDocument.uri]: [
                change.replace
                  ? change.text
                    ? {
                        range: {
                          start: { line: change.line, character: 0 },
                          end: { line: change.line, character: current.length },
                        },
                        newText: change.text,
                      }
                    : {
                        range: {
                          start: { line: change.line, character: 0 },
                          end: { line: change.line + 1, character: 0 },
                        },
                        newText: '',
                      }
                  : {
                      range: { start: { line: change.line, character: 0 }, end: { line: change.line, character: 0 } },
                      newText: `${change.text}\n`,
                    },
              ],
            },
          },
        });
      } else if (diagnostic.code === 'locator-break') {
        const analysis = appAnalyses.get(params.textDocument.uri);
        const { anchorLine, before } = diagnostic.data as { anchorLine: number; before: string };
        const group = analysis?.groups.find((g) => g.anchor.line === anchorLine && g.anchor.before === before);
        if (!group) continue;
        const edits = rewriteEdits(group.breaks, (f, l) => lineOf(path.resolve(context.root, f), l));
        if (!edits.length) continue;
        const changes: Record<string, TextEdit[]> = {};
        for (const edit of edits) {
          const uri = pathToFileURL(path.resolve(context.root, edit.file)).href;
          (changes[uri] ??= []).push({
            range: {
              start: { line: edit.line - 1, character: 0 },
              end: { line: edit.line - 1, character: edit.oldText.length },
            },
            newText: edit.newText,
          });
        }
        const files = [...new Set(edits.map((e) => path.basename(e.file)))];
        actions.push({
          title: `Update ${plural(edits.length, 'locator')} in ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`,
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          isPreferred: true,
          edit: { changes },
        });
      } else if (diagnostic.code === 'ci-failure') {
        const data = diagnostic.data as FailureData;
        const found = failureOf(data);
        if (!found) continue;
        const { context: owner, failure } = found;
        const fixes: CodeAction[] = [];
        // Asked together; each waited for a while at most.
        const healingAsked = within(owner.healing(failure.executionId), null);
        const fixPlanAsked = failure.clusterId ? within(owner.fixPlan(failure.clusterId), null) : null;
        const issuesAsked = owner.client && failure.clusterId ? within(owner.issuesOf(failure), null) : null;
        const healing = await healingAsked;
        const edit = healing?.edit;
        const line = diagnostic.range.start.line;
        const current = lines[line] ?? '';
        // The healing's edit names the line the run reported, wherever the edits since moved it.
        const reported = reportedOf(owner, failure).site?.line ?? line + 1;
        if (edit && edit.line === reported && current.trim() === edit.oldLine.trim() && edit.newLine.trim()) {
          const indent = current.slice(0, current.length - current.trimStart().length);
          fixes.push({
            title: `Heal: use ${healing!.recommendation?.recommended?.locator ?? edit.newLine.trim()}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: {
              changes: {
                [params.textDocument.uri]: [
                  {
                    range: { start: { line, character: 0 }, end: { line, character: current.length } },
                    newText: indent + edit.newLine.trimStart(),
                  },
                ],
              },
            },
          });
        }
        // First on a failure whose line changed since the run, after the heal otherwise.
        fixes.splice(data.edited ? 0 : fixes.length, 0, {
          title: 'Run this test',
          kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic],
          command: {
            title: 'Run this test',
            command: 'piwi.runTests',
            arguments: [
              { uri: params.textDocument.uri, root: owner.root, testIds: [failure.testCaseId] } satisfies RunTestsArgs,
            ],
          },
        });
        actions.push(...fixes);
        if (failure.traces.length) {
          actions.push({
            title: 'Open the trace',
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            command: {
              title: 'Open the trace',
              command: 'piwi.openTrace',
              arguments: [{ uri: params.textDocument.uri, executionId: failure.executionId } satisfies TraceParams],
            },
          });
        }
        actions.push(...desktopJobActions(owner, failure, diagnostic));
        const fixPlan = await fixPlanAsked;
        const planEdit = fixPlan ? fixPlanEdit(owner, fixPlan) : null;
        const verification = fixPlan ? verificationCommand(fixPlan.verify.command) : null;
        if (planEdit && verification) {
          actions.push({
            title: `Apply the fix plan (${plural(planEdit.files, 'file')}), then run its verification`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: planEdit.edit,
            command: {
              title: 'Run the verification',
              command: 'piwi.runCommand',
              arguments: [
                { cwd: commandFolder(owner), command: verification, env: editorRunEnv() } satisfies RunCommandArgs,
              ],
            },
          });
        } else if (planEdit) {
          actions.push({
            title: `Apply the fix plan (${plural(planEdit.files, 'file')})`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: planEdit.edit,
          });
        }
        // Offered once the failure is known to have no ticket.
        const issues = await issuesAsked;
        if (owner.client && failure.clusterId && issues && !issues.length) {
          actions.push({
            title: 'File an issue',
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            command: {
              title: 'File an issue',
              command: 'piwi.openInDashboard',
              arguments: [owner.client.clusterUrl(failure.clusterId)],
            },
          });
        }
        if (owner.client) {
          actions.push({
            title: 'Copy context for agent',
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            command: {
              title: 'Copy context for agent',
              command: 'piwi.copyAgentContext',
              arguments: [
                { uri: params.textDocument.uri, executionId: failure.executionId } satisfies AgentContextParams,
              ],
            },
          });
          actions.push({
            title: 'Open the failure in the dashboard',
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            command: {
              title: 'Open the failure in the dashboard',
              command: 'piwi.openInDashboard',
              arguments: [owner.client.executionUrl(failure.executionId)],
            },
          });
        }
      }
    }
    return actions;
  });

  // In test code: after a page expression's `.` (`page.`, `adminPage.`, `this.page.`), the chains the suite uses on the
  // pages this file's tests visit, and in `expect(` the same chains on the page in use there; at the start of a
  // statement, the project's functions for those pages; inside `piwi:` annotations and tags, their known values.
  connection.onCompletion(async (params): Promise<CompletionItem[]> => {
    const file = uriToPath(params.textDocument.uri);
    const context = file ? contextFor(file) : null;
    const document = documents.get(params.textDocument.uri);
    if (!file || !context?.index || !document) return [];
    const relative = relativeTo(context.root, file);
    if (!relative || !isTestCode(context, relative)) return [];
    const text = document.getText();
    const line = text.split(/\r?\n/)[params.position.line] ?? '';
    const before = line.slice(0, params.position.character);
    const annotation = await annotationItems(context, before, params.position);
    if (annotation) return annotation;
    const statement = /^(\s*)((?:await\s+)?[A-Za-z_$][\w$]*)?$/.exec(before);
    if (statement) {
      const functions = functionSuggestions(await context.functionCatalog(), filePages(context.index, relative));
      const start = { line: params.position.line, character: statement[1]!.length };
      return functions.map((f, i) => ({
        label: f.kind === 'page-object-method' && f.receiver ? `${f.receiver}.${f.name}` : f.name,
        kind: CompletionItemKind.Function,
        detail: [f.kind === 'page-object-method' ? f.importName : f.module, f.urlPattern].filter(Boolean).join(' · '),
        sortText: `~${String(i).padStart(3, '0')}`,
        filterText: `await ${f.receiver ? `${f.receiver}.` : ''}${f.name} ${f.name}`,
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: { range: { start, end: params.position }, newText: functionSnippet(f) },
      }));
    }
    const site = locatorCompletionSite(text, params.position.line, before);
    if (!site) return [];
    const start = { line: params.position.line, character: params.position.character - site.typed.length };
    return locatorSuggestions(context.index, relative).map((s, i) => ({
      label: site.prefix + s.locator,
      kind: CompletionItemKind.Value,
      detail: [
        plural(s.tests, 'test'),
        s.pages.slice(0, 3).join(', '),
        s.stability && s.stability.level !== 'stable' ? `${s.stability.level}: ${stabilityLabels(s.stability)}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      sortText: String(i).padStart(3, '0'),
      filterText: site.prefix + s.locator,
      textEdit: { range: { start, end: params.position }, newText: site.prefix + s.locator },
    }));
  });

  /** Completion inside a `piwi:` annotation or a tag; null when the cursor is in neither. */
  const annotationItems = async (
    context: PiwiContext,
    before: string,
    position: { line: number; character: number },
  ): Promise<CompletionItem[] | null> => {
    const item = (label: string, typed: string, detail?: string): CompletionItem => ({
      label,
      kind: CompletionItemKind.EnumMember,
      detail,
      textEdit: {
        range: { start: { line: position.line, character: position.character - typed.length }, end: position },
        newText: label,
      },
    });
    const type = /\btype:\s*(['"`])([\w:-]*)$/.exec(before);
    if (type) {
      return [
        item('piwi:owner', type[2]!, 'Who owns the test'),
        item('piwi:priority', type[2]!, 'critical, high, medium or low'),
        item('piwi:feature', type[2]!, 'The product area it covers'),
        item('piwi:link', type[2]!, 'A ticket, spec or runbook URL'),
      ];
    }
    const value = /\btype:\s*(['"`])piwi:(owner|priority|feature)\1\s*,\s*description:\s*(['"`])([^'"`]*)$/.exec(
      before,
    );
    if (value) {
      const words = await context.vocabulary();
      const values =
        value[2] === 'priority'
          ? ['critical', 'high', 'medium', 'low']
          : value[2] === 'owner'
            ? words.owners
            : words.features;
      return values.map((v) => item(v, value[4]!));
    }
    const tag = /\btag:\s*(?:\[[^\]]*)?(['"`])(@[\w-]*)$/.exec(before);
    if (tag) return (await context.vocabulary()).tags.map((t) => item(t.startsWith('@') ? t : `@${t}`, tag[2]!));
    return null;
  };

  connection.onHover(async (params, token): Promise<Hover | null> => {
    const file = uriToPath(params.textDocument.uri);
    const found = new Map<number, { context: PiwiContext; failure: BranchFailure }>();
    for (const d of failureDiagnostics.get(params.textDocument.uri) ?? []) {
      if (d.range.start.line !== params.position.line) continue;
      const hit = failureOf(d.data as FailureData);
      if (hit) found.set(hit.failure.executionId, hit);
    }
    // A line of the failing call chain (the test's own line calling a page object) shows the failure too.
    const context = file ? contextFor(file) : null;
    const pass = placer();
    for (const failure of context?.failures?.failures ?? []) {
      const at = pass.place(context!, failure);
      const through =
        at?.state !== 'gone' &&
        !!at?.frames.some((frame) => frame.line - 1 === params.position.line && samePath(frame.file, file!));
      if (through && !found.has(failure.executionId)) found.set(failure.executionId, { context: context!, failure });
    }
    const analysis = await hoverOfAnalysis(params);
    const covered = file ? await coverageHover(params.textDocument.uri, params.position.line) : null;
    if (token.isCancellationRequested) return null;
    if (!found.size) {
      const value = [hoverText(analysis), covered].filter(Boolean).join('\n\n---\n\n');
      return value ? { contents: { kind: 'markdown', value } } : null;
    }
    const parts: string[] = [];
    // Asked together; each waited for a while at most.
    const lookups = [...found.values()].map(({ context, failure }) => ({
      shot: failure.screenshot ? within(context.evidence(failure.screenshot), null) : null,
      issues: within(context.issuesOf(failure), []),
    }));
    for (const [i, { context, failure }] of [...found.values()].entries()) {
      const shot = await lookups[i]!.shot;
      const issues = await lookups[i]!.issues;
      if (token.isCancellationRequested) return null;
      const message = failure.message?.trim();
      const at = pass.place(context, failure);
      const chain = (at?.frames ?? [])
        .slice(0, 5)
        .map(
          (frame) => `[${path.basename(frame.file)}:${frame.line}](${pathToFileURL(frame.file).href}#L${frame.line})`,
        );
      const run = runLabel(context, failure);
      parts.push(
        [
          `**${isLocalFailure(context, failure) ? 'Local failure' : 'CI failure'}** · [${failure.title.replace(/[[\]]/g, '')}](${context.client?.executionUrl(failure.executionId) ?? ''}) · ${run}${at?.state === 'edited' ? ` · edited since ${run}` : ''}`,
          message && message !== failure.headline
            ? `${failure.headline ?? ''}\n\n${fenced(message)}`
            : (failure.headline ?? ''),
          chain.length > 1 ? `Called from ${chain.join(' ← ')}` : '',
          ...issues.map(
            (l) =>
              `Known issue: [${[l.key, l.title].filter(Boolean).join(' ').replace(/[[\]]/g, '') || l.url}](${l.url})${l.statusText ? ` · ${l.statusText}` : ''}`,
          ),
          shot ? `![Failure screenshot](${pathToFileURL(shot).href})` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
    }
    const value = [...parts, hoverText(analysis), covered].filter(Boolean).join('\n\n---\n\n');
    return value ? { contents: { kind: 'markdown', value } } : null;
  });

  const hoverOfAnalysis = async (params: {
    textDocument: { uri: string };
    position: { line: number };
  }): Promise<Hover | null> => {
    const file = uriToPath(params.textDocument.uri);
    const context = file ? contextFor(file) : null;
    if (!file || !context?.index) return null;
    const line = params.position.line + 1;
    const analysis = appAnalyses.get(params.textDocument.uri);
    if (analysis) {
      const groups = analysis.groups.filter((g) => g.anchor.line === line);
      if (!groups.length) return null;
      const parts = groups.flatMap((g) =>
        g.breaks.map((b) => {
          const sites = [...new Set(b.uses.flatMap((u) => u.callSites))].slice(0, 3).map((s) => `\`${s}\``);
          const fix = b.rewrite ? `\n  → \`${b.rewrite}\`` : '';
          return `- \`${b.locator}\` · ${plural(b.tests.length, 'test')} · ${b.confidence} · ${sites.join(', ')}${fix}`;
        }),
      );
      return { contents: { kind: 'markdown', value: `**Piwi: locators this change breaks**\n\n${parts.join('\n')}` } };
    }
    const relative = relativeTo(context.root, file);
    if (!relative) return null;
    const here = locatorsInFile(context.index, relative).filter((l) => l.line === line);
    if (!here.length) return null;
    return { contents: { kind: 'markdown', value: here.map((l) => hoverFor(context, l)).join('\n\n---\n\n') } };
  };

  const hoverFor = (context: PiwiContext, l: LineLocator): string => {
    const tests = l.tests
      .slice(0, 10)
      .map(
        (t) =>
          `- ${statusIcon(t.status)} [${t.title.replace(/[[\]]/g, '')}](${context.client?.testUrl(t.id) ?? ''}) · \`${t.file}\``,
      )
      .join('\n');
    const pages = [
      ...new Set(l.uses.flatMap((u) => (u.pages ?? []).map((p) => context.index?.pages?.[p]).filter(Boolean))),
    ].slice(0, 5);
    const stability =
      l.stability && l.stability.level !== 'stable' ? `\n\n${l.stability.level}: ${stabilityLabels(l.stability)}` : '';
    return [
      `**\`${l.entry.locator}\`** · ${plural(l.tests.length, 'test')} · ${l.actions.slice(0, 4).join(', ')}`,
      tests,
      pages.length ? `Pages: ${pages.map((p) => `\`${p}\``).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .concat(stability);
  };

  /**
   * The tests of a spec as it stands (`lines`): each `test(…)` call, the catalog's case of its title in its describe
   * blocks, the latest run's failure of that test placed on the files as they stand, a later run's pass of it, and its
   * latest result: the run in progress the service follows while it runs the test and once it ended it, else the
   * failure, the pass, or the catalog's status. Null for a test the catalog does not know.
   */
  const specTests = (
    context: PiwiContext,
    file: string,
    lines: string[],
    cases: CatalogCase[],
    pass: Placer,
  ): Array<{
    call: TestCall;
    found?: CatalogCase;
    failed?: BranchFailure;
    fixed?: BranchResolved;
    failure?: TestFailure;
    status: TestLineStatus | null;
  }> => {
    const failingNow = new Map<number, BranchFailure>();
    for (const f of context.failures?.failures ?? [])
      if (!failingNow.has(f.testCaseId)) failingNow.set(f.testCaseId, f);
    /** The tests that failed in the latest complete run and passed since, on every project they failed on. */
    const fixedNow = new Map<number, BranchResolved>();
    for (const r of context.failures?.resolved ?? [])
      if (!failingNow.has(r.testCaseId) && !fixedNow.has(r.testCaseId)) fixedNow.set(r.testCaseId, r);
    return testCalls(lines).map((call) => {
      const found = caseOfCall(cases, call);
      if (!found) return { call, status: null };
      const failed = failingNow.get(found.id);
      const fixed = failed ? undefined : fixedNow.get(found.id);
      const at = failed ? pass.place(context, failed) : null;
      const failure: TestFailure | undefined = failed && {
        line: failureLine(at?.frames ?? [], file, call.line, call.endLine),
        headline: failed.headline,
        message: failed.message ?? null,
        executionId: failed.executionId,
        url: context.client!.executionUrl(failed.executionId),
        state: at?.state === 'edited' ? 'edited' : 'failing',
      };
      const status =
        context.liveTests.get(found.id) ?? (failed ? 'failed' : fixed ? 'passed' : testLineStatus(found.status));
      return { call, found, failed, fixed, failure, status };
    });
  };

  connection.onRequest(FILE_SUMMARY_REQUEST, async (params: FileSummaryParams): Promise<FileSummary> => {
    const empty: FileSummary = { file: null, lines: [] };
    const file = uriToPath(params.uri);
    const context = file ? contextFor(file) : null;
    if (!file || !context?.index || !context.client) return empty;
    const relative = relativeTo(context.root, file);
    const document = documents.get(params.uri);
    const text = document ? document.getText() : fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const lines = text.split(/\r?\n/);
    const pass = placer({ file, text });
    const run = (testIds: number[], coverage?: RunTestsArgs['coverage']) => ({
      title: 'Run them',
      command: 'piwi.runTests' as const,
      arguments: [{ uri: params.uri, testIds, ...(coverage ? { coverage } : {}) } satisfies RunTestsArgs],
    });

    if (isTestCode(context, relative)) {
      const out: SummaryLine[] = [];
      for (const l of locatorsInFile(context.index, relative!)) {
        const counts = testCounts(l.tests);
        out.push({
          line: l.line - 1,
          title: [plural(l.tests.length, 'test'), l.actions.slice(0, 2).join(', '), counts].filter(Boolean).join(' · '),
          command: run(l.tests.map((t) => t.id)),
        });
      }
      const cases = SPEC_FILE.test(relative!) ? await context.casesOf(relative!) : [];
      /** The reason and the evidence of each failure, above its failing line: first on that line. */
      const reasons: SummaryLine[] = [];
      for (const { call, found, failed, fixed, failure, status: testStatus } of specTests(
        context,
        file,
        lines,
        cases,
        pass,
      )) {
        if (!found) continue;
        const i = call.line;
        const runs = found.totalRuns ?? 0;
        const passed = found.passedRuns ?? 0;
        const status = fixed
          ? ` · ${fixedLabel(context, fixed)}`
          : found.status && found.status !== 'passed'
            ? ` · ${found.status}`
            : '';
        const quarantined = context.quarantined.get(found.id);
        const quarantine = quarantined
          ? ` · quarantined ${Math.max(1, Math.round(quarantined.ageMs / 86_400_000))} d · ${
              quarantined.releaseProposed
                ? 'ready to release'
                : `${quarantined.consecutivePasses}${context.releaseAfter ? `/${context.releaseAfter}` : ''} passes toward release`
            }`
          : '';
        const inSelections = context.selections.filter((sel) => sel.tests.has(found.id)).map((sel) => sel.name);
        const selectionsText = inSelections.length
          ? ` · in ${inSelections.slice(0, 3).join(', ')}${inSelections.length > 3 ? '…' : ''}`
          : '';
        const flaky = context.flaky.get(found.id);
        const flakiness = flaky
          ? [
              ` · flaky score ${flaky.score}`,
              flaky.wastedCiMinutes >= 1 ? ` · ${Math.round(flaky.wastedCiMinutes)} CI min wasted` : '',
              flaky.rootCause ? ` · ${flaky.rootCause}` : '',
            ].join('')
          : '';
        const endLine = call.endLine;
        out.push({
          line: i,
          title: `passed ${passed}/${runs}${status}${quarantine}${flakiness}${selectionsText}`,
          command: {
            title: 'Open in dashboard',
            command: 'piwi.openInDashboard',
            arguments: [context.client!.testUrl(found.id)],
          },
          status: testStatus!,
          endLine,
          ...(failure ? { failure } : {}),
          testCaseId: found.id,
        });
        out.push(...flakeLabLines(context, found.id, i, env, desktopJobs.available(context)));
        if (!failed || !failure) continue;
        const evidence = { uri: params.uri, executionId: failed.executionId } satisfies TraceParams;
        const why = clip(failed.headline ?? 'Failed', 120);
        reasons.push({
          line: failure.line,
          title: failure.state === 'edited' ? `✎ edited since ${runLabel(context, failed)} · ${why}` : `✗ ${why}`,
          command: {
            title: 'Open the failure in the dashboard',
            command: 'piwi.openInDashboard',
            arguments: [failure.url],
          },
        });
        reasons.push({
          line: failure.line,
          title: 'Run this test',
          command: {
            title: 'Run this test',
            command: 'piwi.runTests',
            arguments: [{ uri: params.uri, testIds: [found.id] } satisfies RunTestsArgs],
          },
        });
        if (failed.screenshot) {
          reasons.push({
            line: failure.line,
            title: 'Screenshot',
            command: { title: 'Open the failure screenshot', command: 'piwi.openScreenshot', arguments: [evidence] },
          });
        }
        if (failed.traces.length) {
          reasons.push({
            line: failure.line,
            title: 'Trace',
            command: { title: 'Open the trace', command: 'piwi.openTrace', arguments: [evidence] },
          });
        }
      }
      const fileLine: SummaryLine | null = cases.length
        ? {
            line: 0,
            title: [
              `${plural(cases.length, 'test')} in Piwi`,
              testCounts(cases.map((c) => ({ status: c.status ?? null }))),
            ]
              .filter(Boolean)
              .join(' · '),
            command: run(cases.map((c) => c.id)),
          }
        : null;
      return { file: fileLine, lines: [...reasons, ...out].sort((a, b) => a.line - b.line) };
    }

    const repoRelative = relativeTo(context.repoRoot, file);
    const covered = await within(
      coverageMarksOf(params.uri).catch(() => null),
      null,
    );
    const reached = new Map((repoRelative ? testsReaching(context.codeIndex, repoRelative) : []).map((t) => [t.id, t]));
    for (const t of covered?.coverage.tests ?? []) if (!reached.has(t.id)) reached.set(t.id, t);
    const tests = [...reached.values()];
    // A run from a file's coverage lens records the coverage of its runtime, so it refreshes the marks.
    const fragments = covered?.coverage.fragments ?? [];
    const recordCoverage = fragments.some((f) => f.runtime === 'server')
      ? 'server'
      : fragments.some((f) => f.runtime === 'browser')
        ? 'browser'
        : undefined;
    const page = repoRelative
      ? (pageSummary(context.index, repoRelative) ?? pageSummary(context.index, relative ?? ''))
      : null;
    const reachLine: SummaryLine | null = tests.length
      ? {
          line: 0,
          title: [
            `Reached by ${plural(tests.length, 'test')}`,
            testCounts(tests),
            covered ? coverageNote(covered.marks) : null,
          ]
            .filter(Boolean)
            .join(' · '),
          command: run(
            tests.map((t) => t.id),
            recordCoverage,
          ),
        }
      : null;
    /** Each function its tests ran, at its first line as the file stands. */
    const functionLines = (covered?.marks.functions ?? []).flatMap((f): SummaryLine[] => {
      const ran = f.tests.flatMap((i) => covered!.coverage.tests[i] ?? []);
      if (!ran.length) return [];
      return [
        {
          line: f.line - 1,
          title: [`Reached by ${plural(ran.length, 'test')}`, testCounts(ran)].filter(Boolean).join(' · '),
          command: run(
            ran.map((t) => t.id),
            recordCoverage,
          ),
        },
      ];
    });
    if (!page) {
      if (reachLine || functionLines.length) return { file: reachLine, lines: functionLines };
      // A file no test reaches whose changes the pull request will count as uncovered says so at its top.
      const uncovered = await within(
        uncoveredOf(params.uri).catch(() => null),
        null,
      );
      return uncovered ? { file: { line: 0, title: `Uncovered changes: ${uncovered.label}` }, lines: [] } : empty;
    }
    const pageLine: SummaryLine = {
      line: 0,
      title: [
        `Page ${page.pages.slice(0, 2).join(', ')}: ${plural(page.tests.length, 'test')} act on it`,
        plural(page.locators, 'locator'),
        page.brittle ? `${page.brittle} brittle` : '',
        testCounts(page.tests),
      ]
        .filter(Boolean)
        .join(' · '),
      command: run(page.tests.map((t) => t.id)),
    };
    return { file: pageLine, lines: [...(reachLine ? [reachLine] : []), ...functionLines] };
  });

  connection.onRequest(TESTS_FOR_FILE_REQUEST, async (params: TestsForFileParams): Promise<TestsForFile> => {
    const file = uriToPath(params.uri);
    const context = file ? contextFor(file) : null;
    if (!file || !context?.index) return { tests: [], basis: 'none' };
    const relative = relativeTo(context.root, file);
    if (relative && SPEC_FILE.test(relative)) {
      const cases = await context.casesOf(relative);
      return { basis: 'defined', tests: cases.map((c) => caseToEditorTest(context, c)) };
    }
    if (isTestCode(context, relative)) {
      const tests = new Map<number, LocatorIndexTest>();
      for (const l of locatorsInFile(context.index, relative!)) for (const t of l.tests) tests.set(t.id, t);
      return { basis: 'locators', tests: [...tests.values()].map((t) => toEditorTest(context, t)) };
    }
    const repoRelative = relativeTo(context.repoRoot, file);
    const reached = new Map((repoRelative ? testsReaching(context.codeIndex, repoRelative) : []).map((t) => [t.id, t]));
    const covered = await within(
      coverageMarksOf(params.uri).catch(() => null),
      null,
    );
    for (const t of covered?.coverage.tests ?? []) if (!reached.has(t.id)) reached.set(t.id, t);
    return {
      basis: reached.size ? 'reach' : 'none',
      tests: [...reached.values()].map((t) => toEditorTest(context, t)),
    };
  });

  connection.onRequest(TEST_AT_REQUEST, async (params: TestAtParams): Promise<TestAtResult> => {
    const none: TestAtResult = { test: null, spec: null, location: null };
    const file = uriToPath(params.uri);
    const context = file ? contextFor(file) : null;
    const relative = file && context ? relativeTo(context.root, file) : null;
    if (!file || !context || !relative || !SPEC_FILE.test(relative)) return none;
    const call = testCallAt((readText(file) ?? '').split(/\r?\n/), params.line);
    const cases = await context.casesOf(relative);
    const found = call ? new Map(cases.map((c) => [c.title, c])).get(call.title) : undefined;
    return {
      test: found ? caseToEditorTest(context, found) : null,
      spec: cases.length ? { uri: params.uri, testIds: cases.map((c) => c.id) } : null,
      location: call ? `${relative}:${call.line + 1}` : null,
    };
  });

  connection.onRequest(TEST_ITEMS_REQUEST, async (params: TestItemsParams | null): Promise<TestItemsResult> => {
    const pass = placer();
    const specs = new Map<PiwiContext, SpecTests[]>();
    /** A spec of the context's folder as it stands, with the catalog's cases of its tests. */
    const add = (context: PiwiContext, file: string, relative: string, cases: CatalogCase[]) => {
      const text = readText(file);
      if (text === null) return;
      const uri = pathToFileURL(file).href;
      const tests = specTests(context, file, text.split(/\r?\n/), cases, pass).map(
        ({ call, found, failure, status }) => ({
          title: call.title,
          suite: call.suite,
          line: call.line,
          endLine: call.endLine,
          location: `${relative}:${call.line + 1}`,
          testCaseId: found?.id ?? null,
          status,
          failure: failure ?? null,
          url: found ? (context.client?.testUrl(found.id) ?? null) : null,
        }),
      );
      specs.set(context, [...(specs.get(context) ?? []), { uri, file: relative, tests }]);
    };
    /** The specs answered, by path. */
    const answered = new Set<string>();
    if (params?.catalog !== false) {
      for (const context of contexts) {
        // The catalog's specs the workspace holds, each from the config whose folder holds it.
        const byFile = new Map<string, CatalogCase[]>();
        const found = new Map<string, string | null>();
        for (const c of await context.allCases()) {
          if (!found.has(c.filePath)) {
            found.set(c.filePath, resolveReportedFile([context.root, context.repoRoot], c.filePath));
          }
          const file = found.get(c.filePath);
          if (file) byFile.set(file, [...(byFile.get(file) ?? []), c]);
        }
        for (const [file, cases] of byFile) {
          const relative = relativeTo(context.root, file);
          if (!relative || !SPEC_FILE.test(relative) || contextFor(file) !== context) continue;
          answered.add(file);
          add(context, file, relative, cases);
        }
      }
    }
    for (const uri of Array.isArray(params?.uris) ? params.uris : []) {
      const file = typeof uri === 'string' ? uriToPath(uri) : null;
      const context = file ? contextFor(file) : null;
      const relative = file && context ? relativeTo(context.root, file) : null;
      if (!file || !context || !relative || !SPEC_FILE.test(relative) || answered.has(file)) continue;
      answered.add(file);
      add(context, file, relative, await context.casesOf(relative));
    }
    return {
      contexts: contexts.flatMap((context) => {
        const held = specs.get(context);
        if (!held) return [];
        return [
          {
            root: context.root,
            label: contextLabel(context.root, folders),
            specs: held.sort((a, b) => a.file.localeCompare(b.file)),
          },
        ];
      }),
    };
  });

  connection.onRequest(COVERAGE_REQUEST, async (params: CoverageParams): Promise<CoverageResult> => {
    const uri = params.uri;
    const turn = nextCoverageTurn(uri);
    const full = coverageNow(uri);
    // Waited for a while at most: what arrives later is pushed.
    const answer = await within(full, null);
    const result = answer ?? coverageResult(uri, null);
    coverageHeld.set(uri, JSON.stringify(result));
    if (!answer) void full.then((later) => pushCoverage(uri, turn, later));
    // An edit or a read that started meanwhile is computed against what the client now holds.
    else if (coverageTurns.get(uri) !== turn) coverageAgain([uri]);
    return result;
  });

  /**
   * A test run's command with the editor's breakpoints: `PIWI_PAUSE_AT` for those in the files under the context's
   * folder, `--headed`, and a notice when the project's reporter does not pause at them. Unchanged without one.
   */
  const withBreakpoints = (
    context: PiwiContext,
    command: RunCommand,
    breakpoints: EditorBreakpoint[] | undefined,
  ): RunCommand => {
    const files = (Array.isArray(breakpoints) ? breakpoints : []).flatMap((b) => {
      const file = typeof b?.uri === 'string' ? uriToPath(b.uri) : null;
      return file && typeof b.line === 'number' ? [{ file, line: b.line }] : [];
    });
    const pauseAt = pauseAtValue(context.root, files);
    if (!pauseAt) return command;
    const notice = breakpointsNotice(context.reporterVersion);
    return {
      ...command,
      ...headedCommand(command.command, command.args),
      env: { ...command.env, PIWI_PAUSE_AT: pauseAt },
      ...(notice ? { notice } : {}),
    };
  };

  /** Whether a location names a spec under the context's folder, as `piwi/testAt` gives it. */
  const specLocation = (context: PiwiContext, location: unknown): location is string => {
    if (!isTestLocation(location)) return false;
    const spec = location.slice(0, location.lastIndexOf(':'));
    return SPEC_FILE.test(spec) && fs.existsSync(path.join(context.root, spec));
  };

  /** The Playwright arguments that run the tests `params` names: by location, else by id from the instance. */
  const testArgs = async (context: PiwiContext, params: RunTestsArgs): Promise<string[] | null> => {
    if (Array.isArray(params.locations) && params.locations.length) {
      return params.locations.every((l) => specLocation(context, l)) ? [...params.locations] : null;
    }
    if (!context.client || !context.project || !params.testIds?.length) return null;
    const answer = await context.client.runArgs(context.project.id, params.testIds);
    return Array.isArray(answer.args) && answer.args.length ? answer.args : playwrightArgsOf(answer.command);
  };

  /** The commands that run each test several times, by ref: what their end says when their run reaches no instance. */
  const repeatedCommands = new Map<string, { root: string; repeat: number; target: string }>();

  connection.onRequest(RUN_ARGS_REQUEST, async (params: RunTestsArgs): Promise<RunCommand | null> => {
    const file = uriToPath(params.uri);
    const context = contexts.find((c) => c.root === params.root) ?? (file ? contextFor(file) : null);
    if (!context) return null;
    const repeat = params.repeat ?? null;
    const tests = await testArgs(context, params);
    const args = tests && repeat !== null ? repeatArgs(tests, repeat) : tests;
    const command = args?.length ? playwrightTestCommand(args) : null;
    if (!args || !command) return null;
    const ref = newRunRef();
    runWatch.watch(context, ref, repeat);
    const run: RunCommand = {
      cwd: commandFolder(context),
      args,
      command,
      env: { ...editorRunEnv(ref), ...coverageRunEnv(params.coverage) },
      ref,
    };
    if (repeat === null) return withBreakpoints(context, run, params.breakpoints);
    repeatedCommands.set(ref, { root: context.root, repeat, target: tests!.join(' ') });
    for (const oldest of repeatedCommands.keys()) {
      if (repeatedCommands.size <= MAX_REPEATED_COMMANDS) break;
      repeatedCommands.delete(oldest);
    }
    return run;
  });

  // An answer is what the client holds from then on: a change is pushed against it, so a client that read the state
  // midway through a refresh still hears where the refresh ends.
  connection.onRequest(STATUS_REQUEST, (): StatusResult => {
    const status = currentStatus();
    lastStatus = JSON.stringify(status);
    return status;
  });

  connection.onRequest(RUN_STATUS_REQUEST, (): RunStatusResult => {
    const status = runStatus();
    lastRunStatus = JSON.stringify(status);
    return status;
  });

  connection.onRequest(DESKTOP_REQUEST, async (): Promise<DesktopResult> => {
    const desktop = readDesktopDiscovery(env);
    if (!desktop) return { url: null, projects: [], linked: null };
    const projects = await new PiwiClient({ serverUrl: desktop.url, apiKey: desktop.token, project: '' })
      .projects()
      .catch(() => []);
    const id = contexts[0] ? linkedDesktopProject(desktop, contexts[0].root) : null;
    const linked = id === null ? null : (projects.find((p) => p.id === id) ?? null);
    return { url: desktop.url, projects, linked };
  });

  connection.onRequest(SELECTIONS_REQUEST, async (params: SelectionsParams): Promise<SelectionsResult> => {
    const file = params.uri ? uriToPath(params.uri) : null;
    const context = (file ? contextFor(file) : null) ?? contexts.find((c) => c.selections.length) ?? null;
    if (!context) return { items: [] };
    const relative = file ? relativeTo(context.root, file) : null;
    const ids =
      relative && SPEC_FILE.test(relative) ? new Set((await context.casesOf(relative)).map((c) => c.id)) : null;
    return {
      items: context.selections.map((sel) => ({
        key: sel.key,
        name: sel.name,
        count: sel.tests.size,
        includesFile: !!ids && [...sel.tests].some((id) => ids.has(id)),
      })),
    };
  });

  connection.onRequest(RUN_SELECTION_REQUEST, (params: RunSelectionParams): RunCommand | null => {
    const file = uriToPath(params.uri);
    const context = (file ? contextFor(file) : null) ?? contexts.find((c) => c.selections.length) ?? null;
    const selection = context?.selections.find((s) => s.key === params.key);
    const args = selection ? playwrightArgsOf(selection.command) : null;
    const command = args?.length ? playwrightTestCommand(args) : null;
    if (!context || !args || !command) return null;
    const ref = newRunRef();
    runWatch.watch(context, ref);
    const run: RunCommand = {
      cwd: commandFolder(context),
      command,
      args,
      env: editorRunEnv(ref),
      ref,
    };
    return withBreakpoints(context, run, params.breakpoints);
  });

  connection.onRequest(APPLY_PICK_REQUEST, (params: ApplyPickParams): ApplyPickResult => {
    const reported = typeof params.file === 'string' ? params.file.replace(/\\/g, '/') : null;
    const inside = !!reported && !path.isAbsolute(reported) && !reported.split('/').includes('..');
    const file = params.uri
      ? uriToPath(params.uri)
      : inside
        ? (contexts.map((c) => path.join(c.root, reported!)).find((f) => fs.existsSync(f)) ?? null)
        : null;
    if (!file) return { uri: null, edit: null };
    const uri = openDocument(file)?.uri ?? pathToFileURL(file).href;
    const lineText = readText(file)?.split(/\r?\n/)[params.line];
    const edit = lineText === undefined || !params.locator ? null : pickEditOnLine(lineText, params.locator);
    return {
      uri,
      edit: edit && {
        range: { start: { line: params.line, character: edit.start }, end: { line: params.line, character: edit.end } },
        newText: edit.newText,
      },
    };
  });

  connection.onRequest(FAILURES_REQUEST, (params: FailuresParams | null): FailuresResult => {
    failuresGrouping = parseFailuresGrouping(params?.grouping) ?? failuresGrouping;
    const failures = failuresResult(placer());
    failuresSent = JSON.stringify({ ...failures, updatedAt: undefined });
    return failures;
  });

  connection.onRequest(
    AGENT_CONTEXT_REQUEST,
    async (params: AgentContextParams): Promise<AgentContextResult | null> => {
      const file = uriToPath(params.uri);
      const candidates = [file ? contextFor(file) : null, ...contexts].filter((c): c is PiwiContext => !!c);
      for (const context of candidates) {
        const failure = context.failures?.failures.find((f) => f.executionId === params.executionId);
        if (failure) return { text: await agentContext(context, failure) };
      }
      return null;
    },
  );

  connection.onRequest(TRACE_REQUEST, async (params: TraceParams): Promise<TraceResult | null> => {
    const file = uriToPath(params.uri);
    const candidates = [file ? contextFor(file) : null, ...contexts].filter((c): c is PiwiContext => !!c);
    for (const context of candidates) {
      const failure = context.failures?.failures.find((f) => f.executionId === params.executionId);
      if (!failure?.traces.length) continue;
      const trace = await context.evidence(failure.traces[failure.traces.length - 1]!);
      if (!trace) return null;
      return { path: trace, cwd: commandFolder(context), command: `npx playwright show-trace "${trace}"` };
    }
    return null;
  });

  connection.onRequest(SCREENSHOT_REQUEST, async (params: ScreenshotParams): Promise<ScreenshotResult | null> => {
    const file = uriToPath(params.uri);
    const candidates = [file ? contextFor(file) : null, ...contexts].filter((c): c is PiwiContext => !!c);
    for (const context of candidates) {
      const failure = context.failures?.failures.find((f) => f.executionId === params.executionId);
      if (!failure?.screenshot) continue;
      const shot = await context.evidence(failure.screenshot);
      return shot ? { path: shot } : null;
    }
    return null;
  });

  connection.onRequest(MCP_REQUEST, (): McpServersResult => {
    const seen = new Set<string>();
    const servers: McpServersResult['servers'] = [];
    for (const c of contexts) {
      const conn = c.client?.connection;
      if (!conn || seen.has(conn.serverUrl)) continue;
      seen.add(conn.serverUrl);
      let host = conn.serverUrl;
      try {
        host = new URL(conn.serverUrl).host;
      } catch {
        // keep the URL as given
      }
      servers.push({
        label: `Piwi (${host})`,
        url: `${conn.serverUrl}/mcp`,
        headers: conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {},
      });
    }
    return { servers };
  });

  connection.onRequest(
    RUN_ID_REQUEST,
    (params: RunIdParams): RunIdResult => ({
      runId: typeof params?.text === 'string' ? runIdOf(params.text) : null,
    }),
  );

  connection.onRequest(RENDER_STEPS_REQUEST, async (params: RenderStepsParams): Promise<RenderStepsResult> => {
    const parsed = parseSteps(params.steps);
    if (!parsed.ok) return { code: '', warnings: parsed.errors };
    const file = uriToPath(params.uri);
    const context = (file ? contextFor(file) : null) ?? contexts.find((c) => c.client && c.project) ?? null;
    const text = (file ? readText(file) : null) ?? '';
    const atCaret = typeof params.line === 'number' ? params.line : null;
    // The page expression in use at the caret: `this.page` in a page object, `adminPage` in a test with two users.
    const candidates = file && atCaret !== null ? pageCandidates(text, atCaret) : null;
    const page = candidates?.default ?? null;
    const separate = params.imports === 'separate';
    const configFile = context ? playwrightConfigFile(context.root) : null;
    const piwi = configFile
      ? await projectOptions(configFile).then(
          (o) => o.piwi,
          () => null,
        )
      : null;
    const result = renderSpec(sessionFromSteps(parsed.steps), {
      format: 'body',
      urls: context ? await stepUrls(context, parsed.steps.origin) : 'relative',
      locators: 'stable',
      urlChecks: true,
      ...repositoryCodegen(codegenConfigOf(piwi).options, 'steps', candidates?.context ?? 'file'),
      catalog: context ? await context.functionCatalog() : [],
      preferLocators: suiteLocators(context),
      ...(page ? { page } : {}),
      ...(file && atCaret !== null ? { declaredNames: declaredNamesAt(text, atCaret) } : {}),
      ...(separate ? { bodyImports: 'none' as const } : {}),
    });
    const caretLine = atCaret !== null ? (text.split(/\r\n|\r|\n/)[atCaret] ?? '') : null;
    return {
      code:
        caretLine === null
          ? result.code
          : indentBlock(result.code, caretLine.slice(0, caretLine.length - caretLine.trimStart().length)),
      warnings: result.warnings.map((w) => w.message),
      ...(separate ? { importEdit: importInsertion(text, blockImports(text, result)) } : {}),
    };
  });

  connection.onRequest(PAGE_CANDIDATES_REQUEST, (params: PageCandidatesParams): PageCandidatesResult => {
    const file = uriToPath(params.uri);
    return pageCandidates((file ? readText(file) : null) ?? '', params.line);
  });

  connection.onRequest(RECORD_REQUEST, async (params: RecordParams): Promise<RecordResult> => {
    const file = uriToPath(params.uri);
    const context = file ? contextFor(file) : null;
    const configFile = context ? playwrightConfigFile(context.root) : null;
    if (!file || !context || !configFile) {
      return {
        ok: false,
        message: 'No Playwright config holds this file: open the folder of its playwright.config.ts.',
      };
    }
    return recordings.start(params, {
      file,
      text: readText(file) ?? '',
      configFile,
      catalog: context.functionCatalog(),
      preferLocators: suiteLocators(context),
    });
  });

  connection.onRequest(STOP_RECORDING_REQUEST, async (params: StopRecordingParams) => {
    await recordings.stop(params.sessionId);
    return null;
  });

  connection.onRequest(RECORDING_COMMAND_REQUEST, (params: RecordingCommandParams) => {
    recordings.command(params.sessionId, params.command);
    return null;
  });

  connection.onRequest(REFRESH_REQUEST, async () => {
    await refreshAll();
    return null;
  });

  connection.onRequest(REFRESH_RUN_REQUEST, async (): Promise<RunStatusResult> => {
    forgetShared(answers);
    await Promise.all(
      contexts.map(async (c) => {
        const [, ended] = await Promise.all([c.refreshRun(), runWatch.readLive(c)]);
        if (ended) runWatch.end(c);
      }),
    );
    runChanged();
    return runStatus();
  });

  connection.onNotification(COMMAND_STARTED_NOTIFICATION, (params: CommandStartedParams) => {
    if (typeof params?.ref === 'string') runWatch.commandStarted(params.ref, params.terminalRef);
  });

  // A command that runs each test several times says how it went: from its run when the instance holds it
  // (`piwi/runEnded`), else from its exit code.
  connection.onNotification(COMMAND_ENDED_NOTIFICATION, (params: CommandEndedParams) => {
    if (typeof params?.ref !== 'string') return;
    const { ref } = params;
    const exitCode = typeof params.exitCode === 'number' ? params.exitCode : null;
    void runWatch.commandEnded(ref, exitCode).then((reached) => {
      const repeated = repeatedCommands.get(ref);
      if (!repeated || reached) return;
      const verdict = exitVerdict(repeated.repeat, exitCode, repeated.target);
      void connection.sendNotification(NOTICE_NOTIFICATION, { root: repeated.root, ...verdict } satisfies Notice);
    });
  });

  connection.onRequest(DESKTOP_JOB_REQUEST, async (params: DesktopJobParams): Promise<DesktopJobResult> => {
    const found = params.executionId ? failureOf({ root: params.root, executionId: params.executionId }) : null;
    if (params.kind === 'flake-lab') {
      const context = contextOfRoot(params.root);
      const testCaseId = params.testCaseId || found?.failure.testCaseId;
      if (!context?.client || !testCaseId) return { ok: false, message: 'This test is no longer known here.' };
      if (context.source === 'desktop') {
        return {
          ok: false,
          message: "This test is the desktop app's own: run Reproduce this flake on its Flakiness tab.",
        };
      }
      return desktopJobs.startFlakeLab(
        { client: context.client },
        { testCaseId, title: found?.failure.title, clusterId: found?.failure.clusterId },
      );
    }
    if (!found?.context.client) return { ok: false, message: 'This failure is no longer in the latest run.' };
    return desktopJobs.start({ client: found.context.client }, found.failure, params.kind);
  });

  connection.onRequest(
    SHARE_DESKTOP_JOB_REQUEST,
    (params: ShareDesktopJobParams): Promise<ShareDesktopJobResult> => desktopJobs.share(params.jobId),
  );

  connection.onNotification(SET_BASELINE_NOTIFICATION, async (params: SetBaselineParams) => {
    const context = typeof params?.root === 'string' ? contextOfRoot(params.root) : null;
    const choice = parseBaselineChoice(params?.choice);
    if (!context || !choice) return;
    context.baseline = choice;
    if (await context.refreshRun()) runChanged();
  });

  connection.onNotification(SET_CREDENTIALS_NOTIFICATION, (next: EditorCredentials) => {
    credentials = next ?? {};
    applyBaselines();
    // The failures read so far take the severity these credentials choose.
    publishFailures();
    // The refresh opens the streams the instance refused again, with these credentials.
    void refreshAll();
  });

  connection.onShutdown(() => recordings.dispose());

  documents.listen(connection);
  connection.listen();
  return () => {
    stopped = true;
    runWatch.dispose();
    recordings.dispose();
    desktopJobs.dispose();
    if (refreshTimer) clearInterval(refreshTimer);
    if (retryTimer) clearTimeout(retryTimer);
    fs.unwatchFile(desktopFile, onDesktopFile);
    for (const { file, listener } of headWatches) fs.unwatchFile(file, listener);
    if (runTimer) clearTimeout(runTimer);
    if (placeTimer) clearTimeout(placeTimer);
    for (const t of timers.values()) clearTimeout(t);
  };
}
