package dev.piwitests.jetbrains

import com.intellij.DynamicBundle
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.COLUMNS_LARGE
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException
import javax.swing.JComponent
import javax.swing.JList

/** The recording a recording action acts on: the one writing into the file at hand, else the project's only one. */
private fun recordingOf(e: AnActionEvent): RecordingSession? {
    val recordings = e.project?.getServiceIfCreated(PiwiRecordings::class.java) ?: return null
    return e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { recordings.sessionFor(it) } ?: recordings.only()
}

/** The menus that show a recording action only where it applies: the editor's, and the recorded block's gutter mark's. */
private val CONTEXT_MENUS = setOf(ActionPlaces.EDITOR_POPUP, ActionPlaces.EDITOR_GUTTER_POPUP)

/** Enables an action where it applies; [CONTEXT_MENUS] show it only there. */
private fun AnActionEvent.appliesWhen(applies: Boolean) {
    presentation.isEnabled = applies
    presentation.isVisible = applies || place !in CONTEXT_MENUS
}

/** Piwi: Record Here — steps at the caret, or a new test there outside every test, function and class, from a browser the project's Playwright opens. */
open class RecordHereAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) = e.appliesWhen(canRecord(e))

    /** Whether a recording can start at the event's caret. */
    protected fun canRecord(e: AnActionEvent): Boolean {
        val project = e.project ?: return false
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return false
        return e.getData(CommonDataKeys.EDITOR) != null && PiwiRecordFlow.canRecordInto(project, file)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        PiwiRecordFlow.recordHere(project, editor, file)
    }
}

/** Piwi: Record Here… in the editor's Generate menu (Alt+Insert), shown only where a recording can start. */
class RecordHereGenerateAction : RecordHereAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = canRecord(e)
    }
}

/** Piwi: Record a New Test File… — a spec created in the folder at hand, then recorded into. */
class RecordNewFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabledAndVisible = project != null && project.service<PiwiProjectService>().hasPlaywrightConfig()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val selected = e.getData(CommonDataKeys.VIRTUAL_FILE)?.takeIf { it.isInLocalFileSystem }
        val directory = (if (selected?.isDirectory == true) selected else selected?.parent)
            ?: project.service<PiwiProjectService>().playwrightConfigDirs().firstOrNull()?.let { LocalFileSystem.getInstance().findFileByNioFile(it) }
            ?: return
        PiwiRecordFlow.recordNewFile(project, directory)
    }
}

/** Piwi: Stop Recording — the browser closes; the recorded lines stay, one Undo away. */
class StopRecordingAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.appliesWhen(recordingOf(e)?.stopping == false)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val session = recordingOf(e) ?: return
        e.project?.service<PiwiRecordings>()?.stop(session)
    }
}

/** Piwi: Pause Recording — what is done in the browser is not written until Resume. */
class PauseRecordingAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val session = recordingOf(e)
        e.appliesWhen(session != null && session.state == "recording" && !session.edited && !session.stopping)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val session = recordingOf(e) ?: return
        e.project?.service<PiwiRecordings>()?.pause(session)
    }
}

/** Piwi: Resume Recording — writes again, over the recorded lines as the browser has them. */
class ResumeRecordingAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val session = recordingOf(e)
        e.appliesWhen(session != null && (session.state == "paused" || session.edited) && !session.stopping)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val session = recordingOf(e) ?: return
        e.project?.service<PiwiRecordings>()?.resume(session)
    }
}

/**
 * Starts recordings. Record Here asks `piwi/pageCandidates` where the caret is: outside every test, function and class,
 * a new test; anywhere else, the steps there. Record a New Test File creates the spec first. Without an answer, the
 * recording does not start. Both ask for the start page and the page the steps run on, then send `piwi/record`, asking
 * for the Playwright project when it answers with several. The choices are remembered on this machine
 * (`PiwiLocalSettings`).
 */
object PiwiRecordFlow {
    private const val NOT_RUNNING = "The Piwi editor service is not running in this project yet."

