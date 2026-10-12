package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.CommandProcessor
import com.intellij.openapi.command.UndoConfirmationPolicy
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.impl.FinishMarkAction
import com.intellij.openapi.command.impl.StartMarkAction
import com.intellij.openapi.command.undo.BasicUndoableAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.RangeMarker
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.impl.DocumentMarkupModel
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Condition
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.EditorNotifications
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.concurrency.AppExecutorUtil
import java.awt.event.MouseEvent
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import javax.swing.Icon

/**
 * Where a recording's commands go: `pause` and `resume` (`piwi/recordingCommand`) and `stop` (`piwi/stopRecording`),
 * sent off the event thread. The future completes with whether the service answered.
 */
fun interface RecordingRemote {
    fun send(sessionId: String, command: String): CompletableFuture<Boolean>
}

/**
 * The recording sessions writing into this project's files (`piwi/record`). The editor service sends what each
 * recorded block holds now (`piwi/recordingChanged`): the first update writes the block where
 * `RecordResult.placement` says, each later one replaces it, and range markers follow it through the edits around it.
 * Each session also tints its block, marks its warnings for [PiwiRecordingAnnotator] and feeds the banner over its
 * file ([PiwiRecordingNotificationProvider]). It all runs on the event thread, except [changed], [sessionFor], [only]
 * and [warnings].
 */
@Service(Service.Level.PROJECT)
class PiwiRecordings(private val project: Project) : Disposable {
    /** Whether the service was disposed: with its project, or with the plugin unloaded while the project stays open. */
    @Volatile private var disposed = false

    /** What ends the work queued for later: this service disposed, or its project. */
    private val gone = Condition<Any?> { disposed || project.isDisposed }

    private val sessions = ConcurrentHashMap<String, RecordingSession>()

    /** The latest update of each session not registered yet: `piwi/record`'s answer can come after its first update. */
    private val early = LinkedHashMap<String, RecordingUpdate>()

    /** The latest update of each session waiting for the event thread: an update holds the whole block, so the latest wins. */
    private val queued = ConcurrentHashMap<String, RecordingUpdate>()

    /** The warnings of ended recordings, per document, each until its line changes or the file is closed. */
    private val kept = ConcurrentHashMap<Document, List<RecordingWarningMark>>()

    private var listening = false

    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    /** Where the sessions' commands go: the editor service. */
    var remote: RecordingRemote = RecordingRemote { sessionId, command -> send(sessionId, command) }

    /** The session writing into `file`, if any. */
    fun sessionFor(file: VirtualFile): RecordingSession? = sessions.values.firstOrNull { it.file == file }

    /** The project's session when exactly one runs. */
    fun only(): RecordingSession? = sessions.values.singleOrNull()

    /** A session of the project, the one the status bar shows; null when none runs. */
    fun current(): RecordingSession? = sessions.values.firstOrNull()

    /** Called on the event thread when a session's state changes or it ends. */
    fun onChange(parent: Disposable, listener: () -> Unit) {
        listeners += listener
        Disposer.register(parent) { listeners -= listener }
    }

    internal fun viewChanged() {
        listeners.forEach { it() }
    }

    /** The warnings to show in a document, of its recording and of the ended ones, where they show now. In a read action. */
    fun warnings(document: Document): List<Pair<TextRange, String>> =
        (sessions.values.filter { it.document == document }.flatMap { it.warnings } + kept[document].orEmpty())
            .mapNotNull { mark -> mark.range(document)?.let { it to mark.message } }

    /** A `piwi/recordingChanged` notification, from any thread; applied on the event thread. */
    fun changed(update: RecordingUpdate) {
        val id = update.sessionId ?: return
        if (queued.put(id, update) != null) return
        ApplicationManager.getApplication().invokeLater({ queued.remove(id)?.let { apply(it) } }, gone)
    }

    /** Applies an update to its session, or keeps it until the session is registered. */
    fun apply(update: RecordingUpdate) {
        val id = update.sessionId ?: return
        val session = sessions[id]
        if (session != null) {
            session.apply(update)
            return
        }
        early.remove(id)
        early[id] = update
        while (early.size > MAX_EARLY) early.remove(early.keys.first())
    }

