package dev.piwitests.jetbrains

import com.intellij.execution.ExecutionManager
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.process.NopProcessHandler
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPromoter
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.ex.DocumentEx
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.ex.FileEditorManagerEx
import com.intellij.openapi.fileEditor.impl.text.TextEditorProvider
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.RegisterToolWindowTask
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XBreakpointType
import com.intellij.xdebugger.breakpoints.XLineBreakpointType
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import javax.imageio.ImageIO

/**
 * A run's client side, driven by the sessions the editor service would send: the execution point and the inlay above
 * it, the controls they and the actions send, the page of a headless stop, and the breakpoints sent as they change.
 */
class PiwiRunControlTest : BasePlatformTestCase() {
    private lateinit var sessions: PiwiRunSessions
    private lateinit var remote: RunRemote
    private val controls = CopyOnWriteArrayList<RunControlParams>()
    private val breakpoints = CopyOnWriteArrayList<SetRunBreakpointsParams>()
    private val pages = CopyOnWriteArrayList<PausedPageParams>()
    private val ended = CopyOnWriteArrayList<CommandEndedParams>()
    private val started = CopyOnWriteArrayList<StopActionParams>()
    private val listed = CopyOnWriteArrayList<StopRequestsParams>()
    private val counted = CopyOnWriteArrayList<LocatorAtCaretParams>()
    private var requests = StopRequestsResult(true, "The test kept no response yet.", emptyList())
    private var count: (LocatorAtCaretParams) -> LocatorAtCaretResult = { LocatorAtCaretResult(true, "The outline is gone.", null, null) }
    private var image: PausedImage? = null
    private val picks = CopyOnWriteArrayList<PickAtParams>()
    private var picked = PickAtResult(true, "getByRole('button', { name: 'Pay now' }) went to the editor, in place of the locator on the stopped line.", "getByRole('button', { name: 'Pay now' })")
    private lateinit var base: File

    override fun setUp() {
        super.setUp()
        sessions = project.service<PiwiRunSessions>()
        remote = sessions.remote
        sessions.remote = object : RunRemote {
            override fun control(params: RunControlParams): RunControlResult {
                controls += params
                return RunControlResult(true, "Asked.")
            }

            override fun pausedPage(params: PausedPageParams): PausedPageResult {
                pages += params
                return PausedPageResult(image)
            }

            override fun pickAt(params: PickAtParams): PickAtResult {
                picks += params
                return picked
            }

            override fun setBreakpoints(params: SetRunBreakpointsParams) {
                breakpoints += params
            }

            override fun commandEnded(params: CommandEndedParams) {
                ended += params
            }

            override fun action(params: StopActionParams): RunControlResult {
                started += params
                return RunControlResult(true, "Started.")
            }

            override fun requests(params: StopRequestsParams): StopRequestsResult {
                listed += params
                return requests
            }

            override fun locatorAtCaret(params: LocatorAtCaretParams): LocatorAtCaretResult {
                counted += params
                return count(params)
            }

            override fun documentVersion(document: Document): Int = (document as DocumentEx).modificationSequence
        }
        base = File(project.basePath!!).apply { mkdirs() }
    }