    /** Whether a recording can write into `file`: a script of a project with a Playwright config, not recorded into already. */
    fun canRecordInto(project: Project, file: VirtualFile): Boolean =
        file.isInLocalFileSystem &&
            (file.extension?.lowercase() ?: "") in Glue.SCRIPT_EXTENSIONS &&
            project.service<PiwiProjectService>().hasPlaywrightConfig() &&
            project.getServiceIfCreated(PiwiRecordings::class.java)?.sessionFor(file) == null

    fun recordHere(project: Project, editor: Editor, file: VirtualFile) = start(project, editor, file, null)

    fun recordNewFile(project: Project, directory: VirtualFile) {
        val validator = object : InputValidator {
            override fun checkInput(inputString: String?): Boolean =
                Glue.specFileName(inputString.orEmpty())?.let { directory.findChild(it) == null } == true

            override fun canClose(inputString: String?): Boolean = checkInput(inputString)
        }
        val typed = Messages.showInputDialog(
            project,
            "The new spec's name, in ${directory.presentableUrl}. What you do in the browser is written into it as a test.",
            "Piwi: Record a New Test File",
            null,
            freeName(directory),
            validator,
        ) ?: return
        val name = Glue.specFileName(typed) ?: return
        val file = try {
            WriteCommandAction.writeCommandAction(project).withName("Create $name").compute<VirtualFile, IOException> {
                directory.createChildData(this, name)
            }
        } catch (e: IOException) {
            Messages.showErrorDialog(project, "Could not create $name: ${e.message}", "Piwi: Record a New Test File")
            return
        }
        val editor = FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, file, 0), true) ?: return
        start(project, editor, file, "file")
    }

    /** `recorded.spec.ts`, else `recorded-2.spec.ts`, and so on: the first name the folder does not hold. */
    private fun freeName(directory: VirtualFile): String =
        generateSequence(1) { it + 1 }.map { if (it == 1) "recorded.spec.ts" else "recorded-$it.spec.ts" }.first { directory.findChild(it) == null }

    private fun start(project: Project, editor: Editor, file: VirtualFile, fixedInto: String?) {
        val uri = runCatching { file.toNioPath().toUri().toString() }.getOrNull() ?: return
        if (!FileDocumentManager.getInstance().requestWriting(editor.document, project)) return
        if (project.getServiceIfCreated(PiwiRecordings::class.java)?.sessionFor(file) != null) {
            PiwiCommands.notify(project, "Piwi is already recording into ${file.name}.")
            return
        }
        val document = editor.document
        val offset = if (fixedInto == "file") 0 else editor.caretModel.offset
        val line = document.getLineNumber(offset)
        val character = offset - document.getLineStartOffset(line)
        background(project, "Piwi: preparing the recording") {
            val server = project.service<PiwiProjectService>().server()
            if (server == null) {
                PiwiCommands.notify(project, NOT_RUNNING, NotificationType.WARNING)
                return@background
            }
            val request = server.pageCandidates(PageCandidatesParams(uri, line, character))
            val found = request.awaitCancellably(PiwiProjectService.TIMEOUT_SECONDS * 1000)
            val context = found?.context
            if (context == null) {
                PiwiCommands.notify(project, startFailure(request), NotificationType.ERROR)
                return@background
            }
            ApplicationManager.getApplication().invokeLater({
                if (editor.isDisposed) return@invokeLater
                val into = fixedInto ?: Glue.recordInto(context)
                val local = project.service<PiwiProjectService>().local()
                val dialog = RecordDialog(project, into, context, file.name, local.recordStartUrl, found, local.recordPage)
                if (!dialog.showAndGet()) return@invokeLater
                local.recordStartUrl = dialog.startUrl().orEmpty()
                dialog.typedPage()?.let { local.recordPage = it }
                val params = RecordParams(
                    uri = uri,
                    line = line,
                    character = character,
                    into = into,
                    project = local.recordProject.ifBlank { null },
                    startUrl = dialog.startUrl(),
                    page = dialog.page(),
                    language = DynamicBundle.getLocale().toLanguageTag(),
                )
                record(project, editor, file, params)
            }, project.disposed)
        }
    }

    /**
     * Why a recording did not start when `piwi/pageCandidates` gave no answer that says where the caret is: the request
     * failed, the service did not answer in time, or its answer said nothing.
     */
    internal fun startFailure(request: CompletableFuture<*>): String {
        val reason = when {
            request.isCompletedExceptionally -> {
                val error = request.handle { _, e -> e }.getNow(null)
                val cause = if (error is CompletionException || error is ExecutionException) error.cause ?: error else error
                cause?.message?.trim()?.ifEmpty { null }?.removeSuffix(".") ?: "the request to the Piwi editor service failed"
            }
            !request.isDone -> "the Piwi editor service did not answer"
            else -> "the Piwi editor service did not say where the cursor is"
        }
        return "Piwi could not start the recording: $reason."
    }

    /**
     * Sends `piwi/record`, following the document's changes from now until its answer is applied, so the block goes on
     * the line the placement names in the text the service read; a session it starts after the wait was given up is
     * stopped. On the event thread.
     */
    private fun record(project: Project, editor: Editor, file: VirtualFile, params: RecordParams) {
        val since = DocumentChanges(editor.document, project.service<PiwiRecordings>())
        background(project, "Piwi: starting the recording") {
            var registering = false
            try {
                val server = project.service<PiwiProjectService>().server()
                if (server == null) {
                    PiwiCommands.notify(project, NOT_RUNNING, NotificationType.WARNING)
                    return@background
                }
                val answer = server.record(params)
                val result = try {
                    answer.awaitCancellably(RECORD_TIMEOUT_MILLIS)
                } finally {
                    if (!answer.isDone) stopWhenStarted(project, answer)
                }
                val sessionId = result?.sessionId
                val placement = result?.placement
                val projects = result?.projects.orEmpty()
                when {
                    result == null -> PiwiCommands.notify(project, "The Piwi editor service did not start the recording.", NotificationType.WARNING)
                    !result.ok && projects.isNotEmpty() -> ApplicationManager.getApplication().invokeLater({
                        askProject(project, projects) { chosen ->
                            project.service<PiwiProjectService>().local().recordProject = chosen
                            record(project, editor, file, params.copy(project = chosen))
                        }
                    }, project.disposed)
                    !result.ok -> PiwiCommands.notify(project, result.message?.ifBlank { null } ?: "The recording did not start.", NotificationType.WARNING)
                    sessionId == null || placement == null -> {
                        sessionId?.let { project.service<PiwiRecordings>().remote.send(it, "stop") }
                        PiwiCommands.notify(project, "The Piwi editor service did not say where to write the recording.", NotificationType.WARNING)
                    }
                    else -> {
                        registering = true
                        ApplicationManager.getApplication().invokeLater({
                            try {
                                register(project, editor, file, params.into, sessionId, placement, result.message, since)
                            } finally {
                                Disposer.dispose(since)
                            }
                        }, project.disposed)
                    }
                }
            } finally {
                if (!registering) Disposer.dispose(since)
            }
        }
    }

    /** Registers the session `piwi/record` started, unless the file has no editor left or is recorded into already. */
    private fun register(
        project: Project,
        editor: Editor,
        file: VirtualFile,
        into: String,
        sessionId: String,
        placement: RecordingPlacement,
        message: String?,
        since: DocumentChanges,
    ) {
        val recordings = project.service<PiwiRecordings>()
        val target = editor.takeUnless { it.isDisposed }
            ?: (FileEditorManager.getInstance(project).getSelectedEditor(file) as? TextEditor)?.editor
        when {
            target == null -> recordings.remote.send(sessionId, "stop")
            recordings.sessionFor(file) != null -> {
                recordings.remote.send(sessionId, "stop")
                PiwiCommands.notify(project, "Piwi is already recording into ${file.name}.")
            }
            else -> recordings.register(sessionId, target, file, into, placement, message, since)
        }
    }

    private fun stopWhenStarted(project: Project, answer: CompletableFuture<RecordResult?>) {
        answer.thenAccept { late ->
            val id = late?.sessionId
            if (late?.ok == true && id != null) project.service<PiwiRecordings>().remote.send(id, "stop")
        }
    }

    private fun askProject(project: Project, projects: List<String>, chosen: (String) -> Unit) {
        val remembered = project.service<PiwiProjectService>().local().recordProject
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(projects)
            .setTitle("Record with the options of which Playwright project?")
            .setSelectedValue(remembered.takeIf { it in projects } ?: projects.first(), true)
            .setItemChosenCallback { chosen(it) }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    private fun background(project: Project, title: String, body: (ProgressIndicator) -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) = body(indicator)
        })
    }

    /** How long `piwi/record` may take: the service first runs the project's Playwright to read the config's projects. */
    private const val RECORD_TIMEOUT_MILLIS = 90_000L
}

