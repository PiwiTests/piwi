package dev.piwitests.jetbrains

import com.intellij.codeInsight.hints.codeVision.DaemonBoundCodeVisionProvider
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.components.service
import com.intellij.openapi.util.Disposer
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
    /** Settings search finds Piwi's page by the words its labels lack, on the page's own id. */
    fun testSettingsSearchFindsPiwisPageByItsKeywords() {
        val contributor = com.intellij.openapi.extensions.ExtensionPointName<com.intellij.ide.ui.search.SearchableOptionContributor>("com.intellij.search.optionContributor").extensionList
            .filterIsInstance<PiwiSearchableOptions>().single()
        val added = mutableListOf<Pair<String, String>>()
        contributor.processOptions(object : com.intellij.ide.ui.search.SearchableOptionProcessor() {
            override fun addOptions(text: String, path: String?, hit: String?, configurableId: String, configurableDisplayName: String?, applyStemming: Boolean) {
                added += text to configurableId
            }
        })
        assertTrue(added.contains("Playwright" to "dev.piwitests.piwi"))
        assertEquals(setOf("dev.piwitests.piwi"), added.map { it.second }.toSet())
        val page = com.intellij.openapi.options.Configurable.PROJECT_CONFIGURABLE.getExtensions(project)
            .single { it.instanceClass == PiwiConfigurable::class.java.name }
        assertEquals(PiwiSearchableOptions.CONFIGURABLE_ID, page.id)
    }

    /**
     * Settings → Tools → Piwi stays within 100 columns of its font, its texts wrapped at 90, with every text the page
     * fills as it opens or as Test connection answers holding a long sentence and an instance's address.
     */
    fun testTheSettingsPageStaysWithinItsColumnsWithLongTexts() {
        val page = PiwiConfigurable(project)
        try {
            val content = page.createComponent()!!
            fun all(c: java.awt.Container): List<java.awt.Component> = c.components.flatMap { listOf(it) + if (it is java.awt.Container) all(it) else emptyList() }
            val texts = all(content).filterIsInstance<javax.swing.JEditorPane>()
            val intro = texts.first()
            assertTrue(intro.text.contains("Where this project reads its test history from"))
            val column = intro.getFontMetrics(intro.font).charWidth('0')
            assertTrue("the intro is ${intro.preferredSize.width} px, 90 columns ${90 * column} px", intro.preferredSize.width <= 90 * column)
            val long = List(4) { "Saved for https://piwi.platform-team.example-company.internal:8443 in the IDE's password safe." }
                .joinToString(" ")
            val filled = texts.filter { it.document.getText(0, it.document.length).isBlank() }
            assertTrue(filled.size >= 5)
            filled.forEach { it.text = long }
            assertTrue("the page is ${content.preferredSize.width} px, 100 columns ${100 * column} px", content.preferredSize.width <= 100 * column)
        } finally {
            page.disposeUIResources()
        }
    }

    fun testRegistersItsExtensionsAndActions() {
        assertTrue(LspServerSupportProvider.EP_NAME.extensionList.any { it is PiwiLspServerSupportProvider })
        val codeVision = DaemonBoundCodeVisionProvider.extensionPoint.extensionList
        assertTrue(codeVision.map { it.javaClass.name }.toString(), codeVision.any { it is PiwiCodeVisionProvider })
        // One provider per entry of a line, in one group the Code Vision settings name Piwi.
        val slots = codeVision.filterIsInstance<PiwiCodeVisionProvider>()
        assertEquals((0 until Glue.CODE_VISION_SLOTS).map(PiwiCodeVisionProvider::providerId), slots.map { it.id })
        assertTrue(slots.all { it.groupId == PiwiCodeVisionProvider.GROUP_ID })
        val group = com.intellij.codeInsight.codeVision.settings.CodeVisionGroupSettingProvider.EP.EXTENSION_POINT_NAME.extensionList
            .single { it.groupId == PiwiCodeVisionProvider.GROUP_ID }
        assertEquals("Piwi", group.groupName)
        assertTrue(StatusBarWidgetFactory.EP_NAME.extensionList.any { it is PiwiStatusBarWidgetFactory })
        assertTrue(
            com.intellij.openapi.options.Configurable.PROJECT_CONFIGURABLE.getExtensions(project)
                .any { it.instanceClass == PiwiConfigurable::class.java.name },
        )
        // Registered on JavaScript, the annotator serves its dialects too: a spec is TypeScript.
        val annotators = com.intellij.lang.ExternalLanguageAnnotators.INSTANCE
        assertTrue(annotators.allForLanguage(com.intellij.lang.javascript.JavaScriptSupportLoader.TYPESCRIPT).any { it is PiwiTestAnnotator })
        assertTrue(com.intellij.openapi.options.colors.ColorSettingsPage.EP_NAME.extensionList.any { it is PiwiColorSettingsPage })
        for (id in listOf("Piwi.Connect", "Piwi.Disconnect", "Piwi.OpenSettings", "Piwi.Refresh", "Piwi.RunTestsForFile", "Piwi.OpenInDashboard", "Piwi.CopyMcpConfiguration", "Piwi.RunSelection", "Piwi.PairPicker", "Piwi.ToggleCoverageMarks", "Piwi.RerunFailing", "Piwi.RunHeaded", "Piwi.RunHoldFailures", "Piwi.RestartService", "Piwi.OpenLog", "Piwi.OpenDocumentation")) {
            assertNotNull(id, ActionManager.getInstance().getAction(id))
        }
        // Tools → Piwi leaves out what does not apply, in six sections; the editor's context menu and the project view
        // have one Piwi submenu each, in the VS Code extension's order: run, record, a recording's controls.
        val actions = ActionManager.getInstance()
        fun ids(group: String) = (actions.getAction(group) as com.intellij.openapi.actionSystem.DefaultActionGroup)
            .childActionsOrStubs.map { if (it is com.intellij.openapi.actionSystem.Separator) null else actions.getId(it) }
        assertTrue(actions.getAction("Piwi.Actions") is com.intellij.openapi.actionSystem.CompactActionGroup)
        val sections = listOf("Piwi.Run", "Piwi.Record", "Piwi.RunControl", "Piwi.Dashboard", "Piwi.Agents", "Piwi.Connection")
        assertEquals(sections.flatMap { listOf(it, null) }.dropLast(1), ids("Piwi.Actions"))
        for (section in sections) assertTrue(section, actions.getAction(section) is com.intellij.openapi.actionSystem.CompactActionGroup)
        val popup = actions.getAction("Piwi.EditorPopup") as com.intellij.openapi.actionSystem.DefaultActionGroup
        assertTrue(popup is com.intellij.openapi.actionSystem.CompactActionGroup)
        assertEquals(
            listOf(
                "Piwi.RunTestAtCursor", "Piwi.VerifyTestAtCursor", "Piwi.RunSpec", "Piwi.RunTestsForFile", null,
                "Piwi.RecordHere", "Piwi.RecordNewFile", null, "Piwi.StopRecording", "Piwi.PauseRecording", "Piwi.ResumeRecording",
            ),
            ids("Piwi.EditorPopup"),
        )
        assertEquals(listOf("Piwi.RunSpec", "Piwi.RunTestsForFile", null, "Piwi.RecordNewFile"), ids("Piwi.ProjectViewPopup"))
        assertTrue(actions.getAction("Piwi.ProjectViewPopup") is com.intellij.openapi.actionSystem.CompactActionGroup)
        for ((menu, piwi) in listOf("EditorPopupMenu" to "Piwi.EditorPopup", "ProjectViewPopupMenu" to "Piwi.ProjectViewPopup")) {
            assertEquals(menu, listOf(piwi), ids(menu).filter { it?.startsWith("Piwi.") == true })
        }
        // Each Piwi menu shows Piwi's mark before its name.
        for (menu in listOf("Piwi.Actions", "Piwi.EditorPopup", "Piwi.ProjectViewPopup")) {
            assertNotNull(menu, actions.getAction(menu).templatePresentation.icon)
        }
        // The default keymap, which every bundled keymap descends from, binds the actions used while typing.
        val keymap = com.intellij.openapi.keymap.KeymapManager.getInstance().getKeymap(com.intellij.openapi.keymap.KeymapManager.DEFAULT_IDEA_KEYMAP)!!
        fun strokes(id: String) = keymap.getShortcuts(id).filterIsInstance<com.intellij.openapi.actionSystem.KeyboardShortcut>().map { it.firstKeyStroke }
        val record = javax.swing.KeyStroke.getKeyStroke("ctrl alt shift R")
        assertEquals(listOf(record), strokes("Piwi.RecordHere"))
        assertEquals("the same chord stops the recording", listOf(record), strokes("Piwi.StopRecording"))
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("ctrl alt shift F")), strokes("Piwi.RerunFailing"))
        // A run's controls use the debugger's shortcuts, in this keymap as in every other.
        for ((control, debugger) in listOf(
            "Piwi.PauseRun" to "Pause", "Piwi.ResumeRun" to "Resume", "Piwi.StepRun" to "StepOver",
            "Piwi.RunToCaret" to "RunToCursor", "Piwi.FinishRun" to "StepOut",
        )) {
            assertEquals(control, strokes(debugger), strokes(control))
        }
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("F9")), strokes("Piwi.ResumeRun"))
        assertEquals("Pause has no key here, as the debugger's", emptyList<javax.swing.KeyStroke>(), strokes("Piwi.PauseRun"))
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("F8")), strokes("Piwi.StepRun"))
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("alt F9")), strokes("Piwi.RunToCaret"))
        assertEquals(listOf(javax.swing.KeyStroke.getKeyStroke("shift F8")), strokes("Piwi.FinishRun"))
        for (id in PiwiStatusBarWidget.RUN_ACTIONS) assertNotNull(id, ActionManager.getInstance().getAction(id))
        // The status popup lists the run's actions as the one Piwi.RunControl group does, Tools → Piwi too.
        val runControl = ActionManager.getInstance().getAction("Piwi.RunControl") as com.intellij.openapi.actionSystem.ActionGroup
        assertEquals(PiwiStatusBarWidget.RUN_ACTIONS.toList(), runControl.getChildren(null).map { ActionManager.getInstance().getId(it) })
    }

    /**
     * Every action draws a platform icon or a glyph Piwi draws, but a toggle (its menu row shows a check mark); a stop's
     * code actions draw the same in its popups (`PiwiIcons.stopAction`), and a glyph has one meaning.
     */
    fun testEveryActionHasAnIconButToggles() {
        val actions = ActionManager.getInstance()
        val toggles = setOf("Piwi.RunHeaded", "Piwi.ToggleCoverageMarks")
        val ids = actions.getActionIdList("Piwi.").filter { actions.getAction(it) !is com.intellij.openapi.actionSystem.ActionGroup }
        val bare = ids.filter { actions.getAction(it).templatePresentation.icon == null }.toSet()
        assertEquals(toggles, bare)
        for (id in toggles) assertTrue(id, actions.getAction(id) is com.intellij.openapi.actionSystem.ToggleAction)
        val registered = mapOf(
            Glue.StopAction.PICK to "Piwi.PickAtStop", Glue.StopAction.RECORD to "Piwi.RecordAtStop",
            Glue.StopAction.ASSERT to "Piwi.AssertAtStop", Glue.StopAction.ASSERT_REGION to "Piwi.AssertRegionAtStop",
            Glue.StopAction.MOCK to "Piwi.MockAtStop",
        )
        for ((action, id) in registered) assertEquals(id, glyph(PiwiIcons.stopAction(action)), glyph(actions.getAction(id).templatePresentation.icon))
        assertSame(PiwiIcons.OPEN_IN_DASHBOARD, actions.getAction("Piwi.OpenInDashboard").templatePresentation.icon)
        assertEquals(glyph(PiwiIcons.CONNECT), glyph(actions.getAction("Piwi.Connect").templatePresentation.icon))
        // Each glyph Piwi draws is a file of the plugin, with its dark copy but the flaky and running marks, one in both themes.
        for (id in ids.filter { it !in toggles }) {
            val path = glyph(actions.getAction(id).templatePresentation.icon)
            if (!path.startsWith("icons/")) continue
            assertNotNull(id, PiwiIcons::class.java.getResource("/$path"))
            if (path in setOf("icons/testFlaky.svg", "icons/testRunning.svg")) continue
            assertNotNull(id, PiwiIcons::class.java.getResource("/${path.removeSuffix(".svg")}_dark.svg"))
        }
        // The actions that share a glyph are one concept.
        val concepts = setOf(
            setOf("Piwi.RunHoldFailures", "Piwi.HoldFailures"),
            setOf("Piwi.OpenLatestRun", "Piwi.OpenRunPage"),
            setOf("Piwi.RunTestAtCursor", "Piwi.Failure.RunTest"),
            setOf("Piwi.Failure.OpenTrace", "Piwi.OpenTraceSoFar"),
            setOf(
                "Piwi.CopyMcpConfiguration", "Piwi.CopyRunsMcpConfiguration", "Piwi.CopyRunsMcpHttpConfiguration",
                "Piwi.Failure.CopyContext",
            ),
            setOf("Piwi.RecordHere", "Piwi.RecordNewFile", "Piwi.NewRecordedTest", "Piwi.RecordAtStop", "Piwi.RecordHereGenerate", "Piwi.ResumeRecording"),
            setOf("Piwi.ShareRunLive", "Piwi.ShareWindowLive"),
            setOf("Piwi.StopSharingRun", "Piwi.StopSharingWindowLive"),
            setOf("Piwi.OpenSettings", "Piwi.NodeSettings"),
        )
        val shared = ids.filter { it !in toggles }.groupBy { glyph(actions.getAction(it).templatePresentation.icon) }
            .values.filter { it.size > 1 }.map { it.toSet() }.toSet()
        assertEquals(concepts, shared)
    }

    /** The resource an icon is loaded from, however it was asked for: `icons/region.svg`. */
    private fun glyph(icon: javax.swing.Icon?): String =
        icon.toString().substringAfterLast("path=").takeWhile { it !in ",])" }.removePrefix("/")

    /** A popup's registered action updates with what the popup is about: a run page's row is enabled for its page. */
    fun testAPopupsRegisteredActionUpdatesWithItsData() {
        val page = registeredWith("Piwi.OpenRunPage", "Open run #78") { it.add(RUN_PAGE, RunPage(78, "https://piwi.example/runs/78")) }!!
        val shown = myFixture.testAction(page)
        assertTrue(shown.isEnabled)
        assertEquals("Open run #78", shown.text)
        // With no page named and no run of this project, there is nothing to open.
        assertFalse(myFixture.testAction(ActionManager.getInstance().getAction("Piwi.OpenRunPage")).isEnabled)
    }

    fun testEveryIconTheNewUiMapsHasItsSizesAndThemes() {
        // Each classic icon the mapping names exists, and its New UI icon has its 16 px and 20 px files in both themes.
        val mapping = com.google.gson.JsonParser.parseString(
            PiwiIcons::class.java.getResource("/PiwiIconMappings.json")!!.readText(),
        ).asJsonObject["icons"].asJsonObject["expui"].asJsonObject
        assertEquals(setOf("piwi.svg", "piwi_failing.svg"), mapping.keySet())
        for ((name, classic) in mapping.entrySet()) {
            assertNotNull(classic.asString, PiwiIcons::class.java.getResource("/${classic.asString}"))
            val base = name.removeSuffix(".svg")
            for (file in listOf("$base.svg", "${base}_dark.svg", "$base@20x20.svg", "$base@20x20_dark.svg")) {
                assertNotNull(file, PiwiIcons::class.java.getResource("/icons/expui/$file"))
            }
        }
        assertSame(PiwiIcons.RUN_NODE, PiwiIcons.FAILURE_NODES["run"])
    }

    fun testEveryIconKeyOfTheFailuresTreeHasItsGlyph() {
        // The keys the editor service sends (`FailureTreeIcon`), each drawn, and none drawn that it never sends.
        val protocol = java.io.File("../../packages/editor/src/protocol.ts").readText()
        val union = Regex("export type FailureTreeIcon =([^;]+);").find(protocol)!!.groupValues[1]
        val keys = Regex("'([a-z-]+)'").findAll(union).map { it.groupValues[1] }.toSet()
        assertEquals(keys, PiwiIcons.FAILURE_NODES.keys)
        // Each grouping draws what it groups: a cluster, a person, a file, never a folder.
        assertSame(PiwiIcons.CLUSTER, PiwiIcons.FAILURE_NODES["cluster"])
        assertFalse(listOf("file", "cluster", "owner").any { PiwiIcons.FAILURE_NODES[it] == AllIcons.Nodes.Folder })
    }

    /**
     * Every registered action's text is in sentence case, as the VS Code extension's: it starts with a capital, and a
     * later word takes one only in a proper noun. Texts set while the IDE runs are not read here.
     */
    fun testEveryActionsTextIsInSentenceCase() {
        val actions = ActionManager.getInstance()
        val proper = listOf("Piwi Picker", "Claude Code", "Flake Lab", "Piwi", "Playwright", "MCP", "Cursor", "Node.js", "CI", "Rider", "I")
        for (id in actions.getActionIdList("Piwi.")) {
            val text = actions.getAction(id).templatePresentation.text ?: continue
            val sentence = text.removePrefix("Piwi: ")
            assertTrue("$id: $text", sentence.first().isUpperCase())
            val rest = proper.fold(sentence.substringAfter(' ', "")) { s, noun -> s.replace(Regex("(?<!\\w)${Regex.escape(noun)}(?!\\w)"), "") }
            val capitals = rest.split(' ').filter { word -> word.trimStart('(', '\'', '"').firstOrNull()?.isUpperCase() == true }
            assertTrue("$id: $text", capitals.isEmpty())
        }
    }

    /**
     * The Log tab shows the lines written before it opened, then each line as it is written, a failed request under its
     * method once a minute; closed, it opens again with them all.
     */
    fun testTheLogTabShowsTheServicesLogAndTheRequestsThatFailed() {
        val log = project.service<PiwiLog>()
        val manager = com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
        val window = manager.registerToolWindow(com.intellij.openapi.wm.RegisterToolWindowTask.notClosable(PiwiFailuresToolWindowFactory.ID))
        try {
            log.write("The editor service stopped (exit code 1).")
            // No other test fails `piwi/selections`, whose failures the shared log would hold back for a minute.
            val failing = java.lang.reflect.Proxy.newProxyInstance(
                PiwiLanguageServer::class.java.classLoader,
                arrayOf(PiwiLanguageServer::class.java),
            ) { _, method, _ ->
                if (method.name == "selections") {
                    CompletableFuture.failedFuture<SelectionsResult?>(
                        org.eclipse.lsp4j.jsonrpc.ResponseErrorException(org.eclipse.lsp4j.jsonrpc.messages.ResponseError(-32603, "the index is gone", null)),
                    )
                } else {
                    null
                }
            } as PiwiLanguageServer
            val logged = PiwiLog.logged(project, failing)
            val before = log.lines().size
            assertNull(logged.selections(SelectionsParams(null)).orNull())
            assertNull(logged.selections(SelectionsParams(null)).orNull())
            assertEquals(listOf(true), log.lines().drop(before).map { it.endsWith("piwi/selections failed: the index is gone") })

            log.show()
            val tab = window.contentManager.selectedContent!!
            assertEquals(Glue.LOG_TAB, tab.displayName)
            assertTrue(tab.isCloseable)
            val console = tab.component as com.intellij.execution.impl.ConsoleViewImpl
            fun shown(): String {
                console.flushDeferredText()
                return console.editor!!.document.text
            }
            assertTrue(shown(), shown().contains("The editor service stopped (exit code 1)."))
            log.write("Restarting the editor service.")
            assertTrue(shown(), shown().contains("Restarting the editor service."))
            window.contentManager.removeContent(tab, true)
            assertNull(window.contentManager.findContent(Glue.LOG_TAB))
            log.write("Starting the editor service.")
            log.show()
            val again = window.contentManager.findContent(Glue.LOG_TAB).component as com.intellij.execution.impl.ConsoleViewImpl
            again.flushDeferredText()
            val text = again.editor!!.document.text
            assertTrue(text, text.contains("piwi/selections failed") && text.contains("Restarting") && text.contains("Starting the editor service."))
        } finally {
            manager.unregisterToolWindow(PiwiFailuresToolWindowFactory.ID)
        }
    }

    /** What the service's process writes to stderr reaches the log, a stack's frames under the line they continue. */
    fun testTheServicesStderrIsLoggedUntilItsProcessEnds() {
        val log = project.service<PiwiLog>()
        val before = log.lines().size
        val process = com.intellij.execution.process.OSProcessHandler(
            com.intellij.execution.configurations.GeneralCommandLine(
                "node", "-e", "process.stdout.write('{}'); process.stderr.write('Piwi: boom\\n    at main (server.js:1:1)\\n')",
            ),
        )
        log.watch(process)
        process.startNotify()
        assertTrue(process.waitFor(10_000))
        val written = log.lines().drop(before)
        assertEquals(2, written.size)
        assertTrue(written[0], Regex("""\d\d:\d\d:\d\d\.\d{3} Piwi: boom""").matches(written[0]))
        assertEquals("                 at main (server.js:1:1)", written[1])
    }

    /**
     * The tool window says the service stopped only once its latest process ended, and drops what it answered: a
     * process that ends after another started says nothing of the running one.
     */
    fun testOnlyTheLatestProcessEndingSaysTheServiceStopped() {
        val service = project.service<PiwiProjectService>()
        fun waiting() = com.intellij.execution.process.OSProcessHandler(
            com.intellij.execution.configurations.GeneralCommandLine("node", "-e", "setTimeout(() => {}, 60000)"),
        ).also { it.startNotify() }
        fun waitUntil(condition: () -> Boolean) {
            val deadline = System.currentTimeMillis() + 10_000
            while (!condition()) {
                assertTrue("timed out", System.currentTimeMillis() < deadline)
                Thread.sleep(20)
            }
        }
        val first = waiting()
        val second = waiting()
        try {
            service.watchServer(first)
            service.watchServer(second)
            service.statusChanged(StatusResult(emptyList()))
            first.destroyProcess()
            assertTrue(first.waitFor(10_000))
            assertFalse(service.serviceStopped)
            assertNotNull(service.status)
            second.destroyProcess()
            assertTrue(second.waitFor(10_000))
            waitUntil { service.serviceStopped }
            assertNull(service.status)
            assertEquals(
                Glue.EmptyText(Glue.SERVICE_STOPPED, Glue.SERVICE_FIXES),
                Glue.serviceDownText(service.trusted(), service.startProblem, service.serviceStopped),
            )
        } finally {
            first.destroyProcess()
            second.destroyProcess()
        }
    }

    /** The service's process gets the IDE's HTTP proxy, as the variables the service reads; nothing when the IDE reaches the instance directly. */
    fun testTheEditorsPiwiSubmenuShowsNothingAtRestOnAFileOfNoTests() {
        myFixture.configureByText("notes.md", "# Notes")
        val actions = ActionManager.getInstance()
        val popup = actions.getAction("Piwi.EditorPopup") as com.intellij.openapi.actionSystem.ActionGroup
        val context = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.EDITOR, myFixture.editor)
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE, myFixture.file.virtualFile)
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.PSI_FILE, myFixture.file)
            .build()
        // Each entry as the editor's context menu updates it, no run, no recording and no instance: none shows, so the
        // compact submenu, which hides when empty, is not drawn.
        val shown = popup.getChildren(null).filter { it !is com.intellij.openapi.actionSystem.Separator }.filter { action ->
            val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext("EditorPopup", null, context)
            action.update(event)
            event.presentation.isEnabledAndVisible
        }
        assertEquals(emptyList<String>(), shown.map { actions.getId(it) })
    }

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
            assertEquals(EditorCredentials("https://a.example", "pd_a", "Shop", baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            service.settings().serverUrl = "https://b.example"
            assertEquals(null, service.credentials().apiKey)
            service.saveCredentials("https://b.example", "Shop", "pd_b")
            service.settings().serverUrl = "https://a.example"
            assertEquals("pd_a", service.credentials().apiKey)
            service.disconnect()
            assertEquals(EditorCredentials(null, null, null, baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            // A project only, no address and no key.
            service.saveCredentials("", "Shop", "pd_ignored")
            assertEquals(EditorCredentials(null, null, "Shop", baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            // The desktop app, chosen on this machine: what is saved for the instance stays.
            service.useDesktop("Mugs")
            assertEquals(EditorCredentials(null, null, "Shop", desktop = true, desktopProject = "Mugs", baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            service.useInstance()
            assertEquals(EditorCredentials(null, null, "Shop", desktopProject = "Mugs", baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            service.useDesktop(null)
            service.disconnect()
            assertEquals(EditorCredentials(null, null, null, baselines = emptyMap(), failureSeverity = "error", mcpAuthorization = "key", statusBarAlert = "new"), service.credentials())
            assertFalse(service.hasApiKey("https://a.example"))
            assertTrue(service.hasApiKey("https://b.example"))
            // The agent signing in to Piwi's MCP server through the instance, chosen on this machine.
            service.local().mcpAuthorization = "sign-in"
            assertEquals("sign-in", service.credentials().mcpAuthorization)
        } finally {
            service.local().mcpAuthorization = "key"
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

    /** Connect's choice beside the desktop app: one radio button per connection, one of them selected at a time. */
    fun testConnectOffersTheConnectionsAsOneGroupOfRadioButtons() {
        val choices = listOf(
            Glue.ConnectChoice(Glue.ConnectTarget.DESKTOP, "The Piwi desktop app", "Runs on this machine.", "http://127.0.0.1:7495", true),
            Glue.ConnectChoice(Glue.ConnectTarget.INSTANCE, "https://a.example", "From the settings.", "https://a.example", false),
            Glue.ConnectChoice(Glue.ConnectTarget.OTHER, "Another instance…", "A Piwi server, by its address.", null, false),
        )
        val dialog = PiwiConnectFlow.ChooseConnectionDialog(project, choices)
        try {
            assertEquals(listOf("The Piwi desktop app (in use)", "https://a.example", "Another instance…"), dialog.buttons.map { it.text })
            assertEquals(Glue.ConnectTarget.INSTANCE, dialog.picked()?.target)
            dialog.buttons[2].isSelected = true
            assertEquals(listOf(false, false, true), dialog.buttons.map { it.isSelected })
            assertEquals(Glue.ConnectTarget.OTHER, dialog.picked()?.target)
        } finally {
            Disposer.dispose(dialog.disposable)
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

    /** New offers a recorded Playwright test on a folder of a Playwright config, and on no other folder. */
    fun testNewOffersARecordedTestOnAPlaywrightConfigsFoldersAlone() {
        val actions = ActionManager.getInstance()
        val newGroup = actions.getAction("NewGroup") as com.intellij.openapi.actionSystem.DefaultActionGroup
        val listed = newGroup.childActionsOrStubs.mapNotNull { actions.getId(it) }.filter { it.startsWith("Piwi.") }
        assertEquals(listOf("Piwi.NewRecordedTest"), listed)
        // Tools → Piwi records a new test file under its own name, once.
        val record = (actions.getAction("Piwi.Record") as com.intellij.openapi.actionSystem.DefaultActionGroup)
            .childActionsOrStubs.mapNotNull { actions.getId(it) }
        assertTrue(record.toString(), "Piwi.RecordNewFile" in record && "Piwi.NewRecordedTest" !in record)
        val service = project.getService(PiwiProjectService::class.java)
        val base = File(project.basePath!!)
        val config = File(base, "e2e/playwright.config.ts").apply { parentFile.mkdirs() }
        val nested = File(base, "e2e/tests/cart").apply { mkdirs() }
        val helper = File(nested, "helper.ts").apply { writeText("export {};\n") }
        val modules = File(base, "e2e/node_modules/pkg").apply { mkdirs() }
        val other = File(base, "src").apply { mkdirs() }
        try {
            config.writeText("export default {};\n")
            service.searchPlaywright()
            val action = actions.getAction("Piwi.NewRecordedTest")
            fun shownOn(folder: File): Boolean {
                val file = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByIoFile(folder)!!
                val context = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                    .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                    .add(com.intellij.openapi.actionSystem.CommonDataKeys.VIRTUAL_FILE, file)
                    .build()
                val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext("NewGroup", null, context)
                action.update(event)
                return event.presentation.isEnabledAndVisible
            }
            assertTrue(shownOn(config.parentFile))
            assertTrue(shownOn(nested))
            // A file in such a folder, as the project view selects it, offers it in its folder.
            assertTrue(shownOn(helper))
            assertFalse(shownOn(modules))
            assertFalse(shownOn(other))
            assertFalse(shownOn(base))
        } finally {
            config.delete()
            config.parentFile.deleteRecursively()
            other.delete()
            com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshIoFiles(listOf(config.parentFile, other))
            service.searchPlaywright()
        }
    }

    /** A message that the service did not answer is a warning, a problem, with Restart and the log, whatever its caller said. */
    fun testAServiceThatDidNotAnswerIsSaidAsAProblemWithItsFixes() {
        val shown = mutableListOf<com.intellij.notification.Notification>()
        project.messageBus.connect(testRootDisposable).subscribe(
            com.intellij.notification.Notifications.TOPIC,
            object : com.intellij.notification.Notifications {
                override fun notify(notification: com.intellij.notification.Notification) {
                    shown += notification
                }
            },
        )
        PiwiCommands.notify(project, "The recording did not start. ${Glue.SERVICE_NO_ANSWER}")
        PiwiCommands.notify(project, "The run took it.")
        com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val (unanswered, answered) = shown
        assertEquals(com.intellij.notification.NotificationType.WARNING, unanswered.type)
        assertEquals(PiwiNotice.PROBLEM.group, unanswered.groupId)
        assertEquals(Glue.SERVICE_FIXES.map { it.label }, unanswered.actions.map { it.templateText })
        assertEquals(com.intellij.notification.NotificationType.INFORMATION, answered.type)
        assertEquals(emptyList<String>(), answered.actions.map { it.templateText })
    }

    /**
     * The first project holding a Playwright config while nothing connects it says what Piwi does, with Connect, the
     * failures and the documentation, once per installation.
     */
    fun testTheFirstRunNotificationShowsOncePerInstallation() {
        val service = project.getService(PiwiProjectService::class.java)
        val properties = com.intellij.ide.util.PropertiesComponent.getInstance()
        val shown = mutableListOf<com.intellij.notification.Notification>()
        project.messageBus.connect(testRootDisposable).subscribe(
            com.intellij.notification.Notifications.TOPIC,
            object : com.intellij.notification.Notifications {
                override fun notify(notification: com.intellij.notification.Notification) {
                    if (notification.content == Glue.FIRST_RUN) shown += notification
                }
            },
        )
        val config = File(project.basePath!!, "playwright.config.ts")
        val before = properties.getBoolean(PiwiProjectService.FIRST_RUN_SHOWN)
        try {
            properties.unsetValue(PiwiProjectService.FIRST_RUN_SHOWN)
            config.writeText("export default {};\n")
            val found = service.searchPlaywright()
            service.offerFirstRun(found, listOf("https://piwi.example.com"))
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals("a project naming an instance is connected", emptyList<Any>(), shown)
            assertFalse(properties.getBoolean(PiwiProjectService.FIRST_RUN_SHOWN))
            service.offerFirstRun(found, emptyList())
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(listOf("Connect…", "Open the failures", "Learn more"), shown.single().actions.map { it.templateText })
            // Each kind has its group, the requests' sticky, a confirmation fading on its own.
            val groups = com.intellij.notification.NotificationGroupManager.getInstance()
            assertEquals(
                PiwiNotice.entries.map { it.group to (if (it == PiwiNotice.REQUEST) "STICKY_BALLOON" else "BALLOON") },
                PiwiNotice.entries.map { it.group to groups.getNotificationGroup(it.group)!!.displayType.name },
            )
            // A warning keeps the platform's icon.
            assertNull(PiwiNotifier.create(PiwiNotice.PROBLEM, "x", com.intellij.notification.NotificationType.WARNING).icon)
            // An offer: titled Piwi, with its icon, in the suggestions' group.
            val offer = shown.single()
            assertEquals(PiwiNotice.OFFER.group to "Piwi", offer.groupId to offer.title)
            assertNotNull(offer.icon)
            assertTrue(offer.isSuggestionType)
            assertTrue(properties.getBoolean(PiwiProjectService.FIRST_RUN_SHOWN))
            service.offerFirstRun(found, emptyList())
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals("once per installation", 1, shown.size)
        } finally {
            config.delete()
            service.searchPlaywright()
            properties.setValue(PiwiProjectService.FIRST_RUN_SHOWN, before)
        }
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

    /**
     * The actions that read the instance are enabled only while a context is connected; Open in dashboard also on the
     * page of what the tool window has selected, and Re-run the failing tests while failures are listed.
     */
    fun testTheActionsThatReadTheInstanceWaitForAConnection() {
        val actions = ActionManager.getInstance()
        fun enabled(id: String, url: String? = null): Boolean {
            val context = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
                .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
                .apply { if (url != null) add(DASHBOARD_URL, url) }
                .build()
            val event = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext("test", null, context)
            actions.getAction(id).update(event)
            return event.presentation.isEnabled
        }
        val service = project.service<PiwiProjectService>()
        service.statusChanged(StatusResult(listOf(ContextStatus(root = "/w", connected = false))))
        service.failuresChanged(FailuresResult(items = emptyList()))
        for (id in listOf("Piwi.OpenInDashboard", "Piwi.RerunFailing", "Piwi.RunSelection")) assertFalse(id, enabled(id))
        assertTrue("a selected failure's page", enabled("Piwi.OpenInDashboard", "https://piwi.example.com/test-run-cases/9"))
        // Failures listed from a run read before the instance stopped answering re-run all the same.
        val pays = WorkspaceFailure(uri = "file:///w/a.spec.ts", title = "pays", executionId = 9)
        service.failuresChanged(FailuresResult(items = listOf(pays), failing = 1))
        assertTrue(enabled("Piwi.RerunFailing"))
        // A list of failures fixed locally alone has nothing to re-run.
        service.failuresChanged(FailuresResult(items = listOf(pays.copy(state = "fixed-locally")), failing = 0))
        assertFalse(enabled("Piwi.RerunFailing"))
        service.statusChanged(StatusResult(listOf(ContextStatus(root = "/w", connected = true))))
        for (id in listOf("Piwi.OpenInDashboard", "Piwi.RunSelection")) assertTrue(id, enabled(id))
    }

    /** Run headed is kept for every run Piwi starts in the project, on this machine, until it is turned off. */
    fun testRunHeadedIsKeptForEveryRunOfTheProject() {
        val context = com.intellij.openapi.actionSystem.impl.SimpleDataContext.builder()
            .add(com.intellij.openapi.actionSystem.CommonDataKeys.PROJECT, project)
            .build()
        fun event() = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext("test", null, context)
        val action = ActionManager.getInstance().getAction("Piwi.RunHeaded") as com.intellij.openapi.actionSystem.ToggleAction
        val local = project.service<PiwiProjectService>().local()
        assertFalse(action.isSelected(event()))
        action.setSelected(event(), true)
        assertTrue(local.runHeaded)
        assertTrue(action.isSelected(event()))
        action.setSelected(event(), false)
        assertFalse(local.runHeaded)
    }

    /** Trusting this project tells the views, which stop waiting for its trust; another project's trust tells none. */
    fun testTrustingTheProjectTellsTheViews() {
        val service = project.getService(PiwiProjectService::class.java)
        service.watchTrust()
        var told = 0
        val parent = com.intellij.openapi.util.Disposer.newDisposable()
        com.intellij.openapi.util.Disposer.register(testRootDisposable, parent)
        service.onChange(parent) { told++ }
        val trust = com.intellij.openapi.application.ApplicationManager.getApplication().messageBus
            .syncPublisher(com.intellij.ide.trustedProjects.TrustedProjectsListener.TOPIC)
        trust.onProjectTrusted(com.intellij.openapi.project.ProjectManager.getInstance().defaultProject)
        com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(0, told)
        trust.onProjectTrusted(project)
        com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(1, told)
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
                        RunStatus(root = shop.path, run = RunInfo(id = 41, status = "failed", totalTests = 3, passedTests = 1, failedTests = 2), alarm = true),
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
                    "Piwi.RefreshRun", "Piwi.PauseRecording", "Piwi.ResumeRecording", "Piwi.StopRecording", "-",
                    "Piwi.RerunFailing", "Piwi.OpenFailures", "Piwi.ShowFlakyTests", "Piwi.OpenLatestRun", "Piwi.CompareWith", "-",
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

    /** The color key of a coverage mark's gutter bar, which names its kind. */
    private fun coverageKey(highlighter: com.intellij.openapi.editor.markup.RangeHighlighter): String? =
        (highlighter.lineMarkerRenderer as? CoverageGutterMark)?.key?.externalName

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
            .filter { it.lineMarkerRenderer != null && coverageKey(it)?.startsWith("PIWI_COVERAGE_") == true }
            .map { Triple(coverageKey(it), document.getLineNumber(it.startOffset), document.getLineNumber(it.endOffset)) }
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
                .first { coverageKey(it) == "PIWI_COVERAGE_RUN" }
            val tooltip = Glue.coverageMarkTooltip(Glue.CoverageMark(Glue.CoverageKind.RUN, 0, 1, "Piwi: run by 2 tests"))
            assertEquals(tooltip, (run.lineMarkerRenderer as com.intellij.openapi.editor.markup.ActiveGutterRenderer).tooltipText)
            // Every mark carries its key, for a background the scheme sets; the lines run draw no mark in the scroll bar.
            val scheme = com.intellij.openapi.editor.colors.EditorColorsManager.getInstance().globalScheme
            assertEquals("PIWI_COVERAGE_RUN", run.textAttributesKey?.externalName)
            assertNull(run.getErrorStripeMarkColor(scheme))
            val notRun = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
                .first { coverageKey(it) == "PIWI_COVERAGE_NOT_RUN" }
            assertEquals("PIWI_COVERAGE_NOT_RUN", notRun.textAttributesKey?.externalName)
            assertNotNull(notRun.getErrorStripeMarkColor(scheme))
            assertTrue(marks.known)
            marks.shown = false
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(emptyList<Any>(), drawn())
            marks.shown = true
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(3, drawn().size)
            // A new answer: only the marks it changes are taken off or drawn, the others' highlighters kept.
            fun highlighters() = com.intellij.openapi.editor.impl.DocumentMarkupModel.forDocument(document, project, true).allHighlighters
                .filter { coverageKey(it)?.startsWith("PIWI_COVERAGE_") == true }
                .associateBy { coverageKey(it) }
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
            .count { coverageKey(it)?.startsWith("PIWI_COVERAGE_") == true }
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
    private fun sendFromPicker(body: String, bearer: String, challenge: String? = null): java.net.http.HttpResponse<String> {
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val request = java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port${PiwiSendHandler.PATH}"))
            .header("Authorization", "Bearer $bearer")
            .header("Origin", "chrome-extension://abc")
        if (challenge != null) request.header(Glue.EDITOR_CHALLENGE_HEADER, challenge)
        val future = java.net.http.HttpClient.newHttpClient().sendAsync(
            request.POST(java.net.http.HttpRequest.BodyPublishers.ofString(body)).build(),
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

    /**
     * Asks the live endpoint as Piwi Picker does, with `bearer` (none without) and a `challenge`, from `origin`, and
     * waits, pumping the event queue meanwhile.
     */
    private fun liveFromPicker(
        bearer: String?,
        challenge: String? = null,
        method: String = "GET",
        origin: String = "chrome-extension://abc",
    ): java.net.http.HttpResponse<String> {
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val request = java.net.http.HttpRequest.newBuilder(java.net.URI("http://127.0.0.1:$port${PiwiSendHandler.LIVE_PATH}"))
            .header("Origin", origin)
            .method(method, java.net.http.HttpRequest.BodyPublishers.noBody())
        if (bearer != null) request.header("Authorization", "Bearer $bearer")
        if (challenge != null) request.header(Glue.EDITOR_CHALLENGE_HEADER, challenge)
        val future = java.net.http.HttpClient.newHttpClient().sendAsync(request.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
        val deadline = System.currentTimeMillis() + 20_000
        while (!future.isDone && System.currentTimeMillis() < deadline) {
            com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            Thread.sleep(20)
        }
        return future.get(1, TimeUnit.SECONDS)
    }

    /** Piwi Picker reads, through the pairing, the hubs of the running editor services' discovery files, every IDE window's. */
    fun testPiwiPickerListsTheLiveHubsThroughThePairing() {
        // PIWI_EDITORS_DIR names another folder than the home folder's.
        if (!System.getenv("PIWI_EDITORS_DIR").isNullOrBlank()) return
        val token = PiwiSendToken.ensure()
        val home = FileUtil.createTempDirectory("piwi-home", null)
        // The folder the editor services write, readable by this user alone.
        val editors = File(home, ".piwi/editors").apply { mkdirs() }
        editors.setReadable(false, false)
        editors.setWritable(false, false)
        editors.setExecutable(false, false)
        editors.setReadable(true, true)
        editors.setWritable(true, true)
        editors.setExecutable(true, true)
        fun file(pid: Long) = File(editors, "$pid.json").apply {
            writeText(
                """{"pid":$pid,"host":"${Glue.machineName}","version":"0.60.0","client":"WebStorm",""" +
                    """"startedAt":"2026-10-25T10:00:00.000Z","roots":["/work/shop"],""" +
                    """"hub":{"url":"ws://127.0.0.1:43123/piwi/hub","token":"hub-token-0123456789"},""" +
                    """"runChannel":{"path":"/tmp/s.sock","token":"channel-token-0123456789"}}""",
            )
        }
        val pid = ProcessHandle.current().pid()
        file(pid)
        val ended = ProcessBuilder(ProcessHandle.current().info().command().orElse("java"), "-version").redirectErrorStream(true).start()
        ended.inputStream.readAllBytes()
        ended.waitFor()
        val dead = file(ended.pid())
        val saved = System.getProperty("user.home")
        System.setProperty("user.home", home.path)
        try {
            assertEquals(401, liveFromPicker(null).statusCode())
            assertEquals(401, liveFromPicker("wrong-token-wrong-token").statusCode())
            val ok = liveFromPicker(token)
            assertEquals(ok.body(), 200, ok.statusCode())
            assertEquals("chrome-extension://abc", ok.headers().firstValue("Access-Control-Allow-Origin").orElse(null))
            val hubs = com.google.gson.JsonParser.parseString(ok.body()).asJsonObject.getAsJsonArray("hubs")
            assertEquals(1, hubs.size())
            val hub = hubs[0].asJsonObject
            assertEquals(pid, hub.get("pid").asLong)
            assertEquals("ws://127.0.0.1:43123/piwi/hub", hub.get("url").asString)
            assertEquals("hub-token-0123456789", hub.get("token").asString)
            assertEquals("/work/shop", hub.getAsJsonArray("roots")[0].asString)
            assertFalse("the run channel's token is never listed", ok.body().contains("channel-token"))
            assertFalse("a killed service's file is deleted", dead.exists())
        } finally {
            System.setProperty("user.home", saved)
        }
    }

    /** Every answer to Piwi Picker's challenge proves this IDE holds the pairing's token, paired or not, for its port. */
    fun testTheEndpointProvesItHoldsTheTokenBeforePiwiPickerSendsIt() {
        val token = PiwiSendToken.ensure()
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val challenge = "ab".repeat(32)
        val proof = Glue.editorTokenProof(token, port, challenge)
        for ((bearer, method, status) in listOf(Triple(null, "GET", 401), Triple(token, "GET", 200), Triple(null, "OPTIONS", 204))) {
            val res = liveFromPicker(bearer, challenge, method)
            assertEquals("$method with ${bearer != null}", status, res.statusCode())
            assertEquals("$method with ${bearer != null}", proof, res.headers().firstValue(Glue.EDITOR_PROOF_HEADER).orElse(null))
        }
        val refused = sendFromPicker("""{"kind":"locator","text":"x"}""", "wrong-token-wrong-token", challenge)
        assertEquals(401, refused.statusCode())
        assertEquals(proof, refused.headers().firstValue(Glue.EDITOR_PROOF_HEADER).orElse(null))
        val ok = liveFromPicker(token, challenge)
        assertEquals(Glue.EDITOR_PROOF_HEADER, ok.headers().firstValue("Access-Control-Expose-Headers").orElse(null))
        assertEquals(null, liveFromPicker(token).headers().firstValue(Glue.EDITOR_PROOF_HEADER).orElse(null))
        assertEquals(null, liveFromPicker(token, "AB".repeat(32)).headers().firstValue(Glue.EDITOR_PROOF_HEADER).orElse(null))
        // A preflight names the challenge header among those it asks to send.
        val preflight = liveFromPicker(null, null, "OPTIONS")
        assertTrue(preflight.headers().firstValue("Access-Control-Allow-Headers").orElse("").contains(Glue.EDITOR_CHALLENGE_HEADER))
    }

    /**
     * The request Piwi Picker's worker sends before the pairing's token goes anywhere, Send to editor's post included:
     * a GET of the live endpoint carrying a challenge alone, from the extension's origin in Chrome and Edge, or in
     * Firefox. It is answered 401 with the proof, which the worker can read; the send endpoint takes a POST alone.
     */
    fun testPiwiPickersChallengeAloneIsAnsweredWithTheProofOnTheLiveEndpoint() {
        val token = PiwiSendToken.ensure()
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        val challenge = "0123456789abcdef".repeat(4)
        val proof = Glue.editorTokenProof(token, port, challenge)
        for (origin in listOf("chrome-extension://pakhnokpjboejcghgcmkjlpnogfjihhe", "moz-extension://4b7a2f0e-91c3-4d5e-8f6a-0123456789ab")) {
            val res = liveFromPicker(null, challenge, origin = origin)
            assertEquals(origin, 401, res.statusCode())
            assertEquals(origin, proof, res.headers().firstValue(Glue.EDITOR_PROOF_HEADER).orElse(null))
            assertEquals(origin, origin, res.headers().firstValue("Access-Control-Allow-Origin").orElse(null))
            assertEquals(origin, Glue.EDITOR_PROOF_HEADER, res.headers().firstValue("Access-Control-Expose-Headers").orElse(null))
        }
    }

    /** A page reached under another name than this machine's (DNS rebinding) gets nothing from the endpoint. */
    fun testTheEndpointAnswersNoOtherHost() {
        val token = PiwiSendToken.ensure()
        val port = org.jetbrains.ide.BuiltInServerManager.getInstance().waitForStart().port
        fun statusFor(host: String): String {
            val answer = com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread<String> {
                java.net.Socket("127.0.0.1", port).use { socket ->
                    socket.soTimeout = 10_000
                    socket.getOutputStream().write(
                        ("GET ${PiwiSendHandler.LIVE_PATH} HTTP/1.1\r\nHost: $host\r\nAuthorization: Bearer $token\r\n" +
                            "Origin: chrome-extension://abc\r\nConnection: close\r\n\r\n").toByteArray(),
                    )
                    socket.getInputStream().bufferedReader().readLine() ?: ""
                }
            }
            val deadline = System.currentTimeMillis() + 20_000
            while (!answer.isDone && System.currentTimeMillis() < deadline) {
                com.intellij.testFramework.PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
                Thread.sleep(20)
            }
            return answer.get(1, TimeUnit.SECONDS)
        }
        assertTrue(statusFor("127.0.0.1:$port"), statusFor("127.0.0.1:$port").contains(" 200 "))
        val rebound = statusFor("evil.test:$port")
        assertFalse(rebound, rebound.contains(" 200 "))
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

    /**
     * A test's result icon offers what the service lists for it, in its groups: Run and Verify ×3 as the registered
     * actions, then its evidence and its context for an agent, a separator between groups; either click opens them.
     */
    fun testATestsResultIconOffersTheServicesActionsInTheirGroups() {
        myFixture.configureByText("cart.spec.ts", "test('adds', async () => {});\n")
        val at = myFixture.editor.document.createRangeMarker(0, 0)
        fun command(title: String, id: String) = PiwiCommand(title, id, emptyList())
        val line = SummaryLine(
            0,
            "failing in run #124",
            command("Open in dashboard", "piwi.openInDashboard"),
            "failed",
            testCaseId = 1,
            actions = listOf(
                TestAction("run", "run", "Run with Piwi", command("Run with Piwi", "piwi.runTests")),
                TestAction("run", "verify", "Verify ×3 with Piwi", command("Verify ×3 with Piwi", "piwi.runTests")),
                TestAction("evidence", null, "Open the trace", command("Open the trace", "piwi.openTrace")),
                TestAction("evidence", null, "Open in dashboard", command("Open in dashboard", "piwi.openInDashboard")),
                TestAction("agent", null, "Copy context for agent", command("Copy context for agent", "piwi.copyAgentContext")),
            ),
        )
        val gutter = PiwiTestAnnotator.TestResultGutter(project, line, "file:///w/cart.spec.ts", at)
        val entries = gutter.popupMenuActions!!.getChildren(null).map {
            if (it is com.intellij.openapi.actionSystem.Separator) "—" else it.templatePresentation.text
        }
        assertEquals(
            listOf("Run with Piwi", "Verify ×3 with Piwi", "—", "Open the trace", "Open in dashboard", "—", "Copy context for agent"),
            entries,
        )
        // Run and Verify ×3 are the registered actions, their keys shown.
        val manager = ActionManager.getInstance()
        val run = gutter.popupMenuActions!!.getChildren(null).first() as com.intellij.openapi.actionSystem.AnActionWrapper
        assertEquals("Piwi.RunTestAtCursor", manager.getId(run.delegate))
        // A left click opens the same list, never the browser.
        assertTrue(gutter.isNavigateAction)
        assertNotNull(gutter.clickAction)
        assertEquals(PiwiIcons.TRACE, PiwiTestAnnotator.testActionIcon("piwi.openTrace"))
    }

    /** The service the plugin bundles, started with the descriptor's command line, answers in the protocol classes. */
    fun testTheBundledServiceAnswersThroughTheDescriptor() {
        val stub = StubInstance()
        val dir = FileUtil.createTempDirectory("piwi-jetbrains", null, true)
        try {
            writeFixture(dir)
            stub.coverageOf(git(dir, "hash-object", "src/BasketService.cs").trim())
            val logged = project.service<PiwiLog>().lines().size
            val commandLine = PiwiLspServerDescriptor(project).createCommandLine()
                .withWorkDirectory(dir)
                .withEnvironment(
                    mapOf(
                        "PIWI_DASHBOARD_URL" to stub.url,
                        "PIWI_PROJECT_NAME" to "Acme Mugs",
                        "PIWI_DESKTOP_CONFIG" to File(dir, "no-desktop.json").path,
                    ),
                )
            val started = project.service<PiwiLog>().lines().drop(logged)
            assertTrue(started.toString(), started.any { "Starting the editor service with Node.js v" in it })
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
                        initializationOptions = PiwiLspServerDescriptor(project).createInitializationOptions()
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
                        Triple(4, "✗ Failed here · not found", "piwi.openInDashboard"),
                        Triple(4, "Run this test", "piwi.runTests"),
                        Triple(4, "Screenshot", "piwi.openScreenshot"),
                        Triple(4, "Trace", "piwi.openTrace"),
                    ),
                    specLines.filter { it.status == null }.map { Triple(it.line, it.title, it.command?.command) },
                )
                // The service answers a flaky test of the catalog as flaky on its line, which the result icon draws as the flaky mark.
                val catalog = File(dir, "tests/catalog.spec.ts").toURI().toString().replace("file:/", "file:///")
                val flaky = server.fileSummary(UriParams(catalog)).get(5, TimeUnit.SECONDS)?.lines.orEmpty().single { it.status != null }
                assertEquals(2 to "flaky", flaky.line to flaky.status)
                assertSame(PiwiIcons.FLAKY, PiwiIcons.outcome(flaky.status))

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
                // A breakpoint pauses the run, headed while the project's reporter may stop at none headless: the
                // fixture installs none, so its version is unknown. The service's tests check a newer one stays headless.
                val atBreakpoint = args.copy(coverage = null, breakpoints = listOf(EditorBreakpoint(pageObject, 4)))
                val paused = server.runArgs(Glue.withRunStart(atBreakpoint, headed = false, holdFailures = "auto")).get(10, TimeUnit.SECONDS)
                assertNotNull(paused?.env?.get("PIWI_PAUSE_AT"))
                assertTrue(paused?.command.orEmpty(), paused?.args.orEmpty().contains("--headed"))
                val headed = server.runArgs(Glue.withRunStart(atBreakpoint, headed = true, holdFailures = "auto")).get(10, TimeUnit.SECONDS)
                assertTrue(headed?.command.orEmpty(), headed?.args.orEmpty().contains("--headed"))
                assertTrue(client.runStatusChanges > 0)

                runChannel(server, client, run!!, spec, pageObject)
            } finally {
                process.destroy()
            }
        } finally {
            stub.stop()
        }
    }

    /**
     * A worker of the run on the channel its command names, as the capture fixtures play it: the session the client
     * hears, and the controls, breakpoints and image request it sends, read with the Kotlin protocol classes.
     */
    private fun runChannel(server: PiwiLanguageServer, client: TestClient, run: RunCommand, spec: String, pageObject: String) {
        val channel = run.env?.get("PIWI_RUN_CHANNEL")
        assertNotNull("the run names the run channel", channel)
        val (path, token) = channel!!.substringBeforeLast('#') to channel.substringAfterLast('#')
        val ref = run.ref!!
        val socket = java.nio.channels.SocketChannel.open(java.net.UnixDomainSocketAddress.of(path))
        val heard = java.util.concurrent.CopyOnWriteArrayList<com.google.gson.JsonObject>()
        // One line of JSON a message, read and written on the channel itself: a reader thread and the test's writes.
        val reader = Thread {
            val buffer = java.nio.ByteBuffer.allocate(1 shl 16)
            val line = java.io.ByteArrayOutputStream()
            runCatching {
                while (socket.read(buffer.clear()) >= 0) {
                    buffer.flip()
                    while (buffer.hasRemaining()) {
                        val byte = buffer.get()
                        if (byte != '\n'.code.toByte()) {
                            line.write(byte.toInt())
                            continue
                        }
                        heard += com.google.gson.JsonParser.parseString(line.toString(Charsets.UTF_8)).asJsonObject
                        line.reset()
                    }
                }
            }
        }.apply { isDaemon = true; start() }
        fun send(json: String) {
            val bytes = java.nio.ByteBuffer.wrap("$json\n".toByteArray())
            while (bytes.hasRemaining()) socket.write(bytes)
        }
        fun <T> waitFor(what: String, read: () -> T?): T {
            val deadline = System.currentTimeMillis() + 10_000
            while (System.currentTimeMillis() < deadline) {
                read()?.let { return it }
                Thread.sleep(20)
            }
            throw AssertionError("timed out waiting for $what")
        }
        try {
            val cwd = com.google.gson.Gson().toJson(run.cwd)
            val takes = """["pick","record","assert","assert-region","requests","mock","locator","pick-at"]"""
            send("""{"type":"run-attach","token":"$token","ref":"$ref","cwd":$cwd,"workerIndex":0,"parallelIndex":0,"pid":1,"playwright":"1.64.1","reporter":"0.60.0","takes":$takes}""")
            send("""{"type":"test-begin","testId":"t1","title":["removes a row"],"file":"tests/checkout.spec.ts","line":4,"project":"chromium","retry":1,"cannotPause":null}""")
            send("""{"type":"stopped","stop":1,"reason":"breakpoint","title":"Click locator('.cart-row').nth(2)","place":{"file":"tests/pages/checkout.page.ts","line":5,"column":21},"locator":"locator('.cart-row').nth(2)","bar":false}""")
            val session = waitFor("the stopped session") { client.sessions.lastOrNull { it.ref == ref && it.workers?.firstOrNull()?.stop != null } }
            val worker = session.workers!!.single()
            assertEquals("stopped", worker.state)
            assertEquals(RunTest("t1", listOf("removes a row"), spec, 3, "chromium", 1, null), worker.test)
            val stop = worker.stop!!
            assertEquals(listOf("breakpoint", "Click locator('.cart-row').nth(2)", pageObject, "4", "20", "false"), listOf(stop.reason, stop.title, stop.uri, "${stop.line}", "${stop.character}", "${stop.bar}"))
            assertEquals("Stopped at a breakpoint · Click locator('.cart-row').nth(2) · attempt 2", Glue.pausedText(stop, worker.test))

            assertEquals(RunControlResult(true, "Stepping to the next call."), server.runControl(RunControlParams(ref, action = "step")).get(5, TimeUnit.SECONDS))
            waitFor("the step") { heard.firstOrNull { it["type"].asString == "control" && it["action"].asString == "step" && it["stop"].asInt == 1 } }
            val refused = server.runControl(RunControlParams(ref, 7, "resume")).get(5, TimeUnit.SECONDS)
            assertEquals(RunControlResult(false, "Worker 7 of this run is not connected to the editor."), refused)

            server.setRunBreakpoints(SetRunBreakpointsParams(ref, listOf(EditorBreakpoint(spec, 4))))
            val places = waitFor("the breakpoints") { heard.firstOrNull { it["type"].asString == "breakpoints" } }["places"].asJsonArray
            assertEquals("tests/checkout.spec.ts" to 5, places.single().asJsonObject.let { it["file"].asString to it["line"].asInt })

            val page = server.pausedPage(PausedPageParams(ref, 0))
            val request = waitFor("the image asked") { heard.firstOrNull { it["type"].asString == "request" } }
            send("""{"type":"answer","request":${request["request"].asInt},"what":"image","value":{"mime":"image/jpeg","data":"/9j/","width":1280,"height":800}}""")
            assertEquals(PausedImage("image/jpeg", "/9j/", 1280, 800), page.get(5, TimeUnit.SECONDS)?.image)
            assertEquals(listOf("pick", "record", "assert", "assert-region", "requests", "mock", "locator", "pick-at"), worker.takes)

            // Pick on the image: the point in CSS pixels of the page, the worker's answer read with the Kotlin classes.
            val picking = server.pickAt(PickAtParams(ref, since = stop.since!!, x = 640, y = 200))
            val pick = waitFor("the pick on the image") { heard.firstOrNull { it["type"].asString == "request" && it["what"].asString == "pick-at" } }
            assertEquals(listOf(1, 640, 200), listOf(pick["stop"].asInt, pick["x"].asInt, pick["y"].asInt))
            val picked = "getByRole('row', { name: /Mug/ }) went to the editor, in place of the locator on the stopped line."
            send("""{"type":"answer","request":${pick["request"].asInt},"what":"pick-at","value":{"ok":true,"message":"$picked","locator":"getByRole('row', { name: /Mug/ })"}}""")
            assertEquals(PickAtResult(true, picked, "getByRole('row', { name: /Mug/ })"), picking.get(5, TimeUnit.SECONDS))
            // At a stop the test went on from: refused, with no locator.
            val stale = server.pickAt(PickAtParams(ref, since = "2026-01-01T00:00:00.000Z", x = 640, y = 200)).get(5, TimeUnit.SECONDS)
            assertEquals(PickAtResult(false, "The test went on.", null), stale)

            // Code from a stop in the spec: the responses the test kept, one mocked and sent to write, the caret's line.
            send("""{"type":"running","stop":1}""")
            send("""{"type":"stopped","stop":2,"reason":"step","title":"Click","place":{"file":"tests/checkout.spec.ts","line":5,"column":3},"locator":null,"bar":false}""")
            fun request(what: String) = waitFor("the $what asked") { heard.lastOrNull { it["type"].asString == "request" && it["what"].asString == what } }
            fun answer(asked: com.google.gson.JsonObject, value: String) =
                send("""{"type":"answer","request":${asked["request"].asInt},"what":"${asked["what"].asString}","value":$value}""")
            val since = waitFor("the stop in the spec") { client.sessions.lastOrNull { it.ref == ref }?.workers?.firstOrNull()?.stop?.takeIf { it.reason == "step" } }.since!!
            val listing = server.stopRequests(StopRequestsParams(ref, since = since))
            answer(
                request("requests"),
                """{"ok":true,"message":"The test kept 1 response.","requests":[{"id":1,"method":"GET","url":"http://localhost:3000/api/cart","status":200,"type":"application/json","size":null,"time":840}]}""",
            )
            assertEquals(
                StopRequestsResult(true, "The test kept 1 response.", listOf(StopRequest(1, "GET", "http://localhost:3000/api/cart", 200, "application/json", null, 840.0))),
                listing.get(5, TimeUnit.SECONDS),
            )
            val mocking = server.stopAction(StopActionParams(ref, since = since, action = "mock", request = 1))
            answer(request("mock"), """{"ok":true,"message":"GET","response":{"method":"GET","url":"http://localhost:3000/api/cart","status":200,"type":"application/json","body":"{}"}}""")
            assertEquals(true, mocking.get(5, TimeUnit.SECONDS)?.ok)
            val code = waitFor("the code to write") { client.codes.firstOrNull() }
            assertEquals(listOf(ref, since, "mock", spec, "4"), listOf(code.ref, code.since, code.action, code.uri, "${code.line}"))
            assertEquals(null, code.version)
            assertEquals(listOf(EditRange(EditPosition(4, 0), EditPosition(4, 0))), code.edits?.map { it.range })
            assertTrue(code.code!!.startsWith("  await page.route('**/api/cart', (route) =>"))
            assertEquals(emptyList<String>(), code.warnings)
            // The caret on a line holding no locator: refused, the page's outline taken down.
            val caret = server.locatorAtCaret(LocatorAtCaretParams(ref, null, since, spec, 4))
            answer(request("locator"), """{"ok":true,"message":"The outline is gone.","count":null}""")
            assertEquals(LocatorAtCaretResult(false, "No locator on this line.", null, null), caret.get(5, TimeUnit.SECONDS))
            assertEquals(RunControlResult(false, "The test went on."), server.stopAction(StopActionParams(ref, since = "then", action = "assert")).get(5, TimeUnit.SECONDS))

            server.commandEnded(CommandEndedParams(ref, 0))
            waitFor("the end of the run") { client.sessions.lastOrNull { it.ref == ref }?.takeIf { it.ended } }
        } finally {
            socket.close()
            reader.join(1_000)
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
            "tests/catalog.spec.ts",
            listOf(
                "import { test } from '@playwright/test';",
                "",
                "test('filters in-stock products', async ({ page }) => {});",
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

        val sessions = java.util.concurrent.CopyOnWriteArrayList<RunSession>()

        val codes = java.util.concurrent.CopyOnWriteArrayList<StopCode>()

        @JsonNotification("piwi/runSessionChanged")
        fun runSessionChanged(session: RunSession) {
            sessions += session
        }

        @JsonNotification("piwi/stopCode")
        fun stopCode(code: StopCode) {
            codes += code
        }

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
                      "totalRuns":4,"passedRuns":3},
                     {"id":5,"title":"filters in-stock products","filePath":"tests/catalog.spec.ts","status":"flaky",
                      "totalRuns":4,"passedRuns":4,"flakyRuns":2}]}
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