    /**
     * A session `piwi/record` started, writing into `editor`'s file from the line `placement` names: in the text the
     * service read, followed through the changes `since` holds, else in the document as it is. The banner shows
     * `message` until the first update. An update that came before it is applied now; a file closed meanwhile stops it.
     */
    fun register(
        sessionId: String,
        editor: Editor,
        file: VirtualFile,
        into: String,
        placement: RecordingPlacement,
        message: String? = null,
        since: DocumentChanges? = null,
    ): RecordingSession {
        listen()
        val start = since?.lineStart(placement.line)
        val session = RecordingSession(this, project, sessionId, editor, file, into, placement, message, start)
        sessions[sessionId] = session
        Disposer.register(this, session)
        session.refreshView()
        early.remove(sessionId)?.let { session.apply(it) }
        if (!FileEditorManager.getInstance(project).isFileOpen(file)) stop(session)
        return session
    }

    /** Pause: nothing done in the browser is recorded until Resume; shown at once, before the service's update says so. */
    fun pause(session: RecordingSession) {
        session.paused()
        remote.send(session.id, "pause")
    }

    /** Resume: the service sends the block again, which is written over the developer's edits. */
    fun resume(session: RecordingSession) {
        session.resumed()
        remote.send(session.id, "resume")
    }

    /**
     * Stop: the service closes the browser and sends the last update, which ends the session. Once the developer changed
     * the recorded lines, nothing more is written: their edits stay. Without an answer, the session ends here.
     */
    fun stop(session: RecordingSession) {
        if (!session.stopRequested()) return
        remote.send(session.id, "stop").whenComplete { answered, _ ->
            val delay = if (answered == true) STOP_TIMEOUT_SECONDS else 0L
            val reason = if (answered == true) null else "The Piwi editor service did not answer: the recording ended here."
            val end = Runnable {
                ApplicationManager.getApplication().invokeLater({ session.end(reason, failed = reason != null) }, gone)
            }
            AppExecutorUtil.getAppScheduledExecutorService().schedule(end, delay, TimeUnit.SECONDS)
        }
    }

    internal fun keep(document: Document, marks: List<RecordingWarningMark>) {
        if (marks.isNotEmpty()) kept.merge(document, marks) { before, added -> before + added }
    }

    internal fun ended(session: RecordingSession) {
        sessions.remove(session.id, session)
    }

    private fun forget(document: Document) {
        kept.remove(document)?.forEach { it.marker.dispose() }
    }

    /** Once: a closed file stops its sessions and forgets its kept warnings. */
    private fun listen() {
        if (listening) return
        listening = true
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    if (source.isFileOpen(file)) return
                    sessions.values.filter { it.file == file }.forEach { stop(it) }
                    FileDocumentManager.getInstance().getCachedDocument(file)?.let { forget(it) }
                }
            },
        )
    }

    private fun send(sessionId: String, command: String): CompletableFuture<Boolean> =
        CompletableFuture.supplyAsync({
            val server = project.service<PiwiProjectService>().server() ?: return@supplyAsync false
            val request = if (command == "stop") server.stopRecording(StopRecordingParams(sessionId))
            else server.recordingCommand(RecordingCommandParams(sessionId, command))
            runCatching { request.get(PiwiProjectService.TIMEOUT_SECONDS, TimeUnit.SECONDS) }.isSuccess
        }, AppExecutorUtil.getAppExecutorService()).exceptionally { false }

    /** The project closes: the service is asked to stop its sessions, which are disposed already, without waiting. */
    override fun dispose() {
        disposed = true
        val server = runCatching { project.getServiceIfCreated(PiwiProjectService::class.java)?.server() }.getOrNull()
        for (id in sessions.keys) runCatching { server?.stopRecording(StopRecordingParams(id)) }
        sessions.clear()
        listeners.clear()
        kept.values.flatten().forEach { it.marker.dispose() }
        kept.clear()
    }

    companion object {
        /** The name of a recording's writes, in the Undo menu. */
        const val COMMAND = "Record with Piwi"

        /** The tint over a recorded block: **Settings → Editor → Color Scheme → Piwi**, a light blue by default. */
        val BLOCK: TextAttributesKey = TextAttributesKey.createTextAttributesKey("PIWI_RECORDING_BLOCK")

        /** The actions offered on a recorded block's gutter mark. */
        fun actions(): ActionGroup = DefaultActionGroup(
            listOf("Piwi.StopRecording", "Piwi.PauseRecording", "Piwi.ResumeRecording").mapNotNull { ActionManager.getInstance().getAction(it) },
        )

        private const val MAX_EARLY = 16
        private const val STOP_TIMEOUT_SECONDS = 15L
    }
}

