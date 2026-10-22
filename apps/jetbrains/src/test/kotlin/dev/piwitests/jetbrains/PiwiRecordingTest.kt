package dev.piwitests.jetbrains

import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.impl.text.TextEditorProvider
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.EditorNotificationProvider
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException

/**
 * A recording's client side, driven by the updates the editor service would send: where the block is written, how it
 * is rewritten and followed, the imports it adds, the pause on an edit inside it, and the one undo step it leaves.
 */
class PiwiRecordingTest : BasePlatformTestCase() {
    private lateinit var recordings: PiwiRecordings
    private lateinit var remote: RecordingRemote
    private val sent = mutableListOf<String>()
    private val notes = mutableListOf<Notification>()

    override fun setUp() {
        super.setUp()
        recordings = project.service<PiwiRecordings>()
        remote = recordings.remote
        recordings.remote = RecordingRemote { id, command ->
            sent += "$command $id"
            CompletableFuture.completedFuture(true)
        }
        project.messageBus.connect(testRootDisposable).subscribe(
            Notifications.TOPIC,
            object : Notifications {
                override fun notify(notification: Notification) {
                    notes += notification
                }
            },
        )
    }

    override fun tearDown() {
        try {
            generateSequence { recordings.only() }.take(10).forEach { it.end("The test ended.", failed = true) }
            recordings.remote = remote
        } catch (e: Throwable) {
            addSuppressedException(e)
        } finally {
            super.tearDown()
        }
    }

    private fun update(
        id: String,
        code: String,
        state: String = "recording",
        importEdit: FileEdit? = null,
        warnings: List<RecordingWarning> = emptyList(),
        into: String = "steps",
        message: String? = null,
        command: PiwiCommand? = null,
    ) = RecordingUpdate(
        sessionId = id,
        uri = myFixture.file.virtualFile.url,
        into = into,
        state = state,
        code = code,
        importEdit = importEdit,
        steps = code.lines().filter { it.isNotBlank() }.mapIndexed { i, line -> RecordingStep(words = line, line = i) },
        warnings = warnings,
        message = message,
        command = command,
    )

    /** The service's edit inserting `text` at the start of `line`, placed in the file as it stands. */
    private fun insertAt(line: Int, text: String) =
        FileEdit(EditRange(EditPosition(line, 0), EditPosition(line, 0)), text)

    /** An update as the notification delivers it: applied on the event thread. */
    private fun send(update: RecordingUpdate) {
        recordings.changed(update)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
    }

    private fun register(id: String, line: Int, newLine: Boolean, indent: String, into: String = "steps"): RecordingSession =
        recordings.register(id, myFixture.editor, myFixture.file.virtualFile, into, RecordingPlacement(line, newLine, indent))

    private fun text() = myFixture.editor.document.text

    private fun undo() = UndoManager.getInstance(project).undo(TextEditorProvider.getInstance().getTextEditor(myFixture.editor))

    private fun redo() = UndoManager.getInstance(project).redo(TextEditorProvider.getInstance().getTextEditor(myFixture.editor))

    fun testAltEnterOffersARecordingAndChangesNothingItself() {
        myFixture.configureByText("intention.spec.ts", "test('t', async ({ page }) => {\n  <caret>\n});\n")
        val intention = RecordHereIntention()
        assertEquals("Piwi: Record here", intention.text)
        assertFalse(intention.startInWriteAction())
        assertTrue(com.intellij.codeInsight.intention.IntentionManager.getInstance().availableIntentions.any { it is RecordHereIntention ||
            (it as? com.intellij.codeInsight.intention.IntentionActionDelegate)?.delegate is RecordHereIntention })
        myFixture.configureByText("notes.md", "# notes\n<caret>")
        assertFalse(intention.isAvailable(project, myFixture.editor, myFixture.file))
    }

    private fun typeAt(fragment: String, typed: String) {
        myFixture.editor.caretModel.moveToOffset(text().indexOf(fragment))
        myFixture.type(typed)
    }

