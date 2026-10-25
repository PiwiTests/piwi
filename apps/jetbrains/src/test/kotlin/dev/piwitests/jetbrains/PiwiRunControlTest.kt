package dev.piwitests.jetbrains

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.fileEditor.FileEditorManager
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
    private var image: PausedImage? = null
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

            override fun setBreakpoints(params: SetRunBreakpointsParams) {
                breakpoints += params
            }
        }
        base = File(project.basePath!!).apply { mkdirs() }
    }

    override fun tearDown() {
        try {
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
        assertTrue(highlighter.gutterIconRenderer!!.tooltipText!!.contains("⏸ Paused · Click"))
        val inlay = shown.inlays.single()
        assertEquals(Inlay.Placement.ABOVE_LINE, inlay.placement)
        assertEquals(3, editor.document.getLineNumber(inlay.offset))
        val renderer = inlay.renderer as StopInlay
        assertEquals("⏸ Paused · Click getByRole('button', { name: 'Pay now' }) · attempt 2", renderer.text)
        // What is about to run, at the line's indentation, then the controls' links.
        val start = editor.offsetToXY(editor.document.getLineStartOffset(3) + 4).x
        assertNull(renderer.controlAt(inlay, start + 1))
        assertEquals(Glue.StopControl.FINISH, renderer.controlAt(inlay, renderer.calcWidthInPixels(inlay) - 1))

        myFixture.openFileInEditor(file)
        val actions = ActionManager.getInstance()
        assertFalse("Pause waits for a running test", myFixture.testAction(actions.getAction("Piwi.PauseRun")).isEnabled)
        assertTrue(myFixture.testAction(actions.getAction("Piwi.StepRun")).isEnabled)
        waitFor("the step") { controls.firstOrNull() }
        assertEquals(RunControlParams("ed-1", 0, "step"), controls.single())
        myFixture.editor.caretModel.moveToOffset(myFixture.editor.document.getLineStartOffset(4))
        assertTrue(myFixture.testAction(actions.getAction("Piwi.RunToCaret")).isEnabled)
        waitFor("the run to the caret") { controls.getOrNull(1) }
        assertEquals(RunControlParams("ed-1", 0, "run-to", EditorBreakpoint(uri(file), 4)), controls[1])

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

    /** A stop no pause bar shows has its page in the Piwi tool window's Paused Page tab, until the run ends. */
    fun testAHeadlessStopShowsItsPage() {
        val window = ToolWindowManager.getInstance(project).registerToolWindow(RegisterToolWindowTask.notClosable(PiwiFailuresToolWindowFactory.ID))
        try {
            val jpeg = ByteArrayOutputStream().also { ImageIO.write(BufferedImage(4, 3, BufferedImage.TYPE_INT_RGB), "jpg", it) }
            image = PausedImage("image/jpeg", Base64.getEncoder().encodeToString(jpeg.toByteArray()))
            val file = file("tests/pages/checkout.page.ts", page)
            hear(stopped("ed-2", file, 3, bar = false, since = "2026-10-25T10:00:01.000Z"))
            val shown = waitFor("the paused page") { sessions.shown().takeIf { it.pageImage != null } }
            assertEquals(PausedPageParams("ed-2", 0), pages.single())
            assertEquals("⏸ Paused · Click getByRole('button', { name: 'Pay now' }) · attempt 2 · checkout.page.ts:4", shown.pageCaption)
            assertEquals(4, shown.pageImage!!.width)
            assertEquals(PiwiRunSessions.PAUSED_PAGE, window.contentManager.selectedContent?.displayName)
            hear(RunSession("ed-2", ended = true))
            assertEquals("The run ended.", sessions.shown().pageCaption)
            assertNull(sessions.shown().pageImage)
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
            WriteAction.runAndWait<Throwable> { manager.removeBreakpoint(breakpoint) }
            assertEquals(SetRunBreakpointsParams("ed-3", emptyList()), waitFor("the breakpoint removed") { breakpoints.getOrNull(2) })
            // A run that ended hears nothing more.
            hear(RunSession("ed-3", ended = true))
            WriteAction.runAndWait<Throwable> { manager.addLineBreakpoint(type, spec.url, 1, null) }
            Thread.sleep(300)
            assertEquals(3, breakpoints.size)
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