/**
 * One recording session: the file it writes into, its recorded block, the tint over it, its warnings, and what the
 * banner over the file says. The block is followed by a range marker, and its first line by an anchor that outlives
 * the block, so a block the developer removed is written again there on Resume.
 */
class RecordingSession internal constructor(
    private val recordings: PiwiRecordings,
    private val project: Project,
    val id: String,
    private val editor: Editor,
    val file: VirtualFile,
    private val into: String,
    private val placement: RecordingPlacement,
    private var message: String?,
    start: Int?,
) : Disposable {
    val document: Document = editor.document

    private val group = "piwi.recording.$id"
    private val bracket = UndoBracket(project, document)
    private var anchor: RangeMarker? = null
    private var block: RangeMarker? = null
    private var tint: RangeHighlighter? = null
    private var applying = false
    private var written = false
    private var finished = false

    /** The warnings of the latest update, on their lines. */
    @Volatile var warnings: List<RecordingWarningMark> = emptyList()
        private set

    /** `starting`, `recording`, `paused`, `stopped` or `failed`, as the service last said, or `paused` from Pause here until it says so. */
    @Volatile var state: String = "starting"
        private set

    @Volatile var steps: Int = 0
        private set

    /** Whether the developer changed the recorded lines: nothing is written until Resume. */
    @Volatile var edited: Boolean = false
        private set

    /** Whether Stop was asked: the service's last update ends the session. */
    @Volatile var stopping: Boolean = false
        private set

    /** The action the service offers with its message, shown in the banner. */
    @Volatile var command: PiwiCommand? = null
        private set

    @Volatile var view: Glue.RecordingBanner = Glue.recordingBanner(state, 0, edited = false, stopping = false, message = message)
        private set

    /** The block's range before an insertion below it, which its markers then leave out. */
    private var below: TextRange? = null

    init {
        val offset = start?.coerceIn(0, document.textLength) ?: Glue.followLineStart(document.immutableCharSequence, placement.line, emptyList())
        anchor = document.createRangeMarker(offset, offset)
        document.addDocumentListener(
            object : DocumentListener {
                override fun beforeDocumentChange(event: DocumentEvent) = edit(event)

                override fun documentChanged(event: DocumentEvent) = keepAbove()
            },
            this,
        )
    }

    /**
     * Writes the update's block, unless the developer changed it, and ends the session on `stopped` or `failed`. The
     * first block is written by the first update of a recording under way, or by a last one with steps: a recording
     * that ended before its first step writes nothing.
     */
    fun apply(update: RecordingUpdate) {
        if (finished) return
        update.state?.let { state = it }
        update.steps?.let { steps = it.size }
        message = update.message
        command = update.command
        val ending = state == "stopped" || state == "failed"
        if (!edited && (written || !ending || (state == "stopped" && steps > 0))) {
            write(update.code.orEmpty(), update.imports.orEmpty(), update.warnings.orEmpty())
        }
        if (ending) end(update.message, failed = state == "failed") else refreshView()
    }

    /**
     * Ends the session: the block becomes ordinary code, which one Undo removes; the tint and the banner go, the warnings
     * stay. A notification says what was written, or, when `failed`, why it stopped, with the service's command.
     */
    fun end(reason: String?, failed: Boolean) {
        if (finished) return
        finished = true
        bracket.close()
        val open = FileEditorManager.getInstance(project).isFileOpen(file)
        val kept = warnings
        warnings = emptyList()
        if (open) recordings.keep(document, kept) else kept.forEach { it.marker.dispose() }
        recordings.ended(this)
        Disposer.dispose(this)
        EditorNotifications.getInstance(project).updateNotifications(file)
        recordings.viewChanged()
        notify(reason, failed, if (open) kept.size else 0)
    }

    internal fun refreshView() {
        view = Glue.recordingBanner(state, steps, edited, stopping, message)
        EditorNotifications.getInstance(project).updateNotifications(file)
        recordings.viewChanged()
    }

    /** Where the block starts, or will: for the status bar to go there. */
    fun blockStart(): Int? = (block?.takeIf { it.isValid } ?: anchor?.takeIf { it.isValid })?.startOffset

    /** Marks Stop as asked; false when it already was, or the session ended. */
    internal fun stopRequested(): Boolean {
        if (finished || stopping) return false
        stopping = true
        refreshView()
        return true
    }

    internal fun paused() {
        if (finished || state != "recording") return
        state = "paused"
        refreshView()
    }

    internal fun resumed() {
        edited = false
        if (state == "paused") state = "recording"
        refreshView()
    }

    /**
     * An edit of the block by anyone but this session pauses the recording; edits around it only move it. An insertion
     * at the block's end that starts with a line break (Enter at the end of its last line) is below it: it does not
     * pause the recording, and the block does not grow over it.
     */
    private fun edit(event: DocumentEvent) {
        if (applying || finished) return
        val block = block?.takeIf { it.isValid } ?: return
        if (event.offset == block.endOffset && event.oldLength == 0 && event.newFragment.startsWith("\n")) {
            below = block.textRange
            return
        }
        if (edited || event.offset > block.endOffset || event.offset + event.oldLength < block.startOffset) return
        edited = true
        if (!stopping) recordings.remote.send(id, "pause")
        refreshView()
    }

    /** After an insertion below the block: the block and its tint end where they did before it. */
    private fun keepAbove() {
        val range = below ?: return
        below = null
        if (finished) return
        block?.dispose()
        block = blockMarker(range.startOffset, range.endOffset)
        tint()
    }

    /** A range marker over the block, which grows with the text typed at either of its ends. */
    private fun blockMarker(start: Int, end: Int): RangeMarker = document.createRangeMarker(start, end).apply {
        isGreedyToLeft = true
        isGreedyToRight = true
    }

    /**
     * Writes `code` as the block, in one write command with the imports it lacks: over the block when there is one,
     * else at the anchor, where the placement put it. Each write joins the recording's undo step.
     */
    private fun write(code: String, imports: List<String>, warnings: List<RecordingWarning>) {
        val text = Glue.recordedBlock(code, placement.indent)
        val current = block?.takeIf { it.isValid }
        val same = current != null && document.immutableCharSequence.subSequence(current.startOffset, current.endOffset).toString() == text
        if (same && (into == "file" || Glue.importInsertion(document.immutableCharSequence, imports) == null)) {
            mark(warnings)
            return
        }
        bracket.open(editor)
        WriteCommandAction.writeCommandAction(project)
            .withName(PiwiRecordings.COMMAND)
            .withGroupId(group)
            .withUndoConfirmationPolicy(UndoConfirmationPolicy.DO_NOT_REQUEST_CONFIRMATION)
            .shouldRecordActionForActiveDocument(false)
            .run<RuntimeException> {
                applying = true
                try {
                    var start: Int
                    if (current != null) {
                        start = current.startOffset
                        if (!same) document.replaceString(start, current.endOffset, text)
                    } else {
                        val at = anchor?.takeIf { it.isValid }?.startOffset ?: document.textLength
                        val first = Glue.firstBlockWrite(document.immutableCharSequence, at, placement.newLine || written, text)
                        document.replaceString(first.start, first.end, first.text)
                        start = first.blockStart
                    }
                    val insertion = if (into == "file") null else Glue.importInsertion(document.immutableCharSequence, imports)
                    if (insertion != null && (insertion.offset <= start || insertion.offset >= start + text.length)) {
                        document.insertString(insertion.offset, insertion.text)
                        if (insertion.offset <= start) start += insertion.text.length
                    }
                    block?.dispose()
                    anchor?.dispose()
                    block = blockMarker(start, start + text.length)
                    anchor = document.createRangeMarker(start, start)
                } finally {
                    applying = false
                }
            }
        written = true
        tint()
        mark(warnings)
    }

    /** The tint over the block's lines, with the recording's mark in the gutter. */
    private fun tint() {
        tint?.dispose()
        tint = null
        val range = block?.takeIf { it.isValid } ?: return
        tint = DocumentMarkupModel.forDocument(document, project, true).addRangeHighlighter(
            PiwiRecordings.BLOCK,
            range.startOffset,
            range.endOffset,
            HighlighterLayer.ADDITIONAL_SYNTAX,
            HighlighterTargetArea.LINES_IN_RANGE,
        ).apply {
            isGreedyToLeft = true
            isGreedyToRight = true
            gutterIconRenderer = RecordingGutter(this@RecordingSession)
        }
    }

    /** Each warning on the text of its line of the block, which it shows on until that text changes. */
    private fun mark(list: List<RecordingWarning>) {
        warnings.forEach { it.marker.dispose() }
        val range = block?.takeIf { it.isValid }
        if (range == null) {
            warnings = emptyList()
            return
        }
        val first = document.getLineNumber(range.startOffset)
        val last = document.getLineNumber(range.endOffset)
        val chars = document.immutableCharSequence
        warnings = list.mapNotNull { warning ->
            val line = first + warning.line
            val note = warning.message?.trim()?.ifEmpty { null }
            if (warning.line < 0 || line > last || note == null) return@mapNotNull null
            val start = document.getLineStartOffset(line)
            val end = document.getLineEndOffset(line)
            val from = start + (end - start - chars.subSequence(start, end).trimStart().length)
            if (from >= end) null else RecordingWarningMark(document.createRangeMarker(from, end), chars.subSequence(from, end).toString(), note)
        }
    }

    private fun notify(reason: String?, failed: Boolean, warnings: Int) {
        val text = if (failed && !written) reason ?: "The recording did not start." else Glue.recordingSummary(steps, warnings, file.name, reason)
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Piwi")
            .createNotification(text, if (failed) NotificationType.WARNING else NotificationType.INFORMATION)
        val command = command
        val title = command?.title
        if (failed && title != null) {
            notification.addAction(NotificationAction.createSimpleExpiring(title) { PiwiCommands.execute(project, command.command, command.arguments.orEmpty()) })
        }
        notification.notify(project)
    }

    override fun dispose() {
        finished = true
        bracket.release()
        block?.dispose()
        anchor?.dispose()
        tint?.dispose()
        warnings.forEach { it.marker.dispose() }
        block = null
        anchor = null
        tint = null
        warnings = emptyList()
    }
}

