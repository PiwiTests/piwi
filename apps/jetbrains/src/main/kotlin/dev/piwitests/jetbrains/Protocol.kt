package dev.piwitests.jetbrains

import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import org.eclipse.lsp4j.services.LanguageServer
import java.util.concurrent.CompletableFuture

/*
 * The editor service's own requests (packages/editor/src/protocol.ts), as lsp4j
 * reads them. Fields are nullable: Gson fills what the service sends.
 */

data class UriParams(val uri: String)

data class PiwiCommand(val title: String? = null, val command: String? = null, val arguments: List<Any?>? = null)

/**
 * A line of `piwi/fileSummary`. On a test's line, `status` is its latest result (`passed`, `failed`, `flaky`,
 * `skipped`, `running` while the run in progress runs it, or `unknown`), shown in the gutter with `title` as its
 * tooltip, `endLine` where its call ends, and `failure` where and why it failed.
 */
data class SummaryLine(
    val line: Int = 0,
    val title: String? = null,
    val command: PiwiCommand? = null,
    val status: String? = null,
    val endLine: Int? = null,
    val failure: TestFailure? = null,
)

/**
 * The line of the test a failure went through (0-based), followed through the edits since the run, and why it failed.
 * `state` is `edited` once the line the run failed at changed since, `failing` otherwise; null from an older service.
 */
data class TestFailure(
    val line: Int = 0,
    val headline: String? = null,
    val message: String? = null,
    val executionId: Int = 0,
    val url: String? = null,
    val state: String? = null,
)

data class FileSummary(val file: SummaryLine? = null, val lines: List<SummaryLine>? = null)

data class EditorTest(
    val id: Int = 0,
    val title: String? = null,
    val file: String? = null,
    val status: String? = null,
    val url: String? = null,
)

data class TestsForFile(val tests: List<EditorTest>? = null, val basis: String? = null)

/** A line breakpoint of the IDE: the file's URI and its 0-based line. */
data class EditorBreakpoint(val uri: String, val line: Int)

/**
 * `piwi/runArgs`: the tests to run. `breakpoints`, the IDE's enabled line breakpoints, pause the run before a locator
 * action or assertion on their line, headed, with Piwi's pause bar, when their file is under the Playwright config's
 * folder.
 */
/** `root` names the Playwright config's folder to run them with; without it, the config of `uri`. */
data class RunTestsArgs(
    val uri: String,
    val testIds: List<Int>,
    val breakpoints: List<EditorBreakpoint>? = null,
    val root: String? = null,
)

data class RunCommandArgs(val cwd: String, val command: String, val env: Map<String, String>? = null)

/**
 * A command line that runs tests. `ref` is the ref its run carries (`PIWI_ORIGIN_REF` in `env`), which
 * `piwi/commandEnded` names once the command ends; null from an older service. `notice` is a sentence to show once
 * as a warning while it runs anyway: breakpoints passed to a project whose reporter does not pause at them.
 */
data class RunCommand(
    val cwd: String? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val ref: String? = null,
    val notice: String? = null,
)

/**
 * `piwi/commandStarted`: the command of a `RunCommand` built with `ref` was sent to a terminal; `terminalRef` is the ref
 * of that terminal's environment when it is another one, which the run carries instead.
 */
data class CommandStartedParams(val ref: String, val terminalRef: String? = null)

/** `piwi/commandEnded`: the command of a `RunCommand` with `ref` ended, with its exit code. */
data class CommandEndedParams(val ref: String, val exitCode: Int? = null)

/** `piwi/notice`: a sentence to show once about the context at `root`; `severity` is `information` or `warning`. */
data class NoticeParams(val root: String? = null, val severity: String? = null, val message: String? = null)

data class TraceParams(val uri: String, val executionId: Int)

data class TraceResult(val path: String? = null, val cwd: String? = null, val command: String? = null)

data class ScreenshotResult(val path: String? = null)

data class ContextStatus(
    val root: String? = null,
    val connected: Boolean = false,
    val serverUrl: String? = null,
    /** `environment`, `dotenv`, `desktop` or `editor`: where `serverUrl` came from. */
    val source: String? = null,
    val projectId: Int? = null,
    val projectName: String? = null,
    val branch: String? = null,
    val locators: Int = 0,
    val reachedFiles: Int = 0,
    val problem: String? = null,
    /** What `problem` is about: `not-configured`, `no-project`, `refused` or `unreachable`; null with no problem. */
    val problemKind: String? = null,
    /** The instance the environment, the `.env` or the settings name, in use or not; Connect offers it beside the desktop app. */
    val instance: NamedInstance? = null,
)