    fun testRegistersTheRecordingActionsBannerAnnotatorAndColor() {
        for (id in listOf("Piwi.RecordHere", "Piwi.RecordHereGenerate", "Piwi.RecordNewFile", "Piwi.StopRecording", "Piwi.PauseRecording", "Piwi.ResumeRecording")) {
            assertNotNull(id, ActionManager.getInstance().getAction(id))
        }
        val generate = ActionManager.getInstance().getAction("GenerateGroup") as com.intellij.openapi.actionSystem.DefaultActionGroup
        assertTrue("Alt+Insert offers it", generate.childActionsOrStubs.any { ActionManager.getInstance().getId(it) == "Piwi.RecordHereGenerate" })
        assertTrue(EditorNotificationProvider.EP_NAME.getExtensions(project).any { it is PiwiRecordingNotificationProvider })
        val annotators = com.intellij.lang.ExternalLanguageAnnotators.INSTANCE
        assertTrue(annotators.allForLanguage(com.intellij.lang.javascript.JavaScriptSupportLoader.TYPESCRIPT).any { it is PiwiRecordingAnnotator })
        assertTrue(PiwiColorSettingsPage().attributeDescriptors.any { it.key == PiwiRecordings.BLOCK })
    }

    /**
     * Steps written on a new line inside a test: nothing before the first update, then the block rewritten whole on
     * each one, its imports after the file's, an edit around it only moving it, and one undo after Stop.
     */
    fun testStepsGoOnANewLineAndOneUndoRemovesTheRecording() {
        val original = """
            import { test, expect } from '@playwright/test';

            test('pays', async ({ page }) => {
              await page.goto('/cart');
            });

        """.trimIndent()
        myFixture.configureByText("checkout.spec.ts", original)
        val session = register("s1", line = 4, newLine = true, indent = "  ")
        assertEquals(original, text())
        assertNotNull(PiwiRecordingNotificationProvider().collectNotificationData(project, myFixture.file.virtualFile))

        send(update("s1", "", state = "starting"))
        assertEquals(original.replace("});", "\n});"), text())
        assertEquals("Piwi: opening the browser to record into this file…", session.view.text)

        send(update("s1", "await page.getByRole('button', { name: 'Pay' }).click();"))
        assertEquals(original.replace("});", "  await page.getByRole('button', { name: 'Pay' }).click();\n});"), text())
        assertEquals("Piwi is recording what you do in the browser · 1 step", session.view.text)

        val cartPage = "import { CartPage } from './pages/cart.page';"
        send(update("s1", "const cartPage = new CartPage(page);\nawait cartPage.pay();", importEdit = insertAt(1, "$cartPage\n")))
        assertEquals(
            """
            import { test, expect } from '@playwright/test';
            import { CartPage } from './pages/cart.page';

            test('pays', async ({ page }) => {
              await page.goto('/cart');
              const cartPage = new CartPage(page);
              await cartPage.pay();
            });

            """.trimIndent(),
            text(),
        )

        // An edit around the block only moves it; the caret moving between writes changes nothing either.
        myFixture.editor.caretModel.moveToOffset(0)
        WriteCommandAction.runWriteCommandAction(project) {
            val document = myFixture.editor.document
            document.insertString(document.getLineStartOffset(3), "// checkout\n")
        }
        myFixture.editor.caretModel.moveToOffset(text().indexOf("goto"))
        assertFalse(session.edited)
        val final = """
            import { test, expect } from '@playwright/test';
            import { CartPage } from './pages/cart.page';

            // checkout
            test('pays', async ({ page }) => {
              await page.goto('/cart');
              const cartPage = new CartPage(page);
              await cartPage.pay();
              await expect(page).toHaveURL(/\/done/);
            });

        """.trimIndent()
        val code = "const cartPage = new CartPage(page);\nawait cartPage.pay();\nawait expect(page).toHaveURL(/\\/done/);"
        send(update("s1", code))
        assertEquals(final, text())

        myFixture.editor.caretModel.moveToOffset(text().length)
        recordings.stop(session)
        assertEquals(listOf("stop s1"), sent)
        assertEquals("Piwi: stopping the recording…", session.view.text)
        send(update("s1", code, state = "stopped"))
        assertNull(recordings.sessionFor(myFixture.file.virtualFile))
        assertNull(PiwiRecordingNotificationProvider().collectNotificationData(project, myFixture.file.virtualFile))
        assertEquals(final, text())
        assertEquals("Recorded 3 steps into checkout.spec.ts.", notes.last().content)

        undo()
        assertEquals(original, text())
        redo()
        assertEquals(final, text())
    }

    /** A blank caret line takes the block, and a file without imports gets them at its top. */
    fun testABlankLineTakesTheBlockAndImportsGoAtTheTop() {
        val original = "test('adds', async ({ page }) => {\n  \n});\n"
        myFixture.configureByText("cart.spec.ts", original)
        val session = register("s2", line = 1, newLine = false, indent = "  ")
        send(update("s2", "await page.goto('/');", importEdit = insertAt(0, "import { test } from '@playwright/test';\n\n")))
        assertEquals(
            "import { test } from '@playwright/test';\n\ntest('adds', async ({ page }) => {\n  await page.goto('/');\n});\n",
            text(),
        )
        recordings.stop(session)
        send(update("s2", "await page.goto('/');", state = "stopped"))
        undo()
        assertEquals(original, text())
    }