/**
 * The changes of a document from the moment `piwi/record` is sent: the line its placement names is a line of the text
 * the service read, found in the document as it is when the answer arrives. On the event thread.
 */
class DocumentChanges(document: Document, parent: Disposable) : Disposable {
    private val sent: CharSequence = document.immutableCharSequence
    private val changes = mutableListOf<Glue.TextChange>()

    init {
        Disposer.register(parent, this)
        document.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    changes += Glue.TextChange(event.offset, event.oldLength, event.newFragment.toString())
                }
            },
            this,
        )
    }

    /** Where the start of `line` of the text sent is in the document now. */
    fun lineStart(line: Int): Int = Glue.followLineStart(sent, line, changes)

    override fun dispose() = Unit
}

/** A recorded step's warning on the text of its line: shown while that text is unchanged. */
class RecordingWarningMark(val marker: RangeMarker, private val text: String, val message: String) {
    /** Where it shows in `document`; null once its line changed or was removed. */
    fun range(document: Document): TextRange? {
        if (!marker.isValid) return null
        val range = marker.textRange
        val chars = document.immutableCharSequence
        if (range.endOffset > chars.length || chars.subSequence(range.startOffset, range.endOffset).toString() != text) return null
        return range
    }
}

/**
 * Makes everything a recording writes one undo step: a start mark before its first write and a finish mark at its end,
 * and one Undo goes back to the start mark, the developer's own edits of the file in between included. The start mark
 * is a command of its own, right before the write, so the caret it records is the one Undo restores after undoing that
 * write: Undo does not stop at it to move the caret. While the start mark is undone, it is off the undo stack: the next
 * write starts again, and a finish mark only follows a start mark still there.
 */