data class NamedInstance(val serverUrl: String? = null, val source: String? = null)

/** `piwi/status`; `desktopUrl` is the desktop app running on this machine, null when it does not run. */
data class StatusResult(val contexts: List<ContextStatus>? = null, val desktopUrl: String? = null)

data class RunInfo(
    val id: Int = 0,
    val status: String? = null,
    val startTime: String? = null,
    val totalTests: Int = 0,
    val passedTests: Int = 0,
    val failedTests: Int = 0,
    val flakyTests: Int = 0,
    val skippedTests: Int = 0,
    val url: String? = null,
)

/**
 * A run in progress: `status` is `running`, `initializing` or `finalizing`, `done` the tests that ended out of
 * `total`, `startedAt` ISO 8601, and `own` whether the editor started it.
 */
data class LiveRun(
    val runId: Int = 0,
    val status: String? = null,
    val done: Int = 0,
    val total: Int = 0,
    val failed: Int = 0,
    val startedAt: String? = null,
    val own: Boolean = false,
)

/** A test of the run in progress: `running` once it began, then `passed`, `failed`, `flaky` or `skipped`. */
data class LiveTest(val testCaseId: Int = 0, val status: String? = null)

/**
 * The latest run a context reads; `checkedOut` differs from `branch` while the checked-out branch has no run.
 * `failures` counts the failed executions as the runs laid over it (a test re-run from the editor, a local run) leave
 * them, `failingTests` the tests among them, `resolved` the tests those runs fixed and `overlays` those runs. `live` is
 * the run in progress the context follows, the editor's own or one on its branch, `stream` `live` while the instance's
 * event stream is connected or `polling`, `updatedAt` when the latest run was last read (ISO 8601), and `liveTests` the
 * tests `live` began or ended until the latest run is read once it ended, `reporterVersion` the version of
 * `@piwitests/reporter` the project installs (null when none is found), `baseline` the baseline chosen and what it
 * found, `branches` the branches a baseline can be chosen from, the default branch first. The fields after
 * `checkedOut` are null from an older service.
 */
data class RunStatus(
    val root: String? = null,
    val branch: String? = null,
    val run: RunInfo? = null,
    val failures: Int = 0,
    val checkedOut: String? = null,
    val failingTests: Int? = null,
    val resolved: Int? = null,
    val overlays: Int? = null,
    val live: LiveRun? = null,
    val stream: String? = null,
    val updatedAt: String? = null,
    val liveTests: List<LiveTest>? = null,
    val reporterVersion: String? = null,
    val baseline: Baseline? = null,
    val branches: List<String>? = null,
)

/**
 * The run the workspace is compared with: `kind` `ladder` (the latest complete run of the checked-out branch, a CI run
 * first, else the default branch's, else the newest of any branch), `branch` (that `branch`'s latest complete run),
 * `run` (the run `runId`) or `local` (a developer's own runs only, laid over none when no complete one exists).
 */
data class BaselineChoice(val kind: String = "ladder", val branch: String? = null, val runId: Int? = null)

/** The baseline in force and what it found: `CI run #120 on feature/x`, ending with `(no run)` when it found none. */
data class Baseline(val choice: BaselineChoice? = null, val label: String? = null)

/** `piwi/setBaseline`: the baseline chosen for the context at `root`, read at once. */
data class SetBaselineParams(val root: String, val choice: BaselineChoice)

data class RunStatusResult(val contexts: List<RunStatus>? = null)

/**
 * `piwi/runEnded`: a run the editor started ended and the latest run was read again with it: its counts, `fixed` the
 * tests failing before it that it passed, `stillFailing` and `newFailures` the titles (`login.spec.ts › logs in`, at
 * most five) of the tests it failed again and of those that were not failing before, with their counts.
 */
data class RunEnded(
    val root: String? = null,
    val runId: Int = 0,
    val url: String? = null,
    val passed: Int = 0,
    val failed: Int = 0,
    val flaky: Int = 0,
    val skipped: Int = 0,
    val fixed: Int = 0,
    val stillFailing: List<String>? = null,
    val newFailures: List<String>? = null,
    val stillFailingCount: Int? = null,
    val newFailureCount: Int? = null,
)

/**
 * A failure of the latest run where it shows, its line followed through the edits since the run, or, with `state`
 * `fixed-locally`, a failure a later run passed, at its test's line (`executionId` and `runId` are then the passing
 * ones). `source` is `ci`, `own` (a run the editor started) or `local`, `state` `failing`, `edited` (the line the run
 * failed at changed since) or `fixed-locally`, `browserName` the Playwright project. `file` is the test's spec relative
 * to the Playwright config's folder, `status` `failed` or `timedOut`, `clusterId` and `clusterTitle` its failure
 * cluster, `owner` the test's owner, `isNew` whether it did not fail on this project in the latest complete run,
 * `duration` in milliseconds. The fields after `hasTrace` are null from an older service. `piwi/failuresChanged`
 * carries the list again when a line or a state changes.
 */
