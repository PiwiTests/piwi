package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
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
    fun `without a Playwright config, says so`() {
        assertEquals("Piwi", Glue.statusView(StatusResult(emptyList()), null).text)
    }

    @Test
    fun `when not connected, offers Connect with the reason`() {
        val view = Glue.statusView(StatusResult(listOf(ContextStatus(root = "/w", problem = "No project chosen."))), null)
        assertEquals(Glue.StatusView("Piwi: connect", "No project chosen.", null, Glue.StatusAction.CONNECT), view)
    }

    @Test
    fun `a passing run, with its flaky tests, which a click reads again`() {
        assertEquals(
            Glue.StatusView(
                "Piwi: 118 passed · 2 flaky",
                "Run #41 of Acme on feature/pay: 118 passed, 0 failed, 2 flaky, 0 skipped\nhttp://piwi, from the workspace .env",
                "http://piwi/test-runs/41",
                Glue.StatusAction.REFRESH,
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
    fun `a failure of a local run, and a failure fixed since, name their run`() {
        val failing = WorkspaceFailure(title = "pays", runId = 124, source = "local", state = "failing")
        assertEquals("local run #124", Glue.failureRunNote(failing))
        assertEquals("your run #124", Glue.failureRunNote(failing.copy(source = "own")))
        assertEquals(null, Glue.failureRunNote(failing.copy(source = "ci")))
        assertEquals(null, Glue.failureRunNote(WorkspaceFailure(title = "pays", runId = 41)))
        val fixed = failing.copy(state = "fixed-locally", headline = null)
        assertEquals("fixed locally in run #124", Glue.failureRunNote(fixed))
        assertEquals("fixed locally in your run #124", Glue.failureRunNote(fixed.copy(source = "own")))
        assertEquals("fixed in run #124", Glue.failureRunNote(fixed.copy(source = "ci")))
        assertEquals(true, Glue.isFixedLocally(fixed))
        assertEquals(false, Glue.isFixedLocally(failing))
    }

    @Test
    fun `a failure whose line changed since its run names that run`() {
        val edited = WorkspaceFailure(title = "removes a row", runId = 41, source = "ci", state = "edited")
        assertEquals("edited since run #41", Glue.failureRunNote(edited))
        assertEquals("edited since your run #124", Glue.failureRunNote(edited.copy(runId = 124, source = "own")))
        assertEquals("edited since local run #124", Glue.failureRunNote(edited.copy(runId = 124, source = "local")))
        assertEquals(true, Glue.isEdited(edited))
        assertEquals(false, Glue.isEdited(edited.copy(state = "failing")))
        assertEquals(false, Glue.isFixedLocally(edited))
    }

    @Test
    fun `a run in progress, the editor's own or one on the branch, in the text and beside the latest run`() {
        val failed = passed.copy(status = "failed", passedTests = 115, failedTests = 3, flakyTests = 0)
        val inProgress = LiveRun(runId = 124, status = "running", done = 4, total = 9, failed = 1, own = true)
        fun live(run: RunInfo?, live: LiveRun?) =
            RunStatusResult(listOf(RunStatus(root = "/w", branch = "feature/pay", run = run, failingTests = 3, live = live)))
        val own = Glue.statusView(connected, live(failed, inProgress))
        assertEquals("Piwi: 4/9 · 1 failing · your run", own.text)
        assertEquals(
            "Run #41 of Acme on feature/pay: 115 passed, 3 failed, 0 flaky, 0 skipped\n" +
                "Your run #124 is running: 4/9 · 1 failing\nhttp://piwi, from the workspace .env",
            own.tooltip,
        )
        val other = Glue.statusView(connected, live(failed, inProgress.copy(own = false, failed = 0)))
        assertEquals("Piwi: 4/9", other.text)
        assertEquals(true, other.tooltip.contains("\nRun #124 is running: 4/9\n"))
        // Once it ended, the latest run again.
        assertEquals("Piwi: 3 failing", Glue.statusView(connected, live(failed, null)).text)
        // On a branch without a run yet.
        val first = Glue.statusView(connected, live(null, inProgress.copy(done = 0, failed = 0)))
        assertEquals("Piwi: 0/9 · your run", first.text)
        assertEquals(
            "No run of Acme on feature/pay yet\nYour run #124 is running: 0/9\nhttp://piwi, from the workspace .env",
            first.tooltip,
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
    fun `the MCP configuration bridges each instance through mcp-remote, the key in env`() {
        val json = JsonParser.parseString(
            Glue.mcpConfiguration(
                listOf(
                    McpServerDefinition("Piwi (a)", "https://a/mcp", mapOf("Authorization" to "Bearer pd_x")),
                    McpServerDefinition("Piwi (b)", "http://b/mcp", emptyMap()),
                ),
            ),
        ).asJsonObject.getAsJsonObject("mcpServers")
        val first = json.getAsJsonObject("piwi")
        assertEquals("npx", first.get("command").asString)
        assertEquals(
            listOf("-y", "mcp-remote", "https://a/mcp", "--header", "Authorization:\${PIWI_AUTH}"),
            first.getAsJsonArray("args").map { it.asString },
        )
        assertEquals("Bearer pd_x", first.getAsJsonObject("env").get("PIWI_AUTH").asString)
        assertEquals(listOf("-y", "mcp-remote", "http://b/mcp"), json.getAsJsonObject("piwi-2").getAsJsonArray("args").map { it.asString })
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
    }

    @Test
    fun `the breakpoints a run pauses at are those in script files under a Playwright config`() {
        val root = Files.createTempDirectory("piwi-breakpoints").toRealPath()
        val spec = root.resolve("tests/login.spec.ts")
        val page = root.resolve("tests/pages/checkout.page.mjs")
        val found = Glue.runBreakpoints(
            listOf(
                Glue.BreakpointAt(spec.toString(), 41),
                Glue.BreakpointAt(page.toString(), 8),
                Glue.BreakpointAt(root.resolve("README.md").toString(), 3),
                Glue.BreakpointAt(root.resolveSibling("other").resolve("a.spec.ts").toString(), 1),
                Glue.BreakpointAt(spec.toString(), -1),
            ),
            listOf(root.toString()),
        )
        assertEquals(listOf(EditorBreakpoint(spec.toUri().toString(), 41), EditorBreakpoint(page.toUri().toString(), 8)), found)
        assertEquals(emptyList<EditorBreakpoint>(), Glue.runBreakpoints(listOf(Glue.BreakpointAt(spec.toString(), 1)), emptyList()))
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
    fun `a rendered body is re-indented at the caret's indentation`() {
        assertEquals(
            "await page.goto('/cart');\n    await page.getByRole('button').click();",
            Glue.indentBlock("  await page.goto('/cart');\n  await page.getByRole('button').click();\n", "    "),
        )
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
    fun `the failing line's tooltip says why, with the message escaped`() {
        assertEquals(
            "<html><b>Piwi: failed here</b><br>Timeout waiting for &lt;button&gt;<pre>Error: click\n  - waiting for &lt;button&gt; &amp; more</pre></html>",
            Glue.failureTooltip("Timeout waiting for <button>", "Error: click\n  - waiting for <button> & more\n"),
        )
        assertEquals("<html><b>Piwi: failed here</b><br>Failed</html>", Glue.failureTooltip(null, " "))
        assertEquals("<html><b>Piwi: failed here</b><br>boom</html>", Glue.failureTooltip("boom", "boom"))
        assertEquals(
            "<html><b>Piwi: failed here, edited since the run</b><br>boom</html>",
            Glue.failureTooltip("boom", null, edited = true),
        )
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
    fun `the imports a block needs go after the file's last import, each once`() {
        val text = "import { test, expect } from '@playwright/test';\nimport {\n  login,\n  logout,\n} from './helpers';\n\ntest('t', async () => {});\n"
        val afterImports = text.indexOf("\n\ntest")
        assertEquals(
            Glue.ImportInsertion(afterImports, "\nimport { CartPage } from './pages/cart.page';"),
            Glue.importInsertion(
                text,
                listOf("import { CartPage } from './pages/cart.page';", " import { CartPage } from \"./pages/cart.page\" ", "import { login, logout, } from './helpers'"),
            ),
        )
        assertEquals(null, Glue.importInsertion(text, listOf("import { test,expect } from \"@playwright/test\"", "")))
        assertEquals(null, Glue.importInsertion(text, emptyList()))
    }

    @Test
    fun `an import line the file does not hold as it is written is added, whatever names the file binds`() {
        val text = "import CartPage from '../pages/cart.page.js';\nimport './setup';\n"
        val end = text.length - 1
        assertEquals(null, Glue.importInsertion(text, listOf("import './setup'")))
        assertEquals(
            Glue.ImportInsertion(end, "\nimport { CartPage } from './pages/cart.page';\nimport './teardown';"),
            Glue.importInsertion(text, listOf("import { CartPage } from './pages/cart.page';", "import './teardown';")),
        )
    }

    @Test
    fun `without an import, the imports go at the top, followed by an empty line`() {
        assertEquals(Glue.ImportInsertion(0, "import { a } from './a';\n\n"), Glue.importInsertion("test('t', async () => {});\n", listOf("import { a } from './a';")))
        assertEquals(Glue.ImportInsertion(0, "import { a } from './a';\n"), Glue.importInsertion("\ntest('t', async () => {});\n", listOf("import { a } from './a';")))
        // Neither a dynamic import nor `import.meta` is an import statement.
        assertEquals(Glue.ImportInsertion(0, "import { a } from './a';\n\n"), Glue.importInsertion("import('./x');\nimport.meta.url;\n", listOf("import { a } from './a';")))
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
        assertEquals("flow.mts", Glue.specFileName("flow.mts"))
        assertEquals("cart.page.spec.ts", Glue.specFileName("cart.page"))
        assertEquals(null, Glue.specFileName(""))
        assertEquals(null, Glue.specFileName("e2e/checkout"))
        assertEquals(null, Glue.specFileName("..\\checkout"))
        assertEquals(null, Glue.specFileName(".."))
    }

    private val treeNow = java.time.Instant.parse("2026-09-27T10:04:00Z").toEpochMilli()

    private val treeFailures = FailuresResult(
        items = listOf(
            WorkspaceFailure(
                uri = "file:///w/tests/login.spec.ts", line = 41, title = "logs in", headline = "not visible", executionId = 1,
                runId = 120, url = "http://piwi/test-run-cases/1", hasTrace = true, source = "ci", state = "failing",
                browserName = "chromium", file = "tests/login.spec.ts", testCaseId = 7, clusterId = 3,
                clusterTitle = "Login button hidden", owner = "@team-auth", isNew = true, hasScreenshot = true,
            ),
            WorkspaceFailure(
                uri = "file:///w/tests/login.spec.ts", line = 41, title = "logs in", executionId = 2, runId = 120,
                source = "ci", state = "failing", browserName = "firefox", file = "tests/login.spec.ts", testCaseId = 7,
                clusterId = 3, clusterTitle = "Login button hidden", owner = "@team-auth",
            ),
            WorkspaceFailure(
                uri = "file:///w/tests/pages/checkout.page.ts", line = 4, title = "pays", executionId = 3, runId = 124,
                source = "own", state = "edited", browserName = "chromium", file = "tests/checkout.spec.ts", testCaseId = 8,
            ),
            WorkspaceFailure(
                uri = "file:///w/tests/checkout.spec.ts", line = 9, title = "removes a row", executionId = 4, runId = 124,
                source = "own", state = "fixed-locally", browserName = "chromium", file = "tests/checkout.spec.ts",
                testCaseId = 9,
            ),
        ),
        run = FailuresRun(
            id = 120, branch = "feature/x", status = "failed", startTime = "2026-09-27T10:00:00Z", totalTests = 9,
            passedTests = 6, failedTests = 3, url = "http://piwi/test-runs/120", origin = "ci", own = false,
        ),
        overlays = listOf(
            FailuresOverlay(
                id = 124, origin = "editor", startTime = "2026-09-27T10:02:00Z", status = "failed", totalTests = 2,
                passedTests = 1, failedTests = 1, url = "http://piwi/test-runs/124", own = true,
            ),
        ),
    )

    private fun labels(nodes: List<Glue.FailureNode>): List<Any> =
        nodes.map { if (it.children.isEmpty()) it.label else listOf("${it.label} (${it.description})", labels(it.children)) }

    @Test
    fun `the failures tree shows the run, the runs since and the failures by file, failing first`() {
        val root = Glue.failureTree(treeFailures, "file", treeNow).single()
        assertEquals("Run #120 · CI · feature/x · 2 failing · 1 fixed locally", root.label)
        assertEquals("4 min ago", root.description)
        assertEquals("http://piwi/test-runs/120", root.url)
        assertEquals(
            listOf(
                listOf("Your runs since (1 run)", listOf("#124 · your run · 2 min ago · 1 passed, 1 failed")),
                listOf("tests/checkout.spec.ts (1 failing · 1 fixed locally)", listOf("pays", "removes a row")),
                listOf("tests/login.spec.ts (1 failing)", listOf("logs in", "logs in")),
            ),
            labels(root.children),
        )
        assertEquals(false, root.children[0].expanded)
        assertEquals("http://piwi/test-runs/124", root.children[0].children[0].url)
    }

    @Test
    fun `a failure says where, on which project, and whether it is new`() {
        val leaves = Glue.failureTree(treeFailures, "flat", treeNow).single().children.drop(1)
        assertEquals(
            listOf(
                "tests/login.spec.ts:42 · chromium · new" to "error",
                "tests/login.spec.ts:42 · firefox" to "error",
                "checkout.page.ts:5 · chromium" to "edited",
                "tests/checkout.spec.ts:10 · chromium" to "fixed",
            ),
            leaves.map { it.description to it.icon },
        )
        assertEquals("edited since your run #124", Glue.failureRunNote(leaves[2].failure!!))
    }

    @Test
    fun `the failures group by cluster or owner, those without one last`() {
        val byCluster = Glue.failureTree(treeFailures, "cluster", treeNow).single().children.drop(1)
        assertEquals(
            listOf("Login button hidden" to "1 failing", "Ungrouped" to "1 failing · 1 fixed locally"),
            byCluster.map { it.label to it.description },
        )
        val byOwner = Glue.failureTree(treeFailures, "owner", treeNow).single().children.drop(1)
        assertEquals(listOf("@team-auth", "Unowned"), byOwner.map { it.label })
    }

    @Test
    fun `while the editor's own run is live, the run counts it`() {
        val live = LiveRun(runId = 125, status = "running", done = 4, total = 9, own = true)
        assertEquals("running 4/9", Glue.failureTree(treeFailures, "file", treeNow, live).single().description)
        assertEquals("4 min ago", Glue.failureTree(treeFailures, "file", treeNow, live.copy(own = false)).single().description)
    }

    @Test
    fun `without a failure the tree is empty, and from an older service it holds the groups alone`() {
        assertEquals(emptyList<Glue.FailureNode>(), Glue.failureTree(FailuresResult(emptyList(), treeFailures.run), "file"))
        assertEquals(emptyList<Glue.FailureNode>(), Glue.failureTree(null, "file"))
        val older = Glue.failureTree(FailuresResult(listOf(treeFailures.items!![0].copy(file = null))), "file")
        assertEquals(listOf("login.spec.ts"), older.map { it.label })
    }

    @Test
    fun `the header names the run, the failing tests are counted and re-run from the file of the first`() {
        assertEquals("Run #120 · CI · feature/x · 2 failing · 1 fixed locally · 4 min ago", Glue.runHeader(treeFailures, treeNow))
        assertEquals(null, Glue.runHeader(FailuresResult(emptyList())))
        assertEquals(2, Glue.failingCount(treeFailures))
        assertEquals(RunTestsArgs("file:///w/tests/login.spec.ts", listOf(7, 8)), Glue.rerunFailingArgs(treeFailures))
        assertEquals(null, Glue.rerunFailingArgs(FailuresResult(listOf(treeFailures.items!![3]))))
    }

    @Test
    fun `Compare With offers the ladder, the branches with runs, a run by id and the local runs`() {
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
    fun `a run id is read with or without its hash, and a choice is kept per root as text`() {
        assertEquals(listOf(118, 118, null, null, null), listOf("118", " #118 ", "0", "run 118", "").map { Glue.runIdOf(it) })
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
            "Run #120 · CI · feature/x · 2 failing · 1 fixed locally · 4 min ago · Baseline: $label",
            Glue.runHeader(treeFailures.copy(baseline = Baseline(BaselineChoice("ladder"), label)), treeNow),
        )
        assertEquals(
            "Baseline: release (no run)",
            Glue.runHeader(FailuresResult(emptyList(), baseline = Baseline(BaselineChoice("branch", branch = "release"), "release (no run)"))),
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
        val alone = treeFailures.copy(run = null, baseline = local)
        val root = Glue.failureTree(alone, "file", treeNow).single()
        assertEquals("Your local runs · 2 failing · 1 fixed locally" to "no baseline", root.label to root.description)
        assertEquals(listOf("Your runs", "tests/checkout.spec.ts", "tests/login.spec.ts"), root.children.map { it.label })
        assertEquals("Your local runs · 2 failing · 1 fixed locally · Baseline: your local runs only", Glue.runHeader(alone, treeNow))
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
    fun `a run's verdict counts the CI failures it fixed and names those still failing, with Re-run Failing`() {
        assertEquals(
            Glue.RunVerdict(
                true,
                "Run #124 · 1 of 3 CI failures fixed, 2 still failing (login.spec.ts › logs in, checkout.spec.ts › pays)",
                listOf("Open the Failures", "Open in Dashboard", "Re-run Failing"),
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
            Glue.RunVerdict(false, "Run #124 · 1 of 1 CI failure fixed", listOf("Open the Failures", "Open in Dashboard")),
            Glue.runVerdict(passing),
        )
        assertEquals("Run #124 · 4 passed, 0 failed, 1 flaky", Glue.runVerdict(passing.copy(fixed = 0, passed = 4, flaky = 1))?.text)
        // From an older service, without the counts: the titles count.
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
    fun `a test of the run in progress says it runs, and its files are drawn again when it begins or ends`() {
        assertEquals("Piwi: running · passed 4/4", Glue.testResultTooltip("running", "passed 4/4"))
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
        val result = FailuresResult(
            items = listOf(WorkspaceFailure(uri = "file:///w/a.spec.ts", line = 3, title = "pays", executionId = 9, runId = 41, file = "a.spec.ts")),
            run = FailuresRun(id = 41, startTime = "2026-09-27T10:00:00.000Z"),
        )
        val now = java.time.Instant.parse("2026-09-27T10:04:00.000Z").toEpochMilli()
        val idle = Glue.failureTree(result, "file", now)
        val running = Glue.failureTree(result, "file", now, LiveRun(runId = 124, done = 3, total = 9, own = true))
        assertEquals(false, idle == running)
        assertEquals(true, Glue.sameShape(idle, running))
        assertEquals(false, Glue.sameShape(idle, Glue.failureTree(result, "flat", now)))
        val another = result.copy(items = result.items!! + result.items!!.first().copy(executionId = 10, title = "refunds"))
        assertEquals(false, Glue.sameShape(idle, Glue.failureTree(another, "file", now)))
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
}