private class UndoBracket(private val project: Project, private val document: Document) {
    private var mark: StartMarkAction? = null
    private var holder: Editor? = null
    private var start: StartMark? = null

    /** Before a write: starts the bracket in an editor of the document, unless it is open. */
    fun open(preferred: Editor) {
        if (mark != null && start?.undone == false) return
        release()
        val editor = preferred.takeIf { !it.isDisposed && it.document == document }
            ?: EditorFactory.getInstance().getEditors(document, project).firstOrNull()
            ?: return
        CommandProcessor.getInstance().executeCommand(
            project,
            {
                mark = try {
                    StartMarkAction.start(editor, project, PiwiRecordings.COMMAND)
                } catch (_: StartMarkAction.AlreadyStartedException) {
                    null
                }
                if (mark != null) {
                    holder = editor
                    start = StartMark(document).also { UndoManager.getInstance(project).undoableActionPerformed(it) }
                }
            },
            PiwiRecordings.COMMAND,
            null,
            UndoConfirmationPolicy.DO_NOT_REQUEST_CONFIRMATION,
            false,
        )
    }

    /** Ends the bracket in a command of its own: one Undo now removes everything since its start. */
    fun close() {
        val mark = mark
        val editor = holder
        if (mark == null || editor == null || start?.undone != false) {
            release()
            return
        }
        CommandProcessor.getInstance().executeCommand(
            project,
            { FinishMarkAction.finish(project, editor, mark) },
            PiwiRecordings.COMMAND,
            null,
            UndoConfirmationPolicy.DO_NOT_REQUEST_CONFIRMATION,
            false,
        )
        this.mark = null
        holder = null
        start = null
    }

