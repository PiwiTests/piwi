package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

class GlueTest {
    private val connected = StatusResult(
        listOf(ContextStatus(
            root = "/w", connected = true, serverUrl = "http://piwi", source = "dotenv", projectId = 7, projectName = "Acme",
            branch = "main",
        )),
    )

    private fun runs(run: RunInfo?) = RunStatusResult(listOf(RunStatus(root = "/w", branch = "feature/pay", run = run)))

    private val passed = RunInfo(
        id = 41, status = "passed", totalTests = 120, passedTests = 118, flakyTests = 2, url = "http://piwi/test-runs/41",
    )

    @Test
    fun `before the service starts, says when it will and leads to the settings`() {
        val view = Glue.statusView(null, null)
        assertEquals("Piwi", view.text)
        assertEquals(Glue.StatusAction.SETTINGS, view.action)
        assertEquals(Glue.NOT_STARTED, Glue.connectionSummary(null))
    }

    @Test
    fun `once the service that ran stopped, says Piwi is not running and offers to restart it`() {
        assertEquals(
            Glue.StatusView("Piwi: not running", Glue.SERVICE_STOPPED_TOOLTIP, null, Glue.StatusAction.RESTART, Glue.StatusIcon.WARNING),
            Glue.statusView(null, null, stopped = true),
        )
        assertEquals(Glue.NOT_RUNNING, Glue.connectionSummary(null, stopped = true))
        // The tool window's header says it too, as its connection link.
        assertEquals(Glue.NOT_RUNNING, Glue.toolWindowHeader(null, null, stopped = true).connection)
        // Trust and a start that failed say more than that it stopped.
        assertEquals("Piwi: waiting for trust", Glue.statusView(null, null, trusted = false, stopped = true).text)
        assertEquals(Glue.StatusAction.NODE_SETTINGS, Glue.statusView(null, null, startProblem = "no node", stopped = true).action)
        assertEquals("no node", Glue.connectionSummary(null, startProblem = "no node", stopped = true))
        // A service that answers again is drawn from its status.
        assertEquals("Piwi", Glue.statusView(StatusResult(emptyList()), null, stopped = true).text)
    }

    @Test
    fun `a project in safe mode says Piwi waits for its trust, wherever the connection shows`() {
        val view = Glue.statusView(null, null, startProblem = "Node.js 18 is too old", trusted = false)
        assertEquals("Piwi: waiting for trust", view.text)
        assertEquals(Glue.WAITING_FOR_TRUST, view.tooltip)
        assertEquals(Glue.StatusIcon.WARNING, view.icon)
        assertEquals(Glue.StatusAction.NONE, view.action)
        assertEquals(Glue.WAITING_FOR_TRUST, Glue.connectionSummary(null, trusted = false))
        assertEquals(Glue.NOT_STARTED, Glue.connectionSummary(null, trusted = true))
    }

    @Test
    fun `without a Playwright config, says so`() {
        assertEquals("Piwi", Glue.statusView(StatusResult(emptyList()), null).text)
    }

    @Test
    fun `when not connected, offers Connect with the reason`() {
        val view = Glue.statusView(StatusResult(listOf(ContextStatus(root = "/w", problem = "No project chosen."))), null)
        assertEquals(Glue.StatusView("Piwi: connect", "No project chosen.", null, Glue.StatusAction.CONNECT, Glue.StatusIcon.CONNECT), view)
    }

    @Test
    fun `the first-run notification shows once, in a trusted project with a Playwright config that nothing connects`() {
        val dirs = listOf(Path.of("/w/e2e"))
        assertEquals(true, Glue.showsFirstRun(shown = false, trusted = true, configDirs = dirs, status = null, instances = listOf(null, "")))
        assertEquals("once per installation", false, Glue.showsFirstRun(true, true, dirs, null, emptyList()))
        assertEquals("never in an untrusted project", false, Glue.showsFirstRun(false, false, dirs, null, emptyList()))
        assertEquals("not without a config", false, Glue.showsFirstRun(false, true, emptyList(), null, emptyList()))
        assertEquals("not once connected", false, Glue.showsFirstRun(false, true, dirs, connected, emptyList()))
        val unconnected = StatusResult(listOf(ContextStatus(root = "/w", problem = "No project chosen.")))
        assertEquals(true, Glue.showsFirstRun(false, true, dirs, unconnected, emptyList()))
        assertEquals(
            "not while the project names an instance, before the service answers",
            false,
            Glue.showsFirstRun(false, true, dirs, null, listOf(null, "https://piwi.example.com")),
        )
    }

    @Test
    fun `the status bar tooltip shows the instance's and the project's text as text, a line per line`() {
        val status = StatusResult(listOf(ContextStatus(root = "/w", problem = "Project <b>pay</b> & co\nAsk an admin.")))
        assertEquals(
            "<html>Project &lt;b&gt;pay&lt;/b&gt; &amp; co<br>Ask an admin.</html>",
            Glue.htmlTooltip(Glue.statusView(status, null).tooltip),
        )
    }

    @Test
    fun `a folder created under a searched root may hold a config, unless it is too deep, hidden or skipped`() {
        val roots = listOf(java.nio.file.Path.of("/w/shop"))
        assertEquals(true, Glue.mayHoldConfigs("/w/shop/apps/web", roots))
        assertEquals(true, Glue.mayHoldConfigs("/w/shop/a/b/c/d", roots))
        assertEquals(false, Glue.mayHoldConfigs("/w/shop/a/b/c/d/e", roots))
        assertEquals(false, Glue.mayHoldConfigs("/w/shop/node_modules/pkg", roots))
        assertEquals(false, Glue.mayHoldConfigs("/w/shop/apps/.cache", roots))
        assertEquals(false, Glue.mayHoldConfigs("/w/shop", roots))
        assertEquals(false, Glue.mayHoldConfigs("/w/shopping/apps", roots))
        assertEquals(false, Glue.mayHoldConfigs(null, roots))
        assertEquals(true, Glue.mayHoldConfigs("c:/w/shop/apps", listOf(java.nio.file.Path.of("C:\\w\\shop"))))
    }

    @Test
    fun `the IDE's Playwright runner takes an npx playwright test command, named after what it runs`() {
        assertEquals(listOf("tests/a.spec.ts:3", "--headed"), Glue.playwrightTestArgs("npx playwright test tests/a.spec.ts:3 --headed"))
        assertEquals(emptyList<String>(), Glue.playwrightTestArgs("npx playwright test"))
        assertEquals(null, Glue.playwrightTestArgs("npm run e2e -- tests/a.spec.ts"))
        assertEquals("Piwi: a.spec.ts:3", Glue.playwrightRunName(listOf("tests/a.spec.ts:3", "--headed")))
        assertEquals("Piwi: a.spec.ts and 1 more", Glue.playwrightRunName(listOf("tests/a.spec.ts", "b.spec.ts", "-g", "pays")))
        assertEquals("Piwi", Glue.playwrightRunName(listOf("--grep=@smoke")))
        // A Run tab is named after what it runs: the tests, a chain's included, else the command up to its first option.
        assertEquals("Piwi: a.spec.ts:3", Glue.runTabName("npx playwright test tests/a.spec.ts:3 --repeat-each=3"))
        val chain = "npx playwright test tests/a.spec.ts --project=chromium && npx playwright test tests/b.spec.ts --project=firefox"
        assertEquals("Piwi: a.spec.ts and 1 more", Glue.runTabName(chain))
        assertEquals("Piwi: piwi flake 12", Glue.runTabName("npx @piwitests/reporter flake 12 --server-url http://127.0.0.1:3000"))
        assertEquals("Piwi: piwi flake verify 12", Glue.runTabName("npx @piwitests/reporter flake verify 12"))
        // An agent's run says who started it.
        assertEquals("Piwi: a.spec.ts:3 · Started by Claude Code", Glue.labeledRunName("Piwi: a.spec.ts:3", "Started by Claude Code"))
        assertEquals("Piwi: a.spec.ts:3", Glue.labeledRunName("Piwi: a.spec.ts:3", null))
        // A chain is the shell's: the IDE's runner takes none.
        assertTrue(Glue.chained(chain))
        assertNull(Glue.playwrightTestArgs(chain))
        assertFalse(Glue.chained("npx playwright test tests/a.spec.ts"))
    }

    @Test
    fun `a Node_js missing or older than 20 is said, with its settings one click away`() {
        assertEquals(null, Glue.nodeProblem("node", "v20.11.1\n"))
        assertEquals(null, Glue.nodeProblem("/usr/bin/node", "v22.3.0"))
        val old = "Piwi needs Node.js 20 or later, and /usr/bin/node is v18.19.0: choose one in Settings → Languages & Frameworks → Node.js."
        assertEquals(old, Glue.nodeProblem("/usr/bin/node", "v18.19.0"))
        assertEquals(
            "Piwi needs Node.js 20 or later, and node did not run: choose one in Settings → Languages & Frameworks → Node.js.",
            Glue.nodeProblem("node", null),
        )
        assertEquals(
            Glue.StatusView("Piwi: Node.js", "$old\nClick for the Node.js settings.", null, Glue.StatusAction.NODE_SETTINGS, Glue.StatusIcon.WARNING),
            Glue.statusView(null, null, startProblem = old),
        )
        assertEquals(old, Glue.connectionSummary(null, startProblem = old))
        assertEquals(Glue.NOT_STARTED, Glue.connectionSummary(null))
    }

    @Test
    fun `every Code Vision entry of a line is drawn, one slot each, in the service's order`() {
        fun entry(line: Int, title: String?, status: String? = null) = SummaryLine(line = line, title = title, status = status)
        val summary = FileSummary(
            file = entry(0, "3 tests in Piwi · 1 failing"),
            lines = listOf(
                entry(9, "✗ locator('#pay') was not found"),
                entry(9, "Run this test"),
                entry(9, "Screenshot"),
                entry(9, "Trace"),
                entry(4, "passed 44 of 48 runs", status = "failing"),
                entry(4, "Flaky · Flake Lab"),
                entry(12, ""),
            ),
        )
        val slots = (0 until Glue.CODE_VISION_SLOTS).map { slot -> Glue.codeVisionSlot(summary, slot).map { it.line to it.title } }
        assertEquals(listOf(0 to "3 tests in Piwi · 1 failing", 9 to "✗ locator('#pay') was not found", 4 to "Flaky · Flake Lab"), slots[0])
        assertEquals(listOf(9 to "Run this test"), slots[1])
        assertEquals(listOf(9 to "Screenshot"), slots[2])
        assertEquals(listOf(9 to "Trace"), slots[3])
        assertEquals(emptyList<Pair<Int, String?>>(), slots[4])
    }

    @Test
    fun `when the instance does not answer, says so and reads it again on a click rather than Connect`() {
        val problem = "Could not reach http://piwi: fetch failed"
        val status = StatusResult(listOf(ContextStatus(root = "/w", problem = problem, problemKind = "unreachable")))
        assertEquals(
            Glue.StatusView(
                "Piwi: unreachable",
                "$problem\nPiwi reads it again on its own; Reload Piwi reads it now.",
                null,
                Glue.StatusAction.RETRY,
                Glue.StatusIcon.UNREACHABLE,
            ),
            Glue.statusView(status, null),
        )
        assertEquals("Not connected. $problem Piwi reads it again on its own.", Glue.connectionSummary(status))
        val refused = StatusResult(listOf(ContextStatus(root = "/w", problem = "Refused.", problemKind = "refused")))
        assertEquals(Glue.StatusAction.CONNECT, Glue.statusView(refused, null).action)
    }

    @Test
    fun `when the desktop app does not prove its token, says to restart it, not that it is unreachable`() {
        val problem = "The desktop app's token is not sent to http://127.0.0.1:3000: the server there did not prove it holds the token. Restart or update the desktop app."
        val status = StatusResult(listOf(ContextStatus(root = "/w", problem = problem, problemKind = "desktop-unproven")))
        assertEquals(
            Glue.StatusView("Piwi: restart the desktop app", problem, null, Glue.StatusAction.RETRY, Glue.StatusIcon.WARNING),
            Glue.statusView(status, null),
        )
        // Beside a config with no project, the tool window and the settings page quote the desktop app's problem too.
        val two = StatusResult(listOf(ContextStatus(root = "/a", problem = "No project.", problemKind = "no-project"), status.contexts!!.single()))
        assertEquals("Not connected. $problem", Glue.connectionSummary(two))
    }

    @Test
    fun `a passing run, with its flaky tests, which the popup's first entry reads again`() {
        assertEquals(
            Glue.StatusView(
                "Piwi: 118 passed · 2 flaky",
                "Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped\nhttp://piwi, from the workspace .env",
                "http://piwi/test-runs/41",
                Glue.StatusAction.REFRESH,
                Glue.StatusIcon.PASSED,
            ),
            Glue.statusView(connected, runs(passed)),
        )
        assertEquals(Glue.StatusAction.REFRESH, Glue.statusView(connected, runs(null)).action)
    }

    @Test
    fun `the tooltip says when the run was read, and whether the next one is pushed or polled`() {
        val now = java.time.Instant.parse("2026-09-27T12:00:12Z").toEpochMilli()
        fun read(stream: String?) = RunStatusResult(
            listOf(RunStatus(root = "/w", branch = "feature/pay", run = passed, updatedAt = "2026-09-27T12:00:00.000Z", stream = stream)),
        )
        assertEquals(
            listOf(
                "Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped",
                "Updated 12 s ago · live",
                "http://piwi, from the workspace .env",
            ),
            Glue.statusView(connected, read("live"), now = now).tooltip.lines(),
        )
        assertEquals(
            true,
            Glue.statusView(connected, read("polling"), now = now).tooltip.contains("\nUpdated 12 s ago · read every minute\n"),
        )
        // From a service that does not say when.
        assertEquals(false, Glue.statusView(connected, runs(passed), now = now).tooltip.contains("Updated"))
    }

    @Test
    fun `the time since a read, in seconds, minutes, hours, then days`() {
        val at = "2026-09-27T12:00:00Z"
        val base = java.time.Instant.parse(at).toEpochMilli()
        fun ago(ms: Long) = Glue.relativeTime(at, base + ms)
        assertEquals("just now", ago(400))
        assertEquals("just now", ago(-5_000))
        assertEquals("12 s ago", ago(12_000))
        assertEquals("59 s ago", ago(59_999))
        assertEquals("1 min ago", ago(60_000))
        assertEquals("4 min ago", ago(270_000))
        assertEquals("2 h ago", ago(7_200_000))
        assertEquals("3 d ago", ago(3 * 86_400_000L + 5))
        assertEquals("just now", Glue.relativeTime("not a time", 0))
    }

    @Test
    fun `a failing run, a running run, an interrupted run and no run`() {
        assertEquals("Piwi: 3 failing · 2 flaky", Glue.statusView(connected, runs(passed.copy(status = "failed", failedTests = 3))).text)
        assertEquals(
            "Piwi: 41/120 · 1 failing",
            Glue.statusView(connected, runs(passed.copy(status = "running", passedTests = 40, failedTests = 1, flakyTests = 0))).text,
        )
        assertEquals("Piwi: interrupted", Glue.statusView(connected, runs(passed.copy(status = "interrupted"))).text)
        assertEquals("Piwi: no run", Glue.statusView(connected, runs(null)).text)
    }

    @Test
    fun `counts the tests still failing after the local runs, and those they fixed`() {
        val failed = passed.copy(status = "failed", passedTests = 115, failedTests = 3, flakyTests = 0)
        fun local(failing: Int, resolved: Int, overlays: Int) = RunStatusResult(
            listOf(
                RunStatus(
                    root = "/w", branch = "feature/pay", run = failed,
                    failingTests = failing, resolved = resolved, overlays = overlays,
                ),
            ),
        )
        val view = Glue.statusView(connected, local(2, 1, 2))
        assertEquals("Piwi: 2 failing · 1 fixed locally", view.text)
        assertEquals(
            "Run #41 of Acme on feature/pay: 115 passed, 3 failed, 0 flaky, 0 skipped\n" +
                "2 local runs since · 1 test fixed locally\nhttp://piwi, from the workspace .env",
            view.tooltip,
        )
        assertEquals("Piwi: 3 fixed locally", Glue.statusView(connected, local(0, 3, 1)).text)
        assertEquals("Piwi: 1 failing", Glue.statusView(connected, local(1, 0, 1)).text)
        assertEquals(false, Glue.statusView(connected, local(3, 0, 0)).tooltip.contains("local run"))
        // From a service without the counts, the run's own.
        assertEquals("Piwi: 3 failing", Glue.statusView(connected, runs(failed)).text)
    }

    @Test
    fun `a failure a later run passed is fixed locally`() {
        val failing = WorkspaceFailure(title = "pays", runId = 124, source = "local", state = "failing")
        assertEquals(true, Glue.isFixedLocally(failing.copy(state = "fixed-locally")))
        assertEquals(false, Glue.isFixedLocally(failing))
        assertEquals(false, Glue.isFixedLocally(failing.copy(state = "edited")))
    }

    @Test
    fun `a run in progress, the editor's own or one on the branch, in the text and beside the latest run`() {
        val failed = passed.copy(status = "failed", passedTests = 115, failedTests = 3, flakyTests = 0)
        val inProgress = LiveRun(runId = 124, status = "running", done = 4, total = 9, failed = 1, own = true)
        fun live(run: RunInfo?, live: LiveRun?) =
            RunStatusResult(listOf(RunStatus(root = "/w", branch = "feature/pay", run = run, failingTests = 3, live = live)))
        val own = Glue.statusView(connected, live(failed, inProgress))
        assertEquals("Piwi: run #124 · 4/9 · 1 failing · yours", own.text)
        assertEquals(
            "Run #41 of Acme on feature/pay: 115 passed, 3 failed, 0 flaky, 0 skipped\n" +
                "Your run #124 is running: 4/9 · 1 failing\nhttp://piwi, from the workspace .env",
            own.tooltip,
        )
        val other = Glue.statusView(connected, live(failed, inProgress.copy(own = false, failed = 0)))
        assertEquals("Piwi: run #124 · 4/9", other.text)
        assertEquals(true, other.tooltip.contains("\nRun #124 is running: 4/9\n"))
        // Once it ended, the latest run again.
        assertEquals("Piwi: 3 failing", Glue.statusView(connected, live(failed, null)).text)
        // On a branch without a run yet.
        val first = Glue.statusView(connected, live(null, inProgress.copy(done = 0, failed = 0)))
        assertEquals("Piwi: run #124 · 0/9 · yours", first.text)
        assertEquals(
            "No run of Acme on feature/pay yet\nYour run #124 is running: 0/9\nhttp://piwi, from the workspace .env",
            first.tooltip,
        )
    }

    @Test
    fun `the status bar item speaks for the selected file's Playwright config, the deepest holding it, else the first connected`() {
        val shop = ContextStatus(root = "/w/shop", problem = "No project chosen.", problemKind = "no-project")
        val admin = ContextStatus(root = "/w/shop/admin/", connected = true)
        val web = ContextStatus(root = "/w/web", connected = true)
        val contexts = listOf(shop, admin, web)
        assertEquals(admin, Glue.statusContext(contexts, "/w/shop/admin/tests/users.spec.ts"))
        assertEquals(shop, Glue.statusContext(contexts, "/w/shop/tests/cart.spec.ts"))
        assertEquals(web, Glue.statusContext(contexts, "/w/web/checkout.spec.ts"))
        // A folder whose name only begins the same does not hold the file.
        assertEquals(admin, Glue.statusContext(contexts, "/w/shopping/a.spec.ts"))
        // Outside every config, or without a file: the first connected.
        assertEquals(admin, Glue.statusContext(contexts, "/elsewhere/notes.md"))
        assertEquals(admin, Glue.statusContext(contexts, null))
        // Windows paths, with either separator and the drive letter in either case.
        val windows = listOf(ContextStatus(root = "C:\\w\\shop", connected = true), ContextStatus(root = "c:\\w\\web"))
        assertEquals(windows[1], Glue.statusContext(windows, "C:/w/web/a.spec.ts"))
        // Nothing connected: the first the instance did not answer, else the first.
        val unreachable = ContextStatus(root = "/w/web", problemKind = "unreachable")
        assertEquals(unreachable, Glue.statusContext(listOf(shop, unreachable), null))
        assertEquals(shop, Glue.statusContext(listOf(shop), "/elsewhere/a.ts"))
        assertEquals(null, Glue.statusContext(emptyList(), "/w/a.ts"))
    }

    @Test
    fun `with several Playwright configs, the item shows the selected file's run and its tooltip names that config`() {
        val status = StatusResult(
            listOf(
                ContextStatus(root = "/w/shop", connected = true, projectName = "Shop", label = "shop"),
                ContextStatus(root = "/w/admin", connected = true, projectName = "Admin"),
            ),
        )
        val runs = RunStatusResult(
            listOf(
                RunStatus(root = "/w/shop", branch = "main", run = passed.copy(status = "failed", failedTests = 3)),
                RunStatus(root = "/w/admin", branch = "main", run = passed.copy(id = 12, passedTests = 5, flakyTests = 0)),
            ),
        )
        val admin = Glue.statusView(status, runs, file = "/w/admin/tests/users.spec.ts")
        assertEquals("Piwi: 5 passed", admin.text)
        assertEquals(
            listOf("Run #12 of Admin on main: 5 passed, 0 failed, 0 flaky, 0 skipped", "The active file's Playwright config, in admin (one of 2)"),
            admin.tooltip.lines(),
        )
        val shop = Glue.statusView(status, runs, file = "/w/shop/cart.spec.ts")
        assertEquals("Piwi: 3 failing · 2 flaky", shop.text)
        assertEquals("The active file's Playwright config, in shop (one of 2)", shop.tooltip.lines()[1])
        // A file in neither, or none: the first connected, and how to see another's run.
        assertEquals("Piwi: 3 failing · 2 flaky", Glue.statusView(status, runs, file = "/w/README.md").text)
        assertEquals(
            "The Playwright config in shop (one of 2): open a file of another one to see its run",
            Glue.statusView(status, runs).tooltip.lines()[1],
        )
        // A config without a run is never shown another's.
        assertEquals("Piwi: no run", Glue.statusView(status, RunStatusResult(runs.contexts!!.take(1)), file = "/w/admin/a.spec.ts").text)
        // A config that is not connected says so, for itself.
        val partly = StatusResult(listOf(status.contexts!![0], ContextStatus(root = "/w/admin", problem = "No project chosen.")))
        assertEquals(
            Glue.StatusView(
                "Piwi: connect",
                "No project chosen.\nThe active file's Playwright config, in admin (one of 2)",
                null,
                Glue.StatusAction.CONNECT,
                Glue.StatusIcon.CONNECT,
            ),
            Glue.statusView(partly, runs, file = "/w/admin/a.spec.ts"),
        )
    }

    @Test
    fun `the icon and the error color follow what the text counts`() {
        fun look(view: Glue.StatusView) = view.icon to view.error
        val failed = passed.copy(status = "failed", failedTests = 3)
        assertEquals(Glue.StatusIcon.PASSED to false, look(Glue.statusView(connected, runs(passed))))
        assertEquals(Glue.StatusIcon.FAILING to true, look(Glue.statusView(connected, runs(failed))))
        assertEquals(Glue.StatusIcon.WARNING to false, look(Glue.statusView(connected, runs(passed.copy(status = "interrupted")))))
        assertEquals(Glue.StatusIcon.RUNNING to true, look(Glue.statusView(connected, runs(passed.copy(status = "running", failedTests = 1)))))
        assertEquals(Glue.StatusIcon.RUNNING to false, look(Glue.statusView(connected, runs(passed.copy(status = "running")))))
        assertEquals(Glue.StatusIcon.PIWI to false, look(Glue.statusView(connected, runs(null))))
        // A run in progress: by its own failures, whatever the latest run's.
        fun live(run: RunInfo?, failing: Int) = RunStatusResult(
            listOf(RunStatus(root = "/w", run = run, live = LiveRun(runId = 124, done = 4, total = 9, failed = failing))),
        )
        assertEquals(Glue.StatusIcon.RUNNING to false, look(Glue.statusView(connected, live(failed, 0))))
        assertEquals(Glue.StatusIcon.RUNNING to true, look(Glue.statusView(connected, live(passed, 1))))
        assertEquals(Glue.StatusIcon.RUNNING to true, look(Glue.statusView(connected, live(null, 2))))
        // Every failing test fixed by a local run.
        val fixed = RunStatusResult(listOf(RunStatus(root = "/w", run = failed, failingTests = 0, resolved = 3, overlays = 1)))
        assertEquals(Glue.StatusIcon.PASSED to false, look(Glue.statusView(connected, fixed)))
        // A developer's own runs alone.
        fun local(failing: Int) = RunStatusResult(listOf(RunStatus(root = "/w", failingTests = failing, overlays = 1)))
        assertEquals(Glue.StatusIcon.FAILING to true, look(Glue.statusView(connected, local(2))))
        assertEquals(Glue.StatusIcon.PASSED to false, look(Glue.statusView(connected, local(0))))
        // The service and the connection.
        assertEquals(Glue.StatusIcon.PIWI to false, look(Glue.statusView(null, null)))
        assertEquals(Glue.StatusIcon.WARNING to false, look(Glue.statusView(null, null, startProblem = "Piwi needs Node.js 20 or later.")))
        assertEquals(Glue.StatusIcon.CONNECT to false, look(Glue.statusView(StatusResult(listOf(ContextStatus(root = "/w"))), null)))
        assertEquals(
            Glue.StatusIcon.UNREACHABLE to false,
            look(Glue.statusView(StatusResult(listOf(ContextStatus(root = "/w", problemKind = "unreachable"))), null)),
        )
    }

    @Test
    fun `the files are drawn again when the latest run changes, not while a run in progress moves`() {
        val latest = runs(passed.copy(status = "failed", failedTests = 1))
        val moving = RunStatusResult(
            latest.contexts!!.map {
                it.copy(live = LiveRun(runId = 124, status = "running", own = true), stream = "live", updatedAt = "2026-09-27T11:00:00.000Z")
            },
        )
        assertEquals(Glue.runsInFiles(latest), Glue.runsInFiles(moving))
        assertEquals(false, Glue.runsInFiles(runs(passed)) == Glue.runsInFiles(latest))
    }

    @Test
    fun `the connection in one sentence, with where it came from`() {
        assertEquals("Connected to Acme on main at http://piwi, from the workspace .env.", Glue.connectionSummary(connected))
        assertEquals(
            "Not connected. No project chosen.",
            Glue.connectionSummary(StatusResult(listOf(ContextStatus(root = "/w", problem = "No project chosen.")))),
        )
        assertEquals("the environment (PIWI_DASHBOARD_URL)", Glue.sourceLabel("environment"))
        assertEquals("Settings → Tools → Piwi", Glue.sourceLabel("editor"))
    }

    @Test
    fun `an instance URL is stored trimmed, and its key is kept under it`() {
        assertEquals("https://piwi.corp", Glue.normalizeServerUrl("  https://piwi.corp//  "))
        assertEquals("http://localhost:3000/piwi", Glue.normalizeServerUrl("http://localhost:3000/piwi/"))
        assertEquals(null, Glue.normalizeServerUrl("piwi.corp"))
        assertEquals(null, Glue.normalizeServerUrl("ftp://piwi.corp"))
        assertEquals(null, Glue.normalizeServerUrl("https://"))
        assertEquals("apiKey https://piwi.corp", Glue.apiKeyEntry("https://piwi.corp/"))
    }

    @Test
    fun `the MCP configuration bridges each instance through a pinned mcp-remote over HTTP alone, the key in env`() {
        val json = JsonParser.parseString(
            Glue.mcpConfiguration(
                listOf(
                    McpServerDefinition("Piwi (a)", "https://a/mcp", mapOf("Authorization" to "Bearer pd_x"), "key"),
                    McpServerDefinition("Piwi (b)", "http://b/mcp", emptyMap(), "sign-in"),
                ),
            ),
        ).asJsonObject.getAsJsonObject("mcpServers")
        val first = json.getAsJsonObject("piwi")
        assertEquals("npx", first.get("command").asString)
        assertEquals(
            listOf("-y", "mcp-remote@0.14.3", "https://a/mcp", "--transport", "http-only", "--header", "Authorization:\${PIWI_AUTH}"),
            first.getAsJsonArray("args").map { it.asString },
        )
        assertEquals("Bearer pd_x", first.getAsJsonObject("env").get("PIWI_AUTH").asString)
        assertEquals(
            listOf("-y", "mcp-remote@0.14.3", "http://b/mcp", "--transport", "http-only"),
            json.getAsJsonObject("piwi-2").getAsJsonArray("args").map { it.asString },
        )
        // An exact release: npx with none runs whatever npm serves that day.
        assertTrue(Regex("^mcp-remote@\\d+\\.\\d+\\.\\d+$").matches(Glue.MCP_REMOTE))
    }

    @Test
    fun `the runs' MCP configuration bridges the project's server through mcp-remote, its token in env`() {
        val json = JsonParser.parseString(Glue.runsMcpConfiguration("http://127.0.0.1:41234/mcp", "t0ken"))
            .asJsonObject.getAsJsonObject("mcpServers").getAsJsonObject("piwi-runs")
        assertEquals("npx", json.get("command").asString)
        assertEquals(
            listOf(
                "-y",
                "mcp-remote@0.14.3",
                "http://127.0.0.1:41234/mcp",
                "--transport",
                "http-only",
                "--header",
                "Authorization:\${PIWI_RUNS_AUTH}",
            ),
            json.getAsJsonArray("args").map { it.asString },
        )
        assertEquals("Bearer t0ken", json.getAsJsonObject("env").get("PIWI_RUNS_AUTH").asString)
        assertEquals(41234, Glue.portOf("http://127.0.0.1:41234/mcp"))
        assertEquals(null, Glue.portOf("not a url"))
        val token = Glue.newAgentsToken()
        assertTrue(Glue.isAgentsToken(token))
        assertNotEquals(token, Glue.newAgentsToken())
        assertFalse(Glue.isAgentsToken("short"))
        assertFalse(Glue.isAgentsToken("a".repeat(40) + " "))
    }

    @Test
    fun `the runs' MCP configuration for Claude Code or Cursor is an http entry, its token a bearer header`() {
        val json = JsonParser.parseString(Glue.runsMcpHttpConfiguration("http://127.0.0.1:41234/mcp", "t0\"ken"))
            .asJsonObject.getAsJsonObject("mcpServers").getAsJsonObject("piwi-runs")
        assertEquals("http", json.get("type").asString)
        assertEquals("http://127.0.0.1:41234/mcp", json.get("url").asString)
        assertEquals("Bearer t0\"ken", json.getAsJsonObject("headers").get("Authorization").asString)
        assertFalse(json.has("command"))
        assertEquals("agentsToken 1a2b", Glue.agentsTokenEntry("1a2b"))
        assertNotEquals(Glue.agentsTokenEntry("1a2b"), Glue.agentsTokenEntry("3c4d"))
    }