data class WorkspaceFailure(
    val uri: String? = null,
    /** The folder of the Playwright config the test belongs to, which runs it. */
    val root: String? = null,
    val line: Int = 0,
    val title: String? = null,
    val headline: String? = null,
    val executionId: Int = 0,
    val runId: Int = 0,
    val url: String? = null,
    val hasTrace: Boolean = false,
    val source: String? = null,
    val state: String? = null,
    val browserName: String? = null,
    val file: String? = null,
    val status: String? = null,
    val testCaseId: Int? = null,
    val clusterId: Int? = null,
    val clusterTitle: String? = null,
    val owner: String? = null,
    val isNew: Boolean? = null,
    val duration: Long? = null,
    val hasScreenshot: Boolean? = null,
)

/**
 * The latest complete run a context reads: `origin` is what launched it (`ci`, `local`, `editor`…, null from an older
 * instance), `own` whether the editor started it, `startTime` ISO 8601, `url` its page in the dashboard.
 */
data class FailuresRun(
    val id: Int = 0,
    val branch: String? = null,
    val status: String? = null,
    val startTime: String? = null,
    val totalTests: Int = 0,
    val passedTests: Int = 0,
    val failedTests: Int = 0,
    val flakyTests: Int = 0,
    val skippedTests: Int = 0,
    val url: String? = null,
    val origin: String? = null,
    val own: Boolean? = null,
)

/** A run laid over the latest complete run, such as a test re-run from an editor; `own` when the editor started it. */
data class FailuresOverlay(
    val id: Int = 0,
    val origin: String? = null,
    val startTime: String? = null,
    val status: String? = null,
    val totalTests: Int = 0,
    val passedTests: Int = 0,
    val failedTests: Int = 0,
    val url: String? = null,
    val own: Boolean? = null,
)

/**
 * `piwi/failures`: the failures, the baseline run of the first context that has one (`run`, null when a developer's
 * own runs are read alone), the runs laid over it, newest first, when they were read (ISO 8601) and the baseline
 * chosen; the last four null from an older service.
 */
data class FailuresResult(
    val items: List<WorkspaceFailure>? = null,
    val run: FailuresRun? = null,
    val overlays: List<FailuresOverlay>? = null,
    val updatedAt: String? = null,
    val baseline: Baseline? = null,
)

/** `piwi/agentContext`: one block about a failure for a coding agent: the failure, its healing and its fix plan. */
data class AgentContextResult(val text: String? = null)

data class McpServerDefinition(val label: String? = null, val url: String? = null, val headers: Map<String, String>? = null)

data class McpServersResult(val servers: List<McpServerDefinition>? = null)

/**
 * `piwi/renderSteps`: a steps document from Piwi Picker, rendered for the file at `uri`. `line` and `character` are
 * the caret (0-based), whose page expression the steps run on; with `imports` `separate`, the import lines the code
 * needs and the file does not bind come in the result's `imports` rather than as comments in its `code`.
 */
data class RenderStepsParams(
    val uri: String,
    val steps: Any?,
    val line: Int? = null,
    val character: Int? = null,
    val imports: String? = null,
)

data class RenderStepsResult(val code: String? = null, val warnings: List<String>? = null, val imports: List<String>? = null)

/**
 * `piwi/record`: open a browser through the Playwright of the file's config and write what is done there into the
 * file at `uri`, from the caret (0-based). `into` is `steps` (lines of the test the caret is in), `test` (a new test at
 * the caret) or `file` (a whole new spec). `project` names the Playwright project whose `use` options the browser
 * gets, `startUrl` the page it opens (a path on the `baseURL`, or a URL), `title` the test's, `page` the expression
 * the steps run on, and `language` the editor's display language (a BCP 47 tag) for the recorder's panel.
 */
data class RecordParams(
    val uri: String,
    val line: Int,
    val character: Int,
    val into: String,
    val project: String? = null,
    val startUrl: String? = null,
    val title: String? = null,
    val page: String? = null,
    val language: String? = null,
)

/**
 * Where the recorded block goes: its first line (0-based), whether that line is a new one inserted first (otherwise
 * a blank line the block takes the place of), and what every line of the block that is not empty starts with.
 */
data class RecordingPlacement(val line: Int = 0, val newLine: Boolean = false, val indent: String = "")

