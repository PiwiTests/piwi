package dev.piwitests.jetbrains

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import java.nio.file.FileSystems
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFileAttributes
import java.nio.file.attribute.PosixFilePermission
import java.nio.file.attribute.UserPrincipal
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * What the plugin shows, computed from the editor service's answers, where it
 * looks for Playwright configs, and where a recording's lines go, with no
 * platform API, so it is tested without an IDE.
 */
object Glue {
    /** The files the editor service reads: test and application code (C# and Razor views too), and translations. */
    val SUPPORTED_EXTENSIONS = setOf(
        "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "html",
        "json", "yaml", "yml", "properties", "po", "resx", "cs", "cshtml", "razor",
    )

    val PLAYWRIGHT_CONFIGS = listOf(
        "playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs",
        "playwright.config.mts", "playwright.config.cts",
    )

    /** Whether a file name is a spec's, as the editor service reads specs (`checkout.spec.ts`, `cart.test.mjs`). */
    fun isSpecFile(name: String): Boolean = SPEC_FILE.containsMatchIn(name)

    private val SPEC_FILE = Regex("\\.(spec|test)\\.[cm]?[jt]sx?$")

    /** How many times **Verify ×3** runs a test. */
    const val VERIFY_REPEAT = 3

    /** The actions the notification after a recording offers for the test that holds the block. */
    const val RUN_RECORDED = "Run"
    const val VERIFY_RECORDED = "Verify ×3"

    /**
     * What runs the test `piwi/testAt` found at a line of the spec at `uri`: by its id when Piwi knows it, else by its
     * location; with `repeat`, by its location, that many times. Null outside every test.
     */
    fun testAtRun(uri: String, found: TestAtResult?, repeat: Int? = null): RunTestsArgs? {
        val test = found?.test
        if (test != null && repeat == null) return RunTestsArgs(uri, listOf(test.id))
        val location = found?.location ?: return null
        return RunTestsArgs(uri, emptyList(), locations = listOf(location), repeat = repeat)
    }

    /**
     * **Hold failures** from each run's start (`PiwiLocalSettings.runHoldFailures`): `auto` leaves it to the service, on
     * for a run with a breakpoint it can stop at or a `page.pause()` and off otherwise; `on` and `off` set it.
     */
    val HOLD_FAILURES_CHOICES = listOf("auto", "on", "off")

    /** A choice of [HOLD_FAILURES_CHOICES] in words, for a menu or a setting. */
    fun holdFailuresLabel(choice: String): String = when (choice) {
        "on" -> "On from each run's start"
        "off" -> "Off from each run's start"
        else -> "Auto: on with a breakpoint or a page.pause()"
    }

    /** What a run sends the service of Hold failures: true for `on`, false for `off`, nothing for `auto` or another. */
    fun holdFailuresOption(choice: String): Boolean? = when (choice) {
        "on" -> true
        "off" -> false
        else -> null
    }

    /**
     * A run's arguments started as the person chose for every run of the project: headed when `headed`, and Hold
     * failures as `holdFailures` says ([holdFailuresOption]). A debug run (`debug`) starts as the service builds it.
     */
    fun withRunStart(args: RunTestsArgs, headed: Boolean, holdFailures: String): RunTestsArgs =
        if (args.debug != null) args else args.copy(headed = headed.takeIf { it }, holdFailures = holdFailuresOption(holdFailures))

    /** A saved selection's run, started as [withRunStart] starts a run of tests. */
    fun withRunStart(params: RunSelectionParams, headed: Boolean, holdFailures: String): RunSelectionParams =
        params.copy(headed = headed.takeIf { it }, holdFailures = holdFailuresOption(holdFailures))

    /** Whether a path, with either separator, names a Playwright config. */
    fun isPlaywrightConfig(path: String?): Boolean =
        path != null && path.substringAfterLast('/').substringAfterLast('\\') in PLAYWRIGHT_CONFIGS

    /**
     * Whether a folder created, removed, renamed or moved at `path` may hold a Playwright config the search finds: it is
     * under one of `roots`, at most [CONFIG_DEPTH] levels down, and neither it nor a folder above it is skipped.
     */
    fun mayHoldConfigs(path: String?, roots: List<Path>): Boolean {
        // Strings only: it runs for every folder a refresh of the file system reports, in a write action.
        val dir = path?.replace('\\', '/')?.trimEnd('/') ?: return false
        for (root in roots) {
            val prefix = root.toString().replace('\\', '/').trimEnd('/') + "/"
            if (!dir.startsWith(prefix, ignoreCase = true)) continue
            val segments = dir.substring(prefix.length).split('/').filter { it.isNotEmpty() && it != "." }
            return segments.size <= CONFIG_DEPTH && segments.none { it.startsWith(".") || it in SKIPPED_DIRS }
        }
        return false
    }

    /** Directory levels searched below a folder for Playwright configs, as the editor service does. */
    const val CONFIG_DEPTH = 4

    /** Folders never searched for a Playwright config, beside the hidden ones. */
    private val SKIPPED_DIRS = setOf("node_modules", "dist", "build", "coverage", "test-results")

    /** Where a project's Playwright configs are: the folders searched, and those holding a config. */
    data class PlaywrightSearch(val roots: List<Path>, val configDirs: List<Path>)

    /**
     * The folder holding a project's files, from the IDE's project path: Rider keeps a solution's
     * project in `<solution folder>/.idea/.idea.<name>`, so it is the folder above `.idea`.
     */
    fun projectFolder(basePath: String): String {
        val path = basePath.replace('\\', '/').trimEnd('/')
        val idea = Regex("/\\.idea(/|$)").find(path) ?: return path
        return path.substring(0, idea.range.first).ifEmpty { "/" }
    }

    /** The folders, each once, without those inside another one. */
    fun outermost(folders: List<Path>): List<Path> {
        val all = folders.map { it.toAbsolutePath().normalize() }.distinct()
        return all.filter { folder -> all.none { it != folder && folder.startsWith(it) } }
    }

    /**
     * The folders under `roots`, the roots included and down to [CONFIG_DEPTH] levels, that hold a
     * Playwright config. Dependencies, build output and hidden folders are skipped, as the editor
     * service skips them.
     */
    fun playwrightConfigDirs(roots: List<Path>): List<Path> {
        val found = LinkedHashSet<Path>()
        walkSearched(roots) { file ->
            if (file.fileName.toString() in PLAYWRIGHT_CONFIGS) file.parent?.let { found.add(it) }
            false
        }
        return found.sorted()
    }