    @Test
    fun `the copied MCP configuration says whether it holds a key, or that the agent signs in`() {
        val keyed = McpServerDefinition("Piwi (a)", "https://a/mcp", mapOf("Authorization" to "Bearer pd_x"), "key")
        val signIn = McpServerDefinition("Piwi (b)", "http://b/mcp", emptyMap(), "sign-in")
        assertEquals("It holds your API key: keep it out of the repository.", Glue.mcpAuthorizationNote(listOf(keyed, signIn)))
        assertEquals(
            "It holds no key: the first time the agent connects, it opens the instance in your browser to sign in.",
            Glue.mcpAuthorizationNote(listOf(signIn)),
        )
        assertEquals("", Glue.mcpAuthorizationNote(listOf(signIn.copy(authorization = "none"))))
    }

    @Test
    fun `a command line splits like a shell's words`() {
        assertEquals(
            listOf("npx", "playwright", "show-trace", "/tmp/a b/trace.zip"),
            Glue.splitCommand("npx playwright show-trace \"/tmp/a b/trace.zip\""),
        )
        assertEquals(listOf("npx", "playwright", "test", "tests/a.spec.ts:3"), Glue.splitCommand("npx  playwright test tests/a.spec.ts:3"))
    }

    @Test
    fun `a locator picked at a breakpoint names its place, inside the run`() {
        val at = Glue.SendPlace("tests/login.spec.ts", 42)
        assertEquals(
            Glue.SendPayload.Locator("getByRole('button')", at),
            Glue.parseSendPayload("""{"kind":"locator","text":"getByRole('button')","at":{"file":"tests/login.spec.ts","line":42}}"""),
        )
        assertEquals(
            Glue.SendPayload.Locator("getByRole('button')"),
            Glue.parseSendPayload("""{"kind":"locator","text":"getByRole('button')","at":null}"""),
        )
        val refusedFile = Glue.SendPayload.Refused("at.file must be a path relative to the run, without ..")
        val refusedLine = Glue.SendPayload.Refused("at.line must be a positive integer")
        fun send(at: String) = Glue.parseSendPayload("""{"kind":"locator","text":"getByText('x')","at":$at}""")
        assertEquals(refusedFile, send("""{"file":"../secrets.ts","line":1}"""))
        assertEquals(refusedFile, send("""{"file":"/etc/passwd","line":1}"""))
        assertEquals(refusedFile, send("""{"file":"C:\\\\work\\\\a.ts","line":1}"""))
        assertEquals(refusedFile, send("\"tests/a.ts:1\""))
        assertEquals(refusedLine, send("""{"file":"tests/a.ts","line":0}"""))
        assertEquals(refusedLine, send("""{"file":"tests/a.ts","line":1.5}"""))
        assertEquals(refusedLine, send("""{"file":"tests/a.ts","line":"3"}"""))
    }

    @Test
    fun `a picked locator says where it went`() {
        val at = Glue.SendPlace("tests/login.spec.ts", 42)
        assertEquals("The picked locator replaced the one at line 42 of login.spec.ts.", Glue.pickNotice(at, Glue.PickOutcome.REPLACED))
        assertEquals(
            "The picked locator was inserted at the caret: line 42 of login.spec.ts holds no locator anymore.",
            Glue.pickNotice(at, Glue.PickOutcome.NO_LOCATOR),
        )
        assertEquals(
            "The picked locator was inserted at the caret: tests/login.spec.ts is not in this project.",
            Glue.pickNotice(at, Glue.PickOutcome.NO_FILE),
        )
        assertEquals(
            "The picked locator was inserted at the caret. ${Glue.SERVICE_NOT_RUNNING}",
            Glue.pickNotice(at, Glue.PickOutcome.NOT_RUNNING),
        )
        assertEquals(
            "The picked locator was inserted in a new scratch file: the Piwi editor service did not answer.",
            Glue.pickNotice(at, Glue.PickOutcome.NO_ANSWER, scratch = true),
        )
    }

    @Test
    fun `a picked locator goes to the project whose run made it, not the one focused last`() {
        val at = Glue.SendPlace("tests/cart.spec.ts", 12)
        val shop = Glue.PickCandidate("shop", listOf("/work/shop/e2e"), listOf("/work/shop/e2e/tests/cart.spec.ts"))
        val blog = Glue.PickCandidate("blog", listOf("/work/blog"), emptyList())
        val files = setOf("/work/shop/e2e/tests/cart.spec.ts", "/work/blog/tests/cart.spec.ts")
        val exists = { path: String -> path in files }
        assertEquals("the project stopped in the file", "shop", Glue.pickProject(at, listOf(blog, shop), "blog", exists))
        // With no run stopped there, the project holding the file.
        val idle = shop.copy(stoppedFiles = emptyList())
        assertEquals("shop", Glue.pickProject(at, listOf(idle, blog.copy(roots = listOf("/work/elsewhere"))), "blog", exists))
        // Two projects hold such a file: the focused one.
        assertEquals("blog", Glue.pickProject(at, listOf(idle, blog), "blog", exists))
        // No project holds it, or the pick names no place: the focused one.
        assertEquals("blog", Glue.pickProject(Glue.SendPlace("tests/none.spec.ts", 1), listOf(idle, blog), "blog", exists))
        assertEquals("blog", Glue.pickProject(null, listOf(shop, blog), "blog", exists))
        // A stop in the same file of a project the run's path is not under does not count.
        val other = Glue.PickCandidate("other", listOf("/work/other"), listOf("/work/shop/e2e/tests/cart.spec.ts"))
        assertEquals("blog", Glue.pickProject(at, listOf(other, blog), "blog", exists))
    }

    @Test
    fun `a recording writes only into a script under a Playwright config folder`() {
        val root = Files.createTempDirectory("piwi-config").toRealPath()
        val dirs = listOf(root.resolve("e2e"))
        assertEquals(true, Glue.inConfigDirs(root.resolve("e2e/tests/login.spec.ts"), dirs))
        assertEquals(true, Glue.inConfigDirs(root.resolve("e2e"), dirs))
        assertEquals(true, Glue.inConfigDirs(root.resolve("e2e/../e2e/pages/cart.ts"), dirs))
        assertEquals(false, Glue.inConfigDirs(root.resolve("vite.config.ts"), dirs))
        assertEquals(false, Glue.inConfigDirs(root.resolve("e2e-old/a.spec.ts"), dirs))
        assertEquals(false, Glue.inConfigDirs(null, dirs))
        assertEquals(false, Glue.inConfigDirs(root.resolve("e2e/a.spec.ts"), emptyList()))
    }

    @Test
    fun `a service that stopped while starting is started again, a few times only`() {
        val start = 1_000_000L
        assertEquals(true, Glue.restartsService(start, start + 2_000, emptyList()))
        assertEquals(false, Glue.restartsService(start, start + Glue.SERVICE_START_MILLIS + 1, emptyList()))
        assertEquals(false, Glue.restartsService(null, start, emptyList()))
        val recent = listOf(start - 60_000, start - 30_000, start - 10_000)
        assertEquals(false, Glue.restartsService(start, start + 2_000, recent))
        val old = recent.map { it - Glue.SERVICE_RESTART_PERIOD_MILLIS }
        assertEquals(true, Glue.restartsService(start, start + 2_000, old))
    }

    @Test
    fun `the IDE's proxy reaches the service as the variables it reads, this machine left direct`() {
        assertEquals(
            mapOf(
                "HTTPS_PROXY" to "http://proxy.example.com:3128",
                "HTTP_PROXY" to "http://proxy.example.com:3128",
                "NO_PROXY" to "localhost,127.0.0.1,::1",
            ),
            Glue.proxyEnvironment("proxy.example.com", 3128, emptyList()),
        )
        assertEquals(
            "localhost,127.0.0.1,::1,.example.com,10.0.0.1",
            Glue.proxyEnvironment("proxy", 8080, listOf("*.example.com", " 10.0.0.1 ", "", "localhost"))["NO_PROXY"],
        )
        assertEquals("http://[::1]:3128", Glue.proxyEnvironment("::1", 3128, emptyList())["HTTPS_PROXY"])
    }

    @Test
    fun `the breakpoints a run pauses at are those in script files under a Playwright config`() {
        val root = Files.createTempDirectory("piwi-breakpoints").toRealPath()
        val spec = root.resolve("tests/login.spec.ts")
        val page = root.resolve("tests/pages/checkout.page.mjs")
        val found = Glue.runBreakpoints(
            listOf(
                Glue.BreakpointAt(spec.toString(), 41, "b1"),
                Glue.BreakpointAt(page.toString(), 8),
                Glue.BreakpointAt(root.resolve("README.md").toString(), 3),
                Glue.BreakpointAt(root.resolveSibling("other").resolve("a.spec.ts").toString(), 1),
                Glue.BreakpointAt(spec.toString(), -1),
            ),
            listOf(root.toString()),
        )
        assertEquals(listOf(EditorBreakpoint(spec.toUri().toString(), 41), EditorBreakpoint(page.toUri().toString(), 8)), found.map { it.place })
        assertEquals(listOf("b1", null), found.map { it.key })
        assertEquals(emptyList<Glue.RunBreakpoint>(), Glue.runBreakpoints(listOf(Glue.BreakpointAt(spec.toString(), 1)), emptyList()))
    }

    private val specUri = "file:///work/shop/tests/checkout.spec.ts"
    private val pageUri = "file:///work/shop/tests/pages/checkout.page.ts"

    private fun runTest(retry: Int = 0, cannotPause: String? = null) =
        RunTest("t1", listOf("checkout", "pays"), specUri, 2, "chromium", retry, cannotPause)

    private fun stopAt(uri: String, line: Int, bar: Boolean = true) = RunStop(
        "breakpoint", "Fill \"WELCOME10\" getByLabel('Coupon')", uri, line, 4, "getByLabel('Coupon')", bar, "2026-10-25T10:00:0$line.000Z",
    )

    private fun session(ref: String, vararg workers: RunWorker, ended: Boolean = false) = RunSession(ref, "/work/shop", workers.toList(), ended)