    /**
     * Typing in the block pauses the recording: nothing is written until Resume, which writes the block over the edit;
     * after Keep My Edits, the last update is not written either.
     */
    fun testTypingInTheBlockPausesUntilResumeAndKeepMyEditsKeepsTheEdits() {
        val original = "test('pays', async ({ page }) => {\n  \n});\n"
        myFixture.configureByText("pause.spec.ts", original)
        val session = register("s3", line = 1, newLine = false, indent = "  ")
        send(update("s3", "await page.goto('/cart');"))
        assertEquals("test('pays', async ({ page }) => {\n  await page.goto('/cart');\n});\n", text())

        typeAt("goto", "x")
        assertTrue(session.edited)
        assertEquals(listOf("pause s3"), sent)
        assertEquals(listOf(Glue.RecordingAction.RESUME, Glue.RecordingAction.KEEP_EDITS), session.view.actions)
        val twoSteps = "await page.goto('/cart');\nawait page.getByRole('link').click();"
        send(update("s3", twoSteps))
        assertEquals("test('pays', async ({ page }) => {\n  await page.xgoto('/cart');\n});\n", text())

        recordings.resume(session)
        assertFalse(session.edited)
        assertEquals(listOf("pause s3", "resume s3"), sent)
        send(update("s3", twoSteps))
        assertEquals("test('pays', async ({ page }) => {\n  await page.goto('/cart');\n  await page.getByRole('link').click();\n});\n", text())

        typeAt("link", "nav")
        assertEquals(listOf("pause s3", "resume s3", "pause s3"), sent)
        recordings.stop(session)
        assertEquals("stop s3", sent.last())
        send(update("s3", "$twoSteps\nawait page.close();", state = "stopped"))
        assertEquals("test('pays', async ({ page }) => {\n  await page.goto('/cart');\n  await page.getByRole('navlink').click();\n});\n", text())
        assertNull(recordings.sessionFor(myFixture.file.virtualFile))

        undo()
        assertEquals(original, text())
    }

    /**
     * Undo while recording takes the block and its start mark away: Resume writes the block again where it was, and the
     * undo step starts over, so one undo after Stop still restores the file.
     */
    fun testAnUndoWhileRecordingThenResumeStillLeavesOneUndoStep() {
        val original = "test('t', async ({ page }) => {\n  await page.goto('/');\n});\n"
        myFixture.configureByText("undo.spec.ts", original)
        val session = register("s8", line = 2, newLine = true, indent = "  ")
        send(update("s8", "await page.reload();"))
        undo()
        assertEquals(original, text())
        assertTrue(session.edited)
        recordings.resume(session)
        send(update("s8", "await page.reload();\nawait page.goBack();"))
        assertEquals("test('t', async ({ page }) => {\n  await page.goto('/');\n  await page.reload();\n  await page.goBack();\n});\n", text())
        recordings.stop(session)
        send(update("s8", "await page.reload();\nawait page.goBack();", state = "stopped"))
        undo()
        assertEquals(original, text())
    }

    /**
     * Lines inserted above the caret while `piwi/record` is pending: the block goes on the line the placement names in
     * the text the service read, followed through those changes, and through those made before the first update.
     */
    fun testTheBlockGoesWhereThePlacementSaysThroughTheEditsMadeWhileTheRequestWasPending() {
        val original = "test('pays', async ({ page }) => {\n  await page.goto('/cart');\n});\n"
        myFixture.configureByText("pending.spec.ts", original)
        val document = myFixture.editor.document
        val since = DocumentChanges(document, testRootDisposable)
        WriteCommandAction.runWriteCommandAction(project) {
            document.insertString(0, "// one\n// two\n")
            document.insertString(document.getLineStartOffset(4), "  // closing\n")
        }
        recordings.register("s11", myFixture.editor, myFixture.file.virtualFile, "steps", RecordingPlacement(2, true, "  "), since = since)
        Disposer.dispose(since)
        WriteCommandAction.runWriteCommandAction(project) { document.insertString(0, "// three\n") }
        send(update("s11", "await page.reload();"))
        assertEquals(
            "// three\n// one\n// two\ntest('pays', async ({ page }) => {\n  await page.goto('/cart');\n  // closing\n  await page.reload();\n});\n",
            text(),
        )
    }

