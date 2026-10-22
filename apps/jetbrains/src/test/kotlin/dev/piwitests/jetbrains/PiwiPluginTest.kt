package dev.piwitests.jetbrains

import com.intellij.codeInsight.hints.codeVision.DaemonBoundCodeVisionProvider
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.components.service
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.sun.net.httpserver.HttpServer
import org.eclipse.lsp4j.ClientCapabilities
import org.eclipse.lsp4j.InitializeParams
import org.eclipse.lsp4j.InitializedParams
import org.eclipse.lsp4j.MessageActionItem
import org.eclipse.lsp4j.MessageParams
import org.eclipse.lsp4j.PublishDiagnosticsParams
import org.eclipse.lsp4j.ShowMessageRequestParams
import org.eclipse.lsp4j.WorkspaceFolder
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.launch.LSPLauncher
import org.eclipse.lsp4j.services.LanguageClient
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class PiwiPluginTest : BasePlatformTestCase() {
    fun testRegistersItsExtensionsAndActions() {
        assertTrue(LspServerSupportProvider.EP_NAME.extensionList.any { it is PiwiLspServerSupportProvider })
        val codeVision = DaemonBoundCodeVisionProvider.extensionPoint.extensionList
        assertTrue(codeVision.map { it.javaClass.name }.toString(), codeVision.any { it is PiwiCodeVisionProvider })
        assertTrue(StatusBarWidgetFactory.EP_NAME.extensionList.any { it is PiwiStatusBarWidgetFactory })
        assertTrue(
            com.intellij.openapi.options.Configurable.PROJECT_CONFIGURABLE.getExtensions(project)
                .any { it.instanceClass == PiwiConfigurable::class.java.name },
        )
        // Registered on JavaScript, the annotator serves its dialects too: a spec is TypeScript.
        val annotators = com.intellij.lang.ExternalLanguageAnnotators.INSTANCE
        assertTrue(annotators.allForLanguage(com.intellij.lang.javascript.JavaScriptSupportLoader.TYPESCRIPT).any { it is PiwiTestAnnotator })
        assertTrue(com.intellij.openapi.options.colors.ColorSettingsPage.EP_NAME.extensionList.any { it is PiwiColorSettingsPage })
        for (id in listOf("Piwi.Connect", "Piwi.Disconnect", "Piwi.OpenSettings", "Piwi.Refresh", "Piwi.RunTestsForFile", "Piwi.OpenInDashboard", "Piwi.CopyMcpConfiguration", "Piwi.RunSelection", "Piwi.PairPicker", "Piwi.ToggleCoverageMarks", "Piwi.RerunFailing")) {
            assertNotNull(id, ActionManager.getInstance().getAction(id))
        }
        // The default keymap, which every bundled keymap descends from, binds the actions used while typing.
        val keymap = com.intellij.openapi.keymap.KeymapManager.getInstance().getKeymap(com.intellij.openapi.keymap.KeymapManager.DEFAULT_IDEA_KEYMAP)!!
        fun strokes(id: String) = keymap.getShortcuts(id).filterIsInstance<com.intellij.openapi.actionSystem.KeyboardShortcut>().map { it.firstKeyStroke }
        val record = javax.swing.KeyStroke.getKeyStroke("ctrl alt shift R")
        assertEquals(listOf(record), strokes("Piwi.RecordHere"))
        assertEquals("the same chord stops the recording", listOf(record), strokes("Piwi.StopRecording"))
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("ctrl alt shift F")), strokes("Piwi.RerunFailing"))
    }

    /** The service's process gets the IDE's HTTP proxy, as the variables the service reads; nothing when the IDE reaches the instance directly. */
    fun testTheServiceGetsTheIdesProxy() {
        val selector = object : java.net.ProxySelector() {
            override fun select(uri: java.net.URI): List<java.net.Proxy> =
                if (uri.host == "piwi.example.com") listOf(java.net.Proxy(java.net.Proxy.Type.HTTP, java.net.InetSocketAddress("proxy.example.com", 3128)))
                else listOf(java.net.Proxy.NO_PROXY)

            override fun connectFailed(uri: java.net.URI, address: java.net.SocketAddress, failure: java.io.IOException) {}
        }
        val settings = project.service<PiwiSettings>().state
        val saved = settings.serverUrl
        try {
            settings.serverUrl = "https://piwi.example.com"
            val environment = PiwiLspServerDescriptor(project).proxyEnvironment(selector)
            assertEquals("http://proxy.example.com:3128", environment["HTTPS_PROXY"])
            assertEquals("http://proxy.example.com:3128", environment["HTTP_PROXY"])
            assertEquals("localhost,127.0.0.1,::1", environment["NO_PROXY"])
            settings.serverUrl = ""
            assertEquals("no proxy for a public address, none for the service", emptyMap<String, String>(), PiwiLspServerDescriptor(project).proxyEnvironment(selector))
        } finally {
            settings.serverUrl = saved
        }
    }

    /** A project's settings, which a repository may commit, only ever select the key saved for their own instance. */
    fun testTheApiKeyIsKeptPerInstance() {
        val service = project.getService(PiwiProjectService::class.java)
        try {
            service.saveCredentials("https://a.example/", "Shop", "pd_a")
            assertEquals(EditorCredentials("https://a.example", "pd_a", "Shop", baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            service.settings().serverUrl = "https://b.example"
            assertEquals(null, service.credentials().apiKey)
            service.saveCredentials("https://b.example", "Shop", "pd_b")
            service.settings().serverUrl = "https://a.example"
            assertEquals("pd_a", service.credentials().apiKey)
            service.disconnect()
            assertEquals(EditorCredentials(null, null, null, baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            // A project only, no address and no key.
            service.saveCredentials("", "Shop", "pd_ignored")
            assertEquals(EditorCredentials(null, null, "Shop", baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            // The desktop app, chosen on this machine: what is saved for the instance stays.
            service.useDesktop("Mugs")
            assertEquals(EditorCredentials(null, null, "Shop", desktop = true, desktopProject = "Mugs", baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            service.useInstance()
            assertEquals(EditorCredentials(null, null, "Shop", desktopProject = "Mugs", baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            service.useDesktop(null)
            service.disconnect()
            assertEquals(EditorCredentials(null, null, null, baselines = emptyMap(), failureSeverity = "error"), service.credentials())
            assertFalse(service.hasApiKey("https://a.example"))
            assertTrue(service.hasApiKey("https://b.example"))
        } finally {
            service.saveCredentials("https://b.example", "", null)
            service.disconnect()
        }
    }

    /** Connect's requests: an instance with a login asks for a key, and the browser sign-in hands one over. */
    fun testSignsInWithTheBrowserAndListsTheProjects() {
        val started = mutableListOf<String>()
        var polls = 0
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            val (status, answer) = when (exchange.requestURI.path) {
                "/api/projects/menu" ->
                    if (exchange.requestHeaders.getFirst("X-API-Key") == "pd_new") 200 to """{"items":[{"id":7,"name":"Acme Mugs"}]}"""
                    else 401 to "{}"
                "/api/extension/connect" -> {
                    started += body
                    200 to """{"deviceCode":"pdc_1","userCode":"BCDF-GHJK","verificationUrl":"http://x/extension/connect?code=BCDF-GHJK","interval":5,"expiresIn":600}"""
                }
                "/api/extension/connect/token" ->
                    200 to if (++polls == 1) """{"status":"pending"}""" else """{"status":"approved","apiKey":"pd_new","user":{"name":"Ada"}}"""
                else -> 404 to "{}"
            }
            val bytes = answer.toByteArray()
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val url = "http://127.0.0.1:${server.address.port}"
        try {
            assertEquals(PiwiInstance.Reached(url, needsKey = true), PiwiInstance.reach(url))
            val signIn = PiwiInstance.startSignIn(url, "WebStorm", "Linux")
            assertEquals("BCDF-GHJK", signIn.userCode)
            assertEquals(5, signIn.interval)
            assertEquals("""{"editor":"WebStorm","os":"Linux"}""", started.single())
            assertEquals("pending", PiwiInstance.pollSignIn(url, signIn.deviceCode).status)
            val approved = PiwiInstance.pollSignIn(url, signIn.deviceCode)
            assertEquals("approved", approved.status)
            assertEquals(listOf("Acme Mugs"), PiwiInstance.projects(url, approved.apiKey).map { it.name })
        } finally {
            server.stop(0)
        }
    }

    /**
     * An instance on this machine answers on whichever loopback address it listens on: this one listens on
     * 127.0.0.1 only, so `[::1]` is refused (or has no IPv6 at all) and Connect keeps the address that answered.
     */
    fun testReachesAnInstanceOnTheOtherLoopbackAddress() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val bytes = """{"items":[{"id":7,"name":"Acme Mugs"}]}""".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val port = server.address.port
        try {
            assertEquals(PiwiInstance.Reached("http://127.0.0.1:$port", false), PiwiInstance.reach("http://[::1]:$port"))
            assertEquals(PiwiInstance.Reached("http://localhost:$port", false), PiwiInstance.reach("http://localhost:$port"))
        } finally {
            server.stop(0)
        }
        val refused = try {
            PiwiInstance.reach("http://localhost:$port")
            null
        } catch (e: PiwiInstance.Unreachable) {
            e
        }
        assertEquals(
            "nothing answers at http://localhost:$port (nor at http://127.0.0.1:$port or http://[::1]:$port). " +
                "Is the instance running, on that port?",
            refused?.message,
        )
    }

    /** An instance that drops a request asking to upgrade, as `nuxt dev` does: Connect never asks. */
    fun testReachesAnInstanceThatDropsUpgradeRequests() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            if (exchange.requestHeaders.containsKey("Upgrade")) {
                exchange.close()
                return@createContext
            }
            val bytes = """{"items":[{"id":7,"name":"Acme Mugs"}]}""".toByteArray()
            exchange.sendResponseHeaders(200, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        val url = "http://127.0.0.1:${server.address.port}"
        try {
            assertEquals(PiwiInstance.Reached(url, false), PiwiInstance.reach(url))
            assertEquals(listOf("Acme Mugs"), PiwiInstance.projects(url, null).map { it.name })
        } finally {
            server.stop(0)
        }
    }

    fun testCopyTextCopiesTheAgentContext() {
        PiwiCommands.execute(project, "piwi.copyText", listOf(com.google.gson.JsonPrimitive("# Failing test: pays")))
        val copied = com.intellij.openapi.ide.CopyPasteManager.getInstance()
            .getContents<String>(java.awt.datatransfer.DataFlavor.stringFlavor)
        assertEquals("# Failing test: pays", copied)
    }

    /** The project's Playwright configs are searched for on disk, and the service's workspace is the folders searched. */
    fun testTheIdesPlaywrightRunnerTakesTheServicesCommand() {
        assertTrue("WebStorm has its Playwright runner", PlaywrightRunnerGate.available())
        val env = mapOf("PIWI_ORIGIN" to "editor", "PIWI_ORIGIN_REF" to "ed-0000abcd")
        val settings = PlaywrightRunnerLauncher.configure(project, "/w/shop", listOf("tests/a.spec.ts:3", "-g", "pays now", "--headed"), env)!!
        try {
            assertTrue(settings.isTemporary)
            assertEquals("Piwi: a.spec.ts:3", settings.name)
            val runner = (settings.configuration as com.intellij.aqua.runners.playwright.js.PlaywrightRunConfiguration).settings
            assertEquals("/w/shop", runner.workingDir)
            assertEquals("tests/a.spec.ts:3 -g \"pays now\" --headed", runner.cliOptions)
            assertEquals(env, runner.envData.envs)
            assertTrue(runner.envData.isPassParentEnvs)
        } finally {
            com.intellij.execution.RunManager.getInstance(project).removeConfiguration(settings)
        }
    }

    fun testFindsThePlaywrightConfigsAndHandsTheirFoldersToTheService() {
        val service = project.getService(PiwiProjectService::class.java)
        val base = File(project.basePath!!)
        val config = File(base, "e2e/playwright.config.ts").apply { parentFile.mkdirs() }
        try {
            config.writeText("export default {};\n")
            service.searchPlaywright()
            assertTrue(service.hasPlaywrightConfig())
            assertEquals(listOf(base.toPath().resolve("e2e")), service.playwrightConfigDirs())
            assertEquals(listOf(base.toPath()), service.searchRoots())
            val folders = PiwiLspServerDescriptor(project).createInitializeParams().workspaceFolders
            assertEquals(service.searchRoots(), folders.map { java.nio.file.Path.of(java.net.URI(it.uri)) })
        } finally {
            config.delete()
            service.searchPlaywright()
        }
        assertFalse(service.hasPlaywrightConfig())
    }

    /** A Playwright config created or removed while the project is open is found without Refresh, whatever its name. */
    fun testFindsAConfigCreatedOrRemovedWhileTheProjectIsOpen() {
        val service = project.getService(PiwiProjectService::class.java)
        service.searchPlaywright()
        service.watchConfigs()
        val files = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
        // The project's folder as the IDE shows it: the changes in it are reported.
        val base = files.refreshAndFindFileByIoFile(File(project.basePath!!))!!
        base.children
        // A new folder holding a config, as a branch checked out brings it: the IDE reports the folder alone.
        val dir = File(project.basePath!!, "web")
        val config = File(dir, "playwright.config.mts")
        fun waitUntil(condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + 10_000
            while (!condition() && System.currentTimeMillis() < deadline) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(50)
            }
            assertTrue(condition())
        }
        try {
            dir.mkdirs()
            config.writeText("export default {};\n")
            com.intellij.openapi.vfs.VfsUtil.markDirtyAndRefresh(false, true, true, base)
            waitUntil { service.playwrightConfigDirs() == listOf(dir.toPath()) }
            val file = files.refreshAndFindFileByIoFile(config)!!
            com.intellij.openapi.application.WriteAction.runAndWait<java.io.IOException> { file.delete(this) }
            waitUntil { !service.hasPlaywrightConfig() }
        } finally {
            dir.deleteRecursively()
            service.searchPlaywright()
        }
    }

    /** The answers the service pushes are kept as they come, and the listeners hear once of the changes made meanwhile. */
    fun testThePushedAnswersAreKeptAndToldOnce() {
        val service = project.getService(PiwiProjectService::class.java)
        var told = 0
        val parent = com.intellij.openapi.util.Disposer.newDisposable()
        com.intellij.openapi.util.Disposer.register(testRootDisposable, parent)
        service.onChange(parent) { told++ }
        val status = StatusResult(listOf(ContextStatus(root = "/w", connected = true, projectName = "Acme Mugs")))
        val runs = RunStatusResult(listOf(RunStatus(root = "/w", run = RunInfo(id = 41, status = "failed", failedTests = 1))))
        val failures = FailuresResult(items = listOf(WorkspaceFailure(uri = "file:///w/a.spec.ts", title = "pays", executionId = 9)))
        try {
            service.statusChanged(status)
            service.runStatusChanged(runs)
            service.failuresChanged(failures)
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(1, told)
            assertEquals(status, service.status)
            assertEquals(runs, service.runs)
            assertEquals(failures, service.failuresResult)
            assertEquals(failures.items, service.failures)
            // A run in progress moving: told again.
            service.runStatusChanged(RunStatusResult(runs.contexts!!.map { it.copy(live = LiveRun(runId = 42, done = 1, total = 9)) }))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(2, told)
        } finally {
            // No service runs here: a read leaves nothing of the pushed answers to the next tests.
            service.refreshStatus()
            val deadline = System.currentTimeMillis() + 10_000
            while (service.status != null && System.currentTimeMillis() < deadline) Thread.sleep(20)
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        }
    }

    /**
     * The status bar item speaks for the Playwright config of the selected file, its text in the error color while that
     * config's tests fail, and its popup holds what its state calls for first, then Piwi's actions.
     */
    fun testTheStatusBarItemFollowsTheSelectedFile() {
        val service = project.getService(PiwiProjectService::class.java)
        val shop = File(project.basePath!!, "shop")
        val admin = File(shop, "admin")
        val cart = File(shop, "cart.spec.ts")
        val users = File(admin, "users.spec.ts")
        admin.mkdirs()
        cart.writeText("test('pays', async () => {});\n")
        users.writeText("test('lists', async () => {});\n")
        val files = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
        val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
        val error = com.intellij.util.ui.NamedColorUtil.getErrorForeground()
        val widget = PiwiStatusBarWidget(project)
        com.intellij.openapi.util.Disposer.register(testRootDisposable, widget)
        val label = widget.component as javax.swing.JLabel
        var told = 0
        service.onChange(widget) { told++ }
        fun waitUntil(condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + 10_000
            while (!condition() && System.currentTimeMillis() < deadline) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(20)
            }
            assertTrue(condition())
        }
        try {
            editors.openFiles.forEach { editors.closeFile(it) }
            widget.install(com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)!!)
            // The read the item asks for once installed ends before the answers are pushed: no service runs here.
            waitUntil { told > 0 }
            Thread.sleep(200)
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            service.statusChanged(
                StatusResult(
                    listOf(
                        ContextStatus(root = shop.path, connected = true, projectName = "Shop"),
                        ContextStatus(root = admin.path, connected = true, projectName = "Admin"),
                    ),
                ),
            )
            service.runStatusChanged(
                RunStatusResult(
                    listOf(
                        RunStatus(root = shop.path, run = RunInfo(id = 41, status = "failed", totalTests = 3, passedTests = 1, failedTests = 2)),
                        RunStatus(root = admin.path, run = RunInfo(id = 12, status = "passed", totalTests = 5, passedTests = 5)),
                    ),
                ),
            )
            waitUntil { label.text == "Piwi: 2 failing" }
            // Without an editor, the first connected config.
            assertEquals(error.rgb, label.foreground.rgb)
            editors.openFile(files.refreshAndFindFileByIoFile(users)!!, true)
            assertEquals("Piwi: 5 passed", label.text)
            assertTrue(error.rgb != label.foreground.rgb)
            assertTrue(label.toolTipText, label.toolTipText.contains("The active file's Playwright config, in admin (one of 2)"))
            assertNotNull(label.icon)
            val manager = ActionManager.getInstance()
            val entries = widget.actions().getChildren(null)
                .map { if (it is com.intellij.openapi.actionSystem.Separator) "-" else manager.getId(it) ?: it.templateText }
            assertEquals(
                listOf(
                    "Read the Latest Run Again", "Piwi.PauseRecording", "Piwi.ResumeRecording", "Piwi.StopRecording", "-",
                    "Piwi.RerunFailing", "Open the Failures", "Piwi.OpenLatestRun", "Piwi.OpenInDashboard", "Piwi.CompareWith", "-",
                    "Piwi.RunTestAtCursor", "Piwi.RecordHere", "-",
                    "Piwi.Refresh", "Piwi.Connect", "Piwi.OpenSettings",
                ),
                entries,
            )
            editors.openFile(files.refreshAndFindFileByIoFile(cart)!!, true)
            assertEquals("Piwi: 2 failing", label.text)
            assertEquals(error.rgb, label.foreground.rgb)
        } finally {
            editors.openFiles.forEach { editors.closeFile(it) }
            shop.deleteRecursively()
            // No service runs here: a read leaves nothing of the pushed answers to the next tests.
            service.refreshStatus()
            val deadline = System.currentTimeMillis() + 10_000
            while (service.status != null && System.currentTimeMillis() < deadline) Thread.sleep(20)
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        }
    }

    /** A file's coverage answer is drawn as marks in the gutter, one per span, hidden and shown again with the action. */
    fun testCoverageMarksAreDrawnAndHidden() {
        val base = File(project.basePath!!)
        File(base, "src").mkdirs()
        val io = File(base, "src/BasketService.cs").apply { writeText("a\nb\nc\nd\ne\nf\n") }
        val file = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(io)!!
        val document = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(file)!!
        val marks = project.service<PiwiCoverageMarks>()
        val wasShown = marks.shown
        fun drawn() = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
            .filter { it.lineMarkerRenderer != null && it.textAttributesKey?.externalName?.startsWith("PIWI_COVERAGE_") == true }
            .map { Triple(it.textAttributesKey?.externalName, document.getLineNumber(it.startOffset), document.getLineNumber(it.endOffset)) }
            .sortedBy { it.second }
        try {
            marks.shown = true
            // No service runs here: the file is kept, and its answer drawn as it comes.
            marks.ask(file)
            val uri = file.toNioPath().toUri().toString()
            val result = CoverageResult(
                uri = uri,
                state = "mapped",
                executed = listOf(LineSpan(0, 1, 2)),
                notRun = listOf(LineSpan(3, 3)),
                changed = listOf(LineSpan(4, 4)),
                tests = 2,
            )
            assertSame(file, marks.arrived(result))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(
                listOf(
                    Triple("PIWI_COVERAGE_RUN", 0, 1),
                    Triple("PIWI_COVERAGE_NOT_RUN", 3, 3),
                    Triple("PIWI_COVERAGE_CHANGED", 4, 4),
                ),
                drawn(),
            )
            // Hovered in the gutter or the scroll bar, a mark says what it marks and what the marks mean.
            val run = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
                .first { it.textAttributesKey?.externalName == "PIWI_COVERAGE_RUN" }
            val tooltip = Glue.coverageMarkTooltip(Glue.CoverageMark(Glue.CoverageKind.RUN, 0, 1, "Piwi: run by 2 tests"))
            assertEquals(tooltip, (run.lineMarkerRenderer as com.intellij.openapi.editor.markup.ActiveGutterRenderer).tooltipText)
            assertEquals(tooltip, run.errorStripeTooltip)
            assertTrue(marks.known)
            marks.shown = false
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(emptyList<Any>(), drawn())
            marks.shown = true
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(3, drawn().size)
            // A new answer: only the marks it changes are taken off or drawn, the others' highlighters kept.
            fun highlighters() = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
                .filter { it.textAttributesKey?.externalName?.startsWith("PIWI_COVERAGE_") == true }
                .associateBy { it.textAttributesKey?.externalName }
            val first = highlighters()
            marks.arrived(result.copy(notRun = listOf(LineSpan(2, 3))))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            val second = highlighters()
            assertSame(first["PIWI_COVERAGE_RUN"], second["PIWI_COVERAGE_RUN"])
            assertSame(first["PIWI_COVERAGE_CHANGED"], second["PIWI_COVERAGE_CHANGED"])
            assertNotSame(first["PIWI_COVERAGE_NOT_RUN"], second["PIWI_COVERAGE_NOT_RUN"])
            assertEquals(
                listOf(
                    Triple("PIWI_COVERAGE_RUN", 0, 1),
                    Triple("PIWI_COVERAGE_NOT_RUN", 2, 3),
                    Triple("PIWI_COVERAGE_CHANGED", 4, 4),
                ),
                drawn(),
            )
            // A line typed above: the highlighters follow it, and an answer placing the marks where they went keeps them all.
            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "z\n") }
            marks.arrived(result.copy(executed = listOf(LineSpan(1, 2, 2)), notRun = listOf(LineSpan(3, 4)), changed = listOf(LineSpan(5, 5))))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(second.values.toSet(), highlighters().values.toSet())
            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) {
                document.deleteString(0, 2)
                com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().saveDocument(document)
            }
            // Coverage of another version of the file: no mark.
            marks.arrived(result.copy(state = "other-version", executed = emptyList(), notRun = emptyList(), changed = emptyList()))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(emptyList<Any>(), drawn())
            // A file never asked about is not drawn.
            assertNull(marks.arrived(result.copy(uri = "file:///elsewhere/Other.cs")))
        } finally {
            marks.shown = wasShown
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        }
    }

    /** A renamed or moved file loses the marks of its old URI and is asked again under its new one; a deleted file is forgotten. */
    fun testCoverageMarksFollowARenamedOrMovedFile() {
        val dir = File(project.basePath!!, "moving").apply { deleteRecursively() }
        val io = File(dir, "Basket.cs").apply { parentFile.mkdirs(); writeText("a\nb\nc\n") }
        val local = com.intellij.openapi.vfs.LocalFileSystem.getInstance()
        val file = local.refreshAndFindFileByIoFile(io)!!
        val target = local.refreshAndFindFileByIoFile(File(dir, "done").apply { mkdirs() })!!
        val document = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(file)!!
        val marks = project.service<PiwiCoverageMarks>()
        val wasShown = marks.shown
        fun drawn() = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
            .count { it.textAttributesKey?.externalName?.startsWith("PIWI_COVERAGE_") == true }
        fun uri() = file.toNioPath().toUri().toString()
        val dispatch = { com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue() }
        val result = CoverageResult(uri = uri(), state = "exact", executed = listOf(LineSpan(0, 1, 1)), tests = 1)
        try {
            marks.shown = true
            marks.start()
            // No service runs here: the file is kept under each URI it takes, and its answer drawn as it comes.
            marks.ask(file)
            assertSame(file, marks.arrived(result))
            dispatch()
            assertEquals(1, drawn())
            com.intellij.openapi.application.WriteAction.runAndWait<java.io.IOException> { file.rename(this, "Cart.cs") }
            dispatch()
            assertEquals(0, drawn())
            assertNull(marks.arrived(result))
            val renamed = uri()
            assertTrue(renamed, renamed.endsWith("/moving/Cart.cs"))
            assertSame(file, marks.arrived(result.copy(uri = renamed)))
            dispatch()
            assertEquals(1, drawn())
            com.intellij.openapi.application.WriteAction.runAndWait<java.io.IOException> { file.move(this, target) }
            dispatch()
            assertEquals(0, drawn())
            assertNull(marks.arrived(result.copy(uri = renamed)))
            val moved = uri()
            assertTrue(moved, moved.endsWith("/moving/done/Cart.cs"))
            assertSame(file, marks.arrived(result.copy(uri = moved)))
            dispatch()
            assertEquals(1, drawn())
            com.intellij.openapi.application.WriteAction.runAndWait<java.io.IOException> { file.delete(this) }
            dispatch()
            assertEquals(0, drawn())
            assertNull(marks.arrived(result.copy(uri = moved)))
        } finally {
            marks.shown = wasShown
            dir.deleteRecursively()
            local.refreshAndFindFileByIoFile(File(project.basePath!!))?.let { com.intellij.openapi.vfs.VfsUtil.markDirtyAndRefresh(false, true, true, it) }
            dispatch()
        }
    }

    /** A read action waiting on the service gives way as soon as the platform cancels it: typing never waits on it. */
    fun testAWaitOnTheServiceEndsWhenCanceled() {
        val never = CompletableFuture<String>()
        assertNull(never.awaitCancellably(50))
        assertEquals("ok", CompletableFuture.completedFuture("ok").awaitCancellably(50))
        val indicator = com.intellij.openapi.progress.EmptyProgressIndicator()
        val waited = com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread<Throwable?> {
            try {
                com.intellij.openapi.progress.ProgressManager.getInstance().runProcess({ never.awaitCancellably(20_000) }, indicator)
                null
            } catch (e: com.intellij.openapi.progress.ProcessCanceledException) {
                e
            }
        }
        Thread.sleep(100)
        indicator.cancel()
        assertTrue(waited.get(5, TimeUnit.SECONDS) is com.intellij.openapi.progress.ProcessCanceledException)
    }

    fun testServesTheFilesTheServiceReads() {
        for (name in listOf("Checkout.vue", "checkout.page.ts", "Index.cshtml", "Cart.razor", "Strings.resx", "en.json")) {
            assertTrue(name, PiwiLspServerSupportProvider.isSupported(myFixture.addFileToProject("src/$name", "").virtualFile))
        }
        assertFalse(PiwiLspServerSupportProvider.isSupported(myFixture.addFileToProject("src/logo.png", "").virtualFile))
    }

    /** Posts `body` to the Send to editor endpoint as Piwi Picker does, and waits for the answer, pumping the event queue meanwhile. */
    private fun sendFromPicker(body: String, bearer: String): java.net.http.HttpResponse<String> {
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val future = java.net.http.HttpClient.newHttpClient().sendAsync(
            java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port${PiwiSendHandler.PATH}"))
                .header("Authorization", "Bearer $bearer")
                .header("Origin", "chrome-extension://abc")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString(body))
                .build(),
            java.net.http.HttpResponse.BodyHandlers.ofString(),
        )
        val deadline = System.currentTimeMillis() + 20_000
        while (!future.isDone && System.currentTimeMillis() < deadline) {
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(20)
        }
        return future.get(1, TimeUnit.SECONDS)
    }

    /** Piwi Picker's request lands at the caret of the open editor, through the IDE's built-in server. */
    fun testPiwiPickerSendsALocatorToTheCaret() {
        myFixture.configureByText("checkout.spec.ts", "test('pays', async ({ page }) => {\n  <caret>\n});\n")
        val token = PiwiSendToken.ensure()
        assertEquals(401, sendFromPicker("""{"kind":"locator","text":"x"}""", "wrong-token-wrong-token").statusCode())
        val bad = sendFromPicker("""{"kind":"file"}""", token)
        assertEquals(400, bad.statusCode())
        val ok = sendFromPicker("""{"kind":"locator","text":"page.getByRole('button', { name: 'Pay now' })"}""", token)
        assertEquals(ok.body(), 200, ok.statusCode())
        assertEquals("chrome-extension://abc", ok.headers().firstValue("Access-Control-Allow-Origin").orElse(null))
        assertEquals(myFixture.file.virtualFile.path, com.google.gson.JsonParser.parseString(ok.body()).asJsonObject.get("file").asString)
        assertEquals(
            "test('pays', async ({ page }) => {\n  page.getByRole('button', { name: 'Pay now' })\n});\n",
            myFixture.editor.document.text,
        )
    }

    /** Without an editor open, Piwi Picker's text goes into a new scratch file, and the answer names no file. */
    fun testPiwiPickerOpensAScratchFileWhileNoEditorIsOpen() {
        val token = PiwiSendToken.ensure()
        val editors = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
        editors.openFiles.forEach { editors.closeFile(it) }
        assertNull(editors.selectedTextEditor)
        val ok = sendFromPicker("""{"kind":"locator","text":"page.getByLabel('Email')"}""", token)
        assertEquals(ok.body(), 200, ok.statusCode())
        assertTrue(ok.body(), com.google.gson.JsonParser.parseString(ok.body()).asJsonObject.get("file").isJsonNull)
        com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val editor = editors.selectedTextEditor
        val scratch = editor?.virtualFile
        try {
            assertTrue(scratch?.name ?: "no editor", scratch?.name?.startsWith("piwi-picker") == true)
            assertTrue(com.intellij.ide.scratch.ScratchUtil.isScratch(scratch))
            assertEquals("page.getByLabel('Email')", editor?.document?.text)
        } finally {
            if (scratch != null) {
                editors.closeFile(scratch)
                com.intellij.openapi.application.WriteAction.runAndWait<java.io.IOException> { scratch.delete(this) }
            }
        }
    }

    /** The dashboard's Open in IDE finds a run's file in the open project and opens it at its line, through the built-in server. */
    fun testTheDashboardOpensAFileAtItsLine() {
        // The light test project's content is in memory: the files the dashboard asks for are on disk, under its directory.
        val base = File(project.basePath!!)
        File(base, "tests").mkdirs()
        File(base, "tests/checkout.spec.ts").writeText("import { test } from '@playwright/test';\n\ntest('pays', async () => {\n  await pay();\n});\n")
        File(base, "e2e/tests").mkdirs()
        File(base, "e2e/tests/login.spec.ts").writeText("test('signs in', async () => {});\n")
        val outside = FileUtil.createTempDirectory("piwi-outside", null)
        File(outside, "tests").mkdirs()
        File(outside, "tests/secret.spec.ts").writeText("secret\n")
        // The dashboard is the instance the project is connected to, here under another loopback name.
        val settings = project.service<PiwiSettings>().state
        val saved = settings.serverUrl
        settings.serverUrl = "http://localhost:3000"
        val service = project.service<PiwiProjectService>()
        service.readKnownAddresses()
        com.intellij.openapi.util.Disposer.register(testRootDisposable) {
            settings.serverUrl = saved
            service.readKnownAddresses()
        }
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val client = java.net.http.HttpClient.newHttpClient()
        fun get(query: String, origin: String? = "http://127.0.0.1:3000"): java.net.http.HttpResponse<String> {
            val request = java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port${PiwiOpenHandler.PATH}?$query"))
            if (origin != null) request.header("Origin", origin)
            val future = client.sendAsync(request.GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString())
            val deadline = System.currentTimeMillis() + 20_000
            while (!future.isDone && System.currentTimeMillis() < deadline) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(20)
            }
            return future.get(1, TimeUnit.SECONDS)
        }
        fun json(response: java.net.http.HttpResponse<String>) = com.google.gson.JsonParser.parseString(response.body()).asJsonObject

        // Another page on this machine, another site, a request without an origin: a 403 and nothing about the project.
        for (origin in listOf("http://127.0.0.1:5173", "https://evil.example", null)) {
            val refused = get("file=tests/checkout.spec.ts&check", origin)
            assertEquals("$origin: ${refused.body()}", 403, refused.statusCode())
            assertFalse("$origin: ${refused.body()}", refused.body().contains("\"found\"") || refused.body().contains(base.path))
        }

        assertEquals(400, get("line=3").statusCode())
        val missing = get("file=tests/nowhere.spec.ts&check")
        assertEquals(missing.body(), 404, missing.statusCode())
        assertEquals(false, json(missing).get("found").asBoolean)
        assertEquals("http://127.0.0.1:3000", missing.headers().firstValue("Access-Control-Allow-Origin").orElse(null))

        // The dashboard's root, the run's working directory, is tried first; a root outside the project opens nothing.
        val fromRoot = get("file=tests/login.spec.ts&check&root=" + java.net.URLEncoder.encode(File(base, "e2e").path, Charsets.UTF_8))
        assertEquals(fromRoot.body(), 200, fromRoot.statusCode())
        val escaped = get("file=tests/secret.spec.ts&check&root=" + java.net.URLEncoder.encode(outside.path, Charsets.UTF_8))
        assertEquals(escaped.body(), 404, escaped.statusCode())

        val checked = get("file=tests/checkout.spec.ts&line=4&column=9&check")
        assertEquals(checked.body(), 200, checked.statusCode())
        assertEquals(false, json(checked).get("opened").asBoolean)
        assertNull(com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).selectedTextEditor?.virtualFile?.takeIf { it.name == "checkout.spec.ts" })

        val opened = get("file=tests/checkout.spec.ts&line=4&column=9")
        assertEquals(opened.body(), 200, opened.statusCode())
        assertEquals(true, json(opened).get("opened").asBoolean)
        assertEquals(
            FileUtil.toSystemIndependentName(File(base, "tests/checkout.spec.ts").canonicalPath),
            FileUtil.toSystemIndependentName(File(json(opened).get("file").asString).canonicalPath),
        )
        com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val editor = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).selectedTextEditor
        assertEquals("checkout.spec.ts", editor?.virtualFile?.name)
        assertEquals(com.intellij.openapi.editor.LogicalPosition(3, 8), editor?.caretModel?.logicalPosition)
    }

    /** The service the plugin bundles, started with the descriptor's command line, answers in the protocol classes. */
    fun testTheBundledServiceAnswersThroughTheDescriptor() {
        val stub = StubInstance()
        val dir = FileUtil.createTempDirectory("piwi-jetbrains", null, true)
        try {
            writeFixture(dir)
            stub.coverageOf(git(dir, "hash-object", "src/BasketService.cs").trim())
            val commandLine = PiwiLspServerDescriptor(project).createCommandLine()
                .withWorkDirectory(dir)
                .withEnvironment(
                    mapOf(
                        "PIWI_DASHBOARD_URL" to stub.url,
                        "PIWI_PROJECT_NAME" to "Acme Mugs",
                        "PIWI_DESKTOP_CONFIG" to File(dir, "no-desktop.json").path,
                    ),
                )
            val process = commandLine.createProcess()
            try {
                val client = TestClient()
                val launcher = LSPLauncher.Builder<PiwiLanguageServer>()
                    .setLocalService(client)
                    .setRemoteInterface(PiwiLanguageServer::class.java)
                    .setInput(process.inputStream)
                    .setOutput(process.outputStream)
                    .create()
                launcher.startListening()
                val server = launcher.remoteProxy
                server.initialize(
                    InitializeParams().apply {
                        capabilities = ClientCapabilities()
                        workspaceFolders = listOf(WorkspaceFolder(dir.toURI().toString(), "shop"))
                    },
                ).get(20, TimeUnit.SECONDS)
                server.initialized(InitializedParams())

                val deadline = System.currentTimeMillis() + 20_000
                var status: StatusResult? = null
                while (System.currentTimeMillis() < deadline) {
                    status = server.status().get(5, TimeUnit.SECONDS)
                    if (status?.contexts?.firstOrNull()?.connected == true) break
                    Thread.sleep(100)
                }
                assertEquals("Acme Mugs", status?.contexts?.single()?.projectName)
                assertEquals(NamedInstance(stub.url, "environment"), status?.contexts?.single()?.instance)
                assertEquals(null, status?.desktopUrl)

                // The latest run is read after the indexes: wait for it too.
                var runs: RunStatusResult? = null
                while (System.currentTimeMillis() < deadline) {
                    runs = server.runStatus().get(5, TimeUnit.SECONDS)
                    if (runs?.contexts?.firstOrNull()?.run != null) break
                    Thread.sleep(100)
                }
                assertEquals(41, runs?.contexts?.single()?.run?.id)
                assertEquals("Piwi: 1 failing", Glue.statusView(status, runs).text)

                // No desktop app runs here: Connect offers none.
                assertEquals(null, server.desktop().get(5, TimeUnit.SECONDS)?.url)

                val failures = server.failures(FailuresParams("cluster")).get(5, TimeUnit.SECONDS)
                val failure = failures?.items?.single()
                assertEquals("cluster" to 1, failures?.grouping to failures?.failing)
                assertEquals(listOf("failure:${failure?.executionId}"), failures?.tree?.single()?.children?.single()?.children?.map { it.key })
                assertEquals(118, server.runId(RunIdParams(" #118 ")).get(5, TimeUnit.SECONDS)?.runId)
                assertEquals(File(dir, "tests/pages/checkout.page.ts").toURI().toString().replace("file:/", "file:///"), failure?.uri)
                assertEquals(4, failure?.line)
                assertTrue(failure?.hasTrace == true)

                val pageObject = File(dir, "tests/pages/checkout.page.ts").toURI().toString().replace("file:/", "file:///")
                val summary = server.fileSummary(UriParams(pageObject)).get(5, TimeUnit.SECONDS)
                assertEquals(listOf(4 to "1 test · click · 1 failing"), summary?.lines?.map { it.line to it.title })
                assertEquals("piwi.runTests", summary?.lines?.single()?.command?.command)

                // In the spec: the line the failure went through, why, and the evidence above it.
                val spec = File(dir, "tests/checkout.spec.ts").toURI().toString().replace("file:/", "file:///")
                val specLines = server.fileSummary(UriParams(spec)).get(5, TimeUnit.SECONDS)?.lines.orEmpty()
                val test = specLines.single { it.status != null }
                assertEquals("failed", test.status)
                assertEquals(TestFailure(4, "not found", "Error: locator.click: Timeout 5000ms exceeded.", 900, "${stub.url}/test-run-cases/900", "failing"), test.failure)
                assertEquals(
                    listOf(
                        Triple(4, "✗ not found", "piwi.openInDashboard"),
                        Triple(4, "Run this test", "piwi.runTests"),
                        Triple(4, "Screenshot", "piwi.openScreenshot"),
                        Triple(4, "Trace", "piwi.openTrace"),
                    ),
                    specLines.filter { it.status == null }.map { Triple(it.line, it.title, it.command?.command) },
                )
                val shot = server.screenshot(TraceParams(spec, 900)).get(10, TimeUnit.SECONDS)
                assertEquals("PNG-stub", shot?.path?.let { File(it).readText() })

                val mcp = server.mcp().get(5, TimeUnit.SECONDS)?.servers?.single()
                assertEquals("${stub.url}/mcp", mcp?.url)

                // A C# file's coverage: its marks, and its lenses, whose runs record the backend's coverage.
                val basket = File(dir, "src/BasketService.cs").toURI().toString().replace("file:/", "file:///")
                val coverage = server.coverage(UriParams(basket)).get(10, TimeUnit.SECONDS)
                assertEquals("exact", coverage?.state)
                assertEquals(listOf(LineSpan(2, 3, 1)), coverage?.executed)
                assertEquals(listOf(LineSpan(4, 4)), coverage?.notRun)
                assertEquals("2 of 3 lines run by 1 test", coverage?.label)
                assertEquals(
                    listOf(Glue.CoverageKind.RUN to 2..3, Glue.CoverageKind.NOT_RUN to 4..4),
                    Glue.coverageMarks(coverage, 8, shown = true).map { it.kind to it.start..it.end },
                )
                val lenses = server.fileSummary(UriParams(basket)).get(10, TimeUnit.SECONDS)
                assertEquals("Reached by 1 test · 1 failing · 2 of 3 lines run", lenses?.file?.title)
                assertEquals(listOf(2 to "Reached by 1 test · 1 failing"), lenses?.lines?.map { it.line to it.title })
                val args = com.google.gson.Gson().let { it.fromJson(it.toJson(lenses?.file?.command?.arguments?.single()), RunTestsArgs::class.java) }
                assertEquals("server", args.coverage)
                val run = server.runArgs(args).get(10, TimeUnit.SECONDS)
                assertEquals("lines", run?.env?.get("PIWI_COVERAGE_SERVER"))
                assertTrue(client.runStatusChanges > 0)
            } finally {
                process.destroy()
            }
        } finally {
            stub.stop()
        }
    }

    private fun writeFixture(dir: File) {
        fun write(path: String, text: String) = File(dir, path).apply { parentFile.mkdirs() }.writeText(text)
        write("playwright.config.ts", "export default {};\n")
        write(
            "tests/pages/checkout.page.ts",
            listOf(
                "import type { Page } from '@playwright/test';",
                "export class CheckoutPage {",
                "  constructor(private readonly page: Page) {}",
                "  pay = () => this.page.getByRole('button', { name: 'Pay now' });",
                "  row = () => this.page.locator('.cart-row').nth(2);",
                "}",
                "",
            ).joinToString("\n"),
        )
        write(
            "tests/checkout.spec.ts",
            listOf(
                "import { test } from '@playwright/test';",
                "import { CheckoutPage } from './pages/checkout.page';",
                "",
                "test('removes a row', async ({ page }) => {",
                "  await new CheckoutPage(page).row().click();",
                "});",
                "",
            ).joinToString("\n"),
        )
        write(
            "src/BasketService.cs",
            listOf(
                "public class BasketService",
                "{",
                "    public int Add(int a)",
                "    {",
                "        if (a < 0) throw new System.ArgumentException();",
                "        return a + 1;",
                "    }",
                "}",
                "",
            ).joinToString("\n"),
        )
        git(dir, "init", "-q", "-b", "main")
        git(dir, "add", ".")
        git(dir, "commit", "-q", "-m", "init")
    }

    /** What a git command prints in `dir`; it must succeed. */
    private fun git(dir: File, vararg args: String): String {
        val p = ProcessBuilder(listOf("git", "-c", "user.email=t@example.com", "-c", "user.name=t") + args)
            .directory(dir).redirectErrorStream(true).start()
        val out = p.inputStream.readAllBytes().toString(Charsets.UTF_8)
        assertEquals(out, 0, p.waitFor())
        return out
    }

    class TestClient : LanguageClient {
        @Volatile var runStatusChanges = 0

        @JsonNotification("piwi/runStatusChanged")
        fun runStatusChanged(@Suppress("UNUSED_PARAMETER") status: RunStatusResult) {
            runStatusChanges++
        }

        override fun telemetryEvent(`object`: Any?) {}
        override fun publishDiagnostics(diagnostics: PublishDiagnosticsParams?) {}
        override fun showMessage(messageParams: MessageParams?) {}
        override fun showMessageRequest(requestParams: ShowMessageRequestParams?): CompletableFuture<MessageActionItem> =
            CompletableFuture.completedFuture(null)
        override fun logMessage(message: MessageParams?) {}
    }

    /** The instance endpoints the service reads, with one failing run. */
    class StubInstance {
        private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val url get() = "http://127.0.0.1:${server.address.port}"

        init {
            val routes = mapOf(
                "/api/projects/menu" to """{"items":[{"id":7,"name":"Acme Mugs"}]}""",
                "/api/projects/7/locator-index" to """
                    {"projectId":7,"projectName":"Acme Mugs","branch":null,"defaultBranch":"main","branches":[],
                     "builtAt":null,"generatedAt":"2026-09-27T00:00:00Z","testIdAttributes":null,"pages":["/checkout"],
                     "tests":[{"id":3,"title":"removes a row","file":"tests/checkout.spec.ts","suite":[],"status":"failed"}],
                     "locators":[{"locator":"locator('.cart-row').nth(2)","lastSeenAt":"","uses":[{"test":0,"actions":["click"],
                       "callSites":["tests/pages/checkout.page.ts:5:21"],"projects":["chromium"],"branches":["main"]}]}],
                     "truncated":false}
                """.trimIndent(),
                "/api/projects/7/code-index" to """
                    {"files":["src/BasketService.cs"],
                     "tests":[{"id":3,"title":"removes a row","file":"tests/checkout.spec.ts","suite":[],"status":"failed"}],
                     "reach":[{"file":0,"tests":[0],"origin":"server","runtime":"server","via":"coverage"}],
                     "builtAt":null,"truncated":false}
                """.trimIndent(),
                "/api/projects/7/selections/preview" to """{"materialization":{"args":["tests/checkout.spec.ts:4"],"command":"npx playwright test tests/checkout.spec.ts:4"}}""",
                "/api/projects/7/branch-failures" to """
                    {"run":{"id":41,"status":"failed","branch":"main","startTime":"2026-09-27T10:00:00.000Z","totalTests":2,
                      "passedTests":1,"failedTests":1,"flakyTests":0,"skippedTests":0},
                     "failures":[{"executionId":900,"testCaseId":3,"title":"removes a row","file":"tests/checkout.spec.ts",
                      "line":4,"status":"failed","headline":"not found","location":"/ci/work/tests/pages/checkout.page.ts:5:21",
                      "message":"Error: locator.click: Timeout 5000ms exceeded.",
                      "frames":["/ci/work/tests/pages/checkout.page.ts:5:21","/ci/work/tests/checkout.spec.ts:5:32"],
                      "traces":["traces/900.zip"],"screenshot":"shots/900.png"}]}
                """.trimIndent(),
                "/api/projects/7/test-cases" to """
                    {"items":[{"id":3,"title":"removes a row","filePath":"tests/checkout.spec.ts","status":"failed",
                      "totalRuns":4,"passedRuns":3}]}
                """.trimIndent(),
                "/api/files/shots/900.png" to "PNG-stub",
                "/api/projects/7/locator-alternatives" to """{"items":[]}""",
            )
            server.createContext("/") { exchange ->
                val body = if (exchange.requestURI.path == "/api/projects/7/coverage") coverage else routes[exchange.requestURI.path]
                val bytes = (body ?: "{}").toByteArray()
                exchange.responseHeaders.add("Content-Type", "application/json")
                exchange.sendResponseHeaders(if (body != null) 200 else 404, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            server.start()
        }

        /** The coverage of `src/BasketService.cs`, recorded on the version whose blob id is `blob`; none until set. */
        @Volatile private var coverage: String? = null

        fun coverageOf(blob: String) {
            coverage = """
                {"file":"src/BasketService.cs","branch":"main",
                 "fragments":[{"path":"src/BasketService.cs","runtime":"server","blob":"$blob","functions":[[3,7]],"lines":[[3,4]],"tests":[0]}],
                 "tests":[{"id":3,"title":"removes a row","file":"tests/checkout.spec.ts","suite":[],"status":"failed"}],
                 "executable":[{"path":"src/BasketService.cs","runtime":"server","blob":"$blob","lines":[[3,5]]}]}
            """.trimIndent()
        }

        fun stop() = server.stop(0)
    }
}