    override fun tearDown() {
        try {
            // The documents edited here are left as they are on disk, for the tests after.
            val documents = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
            documents.unsavedDocuments.forEach { documents.reloadFromDisk(it) }
            sessions.sessions.keys.forEach { sessions.heard(RunSession(it, ended = true)) }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            sessions.remote = remote
            FileEditorManager.getInstance(project).openFiles.forEach { FileEditorManager.getInstance(project).closeFile(it) }
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    private fun file(path: String, text: String): VirtualFile {
        val io = File(base, path).apply {
            parentFile.mkdirs()
            writeText(text)
        }
        return LocalFileSystem.getInstance().refreshAndFindFileByIoFile(io)!!
    }

    private fun uri(file: VirtualFile) = file.toNioPath().toUri().toString()

    private fun test(retry: Int = 0) = RunTest("t1", listOf("pays"), null, 2, "chromium", retry, null)

    private fun stopped(ref: String, file: VirtualFile, line: Int, bar: Boolean, since: String) = RunSession(
        ref,
        base.path,
        listOf(
            RunWorker(
                0,
                0,
                "stopped",
                test(retry = 1),
                RunStop("pause", "Click getByRole('button', { name: 'Pay now' })", uri(file), line, 4, null, bar, since),
            ),
        ),
    )

    private fun running(ref: String) = RunSession(ref, base.path, listOf(RunWorker(0, 0, "running", test(retry = 1))))

    private val takes = listOf("pick", "record", "assert", "assert-region", "requests", "mock", "locator")

    /** A worker of `ref` stopped at `line` of `file` for `reason`, its reporter taking every code action. */
    private fun taking(ref: String, file: VirtualFile, line: Int, since: String, reason: String = "breakpoint", title: String = "Fill \"MORNING10\" getByLabel('Coupon code')") =
        RunSession(
            ref,
            base.path,
            listOf(RunWorker(0, 0, "stopped", test(retry = 1), RunStop(reason, title, uri(file), line, 4, null, true, since), takes = takes)),
        )

    private val coupon = listOf(
        "import { test } from '@playwright/test';",
        "",
        "test('applies a coupon', async ({ page }) => {",
        "  await page.goto('/cart');",
        "  await page.getByLabel('Coupon code').fill('MORNING10');",
        "  await page.getByRole('button', { name: 'Apply' }).click();",
        "});",
        "",
    ).joinToString("\n")

    private fun hear(session: RunSession) {
        sessions.heard(session)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
    }

    private fun <T> waitFor(what: String, read: () -> T?): T {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            read()?.let { return it }
            Thread.sleep(20)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private val page = listOf(
        "export class CheckoutPage {",
        "  constructor(private readonly page: Page) {}",
        "  async pay() {",
        "    await this.page.getByRole('button', { name: 'Pay now' }).click();",
        "  }",
        "}",
        "",
    ).joinToString("\n")

    /**
     * A stop opens its file at its line, marked with the execution point and an inlay above it saying what is about to
     * run; the inlay's links, the gutter and the actions answer it; all of it goes once the test goes on.
     */
    fun testAStopIsTheExecutionPointWithItsControlsAboveIt() {
        val file = file("tests/pages/checkout.page.ts", page)
        hear(stopped("ed-1", file, 3, bar = true, since = "2026-10-25T10:00:00.000Z"))
        val editor = FileEditorManager.getInstance(project).selectedTextEditor!!
        assertEquals(file, editor.virtualFile)
        assertEquals(3, editor.caretModel.logicalPosition.line)
        val shown = sessions.shown()
        val highlighter = shown.highlighters.single()
        assertEquals(3, editor.document.getLineNumber(highlighter.startOffset))
        assertEquals(PiwiRunSessions.EXECUTION_POINT, highlighter.textAttributesKey)
        assertTrue(highlighter.gutterIconRenderer!!.tooltipText!!.contains("Paused · Click"))
        val inlay = shown.inlays.single()
        assertEquals(Inlay.Placement.ABOVE_LINE, inlay.placement)
        assertEquals(3, editor.document.getLineNumber(inlay.offset))
        val renderer = inlay.renderer as StopInlay
        assertEquals("Paused · Click getByRole('button', { name: 'Pay now' }) · attempt 2", renderer.text)
        // What is about to run, at the line's indentation, then the controls' links.
        val start = editor.offsetToXY(editor.document.getLineStartOffset(3) + 4).x
        assertNull(renderer.controlAt(inlay, start + 1))
        assertEquals(Glue.StopControl.FINISH, renderer.controlAt(inlay, renderer.calcWidthInPixels(inlay) - 1))

        myFixture.openFileInEditor(file)
        val actions = ActionManager.getInstance()
        assertFalse("Pause waits for a running test", myFixture.testAction(actions.getAction("Piwi.PauseRun")).isEnabled)
        assertTrue(myFixture.testAction(actions.getAction("Piwi.StepRun")).isEnabled)
        waitFor("the step") { controls.firstOrNull() }
        // A control names the stop it answers.
        val since = "2026-10-25T10:00:00.000Z"
        assertEquals(RunControlParams("ed-1", 0, "step", since = since), controls.single())
        myFixture.editor.caretModel.moveToOffset(myFixture.editor.document.getLineStartOffset(4))
        assertTrue(myFixture.testAction(actions.getAction("Piwi.RunToCaret")).isEnabled)
        waitFor("the run to the caret") { controls.getOrNull(1) }
        assertEquals(RunControlParams("ed-1", 0, "run-to", EditorBreakpoint(uri(file), 4), since), controls[1])

        val statusBar = PiwiStatusBarWidget(project)
        com.intellij.openapi.util.Disposer.register(testRootDisposable, statusBar)
        statusBar.update()
        assertEquals("Piwi: paused · checkout.page.ts:4", (statusBar.component as javax.swing.JLabel).text)
        val manager = ActionManager.getInstance()
        val entries = statusBar.actions().getChildren(null).mapNotNull { manager.getId(it) }
        assertEquals(PiwiStatusBarWidget.RUN_ACTIONS.toList(), entries.take(PiwiStatusBarWidget.RUN_ACTIONS.size))

        hear(running("ed-1"))
        assertEquals(PiwiRunSessions.Shown(emptyList(), emptyList(), null, null), sessions.shown())
        assertTrue(myFixture.testAction(actions.getAction("Piwi.PauseRun")).isEnabled)
        waitFor("the pause") { controls.getOrNull(2) }
        assertEquals(RunControlParams("ed-1", action = "pause"), controls[2])
        assertFalse(myFixture.testAction(actions.getAction("Piwi.ResumeRun")).isEnabled)
    }

    /**
     * Two lines written above a stop: its mark follows the line, an editor opened later draws it there too, a control at
     * the caret finds it there, and Run to Caret runs to the caret's line as the run's code has it.
     */
    fun testAStopFollowsTheEditsAboveItAndRunToCaretMapsTheCaretBack() {
        val file = file("tests/pages/checkout.page.ts", page)
        hear(stopped("ed-4", file, 3, bar = true, since = "2026-10-25T10:00:04.000Z"))
        val document = FileEditorManager.getInstance(project).selectedTextEditor!!.document
        WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// one\n// two\n") }
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(5, sessions.stops().single().stop.line)
        assertEquals(5, document.getLineNumber(sessions.shown().highlighters.single().startOffset))
        // An editor opened now, and the stop heard again as the service sends it, still at the run's line.
        val later = EditorFactory.getInstance().createEditor(document, project)
        try {
            hear(stopped("ed-4", file, 3, bar = true, since = "2026-10-25T10:00:04.000Z"))
            val inlays = sessions.shown().inlays
            assertEquals(2, inlays.size)
            assertEquals(listOf(5, 5), inlays.map { document.getLineNumber(it.offset) })
        } finally {
            EditorFactory.getInstance().releaseEditor(later)
        }
        myFixture.openFileInEditor(file)
        myFixture.editor.caretModel.moveToOffset(document.getLineStartOffset(6))
        assertTrue(myFixture.testAction(ActionManager.getInstance().getAction("Piwi.RunToCaret")).isEnabled)
        waitFor("the run to the caret") { controls.firstOrNull() }
        assertEquals(RunControlParams("ed-4", 0, "run-to", EditorBreakpoint(uri(file), 4), "2026-10-25T10:00:04.000Z"), controls.single())
        // A line written since: the running test has none, and nothing is asked.
        myFixture.editor.caretModel.moveToOffset(document.getLineStartOffset(1))
        myFixture.testAction(ActionManager.getInstance().getAction("Piwi.RunToCaret"))
        Thread.sleep(200)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(1, controls.size)
    }

    /**
     * At a stop whose reporter takes them, the inlay and the actions offer the code actions: Assert starts at the
     * caret's stop, and Mock a Request lists the responses, the latest first, and mocks the one chosen.
     */
    fun testAStopOffersTheCodeActionsItsReporterTakes() {
        val file = file("tests/coupon.spec.ts", coupon)
        val since = "2026-10-25T10:00:07.000Z"
        hear(taking("ed-7", file, 4, since))
        val inlay = sessions.shown().inlays.single()
        val renderer = inlay.renderer as StopInlay
        assertEquals(Glue.StopControl.entries + Glue.StopAction.entries, renderer.links)
        assertEquals(Glue.StopAction.MOCK, renderer.controlAt(inlay, renderer.calcWidthInPixels(inlay) - 1))
        val popup = sessions.stopActions(sessions.stops().single()).getChildren(null).mapNotNull { it.templatePresentation.text }
        assertEquals(listOf("Resume", "Step", "Run to Caret", "Finish", PiwiRunSessions.SHOW_PAUSED_PAGE) + Glue.StopAction.entries.map { it.label }, popup)

        myFixture.openFileInEditor(file)
        val actions = ActionManager.getInstance()
        assertTrue(myFixture.testAction(actions.getAction("Piwi.AssertAtStop")).isEnabled)
        assertEquals(StopActionParams("ed-7", 0, since, "assert"), waitFor("the assert") { started.firstOrNull() })

        val cart = StopRequest(1, "GET", "http://localhost:3000/api/cart", 200, "application/json", 12, 840.0)
        val pay = StopRequest(2, "POST", "http://localhost:3000/api/pay", 402, "", null, 900.0)
        requests = StopRequestsResult(true, "The test kept 2 responses.", listOf(cart, pay))
        val offered = CopyOnWriteArrayList<List<StopRequest>>()
        sessions.chooseRequest = { list, chosen ->
            offered += list
            chosen(list.last())
        }
        assertTrue(myFixture.testAction(actions.getAction("Piwi.MockAtStop")).isEnabled)
        assertEquals(StopActionParams("ed-7", 0, since, "mock", 1), waitFor("the mock") { started.getOrNull(1) })
        assertEquals(StopRequestsParams("ed-7", 0, since), listed.single())
        assertEquals(listOf(listOf(pay, cart)), offered.toList())

        // At a headless stop, Mock a Request alone.
        val headless = taking("ed-7", file, 4, "2026-10-25T10:00:07.500Z")
        hear(headless.copy(workers = headless.workers!!.map { w -> w.copy(stop = w.stop!!.copy(bar = false)) }))
        assertEquals(listOf(Glue.StopAction.MOCK), (sessions.shown().inlays.single().renderer as StopInlay).links.filterIsInstance<Glue.StopAction>())
        assertFalse(myFixture.testAction(actions.getAction("Piwi.AssertAtStop")).isEnabled)
    }

    /** A failure the IDE holds: its own icon and words, Resume alone among the controls, then the code actions. */
    fun testAFailureIsAStopOfItsOwn() {
        val file = file("tests/coupon.spec.ts", coupon)
        hear(taking("ed-8", file, 5, "2026-10-25T10:00:08.000Z", "failure", "Failed: Timed out 5000ms waiting for getByRole('button', { name: 'Apply' })"))
        val shown = sessions.shown()
        val renderer = shown.inlays.single().renderer as StopInlay
        assertEquals("Failed · Timed out 5000ms waiting for getByRole('button', { name: 'Apply' }) · attempt 2", renderer.text)
        assertEquals(listOf(Glue.StopControl.RESUME) + Glue.StopAction.entries, renderer.links)
        assertEquals(AllIcons.RunConfigurations.TestError, shown.highlighters.single().gutterIconRenderer!!.icon)
        val statusBar = PiwiStatusBarWidget(project)
        com.intellij.openapi.util.Disposer.register(testRootDisposable, statusBar)
        statusBar.update()
        assertEquals("Piwi: failed · coupon.spec.ts:6", (statusBar.component as javax.swing.JLabel).text)
    }

    /**
     * The code a stop made is written in one command: the import line and the block above the stopped statement, which
     * the mark follows; one undo takes both away. Code placed in another version of the text is not written, and a file
     * no editor shows is opened first.
     */
    fun testTheCodeAStopMadeIsWrittenInOneCommand() {
        val file = file("tests/coupon.spec.ts", coupon)
        val since = "2026-10-25T10:00:09.000Z"
        hear(taking("ed-9", file, 4, since))
        myFixture.openFileInEditor(file)
        val document = myFixture.editor.document
        val at = { line: Int, newText: String -> FileEdit(EditRange(EditPosition(line, 0), EditPosition(line, 0)), newText) }
        val block = "  await expect(page.getByTestId('total')).toHaveText('Total €72.00');"
        val code = StopCode(
            "ed-9", 0, since, "assert", uri(file), (document as DocumentEx).modificationSequence, 4, block,
            listOf(at(1, "import { expect } from '@playwright/test';\n"), at(4, "$block\n")),
            "Piwi wrote the check above coupon.spec.ts:5.", emptyList(),
        )
        sessions.write(code.copy(version = code.version!! + 1))
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(coupon, document.text)
        sessions.write(code)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        val lines = document.text.lines()
        assertEquals("import { expect } from '@playwright/test';", lines[1])
        assertEquals(block, lines[5])
        assertEquals("  await page.getByLabel('Coupon code').fill('MORNING10');", lines[6])
        assertEquals(6, sessions.stops().single().stop.line)
        UndoManager.getInstance(project).undo(TextEditorProvider.getInstance().getTextEditor(myFixture.editor))
        assertEquals(coupon, document.text)
        assertEquals(4, sessions.stops().single().stop.line)

        // No editor shows the file: it is opened, then written.
        FileDocumentManager.getInstance().saveDocument(document)
        FileEditorManagerEx.getInstanceEx(project).closeAllFiles()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        sessions.write(code.copy(version = null))
        waitFor("the code written in the file opened") { document.text.takeIf { it.contains(block) } }
        assertTrue(FileEditorManager.getInstance(project).isFileOpen(file))
    }

    /**
     * While a test is stopped, the end of the caret's line in its file says how many elements the locator there
     * matches, asked once the caret settled; a line without a locator says nothing, and the count goes with the stop.
     */
    fun testTheLocatorAtTheCaretIsCountedOnTheStoppedPage() {
        val file = file("tests/coupon.spec.ts", coupon)
        val since = "2026-10-25T10:00:10.000Z"
        count = { params ->
            when (params.line) {
                4 -> LocatorAtCaretResult(true, "2 elements match.", "getByLabel('Coupon code')", 2)
                5 -> LocatorAtCaretResult(false, "The test is stopped on page: Piwi counts a locator that starts from page.", "getByRole('button')", null)
                else -> LocatorAtCaretResult(false, "No locator on this line.", null, null)
            }
        }
        hear(taking("ed-10", file, 4, since))
        assertEquals("Piwi: 2 matches", waitFor("the count") { sessions.shown().caretCount })
        assertEquals(LocatorAtCaretParams("ed-10", 0, since, uri(file), 4), counted.first())
        val editor = FileEditorManager.getInstance(project).selectedTextEditor!!
        editor.caretModel.moveToOffset(editor.document.getLineStartOffset(3))
        waitFor("the line without a locator asked") { counted.find { it.line == 3 } }
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertNull(sessions.shown().caretCount)
        editor.caretModel.moveToOffset(editor.document.getLineStartOffset(5))
        assertEquals("Piwi: The test is stopped on page: Piwi counts a locator that starts from page.", waitFor("the refusal") { sessions.shown().caretCount })
        val asked = counted.size
        hear(running("ed-10"))
        assertNull(sessions.shown().caretCount)
        Thread.sleep(300)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(asked, counted.size)
    }

    /** While a run is live, its controls go first among the actions a keymap gives their key; without one, none do. */
    fun testTheRunControlsGoFirstAmongTheActionsOfTheirKeyWhileARunIsLive() {
        val promoter = ActionPromoter.EP_NAME.extensionList.filterIsInstance<PiwiRunActionPromoter>().single()
        val other = object : AnAction("Debug") {
            override fun actionPerformed(e: AnActionEvent) {}
        }
        val resume = ActionManager.getInstance().getAction("Piwi.ResumeRun")
        val context = SimpleDataContext.getProjectContext(project)
        assertEquals(emptyList<AnAction>(), promoter.promote(listOf(other, resume), context))
        hear(running("ed-5"))
        assertEquals(listOf(resume), promoter.promote(listOf(other, resume), context))
        assertEquals(emptyList<AnAction>(), promoter.promote(listOf(other, resume), com.intellij.openapi.actionSystem.DataContext.EMPTY_CONTEXT))
    }

    /**
     * A run in the IDE's Playwright runner is followed by its configuration: its first run, a Rerun and a Rerun Failed
     * Tests of it end with Stop and tell the service they ended.
     */
    fun testTheRunnersRunsOfAConfigurationPiwiMadeAreFollowed() {
        assertTrue(PlaywrightRunnerGate.available())
        val settings = PlaywrightRunnerLauncher.configure(project, base.path, listOf("tests/a.spec.ts:3"), mapOf("PIWI_ORIGIN_REF" to "ed-6"))!!
        sessions.followRunner(settings.configuration, "ed-6")
        val executor = DefaultRunExecutor.getRunExecutorInstance()
        val first = ExecutionEnvironmentBuilder.createOrNull(executor, settings)!!.build()
        val failedOnly = object : RunProfile {
            override fun getState(executor: com.intellij.execution.Executor, environment: com.intellij.execution.runners.ExecutionEnvironment) = null

            override fun getName() = "Rerun failed tests"

            override fun getIcon() = null
        }
        val rerunFailed = ExecutionEnvironmentBuilder(first).runProfile(failedOnly).build()
        val events = project.messageBus.syncPublisher(ExecutionManager.EXECUTION_TOPIC)
        for ((env, exit) in listOf(first to 1, rerunFailed to 0)) {
            val process = NopProcessHandler().apply { startNotify() }
            events.processStarted(executor.id, env, process)
            assertTrue(sessions.stopRun("ed-6"))
            assertTrue(process.isProcessTerminating || process.isProcessTerminated)
            events.processTerminated(executor.id, env, process, exit)
            waitFor("the end told") { ended.find { it.exitCode == exit } }
        }
        assertEquals(listOf(CommandEndedParams("ed-6", 1), CommandEndedParams("ed-6", 0)), ended.toList())
        // Another configuration's run is none of Piwi's.
        val other = PlaywrightRunnerLauncher.configure(project, base.path, listOf("tests/b.spec.ts"), emptyMap())!!
        events.processStarted(executor.id, ExecutionEnvironmentBuilder.createOrNull(executor, other)!!.build(), NopProcessHandler())
        assertFalse(sessions.stopRun("ed-6"))
    }

    /** A stop no pause bar shows has its page in the Piwi tool window's Paused Page tab, until the run ends. */
    fun testAHeadlessStopShowsItsPage() {
        val window = ToolWindowManager.getInstance(project).registerToolWindow(RegisterToolWindowTask.notClosable(PiwiFailuresToolWindowFactory.ID))
        try {
            val jpeg = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(4, 3, BufferedImage.TYPE_INT_RGB), "jpg", it) }
            image = PausedImage("image/jpeg", Base64.getEncoder().encodeToString(jpeg.toByteArray()))
            // A file the IDE has not read yet: the page shows at once, and the mark once the file is found on disk.
            val io = File(base, "tests/pages/unread.page.ts").apply {
                parentFile.mkdirs()
                writeText(page)
            }
            val unread = RunStop("pause", "Click getByRole('button', { name: 'Pay now' })", io.toPath().toUri().toString(), 3, 4, null, false, "2026-10-25T10:00:01.000Z")
            hear(RunSession("ed-2", base.path, listOf(RunWorker(0, 0, "stopped", test(retry = 1), unread))))
            val shown = waitFor("the paused page") { sessions.shown().takeIf { it.pageImage != null } }
            waitFor("the mark in the file found on disk") { sessions.shown().highlighters.singleOrNull() }
            assertEquals(PausedPageParams("ed-2", 0), pages.single())
            assertEquals("Paused · Click getByRole('button', { name: 'Pay now' }) · attempt 2 · unread.page.ts:4", shown.pageCaption)
            assertEquals(4, shown.pageImage!!.width)
            assertEquals(PiwiRunSessions.PAUSED_PAGE, window.contentManager.selectedContent?.displayName)
            hear(RunSession("ed-2", ended = true))
            assertEquals("The run ended.", sessions.shown().pageCaption)
            assertNull(sessions.shown().pageImage)
        } finally {
            ToolWindowManager.getInstance(project).unregisterToolWindow(PiwiFailuresToolWindowFactory.ID)
        }
    }

    /**
     * A click on the image of a headless stop whose worker takes `pick-at` picks the element under it: the point in CSS
     * pixels of the page's viewport, the answer under the caption; an older reporter's image offers no pick.
     */
    fun testAClickOnAHeadlessStopsImagePicksThere() {
        val window = ToolWindowManager.getInstance(project).registerToolWindow(RegisterToolWindowTask.notClosable(PiwiFailuresToolWindowFactory.ID))
        try {
            // An image taken at a device scale factor of 2: 2560 by 1600 pixels of a 1280 by 800 viewport.
            val jpeg = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(2560, 1600, BufferedImage.TYPE_INT_RGB), "jpg", it) }
            image = PausedImage("image/jpeg", Base64.getEncoder().encodeToString(jpeg.toByteArray()), 1280, 800)
            val pageObject = file("tests/pages/pick.page.ts", page)
            val since = "2026-10-27T10:00:01.000Z"
            val stop = RunStop("pause", "Click getByRole('button', { name: 'Pay now' })", uri(pageObject), 3, 4, null, false, since)
            hear(RunSession("ed-7", base.path, listOf(RunWorker(0, 0, "stopped", test(retry = 1), stop, takes = listOf("pick", "view", "input", "pick-at")))))
            val shown = waitFor("the paused page") { sessions.shown().takeIf { it.pageImage != null } }
            assertTrue(shown.pagePicks)
            assertNull(shown.pageNote)
            // A click outside the image picks nothing.
            sessions.clickPage(2600, 10)
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(emptyList<PickAtParams>(), picks)
            sessions.clickPage(1300, 400)
            val note = waitFor("the pick's answer") { sessions.shown().pageNote?.takeIf { it != "Picking the element under the click…" } }
            assertEquals(listOf(PickAtParams("ed-7", 0, since, 650, 200)), picks)
            assertEquals(picked.message, note)
            // A refusal is said the same way.
            picked = PickAtResult(false, "No element there: pick an element of the page, not its background.", null)
            sessions.clickPage(10, 10)
            assertEquals(picked.message, waitFor("the refusal") { sessions.shown().pageNote?.takeIf { it.startsWith("No element") } })
            assertEquals(PickAtParams("ed-7", 0, since, 5, 5), picks.last())
            hear(RunSession("ed-7", ended = true))
            assertFalse(sessions.shown().pagePicks)

            // A reporter that does not take `pick-at`: the image alone, no hint, a click asks nothing.
            hear(RunSession("ed-8", base.path, listOf(RunWorker(0, 0, "stopped", test(), stop.copy(since = "2026-10-27T10:00:02.000Z"), takes = listOf("pick")))))
            waitFor("the older reporter's page") { sessions.shown().takeIf { it.pageImage != null } }
            assertFalse(sessions.shown().pagePicks)
            sessions.clickPage(1300, 400)
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(2, picks.size)
            hear(RunSession("ed-8", ended = true))
        } finally {
            ToolWindowManager.getInstance(project).unregisterToolWindow(PiwiFailuresToolWindowFactory.ID)
        }
    }

    /** The IDE's breakpoints go to a live run as it starts and as they change, filtered as a run's start filters them. */
    fun testTheBreakpointsFollowTheIdesWhileTheRunGoesOn() {
        val type = TestLineBreakpointType()
        XBreakpointType.EXTENSION_POINT_NAME.point.registerExtension(type, testRootDisposable)
        val spec = file("tests/checkout.spec.ts", "test('pays', async ({ page }) => {\n  await page.goto('/');\n});\n")
        val service = project.service<PiwiProjectService>()
        service.statusChanged(StatusResult(listOf(ContextStatus(root = base.path, connected = true))))
        val manager = XDebuggerManager.getInstance(project).breakpointManager
        try {
            hear(running("ed-3"))
            assertEquals(SetRunBreakpointsParams("ed-3", emptyList()), waitFor("the breakpoints at the start") { breakpoints.firstOrNull() })
            val breakpoint = WriteAction.computeAndWait<com.intellij.xdebugger.breakpoints.XLineBreakpoint<XBreakpointProperties<*>>, Throwable> {
                manager.addLineBreakpoint(type, spec.url, 1, null)
            }
            assertEquals(
                SetRunBreakpointsParams("ed-3", listOf(EditorBreakpoint(uri(spec), 1))),
                waitFor("the breakpoint added") { breakpoints.getOrNull(1) },
            )
            // Two lines written above it: the IDE moves the breakpoint with its line (as its highlighter does outside
            // tests, `updatePosition`), the run keeps its line, and nothing is sent.
            val document = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getDocument(spec)!!
            myFixture.openFileInEditor(spec)
            WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// one\n// two\n") }
            WriteAction.runAndWait<Throwable> { (breakpoint as com.intellij.xdebugger.impl.breakpoints.XLineBreakpointImpl<*>).setLine(3) }
            Thread.sleep(300)
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(2, breakpoints.size)
            WriteAction.runAndWait<Throwable> { manager.removeBreakpoint(breakpoint) }
            assertEquals(SetRunBreakpointsParams("ed-3", emptyList()), waitFor("the breakpoint removed") { breakpoints.getOrNull(2) })
            // One set on a line of the edited file is sent as the run's line.
            val added = WriteAction.computeAndWait<com.intellij.xdebugger.breakpoints.XLineBreakpoint<XBreakpointProperties<*>>, Throwable> {
                manager.addLineBreakpoint(type, spec.url, 3, null)
            }
            assertEquals(
                SetRunBreakpointsParams("ed-3", listOf(EditorBreakpoint(uri(spec), 1))),
                waitFor("the breakpoint added in the edited file") { breakpoints.getOrNull(3) },
            )
            WriteAction.runAndWait<Throwable> { manager.removeBreakpoint(added) }
            waitFor("the second breakpoint removed") { breakpoints.getOrNull(4) }
            // A run that ended hears nothing more.
            hear(RunSession("ed-3", ended = true))
            WriteAction.runAndWait<Throwable> { manager.addLineBreakpoint(type, spec.url, 1, null) }
            Thread.sleep(300)
            assertEquals(5, breakpoints.size)
        } finally {
            WriteAction.runAndWait<Throwable> { manager.allBreakpoints.filter { it.type === type }.forEach { manager.removeBreakpoint(it) } }
            // No service runs here: a read leaves nothing of the pushed status to the next tests.
            service.refreshStatus()
            val deadline = System.currentTimeMillis() + 10_000
            while (service.status != null && System.currentTimeMillis() < deadline) Thread.sleep(20)
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        }
    }

    /** A line breakpoint any file takes, as the JavaScript debugger's takes a spec's lines. */
    private class TestLineBreakpointType : XLineBreakpointType<XBreakpointProperties<*>>("piwi-test-line", "Piwi test line") {
        override fun createBreakpointProperties(file: VirtualFile, line: Int): XBreakpointProperties<*>? = null
    }
}