    /**
     * Enter at the end of the block's last line is below the block: the recording goes on, the block and its tint do
     * not take the new line, and the next update leaves what is typed there.
     */
    fun testEnterAtTheEndOfTheBlockIsBelowIt() {
        myFixture.configureByText("below.spec.ts", "test('pays', async ({ page }) => {\n  \n});\n")
        val session = register("s12", line = 1, newLine = false, indent = "  ")
        send(update("s12", "await page.goto('/cart');"))
        myFixture.editor.caretModel.moveToOffset(text().indexOf("('/cart');") + "('/cart');".length)
        myFixture.type("\n")
        myFixture.type("// mine")
        assertFalse(session.edited)
        assertEquals(emptyList<String>(), sent)
        val tint = DocumentMarkupModel.forDocument(myFixture.editor.document, project, true).allHighlighters
            .single { it.textAttributesKey == PiwiRecordings.BLOCK }
        assertEquals("  await page.goto('/cart');", myFixture.editor.document.getText(tint.textRange))

        send(update("s12", "await page.goto('/cart');\nawait page.reload();"))
        assertEquals(
            listOf("test('pays', async ({ page }) => {", "await page.goto('/cart');", "await page.reload();", "// mine", "});", ""),
            text().lines().map { it.trim() },
        )
        assertFalse(session.edited)
    }

    /** Without an answer from `piwi/pageCandidates` saying where the caret is, the recording does not start, and says why. */
    fun testARecordingDoesNotStartWithoutKnowingWhereTheCaretIs() {
        assertEquals(
            "Piwi could not start the recording: Document not found.",
            PiwiRecordFlow.startFailure(CompletableFuture.failedFuture<PageCandidatesResult>(IllegalStateException("Document not found."))),
        )
        val wrapped = CompletableFuture<PageCandidatesResult>().apply { completeExceptionally(CompletionException(IllegalStateException("boom"))) }
        assertEquals("Piwi could not start the recording: boom.", PiwiRecordFlow.startFailure(wrapped))
        assertEquals("Piwi could not start the recording: the Piwi editor service did not answer.", PiwiRecordFlow.startFailure(CompletableFuture<PageCandidatesResult>()))
        assertEquals(
            "Piwi could not start the recording: the Piwi editor service did not say where the cursor is.",
            PiwiRecordFlow.startFailure(CompletableFuture.completedFuture<PageCandidatesResult?>(null)),
        )
    }

    /** An update that comes before `piwi/record`'s answer is written once the session is registered. */
    fun testAnUpdateBeforeTheSessionIsRegisteredIsWrittenThen() {
        val original = "test('a', async ({ page }) => {\n  await page.goto('/');\n});\n"
        myFixture.configureByText("early.spec.ts", original)
        send(update("s4", "await page.reload();"))
        assertEquals(original, text())
        register("s4", line = 2, newLine = true, indent = "  ")
        assertEquals("test('a', async ({ page }) => {\n  await page.goto('/');\n  await page.reload();\n});\n", text())

        // Closing the file stops its recording.
        FileEditorManager.getInstance(project).closeFile(myFixture.file.virtualFile)
        assertEquals(listOf("stop s4"), sent)
        send(update("s4", "await page.reload();", state = "stopped"))
        assertNull(recordings.sessionFor(myFixture.file.virtualFile))
    }

    /** A new file is written whole, with its imports, followed by a line break. */
    fun testANewFileIsWrittenWholeEndingWithALineBreak() {
        myFixture.configureByText("new.spec.ts", "")
        register("s5", line = 0, newLine = false, indent = "", into = "file")
        val code = "import { test } from '@playwright/test';\nimport { CartPage } from './pages/cart.page';\n\n" +
            "test('recorded', async ({ page }) => {\n  await new CartPage(page).open();\n});"
        send(update("s5", code, into = "file"))
        assertEquals("$code\n", text())
        send(update("s5", code, state = "stopped", into = "file"))
        undo()
        assertEquals("", text())
    }