    /** Takes the start mark off its editor without a finish mark. */
    fun release() {
        val editor = holder
        if (editor != null && editor.getUserData(StartMarkAction.START_MARK_ACTION_KEY) === mark) {
            editor.putUserData(StartMarkAction.START_MARK_ACTION_KEY, null)
        }
        mark = null
        holder = null
        start = null
    }
}

/** Beside a recording's start mark, in its undo group: whether that group is undone now, the start mark with it. */
private class StartMark(document: Document) : BasicUndoableAction(document) {
    @Volatile var undone = false

    override fun undo() {
        undone = true
    }

    override fun redo() {
        undone = false
    }
}

/** The recorded block's mark in the gutter: what the recording does, and Stop, Pause or Resume on a click. */
private class RecordingGutter(private val session: RecordingSession) : GutterIconRenderer(), DumbAware {
    override fun getIcon(): Icon = AllIcons.Ide.Macro.Recording_1

    override fun getTooltipText(): String = session.view.text

    override fun getPopupMenuActions(): ActionGroup = PiwiRecordings.actions()

    override fun getClickAction(): AnAction = object : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val popup = JBPopupFactory.getInstance().createActionGroupPopup(
                null,
                PiwiRecordings.actions(),
                e.dataContext,
                JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
                false,
            )
            val mouse = e.inputEvent as? MouseEvent
            if (mouse != null) popup.show(RelativePoint(mouse)) else popup.showInBestPositionFor(e.dataContext)
        }
    }

    override fun equals(other: Any?): Boolean = other is RecordingGutter && other.session === session

    override fun hashCode(): Int = System.identityHashCode(session)
}