    /**
     * Each regular file under `roots`, the roots included and down to [CONFIG_DEPTH] levels, skipping what the
     * Playwright config search skips, until `visit` returns true.
     */
    private fun walkSearched(roots: List<Path>, visit: (Path) -> Boolean) {
        for (root in roots) {
            if (!Files.isDirectory(root)) continue
            var done = false
            Files.walkFileTree(root, emptySet(), CONFIG_DEPTH + 1, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    val name = dir.fileName?.toString() ?: return FileVisitResult.CONTINUE
                    val skipped = dir != root && (name.startsWith(".") || name in SKIPPED_DIRS)
                    return if (skipped) FileVisitResult.SKIP_SUBTREE else FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    done = attrs.isRegularFile && visit(file)
                    return if (done) FileVisitResult.TERMINATE else FileVisitResult.CONTINUE
                }

                override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult = FileVisitResult.CONTINUE
            })
            if (done) return
        }
    }

    /** An MSBuild `PackageReference` element's `Include`, its other attributes quoted in either quote. */
    private val PACKAGE_REFERENCE = Regex(
        """<PackageReference\b(?:[^>"']|"[^"]*"|'[^']*')*?\bInclude\s*=\s*(?:"([^"]*)"|'([^']*)')""",
        RegexOption.IGNORE_CASE,
    )

    /** A Playwright for .NET package: `Microsoft.Playwright`, or one of its test framework packages (`.NUnit`, `.Xunit.v3`). */
    private val DOTNET_PLAYWRIGHT_PACKAGE = Regex("""Microsoft\.Playwright(\.[A-Za-z0-9]+)*""", RegexOption.IGNORE_CASE)

    /**
     * Whether the text of an MSBuild project or `Directory.Build.props` references Playwright for .NET, outside its
     * comments; an `Include` may list several packages, split by `;`.
     */
    fun referencesDotnetPlaywright(project: String): Boolean =
        PACKAGE_REFERENCE.findAll(project.replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")).any { match ->
            (match.groupValues[1].ifEmpty { match.groupValues[2] }).split(';')
                .any { DOTNET_PLAYWRIGHT_PACKAGE.matches(it.trim()) }
        }

    /** Whether a file is an MSBuild project of .NET code, or the props every project of its folder imports. */
    private fun isMsbuildProject(name: String): Boolean =
        name.equals("Directory.Build.props", ignoreCase = true) ||
            listOf(".csproj", ".fsproj", ".vbproj").any { name.endsWith(it, ignoreCase = true) }

    /**
     * Whether an MSBuild project under `roots` (`searchedFolders`) references Playwright for .NET, whose tests Piwi does
     * not read. A file over a megabyte is not read.
     */
    fun holdsDotnetPlaywright(roots: List<Path>): Boolean {
        var found = false
        walkSearched(roots) { file ->
            found = isMsbuildProject(file.fileName.toString()) &&
                runCatching { Files.size(file) <= 1_000_000 && referencesDotnetPlaywright(Files.readString(file)) }.getOrDefault(false)
            found
        }
        return found
    }

    /** The repository around `dir`: the nearest folder, `dir` included, that holds `.git`; null outside one. */
    fun repositoryRoot(dir: Path): Path? =
        generateSequence(dir.toAbsolutePath().normalize()) { it.parent }.firstOrNull { Files.exists(it.resolve(".git")) }

    /**
     * The Playwright configs of a project whose files are in `folders` (those on disk). When they
     * hold none, the repository around them is searched: a Rider solution in a subfolder, beside
     * the tests. A repository in the home folder or at a drive's root is not: it holds other projects.
     */
    fun findPlaywright(folders: List<Path>, home: Path?): PlaywrightSearch {
        val roots = outermost(folders.filter { Files.isDirectory(it) })
        val dirs = playwrightConfigDirs(roots)
        if (dirs.isNotEmpty()) return PlaywrightSearch(roots, dirs)
        val repositories = repositoriesAround(roots, home)
        if (repositories.isEmpty() || repositories == roots) return PlaywrightSearch(roots, dirs)
        val inRepositories = playwrightConfigDirs(repositories)
        return if (inRepositories.isEmpty()) PlaywrightSearch(roots, dirs) else PlaywrightSearch(repositories, inRepositories)
    }

    /** The repositories around `roots`, but one in the home folder or at a drive's root, which hold other projects. */
    private fun repositoriesAround(roots: List<Path>, home: Path?): List<Path> {
        val homeFolder = home?.toAbsolutePath()?.normalize()
        return outermost(roots.mapNotNull { repositoryRoot(it) }.filter { it != homeFolder && it.parent != null })
    }

    /** Every folder `findPlaywright` searches for a project in `roots`: they and the repositories around them. */
    fun searchedFolders(roots: List<Path>, home: Path?): List<Path> = outermost(roots + repositoriesAround(roots, home))

    private val ACTIVE = setOf("running", "initializing", "finalizing")

    /**
     * The first entry of the status bar item's popup: `REFRESH` reads the latest run again (`piwi/refreshRun`), `RETRY`
     * reads the instance again (Reload Piwi), `NODE_SETTINGS` opens the Node.js settings, then starts the service again,
     * `RESTART` starts a service that stopped again, with Open the log after it.
     */
    enum class StatusAction { REFRESH, RETRY, CONNECT, SETTINGS, NODE_SETTINGS, RESTART, NONE }

    /**
     * The icon before the status bar text: Piwi's own, the connection's state (`CONNECT`, `UNREACHABLE`), a run in
     * progress, the tests still failing, a run that passed, or a run that ended otherwise or a service that cannot
     * start (`WARNING`).
     */
    enum class StatusIcon { PIWI, CONNECT, UNREACHABLE, RUNNING, FAILING, PASSED, WARNING }

    /**
     * What the status bar item shows: its text and tooltip, the page of the run it counts, its popup's first entry, its
     * icon, and whether its text takes the error color, while tests of the run it counts fail.
     */
    data class StatusView(
        val text: String,
        val tooltip: String,
        val url: String?,
        val action: StatusAction,
        val icon: StatusIcon = StatusIcon.PIWI,
        val error: Boolean = false,
    )

    /**
     * The context the status bar item speaks for: the one whose Playwright config folder holds `file` (a path, with
     * either separator), the deepest when several do, else the first connected, else the first the instance did not
     * answer or the desktop app did not prove itself to, else the first. Null without a context.
     */
    fun statusContext(contexts: List<ContextStatus>, file: String?): ContextStatus? =
        contexts.filter { holds(it.root, file) }.maxByOrNull { folderPath(it.root!!).length }
            ?: contexts.firstOrNull { it.connected }
            ?: contexts.firstOrNull { it.problemKind == "unreachable" || it.problemKind == "desktop-unproven" }
            ?: contexts.firstOrNull()

    /** A path with `/` separators and one trailing `/`, so a folder holds what starts with it. */
    private fun folderPath(path: String) = path.replace('\\', '/').trimEnd('/') + "/"

    /** Whether the folder `root` holds `file`, either path with either separator, ignoring case. */
    private fun holds(root: String?, file: String?): Boolean =
        root != null && file != null && folderPath(file).startsWith(folderPath(root), ignoreCase = true)

    /**
     * With several contexts, the tooltip's line on the one the status bar item speaks for, by its label (else its
     * folder's name): `The active file's Playwright config, in admin (one of 3)`, or, when `file` is in none, how to see
     * another's run. Empty with one context.
     */
    private fun configLine(contexts: List<ContextStatus>, shown: ContextStatus, file: String?): String {
        if (contexts.size < 2) return ""
        val where = shown.label ?: shown.root?.let { folderPath(it).trimEnd('/').substringAfterLast('/') } ?: return ""
        return if (holds(shown.root, file)) {
            "\nThe active file's Playwright config, in $where (one of ${contexts.size})"
        } else {
            "\nThe Playwright config in $where (one of ${contexts.size}): open a file of another one to see its run"
        }
    }

    private fun plural(n: Int, one: String, many: String = "${one}s") = "$n ${if (n == 1) one else many}"

    /** A run in progress in the status bar: `Piwi: run #124 · 4 of 9 · 1 failed`, and ` · yours` for the editor's own. */
    private fun liveText(live: LiveRun): String {
        val run = if (live.ci) "CI run" else "run"
        return "Piwi: $run #${live.runId} · ${countWords(live.done, live.total, live.failed)}" + if (live.own) " · yours" else ""
    }

    /**
     * How far a run is, as both editors word it wherever they count one: `3 of 9 · 1 failed · 1 flaky · 1 ended at a
     * stop`, each outcome only when there is one (VS Code's `countWords`).
     */
    fun countWords(done: Int, total: Int, failed: Int = 0, flaky: Int = 0, endedAtStop: Int = 0): String =
        listOfNotNull(
            "$done of $total",
            if (failed > 0) "$failed failed" else null,
            if (flaky > 0) "$flaky flaky" else null,
            if (endedAtStop > 0) "$endedAtStop ended at a stop" else null,
        ).joinToString(" · ")

    /**
     * The run in progress the status bar counts for the context of `file`, as `statusView` picks it: that context's
     * (the only one's, with one), else the editor's own run of another context, which stays in view whichever config
     * the file belongs to; null while none runs, or while that context is not connected.
     */
    fun liveRun(status: StatusResult?, runs: RunStatusResult?, file: String?): LiveRun? {
        val contexts = status?.contexts.orEmpty()
        val shown = statusContext(contexts, file)?.takeIf { it.connected } ?: return null
        val run = runs?.contexts?.firstOrNull { it.root == shown.root }
            ?: if (contexts.size == 1) runs?.contexts?.firstOrNull() else null
        return run?.live ?: runs?.contexts?.firstNotNullOfOrNull { context -> context.live?.takeIf { it.own } }
    }

    /** The tooltip's line on a run in progress: `Your run #124 is running: 4 of 9 · 1 failed`. */
    private fun liveLine(live: LiveRun): String {
        val run = when {
            live.own -> "Your run"
            live.ci -> "CI run"
            else -> "Run"
        }
        return "\n$run #${live.runId} is running: ${countWords(live.done, live.total, live.failed)}"
    }

    /** The status bar text while the latest run is read again (**Refresh the latest run**, first in its popup). */
    const val REFRESHING = "Piwi: refreshing…"

    /**
     * How long before `now` (ms since the epoch) an ISO 8601 time is: `12 s ago`, `4 min ago`, `2 h ago`, `3 d ago`,
     * or `just now`.
     */
    fun relativeTime(iso: String, now: Long): String {
        val at = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return "just now"
        val seconds = (now - at) / 1000
        return when {
            seconds < 1 -> "just now"
            seconds < 60 -> "$seconds s ago"
            seconds < 3_600 -> "${seconds / 60} min ago"
            seconds < 86_400 -> "${seconds / 3_600} h ago"
            else -> "${seconds / 86_400} d ago"
        }
    }

    /** The tooltip's line on when the latest run was read, and how the next one comes: `Updated 12 s ago · live`. */
    private fun updatedLine(run: RunStatus?, now: Long): String {
        val at = run?.updatedAt ?: return ""
        val how = when (run.stream) {
            "live" -> " · live"
            "polling" -> " · read every minute"
            else -> ""
        }
        return "\nUpdated ${relativeTime(at, now)}$how"
    }

    /**
     * The status bar text: the latest run on the checked-out branch, with what the runs laid over it fixed or still
     * fail, or what keeps the service from reading it, or from starting (`startProblem`, with no status). While a run is in progress, the editor's own or one on the
     * branch, the text counts it, and the tooltip has both, with the baseline chosen and when the latest run was read. The
     * first entry of its popup reads it again.
     * It speaks for the context of `file`, the selected editor's ([statusContext]); with several, the tooltip names its
     * Playwright config. The text takes the error color while tests of the run it counts fail, that run in progress too.
     * A null status means the service has not started, and it starts with the first file of the project opened; or,
     * with `stopped`, that the one that ran stopped: the item says Piwi is not running and offers to restart it.
     */
    fun statusView(
        status: StatusResult?,
        runs: RunStatusResult?,
        desktopChosen: Boolean = false,
        now: Long = System.currentTimeMillis(),
        startProblem: String? = null,
        file: String? = null,
        trusted: Boolean = true,
        stopped: Boolean = false,
    ): StatusView {
        if (status == null && !trusted) {
            return StatusView("Piwi: waiting for trust", WAITING_FOR_TRUST, null, StatusAction.NONE, StatusIcon.WARNING)
        }
        if (status == null && startProblem != null) {
            return StatusView("Piwi: Node.js", "$startProblem\nClick for the Node.js settings.", null, StatusAction.NODE_SETTINGS, StatusIcon.WARNING)
        }
        if (status == null && stopped) {
            return StatusView("Piwi: not running", SERVICE_STOPPED_TOOLTIP, null, StatusAction.RESTART, StatusIcon.WARNING)
        }
        if (status == null) return StatusView("Piwi", "$NOT_STARTED Click for Piwi's settings.", null, StatusAction.SETTINGS)
        val contexts = status.contexts.orEmpty()
        val shown = statusContext(contexts, file)
            ?: return StatusView("Piwi", "No Playwright config found", null, StatusAction.NONE)
        val hint = desktopHint(status, desktopChosen).let { if (it.isEmpty()) "" else "\n$it" }
        val config = configLine(contexts, shown, file)
        if (!shown.connected && shown.problemKind == "desktop-unproven") {
            val problem = shown.problem ?: "The desktop app did not prove it holds its token"
            return StatusView("Piwi: restart the desktop app", "$problem$config$hint", null, StatusAction.RETRY, StatusIcon.WARNING)
        }
        if (!shown.connected && shown.problemKind == "unreachable") {
            val problem = shown.problem ?: "The instance did not answer"
            val tooltip = "$problem$config\nPiwi reads it again on its own; Reload Piwi reads it now.$hint"
            return StatusView("Piwi: unreachable", tooltip, null, StatusAction.RETRY, StatusIcon.UNREACHABLE)
        }
        if (!shown.connected) {
            return StatusView("Piwi: connect", (shown.problem ?: "Not connected") + config + hint, null, StatusAction.CONNECT, StatusIcon.CONNECT)
        }
        // With several contexts, another one's run is never shown for this one.
        val run = runs?.contexts?.firstOrNull { it.root == shown.root }
            ?: if (contexts.size == 1) runs?.contexts?.firstOrNull() else null
        val where = (shown.projectName ?: "Piwi") + (run?.branch?.let { " on $it" } ?: "") + (if (run?.run != null) fallbackNote(run) else "")
        val reporter = run?.reporterVersion?.let { "\nreporter $it" } ?: ""
        val from = (shown.serverUrl?.let { url -> "\n$url, from ${sourceLabel(shown.source)}" } ?: "") + reporter + hint
        // The editor's own run in progress stays in view whichever config the file belongs to.
        val live = run?.live ?: runs?.contexts?.firstNotNullOfOrNull { context -> context.live?.takeIf { it.own } }
        val alarm = run?.alarm == true
        val baseline = baselineLine(run?.baseline?.label)?.let { "\n$it" } ?: ""
        val progress = (live?.let { liveLine(it) } ?: "") + updatedLine(run, now)
        val overlays = run?.overlays ?: 0
        val r = run?.run
        if (r == null && overlays > 0) {
            // A developer's own runs alone, with no baseline.
            val failing = run?.failingTests ?: run?.failures ?: 0
            val text = live?.let { liveText(it) } ?: if (failing > 0) "Piwi: $failing failing" else "Piwi: no failure"
            val tooltip = "${plural(overlays, "local run")} of $where, ${plural(failing, "test")} failing$config$baseline$progress$from"
            return when {
                live != null -> StatusView(text, tooltip, null, StatusAction.REFRESH, StatusIcon.RUNNING)
                failing > 0 -> StatusView(text, tooltip, null, StatusAction.REFRESH, StatusIcon.FAILING, alarm)
                else -> StatusView(text, tooltip, null, StatusAction.REFRESH, StatusIcon.PASSED)
            }
        }
        if (r == null) {
            val tooltip = "No run of $where yet$config$baseline$progress$from"
            if (live != null) return StatusView(liveText(live), tooltip, null, StatusAction.REFRESH, StatusIcon.RUNNING)
            return StatusView("Piwi: no run", tooltip, null, StatusAction.REFRESH)
        }
        // The tests still failing once the later runs are laid over the run; the run's own count when the answer has none.
        val failing = run.failingTests ?: r.failedTests
        val fixed = run.resolved ?: 0
        val local = if (overlays > 0) "\n${plural(overlays, "local run")} since · ${plural(fixed, "test")} fixed locally" else ""
        val tooltip = "Run #${r.id} of $where: ${r.passedTests} passed, ${r.failedTests} failed, " +
            "${r.flakyTests} flaky, ${r.skippedTests} skipped$config$baseline$local$progress$from"
        val flaky = if (r.flakyTests > 0) " · ${r.flakyTests} flaky" else ""
        val refresh = StatusAction.REFRESH
        return when {
            live != null -> StatusView(liveText(live), tooltip, r.url, refresh, StatusIcon.RUNNING)
            r.status in ACTIVE -> {
                val done = r.passedTests + r.failedTests + r.flakyTests + r.skippedTests
                StatusView("Piwi: ${countWords(done, r.totalTests, r.failedTests, r.flakyTests)}", tooltip, r.url, refresh, StatusIcon.RUNNING)
            }
            failing > 0 -> {
                val fixedText = if (fixed > 0) " · $fixed fixed locally" else ""
                StatusView("Piwi: $failing failing$fixedText$flaky", tooltip, r.url, refresh, StatusIcon.FAILING, alarm)
            }
            r.status != "passed" && r.status != "failed" -> StatusView("Piwi: ${r.statusText ?: r.status}", tooltip, r.url, refresh, StatusIcon.WARNING)
            fixed > 0 -> StatusView("Piwi: $fixed fixed locally", tooltip, r.url, refresh, StatusIcon.PASSED)
            else -> StatusView("Piwi: ${r.passedTests} passed$flaky", tooltip, r.url, refresh, StatusIcon.PASSED)
        }
    }

    const val NOT_STARTED = "Piwi starts when you open a file of this project."

    /** The status bar item's tooltip once the editor service that ran stopped. */
    const val SERVICE_STOPPED_TOOLTIP =
        "The Piwi editor service stopped, so nothing of the instance is read.\nClick to restart it, or to open its log, which says why it stopped."

    /** What the tool window's header and the settings page say of the connection once the editor service stopped. */
    const val NOT_RUNNING = "Piwi is not running: its editor service stopped."

    /** The tool window's link, while the service cannot start, to the Node.js settings, as the settings page's button. */
    const val NODE_SETTINGS_LINK = "Node.js settings…"



    /** What a project opened in safe mode says: the editor service runs the repository's tests and reads its `.env`. */
    const val UNTRUSTED = "Piwi starts once you trust this project: it runs the project's tests and reads its .env."

    /** What the status bar item, the Piwi tool window and the settings page say of a project in safe mode. */
    const val WAITING_FOR_TRUST = "Piwi waits for you to trust this project: it runs the project's tests and reads its " +
        ".env. Trusting it starts Piwi."

    /** What the first-run notification says Piwi does. */
    const val FIRST_RUN = "Piwi shows the latest CI failures of your Playwright tests at the lines they failed at, " +
        "with your local runs laid over them, and records tests at the caret."

    /**
     * What a project whose `.csproj` references Playwright for .NET, and that holds no Playwright config, hears once:
     * Piwi reads Playwright Test suites in JavaScript and TypeScript.
     */
    const val DOTNET_PLAYWRIGHT_NOTE = "Piwi reads Playwright Test suites in JavaScript and TypeScript: the Playwright " +
        "for .NET tests of this project get no failures, results or runs from Piwi in the IDE."

    /** Why the settings page's Playwright runner option is off, in an IDE without the runner. */
    const val NO_PLAYWRIGHT_RUNNER = "This IDE's JavaScript plugin has no Playwright runner, so the tests run in the " +
        "Run tool window's console."

    /** Where the docs say which suites Piwi reads: **Learn more** on `DOTNET_PLAYWRIGHT_NOTE`. */
    const val DOTNET_PLAYWRIGHT_DOCS_URL = "https://piwitests.dev/features/jetbrains#install-and-start"

    /** The editor extensions' documentation, which the first-run notification's **Learn more** opens. */
    const val DOCS_URL = "https://piwitests.dev/features/editors"

    /** Piwi's page for the JetBrains IDEs, which the tool window's gear opens (**Documentation**). */
    const val JETBRAINS_DOCS_URL = "https://piwitests.dev/features/jetbrains"

    /**
     * Whether the first-run notification shows: not `shown` on this installation yet, in a `trusted` project holding a
     * Playwright config, while no context of `status` is connected and none of `instances` names an instance (the
     * project's settings, `PIWI_DASHBOARD_URL` in the environment or a config folder's `.env`, the desktop app while it
     * runs). `status` is null until the service starts, with the first file opened.
     */
    fun showsFirstRun(shown: Boolean, trusted: Boolean, configDirs: List<Path>, status: StatusResult?, instances: List<String?>): Boolean =
        !shown && trusted && configDirs.isNotEmpty() &&
            status?.contexts.orEmpty().none { it.connected } && instances.all { it.isNullOrBlank() }

    /** The oldest Node.js major version the editor service runs on. */
    const val NODE_MAJOR = 20

    /** A service that stops this soon after it started failed to start. */
    const val SERVICE_START_MILLIS = 30_000L

    /** How many times a service that failed to start is started again, within [SERVICE_RESTART_PERIOD_MILLIS]. */
    const val SERVICE_RESTARTS = 3
    const val SERVICE_RESTART_PERIOD_MILLIS = 300_000L

    /**
     * Whether the editor service, started at `startedAt` and stopped at `stoppedAt`, is started again: it stopped while
     * starting, and fewer than [SERVICE_RESTARTS] of `restarts`, when it was started again before, are recent. The IDE
     * stops a service whose start failed, for instance when a tab opened or closed while it sent the open files.
     */
    fun restartsService(startedAt: Long?, stoppedAt: Long, restarts: List<Long>): Boolean =
        startedAt != null && stoppedAt - startedAt in 0..SERVICE_START_MILLIS &&
            restarts.count { stoppedAt - it < SERVICE_RESTART_PERIOD_MILLIS } < SERVICE_RESTARTS

    /**
     * Why the editor service cannot start with the Node.js interpreter `node`, from what `node --version` printed (null
     * when it did not run); null when it can.
     */
    fun nodeProblem(node: String, version: String?): String? {
        val where = "choose one in Settings → Languages & Frameworks → Node.js"
        val printed = version?.trim().orEmpty()
        val major = Regex("^v?(\\d+)\\.").find(printed)?.groupValues?.get(1)?.toIntOrNull()
            ?: return "Piwi needs Node.js $NODE_MAJOR or later, and $node did not run: $where."
        return if (major < NODE_MAJOR) "Piwi needs Node.js $NODE_MAJOR or later, and $node is $printed: $where." else null
    }

    /** Whether a `piwi/failures` item is a failure of the latest run that a later run passed. */
    fun isFixedLocally(failure: WorkspaceFailure) = failure.state == "fixed-locally"

    /** How the failures tool window groups the failures under the run: `file`, `cluster`, `owner` or `flat`. */
    val FAILURE_GROUPINGS = listOf("file", "cluster", "owner", "flat")

    /**
     * A node of the failures tree as the tool window draws it: a node of the service's tree (`FailuresResult.tree`),
     * with the age of its run after its description, and the failure a leaf stands for. `kind` is `context`, `run`,
     * `runs`, `overlay`, `group` or `failure`; `key` stays the same across answers, so the tree keeps a node's expansion
     * and selection by it; `icon` is the service's (`context`, `run`, `history`, `failed`, `passed`, `file`, `cluster`,
     * `owner`, `failing`, `edited`, `fixed`); `note` what a failure says about its run; `url` the page a run opens, a
     * failure's execution page; `root`, on a Playwright config's node and a run's, that config's folder, which their
     * actions act on.
     */
    data class FailureNode(
        val key: String,
        val kind: String,
        val label: String,
        val description: String,
        val icon: String,
        val expanded: Boolean,
        val url: String?,
        val failure: WorkspaceFailure? = null,
        val note: String? = null,
        val root: String? = null,
        val children: List<FailureNode> = emptyList(),
        /** The lines of its hover, as the service writes them (`FailureTreeNode.tooltip`). */
        val tooltip: List<String> = emptyList(),
        /** On a flaky test: its spec and the 0-based line of its `test(…)` call. */
        val uri: String? = null,
        val line: Int? = null,
        /** On a flaky test: what looks into it, its Flakiness tab first (`FailureTreeNode.actions`). */
        val actions: List<PiwiCommand> = emptyList(),
    )

    /**
     * The failures tree as the tool window draws it, from the tree the service grouped: a run's age after its
     * description (`4 min ago`), and, while the editor's own run is `live` ([ownRunInProgress]), that run on the node of
     * the run of its Playwright config (`liveRoot`; any run's node when either does not say which: `running 4 of 9 · 1
     * failed`).
     */
    fun failureNodes(
        result: FailuresResult?,
        now: Long = System.currentTimeMillis(),
        live: LiveRun? = null,
        liveRoot: String? = null,
    ): List<FailureNode> {
        val running = live?.takeIf { it.own }
        val failures = result?.items.orEmpty().associateBy { it.executionId }
        fun draw(node: FailureTreeNode): FailureNode = FailureNode(
            key = node.key,
            kind = node.kind,
            label = node.label,
            description = if (running != null && node.kind == "run" && (liveRoot == null || node.root == null || node.root == liveRoot)) {
                "running ${countWords(running.done, running.total, running.failed)}"
            } else {
                listOfNotNull(node.description.ifBlank { null }, node.startTime?.let { relativeTime(it, now) }).joinToString(" · ")
            },
            icon = node.icon,
            expanded = node.expanded,
            url = node.url,
            failure = node.executionId?.let { failures[it] },
            note = node.note,
            root = node.root,
            children = node.children.orEmpty().map { draw(it) },
            tooltip = node.tooltip.orEmpty(),
            uri = node.uri,
            line = node.line,
            actions = node.actions.orEmpty().filter { it.title != null && it.command != null },
        )
        return result?.tree.orEmpty().map { draw(it) }
    }

    /**
     * The editor's own run in progress the failures tree counts, and the folder of its Playwright config: counted from
     * what the run's own process tells the hub (`RunSession.progress`, from its `run-begin` and `run-progress`) when it
     * does, so it counts with no instance and with the desktop app as the instance, else from the instance (`LiveRun`).
     * The instance's run is matched to its session by its ref alone: with none matched, the instance's count shows. A
     * run started in a terminal, or a desktop app's job in a throwaway checkout, is not the editor's own. Null while none
     * runs.
     */
    fun ownRunInProgress(contexts: List<RunStatus>, sessions: Map<String, RunSession>): Pair<LiveRun, String?>? {
        val own = contexts.firstOrNull { it.live?.own == true }
        val ownLive = own?.live
        val told = sessions.values.filter { !it.ended && !it.terminal && it.checkout == null && it.progress?.status == "running" }
        val session = if (ownLive == null) told.firstOrNull() else told.firstOrNull { ownLive.ref != null && it.ref == ownLive.ref }
        val progress = session?.progress ?: return ownLive?.let { it to own.root }
        val counted = (ownLive ?: LiveRun(status = "running", own = true, ref = session.ref))
            .copy(done = progress.done, total = progress.total, failed = progress.failed)
        return counted to (if (ownLive != null) own.root else session.root)
    }

    /**
     * What Re-run the failing tests runs: the tests still failing of every Playwright config, one run each
     * (`FailuresResult.rerun`), or of the config at `root` alone, run from its node in the tool window.
     */
    fun failingRuns(result: FailuresResult?, root: String? = null): List<RunTestsArgs> {
        val runs = result?.rerun.orEmpty()
        return if (root == null) runs else runs.filter { it.root == root }
    }

    /**
     * Whether two failure trees hold the same nodes in the same places, by key, all the way down: then only what the
     * nodes say changed, such as a run in progress counting its tests, and the tree keeps its rows as they are.
     */
    fun sameShape(a: List<FailureNode>, b: List<FailureNode>): Boolean =
        a.size == b.size && a.indices.all { a[it].key == b[it].key && sameShape(a[it].children, b[it].children) }

    /** Whether a node of the failures tree is a run's `Flaky in this run` group, a context's or the only run's. */
    fun isFlakyGroup(key: String): Boolean = key == "flaky" || key.endsWith("\nflaky")

    /**
     * How many flaky tests the failures tree lists, by the folder of the Playwright config whose run's `Flaky in this
     * run` group lists them: its `run` or `context` node's `root`, the empty string when no node names one.
     */
    fun flakyTestsByRoot(result: FailuresResult?): Map<String, Int> {
        val counts = linkedMapOf<String, Int>()
        fun walk(nodes: List<FailureTreeNode>, root: String) {
            for (node in nodes) {
                val at = node.root ?: root
                if (isFlakyGroup(node.key)) counts[at] = (counts[at] ?: 0) + node.children.orEmpty().size
                else walk(node.children.orEmpty(), at)
            }
        }
        walk(result?.tree.orEmpty(), "")
        return counts
    }

    /** The flaky tests the tree lists for the config at `root`, else those of the only config it lists any for. */
    fun flakyTestsListed(result: FailuresResult?, root: String?): Int {
        val counts = flakyTestsByRoot(result)
        return counts[root] ?: counts.values.singleOrNull() ?: 0
    }

    /** What opens a config's flaky tests: `Show the run's 2 flaky tests`, as VS Code's status tooltip says it. */
    fun showFlakyTestsLabel(count: Int): String =
        if (count == 1) "Show the run's flaky test" else "Show the run's $count flaky tests"

    /** The baseline a context compares with, as the tooltip and the tool window name it: `Baseline: CI run #120 on main`. */
    fun baselineLine(label: String?): String? = label?.ifBlank { null }?.let { "Baseline: $it" }

    /** An entry of **Compare with…**: a baseline, or, with a null `choice`, a run by its id, asked for first. */
    data class BaselineEntry(val label: String, val detail: String, val current: Boolean, val choice: BaselineChoice?)

    /**
     * What **Compare with…** offers for a context, as VS Code's Compare with… does: the ladder (`CI on the checked-out
     * branch, else main (default)`), the default branch and each branch with runs, a run by its id, and the developer's
     * own runs only; `current` marks the choice in force.
     */
    fun baselineEntries(run: RunStatus?): List<BaselineEntry> {
        val current = run?.baseline?.choice ?: BaselineChoice("ladder")
        val known = run?.branches.orEmpty()
        val branches = if (current.kind == "branch" && current.branch != null && current.branch !in known) known + current.branch else known
        val ladder = BaselineChoice("ladder")
        val local = BaselineChoice("local")
        fun same(choice: BaselineChoice) = choice.kind == current.kind && choice.branch == current.branch && choice.runId == current.runId
        return listOf(
            BaselineEntry(
                "CI on the checked-out branch, else ${known.firstOrNull() ?: "the default branch"} (default)",
                "The latest complete run of the branch, a CI run first, with your runs since laid over it",
                same(ladder),
                ladder,
            ),
        ) + branches.mapIndexed { i, branch ->
            val choice = BaselineChoice("branch", branch = branch)
            val default = if (i == 0 && known.firstOrNull() == branch) "The default branch: its" else "The"
            BaselineEntry(branch, "$default latest complete run, a CI run first", same(choice), choice)
        } + listOf(
            BaselineEntry(
                if (current.kind == "run") "A run by id… (now run #${current.runId})" else "A run by id…",
                "One run of the project, with the runs of its branch since",
                current.kind == "run",
                null,
            ),
            BaselineEntry("My local runs only", "Your runs on this machine, in the desktop app or an editor, without CI", same(local), local),
        )
    }

    /** A baseline as `PiwiLocalSettings` keeps it per root: `local`, `branch:<name>`, `run:<id>`; the ladder is none. */
    fun encodeBaseline(choice: BaselineChoice): String? = when (choice.kind) {
        "local" -> "local"
        "branch" -> choice.branch?.let { "branch:$it" }
        "run" -> choice.runId?.let { "run:$it" }
        else -> null
    }

    /** A baseline `PiwiLocalSettings` keeps; null for the ladder or a value it cannot read. */
    fun decodeBaseline(text: String?): BaselineChoice? = when {
        text == "local" -> BaselineChoice("local")
        text?.startsWith("branch:") == true -> text.removePrefix("branch:").ifBlank { null }?.let { BaselineChoice("branch", branch = it) }
        text?.startsWith("run:") == true -> text.removePrefix("run:").toIntOrNull()?.takeIf { it > 0 }?.let { BaselineChoice("run", runId = it) }
        else -> null
    }

    /** What **Run this test** runs for a failure: its test, from the Playwright config it belongs to. */
    fun failureRunArgs(failure: WorkspaceFailure): RunTestsArgs? {
        val uri = failure.uri ?: return null
        val id = failure.testCaseId ?: return null
        return RunTestsArgs(uri, listOf(id), root = failure.root)
    }

    /**
     * The Playwright config folder a file (a `file:` URI) belongs to among the status's contexts: the deepest that holds
     * it, else the connected one.
     */
    fun contextRootOf(status: StatusResult?, uri: String?): String? {
        val contexts = status?.contexts.orEmpty()
        val path = uri?.let { runCatching { java.nio.file.Path.of(java.net.URI(it)) }.getOrNull() }
        val holding = contexts.mapNotNull { c -> c.root?.takeIf { root -> path != null && path.startsWith(java.nio.file.Path.of(root)) } }
        return holding.maxByOrNull { it.length } ?: contexts.firstOrNull { it.connected }?.root
    }

    /**
     * The runs as the files show them: without the run in progress, the stream and the time of the last read, which
     * move while the latest run and its failures stay. The files are drawn again when it changes.
     */
    fun runsInFiles(runs: RunStatusResult?): RunStatusResult? =
        runs?.copy(contexts = runs.contexts?.map { it.copy(live = null, stream = null, updatedAt = null) })

    /**
     * `piwi/fileSummary` answers by file URI, each for one state of the file's text (`stamp`) and one count of the changes
     * the service pushed (`pushed`): the gutter and Code Vision of one highlighting pass share one request. An answer
     * older than `ttlMillis`, or one that failed, is asked for again; past `max` files, all are.
     */
    class SummaryCache(private val ttlMillis: Long, private val max: Int) {
        private class Entry(val stamp: Long, val pushed: Long, val at: Long, val answer: CompletableFuture<FileSummary?>)

        private val entries = ConcurrentHashMap<String, Entry>()

        fun get(uri: String, stamp: Long, pushed: Long, now: Long, ask: () -> CompletableFuture<FileSummary?>): CompletableFuture<FileSummary?> {
            entries[uri]
                ?.takeIf { it.stamp == stamp && it.pushed == pushed && now - it.at < ttlMillis && !it.answer.isCompletedExceptionally }
                ?.let { return it.answer }
            if (entries.size >= max) entries.clear()
            return ask().also { entries[uri] = Entry(stamp, pushed, now, it) }
        }

        fun clear() = entries.clear()
    }

    /** Which open files a change of the runs draws again: none, those whose tests show a result, or every file Piwi reads. */
    enum class Redraw { NONE, TESTS, ALL }

    /**
     * What a change of the runs from `before` to `after` draws again: nothing when only the run in progress moved
     * ([runsInFiles]); the files whose tests show a result when only the tests of the run in progress began or ended
     * (`liveTests`), which only a test's line shows; every file Piwi reads when anything else the files show changed,
     * such as the latest run or its baseline.
     */
    fun redraw(before: RunStatusResult?, after: RunStatusResult?): Redraw {
        val shownBefore = runsInFiles(before)
        val shownAfter = runsInFiles(after)
        return when {
            shownBefore == shownAfter -> Redraw.NONE
            withoutLiveTests(shownBefore) == withoutLiveTests(shownAfter) -> Redraw.TESTS
            else -> Redraw.ALL
        }
    }

    private fun withoutLiveTests(runs: RunStatusResult?): RunStatusResult? =
        runs?.copy(contexts = runs.contexts?.map { it.copy(liveTests = null) })

    /** On the ladder, when the checked-out branch has no run yet and another branch's is shown: which one, and why. */
    fun fallbackNote(run: RunStatus?): String {
        val checkedOut = run?.checkedOut ?: return ""
        if (run.branch == checkedOut) return ""
        if (run.baseline?.choice?.kind.let { it != null && it != "ladder" }) return ""
        return " ($checkedOut has no run yet)"
    }

    /**
     * What a coverage mark says of its lines: the tests ran them, no test runs them, they changed since the run, or, in
     * a file no test reaches, they changed since the default branch.
     */
    enum class CoverageKind { RUN, NOT_RUN, CHANGED, UNCOVERED }

    /** A coverage mark over lines `start` to `end` (0-based, inclusive) and its tooltip in the scroll bar. */
    data class CoverageMark(val kind: CoverageKind, val start: Int, val end: Int, val tooltip: String)

    /**
     * Whether a `piwi/coverage` answer marks lines: coverage was recorded on the file as it stands, or placed on it, or
     * the file has uncovered changes.
     */
    fun hasCoverageMarks(result: CoverageResult?): Boolean =
        result?.state == "exact" || result?.state == "mapped" || !result?.uncovered.isNullOrEmpty()

    /** What the coverage marks mean, in the colors the dashboard marks them in by default; the service's hover says it too. */
    const val COVERAGE_MARKS_EXPLAINED = "The bar at the left of a line: teal, a test ran it; slate, it is executable " +
        "and no test runs it; dashed amber, it changed since the coverage run."

    /** What the mark of an uncovered change means; the service's hover says it too. */
    const val UNCOVERED_EXPLAINED =
        "The orange bar at the left of a line: it changed since the default branch, and no test reaches this file."

    /** A coverage mark's tooltip, in the gutter and the scroll bar: what it says of its lines, then what the marks mean. */
    fun coverageMarkTooltip(mark: CoverageMark): String {
        val explained = if (mark.kind == CoverageKind.UNCOVERED) UNCOVERED_EXPLAINED else COVERAGE_MARKS_EXPLAINED
        return "<html>${mark.tooltip}<br>$explained</html>"
    }

    /**
     * The marks to draw for a file's `piwi/coverage` answer within its `lineCount` lines: none while they are hidden,
     * and none for a file with neither line coverage nor uncovered changes.
     */
    fun coverageMarks(result: CoverageResult?, lineCount: Int, shown: Boolean): List<CoverageMark> {
        if (!shown || result == null || !hasCoverageMarks(result)) return emptyList()
        fun marks(spans: List<LineSpan>?, kind: CoverageKind, tooltip: (LineSpan) -> String) = spans.orEmpty()
            .filter { it.start in 0 until lineCount && it.end >= it.start }
            .map { CoverageMark(kind, it.start, minOf(it.end, lineCount - 1), tooltip(it)) }
        return marks(result.executed, CoverageKind.RUN) { "Piwi: run by ${plural(it.tests ?: 0, "test")}" } +
            marks(result.notRun, CoverageKind.NOT_RUN) {
                if (it.start == it.end) "Piwi: no test runs this line" else "Piwi: no test runs these lines"
            } +
            marks(result.changed, CoverageKind.CHANGED) { "Piwi: changed since the coverage run" } +
            marks(result.uncovered, CoverageKind.UNCOVERED) {
                "Piwi: uncovered change: ${escapeHtml(result.label ?: "no test reaches this file")}"
            }
    }

    /** The coverage marks to take off a file, and those to draw on it, each once. */
    data class CoverageMarksDiff(val remove: List<CoverageMark>, val add: List<CoverageMark>)

    /**
     * What turns the marks `drawn` on a file into its `marks`: a mark is kept while one of the same kind, lines and
     * tooltip is wanted, so only the marks that changed are taken off or drawn.
     */
    fun coverageMarksDiff(drawn: Set<CoverageMark>, marks: List<CoverageMark>): CoverageMarksDiff {
        val wanted = marks.toSet()
        return CoverageMarksDiff(remove = drawn.filter { it !in wanted }, add = wanted.filter { it !in drawn })
    }

    /** `text` as HTML text: the IDE renders a tooltip as HTML, and the instance's text is never markup. */
    fun escapeHtml(text: String): String = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** A plain-text tooltip, one line per `\n`, as the HTML the IDE renders a tooltip as. */
    fun htmlTooltip(text: String): String = "<html>${escapeHtml(text).replace("\n", "<br>")}</html>"

    /** A test's gutter tooltip: the summary the service writes, its latest result naming the run first, as HTML text. */
    fun testResultTooltip(title: String?): String =
        "<html>${escapeHtml(listOfNotNull("Piwi", title?.ifBlank { null }).joinToString(": "))}</html>"

    /** When a run the editor started says what it changed: `always`, `failures` (only when something fails), `never`. */
    val RUN_NOTIFICATIONS = listOf("always", "failures", "never")

    /**
     * Whose runs say what they changed (`PiwiLocalSettings.runNotificationsScope`, VS Code's
     * `piwi.runNotificationsScope`): `mineAndCi`, the editor's own and the branch's CI runs; `mine`, the editor's own.
     */
    val RUN_NOTIFICATION_SCOPES = listOf("mineAndCi", "mine")

    /**
     * Which failures turn the status item to its alarm, its text in the error color (`PiwiLocalSettings.statusBarAlert`,
     * `EditorCredentials.statusBarAlert`, VS Code's `piwi.statusBarAlert`), as the service decides it (`RunStatus.alarm`).
     */
    val STATUS_BAR_ALERTS = listOf("new", "any", "never")

    /**
     * The severity of a failure's diagnostic (`EditorCredentials.failureSeverity`): `error`, `warning`, `information`,
     * or `off`, which leaves the failures to the tool window and the gutter.
     */
    val FAILURE_SEVERITIES = listOf("error", "warning", "information", "off")

    /**
     * How the agent signs in to Piwi's MCP server (`EditorCredentials.mcpAuthorization`): `key`, with the IDE's key, or
     * `sign-in`, through the instance's OAuth, for a token of its own.
     */
    val MCP_AUTHORIZATIONS = listOf("key", "sign-in")

    /** What the copied MCP configuration holds, for the person pasting it: the key, or no key and the sign-in. */
    fun mcpAuthorizationNote(servers: List<McpServerDefinition>): String = when {
        servers.any { it.authorization == "key" } -> "It holds your API key: keep it out of the repository."
        servers.any { it.authorization == "sign-in" } ->
            "It holds no key: the first time the agent connects, it opens the instance in your browser to sign in."
        else -> ""
    }

    const val OPEN_FAILURES = "Open the failures"
    const val OPEN_IN_DASHBOARD = "Open in dashboard"
    const val RERUN_FAILING = "Re-run failing"

    /** The action of a passing run's notice that keeps the next ones for runs that fail (`runNotifications`). */
    const val ONLY_ON_FAILURE = "Only on failure"

    /** The confirmation once Only on failure is chosen. */
    const val ONLY_ON_FAILURE_SET =
        "A run's notice now comes only when a test fails; a verification still says how it went (Settings → Tools → Piwi)."

    /**
     * A run's verdict: a warning when something fails, its balloon's title, which names the run so two runs' balloons
     * read apart (`Piwi: run #124`, `Piwi: CI run #130 on feature-x`), its sentence, and the actions it offers.
     */
    data class RunVerdict(val warning: Boolean, val title: String, val text: String, val actions: List<String>)

    /**
     * What a run changed, once it ended, in the service's words (`RunEnded.verdict`): `1 of 3 CI failures fixed, 2
     * still failing (login.spec.ts › logs in, checkout.spec.ts › pays)`; a warning with the service's actions when
     * something fails, and **Only on failure** when nothing does while `setting` is `always`. Null when `setting` keeps
     * it quiet, or for a CI run of the branch when `scope` is `mine`; a run of each test several times says how its
     * runs went whatever the setting.
     */
    fun runVerdict(ended: RunEnded, setting: String = "always", scope: String = "mineAndCi"): RunVerdict? {
        val words = ended.verdict ?: return null
        if (ended.origin == "ci" && scope == "mine") return null
        if (!words.always && (setting == "never" || (setting == "failures" && !words.failing))) return null
        val actions = words.actions.mapNotNull { VERDICT_ACTIONS[it] }
        val onlyOnFailure = if (!words.always && !words.failing && setting == "always") listOf(ONLY_ON_FAILURE) else emptyList()
        return RunVerdict(words.failing, "Piwi: ${words.title}", words.text, actions + onlyOnFailure)
    }

    /** The labels of a verdict's actions, by the service's ids (`RunEnded.verdict.actions`). */
    private val VERDICT_ACTIONS = mapOf("failures" to OPEN_FAILURES, "dashboard" to OPEN_IN_DASHBOARD, "rerun" to RERUN_FAILING)

    /** Where the service found the instance, in the words of the settings page. */
    fun sourceLabel(source: String?): String = when (source) {
        "environment" -> "the environment (PIWI_DASHBOARD_URL)"
        "dotenv" -> "the workspace .env"
        "desktop" -> "the Piwi desktop app"
        else -> "Settings → Tools → Piwi"
    }

    /**
     * The instance the environment or a workspace `.env` names, which comes before the one the settings page saves: its
     * address, its project while it is the one read, where it comes from (`sourceLabel`), the config it is named for when
     * the project has several (`label`), and whether the desktop app is read before it.
     */
    data class Overriding(
        val serverUrl: String,
        val project: String?,
        val source: String,
        val label: String? = null,
        val desktopFirst: Boolean = false,
    )

    /**
     * What overrides the settings page's instance, `saved`, from the status: the first config whose environment or `.env`
     * names another; null when none does, or before the service starts.
     */
    fun overriding(status: StatusResult?, saved: String): Overriding? {
        val contexts = status?.contexts.orEmpty()
        for (c in contexts) {
            val source = c.instance?.source ?: c.source
            if (source != "environment" && source != "dotenv") continue
            val url = c.instance?.serverUrl ?: c.serverUrl ?: continue
            if (normalizeServerUrl(url) == normalizeServerUrl(saved)) continue
            return Overriding(
                url,
                c.projectName.takeIf { c.source == source && c.connected },
                sourceLabel(source),
                c.label.takeIf { contexts.size > 1 },
                c.source == "desktop",
            )
        }
        return null
    }

    /** What the settings page says above its instance's fields while `overriding` names another one. */
    fun overriddenText(overriding: Overriding): String {
        val of = overriding.label?.let { " for $it" } ?: ""
        val project = overriding.project?.let { ", project $it" } ?: ""
        return if (overriding.desktopFirst) {
            "${overriding.source.replaceFirstChar { it.uppercase() }} names ${overriding.serverUrl}$of, which Piwi reads " +
                "before the server URL below while the desktop app is not in use."
        } else {
            "Overridden by ${overriding.source}$of: Piwi reads ${overriding.serverUrl}$project, not the server URL below."
        }
    }

    /**
     * The Piwi tool window's one line: the connection, short, a link to the settings (its sentence in the tooltip),
     * and the baseline, a link to Compare with…; the run is the tree's own node.
     */
    data class ToolWindowHeader(val connection: String, val tooltip: String, val baseline: String?)

    fun toolWindowHeader(
        status: StatusResult?,
        result: FailuresResult?,
        desktopChosen: Boolean = false,
        startProblem: String? = null,
        trusted: Boolean = true,
        stopped: Boolean = false,
    ): ToolWindowHeader {
        val summary = connectionSummary(status, desktopChosen, startProblem, trusted, stopped)
        val contexts = status?.contexts.orEmpty()
        val connected = contexts.filter { it.connected }
        val short = when {
            connected.isEmpty() -> null
            contexts.size > 1 -> "${connected.size} of ${contexts.size} Playwright configs connected"
                .takeIf { connected.size < contexts.size } ?: "${contexts.size} Playwright configs"
            else -> connected[0].let { c -> (c.projectName ?: "Piwi") + (c.branch?.let { " on $it" } ?: "") }
        }
        // The desktop app's hint stays in sight: it says what Connect can switch to.
        val connection = short?.let { s -> desktopHint(status, desktopChosen).ifEmpty { null }?.let { "$s. $it" } ?: s } ?: summary
        return ToolWindowHeader(connection, summary, baselineLine(result?.baseline?.label)?.let { "$it ▾" })
    }

    /**
     * Whether the status popup offers Open the latest run: not when a row of it already opens the page of the run in
     * progress that the action would open (`pageIds`, the run pages the popup lists), whatever host each page names.
     */
    fun latestRunOffered(live: LiveRun?, pageIds: Collection<Int>): Boolean = live == null || live.runId !in pageIds

    /**
     * One sentence on the connection, for the tool window and the settings page; with no status, why: the project waits
     * for trust, the service cannot start, it stopped (`stopped`), or it has not started yet.
     */
    fun connectionSummary(
        status: StatusResult?,
        desktopChosen: Boolean = false,
        startProblem: String? = null,
        trusted: Boolean = true,
        stopped: Boolean = false,
    ): String {
        if (status == null && !trusted) return WAITING_FOR_TRUST
        if (status == null) return startProblem ?: if (stopped) NOT_RUNNING else NOT_STARTED
        val contexts = status.contexts.orEmpty()
        if (contexts.isEmpty()) return "No Playwright config found in this project."
        val hint = desktopHint(status, desktopChosen).let { if (it.isEmpty()) "" else " $it" }
        val unreachable = contexts.firstOrNull { it.problemKind == "unreachable" }
        val unproven = contexts.firstOrNull { it.problemKind == "desktop-unproven" }
        val c = contexts.firstOrNull { it.connected }
            ?: return if (unreachable != null) {
                "Not connected. ${unreachable.problem ?: ""} Piwi reads it again on its own.$hint"
            } else if (unproven != null) {
                "Not connected. " + (unproven.problem ?: "") + hint
            } else {
                "Not connected. " + (contexts.first().problem ?: "") + hint
            }
        val branch = c.branch?.let { " on $it" } ?: ""
        return "Connected to ${c.projectName ?: "Piwi"}$branch at ${c.serverUrl}, from ${sourceLabel(c.source)}.$hint"
    }

    /**
     * A sentence on the desktop app when it is not in use: it runs and Connect can switch to it,
     * or it was chosen and does not run. Empty otherwise.
     */
    fun desktopHint(status: StatusResult?, desktopChosen: Boolean): String = when {
        status == null || status.contexts.orEmpty().any { it.source == "desktop" } -> ""
        status.desktopUrl != null -> "The Piwi desktop app runs on this machine: Connect to use it."
        desktopChosen -> "The Piwi desktop app, chosen with Connect, is not running."
        else -> ""
    }

    /**
     * The end of a tinted line's range: past its line break, so the editor paints the background to its right edge as it
     * does a whole line's; the line's own end on the last line, which has none.
     */
    fun lineEndWithBreak(lineEnd: Int, textLength: Int): Int = if (lineEnd < textLength) lineEnd + 1 else lineEnd

    /** What every action that needs the editor service says while it is not running in the project, and how to start it. */
    const val SERVICE_NOT_RUNNING =
        "The Piwi editor service is not running in this project: open one of its test files, or Tools → Piwi → Restart the editor service."

    /** What an action says when the running service did not answer it: the request failed, or took too long. */
    const val SERVICE_NO_ANSWER =
        "The Piwi editor service did not answer in time, or the request failed: Tools → Piwi → Open the log shows it."

    /** What an action that needs an instance says while none is connected, beside **Connect…**. */
    const val CONNECT_FIRST = "Connect to an instance first."

    /** What Restart the editor service says with no service running and no test file open: the IDE starts it for one. */
    const val SERVICE_NEEDS_A_FILE = "The Piwi editor service starts for a test file: open one of this project's."

    /** What the tool window says once the editor service that ran stopped, and nothing started it again. */
    const val SERVICE_STOPPED = "The Piwi editor service stopped."

    /** What a message that the service does not run or did not answer offers: Restart the editor service and Open the log. */
    val SERVICE_FIXES = listOf(EmptyLink.RESTART_SERVICE, EmptyLink.OPEN_LOG)

    /** Whether a message says the service does not run or did not answer: its balloon offers [SERVICE_FIXES]. */
    fun offersServiceFixes(message: String): Boolean = SERVICE_NOT_RUNNING in message || SERVICE_NO_ANSWER in message

    /** The tool window's text while no service answers: why, and the links that start it or show its log. */
    fun serviceDownText(trusted: Boolean, startProblem: String?, stopped: Boolean): EmptyText = when {
        !trusted -> EmptyText(WAITING_FOR_TRUST)
        startProblem != null -> EmptyText(startProblem, listOf(EmptyLink.OPEN_LOG))
        stopped -> EmptyText(SERVICE_STOPPED, SERVICE_FIXES)
        else -> EmptyText(NOT_STARTED)
    }

    /** The Piwi tool window's tab that holds the editor service's log, which **Open the log** opens. */
    const val LOG_TAB = "Log"

    /** How many lines the log keeps: the oldest go first. */
    const val LOG_LINES = 5_000

    /** How long a failed request of one method stays out of the log once one was written there. */
    const val LOG_REPEAT_MILLIS = 60_000L

    private val LOG_TIME = java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss.SSS")

    /**
     * The log's lines for `text` written at `at`: its first line after the time, the others indented under it, the blank
     * lines at its end left out. Text that starts indented continues the line before it, as each line of a stack the
     * service writes to stderr arrives on its own: it takes no time.
     */
    fun logLines(at: java.time.LocalTime, text: String): List<String> {
        val lines = text.lines().dropLastWhile { it.isBlank() }.ifEmpty { return emptyList() }
        val time = at.format(LOG_TIME)
        val indent = " ".repeat(time.length + 1)
        val continues = lines.first().firstOrNull()?.isWhitespace() == true
        return lines.mapIndexed { i, line -> if (i == 0 && !continues) "$time $line" else "$indent$line" }
    }

    /**
     * The log's lines, the oldest dropped past `max`, and when a failed request of each method was last written, so the
     * daemon's repeated failures write one line a minute. Not thread-safe: `PiwiLog` holds its lock around it.
     */
    class LogBuffer(private val max: Int = LOG_LINES) {
        private val lines = ArrayDeque<String>()
        private val failures = HashMap<String, Long>()

        fun add(added: List<String>) {
            lines.addAll(added)
            while (lines.size > max) lines.removeFirst()
        }

        fun lines(): List<String> = lines.toList()

        /** Whether a failure of `method` at `now` is written: none of that method was within [LOG_REPEAT_MILLIS]. */
        fun writesFailure(method: String, now: Long): Boolean {
            val last = failures[method]
            if (last != null && now - last < LOG_REPEAT_MILLIS) return false
            failures[method] = now
            return true
        }
    }

    /** An action the Piwi tool window's empty text links, by its id. */
    enum class EmptyLink(val label: String, val actionId: String) {
        RESTART_SERVICE("Restart the editor service", "Piwi.RestartService"),
        OPEN_LOG("Open the log", "Piwi.OpenLog"),
        CONNECT("Connect…", "Piwi.Connect"),
        RETRY("Retry", "Piwi.Refresh"),
        SETTINGS("Settings…", "Piwi.OpenSettings"),
        COMPARE("Compare with…", "Piwi.CompareWith"),
    }

    /** What the Piwi tool window says with no failure to list, and the actions it links. */
    data class EmptyText(val text: String, val links: List<EmptyLink> = emptyList())

    /**
     * The tool window's empty text, from the state the service says the view is in (`view`), in its words: an instance
     * that does not answer, with Retry and Settings…; a desktop app that did not prove its token; an instance still
     * being read; no run yet, or none for the baseline chosen (`baselineNoRun`), with Compare with…; no connection,
     * with Connect…; else no failure in the run read (`runId`).
     */
    fun failuresEmpty(view: FailuresView?, baselineNoRun: String?, runId: Int?): EmptyText = when (view?.state) {
        "disconnected" -> EmptyText(view.message ?: "Not connected to a Piwi instance", listOf(EmptyLink.CONNECT))
        "loading" -> EmptyText(view.message ?: "Piwi is reading the instance…")
        "unreachable" -> EmptyText(view.message ?: "The instance does not answer.", listOf(EmptyLink.RETRY, EmptyLink.SETTINGS))
        "desktop-unproven" -> EmptyText(view.message ?: "Restart or update the desktop app.", listOf(EmptyLink.RETRY))
        "norun" -> EmptyText(baselineNoRun ?: view.message ?: "No run of this branch yet.", listOf(EmptyLink.COMPARE))
        else -> EmptyText(
            when {
                baselineNoRun != null -> baselineNoRun
                runId != null -> "No failure in run #$runId"
                else -> "No failure in the latest run"
            },
        )
    }

    /** What Disconnect says when nothing is saved to forget. */
    const val NOTHING_SAVED = "Nothing is saved in the settings: the connection in use comes from elsewhere, or there is none."

    /** What Test connection says when the field holds no http(s) URL. */
    const val TEST_CONNECTION_NO_URL = "Type an http(s) URL first, such as https://piwi.example.com."

    /** What Test connection says of an address that answered, before it is saved: and whether it asks for a key. */
    fun testConnectionText(url: String, needsKey: Boolean): String =
        if (needsKey) "$url answers. It asks for an API key: Connect… signs in or takes one."
        else "$url answers, and lists its projects without a key."

    /** What Test connection says of an address it could not use, in Connect's words. */
    fun testConnectionFailure(url: String, reason: String): String = "Could not connect to $url: $reason"

    /**
     * Why Connect could not reach an instance, one sentence per kind of failure, `{name}` standing for a value: the
     * editor service's table, `packages/editor/src/connect-failures.json`, which the VS Code extension reads and
     * `GlueTest` holds this copy to.
     */
    val CONNECT_FAILURE_WORDS: Map<String, String> = linkedMapOf(
        "refused-key" to "the instance refused the key ({status})",
        "not-piwi" to "not a Piwi instance: nothing answers Piwi's requests at this address (404)",
        "not-piwi-page" to "not a Piwi instance: the address answers with a page, not Piwi's requests",
        "status" to "the instance answered {status}",
        "untrusted" to "{client} does not trust the certificate of {host}. {trust}",
        "expired" to "the certificate of {host} has expired",
        "not-yet-valid" to "the certificate of {host} is not valid yet: check this machine's clock",
        "other-name" to "the certificate of {host} names another address: use the address it was issued for",
        "not-https" to "{host} does not answer HTTPS there: try http://",
        "timeout" to "no answer within {seconds} seconds",
        "no-answer" to "no answer in time",
        "nothing-listening" to "nothing answers there. Is the instance running, on that port?",
        "unknown-host" to "unknown host {host}",
        "lookup-failed" to "the name {host} could not be looked up now: is this machine online?",
    )

    /** How long Connect waits to connect to an instance, then for its answer, in seconds (`PiwiConnect`). */
    const val CONNECT_TIMEOUT_S = 10
    const val ANSWER_TIMEOUT_S = 15

    /** The sentence of `kind` in [CONNECT_FAILURE_WORDS], each `{name}` replaced by its value. */
    fun connectFailureWords(kind: String, vararg values: Pair<String, Any>): String {
        val named = values.toMap()
        return Regex("""\{(\w+)\}""").replace(CONNECT_FAILURE_WORDS.getValue(kind)) { m ->
            named[m.groupValues[1]]?.toString() ?: m.value
        }
    }

    /**
     * Why Connect could not reach `url`, in [CONNECT_FAILURE_WORDS]' words: `status` is the HTTP status the instance
     * answered, if any. A certificate the IDE does not trust names the host and where to trust it, whatever exception
     * carries it; one expired, not valid yet or for another name says so; any other TLS failure gives its own message.
     */
    fun connectFailure(e: Throwable, status: Int?, url: String?): String {
        val host = url?.let { runCatching { java.net.URI(it).host }.getOrNull() } ?: "the instance"
        val chain = generateSequence(e) { it.cause }.take(10).toList()
        val says = { text: String -> chain.any { it.message.orEmpty().contains(text, ignoreCase = true) } }
        return when {
            status == 401 || status == 403 -> connectFailureWords("refused-key", "status" to status)
            status == 404 -> connectFailureWords("not-piwi")
            status != null -> connectFailureWords("status", "status" to status)
            chain.any { it is com.google.gson.JsonParseException } -> connectFailureWords("not-piwi-page")
            chain.any { it is java.security.cert.CertificateExpiredException } -> connectFailureWords("expired", "host" to host)
            chain.any { it is java.security.cert.CertificateNotYetValidException } ->
                connectFailureWords("not-yet-valid", "host" to host)
            says("No subject alternative") || says("No name matching") -> connectFailureWords("other-name", "host" to host)
            chain.any { it is java.security.cert.CertificateException } || says("PKIX path") ->
                connectFailureWords(
                    "untrusted",
                    "client" to "the IDE",
                    "host" to host,
                    "trust" to "Add it, or your company's root certificate, in Settings → Tools → Server Certificates",
                )
            says("Unsupported or unrecognized SSL message") -> connectFailureWords("not-https", "host" to host)
            chain.any { it is java.net.http.HttpConnectTimeoutException } -> connectFailureWords("timeout", "seconds" to CONNECT_TIMEOUT_S)
            chain.any { it is java.net.http.HttpTimeoutException } -> connectFailureWords("timeout", "seconds" to ANSWER_TIMEOUT_S)
            chain.any { it is java.net.ConnectException } -> connectFailureWords("nothing-listening")
            chain.any { it is java.net.UnknownHostException } ->
                connectFailureWords("unknown-host", "host" to (chain.first { it is java.net.UnknownHostException }.message ?: host))
            else -> e.message ?: e.javaClass.simpleName
        }
    }

    /** What Disconnect asks before forgetting the saved connection; null when nothing is saved. */
    fun disconnectQuestion(serverUrl: String, project: String, desktop: Boolean = false): String? {
        val parts = buildList {
            if (serverUrl.isNotBlank()) add("$serverUrl, the project, and the API key saved for it")
            else if (project.isNotBlank()) add("the project $project saved for the desktop app")
            if (desktop) add("the choice of the desktop app")
        }
        return if (parts.isEmpty()) null else "Forget ${parts.joinToString(", and ")}?"
    }

    enum class ConnectTarget { DESKTOP, INSTANCE, OTHER }

    /** A connection Connect offers when the desktop app runs. */
    data class ConnectChoice(val target: ConnectTarget, val label: String, val detail: String, val serverUrl: String?, val inUse: Boolean)

    /**
     * What Connect offers when the desktop app runs: the app, the instance the environment, the
     * `.env` or the settings name (the app does not replace it: either is one choice away), and
     * another instance.
     */
    fun connectChoices(status: StatusResult?, desktop: DesktopResult, savedUrl: String): List<ConnectChoice> {
        val contexts = status?.contexts.orEmpty()
        val context = contexts.firstOrNull { it.connected } ?: contexts.firstOrNull()
        val usesDesktop = context?.source == "desktop"
        val choices = mutableListOf(
            ConnectChoice(
                ConnectTarget.DESKTOP,
                "The Piwi desktop app, at ${desktop.url}",
                desktop.linked?.let { "Runs on this machine; this folder is linked there to the project ${it.name}." }
                    ?: "Runs on this machine: no address or key needed.",
                null,
                usesDesktop,
            ),
        )
        val named = context?.instance?.serverUrl?.let { it to context.instance.source }
            ?: normalizeServerUrl(savedUrl)?.let { it to "editor" }
        if (named != null && named.first != desktop.url) {
            val (url, source) = named
            choices += ConnectChoice(ConnectTarget.INSTANCE, url, "From ${sourceLabel(source)}.", url, !usesDesktop && context?.serverUrl == url)
        }
        choices += ConnectChoice(ConnectTarget.OTHER, "Another instance…", "A Piwi server, by its address.", null, false)
        return choices
    }

    /** The desktop app's discovery file: its address, its token, and the folders linked to its projects. */
    data class DesktopDiscovery(val url: String, val token: String, val links: List<Pair<Int, String>>)

    /** Where the desktop app publishes its discovery file while it runs: `PIWI_DESKTOP_CONFIG`, else `~/.piwi/desktop.json`. */
    fun desktopConfigPath(env: Map<String, String>, home: String?): Path? =
        env["PIWI_DESKTOP_CONFIG"]?.takeIf { it.isNotBlank() }?.let { Path.of(it) }
            ?: home?.let { Path.of(it, ".piwi", "desktop.json") }

    /**
     * A live editor service's hub for Piwi Picker, as `GET /api/piwi/live` lists it: the WebSocket's address and token,
     * and the service (`LiveHub` in `@piwitests/core/run-hub`). The run channel its file also names is never listed.
     */
    data class LiveHub(
        val url: String,
        val token: String,
        val pid: Long,
        val version: String,
        val client: String?,
        val roots: List<String>,
        val startedAt: String,
    )

    /** Where the editor services publish their discovery files: `PIWI_EDITORS_DIR`, else `~/.piwi/editors`. */
    fun editorsDir(env: Map<String, String>, home: String?): Path? =
        env["PIWI_EDITORS_DIR"]?.takeIf { it.isNotBlank() }?.let { runCatching { Path.of(it) }.getOrNull() }
            ?: home?.let { Path.of(it, ".piwi", "editors") }

    private val DISCOVERY_NAME = Regex("^([1-9]\\d{0,9})\\.json$")
    private val HUB_URL = Regex("^ws://127\\.0\\.0\\.1:\\d{1,5}/[\\w/-]{0,64}$")
    private val HUB_TOKEN = Regex("^[A-Za-z0-9_-]{16,256}$")

    /** An editor service's discovery file: the process and the machine it names, and its hub, null when it names none. */
    data class EditorDiscovery(val pid: Long, val host: String, val hub: LiveHub?)

    /**
     * An editor service's discovery file (`<pid>.json`), as `parseEditorDiscovery` in `@piwitests/core/editor-discovery`
     * reads it; null when it is not one. Its hub is null when it names none this machine serves.
     */
    fun parseEditorDiscovery(text: String?): EditorDiscovery? {
        val json = runCatching { JsonParser.parseString(text ?: return null) as? JsonObject }.getOrNull() ?: return null
        fun string(o: JsonObject?, key: String, max: Int) = o?.get(key)
            ?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
            ?.takeIf { it.isNotEmpty() && it.length <= max && !it.contains('\u0000') }
        val named = json.get("pid")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble ?: return null
        if (named < 1 || named > Long.MAX_VALUE.toDouble() || named != Math.floor(named)) return null
        val pid = named.toLong()
        val host = string(json, "host", 255) ?: ""
        val hub = json.get("hub") as? JsonObject
        val url = string(hub, "url", 200)?.takeIf { HUB_URL.matches(it) }
        val token = string(hub, "token", 256)?.takeIf { HUB_TOKEN.matches(it) }
        if (url == null || token == null) return EditorDiscovery(pid, host, null)
        val roots = (json.get("roots") as? JsonArray)?.take(64)?.mapNotNull { root ->
            root.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
                ?.takeIf { it.isNotEmpty() && it.length <= 4096 && !it.contains('\u0000') }
        }.orEmpty()
        val live = LiveHub(
            url = url,
            token = token,
            pid = pid,
            version = string(json, "version", 64) ?: "",
            client = string(json, "client", 200),
            roots = roots,
            startedAt = string(json, "startedAt", 64) ?: "",
        )
        return EditorDiscovery(pid, host, live)
    }

    /** The hub of an editor service's discovery file; null when the file names no hub, or another process than `pid`. */
    fun parseLiveHub(text: String?, pid: Long): LiveHub? = parseEditorDiscovery(text)?.takeIf { it.pid == pid }?.hub

    private val OTHERS_ACCESS = setOf(
        PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_WRITE, PosixFilePermission.GROUP_EXECUTE,
        PosixFilePermission.OTHERS_READ, PosixFilePermission.OTHERS_WRITE, PosixFilePermission.OTHERS_EXECUTE,
    )

    /** The user this process runs as, where the file system names owners (POSIX); null elsewhere. */
    private val currentUser: UserPrincipal? by lazy {
        runCatching {
            FileSystems.getDefault().userPrincipalLookupService.lookupPrincipalByName(System.getProperty("user.name"))
        }.getOrNull()
    }

    /**
     * Whether `path` is, not through a link, a folder (`folder`) this user owns that no other user can enter, or a
     * file this user owns. Where the file system names no owners (Windows), whether it is such a folder or file.
     */
    private fun ownEntry(path: Path, folder: Boolean): Boolean {
        val posix = runCatching {
            Files.readAttributes(path, PosixFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrNull()
        if (posix == null) {
            val basic = runCatching {
                Files.readAttributes(path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            }.getOrNull() ?: return false
            return if (folder) basic.isDirectory else basic.isRegularFile
        }
        if (if (folder) !posix.isDirectory else !posix.isRegularFile) return false
        if (posix.owner() != (currentUser ?: return false)) return false
        return !folder || posix.permissions().none { it in OTHERS_ACCESS }
    }

    /**
     * The hubs of the editor services whose discovery files `dir` holds and whose process runs, oldest first, as
     * `readLiveEditors` in `@piwitests/core/editor-discovery` lists them: nothing from a folder that is a link,
     * another user's or one other users can enter; only the files this user owns are read; a file that reads as a
     * service's file of `host` (this machine, in any case) naming the process its name names is deleted when that
     * process is gone; any other file, another machine's included, is skipped and left as it is.
     */
    fun liveHubs(dir: Path?, host: String, alive: (Long) -> Boolean): List<LiveHub> {
        if (dir == null || !ownEntry(dir, folder = true)) return emptyList()
        val names = runCatching { Files.list(dir).use { entries -> entries.map { it.fileName.toString() }.toList() } }
            .getOrNull().orEmpty()
        return names.mapNotNull { name ->
            val pid = DISCOVERY_NAME.find(name)?.groupValues?.get(1)?.toLongOrNull() ?: return@mapNotNull null
            val file = dir.resolve(name)
            if (!ownEntry(file, folder = false)) return@mapNotNull null
            val discovery = parseEditorDiscovery(runCatching { Files.readString(file) }.getOrNull())
            if (discovery?.pid != pid || !discovery.host.equals(host, ignoreCase = true)) return@mapNotNull null
            if (!alive(pid)) {
                runCatching { Files.deleteIfExists(file) }
                return@mapNotNull null
            }
            discovery.hub
        }.sortedWith(compareBy<LiveHub>({ it.startedAt }, { it.pid }))
    }

    /**
     * This machine's name, as the editor service writes it in its discovery file (Node's `os.hostname()`, the
     * system's `gethostname`): the kernel's on Linux, else what `hostname` prints. Read once, off the event thread.
     */
    val machineName: String by lazy {
        runCatching { Files.readString(Path.of("/proc/sys/kernel/hostname")).trim() }.getOrNull()?.ifEmpty { null }
            ?: runCatching {
                val process = ProcessBuilder("hostname").redirectErrorStream(true).start()
                val out = process.inputStream.bufferedReader().readText().trim()
                if (process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) && process.exitValue() == 0) out else null
            }.getOrNull()?.ifEmpty { null }
            ?: runCatching { java.net.InetAddress.getLocalHost().hostName }.getOrNull()
            ?: ""
    }

    /** The running desktop app, from its discovery file's text; null when it is not one. */
    fun parseDesktopDiscovery(text: String?): DesktopDiscovery? {
        val json = runCatching { JsonParser.parseString(text ?: return null) as? JsonObject }.getOrNull() ?: return null
        fun string(o: JsonObject, key: String) =
            o.get(key)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString?.ifBlank { null }
        val url = string(json, "url") ?: return null
        val token = string(json, "token") ?: return null
        val links = (json.get("projects") as? JsonArray)?.mapNotNull { entry ->
            val link = entry as? JsonObject ?: return@mapNotNull null
            val id = link.get("id")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asInt ?: return@mapNotNull null
            string(link, "path")?.let { id to it }
        }.orEmpty()
        return DesktopDiscovery(url.trimEnd('/'), token, links)
    }

    /**
     * The project the desktop app links to a folder: the linked folder that holds `dir`, or one
     * inside it; the deepest wins.
     */
    fun linkedDesktopProject(links: List<Pair<Int, String>>, dir: Path?): Int? {
        val folder = dir?.toAbsolutePath()?.normalize() ?: return null
        return links
            .filter { (_, path) ->
                val linked = runCatching { Path.of(path).toAbsolutePath().normalize() }.getOrNull()
                linked != null && (folder.startsWith(linked) || linked.startsWith(folder))
            }
            .maxByOrNull { it.second.length }
            ?.first
    }

    /** An instance URL as it is stored: trimmed, without trailing slashes; null when it is not an http(s) URL. */
    fun normalizeServerUrl(input: String?): String? {
        val url = input?.trim()?.trimEnd('/') ?: return null
        return url.takeIf { it.matches(Regex("^https?://[^\\s/]+\\S*$")) }
    }

    private val LOOPBACK_URL = Regex("^(https?://)(localhost|127\\.0\\.0\\.1|\\[::1])(?=[:/?#]|$)", RegexOption.IGNORE_CASE)

    /** Whether an instance URL names this machine: `localhost`, `127.0.0.1` or `[::1]`. */
    fun isLoopback(url: String): Boolean = LOOPBACK_URL.containsMatchIn(url)

    /**
     * The addresses to try for an instance URL: the URL, then, for one on this machine, the same URL
     * on the other loopback addresses. A server started on `localhost` may listen on `::1` only, or on
     * `127.0.0.1` only, whichever the system named first.
     */
    fun loopbackAlternatives(url: String): List<String> {
        val match = LOOPBACK_URL.find(url) ?: return listOf(url)
        val rest = url.substring(match.range.last + 1)
        return (listOf(url) + listOf("127.0.0.1", "[::1]").map { match.groupValues[1] + it + rest }).distinct()
    }

    /**
     * The password-safe entry of an instance's API key. The key is kept per instance: a
     * project's settings, which a repository may commit, never select another instance's key.
     */
    fun apiKeyEntry(serverUrl: String): String = "apiKey ${normalizeServerUrl(serverUrl) ?: serverUrl.trim()}"

    private fun jsonString(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\""

    /**
     * The `mcp-remote` release an `mcpServers` entry runs, exactly: `npx` with no version runs whatever npm serves that
     * day, with the key or the token in its environment. 0.1.16 and later carry the fix for CVE-2025-6514.
     */
    const val MCP_REMOTE = "mcp-remote@0.14.3"

    /**
     * An `mcpServers` entry per instance, bridged to stdio with `mcp-remote` so every
     * MCP client takes it (the JetBrains AI Assistant's settings, Junie, Claude Desktop).
     * The key travels in `env`, never on the command line.
     */
    fun mcpConfiguration(servers: List<McpServerDefinition>): String {
        val entries = servers.mapIndexed { i, s ->
            mcpEntry(if (i == 0) "piwi" else "piwi-${i + 1}", s.url ?: "", s.headers?.get("Authorization"), "PIWI_AUTH")
        }
        return "{\n  \"mcpServers\": {\n${entries.joinToString(",\n")}\n  }\n}"
    }

    /**
     * An `mcpServers` entry bridged to stdio with `mcp-remote` (`MCP_REMOTE`), over streamable HTTP alone, its
     * `Authorization` header in the variable `variable`.
     */
    private fun mcpEntry(name: String, url: String, auth: String?, variable: String): String {
        val args = mutableListOf("\"-y\"", jsonString(MCP_REMOTE), jsonString(url), "\"--transport\"", "\"http-only\"")
        if (auth != null) args += listOf("\"--header\"", "\"Authorization:\${$variable}\"")
        val env = if (auth != null) ",\n      \"env\": { \"$variable\": ${jsonString(auth)} }" else ""
        return "    ${jsonString(name)}: {\n      \"command\": \"npx\",\n      \"args\": [${args.joinToString(", ")}]$env\n    }"
    }

    /**
     * The `mcpServers` entry of the MCP server the editor service serves this project's runs to agents with, bridged as
     * the instance's: its bearer token in `env`, never on the command line. The address and the token stay while the
     * project keeps them (`PiwiLocalSettings.agentsPort`, the password safe).
     */
    fun runsMcpConfiguration(url: String, token: String): String =
        "{\n  \"mcpServers\": {\n${mcpEntry("piwi-runs", url, "Bearer $token", "PIWI_RUNS_AUTH")}\n  }\n}"

    /**
     * The `mcpServers` entry of type `http` that Claude Code and Cursor read: the runs' server, with no bridge, its token
     * as a bearer header.
     */
    fun runsMcpHttpConfiguration(url: String, token: String): String =
        "{\n  \"mcpServers\": {\n    \"piwi-runs\": {\n      \"type\": \"http\",\n      \"url\": ${jsonString(url)},\n" +
            "      \"headers\": { \"Authorization\": ${jsonString("Bearer $token")} }\n    }\n  }\n}"

    /**
     * The password safe's name for the runs' MCP server's token of a project (`Project.getLocationHash`): each project
     * keeps its own, so a new token in one leaves the agents of another connected.
     */
    fun agentsTokenEntry(project: String): String = "agentsToken $project"

    /**
     * A script file named in a line of a run's output: the characters `[start, end)` that name it, its path as written,
     * relative to the run's folder, and its 1-based line and column.
     */
    data class FileLink(val start: Int, val end: Int, val path: String, val line: Int, val column: Int?)

    private val FILE_LINK = Regex("""(?<![\w./\\@~+:-])((?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?""")

    /**
     * The script files a line of a run's output names by a path relative to the run's folder, at a line, as Playwright's
     * reporters print them (`[chromium] › tests/login.spec.ts:12:5 › signs in`). Absolute paths are left out: the IDE's
     * console links them already.
     */
    fun fileLinks(line: String): List<FileLink> = FILE_LINK.findAll(line).mapNotNull { match ->
        val number = match.groupValues[2].toIntOrNull()?.takeIf { it > 0 } ?: return@mapNotNull null
        FileLink(match.range.first, match.range.last + 1, match.groupValues[1], number, match.groupValues[3].toIntOrNull()?.takeIf { it > 0 })
    }.toList()

    /** A test file among a run's arguments, with its line and column: `tests/a.spec.ts:3`. */
    private val TEST_FILE_ARG = Regex("[^-\\s][^\\s]*\\.[cm]?[jt]sx?(:\\d+){0,2}")

    /**
     * The arguments of an `npx playwright test …` command, for the IDE's Playwright runner; null for any other command,
     * a chain of several (`… && …`, [chained]) included.
     */
    fun playwrightTestArgs(command: String): List<String>? {
        val parts = splitCommand(command)
        return if (parts.take(3) == listOf("npx", "playwright", "test") && CHAIN !in parts) parts.drop(3) else null
    }

    /** What joins the commands of a chain: a fix plan's verification of several Playwright projects. */
    private const val CHAIN = "&&"

    /** Whether a command chains several (`a && b`): a shell runs it, each one only once the one before it passed. */
    fun chained(command: String): Boolean = CHAIN in splitCommand(command)

    /**
     * A run's Run tab or run configuration name with who started it when a person did not (`RunCommand.label`), as the
     * VS Code extension names its task: `Piwi: a.spec.ts · Started by Claude Code`.
     */
    fun labeledRunName(name: String, label: String?): String = if (label.isNullOrBlank()) name else "$name · $label"

    /** The name of the IDE's run configuration for a run: its first test file (with its line), and how many more. */
    fun playwrightRunName(args: List<String>): String {
        val targets = args.filter { TEST_FILE_ARG.matches(it) }
        val first = targets.firstOrNull()?.substringAfterLast('/') ?: return "Piwi"
        return if (targets.size > 1) "Piwi: $first and ${targets.size - 1} more" else "Piwi: $first"
    }

    /**
     * The title of a run's tab in the Run tool window, after what it runs: the first test file of a `playwright test` and
     * how many more ([playwrightRunName], a chain's included), else the command up to its first option, the reporter's
     * package named as its command (`Piwi: piwi flake verify 12`).
     */
    fun runTabName(command: String): String {
        val parts = splitCommand(command)
        val words = parts.drop(if (parts.firstOrNull() == "npx") 1 else 0)
        if (words.take(2) == listOf("playwright", "test")) return playwrightRunName(words.drop(2))
        val tool = words
            .map { if (it == "@piwitests/reporter") "piwi" else it }
            .takeWhile { !it.startsWith("-") }
            .take(4)
            .joinToString(" ")
        return if (tool.isEmpty()) "Piwi" else "Piwi: $tool"
    }

    /** The command line that runs a shell command string, split as a shell would for plain words and quotes. */
    fun splitCommand(command: String): List<String> {
        val out = mutableListOf<String>()
        val current = StringBuilder()
        var quote: Char? = null
        var inWord = false
        for (c in command) {
            when {
                quote != null && c == quote -> quote = null
                quote != null -> current.append(c)
                c == '"' || c == '\'' -> { quote = c; inWord = true }
                c.isWhitespace() -> if (inWord) { out += current.toString(); current.clear(); inWord = false }
                else -> { current.append(c); inWord = true }
            }
        }
        if (inWord) out += current.toString()
        return out
    }

    /**
     * What Piwi Picker sends: a locator line, or a steps document for the editor service to render. A locator picked
     * while a run was paused at a breakpoint names its place (`at`): a file relative to the run, and its 1-based line.
     */
    sealed class SendPayload {
        data class Locator(val text: String, val at: SendPlace? = null) : SendPayload()
        data class Steps(val steps: com.google.gson.JsonObject) : SendPayload()
        data class Refused(val error: String) : SendPayload()
    }

    data class SendPlace(val file: String, val line: Int)

    /**
     * An open project a pick may go to: the folders a run's paths start from (its Playwright configs' folders) and the
     * files its runs are stopped in now, as paths.
     */
    data class PickCandidate<P>(val project: P, val roots: List<String>, val stoppedFiles: List<String>)

    /**
     * The project a pick at `at` goes to, the run's: the project a run is stopped in the file `at` names (relative to
     * one of its roots), else the project holding that file (`exists`), else the focused one. Among several, the
     * focused one, else the first. Without `at`, the focused project.
     */
    fun <P> pickProject(at: SendPlace?, candidates: List<PickCandidate<P>>, focused: P?, exists: (String) -> Boolean): P? {
        if (at == null) return focused
        fun named(candidate: PickCandidate<P>) = candidate.roots.mapNotNull { root ->
            runCatching { Path.of(root).resolve(at.file).normalize() }.getOrNull()
        }
        fun preferred(matching: List<PickCandidate<P>>) =
            (matching.firstOrNull { it.project == focused } ?: matching.firstOrNull())?.project
        val stopped = candidates.filter { candidate ->
            val stops = candidate.stoppedFiles.mapNotNull { runCatching { Path.of(it).normalize() }.getOrNull() }
            named(candidate).any { it in stops }
        }
        if (stopped.isNotEmpty()) return preferred(stopped)
        val holding = candidates.filter { candidate -> named(candidate).any { exists(it.toString()) } }
        return preferred(holding) ?: focused
    }

    const val MAX_SEND_TEXT = 4000
    const val MAX_SEND_BYTES = 2_000_000

    /** Whether `file` is a relative path that stays inside the directory it is relative to. */
    private fun isInsidePath(file: String): Boolean {
        if (file.isEmpty() || file.length > 1000 || file.contains('\u0000')) return false
        if (file.startsWith("/") || file.startsWith("\\") || Regex("^[A-Za-z]:").containsMatchIn(file)) return false
        return file.split('/', '\\').none { it == ".." }
    }

    /** The place of a picked locator, as `parseSendPayload` in `@piwitests/core/editor-send` validates it. */
    private fun parseSendPlace(at: com.google.gson.JsonElement?): Any? {
        if (at == null || at.isJsonNull) return null
        val obj = at.takeIf { it.isJsonObject }?.asJsonObject
        val file = obj?.get("file")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        if (file == null || !isInsidePath(file)) return SendPayload.Refused("at.file must be a path relative to the run, without ..")
        val line = obj.get("line")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble
        if (line == null || line < 1 || line != Math.floor(line)) return SendPayload.Refused("at.line must be a positive integer")
        return SendPlace(file, line.toInt())
    }

    /** Validate a request body, as `parseSendPayload` in `@piwitests/core/editor-send` does. */
    fun parseSendPayload(body: String): SendPayload {
        val json = try {
            com.google.gson.JsonParser.parseString(body)
        } catch (_: Exception) {
            return SendPayload.Refused("the body must be JSON")
        }
        if (!json.isJsonObject) return SendPayload.Refused("the body must be a JSON object")
        val obj = json.asJsonObject
        val kind = obj.get("kind")?.takeIf { it.isJsonPrimitive }?.asString
        return when (kind) {
            "locator" -> {
                val text = obj.get("text")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
                when {
                    text.isNullOrBlank() -> SendPayload.Refused("text must be a non-empty string")
                    text.length > MAX_SEND_TEXT -> SendPayload.Refused("text is at most $MAX_SEND_TEXT characters")
                    else -> when (val at = parseSendPlace(obj.get("at"))) {
                        is SendPayload.Refused -> at
                        is SendPlace -> SendPayload.Locator(text, at)
                        else -> SendPayload.Locator(text)
                    }
                }
            }
            "steps" -> obj.get("steps")?.takeIf { it.isJsonObject }?.let { SendPayload.Steps(it.asJsonObject) }
                ?: SendPayload.Refused("steps must be a steps document")
            else -> SendPayload.Refused("kind must be 'locator' or 'steps'")
        }
    }

    /**
     * Where a locator picked at a breakpoint went: on its line, or elsewhere because the line or the file holds none,
     * the editor service does not run, or it did not answer.
     */
    enum class PickOutcome { REPLACED, NO_LOCATOR, NO_FILE, NOT_RUNNING, NO_ANSWER }

    /**
     * What the notification says once a locator picked while a run was paused at a breakpoint reached the IDE: where it
     * went, at the caret or, with `scratch`, in a new scratch file, and why when not on its line.
     */
    fun pickNotice(at: SendPlace, outcome: PickOutcome, scratch: Boolean = false): String {
        val name = at.file.substringAfterLast('/')
        val went = if (scratch) "The picked locator was inserted in a new scratch file" else "The picked locator was inserted at the caret"
        return when (outcome) {
            PickOutcome.REPLACED -> "The picked locator replaced the one at line ${at.line} of $name."
            PickOutcome.NO_LOCATOR -> "$went: line ${at.line} of $name holds no locator anymore."
            PickOutcome.NO_FILE -> "$went: ${at.file} is not in this project."
            PickOutcome.NOT_RUNNING -> "$went. $SERVICE_NOT_RUNNING"
            PickOutcome.NO_ANSWER -> "$went: the Piwi editor service did not answer."
        }
    }

    /** The names of this machine, which the service reaches directly whatever the proxy: the desktop app listens on them. */
    private val LOOPBACK_NAMES = listOf("localhost", "127.0.0.1", "::1")

    /**
     * The environment that takes the service through the IDE's HTTP proxy at `host`:`port`: `HTTPS_PROXY` and
     * `HTTP_PROXY` naming it, and `NO_PROXY` with this machine's names and
     * `exceptions`, the hosts the IDE reaches directly, a `*.example.com` pattern as the `.example.com` suffix Node
     * matches.
     */
    fun proxyEnvironment(host: String, port: Int, exceptions: List<String>): Map<String, String> {
        val name = host.trim().let { if (':' in it && !it.startsWith("[")) "[$it]" else it }
        val proxy = "http://$name:$port"
        val direct = exceptions.map { it.trim() }.filter { it.isNotEmpty() }.map { if (it.startsWith("*.")) it.substring(1) else it }
        return linkedMapOf(
            "HTTPS_PROXY" to proxy,
            "HTTP_PROXY" to proxy,
            "NO_PROXY" to (LOOPBACK_NAMES + direct).distinct().joinToString(","),
        )
    }

    /** A line breakpoint of the IDE: its file's path on disk, its 0-based line and the breakpoint, which a move keeps. */
    data class BreakpointAt(val path: String, val line: Int, val key: Any? = null)

    /** One of the IDE's breakpoints a run pauses at: its place as the service takes it, and the IDE's breakpoint. */
    data class RunBreakpoint(val place: EditorBreakpoint, val key: Any? = null)

    private val SCRIPT_FILE = Regex("\\.[cm]?[jt]sx?$", RegexOption.IGNORE_CASE)

    /**
     * The breakpoints a run started from Piwi pauses at: those in JavaScript or TypeScript files under one of `roots`
     * (the Playwright configs' folders), as the service takes them.
     */
    fun runBreakpoints(breakpoints: List<BreakpointAt>, roots: List<String>): List<RunBreakpoint> {
        val rootPaths = roots.mapNotNull { runCatching { Path.of(it).toAbsolutePath().normalize() }.getOrNull() }
        return breakpoints.mapNotNull { b ->
            val file = runCatching { Path.of(b.path).toAbsolutePath().normalize() }.getOrNull() ?: return@mapNotNull null
            val under = rootPaths.any { root -> file != root && file.startsWith(root) }
            if (b.line < 0 || !SCRIPT_FILE.containsMatchIn(file.fileName?.toString() ?: "") || !under) null
            else RunBreakpoint(EditorBreakpoint(file.toUri().toString(), b.line), b.key)
        }
    }

    /**
     * A change of a document's lines: its old lines `start` to `oldEnd` became the lines `start` to `newEnd`. `first`
     * says the new first line goes on the old first one (text before the change stayed on it), `last` that the new last
     * line goes on the old last one (text after the change stayed on it).
     */
    data class LineEdit(val start: Int, val oldEnd: Int, val newEnd: Int, val first: Boolean, val last: Boolean)

    /**
     * The lines a change moves, from where it started (`startLine`, `startColumn`) to the line it ended on (`endLine`)
     * in the text before, putting `text` there; null for a change within one line. `lineAfter` reads a line of the
     * document after the change: the text that stayed around it tells which old lines go on.
     */
    fun lineEdit(startLine: Int, startColumn: Int, endLine: Int, text: CharSequence, lineAfter: (Int) -> String?): LineEdit? {
        val added = text.count { it == '\n' }
        if (added == 0 && startLine == endLine) return null
        val newEnd = startLine + added
        // Where the text after the change starts on the new last line.
        val after = if (added > 0) text.length - text.lastIndexOf('\n') - 1 else startColumn + text.length
        return LineEdit(
            startLine,
            endLine,
            newEnd,
            first = lineAfter(startLine)?.take(startColumn)?.isNotBlank() == true,
            last = lineAfter(newEnd)?.let { if (after < it.length) it.substring(after) else "" }?.isNotBlank() == true,
        )
    }

    private fun forwardLine(edit: LineEdit, line: Int): Int = when {
        line < edit.start -> line
        line > edit.oldEnd -> line + edit.newEnd - edit.oldEnd
        line == edit.start && edit.first -> edit.start
        line == edit.oldEnd && edit.last -> edit.newEnd
        else -> edit.start
    }

    private fun backLine(edit: LineEdit, line: Int): Int? = when {
        line < edit.start -> line
        line > edit.newEnd -> line - edit.newEnd + edit.oldEnd
        line == edit.start && edit.first -> edit.start
        line == edit.newEnd && edit.last -> edit.oldEnd
        else -> null
    }

    /** What names a file in the edits: its normalized path, which two spellings of its URI share. */
    fun fileKey(uri: String?): String? = uri?.let { runCatching { Path.of(java.net.URI(it)).normalize().toString() }.getOrNull() ?: it }

    /**
     * The edits that moved the documents' lines, in order, while a run is live: a run's code is the documents as they
     * stood when it started (`now`), and a line goes between it and a document as it stands through the edits since.
     * Not thread-safe: its owner guards it.
     */
    class EditLog {
        private var at = 0
        private val edits = HashMap<String, MutableList<Pair<Int, LineEdit>>>()

        /** Where the log stands: a run that starts now maps its lines from here. */
        fun now(): Int = at

        fun add(file: String, edit: LineEdit) {
            edits.getOrPut(file) { mutableListOf() } += ++at to edit
        }

        /** A line of the file as it stood at `since`, as it stands now: where its text went, when it was removed. */
        fun forward(file: String?, line: Int, since: Int): Int =
            file?.let { edits[it] }.orEmpty().fold(line) { moved, (at, edit) -> if (at > since) forwardLine(edit, moved) else moved }

        /** A line of the file as it stands, as it stood at `since`; null for a line made since or an edit leaves unclear. */
        fun back(file: String?, line: Int, since: Int): Int? {
            var found = line
            for ((at, edit) in file?.let { edits[it] }.orEmpty().asReversed()) {
                if (at <= since) break
                found = backLine(edit, found) ?: return null
            }
            return found
        }

        /** Drop the edits made before `since`, the start of the oldest run kept; all of them with no run. */
        fun forget(since: Int) {
            edits.values.forEach { list -> list.removeAll { it.first <= since } }
            edits.values.removeAll { it.isEmpty() }
        }
    }

    /** The sessions kept, by ref, once `session` is heard: the latest of each run, one that ended dropped. */
    fun withSession(sessions: Map<String, RunSession>, session: RunSession): Map<String, RunSession> {
        val ref = session.ref ?: return sessions
        return if (session.ended) sessions - ref else sessions + (ref to session)
    }

    /**
     * A worker stopped: its run, the worker, where it stands, the test it runs, what its reporter takes there, whether
     * its run was started in a terminal (`RunSession.terminal`), and of those by the IDE's own test runner
     * (`RunSession.runner`), and its slot (`RunWorker.parallelIndex`, which the worker Playwright starts in its place
     * after a failure keeps).
     */
    data class ShownStop(
        val ref: String,
        val worker: Int,
        val stop: RunStop,
        val test: RunTest?,
        val takes: List<String> = emptyList(),
        val terminal: Boolean = false,
        val runner: Boolean = false,
        val slot: Int = worker,
        /** Its reporter brings the test's window to the front (`RunWorker.showsWindow`). */
        val showsWindow: Boolean = false,
        /** The commit of the throwaway checkout a desktop app's job runs in (`RunSession.checkout`). */
        val checkout: String? = null,
    )

    /** Every stopped worker of the sessions, in their order. */
    fun stopsOf(sessions: Map<String, RunSession>): List<ShownStop> = sessions.values.flatMap { session ->
        session.workers.orEmpty().mapNotNull { w ->
            w.stop?.let {
                ShownStop(
                    session.ref ?: "",
                    w.worker,
                    it,
                    w.test,
                    w.takes.orEmpty(),
                    session.terminal,
                    session.terminal && session.runner,
                    w.parallelIndex,
                    w.showsWindow,
                    session.checkout?.commit,
                )
            }
        }
    }

    /** What tells a stop from another: its run, its worker and when it stopped. */
    fun stopKey(stop: ShownStop): String = "${stop.ref}\u0000${stop.worker}\u0000${stop.stop.since}"

    /** The stops that call for the person's attention as the service says (`RunStop.calls`), each once (`attended`, the last 200). */
    fun attentionStops(stops: List<ShownStop>, attended: LinkedHashSet<String>): List<ShownStop> {
        val due = stops.filter { it.stop.calls && stopKey(it) !in attended }
        due.forEach { attended += stopKey(it) }
        while (attended.size > 200) attended.remove(attended.first())
        return due
    }

    /** What tells a worker's slot from another: its run and its slot. */
    private fun slotKey(ref: String, slot: Int): String = "$ref\u0000$slot"

    private fun slotKey(stop: ShownStop): String = slotKey(stop.ref, stop.slot)

    /** How long the Paused page tab and the focus wait for the next stop of a slot stepped or run to the caret. */
    const val RESERVED_MILLIS = 10_000L

    /**
     * How long after a control from the IDE answered a stop, until another stop of that slot opens or no worker of the
     * run holds the slot, a run action acts on no other slot's stop.
     */
    const val RESUMED_MILLIS = 2_000L

    /**
     * What a change of the stops shows: the stops new to the IDE, in order, each opening its file at its line in its
     * turn (`StopsShown.focusFor`, `StopsShown.opened`), and the stop whose page the Paused page tab opens (null leaves
     * the tab as it is).
     */
    data class StopsChange(val open: List<ShownStop>, val page: ShownStop?)

    /** The stop an action naming none acts on (`StopsShown.choose`): one, none, or the one the person chooses. */
    sealed interface StopChoice {
        data class One(val stop: ShownStop) : StopChoice

        data object Ask : StopChoice

        data object None : StopChoice
    }

    /**
     * Whether input sent to a stop's page is the person acting on it: a press, a click, a key, text or the wheel; a
     * pointer moving, or a button or key let go, is not.
     */
    fun actsOnPage(events: List<PageInput>): Boolean =
        events.any { it.type == "text" || it.type == "wheel" || (it.action != "move" && it.action != "up") }

    /**
     * Whether the Paused page tab keeps Interact on as it shows `stop`: Interact is on (`interacting`) for the stop of
     * the worker slot it showed (`shown`: a run's ref and a parallel index), Watch stays on, and the new stop of
     * that slot takes input on a live view.
     */
    fun keepsInteract(interacting: Boolean, shown: Pair<String, Int>?, stop: ShownStop, watchLive: Boolean): Boolean =
        interacting && watchLive && shown == (stop.ref to stop.slot) && "view" in stop.takes && "input" in stop.takes

    /**
     * Whether a new page selects the Paused page tab: unless the Worker tab is in sight, selected in a tool window that
     * shows.
     */
    fun selectsPausedPage(workerTabSelected: Boolean, windowVisible: Boolean): Boolean = !(workerTabSelected && windowVisible)

    /** What a control from the IDE records: the slot the person is on, a wait for a slot's next stop, the answer. */
    private enum class Recorded { FOLLOWED, RESERVED, ANSWER }

    /** A slot stepped or run to the caret, by `slotKey`, the stop stepped, by `stopKey`, and until when it waits. */
    private class Reserved(val slot: String, val key: String, val until: Long)

    /** A slot a control answered, by `slotKey`, the stop answered, by `stopKey`, and when. */
    private class Answer(val slot: String, val key: String, val at: Long)

    /** What an answer replaced, with when each changed, and when what it set changed, for a refusal to undo. */
    private class Answered(val was: HashMap<Recorded, Any?>, val wasStamps: HashMap<Recorded, Int>, val stamps: Map<Recorded, Int>)

    /**
     * What the IDE shows of the stops as they change, each stop once, and which stop a run action acts on.
     *
     * - A new stop opens its file at its line. It takes the focus, decided as it opens (`focusFor`), only as a stop of
     *   the slot the person is on, or while no other stop held had its file opened or left closed (`opened`, a tab
     *   closed since included). The slot the person is on is the one whose stop last took the focus, or that they last
     *   acted on: a control from the IDE (`answered`), a code action, or a press, a key, text, the wheel or a pick on
     *   the Paused page (`acted`, `actsOnPage`). Watching a slot in the Worker tab does not make it theirs.
     * - After a Step or a Run to caret from the IDE, until another stop of that slot opens, `RESERVED_MILLIS` at most
     *   and while a worker of the run holds the slot, no stop of another slot takes the focus, and the Paused page tab,
     *   once its own stop of that slot went on, waits for it (`waitsUntil`, when the IDE asks again). An answer the run
     *   refuses undoes what it recorded that nothing changed since (`refused`).
     * - The Paused page tab keeps the stop it shows (`view`) while that stop is held, a stop of the slot the Worker tab
     *   watches included; otherwise it opens the first new stop no pause bar shows, else the first such stop held. A
     *   tab that is closed opens the first new such stop.
     */
    class StopsShown {
        /** The stops heard, those whose file opened or was left closed, and those the person was shown, by `stopKey`. */
        private val heard = HashSet<String>()
        private val files = HashSet<String>()
        private val seen = HashSet<String>()
        private var held: Set<String> = emptySet()

        /** The stop the Paused page tab shows, or showed last; null while it is closed. */
        private var viewed: ShownStop? = null

        /**
         * What the controls and the person's acts recorded, each stamped as it changes: the slot the person is on
         * (`followed`, by `slotKey`), the slot stepped or run to the caret whose next stop the focus and the tab wait
         * for (`reserved`), and the slot a control answered last, until another of its stops opens (`answer`).
         */
        private val recorded = HashMap<Recorded, Any?>()
        private val stamps = HashMap<Recorded, Int>()
        private var changes = 0

        /** The answers sent and not settled, by token. */
        private val answers = LinkedHashMap<Int, Answered>()

        private var followed: String?
            get() = recorded[Recorded.FOLLOWED] as String?
            set(value) = record(Recorded.FOLLOWED, value)

        private var reserved: Reserved?
            get() = recorded[Recorded.RESERVED] as Reserved?
            set(value) = record(Recorded.RESERVED, value)

        private var answer: Answer?
            get() = recorded[Recorded.ANSWER] as Answer?
            set(value) = record(Recorded.ANSWER, value)

        private fun record(field: Recorded, value: Any?) {
            recorded[field] = value
            stamps[field] = ++changes
        }

        /** The sessions changed, with their stops held now at the lines they stand on (`stops`, in order). */
        fun changed(
            sessions: Map<String, RunSession>,
            stops: List<ShownStop>,
            now: Long = System.currentTimeMillis(),
        ): StopsChange {
            val slots = sessions.values.flatMap { s -> s.workers.orEmpty().map { slotKey(s.ref ?: "", it.parallelIndex) } }.toSet()
            if (reserved?.let { it.until <= now || it.slot !in slots } == true) reserved = null
            if (answer?.let { it.slot !in slots } == true) answer = null
            held = stops.map(::stopKey).toSet()
            heard.retainAll(held)
            files.retainAll(held)
            seen.retainAll(held)
            val open = stops.filter { stopKey(it) !in heard }
            open.forEach { heard.add(stopKey(it)) }
            val shown = viewed ?: return StopsChange(open, open.firstOrNull { !it.stop.bar })
            if (stopKey(shown) in held) return StopsChange(open, null)
            val waited = reserved?.takeIf { it.slot == slotKey(shown) }
            if (waited != null) {
                val next = stops.firstOrNull { slotKey(it) == waited.slot && stopKey(it) != waited.key } ?: return StopsChange(open, null)
                if (!next.stop.bar) return StopsChange(open, next)
            }
            return StopsChange(open, open.firstOrNull { !it.stop.bar } ?: stops.firstOrNull { !it.stop.bar })
        }

        /** The Paused page tab shows `stop`'s page; null once it is closed. */
        fun view(stop: ShownStop?) {
            viewed = stop
        }

        /** When the tab stops waiting for a slot's next stop, for `changed` to run then; null while it waits for none. */
        fun waitsUntil(): Long? = reserved?.until

        /** Whether `stop`'s file, opening now, takes the focus. */
        fun focusFor(stop: ShownStop, now: Long = System.currentTimeMillis()): Boolean {
            val slot = slotKey(stop)
            if (reserved?.let { it.until > now && it.slot != slot } == true) return false
            return slot == followed || files.all { it == stopKey(stop) }
        }

        /**
         * `stop`'s file opened, or was left closed while an editor is in use, with the focus or without it, in sight
         * (`shown`) or not. Another stop of the slot waited for ends the wait, as does a stop of another slot that took
         * the focus; another stop of the slot answered ends the moments after the answer.
         */
        fun opened(stop: ShownStop, focus: Boolean, shown: Boolean = true) {
            val key = stopKey(stop)
            if (key !in held) return
            files.add(key)
            if (shown) seen.add(key)
            if (reserved?.let { it.key != key && (focus || it.slot == slotKey(stop)) } == true) reserved = null
            if (answer?.let { it.key != key && it.slot == slotKey(stop) } == true) answer = null
            if (focus) followed = slotKey(stop)
        }

        /**
         * A control from the IDE answers `stop` (`action`), as it is sent: the person is on its slot, and after a Step
         * or a Run to caret the focus and the tab wait for its next stop. The token to settle the answer with
         * (`refused`, `taken`).
         */
        fun answered(stop: ShownStop, action: String, now: Long = System.currentTimeMillis()): Int {
            val slot = slotKey(stop)
            val was = HashMap(recorded)
            val wasStamps = HashMap(stamps)
            followed = slot
            answer = Answer(slot, stopKey(stop), now)
            reserved = if (action == "step" || action == "run-to") Reserved(slot, stopKey(stop), now + RESERVED_MILLIS) else null
            val token = ++changes
            answers[token] = Answered(was, wasStamps, HashMap(stamps))
            return token
        }

        /**
         * The run refused the answer `token` names (`ok: false`): of what it recorded, what nothing changed since goes
         * back to what it was, and what a later answer replaced is what that one puts back if refused. Whether anything
         * went back.
         */
        fun refused(token: Int): Boolean {
            val refused = answers.remove(token) ?: return false
            var undone = false
            for (field in Recorded.entries) {
                if (stamps[field] == refused.stamps[field]) {
                    recorded[field] = refused.was[field]
                    stamps[field] = refused.wasStamps[field] ?: 0
                    undone = true
                    continue
                }
                for (later in answers.values) {
                    if (later.wasStamps[field] != refused.stamps[field]) continue
                    later.was[field] = refused.was[field]
                    later.wasStamps[field] = refused.wasStamps[field] ?: 0
                }
            }
            return undone
        }

        /** The run took the answer `token` names, or its answer is unknown: what it recorded stays. */
        fun taken(token: Int) {
            answers.remove(token)
        }

        /**
         * The person acted on `stop` (a code action, or a press, a key, text, the wheel or a pick on its page): they
         * are on its slot, and a wait for another slot's next stop ends. Whether it ended one.
         */
        fun acted(stop: ShownStop): Boolean {
            followed = slotKey(stop)
            if (reserved?.let { it.slot != slotKey(stop) } != true) return false
            reserved = null
            return true
        }

        /**
         * The stop an action naming none acts on among `candidates` (those `stopsFor` gives for the caret at `line` of
         * `uri`). For a control (`control`) within `RESUMED_MILLIS` of an answer, until another stop of that slot
         * opens, only a stop of that slot, whatever the caret says. Else the one at the caret's line, else the only one
         * when the person was shown its file or its page, else the person chooses among them.
         */
        fun choose(candidates: List<ShownStop>, uri: String?, line: Int?, control: Boolean, now: Long = System.currentTimeMillis()): StopChoice {
            val answered = answer?.takeIf { control && now - it.at < RESUMED_MILLIS }
            if (answered != null) return candidates.firstOrNull { slotKey(it) == answered.slot }?.let { StopChoice.One(it) } ?: StopChoice.None
            val here = if (line == null) emptyList() else candidates.filter { stopIsAt(it, uri, line) }
            if (here.isNotEmpty()) return if (here.size == 1) StopChoice.One(here.single()) else StopChoice.Ask
            if (candidates.isEmpty()) return StopChoice.None
            val only = candidates.singleOrNull() ?: return StopChoice.Ask
            val shown = stopKey(only) in seen || viewed?.let { stopKey(it) } == stopKey(only)
            return if (shown) StopChoice.One(only) else StopChoice.Ask
        }
    }

    /**
     * The line above a stop: what is about to run, `Paused · Fill "MORNING10" getByLabel('Coupon code') · attempt 2`,
     * or, at a failure, how the test failed, `Held at its failure · Timed out 5000ms waiting for getByRole('button') ·
     * attempt 2`, in plain text: the gutter's icon marks the stop.
     */
    fun pausedText(stop: RunStop, test: RunTest?, terminal: Boolean = false, runner: Boolean = false, checkout: String? = null): String {
        val attempt = if (test != null && test.retry > 0) " · attempt ${test.retry + 1}" else ""
        // A run started in a terminal, or by the IDE's own test runner, says so: its process is theirs. So does a job the
        // desktop app runs in a throwaway checkout of a commit (`checkout`), whose code is offered to copy.
        val where = when {
            checkout != null -> " · the desktop app's reproduction at commit ${checkout.take(7)}, in a throwaway checkout"
            !terminal -> ""
            runner -> " · run by the editor's test runner"
            else -> " · run in a terminal"
        }
        if (isFailure(stop)) return "${stopWhy(stop)} · ${stop.title.orEmpty().removePrefix("Failed:").trimStart()}$attempt$where"
        return "${stopWhy(stop)} · ${stop.title.orEmpty()}$attempt$where"
    }

    /**
     * Why a stop's test stands there: a stop an agent asked for (its Pause, Step or Run to) says so, for the person
     * watching; else its reason's words (`RUN_STOP_WORDS`), a held failure's among them.
     */
    fun stopWhy(stop: RunStop): String = when {
        isFailure(stop) -> RUN_STOP_WORDS.getValue("failure")
        stop.by == "agent" -> "Paused by the agent"
        else -> stop.reason?.let { RUN_STOP_WORDS[it] } ?: RUN_STOP_WORDS.getValue("other")
    }

    /** What a stop says of why its test stands there, by its reason: the editor service's `RUN_STOP_WORDS`. */
    val RUN_STOP_WORDS = mapOf(
        "breakpoint" to "Stopped at a breakpoint",
        "step" to "Stopped after a step",
        "pause" to "Paused",
        "run-to" to "Stopped at the line it ran to",
        "page-pause" to "Stopped at page.pause()",
        "failure" to "Held at its failure",
        "other" to "Stopped",
    )

    /** Whether a token kept for the runs' MCP server is one the editor service takes: 32 to 256 characters of base64url. */
    fun isAgentsToken(token: String): Boolean = Regex("^[A-Za-z0-9_-]{32,256}$").matches(token)

    /** A new token for the runs' MCP server: 32 random bytes, base64url. */
    fun newAgentsToken(): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })

    /** The port of a loopback address the editor service names (`http://127.0.0.1:41234/mcp`); null for none. */
    fun portOf(url: String): Int? = runCatching { java.net.URI(url).port }.getOrNull()?.takeIf { it in 1..65535 }

    /** Whether a stop's browser can be shared with Playwright's own tools: its reporter takes `bind`. */
    fun canShare(stop: ShownStop): Boolean = "bind" in stop.takes

    /**
     * Whether a stop's window can come to the front (Show the browser): its pause bar shows, so its browser has a
     * window, and its reporter brings it forward.
     */
    fun canShowBrowser(stop: ShownStop): Boolean = stop.stop.bar && stop.showsWindow

    /** What sharing a stopped browser with Playwright's own tools risks, asked before it is shared. */
    const val SHARE_WARNING =
        "Until the test ends, any process of yours can then drive the stopped test's browser, read its pages and run " +
            "code in them (playwright-cli attach, Playwright's dashboard)."

    /** A run of the sessions its reporter can share live on the team instance, and how it stands there. */
    data class SharedRun(val ref: String, val live: RunLive)

    /** The runs of the sessions whose reporter shares them live, in their order. */
    fun sharedRunsOf(sessions: Map<String, RunSession>): List<SharedRun> =
        sessions.values.mapNotNull { s -> s.live?.let { live -> s.ref?.let { SharedRun(it, live) } } }

    /** The instance a run's page is on, as a sentence names it (its host); null without a page. */
    fun liveInstance(page: String?): String? =
        page?.let { runCatching { java.net.URI(it).authority }.getOrNull() }?.takeIf { it.isNotEmpty() }

    /** What Share live sends, and who sees it, asked before the project shares a run for the first time. */
    fun shareLiveWarning(page: String?, window: Boolean = false): String {
        val instance = liveInstance(page) ?: "the Piwi instance it reports to"
        val what = if (window) {
            "Each run this project follows from now on (those you start here, and those of a terminal it follows) is " +
                "shared until you stop or close the project. While a run"
        } else {
            "While this run"
        }
        return "$what is shared on $instance, anyone with its page open there sees each stop of its tests: " +
            "the call, its file and line, and the test's title, even while nobody watches. While someone watches a " +
            "worker, images of its test's page go there too, each with its call and the test's title. Anyone who can " +
            "open the run there can watch, and on an instance with authentication off, anyone who can reach it. " +
            "Nothing is stored, and Stop sharing ends it within seconds."
    }

    /**
     * A stop's or a share's status with how far the runs are after it, so neither hides the other:
     * `Piwi: paused · cart.spec.ts:12 · run #78 · 3 of 9`.
     */
    /**
     * The status bar item's text while runs are followed: the service's line, and, while a pausing test waits in a call,
     * how long it has (`waits in waitForResponse · 12 s`).
     */
    fun runLineText(line: RunLine, now: Long): String {
        val waited = line.since?.let { waitedFor(it, now) }
        return if (waited == null) line.text else "${line.text} · $waited"
    }

    /** How long a test has waited since `since`: `12 s`, `2 min 5 s`; null for a time it cannot read. */
    fun waitedFor(since: String, now: Long): String? {
        val began = runCatching { java.time.Instant.parse(since).toEpochMilli() }.getOrNull() ?: return null
        val seconds = maxOf(0L, (now - began) / 1000)
        return if (seconds < 60) "$seconds s" else "${seconds / 60} min ${seconds % 60} s"
    }

    /** The runs whose own process named their page on the instance, in their order: `Run #78` and the address. */
    fun runPages(sessions: Map<String, RunSession>): List<Pair<String, RunPage>> =
        sessions.values.mapNotNull { session -> session.page?.takeIf { it.id > 0 }?.let { (session.ref ?: "") to it } }

    /** A worker a Worker tab can watch while its test runs: its run, its worker and slot (`lane`), and its words. */
    data class WatchTarget(val ref: String, val worker: Int, val lane: Int, val label: String)

    /** What the worker in a slot is called: `Worker 2` for parallel index 1, as the service says it. */
    fun workerName(lane: Int): String = "Worker ${lane + 1}"

    /** The accessible name of the Paused Page tab's image, in the VS Code extension's words. */
    const val PAUSED_PAGE_NAME = "The page of the paused test"

    /** The accessible name of the Worker tab's image while it watches a worker of a run of this machine. */
    const val WORKER_PAGE_NAME = "The page of the worker's test"

    /** The accessible name of the Worker tab's image while it watches a CI run's worker. */
    const val CI_WORKER_PAGE_NAME = "The page of the CI worker's test"

    /** The running lines of the watched slots, by run and slot, with `line` heard: a line with no call goes. */
    fun withRunningLine(lines: Map<Pair<String, Int>, RunningLine>, line: RunningLine): Map<Pair<String, Int>, RunningLine> {
        val key = line.ref to line.lane
        return if (line.call == null) lines - key else lines + (key to line)
    }

    /**
     * The running lines to mark: each of a run still live whose slot's worker still runs that test and stands at no
     * stop, so a line goes as the test ends or stops and as the run ends, whatever the service says after.
     */
    fun runningLinesShown(lines: Map<Pair<String, Int>, RunningLine>, sessions: Map<String, RunSession>): List<RunningLine> =
        lines.values.filter { line ->
            val call = line.call ?: return@filter false
            val session = sessions[line.ref]?.takeIf { !it.ended } ?: return@filter false
            val worker = session.workers.orEmpty().firstOrNull { it.parallelIndex == line.lane } ?: return@filter false
            val test = worker.test ?: return@filter false
            worker.worker == line.worker && worker.stop == null && worker.state != "stopped" && (test.id == null || test.id == call.test)
        }

    /** The text after the running call's line: `Piwi: Worker 2 runs Click getByRole('button', { name: 'Pay' })`. */
    fun runningLineText(line: RunningLine): String =
        "Piwi: ${workerName(line.lane)} runs ${clipped(line.call?.title.orEmpty())}"

    /**
     * The Page tab of the Piwi tool window: what the page of the watched slot says, one line each, as the lane's events
     * carry them (its console errors and its uncaught errors), each test named before its first line. A watch of
     * another slot starts it anew ([watching]).
     */
    class PageOutput {
        private var slot: Pair<String, Int>? = null
        private var named: Pair<Int, String>? = null

        /** A watch of the slot `lane` of the run `ref` begins: its next test is named again. */
        fun watching(ref: String, lane: Int) {
            if (slot == ref to lane) return
            slot = ref to lane
            named = null
        }

        /**
         * A layer of the watched slot: the page's line it carries, after the name of its test (`test`, the slot's test
         * as the run's session says it, its title) when that test said nothing before.
         */
        fun layer(layer: LaneLayerFields, test: RunTest?): List<String> {
            if (layer.layer != "events") return emptyList()
            val event = layer.event ?: return emptyList()
            val text = when (event.kind) {
                "console" -> "Console error: ${event.text.orEmpty()}"
                "page-error" -> "Uncaught error: ${event.text.orEmpty()}"
                "dropped" -> "${event.count ?: 0} more events were not sent: too many at once."
                else -> return emptyList()
            }
            val id = layer.test ?: test?.id
            val worker = layer.worker ?: named?.first ?: 0
            val name = if (id == null || named == worker to id) {
                emptyList()
            } else {
                named = worker to id
                val title = test?.takeIf { it.id == id }?.title.orEmpty().joinToString(" › ").ifEmpty { id }
                listOf("${workerName(slot?.second ?: 0)} · $title")
            }
            return name + "  $text"
        }
    }

    /**
     * What each worker of the live runs runs now, one line each, by its lane: its test (`Worker 2 · cart › adds a mug`),
     * stopped there (`· stopped`), or between tests; each run's name before them when several run. Null while no worker
     * runs, as the VS Code extension's `workersNow` says it.
     */
    fun workersNowText(sessions: Map<String, RunSession>): String? {
        val live = sessions.values.filter { !it.ended && !it.workers.isNullOrEmpty() }
        val lines = live.flatMap { session ->
            session.workers.orEmpty().sortedBy { it.parallelIndex }.map { w ->
                val run = if (live.size > 1) "${runLabel(session)} · " else ""
                // A title's own line breaks as spaces: one line per worker.
                val test = w.test?.title?.joinToString(" › ")?.replace(Regex("\\s+"), " ")
                val what = if (test == null) "between tests" else if (w.state == "stopped") "$test · stopped" else test
                "$run${workerName(w.parallelIndex)} · $what"
            }
        }
        val shown = if (lines.size > MAX_WORKER_LINES) {
            lines.take(MAX_WORKER_LINES - 1) + "and ${lines.size - MAX_WORKER_LINES + 1} more workers"
        } else {
            lines
        }
        return shown.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }

    /** How many workers the tooltip lists, the last line counting the others. */
    private const val MAX_WORKER_LINES = 8

    /**
     * The workers of the live runs whose reporter shows their page while their test runs (`RunWorker.watchable`), in
     * their order; `pausable` keeps those a Pause can stop now (Pause and Watch).
     */
    fun watchableWorkers(sessions: Map<String, RunSession>, pausable: Boolean = false): List<WatchTarget> =
        sessions.values.flatMap { session ->
            session.workers.orEmpty()
                .filter { it.watchable && (!pausable || (it.state != "stopped" && !it.pausing && it.test?.cannotPause == null)) }
                .map { w ->
                    val title = w.test?.title.orEmpty().joinToString(" › ")
                    val doing = when {
                        w.test == null -> "between tests"
                        w.state == "stopped" -> "stopped in $title"
                        else -> "running $title"
                    }
                    WatchTarget(session.ref ?: "", w.worker, w.parallelIndex, "${workerName(w.parallelIndex)} · $doing")
                }
        }

    /** Names in a sentence: `A`, `A and B`, `A, B and C`. */
    private fun listed(names: List<String>): String =
        if (names.size < 2) names.firstOrNull().orEmpty() else "${names.dropLast(1).joinToString(", ")} and ${names.last()}"

    /**
     * Who else has a run open, in words: `Also open in Piwi Picker and the desktop app · An agent follows this run`;
     * null while no other tool has it open. This IDE's own entries (`self`) are left out.
     */
    fun presenceText(session: RunSession): String? {
        val others = session.presence.orEmpty().filter { !it.self }
        val open = others.filter { it.kind != "agent" }.map { it.name }.distinct()
        val parts = listOfNotNull(
            open.takeIf { it.isNotEmpty() }?.let { "Also open in ${listed(it)}" },
            "An agent follows this run".takeIf { others.any { it.kind == "agent" } },
        )
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /**
     * Who else has each run open (`presenceText`), one line a run, each named (`runLabel`) when there are several; null
     * while no other tool has one open.
     */
    fun runsPresenceText(sessions: Map<String, RunSession>): String? {
        val lines = sessions.values.mapNotNull { session ->
            presenceText(session)?.let { if (sessions.size > 1) "${runLabel(session)}: $it" else it }
        }
        return lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
    }

    /**
     * Who watches a worker's page now (`RunWorker.watchers`), in words: `Watched by Piwi Picker and you`, this IDE named
     * last as `you`; null while no other tool watches it.
     */
    fun watchersText(watchers: List<RunPresence>?): String? {
        val others = watchers.orEmpty().filter { !it.self }.map { it.name }.distinct()
        if (others.isEmpty()) return null
        return "Watched by ${listed(others + listOfNotNull("you".takeIf { watchers.orEmpty().any { it.self } }))}"
    }

    /**
     * Who drives a stop now (`RunStop.driver`), in words: `You drive this stop`, `Piwi Picker drives this stop`, `An
     * agent drives this stop`; with `interact` (the stop takes input), the agent's says that the person's input takes control.
     * Null while nobody drives it.
     */
    fun driverText(stop: RunStop, interact: Boolean = false): String? {
        val driver = stop.driver ?: return null
        if (driver.self) return "You drive this stop"
        val text = "${driver.name.replaceFirstChar { it.uppercaseChar() }} drives this stop"
        return if (driver.kind == "agent" && interact) "$text: your input takes control" else text
    }

    /** Who drives a stop and who else watches its worker's page, in words; null when nobody does. */
    private fun presentAt(stop: RunStop, takes: List<String>, worker: RunWorker?): String? =
        listOfNotNull(driverText(stop, "input" in takes), watchersText(worker?.watchers))
            .takeIf { it.isNotEmpty() }?.joinToString(" · ")

    /**
     * Who drives a stop and who else watches its worker's page, in words (`An agent drives this stop: Interact takes
     * control · Watched by Piwi Picker and you`); null when nobody does.
     */
    fun stopPresence(stop: ShownStop, sessions: Map<String, RunSession>): String? =
        presentAt(stop.stop, stop.takes, sessions[stop.ref]?.workers.orEmpty().firstOrNull { it.worker == stop.worker })

    /**
     * The Paused page tab's caption of a stop: what it runs and its place, then who drives it and who else watches its
     * worker's page (`Paused · Click getByRole('button') · cart.spec.ts:12 · An agent drives this stop: Interact takes
     * control · Watched by Piwi Picker and you`).
     */
    fun stopCaption(stop: ShownStop, sessions: Map<String, RunSession>): String =
        listOfNotNull(
            "${pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)} · ${stopPlace(stop.stop)}",
            stopPresence(stop, sessions),
        ).joinToString(" · ")

    /** What a Worker tab says of its slot: the worker there now, its stop, and the caption above the image. */
    data class LaneShown(val worker: RunWorker?, val stop: ShownStop?, val caption: String)

    /**
     * What the Worker tab watching the slot `lane` of a run shows above the image: the run ended, the slot's worker is
     * starting or between tests, its test runs (or a Pause reached it), or where it stopped, from `stops`; then who
     * drives its stop and who else watches its page.
     */
    fun laneShown(session: RunSession?, lane: Int, stops: List<ShownStop>): LaneShown {
        val name = workerName(lane)
        if (session == null || session.ended) return LaneShown(null, null, "$name · the run ended.")
        val worker = session.workers.orEmpty().firstOrNull { it.parallelIndex == lane }
            ?: return LaneShown(null, null, "$name · starting…")
        val seen = watchersText(worker.watchers)?.let { " · $it" }.orEmpty()
        val test = worker.test ?: return LaneShown(worker, null, "$name · between tests$seen")
        val title = test.title.orEmpty().joinToString(" › ")
        val stop = stops.firstOrNull { it.ref == session.ref && it.worker == worker.worker }
        if (stop == null && worker.pausing && worker.waiting != null) {
            return LaneShown(worker, null, "$name · Pausing · waits in ${worker.waiting.title} · $title$seen")
        }
        if (stop == null) return LaneShown(worker, null, "$name · ${if (worker.pausing) "Pausing" else "Running"} · $title$seen")
        val present = presentAt(stop.stop, stop.takes, worker)?.let { " · $it" }.orEmpty()
        return LaneShown(worker, stop, "$name · ${pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)} · ${stopPlace(stop.stop)}$present")
    }

    /** The first run of the sessions shared live, as the status bar's tooltip says it; null for none. */
    fun sharedLive(sessions: Map<String, RunSession>): RunLive? = sharedRunsOf(sessions).firstOrNull { it.live.shared }?.live

    /** How a run shared live stands, as the status bar's tooltip says it: where, and how many views of it are open. */
    fun sharedLiveText(live: RunLive): String {
        val where = liveInstance(live.page)?.let { "Shared live on $it" } ?: "Shared live"
        return if (live.viewers == 0) "$where: nobody watches yet" else "$where: ${views(live.viewers)} open"
    }

    /** What an entry of the status bar's menu on a share does: open the run page, copy its link, or stop sharing. */
    enum class LiveEntryKind { OPEN_PAGE, COPY_LINK, STOP_SHARING, STOP_SHARING_PROJECT }

    /** An entry of the status bar's menu on a share, for the run of `ref` and its page `url` where it has them. */
    data class LiveEntry(val kind: LiveEntryKind, val label: String, val ref: String? = null, val url: String? = null)

    /**
     * The status bar's menu on a share, in VS Code's order: for each run shared live, **Open the run page**, **Copy the
     * run page's link** (while its page is known) and **Stop sharing the run**, each naming its run when several are
     * shared (`runLabel`); then **Stop sharing this project's runs** while the project's runs are shared. Both stops ask
     * first ([stopSharingQuestion]).
     */
    fun liveMenu(sessions: Map<String, RunSession>, windowShared: Boolean): List<LiveEntry> {
        val shared = sharedRunsOf(sessions).filter { it.live.shared }
        val entries = shared.flatMap { run ->
            val name = if (shared.size > 1) sessions[run.ref]?.let { runLabel(it).replaceFirstChar { c -> c.lowercaseChar() } } else null
            listOfNotNull(
                run.live.page?.let { LiveEntry(LiveEntryKind.OPEN_PAGE, name?.let { n -> "Open the page of $n" } ?: "Open the run page", run.ref, it) },
                run.live.page?.let { LiveEntry(LiveEntryKind.COPY_LINK, name?.let { n -> "Copy the link of $n" } ?: "Copy the run page's link", run.ref, it) },
                LiveEntry(LiveEntryKind.STOP_SHARING, name?.let { "Stop sharing $it" } ?: "Stop sharing the run", run.ref),
            )
        }
        return if (windowShared) entries + LiveEntry(LiveEntryKind.STOP_SHARING_PROJECT, "Stop sharing this project's runs") else entries
    }

    /** What Stop sharing says, asking nothing, for a run that ended or is shared no more. */
    const val SHARE_ENDED = "That run is not shared live any more: it ended, or its share was stopped."

    /**
     * What Stop sharing asks before it stops: for a run (`live`), where it is shared and the views that end there; for
     * the project's runs (`live` null), that the runs to come are not shared either.
     */
    fun stopSharingQuestion(live: RunLive?): String {
        if (live == null) {
            return "Stop sharing this project's runs live? Their views on the team instance end, and the runs that follow " +
                "are not shared."
        }
        val where = liveInstance(live.page)?.let { " on $it" }.orEmpty()
        val views = if (live.viewers > 0) "The ${views(live.viewers)} open there end" else "Its page there stops showing it live"
        return "Stop sharing the run live$where? $views, and nothing more goes there until you share it again."
    }

    /** What a Share live action acts on: one run, a choice among several, or why there is none. */
    sealed class LiveTarget {
        data class One(val ref: String) : LiveTarget()

        data class Choose(val refs: List<String>) : LiveTarget()

        data class None(val why: String) : LiveTarget()
    }

    /**
     * The run Share live (`on`) or Stop sharing acts on: the only one it fits, else a choice; a run that cannot be
     * shared is asked anyway when no other can be, and the service says why.
     */
    fun liveTarget(sessions: Map<String, RunSession>, on: Boolean): LiveTarget {
        if (sessions.isEmpty()) return LiveTarget.None("No run started from the IDE is running.")
        val runs = sharedRunsOf(sessions)
        val fit = if (on) runs.filter { !it.live.shared && it.live.refused == null } else runs.filter { it.live.shared }
        if (!on && fit.isEmpty()) return LiveTarget.None("No run is shared live.")
        val refs = fit.map { it.ref }.ifEmpty { sessions.keys.take(1) }
        return if (refs.size == 1) LiveTarget.One(refs.single()) else LiveTarget.Choose(refs)
    }

    /** The run whose Hold failures the action turns over, and to what (`on`); else the runs to choose among, or why none. */
    sealed class HoldTarget {
        data class One(val ref: String, val on: Boolean) : HoldTarget()

        data class Choose(val refs: List<String>) : HoldTarget()

        data class None(val why: String) : HoldTarget()
    }

    /**
     * What the plugin answers another tool that asks it to stop a run (`piwi/stopRun`, from Piwi Picker or the desktop
     * app through the hub): whether it ended the run's process, a run this IDE did not start refused.
     */
    fun stopRunAnswer(stopped: Boolean): RunControlResult =
        if (stopped) {
            RunControlResult(ok = true, message = "The IDE stops the run.")
        } else {
            RunControlResult(ok = false, message = "The run was not started in this IDE: stop it where it was started.")
        }

    /** The only live run that has a Hold failures, turned over; else the runs to choose among; else why none has. */
    fun holdTarget(sessions: Map<String, RunSession>): HoldTarget {
        val held = holdableRuns(sessions)
        return when (held.size) {
            0 -> HoldTarget.None("No run of this project can hold its failures now.")
            1 -> HoldTarget.One(held.single().ref!!, held.single().hold?.on != true)
            else -> HoldTarget.Choose(held.map { it.ref!! })
        }
    }

    /** The live runs that have a Hold failures to turn over, in their order. */
    fun holdableRuns(sessions: Map<String, RunSession>): List<RunSession> =
        sessions.values.filter { !it.ended && it.hold != null && it.ref != null }

    /** A run named apart from the others in a list: its page when it has one, else its folder's name, else its ref. */
    fun runLabel(session: RunSession): String {
        session.page?.let { return "Run #${it.id}" }
        val folder = session.root?.split('/', '\\')?.lastOrNull { it.isNotEmpty() }
        return if (folder != null) "Run in $folder (${session.ref})" else "Run ${session.ref}"
    }

    /** The Hold failures action's text: what a click does to the only live run that has one; else a choice to come. */
    fun holdActionText(controls: RunControls): String = when (controls.onlyHold?.on) {
        true -> "Turn hold failures off"
        false -> "Turn hold failures on"
        null -> "Turn hold failures on or off for the run"
    }

    /** A run's Hold failures in words: whether a failed test waits at its line, and that an agent set it when one did. */
    fun holdText(hold: RunHoldFailures): String {
        val by = if (hold.by == "agent") ", as an agent set it" else ""
        return if (hold.on) "Hold failures on: a failed test waits at its line$by" else "Hold failures off$by"
    }

    /** What a shared browser's answer says, with the command that joins it. */
    fun sharedText(result: StopBindResult): String =
        if (!result.ok || result.name == null) result.message.orEmpty() else "${result.message.orEmpty()} Join it with: ${result.command}"

    /** Whether a stop holds a failed test's page: any answer lets the test end as it failed. */
    fun isFailure(stop: RunStop): Boolean = stop.reason == "failure"

    /** A stop's place, as the choice among several and the paused page name it: `checkout.page.ts:5`. */
    fun stopPlace(stop: RunStop): String {
        val path = runCatching { Path.of(java.net.URI(stop.uri ?: "")) }.getOrNull()
        return "${path?.fileName ?: stop.uri.orEmpty().substringAfterLast('/')}:${stop.line + 1}"
    }

    /** How many Code Vision entries a line shows at most: one provider draws each (`PiwiCodeVisionProvider`). */
    const val CODE_VISION_SLOTS = 8

    /**
     * The Code Vision entries the provider of `slot` draws: each line's entry at that place, in the service's order, of
     * the file's line and the lines without a test status (a test's own line is drawn in the gutter), a blank title
     * left out.
     */
    fun codeVisionSlot(summary: FileSummary, slot: Int): List<SummaryLine> =
        (listOfNotNull(summary.file) + summary.lines.orEmpty().filter { it.status == null })
            .filter { !it.title.isNullOrBlank() }
            .groupBy { it.line }
            .mapNotNull { (_, entries) -> entries.getOrNull(slot) }

    /** A stop as the choice among several names it: what it runs, its test, its place and its worker. */
    fun stopLabel(stop: ShownStop): String {
        val test = stop.test?.title?.joinToString(" › ")?.let { "$it · " }.orEmpty()
        return "${pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout)} · $test${stopPlace(stop.stop)} · ${workerName(stop.slot)}"
    }

    /**
     * What the controls offer: while a run is live (`active`), Stop for one this IDE started (`stoppable`; a run
     * started in a terminal is the terminal's to stop), Pause while a worker runs a test or is between tests and no
     * Pause reached it (`pausable`), `pausing` once one did, Resume, Step, Run to caret and Finish while a worker is
     * stopped, End the test where a stop takes it (`endable`), and the code actions some stop offers (`actions`).
     */
    data class RunControls(
        val active: Boolean,
        val pausable: Boolean,
        val pausing: Boolean,
        val stopped: Boolean,
        val actions: Set<StopAction> = emptySet(),
        /** A stop's browser can be shared with Playwright's own tools. */
        val shareable: Boolean = false,
        /** A stop's window can come to the front: Show the browser. */
        val browserShowable: Boolean = false,
        val stoppable: Boolean = active,
        val endable: Boolean = false,
        /** A run is shared live (Stop sharing), and the views open of the shared runs; null for none. */
        val liveViewers: Int? = null,
        /** A worker's reporter shows its page while its test runs: Watch a worker's test. */
        val watchable: Boolean = false,
        /** The call a pausing worker's test waits in (the first such worker's): End the test ends it there. */
        val waiting: RunWaiting? = null,
        /** A live run has a Hold failures to turn over. */
        val holdable: Boolean = false,
        /** The Hold failures of the only live run that has one; null for none or several. */
        val onlyHold: RunHoldFailures? = null,
    ) {
        val liveShared: Boolean get() = liveViewers != null
    }

    fun runControls(sessions: Map<String, RunSession>): RunControls {
        val workers = sessions.values.flatMap { it.workers.orEmpty() }
        return RunControls(
            active = sessions.isNotEmpty(),
            pausable = workers.any { it.state != "stopped" && !it.pausing && it.test?.cannotPause == null },
            pausing = workers.any { it.pausing },
            stopped = workers.any { it.state == "stopped" },
            actions = stopsOf(sessions).flatMap(::stopActions).toSet(),
            shareable = stopsOf(sessions).any(::canShare),
            browserShowable = stopsOf(sessions).any(::canShowBrowser),
            stoppable = sessions.values.any { !it.terminal && it.checkout == null },
            endable = stopsOf(sessions).any(::canEnd),
            liveViewers = sharedRunsOf(sessions).filter { it.live.shared }.takeIf { it.isNotEmpty() }?.sumOf { it.live.viewers },
            watchable = workers.any { it.watchable },
            waiting = workers.firstOrNull { it.pausing && it.waiting != null }?.waiting,
            holdable = holdableRuns(sessions).isNotEmpty(),
            onlyHold = holdableRuns(sessions).singleOrNull()?.hold,
        )
    }

    /** A pausing worker whose test waits in a call: its run, its worker, and the call. */
    data class WaitingWorker(val ref: String, val worker: Int, val waiting: RunWaiting, val slot: Int = worker)

    /** The pausing workers whose test waits in a call, in their order. */
    fun waitingWorkers(sessions: Map<String, RunSession>): List<WaitingWorker> = sessions.values.flatMap { session ->
        session.workers.orEmpty().mapNotNull { w ->
            w.waiting?.takeIf { w.pausing }?.let { WaitingWorker(session.ref ?: "", w.worker, it, w.parallelIndex) }
        }
    }

    /** The longest call the status bar names before it cuts it, in characters. */
    private const val STATUS_CALL_MAX = 60

    /** A call's title as the status bar names it: cut past `STATUS_CALL_MAX` characters, with an ellipsis. */
    private fun clipped(title: String): String =
        if (title.length <= STATUS_CALL_MAX) title else title.take(STATUS_CALL_MAX - 1).trimEnd() + "…"

    /** What the developer reads as a teammate asks to watch a run that is not shared live (`piwi/askToWatch`). */
    fun askToWatchText(by: String, run: Int?): String = "$by asks to watch ${run?.let { "run #$it" } ?: "this run"} live."

    private fun views(count: Int): String = if (count == 1) "1 view" else "$count views"

    /** Whether two URIs name the same file. */
    private fun sameFile(a: String?, b: String?): Boolean {
        if (a == null || b == null) return false
        if (a == b) return true
        val paths = runCatching { Path.of(java.net.URI(a)).normalize() to Path.of(java.net.URI(b)).normalize() }.getOrNull()
        return paths != null && paths.first == paths.second
    }

    /** Whether a stop is at a line of the file at `uri`. */
    fun stopIsAt(stop: ShownStop, uri: String?, line: Int): Boolean = stop.stop.line == line && sameFile(stop.stop.uri, uri)

    /** Whether a stop is in the file at `uri`. */
    fun stopInFile(stop: ShownStop, uri: String?): Boolean = sameFile(stop.stop.uri, uri)

    /**
     * The stops a control at the caret may act on: every one when there is one or none; with several, those stopped on
     * the caret's line, else all of them, to choose from.
     */
    fun stopsFor(stops: List<ShownStop>, uri: String?, line: Int?): List<ShownStop> {
        if (stops.size < 2) return stops
        val here = if (line == null) emptyList() else stops.filter { stopIsAt(it, uri, line) }
        return here.ifEmpty { stops }
    }

    /** A link above a stopped line: a control, or a code action, by its label, or a shorter one in the inlay. */
    sealed interface StopLink {
        val label: String
        val inlayLabel: String get() = label
    }

    /** The controls offered above a stop, in order. */
    enum class StopControl(override val label: String, val action: String) : StopLink {
        RESUME("Resume", "resume"),
        STEP("Step", "step"),
        RUN_TO_CARET("Run to caret", "run-to"),
        FINISH("Finish", "finish"),
        END("End test", "end"),
    }

    /**
     * The controls a stop offers: all of them, End test where its reporter takes it (`canEnd`); at a failure, Resume
     * alone, which lets the test end as it failed (Step, Finish and End do the same).
     */
    fun stopControls(stop: ShownStop): List<StopControl> =
        if (isFailure(stop.stop)) listOf(StopControl.RESUME)
        else StopControl.entries.filter { it != StopControl.END || canEnd(stop) }

    /** Whether a stop can end its test (End the test, `end`): its reporter takes it, and it is no failure. */
    fun canEnd(stop: ShownStop): Boolean = !isFailure(stop.stop) && "end" in stop.takes

    /**
     * The code actions at a stop, in the order it offers them (`piwi/stopAction`): the pause bar's Pick a locator and
     * Record, and Assert and Assert a region, in the test's window (`inPage`), so at a stop the bar shows; Mock a
     * request at any stop. Each needs its reporter to take what `takes` names, and has its action under **Tools → Piwi**;
     * the inlay names it shorter, beside the controls.
     */
    enum class StopAction(
        override val label: String,
        override val inlayLabel: String,
        val action: String,
        val takes: List<String>,
        val inPage: Boolean,
    ) : StopLink {
        PICK("Pick a locator", "Pick", "pick", listOf("pick"), true),
        RECORD("Record", "Record", "record", listOf("record"), true),
        ASSERT("Assert", "Assert", "assert", listOf("assert"), true),
        ASSERT_REGION("Assert a region", "Assert region", "assert-region", listOf("assert-region"), true),
        MOCK("Mock a request", "Mock", "mock", listOf("requests", "mock"), false),
    }

    /** The code actions a stop offers: those its reporter takes, the ones in the test's window only where the bar shows. */
    fun stopActions(stop: ShownStop): List<StopAction> =
        StopAction.entries.filter { (!it.inPage || stop.stop.bar) && stop.takes.containsAll(it.takes) }

    /** A body's size as the list of responses names it: `no size` when the response did not say it. */
    fun sizeText(size: Long?): String = when {
        size == null -> "no size"
        size < 1024 -> "$size B"
        size < 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f KB", size / 1024.0)
        else -> String.format(java.util.Locale.ROOT, "%.1f MB", size / 1024.0 / 1024.0)
    }

    /** When a response finished, after the test began: `840 ms`, `12.4 s`. */
    fun timeText(ms: Double): String =
        if (ms < 1000) "${Math.round(ms)} ms" else String.format(java.util.Locale.ROOT, "%.1f s", ms / 1000)

    /** The responses Mock a request offers, the latest first. */
    fun requestsToMock(requests: List<StopRequest>?): List<StopRequest> = requests.orEmpty().asReversed()

    /** A response as the list names it: its method and URL, which the list filters on. */
    fun requestLabel(request: StopRequest): String = "${request.method.orEmpty()} ${request.url.orEmpty()}"

    /** What the list says of a response beside its label: its status, type, size and when it finished in the test. */
    fun requestDetails(request: StopRequest): String =
        listOf("${request.status}", request.type?.ifEmpty { null } ?: "no type", sizeText(request.size), "at ${timeText(request.time)}")
            .joinToString(" · ")

    /**
     * What the end of the caret's line says of the locator there, counted on the stopped page: `3 matches`, `1 match`,
     * `no match`, why it was not counted; null for a line holding no locator Piwi reads.
     */
    fun caretText(answer: LocatorAtCaretResult): String? {
        if (answer.locator == null) return null
        val count = answer.count
        if (!answer.ok || count == null) return answer.message
        return when (count) {
            0 -> "no match"
            1 -> "1 match"
            else -> "$count matches"
        }
    }

    /**
     * The count at the caret's questions, one at a time: the caret stands at a query (`want`, by its key: the stop, the
     * file and line, the line's text), which is asked once it settled (`ask`), unless another is on its way or it was
     * asked already while the caret stayed there; the answer is shown only while the caret is still there (`answered`),
     * and the query it stands at then asked once that one settled. The caret coming back to a query asks it again, its
     * count being gone. A key of null is no stop: nothing is asked.
     */
    class CaretAsks {
        var wanted: String? = null
            private set
        private var asked: String? = null
        private var flying = false

        /** The caret stands at `key` now; true when it moved to another query, whose count is to be cleared. */
        fun want(key: String?): Boolean {
            if (key == wanted) return false
            wanted = key
            asked = null
            return true
        }

        /** Whether `key`, which the caret settled on, is asked now: then it is on its way. */
        fun ask(key: String): Boolean {
            if (flying || key != wanted || key == asked) return false
            flying = true
            asked = key
            return true
        }

        /** The answer to `key` came: whether it is shown, the caret still standing at it. */
        fun answered(key: String): Boolean {
            flying = false
            return key == wanted
        }
    }

    /** `text` in place of the offsets `start` to `end` of a document. */
    data class TextWrite(val start: Int, val end: Int, val text: String)

    /**
     * Where a stop's edits, all placed in the text they are made in, are made: each as offsets of `text`, the last in
     * the file first, so each leaves the places of those above it as they were, and of two at one place the later one
     * first, so it ends up after the other; null when one falls outside the text.
     */
    fun stopCodeWrites(text: CharSequence, edits: List<FileEdit>): List<TextWrite>? {
        val writes = edits.map { e ->
            val start = offsetAt(text, e.range?.start) ?: return null
            val end = offsetAt(text, e.range?.end) ?: return null
            if (end < start) return null
            TextWrite(start, end, e.newText.orEmpty())
        }
        return writes.withIndex().sortedWith(compareByDescending<IndexedValue<TextWrite>> { it.value.start }.thenByDescending { it.index })
            .map { it.value }
    }

    /** The offset of a position of `text`, a line and a character within it; null outside the text. */
    private fun offsetAt(text: CharSequence, position: EditPosition?): Int? {
        position ?: return null
        if (position.line < 0 || position.character < 0) return null
        var start = 0
        repeat(position.line) {
            val next = text.indexOf('\n', start)
            if (next < 0) return null
            start = next + 1
        }
        val end = text.indexOf('\n', start).let { if (it < 0) text.length else it }
        return if (start + position.character <= end) start + position.character else null
    }

    /**
     * The lines the block a stop's code writes stands on once its edits are made: its first line (`StopCode.line`, moved
     * down by the import lines written above it) and its last.
     */
    fun writtenLines(code: StopCode): IntRange {
        val above = code.edits.orEmpty().filter { (it.range?.start?.line ?: 0) < code.line }.sumOf { e ->
            e.newText.orEmpty().count { it == '\n' } - ((e.range?.end?.line ?: 0) - (e.range?.start?.line ?: 0))
        }
        val start = code.line + above
        return start..start + code.code.orEmpty().count { it == '\n' }
    }

    /** What a stop's code says once written, as a warning when its reader should check something. */
    data class StopCodeNotice(val warning: Boolean, val text: String)

    /** Its sentence, which names Piwi, then what its reader should check (values hidden as credentials, a body as it came). */
    fun stopCodeNotice(code: StopCode): StopCodeNotice {
        val warnings = code.warnings.orEmpty().filter { it.isNotBlank() }
        return StopCodeNotice(warnings.isNotEmpty(), (listOfNotNull(code.message?.ifBlank { null }) + warnings).joinToString(" "))
    }

    /** The runs whose breakpoints the plugin remembers, at most: those it started and those it heard of. */
    private const val MAX_BREAKPOINT_RUNS = 50

    /**
     * What a run was given of the IDE's breakpoints: where the edit log stood when it started (`since`), the line of
     * each breakpoint in its code by the IDE's breakpoint, and the places last sent (null before any).
     */
    class RunBreakpoints(val since: Int, val lines: MutableMap<Any, EditorBreakpoint>, var sent: String?)

    /** A run started at `since` with `breakpoints`; one heard of but not started here was given none Piwi knows. */
    fun runStarted(since: Int, breakpoints: List<RunBreakpoint>?): RunBreakpoints = RunBreakpoints(
        since,
        breakpoints.orEmpty().mapNotNull { b -> b.key?.let { it to b.place } }.toMap(HashMap()),
        breakpoints?.let { list -> breakpointsText(list.map { it.place }) },
    )

    /** Keep what a run was given, the oldest of more than [MAX_BREAKPOINT_RUNS] runs forgotten. */
    fun <T> remember(runs: LinkedHashMap<String, T>, ref: String, value: T) {
        runs.remove(ref)
        runs[ref] = value
        while (runs.size > MAX_BREAKPOINT_RUNS) runs.remove(runs.keys.first())
    }

    private fun breakpointsText(places: List<EditorBreakpoint>) = places.joinToString("\n") { "${it.line} ${it.uri}" }

    /**
     * The IDE's breakpoints as lines of a run's code: one the run was given keeps its line while it only moved with the
     * edits since (`forward` brings that line to where it stands); another, or one moved otherwise (dragged), is its line
     * mapped back through the edits, left out on a line made since, which the run's code lacks.
     */
    fun runPlaces(run: RunBreakpoints, breakpoints: List<RunBreakpoint>, edits: EditLog): List<EditorBreakpoint> =
        breakpoints.mapNotNull { b ->
            val given = b.key?.let { run.lines[it] }
            if (given != null && given.uri == b.place.uri && edits.forward(fileKey(given.uri), given.line, run.since) == b.place.line) {
                return@mapNotNull given
            }
            val line = edits.back(fileKey(b.place.uri), b.place.line, run.since) ?: return@mapNotNull null
            EditorBreakpoint(b.place.uri, line).also { place -> b.key?.let { run.lines[it] = place } }
        }

    /**
     * The `piwi/setRunBreakpoints` the live runs need for the IDE's `breakpoints`: one per run whose places
     * ([runPlaces]) differ from those it has (`runs`, by ref: those its command started with, else the last sent), which
     * `runs` then records. A run heard of without its start maps from now.
     */
    fun breakpointUpdates(
        sessions: Map<String, RunSession>,
        breakpoints: List<RunBreakpoint>,
        runs: LinkedHashMap<String, RunBreakpoints>,
        edits: EditLog,
    ): List<SetRunBreakpointsParams> = sessions.keys.mapNotNull { ref ->
        val run = runs[ref] ?: runStarted(edits.now(), null).also { remember(runs, ref, it) }
        val places = runPlaces(run, breakpoints, edits)
        val text = breakpointsText(places)
        if (run.sent == text) return@mapNotNull null
        run.sent = text
        SetRunBreakpointsParams(ref, places)
    }

    /** The longest paused page the plugin decodes, in base64 characters: 12 MB of JPEG. */
    const val MAX_IMAGE_DATA = 16 * 1024 * 1024

    /** The widest and tallest paused page shown, and the most pixels: a full-page image of a long page is refused. */
    private const val MAX_IMAGE_SIDE = 16_384
    private const val MAX_IMAGE_PIXELS = 40_000_000L

    /** A JPEG of a stopped page, decoded from base64, of [MAX_IMAGE_DATA] at most; null for anything else. */
    fun pausedImageBytes(image: PausedImage?): ByteArray? {
        if (image?.mime != "image/jpeg") return null
        val data = image.data ?: return null
        if (data.length > MAX_IMAGE_DATA) return null
        return runCatching { java.util.Base64.getDecoder().decode(data) }.getOrNull()?.takeIf { it.isNotEmpty() }
    }

    /** Whether an image this wide and tall is drawn: decoding one larger holds too much memory. */
    fun decodableImage(width: Int, height: Int): Boolean =
        width in 1..MAX_IMAGE_SIDE && height in 1..MAX_IMAGE_SIDE && width.toLong() * height <= MAX_IMAGE_PIXELS

    /** The hint above an image a click picks on. */
    const val PICK_HINT = "Click the image to pick a locator: it replaces the one on the stopped line."

    /** Whether a click on an image of a stop picks there: its worker takes `pick-at`, and the image names its viewport. */
    fun picksOnImage(takes: List<String>, image: PausedImage?): Boolean =
        "pick-at" in takes && (image?.width ?: 0) > 0 && (image?.height ?: 0) > 0

    /**
     * The point of the stopped page under a click at `x`, `y` of its image shown `shownWidth` by `shownHeight`, in CSS
     * pixels of its viewport (`piwi/pickAt`): scaled by the viewport over the size it is shown at, whatever the image's
     * own size and the page's device scale factor; null for a click outside the image or one that names no viewport.
     */
    fun pagePoint(x: Int, y: Int, shownWidth: Int, shownHeight: Int, image: PausedImage?): Pair<Int, Int>? {
        val width = image?.width?.takeIf { it > 0 } ?: return null
        val height = image.height?.takeIf { it > 0 } ?: return null
        if (shownWidth <= 0 || shownHeight <= 0 || x !in 0..shownWidth || y !in 0..shownHeight) return null
        val pageX = Math.round(x.toDouble() * width / shownWidth).toInt().coerceAtMost(width - 1)
        val pageY = Math.round(y.toDouble() * height / shownHeight).toInt().coerceAtMost(height - 1)
        return pageX to pageY
    }

    /**
     * What **Pair with Piwi Picker** adds for remote development: the platform gives no public way to forward a port of
     * a JetBrains Gateway backend, so the person forwards the IDE's port (`pairing`) and the run hubs' (`hubs`) under
     * **Ports** in the JetBrains Client, at the same numbers, which the pairing's proof and the hubs' `Host` check name.
     */
    fun forwardingHint(pairing: Int, hubs: List<Int>): String {
        val runs = hubs.distinct().sorted()
        val first = "With JetBrains Gateway, forward port $pairing under Ports in the JetBrains Client first"
        return when (runs.size) {
            0 -> "$first, at the same number."
            1 -> "$first, and ${runs.single()} for the runs, at the same numbers."
            else -> "$first, and ${runs.dropLast(1).joinToString(", ")} and ${runs.last()} for the runs, at the same numbers."
        }
    }

    /** The request header carrying Piwi Picker's challenge (`@piwitests/core/editor-send`). */
    const val EDITOR_CHALLENGE_HEADER = "x-piwi-editor-challenge"

    /** The response header carrying the proof that answers it. */
    const val EDITOR_PROOF_HEADER = "x-piwi-editor-proof"

    private val EDITOR_CHALLENGE = Regex("^[0-9a-f]{32,128}$")

    /** Whether `value` is a challenge: 32 to 128 lowercase hex characters. */
    fun isEditorChallenge(value: String?): Boolean = value != null && EDITOR_CHALLENGE.matches(value)

    /**
     * The proof that this IDE holds the pairing's `token`, for the loopback `port` it answers on, as
     * `editorTokenProof` in `@piwitests/core/editor-send` makes it: HMAC-SHA256 keyed by the token over
     * `piwi-editor-proof:<port>:<challenge>`, lowercase hex.
     */
    fun editorTokenProof(token: String, port: Int, challenge: String): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal("piwi-editor-proof:$port:$challenge".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    /** Whether an `Authorization` header carries the token, compared in constant time. */
    fun sendAuthorized(header: String?, token: String): Boolean {
        val given = Regex("^Bearer\\s+(\\S+)$", RegexOption.IGNORE_CASE).find(header ?: "")?.groupValues?.get(1) ?: return false
        return token.isNotEmpty() && java.security.MessageDigest.isEqual(given.toByteArray(), token.toByteArray())
    }

    /**
     * What the dashboard's Open in IDE asks (`/api/piwi/open`): a file of a run, as a path relative to the
     * run's working directory or an absolute one, at an optional 1-based line and column. `root` is the
     * working directory when the dashboard knows it (its workspace root setting, the desktop app's linked
     * folder), tried first. With `check`, the IDE only says whether one of its open projects holds the file.
     * `piwiProject` names the Piwi project, which picks the IDE project connected to it when several hold the file.
     */
    sealed class OpenRequest {
        data class File(
            val path: String,
            val line: Int?,
            val column: Int?,
            val check: Boolean,
            val piwiProject: String?,
            val root: String? = null,
            /** **Debug in my editor** (`debug=1`): the test to run, stopping at `line` of the file, once asked. */
            val debug: DebugRequest? = null,
        ) : OpenRequest()

        data class Refused(val error: String) : OpenRequest()
    }

    /**
     * What a Debug in my editor request names beside the failing line: the test's spec as the run reported it, its title
     * after its describe blocks' (joined by ` › `), the Playwright project it failed in, and the failed execution whose
     * suggested locator is outlined at the stop, and the name the dashboard gave the run, which its page follows it by.
     */
    data class DebugRequest(
        val spec: String,
        val title: String,
        val project: String?,
        val execution: Int?,
        val ref: String? = null,
    )

    /** The fields a debug request names, none of them twice. */
    private val DEBUG_FIELDS = listOf("file", "line", "column", "root", "debug", "spec", "test", "playwrightProject", "execution", "ref")

    /** The name a dashboard gives a debug run, which the editor service checks again (`DEBUG_RUN_REF`). */
    private val RUN_REF = Regex("^ed-[0-9a-f]{16,32}$")

    const val MAX_DEBUG_TITLE = 1000
    const val MAX_DEBUG_PROJECT = 200

    /**
     * Text alone: no control character, and none of the characters a notification could read as markup or a link
     * (`[`, `]`, `<`, `>`, a backtick, a backslash).
     */
    private val PLAIN_TEXT = Regex("^[^\\p{Cc}\\[\\]<>`\\\\]+$")

    /**
     * Characters a shell expands, which no Playwright project name on a command line may hold: PowerShell reads the
     * typographic double quotes (“ ” „) as `"` too.
     */
    private val SHELL_EXPANDED = Regex("[$\"%!\u201C\u201D\u201E]")

    /** A positive whole number as a link writes it: no sign, no leading zero, no exponent, 32 bits at most. */
    private fun positive(value: String?): Int? =
        value?.takeIf { Regex("^[1-9][0-9]{0,9}$").matches(it) }?.toLongOrNull()?.takeIf { it <= Int.MAX_VALUE }?.toInt()

    /**
     * Read what a debug request adds to an open request (`debug=1`), each value checked: `line` a positive whole
     * number, `test` a title of plain text, `spec` a path as `file` is, `playwrightProject` a name of plain text no shell
     * expands, `execution` an id; no field given twice. A link is anyone's to write: it names files, a line and a title,
     * never a command.
     */
    private fun parseDebugRequest(query: Map<String, List<String>>, path: String): Any {
        for (name in DEBUG_FIELDS) if ((query[name]?.size ?: 0) > 1) return "$name is given twice"
        fun one(name: String) = query[name]?.firstOrNull()
        if (one("debug") != "1") return "debug must be 1"
        if (positive(one("line")) == null) return "line must be a positive whole number"
        if (one("column") != null && positive(one("column")) == null) return "column must be a positive whole number"
        val spec = one("spec")?.trim()?.ifEmpty { null }?.replace('\\', '/') ?: path
        refusedPath("spec", spec)?.let { return it }
        val title = one("test")?.trim().orEmpty()
        if (title.isEmpty() || title.length > MAX_DEBUG_TITLE || !PLAIN_TEXT.matches(title)) {
            return "test must be a title of 1 to $MAX_DEBUG_TITLE characters of plain text"
        }
        val project = one("playwrightProject")?.trim()?.ifEmpty { null }
        if (project != null && (project.length > MAX_DEBUG_PROJECT || !PLAIN_TEXT.matches(project) || SHELL_EXPANDED.containsMatchIn(project))) {
            return "playwrightProject must be a project name of 1 to $MAX_DEBUG_PROJECT characters of plain text"
        }
        val execution = one("execution")
        if (execution != null && positive(execution) == null) return "execution must be an id"
        val ref = one("ref")?.trim()?.ifEmpty { null }
        if (ref != null && !RUN_REF.matches(ref)) return "ref must be a run name the dashboard gives"
        return DebugRequest(spec, title, project, execution?.let { positive(it) }, ref)
    }

    const val MAX_OPEN_PATH = 4096

    /** Why a path given to Open in IDE is refused, or null when it is acceptable. */
    private fun refusedPath(name: String, path: String): String? = when {
        path.length > MAX_OPEN_PATH -> "$name is at most $MAX_OPEN_PATH characters"
        path.any { it.isISOControl() } -> "$name must not contain a control character"
        // A UNC path would make the IDE reach a network share (and send the user's credentials to it).
        path.startsWith("//") -> "network paths are not supported"
        path.split('/').any { it == ".." } -> "$name must not contain '..'"
        else -> null
    }

    /** Read the query of an open request; a missing line or column means none. */
    fun parseOpenRequest(query: Map<String, List<String>>): OpenRequest {
        fun last(name: String) = query[name]?.lastOrNull()?.trim()?.ifEmpty { null }
        val path = last("file")?.replace('\\', '/') ?: return OpenRequest.Refused("file is required")
        refusedPath("file", path)?.let { return OpenRequest.Refused(it) }
        val root = last("root")?.replace('\\', '/')
        if (root != null) {
            refusedPath("root", root)?.let { return OpenRequest.Refused(it) }
            if (!isAbsolutePath(root)) return OpenRequest.Refused("root must be an absolute path")
        }
        // A debug request's fields are checked first, each by its own rule.
        val debug = if (query.containsKey("debug")) {
            when (val read = parseDebugRequest(query, path)) {
                is DebugRequest -> read
                else -> return OpenRequest.Refused(read as String)
            }
        } else {
            null
        }
        val line = last("line")
        val lineNumber = line?.toIntOrNull()
        if (line != null && (lineNumber == null || lineNumber < 1)) return OpenRequest.Refused("line must be a positive integer")
        val column = last("column")
        val columnNumber = column?.toIntOrNull()
        if (column != null && (columnNumber == null || columnNumber < 1)) return OpenRequest.Refused("column must be a positive integer")
        // `?check` and `?check=1` ask for a check; `?check=0` does not.
        val check = query["check"]?.lastOrNull()?.trim()?.let { it != "0" && it != "false" } ?: query.containsKey("check")
        return OpenRequest.File(path, lineNumber, columnNumber, check, last("project"), root, debug)
    }

    /**
     * The folders a file of the project is found in, by Open in IDE and by a debug request alike: the folders the
     * service reads (`contextRoots`), the Playwright configs' (`configDirs`), the folders searched for them
     * (`searchRoots`, where a config beside a Rider solution is found through Git), the project's folder (above `.idea`
     * in Rider, `projectFolder`) and its content roots; each once, in that order.
     */
    fun openRoots(
        contextRoots: List<String>,
        configDirs: List<String>,
        searchRoots: List<String>,
        basePath: String?,
        contentRoots: List<String>,
    ): List<String> =
        (contextRoots + configDirs + searchRoots + listOfNotNull(basePath?.let(::projectFolder), basePath) + contentRoots)
            .distinct()

    /**
     * Why a file a debug request names may not be debugged, with every link followed (`canonical`, the file's
     * canonical path, and the folders'): it must be in one of `projectRoots` and under one of `configDirs`, the failing
     * line's a script file, the test's a spec. Null when it may. `named` is the path as the request named it.
     */
    fun debugFileRefusal(named: String, canonical: String, projectRoots: List<String>, configDirs: List<String>, spec: Boolean): String? {
        fun inside(folders: List<String>) = folders.any { folder ->
            runCatching { Path.of(canonical).normalize().startsWith(Path.of(folder).normalize()) }.getOrDefault(false)
        }
        return when {
            !inside(projectRoots) -> "$named is outside the project's folders"
            !inside(configDirs) -> "$named is under no Playwright config's folder"
            spec && !SPEC_FILE.containsMatchIn(canonical) -> "$named is not a spec"
            !spec && !SCRIPT_FILE.containsMatchIn(canonical) -> "$named is not a JavaScript or TypeScript file"
            else -> null
        }
    }

    /** The button of the prompt that asks before a debug request runs anything. */
    const val DEBUG_ANSWER = "Debug"

    /** The prompt that asks before a debug request runs anything, as plain text: the test, and its Playwright project. */
    fun debugPrompt(title: String, line: Int, project: String? = null): String {
        val inProject = project?.let { " in the Playwright project “$it”," } ?: ""
        return "Debug this test here? Piwi runs “$title”$inProject headed, one worker, and stops at line $line."
    }

    /** What a refused debug request says. */
    fun debugRefusal(why: String): String = "This Debug in my editor link was refused: $why. Nothing was opened or run."

    /**
     * The run a yes to a debug request starts (`piwi/runArgs`): the test of the spec at `specUri` its title names,
     * stopping once at the 1-based `line` of the file at `fileUri`.
     */
    fun debugRunArgs(specUri: String, fileUri: String, line: Int, debug: DebugRequest): RunTestsArgs = RunTestsArgs(
        uri = specUri,
        testIds = emptyList(),
        debug = DebugRun(EditorBreakpoint(fileUri, line - 1), debug.title, debug.project, debug.execution, debug.ref),
    )

    /** Whether a path, with forward slashes, is absolute: `/home/me/a.ts` or `C:/me/a.ts`. */
    fun isAbsolutePath(path: String): Boolean = path.startsWith("/") || Regex("^[A-Za-z]:/").containsMatchIn(path)

    /**
     * The files to look for, in order: an absolute path as is; a relative one under each root
     * (the directories a run's paths may start from), each root once.
     */
    fun candidatePaths(path: String, roots: List<String>): List<String> {
        val file = path.replace('\\', '/')
        if (isAbsolutePath(file)) return listOf(file)
        val relative = file.replace(Regex("^(\\./)+"), "").trimStart('/')
        return roots.map { it.replace('\\', '/').trimEnd('/') }.filter { it.isNotEmpty() }.distinct().map { "$it/$relative" }
    }

    /** How a desktop job's update shows (`desktopJobNotice` in the VS Code extension). */
    data class DesktopJobNotice(val text: String, val warning: Boolean, val actions: List<String>)

    /**
     * A job that ended without a verdict (declined, expired, the app gone, or an error) shows as a warning, anything
     * else as information, with the share button when the verdict can be shared.
     */
    fun desktopJobNotice(update: DesktopJobUpdate): DesktopJobNotice {
        val message = update.message.orEmpty()
        val failed = update.status != "done" && update.status != "running"
        return DesktopJobNotice(
            text = message,
            warning = failed || message.startsWith("The desktop app could not"),
            actions = listOfNotNull(update.share?.label),
        )
    }

    /** The extensions of the files a recording writes into: JavaScript and TypeScript. */
    val SCRIPT_EXTENSIONS = setOf("ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts")

    /** Whether `path` is one of `configDirs`, the Playwright config folders, or inside one: where a recording may write. */
    fun inConfigDirs(path: Path?, configDirs: List<Path>): Boolean {
        val file = path?.let { runCatching { it.toAbsolutePath().normalize() }.getOrNull() } ?: return false
        return configDirs.any { dir -> runCatching { file.startsWith(dir.toAbsolutePath().normalize()) }.getOrDefault(false) }
    }

    /**
     * Whether New offers a recorded test on `folder`: a Playwright config's folder or one inside it, apart from
     * `node_modules` and a hidden folder (`.git`, `.idea`) below the config's.
     */
    fun newSpecFolder(folder: Path?, configDirs: List<Path>): Boolean {
        val dir = folder?.let { runCatching { it.toAbsolutePath().normalize() }.getOrNull() } ?: return false
        val config = configDirs.map { it.toAbsolutePath().normalize() }.filter { dir.startsWith(it) }.maxByOrNull { it.nameCount }
            ?: return false
        return config.relativize(dir).none { it.toString() == "node_modules" || it.toString().startsWith(".") }
    }

    /**
     * Where a recording started at a position writes, from where `piwi/pageCandidates` says the position is: outside
     * every test, function and class (`file`), a new test (`test`); anywhere else, the steps there (`steps`), which the
     * editor service refuses where they cannot go.
     */
    fun recordInto(context: String): String = if (context == "file") "test" else "steps"

    /**
     * The recorded block as the file holds it: the lines of `code`, each one that is not blank prefixed with `indent`,
     * the blank ones empty.
     */
    fun recordedBlock(code: String, indent: String): String =
        code.replace("\r\n", "\n").replace('\r', '\n').split('\n').joinToString("\n") { if (it.isBlank()) "" else indent + it }

    /** A first write of a recorded block: the range `[start, end)` of the text it replaces, what goes there, and where the block starts after it. */
    data class BlockWrite(val start: Int, val end: Int, val text: String, val blockStart: Int)

    /**
     * Where a recorded block is first written into a document's text, at `offset`: the start of the line the placement
     * names, followed through the edits since. A blank line there takes the block, unless `newLine`; otherwise the block
     * goes on a new line inserted there, pushing that line down. An offset within a line (at the end of a last line
     * with text, or after the line break before it was removed) puts the block on a new line after that line. A block
     * that takes the place of the text's last line is followed by a line break, so the file still ends with one.
     */
    fun firstBlockWrite(text: CharSequence, offset: Int, newLine: Boolean, block: String): BlockWrite {
        val at = offset.coerceIn(0, text.length)
        val lineStart = text.lastIndexOf('\n', at - 1) + 1
        val lineEnd = text.indexOf('\n', at).let { if (it < 0) text.length else it }
        if (lineStart != at) return BlockWrite(lineEnd, lineEnd, "\n" + block, lineEnd + 1)
        if (newLine || text.subSequence(lineStart, lineEnd).isNotBlank()) return BlockWrite(at, at, block + "\n", at)
        return BlockWrite(lineStart, lineEnd, if (lineEnd == text.length) block + "\n" else block, lineStart)
    }

    /** A change of a document's text: the `oldLength` characters at `offset` replaced with `text`. */
    data class TextChange(val offset: Int, val oldLength: Int, val text: String)

    /**
     * Where the start of line `line` of `text` (its end, past its last line) is once `changes` were made to it, in
     * order. A change before it moves it; one that ends on it moves it to that change's end; one that inserts at it, or
     * replaces text around it, leaves it after the last line break the change wrote, else at the change's start.
     */
    fun followLineStart(text: CharSequence, line: Int, changes: List<TextChange>): Int {
        var offset = 0
        var lines = 0
        while (lines < line && offset < text.length) {
            offset = text.indexOf('\n', offset).let { if (it < 0) text.length else it + 1 }
            lines++
        }
        for (change in changes) {
            val end = change.offset + change.oldLength
            offset = when {
                end < offset || (end == offset && change.oldLength > 0) -> offset + change.text.length - change.oldLength
                change.offset > offset -> offset
                else -> change.offset + change.text.lastIndexOf('\n') + 1
            }
        }
        return offset
    }

    /**
     * The offset in a document's text of a position the service names (0-based line and character), kept within the
     * text and the line; null without a position.
     */
    fun offsetOf(text: CharSequence, position: EditPosition?): Int? {
        position ?: return null
        var start = 0
        repeat(position.line.coerceAtLeast(0)) {
            val next = text.indexOf('\n', start)
            if (next < 0) return text.length
            start = next + 1
        }
        val end = text.indexOf('\n', start).let { if (it < 0) text.length else it }
        return (start + position.character.coerceAtLeast(0)).coerceAtMost(end)
    }

    /** Import lines written with a block, at `offset`: before the block's write (`first`) or after it, above the block. */
    data class ImportWrite(val offset: Int, val text: String, val first: Boolean)

    /**
     * How the import lines the service placed at `offset` of a document's text, before a block's `write`, are written
     * with it in one command: first when they come after the range the write replaces, so their offset holds; last
     * when they come at or before it, so they go above the block, which moves down by their length; not at all inside
     * that range. Null without an offset or a text.
     */
    fun importWrite(offset: Int?, text: String?, write: BlockWrite): ImportWrite? {
        if (offset == null || text.isNullOrEmpty()) return null
        return when {
            offset > write.end || (offset == write.end && write.end > write.start) -> ImportWrite(offset, text, first = true)
            offset <= write.start -> ImportWrite(offset, text, first = false)
            else -> null
        }
    }

    /** A quick fix on a recorded line's warning: another locator of the step, for the written one at `[start, end)` of the line. */
    data class LocatorChoice(val title: String, val locator: String, val start: Int, val end: Int)

    /**
     * The other locators the recorder verified for a step, best first, as quick fixes on `line`, the text of the line the
     * step is written on: each puts its locator in place of the written one (`RecordingStep.chosen`), which is found on
     * the line as it is written, after a page expression or inside a call. None when the step has a single locator, or
     * when the written one is not on the line exactly once.
     */
    fun locatorChoices(line: String, step: RecordingStep?): List<LocatorChoice> {
        val locators = step?.locators.orEmpty()
        val written = step?.chosen?.let { locators.getOrNull(it) }
        if (written.isNullOrEmpty() || locators.size < 2) return emptyList()
        val start = line.indexOf(written)
        if (start < 0 || line.indexOf(written, start + 1) >= 0) return emptyList()
        return locators.filter { it.isNotEmpty() && it != written }
            .map { LocatorChoice("Use $it", it, start, start + written.length) }
    }

    /** "1 step", "3 steps". */
    fun stepCount(steps: Int): String = if (steps == 1) "1 step" else "$steps steps"

    /** What the banner over a file a recording writes into offers. */
    enum class RecordingAction { STOP, PAUSE, RESUME, KEEP_EDITS }

    /** The banner over a file a recording writes into: what the recording does, and the actions it offers. */
    data class RecordingBanner(val text: String, val actions: List<RecordingAction>)

    /**
     * The banner of a recording in `state`, with `steps` written so far: while the browser opens, while recording, while
     * paused. Once the developer changed the recorded lines (`edited`), it offers to resume, which writes them again, or
     * to keep the edits, which ends the recording; once Stop is clicked (`stopping`), nothing. The service's `message`,
     * if any, follows.
     */
    fun recordingBanner(state: String?, steps: Int, edited: Boolean, stopping: Boolean, message: String?): RecordingBanner {
        val (text, actions) = when {
            stopping -> "Piwi: stopping the recording…" to emptyList()
            edited -> "Piwi: recording paused, since you changed the recorded lines. Resume writes them again from the browser." to
                listOf(RecordingAction.RESUME, RecordingAction.KEEP_EDITS)
            state == "starting" -> "Piwi: opening the browser to record into this file…" to listOf(RecordingAction.STOP)
            state == "paused" -> "Piwi: recording paused · ${stepCount(steps)}" to listOf(RecordingAction.RESUME, RecordingAction.STOP)
            else -> "Piwi is recording what you do in the browser · ${stepCount(steps)}" to
                listOf(RecordingAction.PAUSE, RecordingAction.STOP)
        }
        val note = message?.trim()?.ifEmpty { null }?.takeUnless { stopping }
        return RecordingBanner(if (note == null) text else "$text · $note", actions)
    }

    /** The status bar while a recording runs: its state and its step count. */
    fun recordingStatus(state: String?, steps: Int, edited: Boolean, stopping: Boolean): String = when {
        stopping -> "Piwi: stopping the recording"
        state == "starting" -> "Piwi: opening the browser"
        edited || state == "paused" -> "Piwi: recording paused · ${stepCount(steps)}"
        else -> "Piwi: recording · ${stepCount(steps)}"
    }

    /** The notification when a recording ends: why, if the service said, what was written where, and the warnings to check. */
    fun recordingSummary(steps: Int, warnings: Int, file: String, message: String?): String {
        val written = if (steps == 0) "Nothing was recorded into $file." else "Recorded ${stepCount(steps)} into $file."
        val check = when (warnings) {
            0 -> ""
            1 -> " 1 warning to check, on its line."
            else -> " $warnings warnings to check, on their lines."
        }
        return listOfNotNull(message?.trim()?.ifEmpty { null }, written + check).joinToString(" ")
    }

    /**
     * The name of a new spec file from what was typed: as typed when it ends with a script extension, `.ts` added after
     * `.spec` or `.test`, else `.spec.ts`. Null when it is blank or names a folder.
     */
    fun specFileName(input: String): String? {
        val name = input.trim()
        if (name.isEmpty() || '/' in name || '\\' in name || name.all { it == '.' }) return null
        return when {
            name.substringAfterLast('.', "").lowercase() in SCRIPT_EXTENSIONS -> name
            name.endsWith(".spec") || name.endsWith(".test") -> "$name.ts"
            else -> "$name.spec.ts"
        }
    }

    /** A test file's suffix, `.spec` or `.test` and its script extension (`.test.js` of `cart.test.js`); null for another file. */
    fun testFileSuffix(name: String): String? = SPEC_FILE.find(name)?.value

    /** A CI session's key: its context's folder and its run. */
    fun ciKey(session: CiSession): String = ciKey(session.root, session.runId)

    fun ciKey(root: String?, runId: Int): String = "${root.orEmpty()}\n$runId"

    /** The CI sessions kept, by `ciKey`, once `session` is heard: the latest of each run, one that ended dropped. */
    fun withCiSession(sessions: Map<String, CiSession>, session: CiSession): Map<String, CiSession> {
        val key = ciKey(session)
        return if (session.ended) sessions - key else sessions + (key to session)
    }

    /** A CI position at a line, as the editor marks it after the line's text: the words of each test there, joined. */
    data class CiMark(val line: Int, val text: String)

    /**
     * The CI positions in the file `uri` (as `Glue.sameFile` compares files): the call each running test of a CI run is
     * at there, one mark per line. Never a stop: nothing waits there.
     */
    fun ciMarksIn(sessions: Collection<CiSession>, uri: String): List<CiMark> {
        val lines = sortedMapOf<Int, MutableList<String>>()
        for (session in sessions) {
            for (test in session.tests.orEmpty()) {
                val at = test.at ?: continue
                if (test.status != "running" || !sameFile(at.uri, uri)) continue
                val texts = lines.getOrPut(at.line) { mutableListOf() }
                if (at.text !in texts) texts += at.text
            }
        }
        return lines.map { (line, texts) -> CiMark(line, texts.joinToString(" · ")) }
    }

    /** The files a CI position is in now. */
    fun ciMarkedFiles(sessions: Collection<CiSession>): Set<String> =
        sessions.flatMap { s -> s.tests.orEmpty().mapNotNull { it.at?.uri } }.toSet()

    /**
     * A row of the CI Runs tab: a run (`CI run #78`, its branch and progress), its **Open** on the dashboard, a test (its
     * name, then its project, attempt, worker and call, or its result), or a running test's **Watch** in the Worker tab
     * (`ci-watch`) and on the dashboard (`watch`). What a row opens: a CI lane in the Worker tab (`lane`), else a file at a
     * line (`uri`, `line`, `character`), else a page (`url`), else nothing. Its `key` stays as the rows move and its run
     * progresses, so the tab keeps it selected.
     */
    data class CiRow(
        val kind: String,
        val text: String,
        val detail: String,
        val status: String? = null,
        val uri: String? = null,
        val line: Int = 0,
        val character: Int = 0,
        val url: String? = null,
        val lane: CiLane? = null,
        val key: String = "",
    )

    /**
     * A lane of a CI run the Worker tab watches (`piwi/ciWatch`), as its `CiTest` names it (`lane` from 1, its shard),
     * and its view on the dashboard, the second choice where the IDE cannot show it.
     */
    data class CiLane(val root: String, val runId: Int, val shard: Int?, val lane: Int, val dashboard: String?)

    /** Whether a frame the service sent is of the CI lane the Worker tab asked to watch. */
    fun sameCiLane(watching: CiWatchParams, frame: CiFrame): Boolean =
        watching.root == frame.root && watching.runId == frame.runId && watching.shard == frame.shard && watching.lane == frame.lane

    /** Where a CI test runs: `worker 2`, `shard 1, worker 2`, or nothing for a run that names no lane. */
    private fun ciLane(lane: Int?, shard: Int?): String = when {
        lane == null -> ""
        shard != null -> "shard $shard, worker $lane"
        else -> "worker $lane"
    }

    private fun ciLane(test: CiTest): String = ciLane(test.lane, test.shard)

    /** The Worker tab's name while it watches a CI lane: `CI run #78 · worker 2`. */
    fun ciLaneTitle(lane: CiLane): String = "CI run #${lane.runId} · ${ciLane(lane.lane, lane.shard)}"

    /**
     * What the Worker tab says above a CI lane it watches, from the run's session (`sessions` by `ciKey`): the test
     * running in the lane and the call it is at, else that the lane is between tests, else that the run ended; always
     * read-only.
     */
    fun ciLaneCaption(sessions: Map<String, CiSession>, lane: CiLane): String {
        val name = ciLaneTitle(lane)
        val session = sessions[ciKey(lane.root, lane.runId)] ?: return "$name · the run ended."
        val test = session.tests.orEmpty().firstOrNull { it.status == "running" && it.lane == lane.lane && it.shard == lane.shard }
            ?: return "$name · between tests · read-only"
        val title = test.title.orEmpty().joinToString(" › ").replace(Regex("\\s+"), " ")
        val at = test.at?.let { " · ${it.title}" }.orEmpty()
        return "$name · Running $title$at · read-only"
    }

    /**
     * The CI Runs tab: each CI run of the branch, newest first, named as other runs are (`CI run #78`) with its
     * progress, then **Open run #78**, its tests and, under a running test of a run that can be watched, **Watch** in the
     * Worker tab and **Watch on the dashboard**. Read-only: no row pauses, steers, shares or holds the run.
     */
    fun ciRows(sessions: Collection<CiSession>): List<CiRow> = sessions.sortedByDescending { it.runId }.flatMap { session ->
        val key = ciKey(session)
        val head = CiRow(
            "run",
            session.name.ifEmpty { "CI run #${session.runId}" },
            listOfNotNull(session.branch, session.summary.ifEmpty { null }).joinToString(" · "),
            key = key,
        )
        val open = CiRow("open", "Open run #${session.runId}", "on the dashboard", url = session.url, key = "$key\nopen")
        val keys = HashSet<String>()
        val tests = session.tests.orEmpty().flatMapIndexed { index, test ->
            val running = test.status == "running"
            val detail = listOf(
                test.project,
                if (test.retry > 0) "retry ${test.retry}" else "",
                if (running) ciLane(test) else test.status,
                if (running) test.at?.title.orEmpty() else "",
            ).filter { it.isNotEmpty() }.joinToString(" · ")
            val name = test.title.orEmpty().joinToString(" › ").replace(Regex("\\s+"), " ")
            var testKey = "$key\n${test.uri.orEmpty()}\n${test.title.orEmpty().joinToString("\u001f")}\n${test.project}"
            if (!keys.add(testKey)) testKey = "$testKey\n$index"
            val at = test.at
            val row = when {
                at != null -> CiRow("test", name, detail, test.status, at.uri, at.line, at.character ?: 0, key = testKey)
                test.uri != null && test.line != null -> CiRow("test", name, detail, test.status, test.uri, test.line, key = testKey)
                else -> CiRow("test", name, detail, test.status, key = testKey)
            }
            val here = test.watch?.let { url ->
                test.lane?.let { lane ->
                    CiRow(
                        "ci-watch",
                        "Watch",
                        "${ciLane(test)} · read-only",
                        lane = CiLane(session.root.orEmpty(), session.runId, test.shard, lane, url),
                        key = "$testKey\nwatch-here",
                    )
                }
            }
            val watch = test.watch?.let { CiRow("watch", "Watch on the dashboard", "read-only", url = it, key = "$testKey\nwatch") }
            listOfNotNull(row, here, watch)
        }
        listOf(head, open) + tests
    }

    /** The most events the Worker tab lists, the newest first. */
    const val MAX_LANE_EVENTS = 50

    /** The call log's last lines the Worker tab shows under its image. */
    const val WAITS_LINES = 3

    /** The most images a test's filmstrip keeps (`MAX_FILMSTRIP` of `@piwitests/core/live-layers`). */
    const val MAX_FILMSTRIP = 40

    /** The longest page's text a layer carries, in characters (`MAX_LANE_TEXT` of `@piwitests/core/live-layers`). */
    const val MAX_LANE_TEXT = 96 * 1024

    /** The size an image of a filmstrip is made at most (`LANE_THUMB_WIDTH`, `LANE_THUMB_HEIGHT` of the same). */
    const val LANE_THUMB_WIDTH = 320
    const val LANE_THUMB_HEIGHT = 200

    /** The longest image of a filmstrip, in characters of base64 (`MAX_LANE_THUMB_BASE64` of the same). */
    private const val MAX_LANE_THUMB_BASE64 = 4 * ((128 * 1024 + 2) / 3)

    /**
     * A JPEG's width and height as its frame header (`SOF0` to `SOF15`) says, read from its markers without decoding
     * it; null for anything that is not a JPEG naming its size before its scan.
     */
    fun jpegSize(bytes: ByteArray): Pair<Int, Int>? {
        fun at(i: Int) = bytes[i].toInt() and 0xFF
        if (bytes.size < 4 || at(0) != 0xFF || at(1) != 0xD8) return null
        var i = 2
        while (i + 3 < bytes.size) {
            if (at(i) != 0xFF) return null
            val marker = at(i + 1)
            when {
                // Fill bytes before a marker.
                marker == 0xFF -> i++
                // A marker with no length: TEM, RSTn.
                marker == 0x01 || marker in 0xD0..0xD7 -> i += 2
                // The image ends, or its scan starts, before any frame header.
                marker == 0xD9 || marker == 0xDA -> return null
                else -> {
                    val length = (at(i + 2) shl 8) or at(i + 3)
                    if (length < 2) return null
                    // A frame header, all but DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
                    if (marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
                        if (length < 7 || i + 8 >= bytes.size) return null
                        return ((at(i + 7) shl 8) or at(i + 8)) to ((at(i + 5) shl 8) or at(i + 6))
                    }
                    i += 2 + length
                }
            }
        }
        return null
    }

    /**
     * The bytes of a filmstrip image as the Worker tab may decode them: a JPEG in base64 of the thumbnail's bound, whose
     * header names a size within twice `LANE_THUMB_WIDTH` by `LANE_THUMB_HEIGHT`, read before anything is decoded;
     * null for anything else.
     */
    fun stripImageBytes(data: String?): ByteArray? {
        if (data == null || data.length > MAX_LANE_THUMB_BASE64) return null
        val bytes = pausedImageBytes(PausedImage("image/jpeg", data, null, null)) ?: return null
        val (width, height) = jpegSize(bytes) ?: return null
        return bytes.takeIf { width in 1..2 * LANE_THUMB_WIDTH && height in 1..2 * LANE_THUMB_HEIGHT }
    }

    /**
     * The layers the Worker tab asks for (`piwi/laneView`'s and `piwi/ciWatch`'s `layers`): the call log and the page's
     * events always, the page's text and the filmstrip while their tab is selected.
     */
    fun laneLayersAsked(text: Boolean, filmstrip: Boolean): List<String> =
        listOfNotNull("calls", "events", "text".takeIf { text }, "filmstrip".takeIf { filmstrip })

    /** A time as the Worker tab says it: `120 ms`, `4.2 s`, `17 s`. */
    fun laneDuration(ms: Long): String = when {
        ms < 1000 -> "${maxOf(0L, ms)} ms"
        ms < 10_000 -> String.format(java.util.Locale.ROOT, "%.1f s", ms / 1000.0)
        else -> "${Math.round(ms / 1000.0)} s"
    }

    private val WEB_ADDRESS = Regex("^https?://[^/?#]+([^#]*)", RegexOption.IGNORE_CASE)

    /** An address as an event line shows it: its path and query on a web address, else as it came. */
    fun eventAddress(url: String): String = WEB_ADDRESS.find(url)?.groupValues?.get(1)?.ifEmpty { "/" } ?: url

    /**
     * Why the call the lane's test is in waits: the call and how it stands (`head`), what its locator matches while it
     * waits on one (`target`), the call log's last lines then the error it ended with (`lines`).
     */
    data class WaitsView(val head: String, val target: String?, val lines: List<String>, val failed: Boolean)

    private fun targetWords(target: LiveCallTarget?): String? {
        if (target == null) return null
        if (target.count == 0) return "No element matches yet"
        val state = when (target.enabled) { false -> "disabled"; true -> "enabled"; null -> null }
        if (target.count == 1) return "1 element matches" + (state?.let { ", $it" } ?: "")
        return "${target.count} elements match" + (state?.let { ", the first $it" } ?: "")
    }

    fun waitsView(log: LiveCallLog): WaitsView {
        val time = laneDuration(log.ms)
        val how = when (log.status) { "running" -> "waiting $time"; "passed" -> "done in $time"; else -> "failed after $time" }
        val lines = log.lines.orEmpty().takeLast(WAITS_LINES)
        return WaitsView(
            "${log.call?.title.orEmpty()} · $how",
            if (log.status == "running") targetWords(log.target) else null,
            if (log.error != null) lines + log.error else lines,
            log.status == "failed",
        )
    }

    /** A line of the Worker tab's events: `key` the same request's lines share, `level` `error`, `warning` or `info`. */
    data class EventLine(val key: String, val text: String, val level: String, val url: String?, val at: Long)

    /** What a page event says, as the Worker tab lists it; `n` keys a line no other replaces. */
    fun eventLine(event: PageEvent, at: Long, worker: Int, n: Int): EventLine {
        fun line(text: String, level: String, url: String? = null, key: String = "$n") = EventLine(key, text, level, url, at)
        val url = event.url.orEmpty()
        val what = "${event.method.orEmpty()} ${eventAddress(url)}"
        return when (event.kind) {
            "console" -> line("Console error: ${event.text.orEmpty()}", "error")
            "page-error" -> line("Uncaught error: ${event.text.orEmpty()}", "error")
            "request-failed" ->
                line("$what " + (event.status?.let { "answered $it" } ?: "failed: ${event.failure ?: "no answer"}"), "error", url)
            "request-pending" -> {
                val time = laneDuration(event.ms ?: 0)
                val done = event.done == true
                line(if (done) "$what answered after $time" else "$what pending $time", if (done) "info" else "warning", url, "pending $worker:${event.id}")
            }
            "backend" -> {
                val level = if (event.level == "warning") "warning" else "error"
                line("Backend $level on $what${event.status?.let { " ($it)" } ?: ""}: ${event.text.orEmpty()}", level, url)
            }
            "api" -> {
                val status = event.status
                if (event.failure != null || status == null) line("API $what failed: ${event.failure ?: "no answer"}", "error", url)
                else line("API $what answered $status in ${laneDuration(event.ms ?: 0)}", if (status >= 400) "error" else "info", url)
            }
            "dropped" -> line("${event.count ?: 0} more events were not sent: too many at once.", "warning")
            else -> line(event.text.orEmpty(), "info")
        }
    }

    /** An image of the lane's filmstrip: the call it ended, its title and its place in the strip, its JPEG in base64. */
    data class StripImage(val call: String, val title: String, val index: Int, val data: String)

    /** The page's text as the Worker tab shows it (`text`, `cut`, `source`), or why none came (`refused`). */
    data class LaneTextShown(val text: String?, val cut: Boolean, val source: String, val refused: String?)

    /**
     * The layers the Worker tab shows of its lane, as they came: of the test `test` (its id, or its title on a CI lane)
     * and the worker `worker` that runs it, the newest events first, how many were heard, the page's text, the filmstrip
     * in the order of the test's calls.
     */
    data class LaneLayersShown(
        val test: String?,
        val worker: Int?,
        val waits: WaitsView?,
        val events: List<EventLine>,
        val heard: Int,
        val text: LaneTextShown?,
        val strip: List<StripImage>,
    )

    val NO_LANE_LAYERS = LaneLayersShown(null, null, null, emptyList(), 0, null, emptyList())

    private val THUMB_DATA = Regex("^/9j/[A-Za-z0-9+/]*={0,2}$")

    /**
     * The layers shown with `layer` heard, and the parts it changed (`waits`, `events`, `text`, `strip`; none for an
     * image of a call the strip holds, as the worker sends the filmstrip again when the layers change). A layer of
     * another test, or of another worker (a retry runs in a new one), starts the call log and the filmstrip anew; so does
     * an image placed at or before the strip's last of a call it does not hold, another attempt's. A request's pending
     * time replaces its line, first again.
     */
    fun withLaneLayer(shown: LaneLayersShown, layer: LaneLayerFields): Pair<LaneLayersShown, Set<String>> {
        val changed = linkedSetOf<String>()
        var next = shown
        val test = layer.test
        val worker = layer.worker ?: shown.worker
        if ((test != null && test != shown.test) || worker != shown.worker) {
            if (shown.waits != null) changed += "waits"
            if (shown.strip.isNotEmpty()) changed += "strip"
            next = next.copy(test = test ?: shown.test, worker = worker, waits = null, strip = emptyList())
        }
        when (layer.layer) {
            "calls" -> layer.log?.let {
                next = next.copy(waits = waitsView(it))
                changed += "waits"
            }
            "events" -> layer.event?.let {
                val line = eventLine(it, layer.at ?: 0, worker ?: 0, next.heard + 1)
                next = next.copy(
                    events = (listOf(line) + next.events.filter { e -> e.key != line.key }).take(MAX_LANE_EVENTS),
                    heard = next.heard + 1,
                )
                changed += "events"
            }
            "text" -> {
                val text = layer.text
                val refused = layer.refused
                if (refused != null) next = next.copy(text = LaneTextShown(null, false, "", refused))
                else if (text != null) next = next.copy(text = LaneTextShown(text.text, text.cut, text.source, null))
                if (refused != null || text != null) changed += "text"
            }
            "filmstrip" -> {
                val thumb = layer.thumb
                val data = layer.data
                if (thumb != null && data != null && THUMB_DATA.matches(data) && next.strip.none { it.call == thumb.call }) {
                    val image = StripImage(thumb.call, thumb.title, thumb.index, data)
                    val kept = next.strip.takeIf { it.isEmpty() || image.index > it.last().index }.orEmpty()
                    next = next.copy(strip = (kept + image).takeLast(MAX_FILMSTRIP))
                    changed += "strip"
                }
            }
        }
        return next to changed
    }

    /** What the page's text tab says above the text: where it came from and whether it was cut, or why none came. */
    fun laneTextNote(text: LaneTextShown?): String = when {
        text == null -> "Nothing yet."
        text.refused != null -> text.refused
        else -> (if (text.source == "trace") "From the test’s trace." else "Read from the page.") +
            (if (text.cut) " Cut at ${MAX_LANE_TEXT / 1024} K characters." else "")
    }

    /** **Open the trace so far** in the Worker tab, and what its tooltip says it does. */
    const val OPEN_TRACE = "Open the trace so far"
    const val OPEN_TRACE_TITLE = "Open this test’s trace up to now in Playwright’s trace viewer, on the machine the run runs on"

    /**
     * Whether the Worker tab offers **Open the trace so far** for the worker in its slot: its reporter answers a trace
     * ask (`traces`) and it runs a test, as `canOpenTrace` of `@piwitests/run-model/stop` says for the Runs window.
     */
    fun canOpenTrace(worker: RunWorker?): Boolean = worker?.traces == true && worker.test != null

    /**
     * What the answer to **Open the trace so far** for the slot `asked` (a run's ref and a lane) says: as it is while the
     * Worker tab shows that slot (`shown`), else with the name of the worker it is for in front.
     */
    fun traceAnswerText(asked: Pair<String, Int>, shown: Pair<String, Int>?, message: String): String =
        if (shown == asked) message else "${workerName(asked.second)}: $message"

    /** The note over a lane whose reporter sends no layers; null when it sends them or the tab cannot tell. */
    fun laneLayersNote(worker: RunWorker?): String? =
        if (worker != null && !worker.layers) {
            "This worker’s reporter sends its images alone: update @piwitests/reporter to see why it waits, the page’s events, its text and the filmstrip."
        } else null

    /**
     * The note over a CI lane while none of its page's events, its text or its filmstrip came: neither the team instance
     * nor the CI run's reporter says whether it sends them, and an older one of either sends the images alone. Null once
     * one came.
     */
    fun ciLaneLayersNote(shown: LaneLayersShown): String? =
        if (shown.heard > 0 || shown.text != null || shown.strip.isNotEmpty()) null
        else "The page’s events, its text and the filmstrip show here as the CI run’s worker sends them: a team instance or a @piwitests/reporter older than the IDE’s sends the images alone."

    /**
     * The layers the Worker tab holds as asked once the service answered a change of them (`asked`): those it held,
     * unless the service refused the very change they are, which leaves none held, so the next change asks again.
     */
    fun layersAfterAnswer(held: List<String>, asked: List<String>, ok: Boolean): List<String> =
        if (ok || held != asked) held else emptyList()

    /**
     * Where `query` is next found in `text` from `from`, ignoring case, wrapping to the start; -1 for none or an empty
     * query. The Text tab's search.
     */
    fun findIn(text: String, query: String, from: Int): Int {
        if (query.isEmpty()) return -1
        val at = text.indexOf(query, from.coerceIn(0, text.length), ignoreCase = true)
        return if (at >= 0) at else text.indexOf(query, 0, ignoreCase = true)
    }
}