/**
 * What a recording asks before it starts: the page the browser opens (a path on the `baseURL`, or a URL; the last one
 * typed), and the page expression the steps run on: the candidates of the code around the caret, the default first,
 * and the last expression typed that was not among them, or any other typed in.
 */
private class RecordDialog(
    project: Project,
    into: String,
    context: String,
    fileName: String,
    startUrl: String,
    found: PageCandidatesResult?,
    remembered: String,
) : DialogWrapper(project) {
    private val where = when {
        into == "file" -> "What you do in the browser is written into $fileName, as a new test."
        into == "steps" && context == "test" -> "What you do in the browser is written at the cursor, as steps of this test."
        into == "steps" && context == "function" -> "What you do in the browser is written at the cursor, as steps of this function."
        into == "steps" -> "What you do in the browser is written at the cursor."
        else -> "What you do in the browser is written at the cursor, as a new test."
    }
    private val reasons: Map<String, String>
    private val offered: List<String>
    private val start = JBTextField(startUrl)
    private val page: ComboBox<String>

    init {
        val candidates = found?.candidates.orEmpty().mapNotNull { c -> c.expression?.trim()?.ifEmpty { null }?.let { it to c.reason.orEmpty() } }
        val default = found?.default?.trim()?.ifEmpty { null }
        offered = (listOfNotNull(default) + candidates.map { it.first }).distinct()
        val typed = remembered.trim().ifEmpty { null }?.takeIf { it !in offered }
        reasons = candidates.toMap() + listOfNotNull(typed?.let { it to "typed last time" })
        page = ComboBox((offered + listOfNotNull(typed)).toTypedArray()).apply {
            isEditable = true
            selectedItem = default ?: offered.firstOrNull()
            renderer = object : ColoredListCellRenderer<String>() {
                override fun customizeCellRenderer(list: JList<out String>, value: String?, index: Int, selected: Boolean, hasFocus: Boolean) {
                    append(value.orEmpty())
                    reasons[value]?.ifEmpty { null }?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                }
            }
        }
        title = if (into == "file") "Piwi: Record a New Test File" else "Piwi: Record Here"
        setOKButtonText("Record")
        init()
    }

    /** The start page; null for the `baseURL`. */
    fun startUrl(): String? = start.text.trim().ifEmpty { null }

    /** The page expression; null for the service's default. */
    fun page(): String? = ((page.editor.item ?: page.selectedItem) as? String)?.trim()?.ifEmpty { null }

    /** The page expression when it is not among those offered, to offer next time. */
    fun typedPage(): String? = page()?.takeIf { it !in offered }

    override fun createCenterPanel(): JComponent = panel {
        row { text(where, maxLineLength = 70) }
        row("Start page:") {
            cell(start).columns(COLUMNS_LARGE)
                .comment("A path on the baseURL of the Playwright config, or a full URL; empty opens the baseURL")
        }
        row("Steps run on:") {
            cell(page).comment("The page the recorded lines use: one offered from the code around the cursor, or any other expression")
        }
        row {
            comment("Stop in the editor or in the browser. One Undo removes the recording.")
        }
    }

    override fun getPreferredFocusedComponent(): JComponent = start
}