/** `piwi/record`'s answer: the session and where its block goes, or the sentence to show; `projects` to ask which. */
data class RecordResult(
    val ok: Boolean = false,
    val sessionId: String? = null,
    val message: String? = null,
    val projects: List<String>? = null,
    val placement: RecordingPlacement? = null,
)

data class StopRecordingParams(val sessionId: String)

/** `piwi/recordingCommand`: `pause` or `resume`. */
data class RecordingCommandParams(val sessionId: String, val command: String)

/**
 * A recorded step: in words, the 0-based line of `RecordingUpdate.code` it starts on, the locators verified for its
 * element (best first) and the index of the one written, and the project function it is part of, if any.
 */
data class RecordingStep(
    val words: String? = null,
    val line: Int = 0,
    val locators: List<String>? = null,
    val chosen: Int? = null,
    val functionName: String? = null,
)

/** What a reader of the recorded code should check about the step `step`, on the 0-based line `line` of the code. */
data class RecordingWarning(val step: Int = 0, val line: Int = 0, val message: String? = null)

/**
 * `piwi/recordingChanged`: what the recorded block holds now (`code`: its lines joined with `\n`, not indented) and
 * the session's `state` (`starting`, `recording`, `paused`, `stopped` or `failed`), with the import lines the code
 * needs whose names the file does not bind yet, its steps and warnings, and a sentence on what happened with the action
 * it offers.
 */
data class RecordingUpdate(
    val sessionId: String? = null,
    val uri: String? = null,
    val into: String? = null,
    val state: String? = null,
    val code: String? = null,
    val imports: List<String>? = null,
    val steps: List<RecordingStep>? = null,
    val warnings: List<RecordingWarning>? = null,
    val message: String? = null,
    val command: PiwiCommand? = null,
)

data class PageCandidatesParams(val uri: String, val line: Int, val character: Int)

/** A page expression the steps written at a position could run on, and why it is offered. */
data class PageCandidate(val expression: String? = null, val reason: String? = null)

/**
 * `piwi/pageCandidates`: the candidates, best first, the default, and where the position is: `test` (in the body of a
 * test's or a hook's callback), `function` (in the body of any other function or method), `class` (in a class body,
 * outside its methods) or `file` (anywhere else).
 */
data class PageCandidatesResult(
    val candidates: List<PageCandidate>? = null,
    val default: String? = null,
    val context: String? = null,
)

data class SelectionsParams(val uri: String?)

data class SelectionItem(val key: String = "", val name: String? = null, val count: Int = 0, val includesFile: Boolean = false)

data class SelectionsResult(val items: List<SelectionItem>? = null)

/** `piwi/runSelection`: a saved selection to run, with the IDE's breakpoints as in `RunTestsArgs`. */
data class RunSelectionParams(val uri: String, val key: String, val breakpoints: List<EditorBreakpoint>? = null)

/**
 * `piwi/applyPick`: the edit that puts a locator picked while a run was paused at a breakpoint in place of the locator
 * chain its line holds. The file is `uri`, else `file`, a path relative to a Playwright config's folder as the run
 * reported it; `line` is 0-based.
 */
data class ApplyPickParams(val uri: String? = null, val file: String? = null, val line: Int, val locator: String)

data class PickPosition(val line: Int = 0, val character: Int = 0)

data class PickRange(val start: PickPosition? = null, val end: PickPosition? = null)

data class PickEdit(val range: PickRange? = null, val newText: String? = null)

/** The file found (null when none is) and the edit on its line; `edit` is null when the line holds no locator. */
data class ApplyPickResult(val uri: String? = null, val edit: PickEdit? = null)

data class ProjectRef(val id: Int = 0, val name: String = "")

/** `piwi/desktop`: the desktop app running on this machine; `url` is null when it does not run. */
data class DesktopResult(val url: String? = null, val projects: List<ProjectRef>? = null, val linked: ProjectRef? = null)

/**
 * `piwi/setCredentials`: the instance saved in the IDE, and, with `desktop`, the desktop app first while it runs,
 * on the project `desktopProject` names, else the one linked there to the folder. `baselines` are the baselines chosen
 * per context root, kept on this machine; when sent, a context they leave out reads the ladder.
 */
data class EditorCredentials(
    val serverUrl: String? = null,
    val apiKey: String? = null,
    val project: String? = null,
    val desktop: Boolean = false,
    val desktopProject: String? = null,
    val baselines: Map<String, BaselineChoice>? = null,
)