    /** Warnings show on their lines, as weak warnings with their message, and stay after Stop until their line changes. */
    fun testWarningsShowOnTheirLinesAndStayAfterStopUntilTheLineChanges() {
        myFixture.configureByText("warned.spec.ts", "test('t', async ({ page }) => {\n  \n});\n")
        val session = register("s6", line = 1, newLine = false, indent = "  ")
        val brittle = "This locator depends on the order of the rows."
        val code = "await page.goto('/');\nawait page.locator('.row').nth(2).click();"
        send(update("s6", code, warnings = listOf(RecordingWarning(step = 1, line = 1, message = brittle))))
        val document = myFixture.editor.document
        val shown = recordings.warnings(document).single()
        assertEquals("await page.locator('.row').nth(2).click();" to brittle, document.getText(shown.first) to shown.second)
        assertTrue(myFixture.doHighlighting(HighlightSeverity.WEAK_WARNING).any { it.description == "Piwi: $brittle" })

        recordings.stop(session)
        send(update("s6", code, state = "stopped", warnings = listOf(RecordingWarning(step = 1, line = 1, message = brittle))))
        assertEquals("Recorded 2 steps into warned.spec.ts. 1 warning to check, on its line.", notes.last().content)
        assertEquals(1, recordings.warnings(document).size)
        typeAt("nth(2)", "x")
        assertEquals(emptyList<Pair<Any, String>>(), recordings.warnings(document))
    }

    /**
     * A recording that fails or stops before its first step leaves the file as it was, even when the service's last
     * update holds an empty test; a failure says why, with the service's command.
     */
    fun testARecordingEndedBeforeItsFirstStepWritesNothing() {
        val original = "test('t', async ({ page }) => {\n  await page.goto('/');\n});\n"
        myFixture.configureByText("failed.spec.ts", original)
        val emptyTest = "test('recorded flow', async ({ page }) => {\n});"
        register("s7", line = 3, newLine = false, indent = "", into = "test")
        val install = PiwiCommand("Install Chromium", "piwi.runCommand", listOf(mapOf("cwd" to "/w", "command" to "npx playwright install chromium")))
        send(update("s7", emptyTest, state = "failed", message = "Chromium is not installed for this project.", command = install).copy(steps = emptyList()))
        assertEquals(original, text())
        assertNull(recordings.sessionFor(myFixture.file.virtualFile))
        assertEquals("Chromium is not installed for this project.", notes.last().content)
        assertEquals(listOf("Install Chromium"), notes.last().actions.map { it.templateText })

        register("s10", line = 3, newLine = false, indent = "", into = "test")
        send(update("s10", emptyTest, state = "stopped").copy(steps = emptyList()))
        assertEquals(original, text())
        assertEquals("Nothing was recorded into failed.spec.ts.", notes.last().content)
    }

    /** Stop, Pause and Resume act on the recording of the file at hand, each while it applies. */
    fun testTheRecordingActionsActOnTheFilesRecordingWhileTheyApply() {
        myFixture.configureByText("only.spec.ts", "test('t', async ({ page }) => {\n  \n});\n")
        val opening = "Opening Chromium with the options of the admin project."
        val session = recordings.register("s9", myFixture.editor, myFixture.file.virtualFile, "steps", RecordingPlacement(1, false, "  "), opening)
        assertSame(session, recordings.only())
        assertEquals("Piwi: opening the browser to record into this file… · $opening", session.view.text)
        val actions = ActionManager.getInstance()
        assertFalse(myFixture.testAction(actions.getAction("Piwi.PauseRecording")).isEnabled)
        send(update("s9", "await page.goto('/');"))
        val statusBar = PiwiStatusBarWidget(project)
        fun statusText(): String {
            statusBar.update()
            return (statusBar.component as javax.swing.JLabel).text
        }
        assertEquals("Piwi: ● recording · 1 step", statusText())
        // The service sends nothing for a pause: the banner says so at once.
        assertTrue(myFixture.testAction(actions.getAction("Piwi.PauseRecording")).isEnabled)
        assertEquals(listOf("pause s9"), sent)
        assertEquals("Piwi: recording paused · 1 step", session.view.text)
        assertEquals("Piwi: recording paused · 1 step", statusText())
        assertFalse(myFixture.testAction(actions.getAction("Piwi.PauseRecording")).isEnabled)
        assertTrue(myFixture.testAction(actions.getAction("Piwi.ResumeRecording")).isEnabled)
        assertEquals(listOf("pause s9", "resume s9"), sent)
        assertEquals("recording", session.state)
        send(update("s9", "await page.goto('/');"))
        assertTrue(myFixture.testAction(actions.getAction("Piwi.StopRecording")).isEnabled)
        assertFalse(myFixture.testAction(actions.getAction("Piwi.StopRecording")).isEnabled)
        assertEquals(listOf("pause s9", "resume s9", "stop s9"), sent)
        send(update("s9", "await page.goto('/');", state = "stopped"))
        assertNull(recordings.only())
        assertFalse(statusText().contains("recording"))
    }
}
