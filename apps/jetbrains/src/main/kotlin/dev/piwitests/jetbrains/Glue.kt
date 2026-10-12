package dev.piwitests.jetbrains

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * What the plugin shows, computed from the editor service's answers, where it
 * looks for Playwright configs, and where a recording's lines go, with no
 * platform API, so it is tested without an IDE.
 */
object Glue {
    /** The files the editor service reads: test and application code, translations, and Razor views. */
    val SUPPORTED_EXTENSIONS = setOf(
        "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "html",
        "json", "yaml", "yml", "properties", "po", "resx", "cshtml", "razor",
    )

    val PLAYWRIGHT_CONFIGS = listOf(
        "playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs",
        "playwright.config.mts", "playwright.config.cts",
    )

    /** Whether a path, with either separator, names a Playwright config. */
    fun isPlaywrightConfig(path: String?): Boolean =
        path != null && path.substringAfterLast('/').substringAfterLast('\\') in PLAYWRIGHT_CONFIGS

    /**
     * Whether a folder created, removed, renamed or moved at `path` may hold a Playwright config the search finds: it is
     * under one of `roots`, at most [CONFIG_DEPTH] levels down, and neither it nor a folder above it is skipped.
     */
    fun mayHoldConfigs(path: String?, roots: List<Path>): Boolean {
        val dir = path?.let { runCatching { Path.of(it).toAbsolutePath().normalize() }.getOrNull() } ?: return false
        val root = roots.map { it.toAbsolutePath().normalize() }.firstOrNull { dir != it && dir.startsWith(it) } ?: return false
        val relative = root.relativize(dir)
        return relative.nameCount <= CONFIG_DEPTH && relative.none { it.toString().startsWith(".") || it.toString() in SKIPPED_DIRS }
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
        for (root in roots) {
            if (!Files.isDirectory(root)) continue
            Files.walkFileTree(root, emptySet(), CONFIG_DEPTH + 1, object : SimpleFileVisitor<Path>() {
                override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                    val name = dir.fileName?.toString() ?: return FileVisitResult.CONTINUE
                    val skipped = dir != root && (name.startsWith(".") || name in SKIPPED_DIRS)
                    return if (skipped) FileVisitResult.SKIP_SUBTREE else FileVisitResult.CONTINUE
                }

                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    if (attrs.isRegularFile && file.fileName.toString() in PLAYWRIGHT_CONFIGS) file.parent?.let { found.add(it) }
                    return FileVisitResult.CONTINUE
                }

                override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult = FileVisitResult.CONTINUE
            })
        }
        return found.sorted()
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
        val homeFolder = home?.toAbsolutePath()?.normalize()
        val repositories = outermost(roots.mapNotNull { repositoryRoot(it) }.filter { it != homeFolder && it.parent != null })
        if (repositories.isEmpty() || repositories == roots) return PlaywrightSearch(roots, dirs)
        val inRepositories = playwrightConfigDirs(repositories)
        return if (inRepositories.isEmpty()) PlaywrightSearch(roots, dirs) else PlaywrightSearch(repositories, inRepositories)
    }

    private val ACTIVE = setOf("running", "initializing", "finalizing")

    /**
     * What a click on the status bar item does: `REFRESH` reads the latest run again (`piwi/refreshRun`), `RETRY` reads
     * the instance again (Refresh), `NODE_SETTINGS` opens the Node.js settings, then starts the service again.
     */
    enum class StatusAction { REFRESH, RETRY, CONNECT, SETTINGS, NODE_SETTINGS, NONE }

    data class StatusView(val text: String, val tooltip: String, val url: String?, val action: StatusAction)

    private fun plural(n: Int, one: String, many: String = "${one}s") = "$n ${if (n == 1) one else many}"

    /** A run in progress in the status bar: `Piwi: 4/9 · 1 failing`, and ` · your run` for the editor's own. */
    private fun liveText(live: LiveRun): String {
        val failing = if (live.failed > 0) " · ${live.failed} failing" else ""
        return "Piwi: ${live.done}/${live.total}$failing" + if (live.own) " · your run" else ""
    }

    /** The tooltip's line on a run in progress: `Your run #124 is running: 4/9 · 1 failing`. */
    private fun liveLine(live: LiveRun): String {
        val failing = if (live.failed > 0) " · ${live.failed} failing" else ""
        return "\n${if (live.own) "Your run" else "Run"} #${live.runId} is running: ${live.done}/${live.total}$failing"
    }

    /** The status bar text while a click reads the latest run again. */
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
     * branch, the text counts it, and the tooltip has both, with the baseline chosen and when the latest run was read. A
     * click reads it again.
     * A null status means the service has not started: it starts with the first file of the project opened.
     */
    fun statusView(
        status: StatusResult?,
        runs: RunStatusResult?,
        desktopChosen: Boolean = false,
        now: Long = System.currentTimeMillis(),
        startProblem: String? = null,
    ): StatusView {
        if (status == null && startProblem != null) {
            return StatusView("Piwi: Node.js", "$startProblem\nClick to open the Node.js settings.", null, StatusAction.NODE_SETTINGS)
        }
        if (status == null) return StatusView("Piwi", "$NOT_STARTED Click for Piwi's settings.", null, StatusAction.SETTINGS)
        val contexts = status.contexts.orEmpty()
        if (contexts.isEmpty()) return StatusView("Piwi", "No Playwright config found", null, StatusAction.NONE)
        val hint = desktopHint(status, desktopChosen).let { if (it.isEmpty()) "" else "\n$it" }
        val connected = contexts.firstOrNull { it.connected }
        val unreachable = contexts.firstOrNull { it.problemKind == "unreachable" }
        if (connected == null && unreachable != null) {
            val problem = unreachable.problem ?: "The instance did not answer"
            return StatusView("Piwi: unreachable", "$problem\nPiwi reads it again on its own; click to read it now.$hint", null, StatusAction.RETRY)
        }
        connected
            ?: return StatusView("Piwi: connect", (contexts.first().problem ?: "Not connected") + hint, null, StatusAction.CONNECT)
        val run = runs?.contexts?.firstOrNull { it.root == connected.root } ?: runs?.contexts?.firstOrNull()
        val where = (connected.projectName ?: "Piwi") + (run?.branch?.let { " on $it" } ?: "") + (if (run?.run != null) fallbackNote(run) else "")
        val reporter = run?.reporterVersion?.let { "\nreporter $it" } ?: ""
        val from = (connected.serverUrl?.let { url -> "\n$url, from ${sourceLabel(connected.source)}" } ?: "") + reporter + hint
        val live = run?.live
        val baseline = baselineLine(run?.baseline?.label)?.let { "\n$it" } ?: ""
        val progress = (live?.let { liveLine(it) } ?: "") + updatedLine(run, now)
        val overlays = run?.overlays ?: 0
        val r = run?.run
        if (r == null && overlays > 0) {
            // A developer's own runs alone, with no baseline.
            val failing = run?.failingTests ?: run?.failures ?: 0
            val text = live?.let { liveText(it) } ?: if (failing > 0) "Piwi: $failing failing" else "Piwi: no failure"
            val tooltip = "${plural(overlays, "local run")} of $where, ${plural(failing, "test")} failing$baseline$progress$from"
            return StatusView(text, tooltip, null, StatusAction.REFRESH)
        }
        if (r == null) {
            return StatusView(live?.let { liveText(it) } ?: "Piwi: no run", "No run of $where yet$baseline$progress$from", null, StatusAction.REFRESH)
        }
        // The tests still failing once the later runs are laid over the run; the run's own count from an older service.
        val failing = run.failingTests ?: r.failedTests
        val fixed = run.resolved ?: 0
        val local = if (overlays > 0) "\n${plural(overlays, "local run")} since · ${plural(fixed, "test")} fixed locally" else ""
        val tooltip = "Run #${r.id} of $where: ${r.passedTests} passed, ${r.failedTests} failed, " +
            "${r.flakyTests} flaky, ${r.skippedTests} skipped$baseline$local$progress$from"
        val flaky = if (r.flakyTests > 0) " · ${r.flakyTests} flaky" else ""
        val refresh = StatusAction.REFRESH
        return when {
            live != null -> StatusView(liveText(live), tooltip, r.url, refresh)
            r.status in ACTIVE -> {
                val done = r.passedTests + r.failedTests + r.flakyTests + r.skippedTests
                val failed = if (r.failedTests > 0) " · ${r.failedTests} failing" else ""
                StatusView("Piwi: $done/${r.totalTests}$failed", tooltip, r.url, refresh)
            }
            failing > 0 -> {
                val fixedText = if (fixed > 0) " · $fixed fixed locally" else ""
                StatusView("Piwi: $failing failing$fixedText$flaky", tooltip, r.url, refresh)
            }
            r.status != "passed" && r.status != "failed" -> StatusView("Piwi: ${r.status}", tooltip, r.url, refresh)
            fixed > 0 -> StatusView("Piwi: $fixed fixed locally", tooltip, r.url, refresh)
            else -> StatusView("Piwi: ${r.passedTests} passed$flaky", tooltip, r.url, refresh)
        }
    }

    const val NOT_STARTED = "Piwi starts when you open a file of this project."

    /** The oldest Node.js major version the editor service runs on. */
    const val NODE_MAJOR = 20

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

    /** Whether a `piwi/failures` item is a failure whose line changed since its run. */
    fun isEdited(failure: WorkspaceFailure) = failure.state == "edited"

    /**
     * What a `piwi/failures` item says about its run, beside its title: `fixed locally in run #124` for a failure a
     * later run passed (`fixed in run #124` when that run is a CI run, `fixed locally in your run #124` when the editor
     * started it), `edited since run #120` for a failure whose line changed since its run (`edited since your run
     * #124`, `edited since local run #124`), `your run #124` for a failure of a run the editor started, `local run
     * #124` for a failure of another run that did not run in CI; null otherwise, and from an older service.
     */
    fun failureRunNote(failure: WorkspaceFailure): String? {
        val run = when (failure.source) {
            "own" -> "your run #${failure.runId}"
            "local" -> "local run #${failure.runId}"
            else -> null
        }
        return when {
            isFixedLocally(failure) -> when (failure.source) {
                "ci" -> "fixed in run #${failure.runId}"
                "own" -> "fixed locally in your run #${failure.runId}"
                else -> "fixed locally in run #${failure.runId}"
            }
            isEdited(failure) -> "edited since ${run ?: "run #${failure.runId}"}"
            else -> run
        }
    }

    /** How the failures tool window groups the failures under the run: `file`, `cluster`, `owner` or `flat`. */
    val FAILURE_GROUPINGS = listOf("file", "cluster", "owner", "flat")

    /**
     * A node of the failures tree. `kind` is `run`, `runs` (the runs laid over it), `overlay`, `group` or `failure`;
     * `key` stays the same across refreshes, so the tree keeps a node's expansion and selection by it; `icon` is
     * `error`, `edited` or `fixed` for a failure, `folder` for a group, `run` and `history` for the runs; `expanded`
     * is whether a node with children opens expanded; `url` is the page a run opens, a failure's execution page.
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
        val children: List<FailureNode> = emptyList(),
    )

    private val STATE_ORDER = mapOf("failing" to 0, "edited" to 1, "fixed-locally" to 2)

    /** What launched a run, in a few words: `CI`, `your run`, `local`, `desktop app`, `editor`. */
    private fun originLabel(origin: String?, own: Boolean?): String = when {
        own == true -> "your run"
        origin == null || origin == "ci" || origin == "ci-rerun" -> "CI"
        origin == "desktop" -> "desktop app"
        else -> origin
    }

    /** The test a failure stands for: its id, else its title in its file. */
    private fun testKey(f: WorkspaceFailure): String = f.testCaseId?.toString() ?: "${f.file ?: f.uri}\n${f.title}"

    /** `3 failing · 1 fixed locally`, counting tests: a test failing on several projects counts once. */
    private fun failureCounts(items: List<WorkspaceFailure>): String {
        val failing = items.filterNot { isFixedLocally(it) }.map { testKey(it) }.toSet().size
        val fixed = items.filter { isFixedLocally(it) }.map { testKey(it) }.toSet().size
        return listOfNotNull(
            if (failing > 0 || fixed == 0) "$failing failing" else null,
            if (fixed > 0) "$fixed fixed locally" else null,
        ).joinToString(" · ")
    }

    /** How many tests still fail, edited since their run or not: the tool window's title counts them. */
    fun failingCount(result: FailuresResult?): Int =
        result?.items.orEmpty().filterNot { isFixedLocally(it) }.map { testKey(it) }.toSet().size

    private fun fileName(uri: String?): String =
        java.net.URLDecoder.decode((uri ?: "").substringAfterLast('/').replace("+", "%2B"), Charsets.UTF_8)

    /** Where a failure shows, at its line: the spec's path when it shows in the spec, else the file's name. */
    fun failurePlace(f: WorkspaceFailure): String {
        val decoded = java.net.URLDecoder.decode((f.uri ?: "").replace("+", "%2B"), Charsets.UTF_8)
        val shown = f.file?.takeIf { decoded.endsWith("/$it") } ?: fileName(f.uri)
        return "$shown:${f.line + 1}"
    }

    private fun failureLeaf(f: WorkspaceFailure): FailureNode = FailureNode(
        key = "failure:${f.executionId}",
        kind = "failure",
        label = f.title ?: "Failed",
        description = listOfNotNull(
            failurePlace(f),
            f.browserName,
            if (f.isNew == true && !isFixedLocally(f)) "new" else null,
        ).joinToString(" · "),
        icon = when {
            isFixedLocally(f) -> "fixed"
            isEdited(f) -> "edited"
            else -> "error"
        },
        expanded = false,
        url = f.url,
        failure = f,
    )

    private fun sortFailures(items: List<WorkspaceFailure>): List<WorkspaceFailure> = items.sortedWith(
        compareBy<WorkspaceFailure>({ STATE_ORDER[it.state ?: "failing"] ?: 0 }, { it.file ?: it.uri ?: "" }, { it.line }, { it.title ?: "" }),
    )

    /** The group a failure goes in: its key, which ends with `:` for the failures without a value, and its label. */
    private fun groupOf(f: WorkspaceFailure, grouping: String): Pair<String, String> = when (grouping) {
        "cluster" -> f.clusterId?.let { "cluster:$it" to (f.clusterTitle?.ifBlank { null } ?: "Cluster #$it") }
            ?: ("cluster:" to "Ungrouped")
        "owner" -> f.owner?.ifBlank { null }?.let { "owner:$it" to it } ?: ("owner:" to "Unowned")
        else -> (f.file ?: fileName(f.uri)).let { "file:$it" to it }
    }

    private fun grouped(items: List<WorkspaceFailure>, grouping: String): List<FailureNode> {
        if (grouping == "flat") return sortFailures(items).map { failureLeaf(it) }
        return items.groupBy { groupOf(it, grouping) }.entries
            .sortedWith(compareBy({ it.key.first.endsWith(":") }, { it.key.second }))
            .map { (group, members) ->
                FailureNode(
                    key = "group:${group.first}",
                    kind = "group",
                    label = group.second,
                    description = failureCounts(members),
                    icon = "folder",
                    expanded = true,
                    url = null,
                    children = sortFailures(members).map { failureLeaf(it) },
                )
            }
    }

    /**
     * The failures tree, as VS Code's view draws it: the latest complete run (`Run #120 · CI · feature/x · 3 failing ·
     * 1 fixed locally`, its age, or the editor's own run in progress, as its description), the runs laid over it under
     * `Your runs since`, and its failures grouped by `file`, `cluster` or `owner`, or `flat`, failing first, then
     * edited, then fixed locally. With a developer's own runs alone, the root is `Your local runs`. Without a run (an
     * older service), the groups alone; without a failure, nothing.
     */
    fun failureTree(result: FailuresResult?, grouping: String, now: Long = System.currentTimeMillis(), live: LiveRun? = null): List<FailureNode> {
        val items = result?.items.orEmpty()
        if (items.isEmpty()) return emptyList()
        val groups = grouped(items, grouping)
        val run = result?.run
        val overlays = result?.overlays.orEmpty()
        val baseline = baselineLine(result?.baseline?.label)
        if (run == null && (baseline == null || overlays.isEmpty())) return groups
        val runs = if (overlays.isEmpty()) emptyList() else listOf(
            FailureNode(
                key = "runs",
                kind = "runs",
                label = if (run != null) "Your runs since" else "Your runs",
                description = plural(overlays.size, "run"),
                icon = "history",
                expanded = false,
                url = null,
                children = overlays.map { o ->
                    FailureNode(
                        key = "overlay:${o.id}",
                        kind = "overlay",
                        label = listOfNotNull(
                            "#${o.id}",
                            if (o.own == true) "your run" else null,
                            o.startTime?.let { relativeTime(it, now) },
                            "${o.passedTests} passed, ${o.failedTests} failed",
                        ).joinToString(" · "),
                        description = "",
                        icon = if (o.failedTests > 0) "error" else "fixed",
                        expanded = false,
                        url = o.url,
                    )
                },
            ),
        )
        val running = live?.takeIf { it.own }
        if (run == null) {
            return listOf(
                FailureNode(
                    key = "run",
                    kind = "run",
                    label = "Your local runs · ${failureCounts(items)}",
                    description = running?.let { "running ${it.done}/${it.total}" } ?: "no baseline",
                    icon = "run",
                    expanded = true,
                    url = null,
                    children = runs + groups,
                ),
            )
        }
        return listOf(
            FailureNode(
                key = "run",
                kind = "run",
                label = listOfNotNull("Run #${run.id}", originLabel(run.origin, run.own), run.branch, failureCounts(items))
                    .joinToString(" · "),
                description = running?.let { "running ${it.done}/${it.total}" } ?: run.startTime?.let { relativeTime(it, now) } ?: "",
                icon = "run",
                expanded = true,
                url = run.url,
                children = runs + groups,
            ),
        )
    }

    /**
     * Whether two failure trees hold the same nodes in the same places, by key, all the way down: then only what the
     * nodes say changed, such as a run in progress counting its tests, and the tree keeps its rows as they are.
     */
    fun sameShape(a: List<FailureNode>, b: List<FailureNode>): Boolean =
        a.size == b.size && a.indices.all { a[it].key == b[it].key && sameShape(a[it].children, b[it].children) }

    /**
     * The tool window's line on the run and the baseline: `Run #120 · CI · feature/x · 3 failing · 1 fixed locally · 4 min
     * ago · Baseline: CI run #120 on feature/x`; `Your local runs · 1 failing · Baseline: your local runs only` with a
     * developer's own runs alone; the baseline alone when it found no run.
     */
    fun runHeader(result: FailuresResult?, now: Long = System.currentTimeMillis()): String? {
        val baseline = baselineLine(result?.baseline?.label)
        val run = result?.run
        val items = result?.items.orEmpty()
        val parts = when {
            run != null -> listOfNotNull(
                "Run #${run.id}",
                originLabel(run.origin, run.own),
                run.branch,
                failureCounts(items),
                run.startTime?.let { relativeTime(it, now) },
            )
            !result?.overlays.isNullOrEmpty() -> listOf("Your local runs", failureCounts(items))
            else -> emptyList()
        }
        return (parts + listOfNotNull(baseline)).ifEmpty { null }?.joinToString(" · ")
    }

    /** The baseline a context compares with, as the tooltip and the tool window name it: `Baseline: CI run #120 on main`. */
    fun baselineLine(label: String?): String? = label?.ifBlank { null }?.let { "Baseline: $it" }

    /** An entry of **Compare With…**: a baseline, or, with a null `choice`, a run by its id, asked for first. */
    data class BaselineEntry(val label: String, val detail: String, val current: Boolean, val choice: BaselineChoice?)

    /**
     * What **Compare With…** offers for a context, as VS Code's Compare with… does: the ladder (`CI on the checked-out
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

    /** The run id typed for **A run by id…** (`118` or `#118`); null when it is not one. */
    fun runIdOf(text: String?): Int? =
        Regex("^\\s*#?(\\d{1,9})\\s*$").find(text.orEmpty())?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it > 0 }

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

    /**
     * What **Re-run the Failing Tests** runs: every test still failing or edited since its run, one run per Playwright
     * config (`WorkspaceFailure.root`), in the order of their first failure; none when none fails.
     */
    fun rerunFailingArgs(result: FailuresResult?): List<RunTestsArgs> =
        result?.items.orEmpty()
            .filter { !isFixedLocally(it) && it.testCaseId != null && it.uri != null }
            .groupBy { it.root.orEmpty() }
            .map { (_, failures) ->
                RunTestsArgs(failures.first().uri!!, failures.mapNotNull { it.testCaseId }.distinct(), root = failures.first().root)
            }

    /** What **Run This Test** runs for a failure: its test, from the Playwright config it belongs to. */
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

    /** A test's gutter tooltip: its latest result, then its history as the service sums it up. */
    fun testResultTooltip(status: String?, title: String?): String {
        val result = when (status) {
            "failed" -> "failing"
            "flaky" -> "flaky"
            "passed" -> "passing"
            "skipped" -> "skipped"
            "running" -> "running"
            else -> "no recent result"
        }
        return listOfNotNull("Piwi: $result", title?.ifBlank { null }).joinToString(" · ")
    }

    /**
     * The tooltip of a test's failing line: why it failed, and the error without its stack; with `edited`, that the
     * line changed since the run.
     */
    fun failureTooltip(headline: String?, message: String?, edited: Boolean = false): String {
        val escape = { text: String -> text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") }
        val why = headline?.ifBlank { null } ?: "Failed"
        val details = message?.trim()?.ifBlank { null }?.takeIf { it != why }?.let { "<pre>${escape(it)}</pre>" } ?: ""
        val title = if (edited) "Piwi: failed here, edited since the run" else "Piwi: failed here"
        return "<html><b>$title</b><br>${escape(why)}$details</html>"
    }

    /** When a run the editor started says what it changed: `always`, `failures` (only when something fails), `never`. */
    val RUN_NOTIFICATIONS = listOf("always", "failures", "never")

    const val OPEN_FAILURES = "Open the Failures"
    const val OPEN_IN_DASHBOARD = "Open in Dashboard"
    const val RERUN_FAILING = "Re-run Failing"

    /** A run's verdict: a warning when something fails, its sentence, and the actions it offers. */
    data class RunVerdict(val warning: Boolean, val text: String, val actions: List<String>)

    private fun titleList(titles: List<String>, count: Int): String {
        val more = count - titles.size
        return "(${titles.joinToString(", ")}${if (more > 0) " and $more more" else ""})"
    }

    /**
     * What a run the editor started changed, once it ended: `run #124 · 1 of 3 CI failures fixed, 2 still failing
     * (login.spec.ts › logs in, checkout.spec.ts › pays)`, then its new failures, else its counts; a warning with
     * **Re-run Failing** when something fails. Null when `setting` keeps it quiet.
     */
    fun runVerdict(ended: RunEnded, setting: String = "always"): RunVerdict? {
        val stillTitles = ended.stillFailing.orEmpty()
        val newTitles = ended.newFailures.orEmpty()
        val still = ended.stillFailingCount ?: stillTitles.size
        val added = ended.newFailureCount ?: newTitles.size
        val parts = mutableListOf<String>()
        if (ended.fixed > 0 || still > 0) {
            val total = ended.fixed + still
            val fixed = "${ended.fixed} of $total CI ${if (total == 1) "failure" else "failures"} fixed"
            parts += if (still > 0) "$fixed, $still still failing ${titleList(stillTitles, still)}" else fixed
        }
        if (added > 0) parts += "${plural(added, "new failure")} ${titleList(newTitles, added)}"
        if (parts.isEmpty()) {
            parts += listOfNotNull(
                "${ended.passed} passed",
                "${ended.failed} failed",
                if (ended.flaky > 0) "${ended.flaky} flaky" else null,
                if (ended.skipped > 0) "${ended.skipped} skipped" else null,
            ).joinToString(", ")
        }
        val failing = still + added > 0 || ended.failed > 0
        if (setting == "never" || (setting == "failures" && !failing)) return null
        return RunVerdict(
            failing,
            "Run #${ended.runId} · ${parts.joinToString(" · ")}",
            listOfNotNull(OPEN_FAILURES, OPEN_IN_DASHBOARD, if (failing) RERUN_FAILING else null),
        )
    }

    /** Where the service found the instance, in the words of the settings page. */
    fun sourceLabel(source: String?): String = when (source) {
        "environment" -> "the environment (PIWI_DASHBOARD_URL)"
        "dotenv" -> "the workspace .env"
        "desktop" -> "the Piwi desktop app"
        else -> "Settings → Tools → Piwi"
    }

    /** One sentence on the connection, for the tool window and the settings page. */
    fun connectionSummary(status: StatusResult?, desktopChosen: Boolean = false, startProblem: String? = null): String {
        if (status == null) return startProblem ?: NOT_STARTED
        val contexts = status.contexts.orEmpty()
        if (contexts.isEmpty()) return "No Playwright config found in this project."
        val hint = desktopHint(status, desktopChosen).let { if (it.isEmpty()) "" else " $it" }
        val unreachable = contexts.firstOrNull { it.problemKind == "unreachable" }
        val c = contexts.firstOrNull { it.connected }
            ?: return if (unreachable != null) {
                "Not connected. ${unreachable.problem ?: ""} Piwi reads it again on its own.$hint"
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
     * An `mcpServers` entry per instance, bridged to stdio with `mcp-remote` so every
     * MCP client takes it (the JetBrains AI Assistant's settings, Junie, Claude Desktop).
     * The key travels in `env`, never on the command line.
     */
    fun mcpConfiguration(servers: List<McpServerDefinition>): String {
        val entries = servers.mapIndexed { i, s ->
            val name = if (i == 0) "piwi" else "piwi-${i + 1}"
            val auth = s.headers?.get("Authorization")
            val args = mutableListOf("\"-y\"", "\"mcp-remote\"", jsonString(s.url ?: ""))
            if (auth != null) args += listOf("\"--header\"", "\"Authorization:\${PIWI_AUTH}\"")
            val env = if (auth != null) ",\n      \"env\": { \"PIWI_AUTH\": ${jsonString(auth)} }" else ""
            "    ${jsonString(name)}: {\n      \"command\": \"npx\",\n      \"args\": [${args.joinToString(", ")}]$env\n    }"
        }
        return "{\n  \"mcpServers\": {\n${entries.joinToString(",\n")}\n  }\n}"
    }

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

    /** The arguments of an `npx playwright test …` command, for the IDE's Playwright runner; null for any other command. */
    fun playwrightTestArgs(command: String): List<String>? {
        val parts = splitCommand(command)
        return if (parts.take(3) == listOf("npx", "playwright", "test")) parts.drop(3) else null
    }

    /** The name of the IDE's run configuration for a run: its first test file (with its line), and how many more. */
    fun playwrightRunName(args: List<String>): String {
        val targets = args.filter { TEST_FILE_ARG.matches(it) }
        val first = targets.firstOrNull()?.substringAfterLast('/') ?: return "Piwi"
        return if (targets.size > 1) "Piwi: $first and ${targets.size - 1} more" else "Piwi: $first"
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

    /** Where a locator picked at a breakpoint went: on its line, or to the caret because the line or the file has none. */
    enum class PickOutcome { REPLACED, NO_LOCATOR, NO_FILE }

    /** What the notification says once a locator picked while a run was paused at a breakpoint reached the IDE. */
    fun pickNotice(at: SendPlace, outcome: PickOutcome): String {
        val name = at.file.substringAfterLast('/')
        return when (outcome) {
            PickOutcome.REPLACED -> "The picked locator replaced the one at line ${at.line} of $name."
            PickOutcome.NO_LOCATOR -> "The picked locator was inserted at the caret: line ${at.line} of $name holds no locator anymore."
            PickOutcome.NO_FILE -> "The picked locator was inserted at the caret: ${at.file} is not in this project."
        }
    }

    /** A line breakpoint of the IDE: its file's path on disk and its 0-based line. */
    data class BreakpointAt(val path: String, val line: Int)

    private val SCRIPT_FILE = Regex("\\.[cm]?[jt]sx?$", RegexOption.IGNORE_CASE)

    /**
     * The breakpoints a run started from Piwi pauses at: those in JavaScript or TypeScript files under one of `roots`
     * (the Playwright configs' folders), as the service takes them.
     */
    fun runBreakpoints(breakpoints: List<BreakpointAt>, roots: List<String>): List<EditorBreakpoint> {
        val rootPaths = roots.mapNotNull { runCatching { Path.of(it).toAbsolutePath().normalize() }.getOrNull() }
        return breakpoints.mapNotNull { b ->
            val file = runCatching { Path.of(b.path).toAbsolutePath().normalize() }.getOrNull() ?: return@mapNotNull null
            val under = rootPaths.any { root -> file != root && file.startsWith(root) }
            if (b.line < 0 || !SCRIPT_FILE.containsMatchIn(file.fileName?.toString() ?: "") || !under) null
            else EditorBreakpoint(file.toUri().toString(), b.line)
        }
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
        ) : OpenRequest()

        data class Refused(val error: String) : OpenRequest()
    }

    const val MAX_OPEN_PATH = 4096

    /** Why a path given to Open in IDE is refused, or null when it is acceptable. */
    private fun refusedPath(name: String, path: String): String? = when {
        path.length > MAX_OPEN_PATH -> "$name is at most $MAX_OPEN_PATH characters"
        '\u0000' in path -> "$name must not contain a NUL character"
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
        val line = last("line")
        val lineNumber = line?.toIntOrNull()
        if (line != null && (lineNumber == null || lineNumber < 1)) return OpenRequest.Refused("line must be a positive integer")
        val column = last("column")
        val columnNumber = column?.toIntOrNull()
        if (column != null && (columnNumber == null || columnNumber < 1)) return OpenRequest.Refused("column must be a positive integer")
        // `?check` and `?check=1` ask for a check; `?check=0` does not.
        val check = query["check"]?.lastOrNull()?.trim()?.let { it != "0" && it != "false" } ?: query.containsKey("check")
        return OpenRequest.File(path, lineNumber, columnNumber, check, last("project"), root)
    }

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

    /**
     * A block of code re-indented to sit at a line indented with `indent`: its common
     * leading indentation removed, then `indent` added to every line after the first.
     */
    fun indentBlock(code: String, indent: String): String {
        val lines = code.trimEnd().split("\n")
        val common = lines.filter { it.isNotBlank() }.minOfOrNull { it.length - it.trimStart().length } ?: 0
        return lines.mapIndexed { i, line ->
            val stripped = if (line.isBlank()) "" else line.substring(common)
            if (i == 0 || stripped.isEmpty()) stripped else indent + stripped
        }.joinToString("\n")
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

    /** Import lines to insert into a document's text at `offset`. */
    data class ImportInsertion(val offset: Int, val text: String)

    /**
     * The import lines of `imports` a document's text lacks, and where they go: after its last top-level `import`
     * statement, else at its top, followed by an empty line. A line is left out when the file holds the same statement,
     * whatever its spacing, its quotes and its final semicolon.
     */
    fun importInsertion(text: CharSequence, imports: List<String>): ImportInsertion? {
        val statements = importStatements(text)
        val held = statements.map { importKey(it.text) }.toSet()
        val missing = imports.map { it.replace("\r\n", "\n").replace('\r', '\n').trim() }
            .filter { it.isNotEmpty() && importKey(it) !in held }
            .distinctBy { importKey(it) }
        if (missing.isEmpty()) return null
        val last = statements.lastOrNull()
        if (last != null) return ImportInsertion(last.end, "\n" + missing.joinToString("\n"))
        val firstLine = text.subSequence(0, text.indexOf('\n').let { if (it < 0) text.length else it })
        return ImportInsertion(0, missing.joinToString("\n") + "\n" + if (firstLine.isBlank()) "" else "\n")
    }

    /** A top-level `import` statement: its text, over one line or more, and the offset its last line ends at. */
    private data class ImportStatement(val text: String, val end: Int)

    private val IMPORT_START = Regex("^import(?=[\\s{*'\"])")
    private val IMPORT_COMPLETE = Regex("\\bfrom\\s*['\"]|^import\\s*['\"]|=\\s*require\\s*\\(|;\\s*$")

    /** The top-level `import` statements of a text, in order: those starting a line, followed to their module. */
    private fun importStatements(text: CharSequence): List<ImportStatement> {
        val lines = text.split('\n')
        val found = mutableListOf<ImportStatement>()
        var start = 0
        var i = 0
        while (i < lines.size) {
            if (!IMPORT_START.containsMatchIn(lines[i])) {
                start += lines[i].length + 1
                i++
                continue
            }
            var statement = lines[i]
            var end = start + lines[i].length
            var j = i
            while (!IMPORT_COMPLETE.containsMatchIn(statement) && j + 1 < lines.size && j - i < 50) {
                j++
                statement += "\n" + lines[j]
                end += 1 + lines[j].length
            }
            found += ImportStatement(statement, end)
            start = end + 1
            i = j + 1
        }
        return found
    }

    /** An `import` statement compared regardless of its spacing, its quotes and its final semicolon. */
    private fun importKey(statement: String): String =
        statement.replace(Regex("\\s+"), "").replace('"', '\'').removeSuffix(";")

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
        else -> "Piwi: ● recording · ${stepCount(steps)}"
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
}