/**
 * `piwi/desktopJob`, and the arguments of the client command `piwi.desktopJob`: ask the desktop app to reproduce
 * (`kind` `reproduce`) or bisect (`bisect`) the failure `executionId` of the instance the context at `root` reads, or
 * to run Flake Lab (`flake-lab`) on the test `testCaseId`.
 */
data class DesktopJobParams(
    val root: String = "",
    val executionId: Int? = null,
    val testCaseId: Int? = null,
    val kind: String = "reproduce",
)

data class DesktopJobResult(val ok: Boolean = false, val message: String? = null, val jobId: String? = null)

data class DesktopJobShare(val label: String? = null)

/**
 * `piwi/desktopJobChanged`: a job's `status` (`running`, `done`, `declined`, `expired`, `gone`), the sentence to
 * show, and `share` when its verdict can be shared on the instance (`piwi/shareDesktopJob`).
 */
data class DesktopJobUpdate(
    val jobId: String? = null,
    val kind: String? = null,
    val status: String? = null,
    val message: String? = null,
    val share: DesktopJobShare? = null,
)

data class ShareDesktopJobParams(val jobId: String)

data class ShareDesktopJobResult(val ok: Boolean = false, val message: String? = null, val url: String? = null)

/** The service's custom requests beside the language server protocol. */
interface PiwiLanguageServer : LanguageServer {
    @JsonRequest("piwi/fileSummary")
    fun fileSummary(params: UriParams): CompletableFuture<FileSummary?>

    @JsonRequest("piwi/testsForFile")
    fun testsForFile(params: UriParams): CompletableFuture<TestsForFile?>

    @JsonRequest("piwi/runArgs")
    fun runArgs(params: RunTestsArgs): CompletableFuture<RunCommand?>

    @JsonRequest("piwi/status")
    fun status(): CompletableFuture<StatusResult?>

    @JsonRequest("piwi/runStatus")
    fun runStatus(): CompletableFuture<RunStatusResult?>

    @JsonRequest("piwi/failures")
    fun failures(): CompletableFuture<FailuresResult?>

    @JsonRequest("piwi/trace")
    fun trace(params: TraceParams): CompletableFuture<TraceResult?>

    @JsonRequest("piwi/screenshot")
    fun screenshot(params: TraceParams): CompletableFuture<ScreenshotResult?>

    @JsonRequest("piwi/agentContext")
    fun agentContext(params: TraceParams): CompletableFuture<AgentContextResult?>

    @JsonRequest("piwi/mcp")
    fun mcp(): CompletableFuture<McpServersResult?>

    @JsonRequest("piwi/renderSteps")
    fun renderSteps(params: RenderStepsParams): CompletableFuture<RenderStepsResult?>

    @JsonRequest("piwi/selections")
    fun selections(params: SelectionsParams): CompletableFuture<SelectionsResult?>

    @JsonRequest("piwi/runSelection")
    fun runSelection(params: RunSelectionParams): CompletableFuture<RunCommand?>

    @JsonRequest("piwi/desktop")
    fun desktop(): CompletableFuture<DesktopResult?>

    @JsonRequest("piwi/refresh")
    fun refresh(): CompletableFuture<Any?>

    @JsonRequest("piwi/refreshRun")
    fun refreshRun(): CompletableFuture<RunStatusResult?>

    @JsonRequest("piwi/desktopJob")
    fun desktopJob(params: DesktopJobParams): CompletableFuture<DesktopJobResult?>

    @JsonRequest("piwi/shareDesktopJob")
    fun shareDesktopJob(params: ShareDesktopJobParams): CompletableFuture<ShareDesktopJobResult?>

    @JsonRequest("piwi/record")
    fun record(params: RecordParams): CompletableFuture<RecordResult?>

    @JsonRequest("piwi/stopRecording")
    fun stopRecording(params: StopRecordingParams): CompletableFuture<Any?>

    @JsonRequest("piwi/recordingCommand")
    fun recordingCommand(params: RecordingCommandParams): CompletableFuture<Any?>

    @JsonRequest("piwi/pageCandidates")
    fun pageCandidates(params: PageCandidatesParams): CompletableFuture<PageCandidatesResult?>

    @JsonRequest("piwi/applyPick")
    fun applyPick(params: ApplyPickParams): CompletableFuture<ApplyPickResult?>

    @JsonNotification("piwi/setCredentials")
    fun setCredentials(params: EditorCredentials)

    @JsonNotification("piwi/commandStarted")
    fun commandStarted(params: CommandStartedParams)

    @JsonNotification("piwi/commandEnded")
    fun commandEnded(params: CommandEndedParams)

    @JsonNotification("piwi/setBaseline")
    fun setBaseline(params: SetBaselineParams)
}