    @Test
    fun `the running line of a watched slot is marked until its test ends or stops, or its run ends`() {
        val call = RunningCall("t1", "Click getByRole('button', { name: 'Pay' })", specUri, 7)
        val line = RunningLine("ed-1", 1, 3, call)
        val lines = Glue.withRunningLine(emptyMap(), line)
        assertEquals(mapOf(("ed-1" to 1) to line), lines)
        // A line with no call goes; another slot's stays.
        val other = RunningLine("ed-1", 0, 2, call.copy(line = 9))
        assertEquals(mapOf(("ed-1" to 0) to other), Glue.withRunningLine(lines + (("ed-1" to 0) to other), line.copy(call = null)))
        assertEquals("Piwi: Worker 2 runs Click getByRole('button', { name: 'Pay' })", Glue.runningLineText(line))
        assertEquals("Piwi: Worker 2 runs ${"x".repeat(59)}…", Glue.runningLineText(line.copy(call = call.copy(title = "x".repeat(80)))))

        val running = mapOf("ed-1" to session("ed-1", RunWorker(3, 1, "running", runTest())))
        assertEquals(listOf(line), Glue.runningLinesShown(lines, running))
        // The test ended: its worker runs another, or none.
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, mapOf("ed-1" to session("ed-1", RunWorker(3, 1, "running", runTest().copy(id = "t2"))))))
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, mapOf("ed-1" to session("ed-1", RunWorker(3, 1, "between")))))
        // Another worker took the slot (a retry), the test stopped, or the run ended.
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, mapOf("ed-1" to session("ed-1", RunWorker(4, 1, "running", runTest())))))
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, mapOf("ed-1" to session("ed-1", RunWorker(3, 1, "stopped", runTest(), stopAt(specUri, 7))))))
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, mapOf("ed-1" to session("ed-1", RunWorker(3, 1, "running", runTest()), ended = true))))
        assertEquals(emptyList<RunningLine>(), Glue.runningLinesShown(lines, emptyMap()))
    }

    @Test
    fun `the Page tab says what the watched slot's page says, each test named before its first line`() {
        val output = Glue.PageOutput()
        output.watching("ed-1", 1)
        fun event(kind: String, text: String? = null, test: String? = "t1", worker: Int = 3) =
            LaneViewLayer("ed-1", 1, worker, test, "events", event = PageEvent(kind, text))
        assertEquals(
            listOf("Worker 2 · checkout › pays", "  Console error: TypeError: x is undefined"),
            output.layer(event("console", "TypeError: x is undefined"), runTest()),
        )
        assertEquals(listOf("  Uncaught error: boom"), output.layer(event("page-error", "boom"), runTest()))
        // A request's lines and the other layers are not the page's own words.
        assertEquals(emptyList<String>(), output.layer(event("request-failed"), runTest()))
        assertEquals(emptyList<String>(), output.layer(LaneViewLayer("ed-1", 1, 3, "t1", "calls"), runTest()))
        // The next test is named, by its id while the session does not name it yet.
        assertEquals(listOf("Worker 2 · t2", "  Console error: again"), output.layer(event("console", "again", test = "t2"), runTest()))
        assertEquals(
            listOf("  12 more events were not sent: too many at once."),
            output.layer(LaneViewLayer("ed-1", 1, 3, "t2", "events", event = PageEvent("dropped", count = 12)), null),
        )
        // A watch of the same slot keeps going; another slot's names its test again.
        output.watching("ed-1", 1)
        assertEquals(listOf("  Console error: still"), output.layer(event("console", "still", test = "t2"), null))
        output.watching("ed-1", 0)
        assertEquals("Worker 1 · t2", output.layer(event("console", "other", test = "t2"), null).first())
    }

    @Test
    fun `a run's session is kept until it ends`() {
        val running = session("ed-1", RunWorker(0, 0, "running", runTest()))
        val stopped = session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5)))
        var kept = Glue.withSession(Glue.withSession(Glue.withSession(emptyMap(), running), session("ed-2")), stopped)
        assertEquals(listOf("ed-1", "ed-2"), kept.keys.toList())
        assertSame(stopped, kept["ed-1"])
        kept = Glue.withSession(kept, session("ed-1", ended = true))
        assertEquals(listOf("ed-2"), kept.keys.toList())
        assertEquals(kept, Glue.withSession(kept, RunSession(ref = null)))
    }

    @Test
    fun `the controls offer Pause and Stop while a test runs, Resume and the others while one is stopped`() {
        assertEquals(Glue.RunControls(active = false, pausable = false, pausing = false, stopped = false), Glue.runControls(emptyMap()))
        val running = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest()), RunWorker(1, 1, "between")))
        assertEquals(Glue.RunControls(active = true, pausable = true, pausing = false, stopped = false), Glue.runControls(running))
        val pausing = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(), pausing = true)))
        assertEquals(Glue.RunControls(active = true, pausable = false, pausing = true, stopped = false), Glue.runControls(pausing))
        assertEquals("Piwi: pausing…", Glue.runControlStatus(Glue.runControls(pausing), emptyList()))
        val ci = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(cannotPause = "running under CI"))))
        assertEquals(false, Glue.runControls(ci).pausable)
        val stopped = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(pageUri, 4))))
        assertEquals(Glue.RunControls(active = true, pausable = false, pausing = false, stopped = true), Glue.runControls(stopped))
        // A stop whose reporter takes it can be shared with Playwright's own tools.
        val sharing = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(pageUri, 4), takes = listOf("bind"))))
        assertEquals(true, Glue.runControls(sharing).shareable)
        assertTrue(Glue.canShare(Glue.stopsOf(sharing).single()))
        assertFalse(Glue.canShare(Glue.stopsOf(stopped).single()))
        // A stop its pause bar shows can bring its window forward, when its reporter does; a headless one cannot.
        val showing = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(pageUri, 4), showsWindow = true)))
        assertEquals(true, Glue.runControls(showing).browserShowable)
        assertTrue(Glue.canShowBrowser(Glue.stopsOf(showing).single()))
        assertFalse(Glue.canShowBrowser(Glue.stopsOf(stopped).single()))
        val headless = mapOf(
            "ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(pageUri, 4, bar = false), showsWindow = true)),
        )
        assertFalse(Glue.canShowBrowser(Glue.stopsOf(headless).single()))
        assertEquals(
            "Shared. Join it with: npx playwright cli attach piwi-ed-1-w0",
            Glue.sharedText(StopBindResult(true, "Shared.", "piwi-ed-1-w0", "npx playwright cli attach piwi-ed-1-w0")),
        )
        assertEquals("The test went on.", Glue.sharedText(StopBindResult(false, "The test went on.")))
        assertEquals("Piwi: stopped at a breakpoint · checkout.page.ts:5", Glue.runControlStatus(Glue.runControls(stopped), Glue.stopsOf(stopped)))
        assertEquals(null, Glue.runControlStatus(Glue.runControls(running), emptyList()))
    }

    @Test
    fun `Share live says what it sends, offers a run that can be shared, and says how a shared one stands`() {
        val page = "https://piwi.example.com/test-runs/42"
        val warning = Glue.shareLiveWarning(page)
        assertTrue(warning.startsWith("While this run is shared on piwi.example.com, anyone with its page open there "))
        // Its stops show to whoever has the run page open, watched or not; the images only while someone watches.
        assertTrue(warning.contains("each stop of its tests: the call, its file and line, and the test's title, even while nobody watches"))
        assertTrue(warning.contains("images of its test's page go there too, each with its call and the test's title"))
        assertTrue(warning.contains("on an instance with authentication off, anyone who can reach it"))
        assertTrue(warning.endsWith("Stop sharing ends it within seconds."))
        assertTrue(Glue.shareLiveWarning(null).contains("the Piwi instance it reports to"))
        assertEquals("piwi.example.com", Glue.liveInstance(page))
        assertEquals("127.0.0.1:7494", Glue.liveInstance("http://127.0.0.1:7494/test-runs/5"))
        assertEquals(null, Glue.liveInstance(null))

        val ready = RunSession("ed-1", workers = listOf(RunWorker(0, 0, "running", runTest())), live = RunLive(false, null, page, 0))
        val refused = RunSession("ed-2", live = RunLive(false, "This run cannot be shared live: its project's live view is off.", null, 0))
        val shared = ready.copy(live = RunLive(true, null, page, 2))
        assertEquals(Glue.LiveTarget.None("No run started from the IDE is running."), Glue.liveTarget(emptyMap(), true))
        assertEquals(Glue.LiveTarget.One("ed-1"), Glue.liveTarget(mapOf("ed-1" to ready, "ed-2" to refused), true))
        // A run that cannot be shared is asked when no other can: the service says why.
        assertEquals(Glue.LiveTarget.One("ed-2"), Glue.liveTarget(mapOf("ed-2" to refused), true))
        assertEquals(Glue.LiveTarget.None("No run is shared live."), Glue.liveTarget(mapOf("ed-1" to ready), false))
        assertEquals(
            Glue.LiveTarget.Choose(listOf("ed-1", "ed-3")),
            Glue.liveTarget(mapOf("ed-1" to ready, "ed-3" to ready.copy(ref = "ed-3")), true),
        )

        val controls = Glue.runControls(mapOf("ed-1" to shared))
        assertTrue(controls.liveShared)
        assertEquals(2, controls.liveViewers)
        assertFalse(Glue.runControls(mapOf("ed-1" to ready)).liveShared)
        // The views open of every shared run, counted as views: one person may hold several.
        assertEquals("Piwi: shared live · 2 views", Glue.liveStatus(controls))
        val two = Glue.runControls(mapOf("ed-1" to shared, "ed-3" to shared.copy(ref = "ed-3", live = RunLive(true, null, page, 1))))
        assertEquals("Piwi: shared live · 3 views", Glue.liveStatus(two))
        assertEquals("Piwi: shared live · 1 view", Glue.liveStatus(Glue.runControls(mapOf("ed-1" to shared.copy(live = RunLive(true, null, page, 1))))))
        assertEquals(null, Glue.liveStatus(Glue.runControls(mapOf("ed-1" to ready))))
        // While the project's runs are shared, the status bar says so, with or without a shared run.
        assertEquals("Piwi: this project's runs shared live", Glue.liveStatus(Glue.runControls(mapOf("ed-1" to ready)), windowShared = true))
        assertEquals("Piwi: this project's runs shared live · 2 views", Glue.liveStatus(controls, windowShared = true))
        assertTrue(
            Glue.shareLiveWarning(page, window = true)
                .startsWith(
                    "Each run this project follows from now on (those you start here, and those of a terminal it follows) is shared until you stop or close the project. While a run is shared on piwi.example.com, ",
                ),
        )
        assertEquals("Dana asks to watch run #77 live.", Glue.askToWatchText("Dana", 77))
        assertEquals("Dana asks to watch this run live.", Glue.askToWatchText("Dana", null))
        assertEquals(shared.live, Glue.sharedLive(mapOf("ed-1" to shared, "ed-2" to refused)))
        assertEquals(null, Glue.sharedLive(mapOf("ed-1" to ready)))
        assertEquals("Shared live on piwi.example.com: 2 views open", Glue.sharedLiveText(shared.live!!))
        assertEquals("Shared live: nobody watches yet", Glue.sharedLiveText(RunLive(true, null, null, 0)))
        // How far the runs are, as their own processes say: none from a reporter that predates it.
        assertEquals(null, Glue.runProgressText(mapOf("ed-1" to ready)))
        val counted = ready.copy(progress = RunProgress(total = 9, done = 3))
        assertEquals("Piwi: 3 of 9", Glue.runProgressText(mapOf("ed-1" to counted)))
        val failing = ready.copy(ref = "ed-2", progress = RunProgress(total = 1, done = 1, failed = 1, status = "failed"))
        assertEquals("Piwi: 4 of 10 · 1 failed", Glue.runProgressText(mapOf("ed-1" to counted, "ed-2" to failing)))
        // An agent's run says so, never reading as the person's own.
        val agents = counted.copy(label = "Started by Claude Code")
        assertEquals("Piwi: 3 of 9 · Started by Claude Code", Glue.runProgressText(mapOf("ed-1" to agents)))
        // A failure so far takes the error color, as the hub counts it.
        assertFalse(Glue.runsFailing(mapOf("ed-1" to counted, "ed-0" to ready)))
        assertTrue(Glue.runsFailing(mapOf("ed-1" to counted, "ed-2" to failing)))
        // A test ended at a stop is marked so, not counted as a plain pass.
        val endedAtAStop = ready.copy(ref = "ed-3", progress = RunProgress(total = 2, done = 2, skipped = 1, endedAtStop = 1, status = "passed"))
        assertEquals("Piwi: 2 of 2 · 1 ended at a stop", Glue.runProgressText(mapOf("ed-3" to endedAtAStop)))
        val stoppedShared = mapOf("ed-1" to shared.copy(workers = listOf(RunWorker(0, 0, "stopped", runTest(), stopAt(pageUri, 4)))))
        assertEquals(
            "Piwi: stopped at a breakpoint · checkout.page.ts:5 · shared live · 2 views",
            Glue.runControlStatus(Glue.runControls(stoppedShared), Glue.stopsOf(stoppedShared)),
        )
    }

    @Test
    fun `the status bar's menu on a share opens the run page, copies its link and stops sharing after asking`() {
        val page = "https://piwi.example.com/test-runs/42"
        val shared = RunSession("ed-1", root = "/w/shop", live = RunLive(true, null, page, 2), page = RunPage(78, page))
        val ready = RunSession("ed-2", live = RunLive(false, null, page, 0))
        assertEquals(emptyList<Glue.LiveEntry>(), Glue.liveMenu(mapOf("ed-2" to ready), windowShared = false))
        assertEquals(
            listOf(
                Glue.LiveEntry(Glue.LiveEntryKind.OPEN_PAGE, "Open the run page", "ed-1", page),
                Glue.LiveEntry(Glue.LiveEntryKind.COPY_LINK, "Copy the run page's link", "ed-1", page),
                Glue.LiveEntry(Glue.LiveEntryKind.STOP_SHARING, "Stop sharing the run", "ed-1"),
            ),
            Glue.liveMenu(mapOf("ed-1" to shared, "ed-2" to ready), windowShared = false),
        )
        // A run shared before its page is known offers Stop sharing alone.
        assertEquals(
            listOf(Glue.LiveEntry(Glue.LiveEntryKind.STOP_SHARING, "Stop sharing the run", "ed-1")),
            Glue.liveMenu(mapOf("ed-1" to shared.copy(live = RunLive(true, null, null, 0))), windowShared = false),
        )
        // Several shared runs are each named; the project's runs shared add their own stop.
        val other = RunSession("ed-3", root = "/w/admin", live = RunLive(true, null, "https://piwi.example.com/test-runs/43", 0))
        assertEquals(
            listOf(
                "Open the page of run #78", "Copy the link of run #78", "Stop sharing run #78",
                "Open the page of run in admin (ed-3)", "Copy the link of run in admin (ed-3)", "Stop sharing run in admin (ed-3)",
                "Stop sharing this project's runs",
            ),
            Glue.liveMenu(mapOf("ed-1" to shared, "ed-3" to other), windowShared = true).map { it.label },
        )
        assertEquals(
            listOf(Glue.LiveEntry(Glue.LiveEntryKind.STOP_SHARING_PROJECT, "Stop sharing this project's runs")),
            Glue.liveMenu(emptyMap(), windowShared = true),
        )
        // What Stop sharing asks first.
        assertEquals(
            "Stop sharing the run live on piwi.example.com? The 2 views open there end, and nothing more goes there until you share it again.",
            Glue.stopSharingQuestion(shared.live),
        )
        assertEquals(
            "Stop sharing the run live? Its page there stops showing it live, and nothing more goes there until you share it again.",
            Glue.stopSharingQuestion(RunLive(true, null, null, 0)),
        )
        assertEquals(
            "Stop sharing this project's runs live? Their views on the team instance end, and the runs that follow are not shared.",
            Glue.stopSharingQuestion(null),
        )
    }

    @Test
    fun `the workers a Worker tab can watch, and what it says of its slot`() {
        val sessions = mapOf(
            "ed-1" to session(
                "ed-1",
                RunWorker(0, 0, "running", runTest(), watchable = true),
                RunWorker(1, 1, "stopped", runTest(), stopAt(specUri, 5), watchable = true),
                RunWorker(2, 2, "running", runTest()),
                RunWorker(3, 3, "between", watchable = true),
            ),
        )
        assertEquals(
            listOf("Worker 1 · running checkout › pays", "Worker 2 · stopped in checkout › pays", "Worker 4 · between tests"),
            Glue.watchableWorkers(sessions).map { it.label },
        )
        assertEquals(listOf(0, 3), Glue.watchableWorkers(sessions, pausable = true).map { it.worker })
        assertTrue(Glue.runControls(sessions).watchable)
        assertFalse(Glue.runControls(mapOf("ed-2" to session("ed-2", RunWorker(0, 0, "running", runTest())))).watchable)
        val stops = Glue.stopsOf(sessions)
        assertEquals("Worker 1 · the run ended.", Glue.laneShown(null, 0, stops).caption)
        assertEquals("Worker 6 · starting…", Glue.laneShown(sessions["ed-1"], 5, stops).caption)
        assertEquals("Worker 4 · between tests", Glue.laneShown(sessions["ed-1"], 3, stops).caption)
        assertEquals("Worker 1 · Running · checkout › pays", Glue.laneShown(sessions["ed-1"], 0, stops).caption)
        val stopped = Glue.laneShown(sessions["ed-1"], 1, stops)
        assertEquals(stops.single(), stopped.stop)
        assertEquals("Worker 2 · Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · checkout.spec.ts:6", stopped.caption)
    }

    @Test
    fun `what each worker runs now is said by its lane, each run named when several run`() {
        val one = session(
            "ed-1",
            RunWorker(1, 1, "stopped", runTest(), stopAt(specUri, 5)),
            RunWorker(0, 0, "running", runTest()),
            RunWorker(2, 2, "between"),
        )
        assertEquals(
            "Worker 1 · checkout › pays\nWorker 2 · checkout › pays · stopped\nWorker 3 · between tests",
            Glue.workersNowText(mapOf("ed-1" to one)),
        )
        val two = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest())), "ed-2" to session("ed-2", RunWorker(0, 0, "running", runTest())))
        assertEquals(
            "Run in shop (ed-1) · Worker 1 · checkout › pays\nRun in shop (ed-2) · Worker 1 · checkout › pays",
            Glue.workersNowText(two),
        )
        assertNull(Glue.workersNowText(mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest()), ended = true))))
        // Many workers: the first seven, then how many more; a title's line break as a space.
        val wrapped = runTest().copy(title = listOf("cart", "adds\na mug"))
        val many = session("ed-1", *Array(12) { RunWorker(it, it, "running", wrapped) })
        val listed = Glue.workersNowText(mapOf("ed-1" to many))!!.split("\n")
        assertEquals(8, listed.size)
        assertEquals("Worker 1 · cart › adds a mug", listed.first())
        assertEquals("and 5 more workers", listed.last())
    }

    @Test
    fun `who else is on a run, a worker's page and a stop is said, this IDE as you or left out`() {
        val picker = RunPresence("picker", "Piwi Picker")
        val desktop = RunPresence("desktop", "the desktop app")
        val agent = RunPresence("agent", "an agent")
        val me = RunPresence("editor", "WebStorm", self = true)
        // The service's JSON reads with Gson: `self` only on this IDE's own entries.
        val heard = Gson().fromJson(
            """{"ref":"ed-1","root":"/w","workers":[{"worker":0,"parallelIndex":0,"state":"running","watchers":[{"kind":"editor","name":"WebStorm","self":true}]}],"ended":false,"presence":[{"kind":"picker","name":"Piwi Picker"}]}""",
            RunSession::class.java,
        )
        assertEquals(listOf(picker), heard.presence)
        assertEquals(listOf(me), heard.workers!!.single().watchers)
        val run = session("ed-1", RunWorker(0, 0, "running", runTest()))
        assertNull(Glue.presenceText(run))
        assertNull(Glue.presenceText(run.copy(presence = listOf(me))))
        assertEquals("Also open in Piwi Picker", Glue.presenceText(run.copy(presence = listOf(picker))))
        assertEquals(
            "Also open in Piwi Picker and the desktop app · An agent follows this run",
            Glue.presenceText(run.copy(presence = listOf(picker, picker, desktop, agent, me))),
        )
        assertEquals("An agent follows this run", Glue.presenceText(run.copy(presence = listOf(agent))))
        assertEquals(
            "Run in shop (ed-1): Also open in Piwi Picker\nRun in shop (ed-2): An agent follows this run",
            Glue.runsPresenceText(
                mapOf("ed-1" to run.copy(presence = listOf(picker)), "ed-2" to session("ed-2").copy(presence = listOf(agent)), "ed-3" to session("ed-3")),
            ),
        )
        assertEquals("Also open in Piwi Picker", Glue.runsPresenceText(mapOf("ed-1" to run.copy(presence = listOf(picker)))))
        assertNull(Glue.runsPresenceText(mapOf("ed-1" to run)))
        // Watchers: this IDE last as you, nothing while it alone watches.
        assertNull(Glue.watchersText(null))
        assertNull(Glue.watchersText(listOf(me)))
        assertEquals("Watched by Piwi Picker and you", Glue.watchersText(listOf(me, picker)))
        assertEquals("Watched by Piwi Picker, an agent and the desktop app", Glue.watchersText(listOf(picker, agent, desktop)))
        // The driver: Interact takes a stop from the agent.
        val stop = stopAt(specUri, 5, bar = false)
        assertNull(Glue.driverText(stop))
        assertEquals("You drive this stop", Glue.driverText(stop.copy(driver = me), interact = true))
        assertEquals("Piwi Picker drives this stop", Glue.driverText(stop.copy(driver = picker), interact = true))
        assertEquals("An agent drives this stop", Glue.driverText(stop.copy(driver = agent)))
        assertEquals("An agent drives this stop: your input takes control", Glue.driverText(stop.copy(driver = agent), interact = true))
        // The Paused page tab's and the Worker tab's captions.
        val stopped = RunWorker(5, 1, "stopped", runTest(), stop.copy(by = "agent", driver = agent), takes = listOf("input"), watchers = listOf(picker, me))
        val sessions = mapOf("ed-1" to session("ed-1", stopped))
        val shown = Glue.stopsOf(sessions).single()
        val said = "Paused by the agent · Fill \"WELCOME10\" getByLabel('Coupon') · checkout.spec.ts:6"
        val present = "An agent drives this stop: your input takes control · Watched by Piwi Picker and you"
        assertEquals(present, Glue.stopPresence(shown, sessions))
        assertEquals("$said · $present", Glue.stopCaption(shown, sessions))
        assertEquals("Worker 2 · $said · $present", Glue.laneShown(sessions["ed-1"], 1, listOf(shown)).caption)
        // A stop nobody drives and no other tool watches says neither.
        val alone = mapOf("ed-1" to session("ed-1", RunWorker(5, 1, "stopped", runTest(), stop, watchers = listOf(me))))
        val quiet = Glue.stopsOf(alone).single()
        assertNull(Glue.stopPresence(quiet, alone))
        assertEquals("Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · checkout.spec.ts:6", Glue.stopCaption(quiet, alone))
        // A running worker's tab says who else watches it.
        val running = session("ed-1", RunWorker(5, 1, "running", runTest(), watchers = listOf(desktop, me)))
        assertEquals("Worker 2 · Running · checkout › pays · Watched by the desktop app and you", Glue.laneShown(running, 1, emptyList()).caption)
    }

    @Test
    fun `a Pause that waits for a call says which, and End the test ends the test there`() {
        val waiting = RunWaiting("Click getByRole('button', { name: 'Pay' })", specUri, 4, "2026-10-25T10:00:00.000Z", true)
        val sessions = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(), pausing = true, waiting = waiting)))
        val controls = Glue.runControls(sessions)
        assertEquals(waiting, controls.waiting)
        assertEquals(
            "Piwi: pausing… · waits in Click getByRole('button', { name: 'Pay' })",
            Glue.runControlStatus(controls, Glue.stopsOf(sessions)),
        )
        assertEquals(listOf(Glue.WaitingWorker("ed-1", 0, waiting, 0)), Glue.waitingWorkers(sessions))
        // A worker Playwright started again in its slot is named by the slot, as the worker views name it.
        val restarted = mapOf("ed-1" to session("ed-1", RunWorker(2, 0, "running", runTest(), pausing = true, waiting = waiting)))
        assertEquals(listOf(Glue.WaitingWorker("ed-1", 2, waiting, 0)), Glue.waitingWorkers(restarted))
        assertEquals(
            "Worker 1 · Pausing · waits in Click getByRole('button', { name: 'Pay' }) · checkout › pays",
            Glue.laneShown(sessions["ed-1"], 0, emptyList()).caption,
        )
        // A long call is cut in the status bar.
        val long = waiting.copy(title = "Click " + "getByRole('row').".repeat(10))
        val longSessions = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(), pausing = true, waiting = long)))
        val status = Glue.runControlStatus(Glue.runControls(longSessions), emptyList())!!
        assertEquals("Piwi: pausing… · waits in " + long.title.take(59).trimEnd() + "…", status)
        // A worker no Pause reached waits in nothing.
        val going = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(), waiting = waiting)))
        assertNull(Glue.runControls(going).waiting)
        assertEquals(emptyList<Glue.WaitingWorker>(), Glue.waitingWorkers(going))
    }

    @Test
    fun `a stop says what is about to run, with the attempt after the first`() {
        assertEquals("Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon')", Glue.pausedText(stopAt(specUri, 5), runTest()))
        assertEquals("Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · attempt 2", Glue.pausedText(stopAt(specUri, 5), runTest(retry = 1)))
        // A stop an agent asked for says so.
        assertEquals(
            "Paused by the agent · Fill \"WELCOME10\" getByLabel('Coupon')",
            Glue.pausedText(stopAt(specUri, 5).copy(by = "agent"), runTest()),
        )
        val sessions = mapOf(
            "ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5)), RunWorker(1, 1, "running", runTest())),
            "ed-2" to session("ed-2", RunWorker(3, 1, "stopped", runTest(), stopAt(pageUri, 8))),
        )
        val stops = Glue.stopsOf(sessions)
        assertEquals(listOf("ed-1" to 0, "ed-2" to 3), stops.map { it.ref to it.worker })
        assertEquals(2, stops.map(Glue::stopKey).toSet().size)
        assertEquals("Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · checkout › pays · checkout.page.ts:9 · Worker 2", Glue.stopLabel(stops[1]))
        assertEquals("Piwi: 2 tests stopped", Glue.runControlStatus(Glue.runControls(sessions), stops))
    }

    /** Worker `index` of `ed-1`, in slot `slot`, stopped headless at `line`, or with the pause bar for `bar`. */
    private fun stoppedAt(index: Int, line: Int, bar: Boolean = false, slot: Int = index, reason: String = "breakpoint") =
        RunWorker(index, slot, "stopped", runTest(), stopAt(specUri, line, bar).copy(reason = reason))

    private fun runningWorker(index: Int) = RunWorker(index, index, "running", runTest())

    /**
     * The pushes of run `ed-1` as the service sends them, 100 ms apart, through `Glue.StopsShown` as the plugin takes
     * them: each new stop's file opened in its turn, or left closed for a line in `closed` (none for a line in
     * `unopened`, whose file is not found), and the page the tab opens shown there. Each push says which workers' files
     * opened with the focus or without, and the page opened, as `worker to line`.
     */
    private class Pushes(private val unopened: Set<Int> = emptySet(), private val closed: Set<Int> = emptySet()) {
        val shown = Glue.StopsShown()
        var now = 0L

        fun push(vararg workers: RunWorker): Pair<List<Pair<Int, Boolean>>, Pair<Int, Int>?> {
            now += 100
            val sessions = mapOf("ed-1" to RunSession("ed-1", "/work/shop", workers.toList()))
            val change = shown.changed(sessions, Glue.stopsOf(sessions), now)
            val opened = change.open.filter { it.stop.line !in unopened }.map { stop ->
                val focus = shown.focusFor(stop, now)
                shown.opened(stop, focus, focus || stop.stop.line !in closed)
                stop.worker to focus
            }
            change.page?.let(shown::view)
            return opened to change.page?.let { it.worker to it.stop.line }
        }

        fun stopOf(worker: RunWorker): Glue.ShownStop =
            Glue.stopsOf(mapOf("ed-1" to RunSession("ed-1", "/work/shop", listOf(worker)))).single()

        /** A control from the IDE answers `stop`, as it is sent: the token to settle it with. */
        fun answer(action: String, stop: RunWorker): Int = shown.answered(stopOf(stop), action, now)
    }

    private val none = emptyList<Pair<Int, Boolean>>()

    @Test
    fun `the IDE opens the first stop with the focus, and its page`() {
        assertEquals(listOf(0 to true) to (0 to 3), Pushes().push(stoppedAt(0, 3), runningWorker(1)))
    }

    @Test
    fun `the IDE opens a second worker's stop without the focus while the person is on the first, the tab keeping its stop`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        assertEquals(listOf(1 to false) to null, pushes.push(stoppedAt(0, 3), stoppedAt(1, 5)))
        // A failure held for another worker leaves them alone too.
        assertEquals(listOf(2 to false) to null, pushes.push(stoppedAt(0, 3), stoppedAt(1, 5), stoppedAt(2, 7, reason = "failure")))
    }

    @Test
    fun `the IDE gives the focus and the tab to the first stop of a Pause with three workers, in one push or in three`() {
        val together = Pushes()
        assertEquals(none to null, together.push(runningWorker(0), runningWorker(1), runningWorker(2)))
        assertEquals(
            listOf(0 to true, 1 to false, 2 to false) to (0 to 3),
            together.push(stoppedAt(0, 3), stoppedAt(1, 5), stoppedAt(2, 7)),
        )
        val apart = Pushes()
        assertEquals(listOf(0 to true) to (0 to 3), apart.push(stoppedAt(0, 3), runningWorker(1), runningWorker(2)))
        assertEquals(listOf(1 to false) to null, apart.push(stoppedAt(0, 3), stoppedAt(1, 5), runningWorker(2)))
        assertEquals(listOf(2 to false) to null, apart.push(stoppedAt(0, 3), stoppedAt(1, 5), stoppedAt(2, 7)))
    }

    @Test
    fun `the IDE waits for the next stop of a worker stepped from the IDE, through the push where it runs`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("step", stoppedAt(0, 3))
        assertEquals(none to null, pushes.push(runningWorker(0), stoppedAt(1, 5)))
        assertEquals(listOf(0 to true) to (0 to 4), pushes.push(stoppedAt(0, 4), stoppedAt(1, 5)))
    }

    @Test
    fun `the IDE hands the tab to a stop held once the worker it shows is resumed, then follows that one's Step`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("resume", stoppedAt(0, 3))
        assertEquals(none to (1 to 5), pushes.push(runningWorker(0), stoppedAt(1, 5)))
        pushes.answer("step", stoppedAt(1, 5))
        assertEquals(none to null, pushes.push(runningWorker(0), runningWorker(1)))
        assertEquals(listOf(1 to true) to (1 to 6), pushes.push(runningWorker(0), stoppedAt(1, 6)))
    }

    @Test
    fun `the IDE hands the tab on after a control from elsewhere, and opens a lone worker's next stop`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        assertEquals(1 to 5, pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        val lone = Pushes()
        lone.push(stoppedAt(0, 3))
        assertNull(lone.push(runningWorker(0)).second)
        assertEquals(0 to 4, lone.push(stoppedAt(0, 4)).second)
    }

    @Test
    fun `the IDE stops waiting for a stepped worker's next stop once its worker left the run`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("step", stoppedAt(0, 3))
        assertNull(pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        assertEquals(none to (1 to 5), pushes.push(stoppedAt(1, 5)))
        assertNull(pushes.shown.waitsUntil())
    }

    @Test
    fun `the IDE waits for a stepped worker's next stop RESERVED_MILLIS at most, saying when to ask again`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        assertNull(pushes.shown.waitsUntil())
        pushes.answer("run-to", stoppedAt(0, 3))
        assertEquals(pushes.now + Glue.RESERVED_MILLIS, pushes.shown.waitsUntil())
        assertNull(pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        // Asked again when the wait is over, with no push since: the stop held takes the tab.
        pushes.now += Glue.RESERVED_MILLIS
        assertEquals(1 to 5, pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        assertNull(pushes.shown.waitsUntil())
    }

    @Test
    fun `the IDE gives the focus to the next stop of the slot whose stop took it, moved on from elsewhere`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        // Piwi Picker steps worker 0.
        pushes.push(runningWorker(0), stoppedAt(1, 5))
        assertEquals(listOf(0 to true), pushes.push(stoppedAt(0, 4), stoppedAt(1, 5)).first)
    }

    @Test
    fun `the IDE moves the focus to the worker a control answered`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("resume", stoppedAt(1, 5))
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        assertEquals(listOf(1 to true) to null, pushes.push(stoppedAt(0, 3), stoppedAt(1, 6)))
    }

    @Test
    fun `the IDE keeps the focus on the slot of a worker restarted after a failure`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3, reason = "failure"), stoppedAt(1, 5))
        pushes.answer("resume", stoppedAt(0, 3, reason = "failure"))
        pushes.push(stoppedAt(1, 5))
        assertEquals(listOf(2 to true) to null, pushes.push(stoppedAt(2, 4, slot = 0), stoppedAt(1, 5)))
    }

    @Test
    fun `the IDE counts a stop whose file is not found as none shown, and one left closed as shown`() {
        val unfound = Pushes(unopened = setOf(3))
        unfound.push(stoppedAt(0, 3), runningWorker(1))
        assertEquals(listOf(1 to true), unfound.push(stoppedAt(0, 3), stoppedAt(1, 5)).first)
        // Worker 1's file stayed closed, the editor in use left alone: a third worker's stop takes no focus either.
        val closed = Pushes()
        closed.push(stoppedAt(0, 3), runningWorker(1), runningWorker(2))
        assertEquals(listOf(1 to false), closed.push(stoppedAt(0, 3), stoppedAt(1, 5), runningWorker(2)).first)
        closed.answer("resume", stoppedAt(0, 3))
        closed.push(runningWorker(0), stoppedAt(1, 5), runningWorker(2))
        assertEquals(listOf(2 to false), closed.push(runningWorker(0), stoppedAt(1, 5), stoppedAt(2, 7)).first)
    }

    @Test
    fun `the IDE opens no page at a stop with a pause bar, and a new stop's page in a tab that is closed`() {
        val pushes = Pushes()
        assertNull(pushes.push(stoppedAt(0, 3, bar = true), runningWorker(1)).second)
        assertEquals(1 to 5, pushes.push(stoppedAt(0, 3, bar = true), stoppedAt(1, 5)).second)
        pushes.shown.view(null)
        assertNull(pushes.push(stoppedAt(0, 3, bar = true), stoppedAt(1, 5)).second)
        assertEquals(2 to 7, pushes.push(stoppedAt(0, 3, bar = true), stoppedAt(1, 5), stoppedAt(2, 7)).second)
    }

    @Test
    fun `the IDE gives a stop of the slot the Worker tab watches the Paused page for its input, but not the focus`() {
        // The Worker tab only watches slot 1: its stop is any other worker's to the focus and the Paused page tab.
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        assertEquals(listOf(1 to false) to null, pushes.push(stoppedAt(0, 3), stoppedAt(1, 5)))
        pushes.answer("resume", stoppedAt(0, 3))
        assertEquals(none to (1 to 5), pushes.push(runningWorker(0), stoppedAt(1, 5)))
    }

    @Test
    fun `the IDE keeps the focus off another worker's stop while a stepped worker's next stop is awaited`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.answer("step", stoppedAt(0, 3))
        pushes.push(runningWorker(0), runningWorker(1))
        // No other stop's file is open, and worker 1's stop still leaves the caret to worker 0.
        assertEquals(listOf(1 to false) to null, pushes.push(runningWorker(0), stoppedAt(1, 5)))
        assertEquals(listOf(0 to true) to (0 to 4), pushes.push(stoppedAt(0, 4), stoppedAt(1, 5)))
        // In one push, worker 1's stop first.
        val together = Pushes()
        together.push(stoppedAt(0, 3), runningWorker(1))
        together.answer("step", stoppedAt(0, 3))
        together.push(runningWorker(0), runningWorker(1))
        assertEquals(listOf(1 to false, 0 to true) to (0 to 4), together.push(stoppedAt(1, 5), stoppedAt(0, 4)))
    }

    @Test
    fun `the IDE ends the wait as the stepped worker's next stop opens, found later or not`() {
        val pushes = Pushes(unopened = setOf(4))
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.answer("step", stoppedAt(0, 3))
        pushes.push(runningWorker(0), runningWorker(1))
        pushes.push(stoppedAt(0, 4), runningWorker(1))
        assertTrue(pushes.shown.waitsUntil() != null)
        pushes.shown.opened(pushes.stopOf(stoppedAt(0, 4)), false)
        assertNull(pushes.shown.waitsUntil())
    }

    @Test
    fun `the IDE lets another worker's stop take the focus once the wait for a stepped worker is over`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.answer("step", stoppedAt(0, 3))
        pushes.push(runningWorker(0), runningWorker(1))
        pushes.now += Glue.RESERVED_MILLIS
        assertEquals(listOf(1 to true) to (1 to 5), pushes.push(runningWorker(0), stoppedAt(1, 5)))
    }

    @Test
    fun `the IDE makes the slot the person acted on theirs - a code action, input or a pick on the Paused page`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("resume", stoppedAt(0, 3))
        assertEquals(1 to 5, pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        // The person types on worker 1's page: worker 0's next stop leaves them there.
        pushes.shown.acted(pushes.stopOf(stoppedAt(1, 5)))
        assertEquals(listOf(0 to false), pushes.push(stoppedAt(0, 4), stoppedAt(1, 5)).first)
        pushes.push(stoppedAt(0, 4), runningWorker(1))
        assertEquals(listOf(1 to true), pushes.push(stoppedAt(0, 4), stoppedAt(1, 6)).first)
        // Acting on another worker ends the wait for a stepped one.
        pushes.answer("step", stoppedAt(0, 4))
        pushes.shown.acted(pushes.stopOf(stoppedAt(1, 6)))
        assertNull(pushes.shown.waitsUntil())
    }

    @Test
    fun `the IDE forgets an answer the run refused - no wait, and the slot the person was on`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.shown.taken(pushes.answer("resume", stoppedAt(1, 5)))
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        // A Step on worker 0's stop, which went on meanwhile.
        assertTrue(pushes.shown.refused(pushes.answer("step", stoppedAt(0, 3))))
        assertNull(pushes.shown.waitsUntil())
        assertEquals(listOf(1 to true), pushes.push(stoppedAt(0, 3), stoppedAt(1, 6)).first)
        // An answer taken, or settled already, undoes nothing.
        val taken = pushes.answer("step", stoppedAt(0, 3))
        pushes.shown.taken(taken)
        assertFalse(pushes.shown.refused(taken))
        assertEquals(pushes.now + Glue.RESERVED_MILLIS, pushes.shown.waitsUntil())
    }

    @Test
    fun `the IDE undoes each of two refused answers in flight, in either order`() {
        for (order in listOf(listOf(0, 1), listOf(1, 0))) {
            val pushes = Pushes()
            pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
            val tokens = listOf(pushes.answer("step", stoppedAt(0, 3)), pushes.answer("step", stoppedAt(1, 5)))
            order.forEach { pushes.shown.refused(tokens[it]) }
            assertNull(pushes.shown.waitsUntil())
            // Neither answer holds the run actions: the only stop shown is answered.
            val a = pushes.stopOf(stoppedAt(0, 3))
            assertEquals(Glue.StopChoice.One(a), pushes.shown.choose(listOf(a), null, null, true, pushes.now))
        }
    }

    @Test
    fun `the IDE gives a run action the stop at the caret, else none but the one just answered, else the only one shown`() {
        val pushes = Pushes(closed = setOf(5))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5), stoppedAt(2, 7))
        val all = Glue.stopsOf(mapOf("ed-1" to RunSession("ed-1", "/work/shop", listOf(stoppedAt(0, 3), stoppedAt(1, 5), stoppedAt(2, 7)))))
        val (a, b, c) = all
        assertEquals(Glue.StopChoice.One(b), pushes.shown.choose(all, specUri, 5, true))
        assertEquals(Glue.StopChoice.Ask, pushes.shown.choose(all, specUri, 1, true))
        // The only stop left: one whose file stayed closed is asked for.
        assertEquals(Glue.StopChoice.Ask, pushes.shown.choose(listOf(b), specUri, 1, true))
        assertEquals(Glue.StopChoice.One(c), pushes.shown.choose(listOf(c), specUri, 1, true))
        // Worker 0 resumed from the caret: a second press before the next stop answers no other stop, but a code action
        // takes the only one shown.
        pushes.answer("resume", stoppedAt(0, 3))
        assertEquals(Glue.StopChoice.One(a), pushes.shown.choose(listOf(a), specUri, 9, true, 150))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(listOf(c), specUri, 3, true, 150))
        assertEquals(Glue.StopChoice.One(c), pushes.shown.choose(listOf(c), specUri, 3, false, 150))
        assertEquals(Glue.StopChoice.One(c), pushes.shown.choose(listOf(c), specUri, 3, true, 100 + Glue.RESUMED_MILLIS))
        // A stop whose page shows is one the person was shown.
        pushes.shown.view(b)
        assertEquals(Glue.StopChoice.One(b), pushes.shown.choose(listOf(b), specUri, 3, true, 5_000))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(emptyList(), specUri, 3, true))
    }

    @Test
    fun `the IDE ends the moments after an answer once no worker of its run holds the slot`() {
        val shown = Glue.StopsShown()
        val first = mapOf("ed-1" to RunSession("ed-1", "/work/shop", listOf(stoppedAt(0, 3))))
        shown.changed(first, Glue.stopsOf(first), 100)
        val a = Glue.stopsOf(first).single()
        shown.opened(a, true)
        shown.answered(a, "resume", 100)
        // The run ends, and another run's worker stops within the moments after the answer.
        val second = mapOf("ed-2" to RunSession("ed-2", "/work/shop", listOf(stoppedAt(0, 5))))
        shown.changed(second, Glue.stopsOf(second), 200)
        val b = Glue.stopsOf(second).single()
        shown.opened(b, true)
        assertEquals(Glue.StopChoice.One(b), shown.choose(listOf(b), specUri, 5, true, 300))
    }

    @Test
    fun `the IDE ends the moments after an answer at the next stop`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("step", stoppedAt(0, 3))
        pushes.push(runningWorker(0), stoppedAt(1, 5))
        val b = pushes.stopOf(stoppedAt(1, 5))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(listOf(b), null, null, true, 400))
        pushes.push(stoppedAt(0, 4), stoppedAt(1, 5))
        assertEquals(Glue.StopChoice.One(b), pushes.shown.choose(listOf(b), null, null, true, 500))
    }

    @Test
    fun `the IDE keeps a run action on the answered worker until its next stop opens, whatever the caret and other stops say`() {
        val pushes = Pushes(unopened = setOf(4))
        // Two workers stopped at the same line: an action asks which, and the person steps worker 0.
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 3), runningWorker(2))
        val a = pushes.stopOf(stoppedAt(0, 3))
        val b = pushes.stopOf(stoppedAt(1, 3))
        assertEquals(Glue.StopChoice.Ask, pushes.shown.choose(listOf(a, b), specUri, 3, true))
        pushes.answer("step", stoppedAt(0, 3))
        assertEquals(Glue.StopChoice.One(a), pushes.shown.choose(listOf(a, b), specUri, 3, true, 150))
        // Worker 0 runs and worker 2 stops: an action pressed again answers neither worker 1 nor worker 2.
        pushes.push(runningWorker(0), stoppedAt(1, 3), stoppedAt(2, 7))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(listOf(b), specUri, 3, true, 250))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(listOf(pushes.stopOf(stoppedAt(2, 7))), specUri, 7, true, 250))
        // Worker 0's next stop, heard but its file not found yet, has not moved the caret: the action waits for it.
        pushes.push(stoppedAt(0, 4), stoppedAt(1, 3), stoppedAt(2, 7))
        assertEquals(Glue.StopChoice.None, pushes.shown.choose(listOf(b), specUri, 3, true, 350))
        // Its file open, the moments after the answer end.
        pushes.shown.opened(pushes.stopOf(stoppedAt(0, 4)), true)
        assertEquals(Glue.StopChoice.One(b), pushes.shown.choose(listOf(b), specUri, 3, true, 350))
    }

    @Test
    fun `the IDE says when acting ended a wait, for the tab to be drawn again, as after a refusal`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        pushes.answer("step", stoppedAt(0, 3))
        assertNull(pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        assertTrue(pushes.shown.acted(pushes.stopOf(stoppedAt(1, 5))))
        assertEquals(1 to 5, pushes.push(runningWorker(0), stoppedAt(1, 5)).second)
        assertFalse(pushes.shown.acted(pushes.stopOf(stoppedAt(1, 5))))
        // A refused Step says it ended the wait: the tab drawn again opens the stop held.
        val refused = Pushes()
        refused.push(stoppedAt(0, 3), runningWorker(1))
        refused.push(stoppedAt(0, 3), stoppedAt(1, 5))
        val step = refused.answer("step", stoppedAt(0, 3))
        assertNull(refused.push(runningWorker(0), stoppedAt(1, 5)).second)
        assertTrue(refused.shown.refused(step))
        assertEquals(1 to 5, refused.push(runningWorker(0), stoppedAt(1, 5)).second)
    }

    @Test
    fun `the IDE undoes of a refused answer only what nothing changed since`() {
        val pushes = Pushes()
        pushes.push(stoppedAt(0, 3), stoppedAt(1, 5))
        val step = pushes.answer("step", stoppedAt(0, 3))
        // The person types on worker 1's page before the refusal comes.
        pushes.shown.acted(pushes.stopOf(stoppedAt(1, 5)))
        pushes.shown.refused(step)
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        assertEquals(listOf(1 to true), pushes.push(stoppedAt(0, 3), stoppedAt(1, 6)).first)
        // Worker 1 answered, then worker 0 stepped and typed on: the slot the person is on stays worker 0's.
        val again = Pushes()
        again.push(stoppedAt(0, 3), stoppedAt(1, 5))
        again.shown.taken(again.answer("resume", stoppedAt(1, 5)))
        again.push(stoppedAt(0, 3), runningWorker(1))
        val stepped = again.answer("step", stoppedAt(0, 3))
        again.shown.acted(again.stopOf(stoppedAt(0, 3)))
        again.shown.refused(stepped)
        assertEquals(listOf(1 to false), again.push(stoppedAt(0, 3), stoppedAt(1, 6)).first)
    }

    @Test
    fun `the IDE keeps waiting when the stepped stop's own file opens after the Step`() {
        val pushes = Pushes(unopened = setOf(3))
        pushes.push(stoppedAt(0, 3), runningWorker(1))
        pushes.answer("step", stoppedAt(0, 3))
        pushes.shown.opened(pushes.stopOf(stoppedAt(0, 3)), false)
        assertTrue(pushes.shown.waitsUntil() != null)
    }

    @Test
    fun `the IDE counts a press, a click, a key, text or the wheel on a page as acting, not a pointer moving or a release`() {
        assertFalse(Glue.actsOnPage(listOf(PageInput("mouse", "move", 1.0, 2.0))))
        assertFalse(Glue.actsOnPage(listOf(PageInput("mouse", "up", 1.0, 2.0, "left"))))
        assertFalse(Glue.actsOnPage(listOf(PageInput("key", "up", key = "a"))))
        assertFalse(Glue.actsOnPage(emptyList()))
        assertTrue(Glue.actsOnPage(listOf(PageInput("mouse", "down", 1.0, 2.0, "left"))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("mouse", "click", 1.0, 2.0, "left", 1))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("key", "press", key = "Enter"))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("key", "down", key = "a"))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("text", text = "MORNING10"))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("wheel", x = 1.0, y = 2.0, deltaX = 0.0, deltaY = 40.0))))
        assertTrue(Glue.actsOnPage(listOf(PageInput("mouse", "move", 1.0, 2.0), PageInput("key", "press", key = "Tab"))))
    }

    @Test
    fun `the Paused page keeps Interact for the next stop of its worker slot that takes input, while Watch stays on`() {
        val live = listOf("view", "input", "pick-at")
        fun at(ref: String, slot: Int, takes: List<String>, line: Int = 7) =
            Glue.ShownStop(ref, slot + 4, stopAt(specUri, line), runTest(), takes, slot = slot)
        val shown = "ed-1" to 1
        // The slot's next stop, the worker Playwright starts in its place included.
        assertTrue(Glue.keepsInteract(true, shown, at("ed-1", 1, live, 8), watchLive = true))
        assertTrue(Glue.keepsInteract(true, shown, at("ed-1", 1, live).copy(worker = 11), watchLive = true))
        // Interact or Watch off, another slot or run, or a stop that takes no input on a live view: off.
        assertFalse(Glue.keepsInteract(false, shown, at("ed-1", 1, live), watchLive = true))
        assertFalse(Glue.keepsInteract(true, shown, at("ed-1", 1, live), watchLive = false))
        assertFalse(Glue.keepsInteract(true, null, at("ed-1", 1, live), watchLive = true))
        assertFalse(Glue.keepsInteract(true, shown, at("ed-1", 2, live), watchLive = true))
        assertFalse(Glue.keepsInteract(true, shown, at("ed-2", 1, live), watchLive = true))
        assertFalse(Glue.keepsInteract(true, shown, at("ed-1", 1, listOf("view", "pick-at")), watchLive = true))
        assertFalse(Glue.keepsInteract(true, shown, at("ed-1", 1, listOf("input")), watchLive = true))
    }

    @Test
    fun `a new page selects the Paused page tab unless the Worker tab is selected in a tool window that shows`() {
        assertFalse(Glue.selectsPausedPage(workerTabSelected = true, windowVisible = true))
        assertTrue(Glue.selectsPausedPage(workerTabSelected = true, windowVisible = false))
        assertTrue(Glue.selectsPausedPage(workerTabSelected = false, windowVisible = true))
        assertTrue(Glue.selectsPausedPage(workerTabSelected = false, windowVisible = false))
    }

    @Test
    fun `a control at the caret acts on the stop at its line, else on the only one, else asks`() {
        val one = Glue.ShownStop("ed-1", 0, stopAt(specUri, 5), runTest())
        val two = Glue.ShownStop("ed-1", 1, stopAt(pageUri, 8), runTest())
        assertEquals(listOf(one), Glue.stopsFor(listOf(one), pageUri, 1))
        assertEquals(listOf(two), Glue.stopsFor(listOf(one, two), "file:/work/shop/tests/pages/checkout.page.ts", 8))
        assertEquals(listOf(one, two), Glue.stopsFor(listOf(one, two), pageUri, 7))
        assertEquals(listOf(one, two), Glue.stopsFor(listOf(one, two), null, null))
    }

    private val allTakes = listOf("pick", "record", "assert", "assert-region", "requests", "mock", "locator")

    @Test
    fun `a failure held for the IDE says how the test failed and offers Resume alone among the controls`() {
        val failed = stopAt(specUri, 5).copy(reason = "failure", title = "Failed: Timed out 5000ms waiting for click")
        assertEquals("Held at its failure · Timed out 5000ms waiting for click · attempt 2", Glue.pausedText(failed, runTest(retry = 1)))
        val shown = { stop: RunStop, takes: List<String> -> Glue.ShownStop("ed-1", 0, stop, runTest(), takes) }
        assertEquals(listOf(Glue.StopControl.RESUME), Glue.stopControls(shown(failed, listOf("end"))))
        assertEquals(Glue.StopControl.entries - Glue.StopControl.END, Glue.stopControls(shown(stopAt(specUri, 5), allTakes)))
        val stopped = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), failed, takes = allTakes)))
        assertEquals("Piwi: held at its failure · checkout.spec.ts:6", Glue.runControlStatus(Glue.runControls(stopped), Glue.stopsOf(stopped)))
        assertEquals(Glue.StopAction.entries.toSet(), Glue.runControls(stopped).actions)
    }

    @Test
    fun `a stop ends its test where its reporter takes it, never at a failure`() {
        val stopped = { stop: RunStop, takes: List<String> ->
            mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stop, takes = takes)))
        }
        val ending = stopped(stopAt(specUri, 5), listOf("end"))
        assertTrue(Glue.runControls(ending).endable)
        assertEquals(Glue.StopControl.entries, Glue.stopControls(Glue.stopsOf(ending).single()))
        assertFalse(Glue.runControls(stopped(stopAt(specUri, 5), emptyList())).endable)
        assertFalse(Glue.runControls(stopped(stopAt(specUri, 5).copy(reason = "failure"), listOf("end"))).endable)
    }

    @Test
    fun `a run started in a terminal is none to stop, and says so where it stops`() {
        val terminal = RunSession("terminal-41-1", "/work/shop", listOf(RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5))), terminal = true)
        val sessions = mapOf("terminal-41-1" to terminal)
        assertFalse(Glue.runControls(sessions).stoppable)
        assertTrue(Glue.runControls(sessions + ("ed-1" to session("ed-1", RunWorker(0, 0, "running", runTest(), null)))).stoppable)
        val stop = Glue.stopsOf(sessions).single()
        assertTrue(stop.terminal)
        assertFalse(stop.runner)
        assertEquals("Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · run in a terminal", Glue.pausedText(stop.stop, stop.test, stop.terminal))
    }

    @Test
    fun `a job the desktop app runs in a throwaway checkout is none to stop, and says so where it stops`() {
        val job = RunSession(
            "desktop-3-at-abc1234def01",
            null,
            listOf(RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5))),
            checkout = RunCheckout("abc1234def01"),
        )
        val sessions = mapOf("desktop-3-at-abc1234def01" to job)
        assertFalse(Glue.runControls(sessions).stoppable)
        val stop = Glue.stopsOf(sessions).single()
        assertEquals("abc1234def01", stop.checkout)
        assertEquals(
            "Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · the desktop app's reproduction at commit abc1234, in a throwaway checkout",
            Glue.pausedText(stop.stop, stop.test, stop.terminal, stop.runner, stop.checkout),
        )
        assertNull(Glue.ownRunInProgress(emptyList(), mapOf("desktop-3-at-abc1234def01" to job.copy(progress = RunProgress(done = 1, total = 3, status = "running")))))
    }

    @Test
    fun `a run the IDE's own test runner started is none to stop, and says so where it stops`() {
        val stopped = listOf(RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5)))
        val runner = RunSession("terminal-42-1", "/work/shop", stopped, terminal = true, runner = true)
        assertFalse(Glue.runControls(mapOf("terminal-42-1" to runner)).stoppable)
        val stop = Glue.stopsOf(mapOf("terminal-42-1" to runner)).single()
        assertTrue(stop.terminal)
        assertTrue(stop.runner)
        assertEquals(
            "Stopped at a breakpoint · Fill \"WELCOME10\" getByLabel('Coupon') · run by the editor's test runner",
            Glue.pausedText(stop.stop, stop.test, stop.terminal, stop.runner),
        )
        // Said of a run the IDE started, it says nothing.
        val own = RunSession("ed-1", "/work/shop", stopped, runner = true)
        assertFalse(Glue.stopsOf(mapOf("ed-1" to own)).single().runner)
    }

    @Test
    fun `a stop offers the code actions its reporter takes, those in the test's window where the pause bar shows`() {
        val shown = { bar: Boolean, takes: List<String> -> Glue.ShownStop("ed-1", 0, stopAt(specUri, 5, bar), runTest(), takes) }
        assertEquals(Glue.StopAction.entries, Glue.stopActions(shown(true, allTakes)))
        assertEquals(listOf(Glue.StopAction.MOCK), Glue.stopActions(shown(false, allTakes)))
        assertEquals(listOf(Glue.StopAction.PICK, Glue.StopAction.RECORD), Glue.stopActions(shown(true, listOf("pick", "record", "requests"))))
        assertEquals(emptyList<Glue.StopAction>(), Glue.stopActions(shown(true, emptyList())))
        val sessions = mapOf("ed-1" to session("ed-1", RunWorker(0, 0, "stopped", runTest(), stopAt(specUri, 5), takes = listOf("pick"))))
        assertEquals(listOf("pick"), Glue.stopsOf(sessions).single().takes)
    }

    @Test
    fun `Mock a request lists the responses latest first, with their status, type, size and time`() {
        val cart = StopRequest(1, "GET", "http://localhost:3000/api/cart", 200, "application/json", 12, 840.0)
        val pay = StopRequest(2, "POST", "http://localhost:3000/api/pay", 402, "", null, 12_400.0)
        assertEquals(listOf(pay, cart), Glue.requestsToMock(listOf(cart, pay)))
        assertEquals("GET http://localhost:3000/api/cart", Glue.requestLabel(cart))
        assertEquals("200 · application/json · 12 B · at 840 ms", Glue.requestDetails(cart))
        assertEquals("402 · no type · no size · at 12.4 s", Glue.requestDetails(pay))
        assertEquals(listOf("1023 B", "2.0 KB", "3.0 MB"), listOf(1023L, 2048L, 3L * 1024 * 1024).map(Glue::sizeText))
        val listed = Gson().fromJson("""{"ok":true,"message":"m","requests":[{"id":3,"method":"GET","url":"u","status":200,"type":"","size":null,"time":5}]}""", StopRequestsResult::class.java)
        assertEquals(StopRequest(3, "GET", "u", 200, "", null, 5.0), listed.requests!!.single())
    }

    @Test
    fun `the count at the caret says the matches, why none were counted, and nothing on a line without a locator`() {
        assertEquals("3 matches", Glue.caretText(LocatorAtCaretResult(true, "3 elements match.", "getByRole('button')", 3)))
        assertEquals("1 match", Glue.caretText(LocatorAtCaretResult(true, "1 element matches.", "getByRole('button')", 1)))
        assertEquals("no match", Glue.caretText(LocatorAtCaretResult(true, "No element matches.", "getByRole('button')", 0)))
        assertEquals("Another page.", Glue.caretText(LocatorAtCaretResult(false, "Another page.", "getByRole('button')", null)))
        assertEquals(null, Glue.caretText(LocatorAtCaretResult(false, "No locator on this line.", null, null)))
    }

    @Test
    fun `the count at the caret asks one query at a time, once, and shows an answer only while the caret stands there`() {
        val asks = Glue.CaretAsks()
        assertEquals(true, asks.want("a"))
        assertEquals(false, asks.want("a"))
        assertEquals(true, asks.ask("a"))
        // The caret moves on while the answer is on its way: nothing more is asked, and the answer is dropped.
        assertEquals(true, asks.want("b"))
        assertEquals(false, asks.ask("b"))
        assertEquals(false, asks.answered("a"))
        assertEquals(true, asks.ask("b"))
        assertEquals(true, asks.answered("b"))
        assertEquals(false, asks.ask("b"))
        // No stop: asked anew afterwards.
        assertEquals(true, asks.want(null))
        assertEquals(true, asks.want("b"))
        assertEquals(true, asks.ask("b"))
        assertEquals(true, asks.answered("b"))
        // Down a line and back before the count settled: the line it came back to is asked again, its count gone.
        assertEquals(true, asks.want("c"))
        assertEquals(true, asks.want("b"))
        assertEquals(true, asks.ask("b"))
    }

    @Test
    fun `a stop's code is written the last edit first, below the import lines it adds, and says what it wrote`() {
        val text = "import { test } from '@playwright/test';\n\ntest('pays', async ({ page }) => {\n  await page.goto('/');\n});\n"
        val at = { line: Int, character: Int, newText: String -> FileEdit(EditRange(EditPosition(line, character), EditPosition(line, character)), newText) }
        val code = StopCode(
            ref = "ed-1",
            since = "s1",
            action = "mock",
            uri = specUri,
            line = 3,
            code = "  await page.route('**/api/cart', (route) =>\n    route.fulfill({ json: {} }),\n  );",
            edits = listOf(at(1, 0, "import { expect } from '@playwright/test';\n"), at(3, 0, "  block\n")),
            message = "Piwi wrote the mock above checkout.spec.ts:4.",
            warnings = listOf("1 value named or shaped like a credential is written as <hidden>."),
        )
        val writes = Glue.stopCodeWrites(text, code.edits!!)!!
        assertEquals(listOf(Glue.TextWrite(text.indexOf("  await"), text.indexOf("  await"), "  block\n"), Glue.TextWrite(41, 41, "import { expect } from '@playwright/test';\n")), writes)
        val written = writes.fold(StringBuilder(text)) { b, w -> b.replace(w.start, w.end, w.text) }.toString().lines()
        assertEquals(listOf("import { test } from '@playwright/test';", "import { expect } from '@playwright/test';", "", "test('pays', async ({ page }) => {", "  block", "  await page.goto('/');"), written.take(6))
        // Two at one place: the later one ends up after the other.
        assertEquals(listOf("b", "a"), Glue.stopCodeWrites(text, listOf(at(1, 0, "a"), at(1, 0, "b")))!!.map { it.text })
        assertEquals(null, Glue.stopCodeWrites(text, listOf(at(40, 0, "x"))))
        assertEquals(4..6, Glue.writtenLines(code))
        assertEquals(
            Glue.StopCodeNotice(true, "Piwi wrote the mock above checkout.spec.ts:4. 1 value named or shaped like a credential is written as <hidden>."),
            Glue.stopCodeNotice(code),
        )
        assertEquals(Glue.StopCodeNotice(false, "Piwi wrote the mock above checkout.spec.ts:4."), Glue.stopCodeNotice(code.copy(warnings = null)))
    }

    private fun at(key: String, line: Int, uri: String = specUri) = Glue.RunBreakpoint(EditorBreakpoint(uri, line), key)

    @Test
    fun `the breakpoints go to each live run whose breakpoints differ, once`() {
        val places = listOf(EditorBreakpoint(specUri, 4))
        val edits = Glue.EditLog()
        val runs = LinkedHashMap<String, Glue.RunBreakpoints>()
        val live = mapOf("ed-1" to session("ed-1"), "ed-2" to session("ed-2"))
        Glue.remember(runs, "ed-2", Glue.runStarted(edits.now(), listOf(at("b1", 4))))
        assertEquals(listOf(SetRunBreakpointsParams("ed-1", places)), Glue.breakpointUpdates(live, listOf(at("b1", 4)), runs, edits))
        assertEquals(emptyList<SetRunBreakpointsParams>(), Glue.breakpointUpdates(live, listOf(at("b1", 4)), runs, edits))
        assertEquals(
            listOf(SetRunBreakpointsParams("ed-1", emptyList()), SetRunBreakpointsParams("ed-2", emptyList())),
            Glue.breakpointUpdates(live, emptyList(), runs, edits),
        )
        repeat(60) { Glue.remember(runs, "ed-x$it", Glue.runStarted(0, emptyList())) }
        assertEquals(50, runs.size)
        assertEquals(false, "ed-x9" in runs)
    }

    @Test
    fun `a breakpoint that moved with an edit keeps the run's line, and one set since is mapped back`() {
        val edits = Glue.EditLog()
        val runs = LinkedHashMap<String, Glue.RunBreakpoints>()
        val live = mapOf("ed-1" to session("ed-1"))
        Glue.remember(runs, "ed-1", Glue.runStarted(edits.now(), listOf(at("b1", 4), at("b2", 9, pageUri))))
        // Two lines inserted above: the IDE moves the breakpoint to line 6, the run's code did not move.
        edits.add(Glue.fileKey(specUri)!!, Glue.LineEdit(1, 1, 3, first = false, last = true))
        assertEquals(emptyList<SetRunBreakpointsParams>(), Glue.breakpointUpdates(live, listOf(at("b1", 6), at("b2", 9, pageUri)), runs, edits))
        assertEquals(
            listOf(SetRunBreakpointsParams("ed-1", listOf(EditorBreakpoint(specUri, 4), EditorBreakpoint(specUri, 6)))),
            Glue.breakpointUpdates(live, listOf(at("b1", 6), at("b3", 8), at("b4", 1)), runs, edits),
        )
        // Dragged to line 10 of the spec as it stands: mapped back from there.
        assertEquals(
            listOf(SetRunBreakpointsParams("ed-1", listOf(EditorBreakpoint(specUri, 8)))),
            Glue.breakpointUpdates(live, listOf(at("b3", 10)), runs, edits),
        )
    }

    /** A document's lines changed as `text` takes the place of the range from `from` to `to`, and the lines it moved logged. */
    private fun change(lines: List<String>, log: Glue.EditLog, from: Pair<Int, Int>, to: Pair<Int, Int>, text: String): List<String> {
        val joined = lines.joinToString("\n")
        fun offset(at: Pair<Int, Int>) = lines.take(at.first).sumOf { it.length + 1 } + at.second
        val after = (joined.substring(0, offset(from)) + text + joined.substring(offset(to))).split("\n")
        Glue.lineEdit(from.first, from.second, to.first, text) { after.getOrNull(it) }?.let { log.add(Glue.fileKey(specUri)!!, it) }
        return after
    }

    @Test
    fun `the edits since a run started bring its lines to where they stand, and the caret's line back`() {
        val code = listOf("test('pays', async ({ page }) => {", "  await page.goto('/');", "  await pay(page);", "});")
        assertEquals(null, Glue.lineEdit(1, 2, 1, "await ") { "" })
        val log = Glue.EditLog()
        val since = log.now()
        val file = Glue.fileKey(specUri)
        var lines = change(code, log, 1 to 0, 1 to 0, "  // one\n  // two\n")
        lines = change(lines, log, 4 to 18, 4 to 18, "\n  ")
        assertEquals("  await pay(page);", lines[4])
        assertEquals(listOf(0, 3, 4), listOf(0, 1, 2).map { log.forward(file, it, since) })
        assertEquals(listOf(2, 1, null, null, 3), listOf(4, 3, 1, 5, 6).map { log.back(file, it, since) })
        // The same file spelled another way; another file; a run started after the edits.
        assertEquals(4, log.forward(Glue.fileKey("file:/work/shop/tests/checkout.spec.ts"), 2, since))
        assertEquals(2, log.forward(Glue.fileKey(pageUri), 2, since))
        assertEquals(4, log.back(file, 4, log.now()))
        // The edits undone: the lines are the run's again.
        lines = change(lines, log, 4 to 18, 5 to 2, "")
        lines = change(lines, log, 1 to 0, 3 to 0, "")
        assertEquals(code, lines)
        assertEquals(2, log.forward(file, 2, since))
        assertEquals(2, log.back(file, 2, since))
        log.forget(log.now())
        assertEquals(5, log.back(file, 5, since))
    }

    @Test
    fun `a paused page is a JPEG in base64, nothing else, and not too large`() {
        assertEquals(listOf<Byte>(-1, -40, -1), Glue.pausedImageBytes(PausedImage("image/jpeg", "/9j/"))?.toList())
        assertEquals(null, Glue.pausedImageBytes(PausedImage("image/png", "/9j/")))
        assertEquals(null, Glue.pausedImageBytes(PausedImage("image/jpeg", "not base64!")))
        assertEquals(null, Glue.pausedImageBytes(null))
        assertEquals(null, Glue.pausedImageBytes(PausedImage("image/jpeg", "A".repeat(Glue.MAX_IMAGE_DATA + 4))))
        assertEquals(true, Glue.decodableImage(1280, 720))
        assertEquals(false, Glue.decodableImage(1280, 100_000))
        assertEquals(false, Glue.decodableImage(10_000, 10_000))
        assertEquals(false, Glue.decodableImage(0, 720))
    }

    @Test
    fun `a click picks on an image whose worker takes it, mapped to CSS pixels of the page whatever its size`() {
        val image = PausedImage("image/jpeg", "/9j/", 1280, 800)
        assertEquals(true, Glue.picksOnImage(listOf("pick", "pick-at"), image))
        assertEquals(false, Glue.picksOnImage(listOf("pick", "view"), image))
        assertEquals(false, Glue.picksOnImage(listOf("pick-at"), PausedImage("image/jpeg", "/9j/")))
        assertEquals(false, Glue.picksOnImage(listOf("pick-at"), null))
        // An image taken at a device scale factor of 2, shown at its own size: 2560 by 1600 pixels.
        assertEquals(650 to 200, Glue.pagePoint(1300, 400, 2560, 1600, image))
        assertEquals(640 to 200, Glue.pagePoint(320, 100, 640, 400, image))
        assertEquals(1279 to 799, Glue.pagePoint(2560, 1600, 2560, 1600, image))
        assertEquals(0 to 0, Glue.pagePoint(0, 0, 2560, 1600, image))
        assertEquals(null, Glue.pagePoint(-1, 4, 2560, 1600, image))
        assertEquals(null, Glue.pagePoint(4, 1601, 2560, 1600, image))
        assertEquals(null, Glue.pagePoint(4, 4, 0, 1600, image))
        assertEquals(null, Glue.pagePoint(4, 4, 2560, 1600, PausedImage("image/jpeg", "/9j/")))
    }

    @Test
    fun `pairing names the ports a JetBrains Gateway backend's person forwards, at the same numbers`() {
        assertEquals(
            "With JetBrains Gateway, forward port 63342 under Ports in the JetBrains Client first, and 51234 for the runs, at the same numbers.",
            Glue.forwardingHint(63342, listOf(51234)),
        )
        assertEquals(
            "With JetBrains Gateway, forward port 63342 under Ports in the JetBrains Client first, and 51234 and 51240 for the runs, at the same numbers.",
            Glue.forwardingHint(63342, listOf(51240, 51234, 51240)),
        )
        assertEquals(
            "With JetBrains Gateway, forward port 63342 under Ports in the JetBrains Client first, at the same number.",
            Glue.forwardingHint(63342, emptyList()),
        )
    }

    @Test
    fun `the tooltip names the reporter the project installs`() {
        val withReporter = RunStatusResult(listOf(RunStatus(root = "/w", branch = "feature/pay", run = passed, reporterVersion = "0.47.0")))
        assertEquals(
            listOf(
                "Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped",
                "http://piwi, from the workspace .env",
                "reporter 0.47.0",
            ),
            Glue.statusView(connected, withReporter).tooltip.lines(),
        )
        assertEquals(false, Glue.statusView(connected, runs(passed)).tooltip.contains("reporter"))
    }

    @Test
    fun `a send payload is a locator line or a steps document`() {
        assertEquals(Glue.SendPayload.Locator("page.getByRole('button')"), Glue.parseSendPayload("""{"kind":"locator","text":"page.getByRole('button')"}"""))
        assertEquals(true, Glue.parseSendPayload("""{"kind":"steps","steps":{"v":1}}""") is Glue.SendPayload.Steps)
        assertEquals(Glue.SendPayload.Refused("the body must be JSON"), Glue.parseSendPayload("{"))
        assertEquals(Glue.SendPayload.Refused("text must be a non-empty string"), Glue.parseSendPayload("""{"kind":"locator","text":" "}"""))
        assertEquals(Glue.SendPayload.Refused("steps must be a steps document"), Glue.parseSendPayload("""{"kind":"steps"}"""))
        assertEquals(Glue.SendPayload.Refused("kind must be 'locator' or 'steps'"), Glue.parseSendPayload("""{"kind":"file"}"""))
    }

    @Test
    fun `only the bearer token authorizes a send`() {
        val token = "abcdefghijklmnop_1234"
        assertEquals(true, Glue.sendAuthorized("Bearer $token", token))
        assertEquals(false, Glue.sendAuthorized("Bearer ${token}x", token))
        assertEquals(false, Glue.sendAuthorized(token, token))
        assertEquals(false, Glue.sendAuthorized(null, token))
        assertEquals(false, Glue.sendAuthorized("Bearer x", ""))
    }

    @Test
    fun `an open request reads the file, its 1-based position, check and the Piwi project`() {
        fun q(vararg pairs: Pair<String, String>) = pairs.groupBy({ it.first }, { it.second })
        assertEquals(
            Glue.OpenRequest.File("tests/a.spec.ts", 12, 3, false, "Shop"),
            Glue.parseOpenRequest(q("file" to "tests/a.spec.ts", "line" to "12", "column" to "3", "project" to "Shop")),
        )
        assertEquals(Glue.OpenRequest.File("C:/repo/a.ts", null, null, true, null), Glue.parseOpenRequest(q("file" to "C:\\repo\\a.ts", "check" to "")))
        assertEquals("C:/repo/e2e", (Glue.parseOpenRequest(q("file" to "a.ts", "root" to "C:\\repo\\e2e")) as Glue.OpenRequest.File).root)
        assertEquals(false, (Glue.parseOpenRequest(q("file" to "a.ts", "check" to "0")) as Glue.OpenRequest.File).check)
        assertEquals(true, (Glue.parseOpenRequest(mapOf("file" to listOf("a.ts"), "check" to emptyList())) as Glue.OpenRequest.File).check)
    }

    @Test
    fun `an open request refuses a missing file, network paths, parent segments and bad positions`() {
        fun refused(vararg pairs: Pair<String, String>) = (Glue.parseOpenRequest(pairs.groupBy({ it.first }, { it.second })) as Glue.OpenRequest.Refused).error
        assertEquals("file is required", refused("line" to "3"))
        assertEquals("network paths are not supported", refused("file" to "\\\\attacker\\share\\a.ts"))
        assertEquals("network paths are not supported", refused("file" to "//attacker/share/a.ts"))
        assertEquals("file must not contain '..'", refused("file" to "tests/../../etc/passwd"))
        assertEquals("line must be a positive integer", refused("file" to "a.ts", "line" to "0"))
        assertEquals("column must be a positive integer", refused("file" to "a.ts", "line" to "2", "column" to "x"))
        assertEquals("root must be an absolute path", refused("file" to "a.ts", "root" to "repo"))
        assertEquals("network paths are not supported", refused("file" to "a.ts", "root" to "\\\\attacker\\share"))
    }

    /** A debug request's query, as the dashboard writes it, with `fields` over its own; a null value leaves one out. */
    private fun debugQuery(vararg fields: Pair<String, String?>): Map<String, List<String>> {
        val all = linkedMapOf<String, String?>(
            "file" to "tests/pages/checkout.page.ts",
            "line" to "5",
            "debug" to "1",
            "spec" to "tests/checkout.spec.ts",
            "test" to "checkout › pays with a coupon",
            "playwrightProject" to "chromium",
            "execution" to "900",
        )
        for ((name, value) in fields) all[name] = value
        return all.filterValues { it != null }.mapValues { listOf(it.value!!) }
    }

    @Test
    fun `a debug request names the failing line, the test, its project and its execution`() {
        assertEquals(
            Glue.OpenRequest.File(
                "tests/pages/checkout.page.ts",
                5,
                null,
                false,
                null,
                debug = Glue.DebugRequest("tests/checkout.spec.ts", "checkout › pays with a coupon", "chromium", 900),
            ),
            Glue.parseOpenRequest(debugQuery()),
        )
        // The spec is the failing file when the request names none; a title of quotes and a shell's characters is text.
        assertEquals(
            Glue.DebugRequest("tests/a.spec.ts", "shows \"Welcome\" for \$5 (50% off!)", null, null),
            (Glue.parseOpenRequest(
                debugQuery(
                    "file" to "tests/a.spec.ts",
                    "spec" to null,
                    "test" to "shows \"Welcome\" for \$5 (50% off!)",
                    "playwrightProject" to null,
                    "execution" to null,
                ),
            ) as Glue.OpenRequest.File).debug,
        )
        assertEquals(null, (Glue.parseOpenRequest(debugQuery("debug" to null)) as Glue.OpenRequest.File).debug)
    }

    @Test
    fun `a debug request carries the name the dashboard gave the run, and refuses another`() {
        val named = Glue.parseOpenRequest(debugQuery("ref" to "ed-0123456789abcdef")) as Glue.OpenRequest.File
        assertEquals("ed-0123456789abcdef", named.debug?.ref)
        assertEquals("ed-0123456789abcdef", Glue.debugRunArgs("file:///s", "file:///f", 5, named.debug!!).debug?.ref)
        for (ref in listOf("ed-1", "ed-01234567", "terminal-1-2", "ed-0123456789ABCDEF")) {
            val refused = Glue.parseOpenRequest(debugQuery("ref" to ref)) as Glue.OpenRequest.Refused
            assertEquals(ref, "ref must be a run name the dashboard gives", refused.error)
        }
    }

    @Test
    fun `A run another tool asks to stop ends when this IDE started it, else is refused saying where to stop it`() {
        assertEquals(RunControlResult(ok = true, message = "The IDE stops the run."), Glue.stopRunAnswer(true))
        assertEquals(
            RunControlResult(ok = false, message = "The run was not started in this IDE: stop it where it was started."),
            Glue.stopRunAnswer(false),
        )
    }

    @Test
    fun `Hold failures turns the only live run's over, asks among several, and says who set it when an agent did`() {
        fun held(ref: String, on: Boolean, ended: Boolean = false) =
            RunSession(ref = ref, ended = ended, hold = RunHoldFailures(on = on, by = "start"))
        assertEquals(Glue.HoldTarget.None("No run of this project can hold its failures now."), Glue.holdTarget(emptyMap()))
        assertEquals(Glue.HoldTarget.One("ed-1", true), Glue.holdTarget(mapOf("ed-1" to held("ed-1", false))))
        assertEquals(Glue.HoldTarget.One("ed-1", false), Glue.holdTarget(mapOf("ed-1" to held("ed-1", true))))
        // A run nobody attends has none, and an ended run is not turned over.
        val unattended = RunSession(ref = "lab-1")
        assertEquals(
            Glue.HoldTarget.Choose(listOf("ed-1", "ed-2")),
            Glue.holdTarget(mapOf("ed-1" to held("ed-1", false), "ed-2" to held("ed-2", true), "lab-1" to unattended, "ed-3" to held("ed-3", true, ended = true))),
        )
        assertEquals("Hold failures on: a failed test waits at its line", Glue.holdText(RunHoldFailures(true, "start")))
        assertEquals("Hold failures off", Glue.holdText(RunHoldFailures(false, "person")))
        assertEquals("Hold failures on: a failed test waits at its line, as an agent set it", Glue.holdText(RunHoldFailures(true, "agent")))
        // The action is offered only while a run has one, and says what a click does to the only one.
        assertEquals(false, Glue.runControls(mapOf("lab-1" to unattended)).holdable)
        assertEquals("Turn hold failures off", Glue.holdActionText(Glue.runControls(mapOf("ed-1" to held("ed-1", true)))))
        assertEquals("Turn hold failures on", Glue.holdActionText(Glue.runControls(mapOf("ed-1" to held("ed-1", false)))))
        val two = Glue.runControls(mapOf("ed-1" to held("ed-1", false), "ed-2" to held("ed-2", true)))
        assertEquals(true, two.holdable)
        assertEquals("Turn hold failures on or off for the run", Glue.holdActionText(two))
        // The chooser names each run apart: its page, else its folder and ref.
        assertEquals("Run #42", Glue.runLabel(held("ed-1", true).copy(page = RunPage(42, "https://piwi.example/test-runs/42"))))
        assertEquals("Run in shop (ed-2)", Glue.runLabel(held("ed-2", true).copy(root = "/work/shop")))
        assertEquals("Run ed-3", Glue.runLabel(held("ed-3", true)))
    }

    @Test
    fun `a run in progress names its number, a CI run says so, and the editor's own stays in view from another config`() {
        val inProgress = LiveRun(runId = 124, status = "running", done = 4, total = 9, failed = 0, own = false, ci = true)
        fun live(vararg contexts: RunStatus) = RunStatusResult(contexts.toList())
        val ci = Glue.statusView(connected, live(RunStatus(root = "/w", branch = "main", live = inProgress)))
        assertEquals("Piwi: CI run #124 · 4/9", ci.text)
        assertEquals(true, ci.tooltip.contains("\nCI run #124 is running: 4/9"))
        // Two configs: the file is in the second, the editor's own run in the first.
        val two = StatusResult(listOf(connected.contexts!!.single(), connected.contexts!!.single().copy(root = "/w/admin")))
        val own = inProgress.copy(own = true, ci = false, url = "http://piwi/test-runs/124")
        val runs = live(RunStatus(root = "/w", live = own), RunStatus(root = "/w/admin"))
        assertEquals("Piwi: run #124 · 4/9 · yours", Glue.statusView(two, runs, file = "/w/admin/tests/a.spec.ts").text)
        assertEquals(own, Glue.liveRun(two, runs, "/w/admin/tests/a.spec.ts"))
        val notOwn = live(RunStatus(root = "/w", live = own.copy(own = false)), RunStatus(root = "/w/admin"))
        assertEquals(null, Glue.liveRun(two, notOwn, "/w/admin/tests/a.spec.ts"))
        // A config that is not connected counts none, as its status bar asks to connect.
        val unconnected = StatusResult(listOf(connected.contexts!!.single().copy(connected = false)))
        assertEquals(null, Glue.liveRun(unconnected, live(RunStatus(root = "/w", live = own)), "/w/tests/a.spec.ts"))
        // With one config, its run counts whatever the root it reports.
        assertEquals(own, Glue.liveRun(connected, live(RunStatus(root = "/elsewhere", live = own)), "/w/tests/a.spec.ts"))
    }

    @Test
    fun `the progress names the run's number, and a stop or a share keeps it beside them`() {
        val page = RunPage(78, "https://piwi.example.com/test-runs/78")
        val run = RunSession("ed-1", "/w", emptyList(), false, progress = RunProgress(total = 9, done = 3), page = page)
        assertEquals("Piwi: run #78 · 3 of 9", Glue.runProgressText(mapOf("ed-1" to run)))
        assertEquals(listOf("ed-1" to page), Glue.runPages(mapOf("ed-1" to run, "ed-2" to run.copy(ref = "ed-2", page = null))))
        assertEquals(
            "Piwi: paused · cart.spec.ts:12 · run #78 · 3 of 9",
            Glue.withProgress("Piwi: paused · cart.spec.ts:12", Glue.runProgressText(mapOf("ed-1" to run))),
        )
        assertEquals("Piwi: shared live", Glue.withProgress("Piwi: shared live", null))
    }

    @Test
    fun `a debug request refuses every field it does not take, and a field given twice`() {
        fun refused(query: Map<String, List<String>>) = (Glue.parseOpenRequest(query) as Glue.OpenRequest.Refused).error
        for (line in listOf("0", "-1", "1.5", "1e3", "05", "+5", "five", "99999999999")) {
            assertEquals(line, "line must be a positive whole number", refused(debugQuery("line" to line)))
        }
        assertEquals("line must be a positive whole number", refused(debugQuery("line" to null)))
        assertEquals("debug must be 1", refused(debugQuery("debug" to "true")))
        assertEquals("file must not contain '..'", refused(debugQuery("file" to "tests/../../etc/passwd")))
        assertEquals("spec must not contain '..'", refused(debugQuery("spec" to "tests\\..\\..\\secret.spec.ts")))
        assertEquals("network paths are not supported", refused(debugQuery("spec" to "//attacker/share/a.spec.ts")))
        // Every control character, as VS Code refuses them, not the NUL alone.
        assertEquals("spec must not contain a control character", refused(debugQuery("spec" to "tests/a\u001b.spec.ts")))
        for (title in listOf(
            "",
            "[Run](command:workbench.action.terminal.new)",
            "<a href=\"https://evil.example\">pays</a>",
            "pays`rm -rf ~`",
            "one\ntwo",
            "a\\b",
            "x".repeat(1001),
        )) {
            assertEquals(title, "test must be a title of 1 to 1000 characters of plain text", refused(debugQuery("test" to title)))
        }
        // PowerShell reads “ ” „ as `"`: one would end the quoted --project and run what follows.
        val smartQuotes = listOf("chromium\u201C ; calc.exe ; #", "chromium\u201D ; calc.exe", "a\u201Eb")
        for (project in listOf("chromium\$(touch pwned)", "a\"b", "%PATH%", "x!", "<b>", "p".repeat(201)) + smartQuotes) {
            assertEquals(
                project,
                "playwrightProject must be a project name of 1 to 200 characters of plain text",
                refused(debugQuery("playwrightProject" to project)),
            )
        }
        for (execution in listOf("0", "abc", "-3", "2147483648")) {
            assertEquals(execution, "execution must be an id", refused(debugQuery("execution" to execution)))
        }
        assertEquals("file is given twice", refused(debugQuery() + ("file" to listOf("a.spec.ts", "/etc/passwd"))))
        assertEquals("test is given twice", refused(debugQuery() + ("test" to listOf("pays", "refunds"))))
    }

    @Test
    fun `a debug request's files are in the project, under a Playwright config's folder, with every link followed`() {
        val roots = listOf("/home/me/shop")
        val configs = listOf("/home/me/shop/e2e")
        fun refusal(canonical: String, spec: Boolean) = Glue.debugFileRefusal("named.ts", canonical, roots, configs, spec)
        assertEquals(null, refusal("/home/me/shop/e2e/tests/checkout.spec.ts", true))
        assertEquals(null, refusal("/home/me/shop/e2e/tests/pages/checkout.page.ts", false))
        // A link in the project to a file outside it is followed out.
        assertEquals("named.ts is outside the project's folders", refusal("/home/me/elsewhere/evil.spec.ts", true))
        assertEquals("named.ts is outside the project's folders", refusal("/home/me/shop-old/e2e/a.spec.ts", true))
        assertEquals("named.ts is under no Playwright config's folder", refusal("/home/me/shop/scripts/seed.spec.ts", true))
        assertEquals("named.ts is not a spec", refusal("/home/me/shop/e2e/tests/pages/checkout.page.ts", true))
        assertEquals("named.ts is not a JavaScript or TypeScript file", refusal("/home/me/shop/e2e/tests/data.json", false))
    }

    @Test
    fun `a spec beside a Rider solution is found and debugged from one list of the project's folders`() {
        // Rider's project folder is under the solution's .idea; the Playwright config is in a sibling folder, found
        // through Git (the search roots), and the content roots name the backend alone.
        val roots = Glue.openRoots(
            contextRoots = listOf("/home/me/shop/e2e"),
            configDirs = listOf("/home/me/shop/e2e"),
            searchRoots = listOf("/home/me/shop"),
            basePath = "/home/me/shop/backend/.idea/.idea.Shop",
            contentRoots = listOf("/home/me/shop/backend"),
        )
        assertEquals(
            listOf("/home/me/shop/e2e", "/home/me/shop", "/home/me/shop/backend", "/home/me/shop/backend/.idea/.idea.Shop"),
            roots,
        )
        val spec = "/home/me/shop/e2e/tests/checkout.spec.ts"
        assertEquals(null, Glue.debugFileRefusal("checkout.spec.ts", spec, roots, listOf("/home/me/shop/e2e"), true))
        // Within the project's folders, a file still needs a Playwright config's folder above it.
        assertEquals(
            "tools.spec.ts is under no Playwright config's folder",
            Glue.debugFileRefusal("tools.spec.ts", "/home/me/shop/backend/tools.spec.ts", roots, listOf("/home/me/shop/e2e"), true),
        )
        // Nothing outside them.
        assertEquals(
            "evil.spec.ts is outside the project's folders",
            Glue.debugFileRefusal("evil.spec.ts", "/home/me/elsewhere/evil.spec.ts", roots, listOf("/home/me/shop/e2e"), true),
        )
    }

    @Test
    fun `a debug request asks before it runs, and its yes runs the test to stop once at the failing line`() {
        assertEquals(
            "Debug this test here? Piwi runs “checkout › pays” headed, one worker, and stops at line 5.",
            Glue.debugPrompt("checkout › pays", 5),
        )
        assertEquals(
            "Debug this test here? Piwi runs “checkout › pays” in the Playwright project “Mobile Chrome”, headed, one " +
                "worker, and stops at line 5.",
            Glue.debugPrompt("checkout › pays", 5, "Mobile Chrome"),
        )
        assertEquals(
            "This Debug in my editor link was refused: line must be a positive whole number. Nothing was opened or run.",
            Glue.debugRefusal("line must be a positive whole number"),
        )
        assertEquals(
            RunTestsArgs(
                uri = "file:///home/me/shop/e2e/tests/checkout.spec.ts",
                testIds = emptyList(),
                debug = DebugRun(
                    EditorBreakpoint("file:///home/me/shop/e2e/tests/pages/checkout.page.ts", 4),
                    "checkout › pays",
                    "chromium",
                    900,
                ),
            ),
            Glue.debugRunArgs(
                "file:///home/me/shop/e2e/tests/checkout.spec.ts",
                "file:///home/me/shop/e2e/tests/pages/checkout.page.ts",
                5,
                Glue.DebugRequest("tests/checkout.spec.ts", "checkout › pays", "chromium", 900),
            ),
        )
        // The run request the service reads: no test id or location, the debug run in their place.
        assertEquals(
            JsonParser.parseString(
                """{"uri":"file:///s.spec.ts","testIds":[],"debug":{"stop":{"uri":"file:///p.ts","line":4},"title":"pays"}}""",
            ),
            Gson().toJsonTree(Glue.debugRunArgs("file:///s.spec.ts", "file:///p.ts", 5, Glue.DebugRequest("s.spec.ts", "pays", null, null))),
        )
    }

    @Test
    fun `a relative path is looked up under each root once, an absolute one as is`() {
        assertEquals(
            listOf("/repo/e2e/tests/a.spec.ts", "/repo/tests/a.spec.ts"),
            Glue.candidatePaths("./tests/a.spec.ts", listOf("/repo/e2e/", "/repo", "/repo/", "")),
        )
        assertEquals(listOf("C:/repo/web/a.ts"), Glue.candidatePaths("a.ts", listOf("C:\\repo\\web")))
        assertEquals(listOf("/home/me/repo/a.ts"), Glue.candidatePaths("/home/me/repo/a.ts", listOf("/other")))
        assertEquals(listOf("D:/repo/a.ts"), Glue.candidatePaths("D:\\repo\\a.ts", listOf("/other")))
    }

    @Test
    fun `Disconnect asks about what is saved, and nothing when nothing is`() {
        assertEquals("Forget https://piwi.corp, the project, and the API key saved for it?", Glue.disconnectQuestion("https://piwi.corp", "Shop"))
        assertEquals("Forget the project Shop saved for the desktop app?", Glue.disconnectQuestion("", "Shop"))
        assertEquals(null, Glue.disconnectQuestion("", ""))
        assertEquals("Forget the choice of the desktop app?", Glue.disconnectQuestion("", "", desktop = true))
        assertEquals(
            "Forget https://piwi.corp, the project, and the API key saved for it, and the choice of the desktop app?",
            Glue.disconnectQuestion("https://piwi.corp", "Shop", desktop = true),
        )
    }

    @Test
    fun `the status item shows the error's icon while every stop held is a failure`() {
        val stop = RunStop("pause", "Click", "file:///w/a.spec.ts", 3, 2, null, true, "2026-10-25T10:00:00.000Z")
        val paused = Glue.ShownStop("ed-1", 0, stop, null)
        val failed = Glue.ShownStop("ed-1", 1, stop.copy(reason = "failure"), null)
        assertFalse(Glue.heldFailuresOnly(emptyList()))
        assertTrue(Glue.heldFailuresOnly(listOf(failed)))
        assertFalse(Glue.heldFailuresOnly(listOf(failed, paused)))
    }

    @Test
    fun `a failing test's tint takes its lines' breaks, so it runs to the editor's edge`() {
        // "a\nbc\n" (6 characters): the first line ends at 1, the second at 4, the empty last line at 6.
        assertEquals(2, Glue.lineEndWithBreak(1, 6))
        assertEquals(5, Glue.lineEndWithBreak(4, 6))
        assertEquals(6, Glue.lineEndWithBreak(6, 6))
    }

    @Test
    fun `the tool window tells an instance that does not answer, no run and no connection apart`() {
        val down = Glue.failuresEmpty(FailuresView("unreachable", "Could not reach https://piwi.corp: timeout. Piwi tries again on its own."), null, null)
        assertEquals("Could not reach https://piwi.corp: timeout. Piwi tries again on its own.", down.text)
        assertEquals(listOf(Glue.EmptyLink.RETRY, Glue.EmptyLink.SETTINGS), down.links)
        val none = Glue.failuresEmpty(FailuresView("norun", "No run of feature/x yet."), null, null)
        assertEquals(Glue.EmptyText("No run of feature/x yet.", listOf(Glue.EmptyLink.COMPARE)), none)
        assertEquals("Baseline: run #9 (no run)", Glue.failuresEmpty(FailuresView("norun", "No run of main yet."), "Baseline: run #9 (no run)", null).text)
        assertEquals(Glue.EmptyText("Not connected to a Piwi instance", listOf(Glue.EmptyLink.CONNECT)), Glue.failuresEmpty(FailuresView("disconnected"), null, null))
        assertEquals(
            Glue.EmptyText("Piwi is not connected to an instance, so it has no run to show.", listOf(Glue.EmptyLink.CONNECT)),
            Glue.failuresEmpty(FailuresView("disconnected", "Piwi is not connected to an instance, so it has no run to show."), null, null),
        )
        assertEquals(Glue.EmptyText("Piwi is reading the instance…"), Glue.failuresEmpty(FailuresView("loading", "Piwi is reading the instance…"), null, null))
        assertEquals(listOf(Glue.EmptyLink.RETRY), Glue.failuresEmpty(FailuresView("desktop-unproven", "Restart or update the desktop app."), null, null).links)
        assertEquals(Glue.EmptyText("No failure in run #41"), Glue.failuresEmpty(FailuresView("clear", "No failure in the latest run of main."), null, 41))
    }

    @Test
    fun `test connection says whether the typed address answers and asks for a key, or why it does not`() {
        assertEquals(
            "https://piwi.example.com answers. It asks for an API key: Connect… signs in or takes one.",
            Glue.testConnectionText("https://piwi.example.com", needsKey = true),
        )
        assertEquals("http://127.0.0.1:3000 answers, and lists its projects without a key.", Glue.testConnectionText("http://127.0.0.1:3000", false))
        assertEquals(
            "Could not connect to https://piwi.example: nothing answers there. Is the instance running, on that port?",
            Glue.testConnectionFailure(
                "https://piwi.example",
                Glue.connectFailure(java.net.ConnectException("Connection refused"), null, "https://piwi.example"),
            ),
        )
        assertEquals(
            "Could not connect to https://example.com: not a Piwi instance: nothing answers Piwi's requests at this address (404)",
            Glue.testConnectionFailure("https://example.com", Glue.connectFailure(Exception(), 404, "https://example.com")),
        )
    }

    @Test
    fun `connect says why it failed in words, a certificate naming its host and where to trust it`() {
        val pkix = javax.net.ssl.SSLHandshakeException("PKIX path building failed: unable to find valid certification path")
        val certificate = Glue.connectFailure(java.io.IOException("handshake", pkix), null, "https://piwi.corp:8443")
        assertTrue(certificate, certificate.startsWith("the IDE does not trust the certificate of piwi.corp."))
        assertTrue(certificate, certificate.endsWith("Settings → Tools → Server Certificates"))
        assertFalse(certificate, certificate.contains("PKIX"))
        assertEquals(
            "not a Piwi instance: nothing answers Piwi's requests at this address (404)",
            Glue.connectFailure(Exception("the instance answered 404"), 404, "https://example.com"),
        )
        assertEquals("the instance refused the key (401)", Glue.connectFailure(Exception(), 401, null))
        assertEquals("the instance answered 502", Glue.connectFailure(Exception(), 502, null))
        assertEquals(
            "nothing answers there. Is the instance running, on that port?",
            Glue.connectFailure(java.net.ConnectException("Connection refused"), null, "http://localhost:3000"),
        )
        // The JDK's connect timeout carries a ConnectException as its cause.
        val timeout = java.net.http.HttpConnectTimeoutException("HTTP connect timed out")
        timeout.initCause(java.net.ConnectException("HTTP connect timed out"))
        assertEquals("no answer within 10 seconds", Glue.connectFailure(timeout, null, "https://piwi.corp"))
        // A handshake that fails for another reason than the certificate gives its own message.
        assertEquals(
            "Remote host terminated the handshake",
            Glue.connectFailure(javax.net.ssl.SSLHandshakeException("Remote host terminated the handshake"), null, "https://piwi.corp"),
        )
        assertEquals("unknown host piwi.nowhere", Glue.connectFailure(java.net.UnknownHostException("piwi.nowhere"), null, null))
        assertEquals("the reason it gives", Glue.connectFailure(Exception("the reason it gives"), null, null))
        assertEquals(
            "no answer within 15 seconds",
            Glue.connectFailure(java.net.http.HttpTimeoutException("request timed out"), null, "https://piwi.corp"),
        )
        assertEquals(
            "the certificate of piwi.corp has expired",
            Glue.connectFailure(
                javax.net.ssl.SSLHandshakeException("handshake").apply { initCause(java.security.cert.CertificateExpiredException("expired")) },
                null,
                "https://piwi.corp",
            ),
        )
        assertEquals(
            "the certificate of piwi.corp names another address: use the address it was issued for",
            Glue.connectFailure(
                javax.net.ssl.SSLHandshakeException("No subject alternative DNS name matching piwi.corp found."),
                null,
                "https://piwi.corp",
            ),
        )
        assertEquals(
            "piwi.corp does not answer HTTPS there: try http://",
            Glue.connectFailure(javax.net.ssl.SSLException("Unsupported or unrecognized SSL message"), null, "https://piwi.corp"),
        )
        assertEquals(
            "not a Piwi instance: the address answers with a page, not Piwi's requests",
            Glue.connectFailure(com.google.gson.JsonSyntaxException("Expected BEGIN_OBJECT"), null, "https://example.com"),
        )
    }

    @Test
    fun `connect's failure words are the editor service's, which VS Code reads`() {
        val file = java.io.File("../../packages/editor/src/connect-failures.json")
        assertTrue(file.absolutePath, file.isFile)
        val table = com.google.gson.Gson().fromJson(file.readText(), Map::class.java)
        assertEquals(table, Glue.CONNECT_FAILURE_WORDS)
        assertEquals(table.keys.toList(), Glue.CONNECT_FAILURE_WORDS.keys.toList())
    }

    @Test
    fun `an instance on this machine is tried on every loopback address`() {
        assertEquals(
            listOf("http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"),
            Glue.loopbackAlternatives("http://localhost:3000"),
        )
        assertEquals(listOf("http://127.0.0.1:3000/piwi", "http://[::1]:3000/piwi"), Glue.loopbackAlternatives("http://127.0.0.1:3000/piwi"))
        assertEquals(listOf("https://LOCALHOST", "https://127.0.0.1", "https://[::1]"), Glue.loopbackAlternatives("https://LOCALHOST"))
        assertEquals(listOf("http://localhost.example.com:3000"), Glue.loopbackAlternatives("http://localhost.example.com:3000"))
        assertEquals(listOf("https://piwi.corp"), Glue.loopbackAlternatives("https://piwi.corp"))
        assertEquals(true, Glue.isLoopback("http://[::1]:3000"))
        assertEquals(false, Glue.isLoopback("http://127.0.0.10:3000"))
    }

    @Test
    fun `the desktop app is named as a source`() {
        assertEquals("the Piwi desktop app", Glue.sourceLabel("desktop"))
    }

    private val desktop = DesktopResult("http://127.0.0.1:3000", listOf(ProjectRef(3, "Shop")), ProjectRef(3, "Shop"))

    private val team = StatusResult(
        listOf(connected.contexts!!.single().copy(instance = NamedInstance("http://piwi", "dotenv"))),
        desktopUrl = "http://127.0.0.1:3000",
    )

    @Test
    fun `Connect offers the desktop app, the instance the project names, and another one`() {
        assertEquals(
            listOf(
                Glue.ConnectChoice(
                    Glue.ConnectTarget.DESKTOP,
                    "The Piwi desktop app, at http://127.0.0.1:3000",
                    "Runs on this machine; this folder is linked there to the project Shop.",
                    null,
                    false,
                ),
                Glue.ConnectChoice(Glue.ConnectTarget.INSTANCE, "http://piwi", "From the workspace .env.", "http://piwi", true),
                Glue.ConnectChoice(Glue.ConnectTarget.OTHER, "Another instance…", "A Piwi server, by its address.", null, false),
            ),
            Glue.connectChoices(team, desktop, ""),
        )
        // With the app in use, the instance is still one choice away; saved only in the settings, it comes from there.
        val onDesktop = StatusResult(
            listOf(team.contexts!!.single().copy(serverUrl = "http://127.0.0.1:3000", source = "desktop", instance = null)),
            desktopUrl = "http://127.0.0.1:3000",
        )
        val choices = Glue.connectChoices(onDesktop, desktop, "https://piwi.corp/")
        assertEquals(listOf(true, false, false), choices.map { it.inUse })
        assertEquals("https://piwi.corp" to "From Settings → Tools → Piwi.", choices[1].serverUrl to choices[1].detail)
        // Before the service starts: the app and the instance saved here.
        assertEquals(3, Glue.connectChoices(null, desktop, "https://piwi.corp").size)
    }

    @Test
    fun `the status says when the desktop app runs unused, or was chosen and does not run`() {
        assertEquals(
            "Connected to Acme on main at http://piwi, from the workspace .env. " +
                "The Piwi desktop app runs on this machine: Connect to use it.",
            Glue.connectionSummary(team),
        )
        assertEquals(
            "The Piwi desktop app, chosen with Connect, is not running.",
            Glue.statusView(connected, runs(passed), desktopChosen = true).tooltip.lines().last(),
        )
        assertEquals("", Glue.desktopHint(connected, desktopChosen = false))
    }

    @Test
    fun `reads the desktop app's discovery file, and the deepest linked folder wins`() {
        val discovery = Glue.parseDesktopDiscovery(
            """{"url":"http://127.0.0.1:3000/","token":"pd_x","projects":[{"id":"3","path":"/a"},{"id":5},""" +
                """{"id":6,"path":"/w"},{"id":8,"path":"/w/app"}]}""",
        )
        assertEquals(Glue.DesktopDiscovery("http://127.0.0.1:3000", "pd_x", listOf(6 to "/w", 8 to "/w/app")), discovery)
        assertEquals(8, Glue.linkedDesktopProject(discovery!!.links, Path.of("/w/app/tests")))
        assertEquals(6, Glue.linkedDesktopProject(discovery.links, Path.of("/w/other")))
        assertEquals(null, Glue.linkedDesktopProject(discovery.links, Path.of("/elsewhere")))
        assertEquals(null, Glue.parseDesktopDiscovery("""{"url":"http://127.0.0.1:3000"}"""))
        assertEquals(null, Glue.parseDesktopDiscovery("not json"))
        assertEquals(Path.of("/tmp/d.json"), Glue.desktopConfigPath(mapOf("PIWI_DESKTOP_CONFIG" to "/tmp/d.json"), "/home/me"))
        assertEquals(Path.of("/home/me", ".piwi", "desktop.json"), Glue.desktopConfigPath(emptyMap(), "/home/me"))
    }

    /** An editor service's discovery file, as `writeDiscovery` in the service writes it. */
    private fun discoveryFile(
        pid: Long,
        port: Int,
        startedAt: String,
        hubToken: String = "hub-token-$port-0123456789",
        host: String = "dev-laptop",
    ) = """
        {
          "pid": $pid,
          "host": "$host",
          "version": "0.60.0",
          "client": "WebStorm",
          "startedAt": "$startedAt",
          "roots": ["/work/shop-$port", 7],
          "hub": { "url": "ws://127.0.0.1:$port/piwi/hub", "token": "$hubToken" },
          "runChannel": { "path": "/tmp/piwi-record/channel.sock", "token": "channel-token-0123456789" },
          "recorderBundle": null,
          "later": true
        }
    """.trimIndent()

    @Test
    fun `reads the hub of an editor service's discovery file, for Piwi Picker, and none of the run channel`() {
        assertEquals(
            Glue.LiveHub(
                url = "ws://127.0.0.1:43123/piwi/hub", token = "hub-token-43123-0123456789", pid = 42, version = "0.60.0",
                client = "WebStorm", roots = listOf("/work/shop-43123"), startedAt = "2026-10-25T10:00:00.000Z",
            ),
            Glue.parseLiveHub(discoveryFile(42, 43123, "2026-10-25T10:00:00.000Z"), 42),
        )
        assertEquals("a file naming another process", null, Glue.parseLiveHub(discoveryFile(42, 43123, "x"), 7))
        assertEquals("a hub elsewhere than this machine", null, Glue.parseLiveHub(discoveryFile(42, 43123, "x").replace("127.0.0.1", "evil.test"), 42))
        assertEquals("a token too short", null, Glue.parseLiveHub(discoveryFile(42, 43123, "x", hubToken = "short"), 42))
        assertEquals(null, Glue.parseLiveHub("""{"pid":42,"hub":null}""", 42))
        assertEquals(null, Glue.parseLiveHub("{ half", 42))
        assertEquals(Glue.EditorDiscovery(42, "", null), Glue.parseEditorDiscovery("""{"pid":42,"hub":null}"""))
        assertEquals("dev-laptop", Glue.parseEditorDiscovery(discoveryFile(42, 43123, "x"))?.host)
        for (broken in listOf("""{"pid":0}""", """{"pid":"42"}""", """{"pid":1.5}""", "[]", "{ half")) {
            assertEquals(broken, null, Glue.parseEditorDiscovery(broken))
        }
        assertEquals(Path.of("/tmp/e"), Glue.editorsDir(mapOf("PIWI_EDITORS_DIR" to "/tmp/e"), "/home/me"))
        assertEquals(Path.of("/home/me", ".piwi", "editors"), Glue.editorsDir(emptyMap(), "/home/me"))
    }

    @Test
    fun `lists the hubs of the running editor services oldest first, and deletes the files of those gone`() {
        val dir = Files.createTempDirectory("piwi-editors")
        Files.writeString(dir.resolve("12.json"), discoveryFile(12, 43002, "2026-10-25T10:00:02.000Z", host = "DEV-LAPTOP"))
        Files.writeString(dir.resolve("11.json"), discoveryFile(11, 43001, "2026-10-25T10:00:01.000Z"))
        Files.writeString(dir.resolve("13.json"), discoveryFile(13, 43003, "2026-10-25T10:00:03.000Z"))
        Files.writeString(dir.resolve(".14.json.1a2b.tmp"), discoveryFile(14, 43004, "x"))
        Files.writeString(dir.resolve("15.json"), "{ half")
        val hubs = Glue.liveHubs(dir, "dev-laptop") { it != 13L }
        assertEquals(listOf(11L, 12L), hubs.map { it.pid })
        assertEquals(false, Files.exists(dir.resolve("13.json")))
        assertEquals("an unreadable file of a running process stays", true, Files.exists(dir.resolve("15.json")))
        assertEquals("the run channel's token is never listed", false, Gson().toJson(hubs).contains("channel-token"))
        assertEquals(emptyList<Glue.LiveHub>(), Glue.liveHubs(dir.resolve("missing"), "dev-laptop") { true })
        assertEquals(emptyList<Glue.LiveHub>(), Glue.liveHubs(null, "dev-laptop") { true })
    }

    @Test
    fun `deletes no file but a service's of this machine, and skips another machine's`() {
        val dir = Files.createTempDirectory("piwi-editors")
        val files = mapOf(
            // A person's own numbered files, in a folder PIWI_EDITORS_DIR names.
            "2024.json" to """{"my":"report"}""",
            "21.json" to "{ half",
            "22.json" to discoveryFile(23, 43023, "x"),
            // A service of another machine sharing the home folder: its process is that machine's.
            "24.json" to discoveryFile(24, 43024, "x", host = "build-agent"),
            "25.json" to discoveryFile(25, 43025, "x", host = "build-agent"),
            "26.json" to discoveryFile(26, 43026, "x").replace("\"host\": \"dev-laptop\",", ""),
        )
        for ((name, text) in files) Files.writeString(dir.resolve(name), text)
        assertEquals(emptyList<Glue.LiveHub>(), Glue.liveHubs(dir, "dev-laptop") { it == 25L })
        assertEquals(files.keys.sorted(), Files.list(dir).use { it.map { p -> p.fileName.toString() }.toList() }.sorted())
    }

    @Test
    fun `reads nothing from a folder others can enter, a link, nor through a file that is a link`() {
        val base = Files.createTempDirectory("piwi-editors")
        if (Files.getFileStore(base).supportsFileAttributeView("posix").not()) return
        val dir = Files.createDirectory(base.resolve("editors"), java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rwx------")))
        Files.writeString(dir.resolve("31.json"), discoveryFile(31, 43031, "x"))
        assertEquals(listOf(31L), Glue.liveHubs(dir, "dev-laptop") { true }.map { it.pid })
        Files.setPosixFilePermissions(dir, java.nio.file.attribute.PosixFilePermissions.fromString("rwxr-xr-x"))
        assertEquals(emptyList<Glue.LiveHub>(), Glue.liveHubs(dir, "dev-laptop") { true })
        Files.setPosixFilePermissions(dir, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"))
        val link = Files.createSymbolicLink(base.resolve("link"), dir)
        assertEquals(emptyList<Glue.LiveHub>(), Glue.liveHubs(link, "dev-laptop") { true })
        val elsewhere = Files.writeString(base.resolve("elsewhere.json"), discoveryFile(32, 43032, "x"))
        Files.createSymbolicLink(dir.resolve("32.json"), elsewhere)
        assertEquals("a file that is a link is neither read nor deleted", listOf(31L), Glue.liveHubs(dir, "dev-laptop") { it == 31L }.map { it.pid })
        assertEquals(true, Files.isSymbolicLink(dir.resolve("32.json")))
    }

    @Test
    fun `proves the pairing's token for the port it answers on, as the editor service's core does`() {
        // The proof `editorTokenProof` in `@piwitests/core/editor-send` makes of the same token, port and challenge.
        val challenge = "cd".repeat(32)
        assertEquals(
            "ddda276ac84f6fa82231775360760e06e80f4acb757fa5146d48a71945f6af77",
            Glue.editorTokenProof("abcdefghijklmnop_1234", 63342, challenge),
        )
        assertEquals(false, Glue.editorTokenProof("abcdefghijklmnop_1234", 63343, challenge) == Glue.editorTokenProof("abcdefghijklmnop_1234", 63342, challenge))
        assertEquals(true, Glue.isEditorChallenge(challenge))
        assertEquals(true, Glue.isEditorChallenge("a".repeat(128)))
        for (value in listOf(null, "ab".repeat(15), "AB".repeat(16), "g".repeat(32), "a".repeat(129), " " + "a".repeat(32))) {
            assertEquals(value.toString(), false, Glue.isEditorChallenge(value))
        }
        assertEquals("x-piwi-editor-challenge", Glue.EDITOR_CHALLENGE_HEADER)
        assertEquals("x-piwi-editor-proof", Glue.EDITOR_PROOF_HEADER)
    }

    private fun tree(vararg files: String): Path {
        val dir = Files.createTempDirectory("piwi-glue").toRealPath()
        for (file in files) {
            val path = dir.resolve(file)
            Files.createDirectories(path.parent)
            Files.writeString(path, "")
        }
        return dir
    }

    @Test
    fun `a Rider solution's files are in the folder above its idea folder`() {
        assertEquals("C:/src/Shop", Glue.projectFolder("C:\\src\\Shop\\.idea\\.idea.Shop"))
        assertEquals("/home/me/Shop", Glue.projectFolder("/home/me/Shop/.idea/.idea.Shop.dir/"))
        assertEquals("/home/me/shop", Glue.projectFolder("/home/me/shop"))
    }

    @Test
    fun `folders inside another one are searched with it`() {
        fun path(p: String) = Path.of(p).toAbsolutePath()
        assertEquals(
            listOf(path("/w/shop"), path("/elsewhere")),
            Glue.outermost(listOf(path("/w/shop"), path("/w/shop/src/Api"), path("/w/shop"), path("/elsewhere"))),
        )
    }

    @Test
    fun `finds the configs down to four levels, past dependencies and hidden folders`() {
        val dir = tree(
            "playwright.config.ts",
            "apps/web/e2e/tests/playwright.config.mjs",
            "a/b/c/d/e/playwright.config.ts",
            "node_modules/pkg/playwright.config.js",
            ".cache/playwright.config.ts",
            "src/Shop/bin/playwright.config.txt",
        )
        assertEquals(listOf(dir, dir.resolve("apps/web/e2e/tests")), Glue.playwrightConfigDirs(listOf(dir)))
    }

    @Test
    fun `reads a Playwright for dotnet reference in any form MSBuild takes`() {
        for (reference in listOf(
            """<PackageReference Include="Microsoft.Playwright.NUnit" Version="1.49.0" />""",
            """<PackageReference Version="1.49.0" Include="Microsoft.Playwright"/>""",
            """<PackageReference Include="Microsoft.Playwright.Xunit.v3" Version="1.55.0" />""",
            """<PackageReference Include='Microsoft.Playwright.MSTest.v4' />""",
            """<PackageReference Include="NUnit; Microsoft.Playwright.NUnit" />""",
            """<PackageReference Condition="${'$'}(X) > 1" Include="Microsoft.Playwright" />""",
        )) {
            assertTrue(reference, Glue.referencesDotnetPlaywright(reference))
        }
        for (reference in listOf(
            """<PackageReference Include="Microsoft.PlaywrightSharp" />""",
            """<PackageReference Include="NUnit" />""",
            """<PackageReference Update="Microsoft.Playwright" Version="1.49.0" />""",
            """<!-- <PackageReference Include="Microsoft.Playwright" /> -->""",
        )) {
            assertFalse(reference, Glue.referencesDotnetPlaywright(reference))
        }
    }

    @Test
    fun `the settings page names what overrides its instance, the environment or a dotenv`() {
        val named = NamedInstance("https://ci.example.com", "environment")
        val env = ContextStatus(
            connected = true, serverUrl = "https://ci.example.com", source = "environment", projectName = "Acme", instance = named,
        )
        val overriding = Glue.overriding(StatusResult(contexts = listOf(env)), "https://piwi.example.com")
        assertEquals(Glue.Overriding("https://ci.example.com", "Acme", "the environment (PIWI_DASHBOARD_URL)"), overriding)
        assertEquals(
            "Overridden by the environment (PIWI_DASHBOARD_URL): Piwi reads https://ci.example.com, project Acme, not the " +
                "server URL below.",
            Glue.overriddenText(overriding!!),
        )
        // The same address as the page's overrides nothing.
        assertNull(Glue.overriding(StatusResult(contexts = listOf(env)), "https://ci.example.com/"))
        // The desktop app in use: the .env's instance comes before the page's only while the app is not.
        val desktop = ContextStatus(
            connected = true, serverUrl = "http://127.0.0.1:3000", source = "desktop", projectName = "Local",
            instance = NamedInstance("https://team.example.com", "dotenv"),
        )
        val behind = Glue.overriding(StatusResult(contexts = listOf(desktop)), "")
        assertEquals(Glue.Overriding("https://team.example.com", null, "the workspace .env", desktopFirst = true), behind)
        assertEquals(
            "The workspace .env names https://team.example.com, which Piwi reads before the server URL below while the " +
                "desktop app is not in use.",
            Glue.overriddenText(behind!!),
        )
        // With several configs, the one whose environment names it.
        val settings = ContextStatus(
            connected = true, serverUrl = "https://piwi.example.com", source = "editor", label = "api",
            instance = NamedInstance("https://piwi.example.com", "editor"),
        )
        val web = ContextStatus(
            connected = false, serverUrl = "https://ci.example.com", source = "dotenv", label = "web",
            instance = NamedInstance("https://ci.example.com", "dotenv"),
        )
        val several = Glue.overriding(StatusResult(contexts = listOf(settings, web)), "https://piwi.example.com")
        assertEquals(
            "Overridden by the workspace .env for web: Piwi reads https://ci.example.com, not the server URL below.",
            Glue.overriddenText(several!!),
        )
        assertNull(Glue.overriding(StatusResult(contexts = listOf(settings)), "https://piwi.example.com"))
        assertNull(Glue.overriding(null, ""))
    }

    @Test
    fun `finds a project referencing Playwright for dotnet where the configs are searched`() {
        val dir = tree("src/Shop/Shop.csproj", "tests/Shop.E2E/Shop.E2E.fsproj", "node_modules/x/Other.csproj")
        assertFalse(Glue.holdsDotnetPlaywright(listOf(dir)))
        Files.writeString(dir.resolve("node_modules/x/Other.csproj"), """<PackageReference Include="Microsoft.Playwright" />""")
        assertFalse("a dependency's project is skipped", Glue.holdsDotnetPlaywright(listOf(dir)))
        Files.writeString(dir.resolve("tests/Shop.E2E/Shop.E2E.fsproj"), """<ItemGroup>
            <PackageReference Include="Microsoft.Playwright.MSTest" Version="1.49.0" />
        </ItemGroup>""")
        assertTrue(Glue.holdsDotnetPlaywright(listOf(dir)))
        val props = tree("Directory.Build.props")
        Files.writeString(props.resolve("Directory.Build.props"), """<PackageReference Include="Microsoft.Playwright.NUnit" />""")
        assertTrue("the props every project imports", Glue.holdsDotnetPlaywright(listOf(props)))
    }

    @Test
    fun `searches a solution's repository for its dotnet tests`() {
        val repo = tree(".git/HEAD", "backend/Shop.sln", "tests/Shop.E2E/Shop.E2E.csproj")
        Files.writeString(repo.resolve("tests/Shop.E2E/Shop.E2E.csproj"), """<PackageReference Include="Microsoft.Playwright" />""")
        val backend = repo.resolve("backend")
        assertEquals(listOf(repo), Glue.searchedFolders(listOf(backend), null))
        assertTrue(Glue.holdsDotnetPlaywright(Glue.searchedFolders(listOf(backend), null)))
        assertEquals("the home folder's repository holds other projects", listOf(backend), Glue.searchedFolders(listOf(backend), repo))
    }

    @Test
    fun `a solution in a subfolder finds the tests beside it in the repository`() {
        val repo = tree(".git/HEAD", "backend/Shop.sln", "e2e/playwright.config.ts")
        val found = Glue.findPlaywright(listOf(repo.resolve("backend"), repo.resolve("backend/.idea/.idea.Shop")), null)
        assertEquals(Glue.PlaywrightSearch(listOf(repo), listOf(repo.resolve("e2e"))), found)
        // The project's own folders come first: a config there keeps the search to them.
        val backend = repo.resolve("backend")
        Files.writeString(backend.resolve("playwright.config.ts"), "")
        assertEquals(Glue.PlaywrightSearch(listOf(backend), listOf(backend)), Glue.findPlaywright(listOf(backend), null))
    }

    @Test
    fun `a Flake Lab job's results are offered for sharing, and a lab that could not run warns`() {
        val shared = Glue.desktopJobNotice(
            DesktopJobUpdate(
                jobId = "f00d",
                kind = "flake-lab",
                status = "done",
                message = "Flake Lab reproduced \"t\" at b0b0b0b.",
                share = DesktopJobShare("Share on piwi.example.com"),
            ),
        )
        assertEquals(
            Glue.DesktopJobNotice("Flake Lab reproduced \"t\" at b0b0b0b.", false, listOf("Share on piwi.example.com")),
            shared,
        )
        val failed = Glue.desktopJobNotice(
            DesktopJobUpdate(
                kind = "flake-lab",
                status = "done",
                message = "The desktop app could not run Flake Lab on \"t\": npm ci failed",
            ),
        )
        assertEquals(true, failed.warning)
        assertEquals(emptyList<String>(), failed.actions)
    }

    @Test
    fun `a Flake Lab job's arguments keep the test through the command`() {
        val params = Gson().fromJson("""{"root":"/shop","testCaseId":9,"kind":"flake-lab"}""", DesktopJobParams::class.java)
        assertEquals(DesktopJobParams(root = "/shop", testCaseId = 9, kind = "flake-lab"), params)
        assertEquals(null, params.executionId)
    }

    @Test
    fun `a repository in the home folder is not searched`() {
        val home = tree(".git/HEAD", "work/other/playwright.config.ts", "work/shop/Shop.sln")
        val shop = home.resolve("work/shop")
        assertEquals(Glue.PlaywrightSearch(listOf(shop), emptyList()), Glue.findPlaywright(listOf(shop), home))
    }

    @Test
    fun `a recording writes a new test outside every test, function and class, and steps anywhere else`() {
        assertEquals("test", Glue.recordInto("file"))
        assertEquals("steps", Glue.recordInto("test"))
        assertEquals("steps", Glue.recordInto("function"))
        assertEquals("steps", Glue.recordInto("class"))
    }

    @Test
    fun `the start of a line is followed through the changes made after the text was read`() {
        val text = "test('t', async ({ page }) => {\n  await page.goto('/');\n});\n"
        val closing = text.indexOf("});")
        assertEquals(closing, Glue.followLineStart(text, 2, emptyList()))
        assertEquals(text.length, Glue.followLineStart(text, 3, emptyList()))
        assertEquals(text.length, Glue.followLineStart(text, 9, emptyList()))
        assertEquals(0, Glue.followLineStart(text, -1, emptyList()))
        // Lines inserted above it, or right at it, move it down; text typed after it leaves it.
        val above = Glue.TextChange(0, 0, "// one\n// two\n")
        assertEquals(closing + 14, Glue.followLineStart(text, 2, listOf(above)))
        assertEquals(closing + 3, Glue.followLineStart(text, 2, listOf(Glue.TextChange(closing, 0, "a;\n"))))
        assertEquals(closing, Glue.followLineStart(text, 2, listOf(Glue.TextChange(closing, 0, "x"), Glue.TextChange(closing + 5, 0, "y"))))
        // A line removed above it moves it up; a change that ends on it puts it after what that change wrote.
        val second = text.indexOf("  await")
        assertEquals(second, Glue.followLineStart(text, 2, listOf(Glue.TextChange(second, closing - second, ""))))
        assertEquals(second + 4, Glue.followLineStart(text, 2, listOf(Glue.TextChange(second, closing - second, "a;\n\n"))))
        // A change across it leaves it after the last line break that change wrote, else at its start.
        assertEquals(second + 2, Glue.followLineStart(text, 2, listOf(Glue.TextChange(second, closing - second + 1, "a\nb"))))
        assertEquals(second, Glue.followLineStart(text, 2, listOf(Glue.TextChange(second, closing - second + 1, "x"))))
    }

    @Test
    fun `the recorded block indents each line with text, and leaves blank lines empty`() {
        assertEquals(
            "    test('t', async ({ page }) => {\n      await page.goto('/');\n\n    });",
            Glue.recordedBlock("test('t', async ({ page }) => {\n  await page.goto('/');\n   \n});", "    "),
        )
        assertEquals("\tawait a();\n\tawait b();", Glue.recordedBlock("await a();\r\nawait b();", "\t"))
        assertEquals("", Glue.recordedBlock("", "  "))
    }

    @Test
    fun `a block goes on a new line pushing the line there down, or takes a blank line's place`() {
        val text = "test('t', async ({ page }) => {\n  await page.goto('/');\n});\n"
        val closing = text.indexOf("});")
        assertEquals(Glue.BlockWrite(closing, closing, "  B\n", closing), Glue.firstBlockWrite(text, closing, newLine = true, block = "  B"))
        val blank = "test('t', async ({ page }) => {\n    \n});\n"
        val blankLine = blank.indexOf("    ")
        assertEquals(
            Glue.BlockWrite(blankLine, blankLine + 4, "  B", blankLine),
            Glue.firstBlockWrite(blank, blankLine, newLine = false, block = "  B"),
        )
        // A line that is not blank, or a placement asking for a new line, is pushed down.
        assertEquals(Glue.BlockWrite(closing, closing, "  B\n", closing), Glue.firstBlockWrite(text, closing, newLine = false, block = "  B"))
        assertEquals(
            Glue.BlockWrite(blankLine, blankLine, "  B\n", blankLine),
            Glue.firstBlockWrite(blank, blankLine, newLine = true, block = "  B"),
        )
    }

    @Test
    fun `a block on the last line keeps the final line break, and one after a last line with text goes below it`() {
        assertEquals(Glue.BlockWrite(4, 4, "B\n", 4), Glue.firstBlockWrite("});\n", 4, newLine = false, block = "B"))
        assertEquals(Glue.BlockWrite(0, 0, "B\n", 0), Glue.firstBlockWrite("", 0, newLine = false, block = "B"))
        assertEquals(Glue.BlockWrite(4, 6, "B\n", 4), Glue.firstBlockWrite("});\n  ", 4, newLine = false, block = "B"))
        assertEquals(Glue.BlockWrite(3, 3, "\nB", 4), Glue.firstBlockWrite("});", 3, newLine = true, block = "B"))
        // An anchor left within a line, once the line break before it was removed: the block goes after that line.
        assertEquals(Glue.BlockWrite(8, 8, "\nB", 9), Glue.firstBlockWrite("a();b();\nc();", 4, newLine = false, block = "B"))
    }

    @Test
    fun `a position the service names is an offset of the document's text`() {
        val text = "ab\ncd\nlast"
        assertEquals(0, Glue.offsetOf(text, EditPosition(0, 0)))
        assertEquals(4, Glue.offsetOf(text, EditPosition(1, 1)))
        assertEquals(6, Glue.offsetOf(text, EditPosition(2, 0)))
        // Past its line's end, or past the last line: the end of the line, of the text.
        assertEquals(5, Glue.offsetOf(text, EditPosition(1, 9)))
        assertEquals(text.length, Glue.offsetOf(text, EditPosition(7, 0)))
        assertEquals(null, Glue.offsetOf(text, null))
    }

    @Test
    fun `the service's import lines go before a block's write after it, and above the block before it`() {
        val write = Glue.BlockWrite(start = 40, end = 60, text = "block", blockStart = 40)
        assertEquals(Glue.ImportWrite(70, "import a;\n", first = true), Glue.importWrite(70, "import a;\n", write))
        assertEquals(Glue.ImportWrite(60, "import a;\n", first = true), Glue.importWrite(60, "import a;\n", write))
        assertEquals(Glue.ImportWrite(10, "import a;\n", first = false), Glue.importWrite(10, "import a;\n", write))
        assertEquals(Glue.ImportWrite(40, "import a;\n", first = false), Glue.importWrite(40, "import a;\n", write))
        // Inside the range the block replaces, nothing; nor without an edit.
        assertEquals(null, Glue.importWrite(50, "import a;\n", write))
        assertEquals(null, Glue.importWrite(null, "import a;\n", write))
        assertEquals(null, Glue.importWrite(10, "", write))
        // A block inserted where the imports go: they go above it.
        val insert = Glue.BlockWrite(start = 30, end = 30, text = "block\n", blockStart = 30)
        assertEquals(Glue.ImportWrite(30, "import a;\n", first = false), Glue.importWrite(30, "import a;\n", insert))
    }

    @Test
    fun `a recorded line's warning offers the step's other verified locators in place of the written one`() {
        val written = "locator('form > button.btn-3')"
        val step = RecordingStep(locators = listOf("getByTestId('pay')", "getByRole('button', { name: 'Pay' })", written), chosen = 2)
        val line = "await page.$written.click();"
        assertEquals(
            listOf(
                Glue.LocatorChoice("Use getByTestId('pay')", "getByTestId('pay')", 11, 41),
                Glue.LocatorChoice("Use getByRole('button', { name: 'Pay' })", "getByRole('button', { name: 'Pay' })", 11, 41),
            ),
            Glue.locatorChoices(line, step),
        )
        // After any page expression, and inside a call.
        assertEquals(2, Glue.locatorChoices("await adminPage.$written.fill(process.env.E2E_PASSWORD ?? '');", step).size)
        assertEquals(18, Glue.locatorChoices("await expect(page.$written).toBeVisible();", step).first().start)
        // A single locator, none written, or the written one not on the line exactly once: nothing.
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices(line, RecordingStep(locators = listOf(written), chosen = 0)))
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices(line, step.copy(chosen = null)))
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices(line, null))
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices("await cartPage.pay();", step))
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices("await page.$written.dragTo(page.$written);", step))
        assertEquals(emptyList<Glue.LocatorChoice>(), Glue.locatorChoices("await page.locator('form > button.btn-4').click();", step))
    }

    @Test
    fun `the banner says what the recording does and offers what applies`() {
        assertEquals(
            Glue.RecordingBanner("Piwi: opening the browser to record into this file…", listOf(Glue.RecordingAction.STOP)),
            Glue.recordingBanner("starting", 0, edited = false, stopping = false, message = null),
        )
        assertEquals(
            Glue.RecordingBanner("Piwi is recording what you do in the browser · 1 step", listOf(Glue.RecordingAction.PAUSE, Glue.RecordingAction.STOP)),
            Glue.recordingBanner("recording", 1, edited = false, stopping = false, message = " "),
        )
        assertEquals(
            Glue.RecordingBanner("Piwi: recording paused · 3 steps · Paused in the browser.", listOf(Glue.RecordingAction.RESUME, Glue.RecordingAction.STOP)),
            Glue.recordingBanner("paused", 3, edited = false, stopping = false, message = "Paused in the browser."),
        )
        assertEquals(
            listOf(Glue.RecordingAction.RESUME, Glue.RecordingAction.KEEP_EDITS),
            Glue.recordingBanner("recording", 3, edited = true, stopping = false, message = null).actions,
        )
        assertEquals(
            Glue.RecordingBanner("Piwi: stopping the recording…", emptyList()),
            Glue.recordingBanner("recording", 3, edited = true, stopping = true, message = "ignored"),
        )
    }

    @Test
    fun `the status bar shows a recording's state and step count`() {
        assertEquals("Piwi: opening the browser", Glue.recordingStatus("starting", 0, edited = false, stopping = false))
        assertEquals("Piwi: ● recording · 2 steps", Glue.recordingStatus("recording", 2, edited = false, stopping = false))
        assertEquals("Piwi: recording paused · 1 step", Glue.recordingStatus("paused", 1, edited = false, stopping = false))
        assertEquals("Piwi: recording paused · 2 steps", Glue.recordingStatus("recording", 2, edited = true, stopping = false))
        assertEquals("Piwi: stopping the recording", Glue.recordingStatus("recording", 2, edited = true, stopping = true))
    }

    @Test
    fun `the end of a recording says what was written where, and the warnings to check`() {
        assertEquals("Recorded 6 steps into checkout.spec.ts.", Glue.recordingSummary(6, 0, "checkout.spec.ts", null))
        assertEquals(
            "The browser was closed. Recorded 1 step into a.spec.ts. 1 warning to check, on its line.",
            Glue.recordingSummary(1, 1, "a.spec.ts", "The browser was closed."),
        )
        assertEquals("Recorded 2 steps into a.spec.ts. 2 warnings to check, on their lines.", Glue.recordingSummary(2, 2, "a.spec.ts", ""))
        assertEquals("Nothing was recorded into a.spec.ts.", Glue.recordingSummary(0, 0, "a.spec.ts", null))
    }

    @Test
    fun `a new spec's name gets the spec extension it lacks`() {
        assertEquals("checkout.spec.ts", Glue.specFileName(" checkout "))
        assertEquals("checkout.test.ts", Glue.specFileName("checkout.test"))
        assertEquals("checkout.spec.js", Glue.specFileName("checkout.spec.js"))
        assertEquals(".test.js", Glue.testFileSuffix("recorded.test.js"))
        assertEquals(".spec.mts", Glue.testFileSuffix("cart.spec.mts"))
        assertNull(Glue.testFileSuffix("cart.page.ts"))
        assertEquals("flow.mts", Glue.specFileName("flow.mts"))
        assertEquals("cart.page.spec.ts", Glue.specFileName("cart.page"))
        assertEquals(null, Glue.specFileName(""))
        assertEquals(null, Glue.specFileName("e2e/checkout"))
        assertEquals(null, Glue.specFileName("..\\checkout"))
        assertEquals(null, Glue.specFileName(".."))
    }

    private val treeNow = java.time.Instant.parse("2026-09-27T10:04:00Z").toEpochMilli()

    private fun node(
        key: String,
        kind: String,
        label: String,
        icon: String,
        description: String = "",
        startTime: String? = null,
        note: String? = null,
        expanded: Boolean = false,
        url: String? = null,
        executionId: Int? = null,
        children: List<FailureTreeNode> = emptyList(),
        tooltip: List<String> = listOf(label),
    ) = FailureTreeNode(key, kind, label, description, startTime, tooltip, note, icon, expanded, url, executionId, children)

    private val loginFailure = WorkspaceFailure(
        uri = "file:///w/tests/login.spec.ts", line = 41, title = "logs in", headline = "not visible", executionId = 1,
        runId = 120, url = "http://piwi/test-run-cases/1", hasTrace = true, source = "ci", state = "failing",
        browserName = "chromium", file = "tests/login.spec.ts", testCaseId = 7,
    )

    private val editedFailure = WorkspaceFailure(
        uri = "file:///w/tests/pages/checkout.page.ts", line = 4, title = "pays", executionId = 3, runId = 124,
        source = "own", state = "edited", browserName = "chromium", file = "tests/checkout.spec.ts", testCaseId = 8,
    )

    /** The failures as the service answers them: the items, the run, and the tree it grouped by file. */
    private val treeFailures = FailuresResult(
        items = listOf(loginFailure, editedFailure),
        run = FailuresRun(
            id = 120, branch = "feature/x", status = "failed", startTime = "2026-09-27T10:00:00Z", totalTests = 9,
            passedTests = 6, failedTests = 3, url = "http://piwi/test-runs/120", origin = "ci", own = false,
        ),
        grouping = "file",
        runLabel = "Run #120 · CI · feature/x · 2 failing",
        failing = 2,
        rerun = listOf(RunTestsArgs("file:///w/tests/login.spec.ts", listOf(7, 8))),
        tree = listOf(
            node(
                "run", "run", "Run #120 · CI · feature/x · 2 failing", "run", startTime = "2026-09-27T10:00:00Z",
                expanded = true, url = "http://piwi/test-runs/120",
                children = listOf(
                    node(
                        "runs", "runs", "Your runs since", "history", description = "1 run",
                        children = listOf(
                            node(
                                "overlay:124", "overlay", "#124 · your run · 1 passed, 1 failed", "failed",
                                startTime = "2026-09-27T10:02:00Z", url = "http://piwi/test-runs/124",
                            ),
                        ),
                    ),
                    node(
                        "group:file:tests/checkout.spec.ts", "group", "tests/checkout.spec.ts", "file", description = "1 failing",
                        expanded = true,
                        children = listOf(
                            node(
                                "failure:3", "failure", "pays", "edited", description = "checkout.page.ts:5 · chromium",
                                note = "edited since your run #124", executionId = 3,
                            ),
                        ),
                    ),
                    node(
                        "group:file:tests/login.spec.ts", "group", "tests/login.spec.ts", "file", description = "1 failing",
                        expanded = true,
                        children = listOf(
                            node(
                                "failure:1", "failure", "logs in", "failing", description = "tests/login.spec.ts:42 · chromium · new",
                                url = "http://piwi/test-run-cases/1", executionId = 1,
                                tooltip = listOf("logs in", "locator('#login') was not found", "Cluster: Login button", "Owner: @qa"),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    )

    private fun labels(nodes: List<Glue.FailureNode>): List<Any> =
        nodes.map { if (it.children.isEmpty()) it.label else listOf("${it.label} (${it.description})", labels(it.children)) }

    @Test
    fun `the flaky tests the tree lists are counted under each run's group`() {
        val leaf = FailureTreeNode(key = "flaky:1\nchromium", kind = "flaky")
        val group = FailureTreeNode(key = "flaky", kind = "group", children = listOf(leaf, leaf.copy(key = "flaky:2\nchromium")))
        val run = FailureTreeNode(key = "run", kind = "run", children = listOf(group))
        assertEquals(2, Glue.flakyTestsListed(FailuresResult(emptyList(), tree = listOf(run)), "/w"))
        // Under a context's node, its keys on two lines: counted for the config the node names.
        val context = FailureTreeNode(key = "context:/w", kind = "context", root = "/w", children = listOf(run.copy(key = "context:/w\nrun", children = listOf(group.copy(key = "context:/w\nflaky")))))
        val admin = FailureTreeNode(key = "context:/w/admin", kind = "context", root = "/w/admin", children = listOf(group.copy(key = "context:/w/admin\nflaky", children = listOf(leaf))))
        val several = FailuresResult(emptyList(), tree = listOf(context, admin))
        assertEquals(mapOf("/w" to 2, "/w/admin" to 1), Glue.flakyTestsByRoot(several))
        assertEquals(listOf(2, 1, 0), listOf("/w", "/w/admin", "/elsewhere").map { Glue.flakyTestsListed(several, it) })
        assertEquals(0, Glue.flakyTestsListed(null, "/w"))
        assertEquals(listOf("Show the run's flaky test", "Show the run's 2 flaky tests"), listOf(1, 2).map(Glue::showFlakyTestsLabel))
        assertFalse(Glue.isFlakyGroup("group:file:tests/flaky.spec.ts"))
    }

    @Test
    fun `a flaky test of the tree keeps its spec and line, which the tool window opens`() {
        val leaf = FailureTreeNode(
            key = "flaky:tests/cart.spec.ts\nadds\nchromium", kind = "flaky", label = "adds", icon = "flaky",
            url = "http://piwi/test-run-cases/25", uri = "file:///w/tests/cart.spec.ts", line = 2,
            actions = listOf(
                PiwiCommand("Open its Flakiness tab", "piwi.openInDashboard", listOf("http://piwi/test-cases/2")),
                PiwiCommand(null, "piwi.runCommand"),
            ),
        )
        val group = FailureTreeNode(key = "flaky", kind = "group", label = "Flaky in this run", icon = "flaky", children = listOf(leaf))
        val drawn = Glue.failureNodes(FailuresResult(emptyList(), tree = listOf(group))).single().children.single()
        assertEquals(listOf("flaky", "file:///w/tests/cart.spec.ts", "2"), listOf(drawn.icon, drawn.uri, drawn.line.toString()))
        // Its menu lists what looks into it, but an action with no title.
        assertEquals(listOf("Open its Flakiness tab"), drawn.actions.map { it.title })
        assertEquals("http://piwi/test-run-cases/25", drawn.url)
    }

    @Test
    fun `the failures tree is the service's, with the age of each run after its description`() {
        val root = Glue.failureNodes(treeFailures, treeNow).single()
        assertEquals("Run #120 · CI · feature/x · 2 failing" to "4 min ago", root.label to root.description)
        assertEquals("http://piwi/test-runs/120", root.url)
        assertEquals(
            listOf(
                listOf("Your runs since (1 run)", listOf("#124 · your run · 1 passed, 1 failed")),
                listOf("tests/checkout.spec.ts (1 failing)", listOf("pays")),
                listOf("tests/login.spec.ts (1 failing)", listOf("logs in")),
            ),
            labels(root.children),
        )
        val overlay = root.children[0].children[0]
        assertEquals("2 min ago" to "failed", overlay.description to overlay.icon)
        assertEquals(false, root.children[0].expanded)
        val (edited, failing) = root.children.drop(1).map { it.children.single() }
        assertEquals(editedFailure to "edited since your run #124", edited.failure to edited.note)
        assertEquals(loginFailure to null, failing.failure to failing.note)
        assertEquals("tests/login.spec.ts:42 · chromium · new", failing.description)
        // Each node keeps the service's hover lines, drawn as the tree's tooltip.
        assertEquals(listOf("logs in", "locator('#login') was not found", "Cluster: Login button", "Owner: @qa"), failing.tooltip)
        assertEquals(
            "<html>logs in<br>locator('#login') was not found<br>Cluster: Login button<br>Owner: @qa</html>",
            Glue.htmlTooltip(failing.tooltip.joinToString("\n")),
        )
    }

    @Test
    fun `while the editor's own run is live, the run counts it`() {
        val live = LiveRun(runId = 125, status = "running", done = 4, total = 9, own = true)
        assertEquals("running 4/9", Glue.failureNodes(treeFailures, treeNow, live).single().description)
        assertEquals("4 min ago", Glue.failureNodes(treeFailures, treeNow, live.copy(own = false)).single().description)
        assertEquals("running 4/9 · 1 failed", Glue.failureNodes(treeFailures, treeNow, live.copy(failed = 1)).single().description)
    }

    @Test
    fun `the editor's own run is counted from what its process tells the hub, else from the instance`() {
        val instance = LiveRun(runId = 125, status = "running", done = 2, total = 9, own = true, ref = "ed-1")
        val contexts = listOf(RunStatus(root = "/w/shop", live = instance))
        val told = RunSession("ed-1", root = "/w/shop", progress = RunProgress(total = 9, done = 5, failed = 1))
        // The hub's count wins over the instance's, which lags behind it.
        assertEquals(
            instance.copy(done = 5, failed = 1) to "/w/shop",
            Glue.ownRunInProgress(contexts, mapOf("ed-1" to told)),
        )
        // A reporter that tells nothing: the instance's count.
        assertEquals(instance to "/w/shop", Glue.ownRunInProgress(contexts, mapOf("ed-1" to told.copy(progress = null))))
        // Another run of the same config is not the instance's run, nor is any run when the instance names none: the
        // instance's count.
        assertEquals(instance to "/w/shop", Glue.ownRunInProgress(contexts, mapOf("ed-2" to told.copy(ref = "ed-2"))))
        val unnamed = instance.copy(ref = null)
        assertEquals(unnamed to "/w/shop", Glue.ownRunInProgress(listOf(RunStatus(root = "/w/shop", live = unnamed)), mapOf("ed-1" to told)))
        // Offline, or with the desktop app hosting the run: the hub's count alone.
        assertEquals(
            LiveRun(status = "running", done = 5, total = 9, failed = 1, own = true, ref = "ed-1") to "/w/shop",
            Glue.ownRunInProgress(emptyList(), mapOf("ed-1" to told)),
        )
        // A run of a terminal is not the editor's own; one that ended counts no more.
        assertEquals(null, Glue.ownRunInProgress(emptyList(), mapOf("t-1" to told.copy(ref = "t-1", terminal = true))))
        assertEquals(null, Glue.ownRunInProgress(emptyList(), mapOf("ed-1" to told.copy(progress = told.progress!!.copy(status = "failed")))))
        assertEquals(null, Glue.ownRunInProgress(listOf(RunStatus(root = "/w/shop", live = instance.copy(own = false))), emptyMap()))
    }

    @Test
    fun `with several Playwright configs, a node each over its own run, which alone counts the editor's own run`() {
        val run = treeFailures.tree!!.single()
        fun config(root: String, label: String) = FailureTreeNode(
            key = "context:$root", kind = "context", label = label, description = "Shop · 2 failing",
            tooltip = listOf("Playwright config in $root"), icon = "context", expanded = true, url = "http://piwi/test-runs/120",
            children = listOf(run.copy(key = "context:$root/run", root = root)), root = root,
        )
        val several = treeFailures.copy(
            run = null,
            runLabel = null,
            tree = listOf(config("/w/apps/shop", "apps/shop"), config("/w/apps/admin", "apps/admin")),
        )
        val live = LiveRun(runId = 125, status = "running", done = 4, total = 9, own = true)
        val (shop, admin) = Glue.failureNodes(several, treeNow, live, liveRoot = "/w/apps/admin")
        assertEquals(
            listOf("context", "apps/shop", "Shop · 2 failing", "context", "/w/apps/shop", "http://piwi/test-runs/120"),
            listOf(shop.kind, shop.label, shop.description, shop.icon, shop.root, shop.url),
        )
        assertEquals("4 min ago" to "/w/apps/shop", shop.children.single().description to shop.children.single().root)
        assertEquals("running 4/9", admin.children.single().description)
        // A run node that names no config: the editor's own run shows on it.
        assertEquals("running 4/9", Glue.failureNodes(treeFailures, treeNow, live, liveRoot = "/w/apps/admin").single().description)
    }

    @Test
    fun `the status popup offers Open the latest run unless a row of it opens that run's page`() {
        val live = LiveRun(runId = 78, url = "http://127.0.0.1:3000/test-runs/78")
        assertTrue(Glue.latestRunOffered(null, listOf(78)))
        assertTrue(Glue.latestRunOffered(live, listOf(77)))
        // By the run's id, whatever host the reporter's page names.
        assertFalse(Glue.latestRunOffered(live, listOf(78)))
    }

    @Test
    fun `Re-run the failing tests runs every config's failing tests, or one config's from its node`() {
        val shop = RunTestsArgs("file:///w/apps/shop/tests/a.spec.ts", listOf(7), root = "/w/apps/shop")
        val admin = RunTestsArgs("file:///w/apps/admin/tests/b.spec.ts", listOf(8), root = "/w/apps/admin")
        val result = treeFailures.copy(rerun = listOf(shop, admin))
        assertEquals(listOf(shop, admin), Glue.failingRuns(result))
        assertEquals(listOf(admin), Glue.failingRuns(result, "/w/apps/admin"))
        assertEquals(emptyList<RunTestsArgs>(), Glue.failingRuns(result, "/w/apps/docs"))
        assertEquals(emptyList<RunTestsArgs>(), Glue.failingRuns(null))
    }

    @Test
    fun `without a tree nothing is drawn, and the header names the connection and the baseline, not the run`() {
        assertEquals(emptyList<Glue.FailureNode>(), Glue.failureNodes(FailuresResult(emptyList(), treeFailures.run)))
        assertEquals(emptyList<Glue.FailureNode>(), Glue.failureNodes(null))
        // One line: the project and branch, the sentence in the tooltip; the run is the tree's own node.
        val header = Glue.toolWindowHeader(connected, treeFailures)
        assertEquals(Glue.ToolWindowHeader("Acme on main", Glue.connectionSummary(connected), null), header)
        // The desktop app's hint stays in sight.
        assertEquals(
            "Acme on main. The Piwi desktop app runs on this machine: Connect to use it.",
            Glue.toolWindowHeader(connected.copy(desktopUrl = "http://127.0.0.1:3000"), null).connection,
        )
        // Several configs read as their count, and how many are connected when not all are.
        val admin = connected.contexts!!.first().copy(root = "/w/apps/admin")
        assertEquals("2 Playwright configs", Glue.toolWindowHeader(connected.copy(contexts = connected.contexts!! + admin), null).connection)
        assertEquals(
            "1 of 2 Playwright configs connected",
            Glue.toolWindowHeader(connected.copy(contexts = connected.contexts!! + admin.copy(connected = false)), null).connection,
        )
        // Not connected, waiting for trust or a start that failed: the sentence itself.
        val none = connected.copy(contexts = connected.contexts!!.map { it.copy(connected = false, problem = "No API key.") })
        assertEquals(Glue.connectionSummary(none), Glue.toolWindowHeader(none, null).connection)
        assertEquals(Glue.WAITING_FOR_TRUST, Glue.toolWindowHeader(null, null, trusted = false).connection)
        assertEquals("Node.js 18 is too old", Glue.toolWindowHeader(null, null, startProblem = "Node.js 18 is too old").connection)
        assertEquals(
            RunTestsArgs("file:///w/shared/pages/admin.ts", listOf(8), root = "/w/apps/admin"),
            Glue.failureRunArgs(editedFailure.copy(root = "/w/apps/admin", uri = "file:///w/shared/pages/admin.ts")),
        )
    }

    @Test
    fun `Compare with offers the ladder, the branches with runs, a run by id and the local runs`() {
        val run = RunStatus(root = "/w", branch = "main", run = passed, branches = listOf("main", "feature/x"))
        val entries = Glue.baselineEntries(run)
        assertEquals(
            listOf(
                "CI on the checked-out branch, else main (default)" to true,
                "main" to false,
                "feature/x" to false,
                "A run by id…" to false,
                "My local runs only" to false,
            ),
            entries.map { it.label to it.current },
        )
        assertEquals(
            listOf(
                BaselineChoice("ladder"),
                BaselineChoice("branch", branch = "main"),
                BaselineChoice("branch", branch = "feature/x"),
                null,
                BaselineChoice("local"),
            ),
            entries.map { it.choice },
        )
        val chosen = Glue.baselineEntries(
            run.copy(baseline = Baseline(BaselineChoice("branch", branch = "release"), "release (no run)")),
        )
        assertEquals(listOf("release"), chosen.filter { it.current }.map { it.label })
        val byId = Glue.baselineEntries(RunStatus(baseline = Baseline(BaselineChoice("run", runId = 118), "CI run #118 on main")))
        assertEquals("CI on the checked-out branch, else the default branch (default)", byId[0].label)
        assertEquals("A run by id… (now run #118)" to true, byId[1].label to byId[1].current)
    }

    @Test
    fun `a choice is kept per root as text`() {
        for (choice in listOf(BaselineChoice("local"), BaselineChoice("branch", branch = "feature/x"), BaselineChoice("run", runId = 118))) {
            assertEquals(choice, Glue.decodeBaseline(Glue.encodeBaseline(choice)))
        }
        assertEquals(null, Glue.encodeBaseline(BaselineChoice("ladder")))
        assertEquals(null, Glue.decodeBaseline("run:abc"))
    }

    @Test
    fun `the tooltip and the header name the baseline, and a chosen branch is not a fallback`() {
        val chosen = RunStatusResult(
            listOf(
                RunStatus(
                    root = "/w", branch = "main", checkedOut = "feature/cart", run = passed,
                    baseline = Baseline(BaselineChoice("branch", branch = "main"), "CI run #41 on main"),
                ),
            ),
        )
        val tooltip = Glue.statusView(connected, chosen).tooltip
        assertEquals(true, tooltip.startsWith("Run #41 of Acme on main: 118 passed, 0 failed, 2 flaky, 0 skipped\nBaseline: CI run #41 on main"))
        val ladder = chosen.copy(contexts = chosen.contexts!!.map { it.copy(baseline = it.baseline!!.copy(choice = BaselineChoice("ladder"))) })
        assertEquals(true, Glue.statusView(connected, ladder).tooltip.startsWith("Run #41 of Acme on main (feature/cart has no run yet)"))
        val label = "CI run #120 on feature/x"
        assertEquals(
            "Baseline: $label ▾",
            Glue.toolWindowHeader(connected, treeFailures.copy(baseline = Baseline(BaselineChoice("ladder"), label))).baseline,
        )
        assertEquals(
            "Baseline: release (no run) ▾",
            Glue.toolWindowHeader(
                connected,
                FailuresResult(emptyList(), baseline = Baseline(BaselineChoice("branch", branch = "release"), "release (no run)")),
            ).baseline,
        )
    }

    @Test
    fun `the local runs alone count their failures, under a root of their own`() {
        val local = Baseline(BaselineChoice("local"), "your local runs only")
        val runs = RunStatusResult(
            listOf(RunStatus(root = "/w", branch = "main", failures = 2, failingTests = 1, overlays = 2, baseline = local)),
        )
        val view = Glue.statusView(connected, runs)
        assertEquals("Piwi: 1 failing", view.text)
        assertEquals(true, view.tooltip.startsWith("2 local runs of Acme on main, 1 test failing\nBaseline: your local runs only"))
        val alone = treeFailures.copy(run = null, baseline = local, runLabel = "Your local runs · 2 failing")
        assertEquals("Baseline: your local runs only ▾", Glue.toolWindowHeader(connected, alone).baseline)
    }

    @Test
    fun `a failure's context is the deepest Playwright config folder that holds it`() {
        val status = StatusResult(
            listOf(ContextStatus(root = "/w", connected = true), ContextStatus(root = "/w/e2e", connected = true)),
        )
        assertEquals("/w/e2e", Glue.contextRootOf(status, "file:///w/e2e/tests/a.spec.ts"))
        assertEquals("/w", Glue.contextRootOf(status, "file:///w/tests/a.spec.ts"))
        assertEquals("/w", Glue.contextRootOf(status, "file:///elsewhere/a.spec.ts"))
    }

    private val ended = RunEnded(
        root = "/w", runId = 124, url = "http://piwi/test-runs/124", passed = 1, failed = 2, fixed = 1,
        stillFailing = listOf("login.spec.ts › logs in", "checkout.spec.ts › pays"), newFailures = emptyList(),
        stillFailingCount = 2, newFailureCount = 0,
    )

    @Test
    fun `a run's verdict counts the CI failures it fixed and names those still failing, with Re-run failing`() {
        assertEquals(
            Glue.RunVerdict(
                true,
                "Run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in, checkout.spec.ts › pays)",
                listOf("Open the failures", "Open in dashboard", "Re-run failing"),
            ),
            Glue.runVerdict(ended),
        )
    }

    @Test
    fun `a run's verdict names its new failures, and how many more past the first five`() {
        val titles = (1..5).map { "a.spec.ts › $it" }
        val verdict = Glue.runVerdict(
            ended.copy(fixed = 0, stillFailing = emptyList(), stillFailingCount = 0, newFailures = titles, newFailureCount = 7),
        )
        assertEquals("Run #124 · 7 new failures (${titles.joinToString(", ")} and 2 more)", verdict?.text)
    }

    @Test
    fun `a run that fails nothing is an information, and one that touched no failure gives its counts`() {
        val passing = ended.copy(failed = 0, stillFailing = emptyList(), stillFailingCount = 0)
        assertEquals(
            Glue.RunVerdict(
                false,
                "Run #124 · 1 of 1 CI failure fixed",
                listOf("Open the failures", "Open in dashboard", "Only on failure"),
            ),
            Glue.runVerdict(passing),
        )
        // Only on failure is offered while every run says what it changed, and on a run that fails nothing.
        assertEquals(listOf("Open the failures", "Open in dashboard", "Re-run failing"), Glue.runVerdict(ended)?.actions)
        assertEquals("Run #124 · 4 passed, 0 failed, 1 flaky", Glue.runVerdict(passing.copy(fixed = 0, passed = 4, flaky = 1))?.text)
        // The skipped that were ended at a stop are named beside them.
        assertEquals(
            "Run #124 · 3 passed, 0 failed, 2 skipped (1 ended at a stop)",
            Glue.runVerdict(passing.copy(fixed = 0, passed = 3, skipped = 2, endedAtStop = 1))?.text,
        )
        // Without the counts: the titles count.
        assertEquals(ended.copy(stillFailingCount = null).let { Glue.runVerdict(it)?.text }, Glue.runVerdict(ended)?.text)
    }

    @Test
    fun `the setting keeps a run's verdict quiet`() {
        val passing = ended.copy(failed = 0, stillFailing = emptyList(), stillFailingCount = 0)
        assertEquals(null, Glue.runVerdict(passing, "failures"))
        assertEquals(true, Glue.runVerdict(ended, "failures")?.warning)
        assertEquals(null, Glue.runVerdict(ended, "never"))
    }

    @Test
    fun `a run of each test three times says how many of its runs passed, whatever the setting`() {
        assertEquals(
            Glue.RunVerdict(true, "Run #124 · Failed 1 of 3", listOf("Open the failures", "Open in dashboard")),
            Glue.runVerdict(ended.copy(repeat = RepeatVerdict("Failed 1 of 3", failed = true)), "never"),
        )
        val passed = ended.copy(failed = 0, repeat = RepeatVerdict("Passed 3 of 3", failed = false))
        assertEquals(Glue.RunVerdict(false, "Run #124 · Passed 3 of 3", listOf("Open the failures", "Open in dashboard")), Glue.runVerdict(passed, "failures"))
        // The balloon is titled by its run, so two runs' balloons read apart.
        assertEquals("Piwi: run #124", Glue.runVerdictTitle(124))
        assertEquals("Passed 3 of 3", Glue.runVerdict(passed, "failures")?.let { Glue.runVerdictBody(it, 124) })
    }

    @Test
    fun `the test at a line runs by its id when Piwi knows it, else by its location, and by its location to verify it`() {
        val uri = "file:///w/tests/checkout.spec.ts"
        val known = TestAtResult(EditorTest(7, "pays"), SpecTests(uri, listOf(7)), "tests/checkout.spec.ts:3")
        assertEquals(RunTestsArgs(uri, listOf(7)), Glue.testAtRun(uri, known))
        assertEquals(
            RunTestsArgs(uri, emptyList(), locations = listOf("tests/checkout.spec.ts:3"), repeat = 3),
            Glue.testAtRun(uri, known, Glue.VERIFY_REPEAT),
        )
        val recorded = TestAtResult(location = "tests/checkout.spec.ts:12")
        assertEquals(RunTestsArgs(uri, emptyList(), locations = listOf("tests/checkout.spec.ts:12")), Glue.testAtRun(uri, recorded))
        assertEquals(null, Glue.testAtRun(uri, TestAtResult()))
        assertEquals(null, Glue.testAtRun(uri, null))
        // Without a location: a test the service knows still runs, but cannot be verified.
        assertEquals(RunTestsArgs(uri, listOf(7)), Glue.testAtRun(uri, known.copy(location = null)))
        assertEquals(null, Glue.testAtRun(uri, known.copy(location = null), 3))
    }

    @Test
    fun `every run starts as the person chose, headed and with Hold failures on or off, but a debug run`() {
        val uri = "file:///w/tests/checkout.spec.ts"
        val args = RunTestsArgs(uri, listOf(7))
        assertEquals(args, Glue.withRunStart(args, headed = false, holdFailures = "auto"))
        assertEquals(args.copy(headed = true), Glue.withRunStart(args, headed = true, holdFailures = "auto"))
        assertEquals(args.copy(holdFailures = true), Glue.withRunStart(args, headed = false, holdFailures = "on"))
        assertEquals(args.copy(headed = true, holdFailures = false), Glue.withRunStart(args, headed = true, holdFailures = "off"))
        // A value outside the choices reads as Auto.
        assertEquals(args, Glue.withRunStart(args, headed = false, holdFailures = "always"))
        // A verification takes them too: the service keeps `headed` alone.
        val verify = RunTestsArgs(uri, emptyList(), locations = listOf("tests/checkout.spec.ts:3"), repeat = 3)
        assertEquals(verify.copy(headed = true, holdFailures = true), Glue.withRunStart(verify, headed = true, holdFailures = "on"))
        val selection = RunSelectionParams(uri, "smoke")
        assertEquals(selection.copy(headed = true, holdFailures = false), Glue.withRunStart(selection, headed = true, holdFailures = "off"))
        assertEquals(selection, Glue.withRunStart(selection, headed = false, holdFailures = "auto"))
        val debug = Glue.debugRunArgs(uri, uri, 4, Glue.DebugRequest(spec = "tests/checkout.spec.ts", title = "pays", project = null, execution = null))
        assertSame(debug, Glue.withRunStart(debug, headed = true, holdFailures = "off"))
        // What the service reads: an option left out is no field at all.
        assertEquals("{\"uri\":\"$uri\",\"key\":\"smoke\"}", Gson().toJson(Glue.withRunStart(selection, false, "auto")))
        assertEquals("{\"uri\":\"$uri\",\"key\":\"smoke\",\"headed\":true,\"holdFailures\":false}", Gson().toJson(Glue.withRunStart(selection, true, "off")))
        assertEquals(listOf("auto", "on", "off"), Glue.HOLD_FAILURES_CHOICES)
        assertEquals("Off from each run's start", Glue.holdFailuresLabel("off"))
    }

    @Test
    fun `a test of the run in progress says it runs, and its files are drawn again when it begins or ends`() {
        assertEquals(
            "<html>Piwi: running in your run #130 · passed 4 of 4 runs</html>",
            Glue.testResultTooltip("running in your run #130 · passed 4 of 4 runs"),
        )
        // The service's text is shown as text, never as markup.
        assertEquals(
            "<html>Piwi: failing in run #124 · &lt;img src=x onerror=alert(1)&gt; &amp; more</html>",
            Glue.testResultTooltip("failing in run #124 · <img src=x onerror=alert(1)> & more"),
        )
        assertEquals("<html>Piwi</html>", Glue.testResultTooltip(null))
        val latest = RunStatusResult(listOf(RunStatus(root = "/w", run = passed)))
        val moving = RunStatusResult(listOf(RunStatus(root = "/w", run = passed, live = LiveRun(runId = 124, done = 1))))
        val testing = RunStatusResult(listOf(RunStatus(root = "/w", run = passed, liveTests = listOf(LiveTest(1, "running")))))
        assertEquals(Glue.runsInFiles(latest), Glue.runsInFiles(moving))
        assertEquals(false, Glue.runsInFiles(testing) == Glue.runsInFiles(latest))
    }

    @Test
    fun `a run in progress draws only the files that show its tests again, a new run every file`() {
        val latest = RunStatusResult(listOf(RunStatus(root = "/w", run = passed)))
        val moving = RunStatusResult(listOf(RunStatus(root = "/w", run = passed, live = LiveRun(runId = 124, done = 1), stream = "live")))
        val testing = RunStatusResult(listOf(RunStatus(root = "/w", run = passed, liveTests = listOf(LiveTest(1, "running")))))
        val ended = testing.copy(contexts = testing.contexts!!.map { it.copy(liveTests = listOf(LiveTest(1, "passed"))) })
        val next = RunStatusResult(listOf(RunStatus(root = "/w", run = passed.copy(id = 42))))
        assertEquals(Glue.Redraw.NONE, Glue.redraw(latest, moving))
        assertEquals(Glue.Redraw.NONE, Glue.redraw(null, null))
        assertEquals(Glue.Redraw.TESTS, Glue.redraw(latest, testing))
        assertEquals(Glue.Redraw.TESTS, Glue.redraw(testing, ended))
        assertEquals(Glue.Redraw.ALL, Glue.redraw(ended, next))
        assertEquals(Glue.Redraw.ALL, Glue.redraw(null, latest))
        // Another baseline is another run in the files.
        val local = latest.copy(contexts = latest.contexts!!.map { it.copy(baseline = Baseline(BaselineChoice("local"), "your local runs only")) })
        assertEquals(Glue.Redraw.ALL, Glue.redraw(latest, local))
    }

    @Test
    fun `a tree whose nodes only say something else keeps its rows`() {
        val idle = Glue.failureNodes(treeFailures, treeNow)
        val running = Glue.failureNodes(treeFailures, treeNow, LiveRun(runId = 124, done = 3, total = 9, own = true))
        assertEquals(false, idle == running)
        assertEquals(true, Glue.sameShape(idle, running))
        val root = treeFailures.tree!!.single()
        val flat = treeFailures.copy(tree = listOf(root.copy(children = root.children!!.drop(1).flatMap { it.children!! })))
        assertEquals(false, Glue.sameShape(idle, Glue.failureNodes(flat, treeNow)))
    }

    @Test
    fun `a file summary is asked once per text, until the service pushes a change or it gets old`() {
        val cache = Glue.SummaryCache(ttlMillis = 5_000, max = 2)
        var asked = 0
        val ask = { asked++; CompletableFuture.completedFuture<FileSummary?>(FileSummary()) }
        val first = cache.get("file:///a.ts", stamp = 1, pushed = 0, now = 0, ask = ask)
        assertSame(first, cache.get("file:///a.ts", stamp = 1, pushed = 0, now = 4_999, ask = ask))
        assertEquals(1, asked)
        cache.get("file:///a.ts", stamp = 2, pushed = 0, now = 5, ask = ask)
        cache.get("file:///a.ts", stamp = 2, pushed = 1, now = 6, ask = ask)
        cache.get("file:///a.ts", stamp = 2, pushed = 1, now = 6_000, ask = ask)
        assertEquals(4, asked)
        // A failed request is not kept.
        cache.get("file:///b.ts", stamp = 1, pushed = 1, now = 0) { asked++; CompletableFuture.failedFuture(IllegalStateException()) }
        cache.get("file:///b.ts", stamp = 1, pushed = 1, now = 1, ask = ask)
        assertEquals(6, asked)
    }

    @Test
    fun `the paths of a run's output open their line, the absolute ones left to the IDE`() {
        assertEquals(
            listOf(Glue.FileLink(18, 43, "tests/example.spec.ts", 3, 5)),
            Glue.fileLinks("  1) [chromium] › tests/example.spec.ts:3:5 › has title ───"),
        )
        assertEquals(listOf(Glue.FileLink(8, 38, "tests/pages/checkout.page.ts", 5, null)), Glue.fileLinks("    at (tests/pages/checkout.page.ts:5)"))
        assertEquals(emptyList<Glue.FileLink>(), Glue.fileLinks("    at /home/ci/tests/example.spec.ts:7:22"))
        assertEquals(emptyList<Glue.FileLink>(), Glue.fileLinks("    at C:\\work\\tests\\example.spec.ts:7:22"))
        assertEquals(emptyList<Glue.FileLink>(), Glue.fileLinks("GET http://localhost:3000/app.js:10:5 failed"))
        assertEquals(emptyList<Glue.FileLink>(), Glue.fileLinks("  7 |   await expect(page).toHaveTitle(/Playwright/);"))
        assertEquals(listOf("a.spec.ts", "b.test.mjs"), Glue.fileLinks("a.spec.ts:1:2 and b.test.mjs:30").map { it.path })
    }

    @Test
    fun `every name Playwright reads a config from is one`() {
        for (name in listOf("ts", "js", "mjs", "cjs", "mts", "cts")) {
            assertEquals(true, Glue.isPlaywrightConfig("/w/e2e/playwright.config.$name"))
        }
        assertEquals(true, Glue.isPlaywrightConfig("C:\\w\\playwright.config.ts"))
        assertEquals(false, Glue.isPlaywrightConfig("/w/playwright.config.ts.bak"))
        assertEquals(false, Glue.isPlaywrightConfig("/w/vitest.config.ts"))
        assertEquals(false, Glue.isPlaywrightConfig(null))
    }

    @Test
    fun `a spec is named as the editor service reads specs`() {
        for (name in listOf("checkout.spec.ts", "cart.test.mjs", "row.spec.tsx", "login.test.cjs", "a.spec.js")) {
            assertEquals(true, Glue.isSpecFile(name))
        }
        assertEquals(false, Glue.isSpecFile("checkout.page.ts"))
        assertEquals(false, Glue.isSpecFile("checkout.spec.ts.bak"))
        assertEquals(false, Glue.isSpecFile("spec.ts"))
    }

    private val mappedCoverage = CoverageResult(
        uri = "file:///w/src/Web/Services/BasketService.cs",
        state = "mapped",
        executed = listOf(LineSpan(8, 9, 2), LineSpan(17, 30, 1)),
        notRun = listOf(LineSpan(11, 11)),
        changed = listOf(LineSpan(13, 14)),
        tests = 2,
        executedLines = 6,
        executableLines = 7,
        blob = "a".repeat(40),
        label = "6 of 7 lines run by 2 tests · 2 lines changed since the coverage run",
    )

    @Test
    fun `the coverage marks are the lines run, not run and changed since the coverage run, within the file`() {
        assertEquals(
            listOf(
                Glue.CoverageMark(Glue.CoverageKind.RUN, 8, 9, "Piwi: run by 2 tests"),
                Glue.CoverageMark(Glue.CoverageKind.RUN, 17, 19, "Piwi: run by 1 test"),
                Glue.CoverageMark(Glue.CoverageKind.NOT_RUN, 11, 11, "Piwi: no test runs this line"),
                Glue.CoverageMark(Glue.CoverageKind.CHANGED, 13, 14, "Piwi: changed since the coverage run"),
            ),
            Glue.coverageMarks(mappedCoverage, 20, shown = true),
        )
    }

    @Test
    fun `a coverage mark's tooltip says what it marks, then what the marks mean`() {
        val mark = Glue.CoverageMark(Glue.CoverageKind.NOT_RUN, 11, 11, "Piwi: no test runs this line")
        assertEquals(
            "<html>Piwi: no test runs this line<br>The bar at the left of a line: teal, a test ran it; slate, it is " +
                "executable and no test runs it; dashed amber, it changed since the coverage run.</html>",
            Glue.coverageMarkTooltip(mark),
        )
    }

    @Test
    fun `no coverage mark while hidden, nor for a file whose coverage marks no line`() {
        assertEquals(emptyList<Glue.CoverageMark>(), Glue.coverageMarks(mappedCoverage, 20, shown = false))
        assertEquals(emptyList<Glue.CoverageMark>(), Glue.coverageMarks(null, 20, shown = true))
        val other = mappedCoverage.copy(state = "other-version", executed = emptyList(), notRun = emptyList(), changed = emptyList())
        assertEquals(emptyList<Glue.CoverageMark>(), Glue.coverageMarks(other, 20, shown = true))
        assertEquals(true, Glue.hasCoverageMarks(mappedCoverage))
        assertEquals(false, Glue.hasCoverageMarks(other))
        assertEquals(false, Glue.hasCoverageMarks(other.copy(state = "none")))
    }

    @Test
    fun `the uncovered changes of a file no test reaches are marks of their own, with what they mean`() {
        val uncovered = CoverageResult(
            uri = "file:///w/server/api/refunds.post.ts",
            state = "none",
            label = "3 lines changed since main, and no test reaches this file",
            uncovered = listOf(LineSpan(0, 0), LineSpan(2, 30)),
        )
        assertEquals(true, Glue.hasCoverageMarks(uncovered))
        val tooltip = "Piwi: uncovered change: 3 lines changed since main, and no test reaches this file"
        val marks = Glue.coverageMarks(uncovered, 10, shown = true)
        assertEquals(
            listOf(
                Glue.CoverageMark(Glue.CoverageKind.UNCOVERED, 0, 0, tooltip),
                Glue.CoverageMark(Glue.CoverageKind.UNCOVERED, 2, 9, tooltip),
            ),
            marks,
        )
        assertEquals(
            "<html>$tooltip<br>The orange bar at the left of a line: it changed since the default branch, and no test " +
                "reaches this file.</html>",
            Glue.coverageMarkTooltip(marks[0]),
        )
        assertEquals(emptyList<Glue.CoverageMark>(), Glue.coverageMarks(uncovered, 10, shown = false))
    }

    @Test
    fun `a new coverage answer takes off and draws only the marks that changed`() {
        val drawn = Glue.coverageMarks(mappedCoverage, 20, shown = true).toSet()
        val next = mappedCoverage.copy(executed = listOf(LineSpan(8, 9, 2), LineSpan(17, 30, 3)), notRun = listOf(LineSpan(12, 12)))
        assertEquals(
            Glue.CoverageMarksDiff(
                remove = listOf(
                    Glue.CoverageMark(Glue.CoverageKind.RUN, 17, 19, "Piwi: run by 1 test"),
                    Glue.CoverageMark(Glue.CoverageKind.NOT_RUN, 11, 11, "Piwi: no test runs this line"),
                ),
                add = listOf(
                    Glue.CoverageMark(Glue.CoverageKind.RUN, 17, 19, "Piwi: run by 3 tests"),
                    Glue.CoverageMark(Glue.CoverageKind.NOT_RUN, 12, 12, "Piwi: no test runs this line"),
                ),
            ),
            Glue.coverageMarksDiff(drawn, Glue.coverageMarks(next, 20, shown = true)),
        )
        // The same lines in another kind: taken off and drawn again.
        val changed = Glue.CoverageMark(Glue.CoverageKind.CHANGED, 8, 9, "Piwi: changed since the coverage run")
        val run = Glue.CoverageMark(Glue.CoverageKind.RUN, 8, 9, "Piwi: run by 2 tests")
        assertEquals(Glue.CoverageMarksDiff(listOf(run), listOf(changed)), Glue.coverageMarksDiff(setOf(run), listOf(changed)))
        // Hidden: every mark taken off; nothing drawn yet: each mark drawn once.
        assertEquals(Glue.CoverageMarksDiff(drawn.toList(), emptyList()), Glue.coverageMarksDiff(drawn, emptyList()))
        assertEquals(Glue.CoverageMarksDiff(emptyList(), listOf(run)), Glue.coverageMarksDiff(emptySet(), listOf(run, run)))
        assertEquals(Glue.CoverageMarksDiff(emptyList(), emptyList()), Glue.coverageMarksDiff(drawn, drawn.toList()))
    }

    @Test
    fun `the coverage answer reads as the service sends it, and C# files are read`() {
        val result = Gson().fromJson(
            """{"uri":"file:///w/a.cs","state":"exact","executed":[{"start":3,"end":4,"tests":2}],"notRun":[{"start":6,"end":6}],""" +
                """"changed":[],"tests":2,"executedLines":2,"executableLines":3,"blob":"b","label":"2 of 3 lines run by 2 tests"}""",
            CoverageResult::class.java,
        )
        assertEquals(LineSpan(3, 4, 2), result.executed?.single())
        assertEquals(LineSpan(6, 6, null), result.notRun?.single())
        assertEquals(3, result.executableLines)
        assertEquals(true, "cs" in Glue.SUPPORTED_EXTENSIONS)
        val args = Gson().fromJson("""{"uri":"file:///w/a.cs","testIds":[1,2],"coverage":"server"}""", RunTestsArgs::class.java)
        assertEquals("server", args.coverage)
    }

    @Test
    fun theLogWritesEachLineUnderItsTimeAndKeepsTheLatestOnes() {
        val at = java.time.LocalTime.of(9, 5, 7, 42_000_000)
        assertEquals(listOf("09:05:07.042 The editor service stopped (exit code 1)."), Glue.logLines(at, "The editor service stopped (exit code 1).\n"))
        assertEquals(
            listOf("09:05:07.042 Piwi: boom", "                 at main (server.js:1:1)"),
            Glue.logLines(at, "Piwi: boom\n    at main (server.js:1:1)\n\n"),
        )
        assertEquals(emptyList<String>(), Glue.logLines(at, "\n"))
        // A stack's frame, written to stderr as a line of its own, continues the line before it.
        assertEquals(listOf("                 at main (server.js:1:1)"), Glue.logLines(at, "    at main (server.js:1:1)\n"))
        val buffer = Glue.LogBuffer(max = 3)
        buffer.add(listOf("a", "b"))
        buffer.add(listOf("c", "d"))
        assertEquals(listOf("b", "c", "d"), buffer.lines())
    }

    @Test
    fun aFailedRequestOfOneMethodIsWrittenOnceAMinute() {
        val buffer = Glue.LogBuffer()
        assertTrue(buffer.writesFailure("piwi/fileSummary", 1_000))
        assertFalse(buffer.writesFailure("piwi/fileSummary", 1_000 + Glue.LOG_REPEAT_MILLIS - 1))
        assertTrue(buffer.writesFailure("piwi/status", 2_000))
        assertTrue(buffer.writesFailure("piwi/fileSummary", 1_000 + Glue.LOG_REPEAT_MILLIS))
    }

    @Test
    fun theToolWindowOffersToRestartAServiceThatStoppedAndShowsTheLogOfOneThatCouldNotStart() {
        assertEquals(Glue.EmptyText(Glue.WAITING_FOR_TRUST), Glue.serviceDownText(trusted = false, startProblem = "no node", stopped = true))
        assertEquals(Glue.EmptyText("no node", listOf(Glue.EmptyLink.OPEN_LOG)), Glue.serviceDownText(true, "no node", stopped = true))
        assertEquals(
            Glue.EmptyText(Glue.SERVICE_STOPPED, listOf(Glue.EmptyLink.RESTART_SERVICE, Glue.EmptyLink.OPEN_LOG)),
            Glue.serviceDownText(true, null, stopped = true),
        )
        assertEquals(Glue.EmptyText(Glue.NOT_STARTED), Glue.serviceDownText(true, null, stopped = false))
        assertEquals("Piwi.RestartService", Glue.EmptyLink.RESTART_SERVICE.actionId)
        assertEquals("Piwi.OpenLog", Glue.EmptyLink.OPEN_LOG.actionId)
    }

    @Test
    fun aMessageThatTheServiceDoesNotRunOrAnswerOffersItsFixes() {
        assertTrue(Glue.offersServiceFixes(Glue.SERVICE_NOT_RUNNING))
        assertTrue(Glue.offersServiceFixes(Glue.SERVICE_NO_ANSWER))
        assertFalse(Glue.offersServiceFixes("The run did not take it."))
        assertTrue(Glue.SERVICE_NOT_RUNNING.endsWith("Tools → Piwi → ${Glue.EmptyLink.RESTART_SERVICE.label}."))
        assertTrue(Glue.SERVICE_NO_ANSWER.contains("Tools → Piwi → ${Glue.EmptyLink.OPEN_LOG.label}"))
    }

    private val spec = "file:///work/shop/tests/checkout.spec.ts"
    private val page = "file:///work/shop/tests/pages/checkout.page.ts"

    private fun ci(runId: Int, ended: Boolean = false, summary: String = "1 of 4 tests · 1 failed") = CiSession(
        runId = runId,
        root = "/work/shop",
        url = "https://piwi.example/test-runs/$runId",
        name = "CI run #$runId",
        branch = "feature/pay",
        progress = CiProgress(total = 4, done = 1, failed = 1),
        summary = summary,
        tests = listOf(
            CiTest(
                title = listOf("checkout", "pays"), uri = spec, line = 2, project = "chromium", status = "running", lane = 2,
                at = CiPosition("Click getByRole('button')", page, 8, 21, "CI run #$runId · worker 2: Click getByRole('button')"),
                watch = "https://piwi.example/test-runs/$runId?watch=2",
            ),
            CiTest(title = listOf("refunds"), uri = spec, line = 10, project = "chromium", status = "failed", retry = 1, lane = 1),
        ),
        watchable = true,
        ended = ended,
    )

    @Test
    fun theCiRunsOfTheBranchAreKeptTheLatestOfEachUntilOneEnded() {
        var kept = Glue.withCiSession(emptyMap(), ci(78))
        kept = Glue.withCiSession(kept, ci(79))
        kept = Glue.withCiSession(kept, ci(78, summary = "2 of 4 tests · 1 failed"))
        assertEquals(listOf(78 to "2 of 4 tests · 1 failed", 79 to "1 of 4 tests · 1 failed"), kept.values.map { it.runId to it.summary })
        kept = Glue.withCiSession(kept, ci(78, ended = true))
        assertEquals(listOf(79), kept.values.map { it.runId })
    }

    @Test
    fun aCiPositionIsAPlainMarkAtTheLineOfEachRunningTestNeverOneThatEnded() {
        val sessions = listOf(ci(78), ci(79))
        assertEquals(setOf(page), Glue.ciMarkedFiles(sessions))
        assertEquals(
            listOf(Glue.CiMark(8, "CI run #78 · worker 2: Click getByRole('button') · CI run #79 · worker 2: Click getByRole('button')")),
            Glue.ciMarksIn(sessions, page),
        )
        assertEquals(emptyList<Glue.CiMark>(), Glue.ciMarksIn(sessions, spec))
    }

    @Test
    fun theCiRunsTabNamesEachRunAsOtherRunsAreWithItsProgressOpenItsTestsAndWatchReadOnly() {
        val rows = Glue.ciRows(listOf(ci(78)))
        assertEquals(
            listOf(
                Glue.CiRow("run", "CI run #78", "feature/pay · 1 of 4 tests · 1 failed"),
                Glue.CiRow("open", "Open run #78", "on the dashboard", url = "https://piwi.example/test-runs/78"),
                Glue.CiRow("test", "checkout › pays", "chromium · worker 2 · Click getByRole('button')", "running", page, 8, 21),
                // Watch opens the lane in the Worker tab; the dashboard's view is the second choice.
                Glue.CiRow(
                    "ci-watch",
                    "Watch",
                    "worker 2 · read-only",
                    lane = Glue.CiLane("/work/shop", 78, null, 2, "https://piwi.example/test-runs/78?watch=2"),
                ),
                Glue.CiRow("watch", "Watch on the dashboard", "read-only", url = "https://piwi.example/test-runs/78?watch=2"),
                Glue.CiRow("test", "refunds", "chromium · retry 1 · failed", "failed", spec, 10),
            ),
            rows.map { it.copy(key = "") },
        )
        // The newest run first.
        assertEquals(listOf("CI run #79", "CI run #78"), Glue.ciRows(listOf(ci(78), ci(79))).filter { it.kind == "run" }.map { it.text })
    }

    @Test
    fun aCiRowKeepsItsKeyAsTheRunProgressesAndTheRowsMoveSoTheTabKeepsItSelected() {
        val rows = Glue.ciRows(listOf(ci(78)))
        assertEquals(rows.size, rows.map { it.key }.toSet().size)
        assertTrue(rows.none { it.key.isEmpty() })
        // A newer run listed above it, and its progress and call changed: each row keeps its key.
        val moved = ci(78, summary = "2 of 4 tests · 1 failed").let { s ->
            s.copy(tests = s.tests.orEmpty().map { it.copy(at = it.at?.copy(title = "Fill", text = "CI run #78 · worker 2: Fill")) })
        }
        val after = Glue.ciRows(listOf(moved, ci(79)))
        val selected = rows.first { it.kind == "test" && it.status == "running" }
        val now = after.first { it.key == selected.key }
        assertEquals("checkout › pays", now.text)
        assertTrue(after.indexOf(now) > rows.indexOf(selected))
        assertEquals(rows.map { it.key }, after.filter { it.key.startsWith("/work/shop\n78") }.map { it.key })
        // Two tests of one name and project in one run keep keys apart.
        val twice = ci(78).let { s -> s.copy(tests = s.tests.orEmpty() + s.tests.orEmpty().last()) }
        val keys = Glue.ciRows(listOf(twice)).map { it.key }
        assertEquals(keys.size, keys.toSet().size)
    }

    @Test
    fun aCiSessionReadsAsTheServiceSendsIt() {
        val json = """{"runId":78,"root":"/work/shop","url":"https://piwi.example/test-runs/78","name":"CI run #78",
            "branch":"feature/pay","startedAt":"2026-11-12T10:00:00.000Z",
            "progress":{"total":4,"done":1,"failed":1,"flaky":0,"skipped":0,"status":"running"},
            "summary":"1 of 4 tests · 1 failed","watchable":true,"ended":false,
            "tests":[{"title":["pays"],"uri":null,"line":null,"project":"","status":"running","retry":0,"lane":null,
            "shard":null,"at":{"title":"Click","uri":"$page","line":8,"character":null,"text":"CI run #78: Click"},
            "watch":null}]}"""
        val session = Gson().fromJson(json, CiSession::class.java)
        assertEquals(listOf(Glue.CiMark(8, "CI run #78: Click")), Glue.ciMarksIn(listOf(session), page))
        assertEquals(Glue.CiRow("test", "pays", "Click", "running", page, 8, 0), Glue.ciRows(listOf(session))[2].copy(key = ""))
    }

    @Test
    fun aCiRunsLaneInTheWorkerTabSaysWhatRunsThereAndThatItIsReadOnly() {
        val kept = Glue.withCiSession(emptyMap(), ci(78))
        val lane = Glue.CiLane("/work/shop", 78, null, 2, null)
        assertEquals("CI run #78 · worker 2", Glue.ciLaneTitle(lane))
        assertEquals("CI run #78 · shard 3, worker 2", Glue.ciLaneTitle(lane.copy(shard = 3)))
        assertEquals(
            "CI run #78 · worker 2 · Running checkout › pays · Click getByRole('button') · read-only",
            Glue.ciLaneCaption(kept, lane),
        )
        assertEquals("CI run #78 · worker 1 · between tests · read-only", Glue.ciLaneCaption(kept, lane.copy(lane = 1)))
        assertEquals("CI run #78 · worker 2 · the run ended.", Glue.ciLaneCaption(emptyMap(), lane))
        // No Watch while the run cannot be watched.
        val unwatched = ci(78).copy(watchable = false, tests = ci(78).tests.orEmpty().map { it.copy(watch = null) })
        assertTrue(Glue.ciRows(listOf(unwatched)).none { it.kind == "ci-watch" || it.kind == "watch" })
    }

    @Test
    fun aCiFrameIsOfTheLaneWatchedAndReadsAsTheServiceSendsIt() {
        val watching = CiWatchParams("/work/shop", 78, null, 2, true)
        val frame = Gson().fromJson(
            """{"root":"/work/shop","runId":78,"shard":null,"lane":2,"data":"/9j/","test":"pays","call":null}""",
            CiFrame::class.java,
        )
        assertTrue(Glue.sameCiLane(watching, frame))
        assertEquals("/9j/", frame.data)
        assertFalse(Glue.sameCiLane(watching, frame.copy(lane = 1)))
        assertFalse(Glue.sameCiLane(watching, frame.copy(runId = 79)))
        assertFalse(Glue.sameCiLane(watching.copy(shard = 1), frame))
        val ended = Gson().fromJson(
            """{"root":"/work/shop","runId":78,"shard":null,"lane":2,"ended":"The CI run ended."}""",
            CiFrame::class.java,
        )
        assertEquals("The CI run ended.", ended.ended)
        assertEquals(null, ended.data)
    }

    private fun layer(json: String): LaneViewLayer = Gson().fromJson(json, LaneViewLayer::class.java)

    @Test
    fun theWorkerTabAsksForTheCallLogAndTheEventsAlwaysAndTheTextAndTheFilmstripWhileSelected() {
        assertEquals(listOf("calls", "events"), Glue.laneLayersAsked(text = false, filmstrip = false))
        assertEquals(listOf("calls", "events", "text"), Glue.laneLayersAsked(text = true, filmstrip = false))
        assertEquals(listOf("calls", "events", "filmstrip"), Glue.laneLayersAsked(text = false, filmstrip = true))
    }

    @Test
    fun whyItWaitsSaysTheCallHowLongWhatItsLocatorMatchesAndTheLogsLastLines() {
        val running = layer(
            """{"ref":"ed-1","lane":1,"worker":3,"test":"t1","layer":"calls","log":{"id":"c3","call":{"title":"Click getByRole('button')","file":"a.spec.ts","line":9},"status":"running","lines":["waiting for getByRole","  locator resolved to <button disabled>","  element is not enabled","retrying"],"point":null,"target":{"count":1,"box":null,"enabled":false},"viewport":null,"ms":4200,"error":null}}""",
        )
        assertEquals(
            Glue.WaitsView(
                "Click getByRole('button') · waiting 4.2 s",
                "1 element matches, disabled",
                listOf("  locator resolved to <button disabled>", "  element is not enabled", "retrying"),
                false,
            ),
            Glue.waitsView(running.log!!),
        )
        val log = running.log!!
        assertEquals("No element matches yet", Glue.waitsView(log.copy(target = LiveCallTarget(0, null))).target)
        assertEquals("3 elements match, the first enabled", Glue.waitsView(log.copy(target = LiveCallTarget(3, true))).target)
        val failed = Glue.waitsView(log.copy(status = "failed", ms = 30_000, lines = listOf("a"), error = "Timeout 30000ms exceeded."))
        assertEquals(Glue.WaitsView("Click getByRole('button') · failed after 30 s", null, listOf("a", "Timeout 30000ms exceeded."), true), failed)
        assertEquals("999 ms", Glue.laneDuration(999))
        assertEquals("17 s", Glue.laneDuration(17_400))
    }

    @Test
    fun eachPageEventIsALineOfItsOwnARequestsPendingTimeByItsAddresssPath() {
        val pending = PageEvent("request-pending", method = "POST", url = "https://shop.test/api/checkout?x=1", id = 4, ms = 17_000, done = false)
        assertEquals(
            Glue.EventLine("pending 2:4", "POST /api/checkout?x=1 pending 17 s", "warning", "https://shop.test/api/checkout?x=1", 9),
            Glue.eventLine(pending, 9, 2, 1),
        )
        fun text(event: PageEvent) = Glue.eventLine(event, 0, 0, 1).text
        assertEquals("Console error: Oops", text(PageEvent("console", text = "Oops")))
        assertEquals("Uncaught error: x is undefined", text(PageEvent("page-error", text = "x is undefined")))
        assertEquals("GET /cart answered 503", text(PageEvent("request-failed", method = "GET", url = "https://shop.test/cart", status = 503)))
        assertEquals("GET /x failed: net::ERR_ABORTED", text(PageEvent("request-failed", method = "GET", url = "/x", failure = "net::ERR_ABORTED")))
        assertEquals(
            "Backend error on POST /pay (500): Card",
            text(PageEvent("backend", method = "POST", url = "https://shop.test/pay", status = 500, level = "error", text = "Card")),
        )
        assertEquals("API POST /orders answered 201 in 85 ms", text(PageEvent("api", method = "POST", url = "https://api.test/orders", status = 201, ms = 85)))
        assertEquals("12 more events were not sent: too many at once.", text(PageEvent("dropped", count = 12)))
    }

    @Test
    fun theNewestEventsComeFirstCappedOneLinePerPendingRequestItsLastTimeInPlace() {
        var shown = Glue.NO_LANE_LAYERS
        fun event(json: String): Set<String> {
            val (next, changed) = Glue.withLaneLayer(shown, layer("""{"ref":"ed-1","lane":0,"worker":0,"test":"t1","layer":"events","at":1800000000000,"event":$json}"""))
            shown = next
            return changed
        }
        val request = """{"kind":"request-pending","id":1,"method":"POST","url":"/api/checkout","ms":%d,"done":%b}"""
        assertEquals(setOf("events"), event(request.format(5000, false)))
        event("""{"kind":"console","text":"Oops"}""")
        event(request.format(10_000, false))
        assertEquals(listOf("POST /api/checkout pending 10 s", "Console error: Oops"), shown.events.map { it.text })
        event(request.format(12_300, true))
        assertEquals("POST /api/checkout answered after 12 s", shown.events.first().text)
        assertEquals(2, shown.events.size)
        repeat(Glue.MAX_LANE_EVENTS + 5) { event("""{"kind":"console","text":"n$it"}""") }
        assertEquals(Glue.MAX_LANE_EVENTS, shown.events.size)
        assertEquals("Console error: n${Glue.MAX_LANE_EVENTS + 4}", shown.events.first().text)
    }

    @Test
    fun theFilmstripKeepsOneImagePerCallInTheTestsOrderAndStartsAnewWithAnotherTest() {
        var shown = Glue.NO_LANE_LAYERS
        fun hear(json: String): Set<String> {
            val (next, changed) = Glue.withLaneLayer(shown, layer(json))
            shown = next
            return changed
        }
        fun thumb(call: String, index: Int, data: String = "/9j/$call==") =
            """{"ref":"ed-1","lane":0,"worker":0,"test":"t1","layer":"filmstrip","thumb":{"call":"$call","title":"Call $index","index":$index,"width":320,"height":200,"at":1800000000000},"data":"$data"}"""
        assertEquals(setOf("strip"), hear(thumb("c1", 1)))
        assertEquals(setOf("strip"), hear(thumb("c2", 2)))
        // The strip sent again, as the tab asks for it again, changes nothing; nor does an image that is no JPEG.
        assertEquals(emptySet<String>(), hear(thumb("c1", 1)))
        assertEquals(emptySet<String>(), hear(thumb("c2", 2)))
        assertEquals(emptySet<String>(), hear(thumb("c9", 9, "iVBORw0KGgo=")))
        assertEquals(listOf("c1", "c2"), shown.strip.map { it.call })
        hear("""{"ref":"ed-1","lane":0,"worker":0,"test":null,"layer":"text","text":{"call":null,"source":"snapshot","text":"- heading \"Shop\"","cut":false,"at":1800000000000}}""")
        // Another test's call log clears the strip; the page's text stays.
        val changed = hear("""{"ref":"ed-1","lane":0,"worker":0,"test":"t2","layer":"calls","log":{"id":"d1","call":{"title":"Click"},"status":"running","lines":[],"ms":0}}""")
        assertEquals(setOf("strip", "waits"), changed)
        assertTrue(shown.strip.isEmpty())
        assertEquals("- heading \"Shop\"", shown.text?.text)
        assertEquals("Read from the page.", Glue.laneTextNote(shown.text))
        hear("""{"ref":"ed-1","lane":0,"worker":0,"test":"t2","layer":"text","refused":"The page is closed."}""")
        assertEquals("The page is closed.", Glue.laneTextNote(shown.text))
        assertEquals("From the test’s trace. Cut at 96 K characters.", Glue.laneTextNote(Glue.LaneTextShown("x", true, "trace", null)))
        assertEquals("Nothing yet.", Glue.laneTextNote(null))
    }

    @Test
    fun aRetryOfTheTestInAnotherWorkerOrFromItsFirstCallStartsTheFilmstripAndTheCallLogAnew() {
        fun attempt(worker: Int, call: String, index: Int) = layer(
            """{"ref":"ed-1","lane":0,"worker":$worker,"test":"same-test-id","layer":"filmstrip","thumb":{"call":"$call","title":"Attempt $worker call $index","index":$index,"width":320,"height":200,"at":1800000000000},"data":"/9j/${call.filter { it.isLetterOrDigit() }}$worker=="}""",
        )
        fun strip(shown: Glue.LaneLayersShown) = shown.strip.map { "${it.call} ${it.title}" }
        var shown = Glue.NO_LANE_LAYERS
        for ((call, index) in listOf("abcd@1" to 1, "abcd@2" to 2, "abcd@3" to 3)) shown = Glue.withLaneLayer(shown, attempt(0, call, index)).first
        shown = Glue.withLaneLayer(
            shown,
            layer("""{"ref":"ed-1","lane":0,"worker":0,"test":"same-test-id","layer":"calls","log":{"id":"c3","call":{"title":"Click"},"status":"running","lines":[],"ms":0}}"""),
        ).first
        // The retry runs in another worker: its first layer clears the attempt before, the call log with the strip.
        val (retry, changed) = Glue.withLaneLayer(shown, attempt(1, "wxyz@1", 1))
        assertEquals(setOf("strip", "waits"), changed)
        assertNull(retry.waits)
        shown = Glue.withLaneLayer(retry, attempt(1, "wxyz@2", 2)).first
        assertEquals(listOf("wxyz@1 Attempt 1 call 1", "wxyz@2 Attempt 1 call 2"), strip(shown))

        // Step ids that restart with each attempt: the retry's images are not taken for the first attempt's sent again.
        var restarted = Glue.NO_LANE_LAYERS
        for ((call, index) in listOf("pw:api@1" to 1, "pw:api@2" to 2, "pw:api@3" to 3)) restarted = Glue.withLaneLayer(restarted, attempt(0, call, index)).first
        restarted = Glue.withLaneLayer(restarted, attempt(1, "pw:api@1", 1)).first
        restarted = Glue.withLaneLayer(restarted, attempt(1, "pw:api@2", 2)).first
        assertEquals(listOf("pw:api@1 Attempt 1 call 1", "pw:api@2 Attempt 1 call 2"), strip(restarted))
        // An image placed at or before the strip's last, of a call it does not hold, is another attempt's, whatever
        // worker names it.
        assertEquals(listOf("qq@2 Attempt 1 call 2"), strip(Glue.withLaneLayer(restarted, attempt(1, "qq@2", 2)).first))
    }

    @Test
    fun aFilmstripImageIsSizedFromItsJpegHeaderAndOneLargerThanTwiceAThumbnailIsLetGoBeforeItIsDecoded() {
        fun jpeg(width: Int, height: Int): ByteArray {
            val out = java.io.ByteArrayOutputStream()
            javax.imageio.ImageIO.write(java.awt.image.BufferedImage(width, height, java.awt.image.BufferedImage.TYPE_INT_RGB), "jpg", out)
            return out.toByteArray()
        }
        fun base64(bytes: ByteArray) = java.util.Base64.getEncoder().encodeToString(bytes)
        val thumb = jpeg(320, 180)
        assertEquals(320 to 180, Glue.jpegSize(thumb))
        assertTrue(Glue.stripImageBytes(base64(thumb))!!.contentEquals(thumb))
        assertEquals(640 to 400, Glue.jpegSize(jpeg(640, 400)))
        assertTrue(Glue.stripImageBytes(base64(jpeg(640, 400))) != null)
        assertNull(Glue.stripImageBytes(base64(jpeg(641, 100))))
        assertNull(Glue.stripImageBytes(base64(jpeg(100, 401))))
        // A progressive JPEG of a few bytes naming 4000 by 4000 pixels: refused from its header, never decoded.
        fun u16(n: Int) = byteArrayOf((n shr 8).toByte(), n.toByte())
        val huge = byteArrayOf(0xFF.toByte(), 0xD8.toByte()) +
            byteArrayOf(0xFF.toByte(), 0xE0.toByte()) + u16(16) + "JFIF".toByteArray() + ByteArray(10) +
            byteArrayOf(0xFF.toByte(), 0xFF.toByte()) +
            byteArrayOf(0xFF.toByte(), 0xC2.toByte()) + u16(17) + byteArrayOf(8) + u16(4000) + u16(4000) + ByteArray(10) +
            byteArrayOf(0xFF.toByte(), 0xDA.toByte()) + u16(8) + ByteArray(6)
        assertEquals(4000 to 4000, Glue.jpegSize(huge))
        assertNull(Glue.stripImageBytes(base64(huge)))
        // No size before the scan, no JPEG, nothing past the thumbnail's bound in base64.
        val scanFirst = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xDA.toByte()) + u16(8) + ByteArray(6)
        assertNull(Glue.jpegSize(scanFirst))
        assertNull(Glue.jpegSize("iVBORw0KGgo".toByteArray()))
        assertNull(Glue.stripImageBytes("iVBORw0KGgo="))
        assertNull(Glue.stripImageBytes("/9j/" + "A".repeat(180_000)))
        assertNull(Glue.stripImageBytes(null))
    }

    @Test
    fun aCiLayerReadsAsTheServiceSendsItAndAnOlderReporterIsNamed() {
        val ci = Gson().fromJson(
            """{"root":"/work/shop","runId":78,"shard":null,"lane":2,"worker":4,"test":"checkout › pays","layer":"events","event":{"kind":"console","text":"Oops"},"at":1800000000000}""",
            CiLayer::class.java,
        )
        assertEquals(4, ci.worker)
        assertEquals("Console error: Oops", Glue.withLaneLayer(Glue.NO_LANE_LAYERS, ci).first.events.single().text)
        assertTrue(Glue.laneLayersNote(RunWorker(0, 0, "running", layers = false))!!.startsWith("This worker’s reporter sends its images alone"))
        assertNull(Glue.laneLayersNote(RunWorker(0, 0, "running", layers = true)))
        assertNull(Glue.laneLayersNote(null))
    }

    @Test
    fun theWorkerTabOffersTheTraceSoFarOnlyForARunningTestWhoseReporterAnswersTraceAsks() {
        val test = RunTest("t1", listOf("checkout", "pays"))
        assertTrue(Glue.canOpenTrace(RunWorker(0, 1, "running", test, traces = true)))
        // At a stop, the test runs on: its trace so far opens too.
        assertTrue(Glue.canOpenTrace(RunWorker(0, 1, "stopped", test, traces = true)))
        assertFalse(Glue.canOpenTrace(RunWorker(0, 1, "between", null, traces = true)))
        assertFalse(Glue.canOpenTrace(RunWorker(0, 1, "running", test)))
        assertFalse(Glue.canOpenTrace(RunWorker(0, 1, "running", test, traces = false)))
        assertFalse(Glue.canOpenTrace(null))
        // The protocol's field, as the service sends it.
        val heard = Gson().fromJson("""{"worker":0,"parallelIndex":1,"state":"running","test":{"id":"t1"},"traces":true}""", RunWorker::class.java)
        assertTrue(Glue.canOpenTrace(heard))
        assertEquals(OpenTraceParams("r1", 1), Gson().fromJson("""{"ref":"r1","lane":1}""", OpenTraceParams::class.java))
    }

    @Test
    fun aTraceAnswerNamesItsWorkerOnceTheWorkerTabShowsAnotherSlot() {
        val said = "Playwright's trace viewer opened on the trace so far."
        assertEquals(said, Glue.traceAnswerText("r1" to 0, "r1" to 0, said))
        assertEquals("Worker 1: $said", Glue.traceAnswerText("r1" to 0, "r1" to 1, said))
        assertEquals("Worker 3: $said", Glue.traceAnswerText("r1" to 2, "r2" to 2, said))
        // The tab closed, or shows a CI run's lane.
        assertEquals("Worker 2: $said", Glue.traceAnswerText("r1" to 1, null, said))
    }

    @Test
    fun aCiLaneSaysWhyItMayShowNoneOfItsLayersUntilTheFirstComes() {
        assertTrue(Glue.ciLaneLayersNote(Glue.NO_LANE_LAYERS)!!.endsWith("older than the IDE’s sends the images alone."))
        fun ci(fields: String) = Gson().fromJson(
            """{"root":"/work/shop","runId":78,"shard":null,"lane":2,"worker":4,"test":"checkout › pays",$fields}""",
            CiLayer::class.java,
        )
        // Its call log comes with the view itself, whatever the instance and the reporter: it says nothing of the others.
        val calls = Glue.withLaneLayer(Glue.NO_LANE_LAYERS, ci(""""layer":"calls","log":{"id":"c1","call":{"title":"Click"},"status":"running","lines":[],"ms":0}""")).first
        assertTrue(Glue.ciLaneLayersNote(calls) != null)
        assertNull(Glue.ciLaneLayersNote(Glue.withLaneLayer(calls, ci(""""layer":"events","at":1800000000000,"event":{"kind":"console","text":"Oops"}""")).first))
        assertNull(Glue.ciLaneLayersNote(Glue.withLaneLayer(calls, ci(""""layer":"text","refused":"No page."""")).first))
        assertNull(
            Glue.ciLaneLayersNote(
                Glue.withLaneLayer(calls, ci(""""layer":"filmstrip","thumb":{"call":"c1","title":"Click","index":1,"width":320,"height":200,"at":1800000000000},"data":"/9j/AA=="""")).first,
            ),
        )
    }

    @Test
    fun aChangeOfTheLayersIsHeldAsAskedUnlessTheServiceRefusedThatVeryChange() {
        val asked = listOf("calls", "events", "text")
        assertEquals(asked, Glue.layersAfterAnswer(asked, asked, ok = true))
        assertEquals(emptyList<String>(), Glue.layersAfterAnswer(asked, asked, ok = false))
        // A later change asked meanwhile stays held: its own answer decides.
        assertEquals(listOf("calls", "events"), Glue.layersAfterAnswer(listOf("calls", "events"), asked, ok = false))
    }

    @Test
    fun theTextTabsSearchFindsTheNextMatchIgnoringCaseAndWrapsToTheStart() {
        val text = "- heading \"Shop\"\n- button \"Pay\"\n- link \"pay later\""
        assertEquals(text.indexOf("\"Pay\"") + 1, Glue.findIn(text, "pay", 0))
        val first = Glue.findIn(text, "pay", 0)
        assertEquals(text.indexOf("pay later"), Glue.findIn(text, "pay", first + 1))
        assertEquals(first, Glue.findIn(text, "PAY", text.indexOf("pay later") + 1))
        assertEquals(-1, Glue.findIn(text, "checkout", 0))
        assertEquals(-1, Glue.findIn(text, "", 0))
    }
}
