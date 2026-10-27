package dev.piwitests.jetbrains

import com.google.gson.GsonBuilder
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.ide.scratch.ScratchRootType
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.ReadOnlyModificationException
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Computable
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.IdeFocusManager
import io.netty.buffer.Unpooled
import io.netty.channel.ChannelFutureListener
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpMethod
import io.netty.handler.codec.http.HttpRequest
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.QueryStringDecoder
import org.jetbrains.ide.BuiltInServerManager
import org.jetbrains.ide.HttpRequestHandler
import org.jetbrains.ide.HttpRequestHandler.OriginCheckResult
import java.awt.datatransfer.StringSelection
import java.net.InetSocketAddress
import java.net.URI
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** The pairing token Piwi Picker sends with each request, kept in the password safe: read on a pooled thread. */
object PiwiSendToken {
    private val attributes = PiwiCredentials.attributes(generateServiceName("Piwi", "sendToken"))

    @Volatile private var cached: String? = null

    fun current(): String = cached ?: (PasswordSafe.instance.getPassword(attributes) ?: "").also { cached = it }

    fun ensure(): String = current().ifEmpty {
        val bytes = ByteArray(24).also { SecureRandom().nextBytes(it) }
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).also {
            PasswordSafe.instance.setPassword(attributes, it)
            cached = it
        }
    }
}

/**
 * `POST /api/piwi/send` on the IDE's built-in server: what Piwi Picker sends, inserted at the
 * caret of the focused project's editor, or into a new scratch file while no editor is open. A
 * locator picked while a run was paused at a breakpoint replaces the locator of its line instead
 * (`piwi/applyPick`), and goes to the caret when the line holds none. Each request is served on
 * a pooled thread, where the token, the file and its document are read; the server's I/O thread
 * reads nothing from the password safe or the disk, and only the write runs on the event thread.
 * With the same token, `GET /api/piwi/live` lists the hubs of every editor service running on
 * the machine, read from their discovery files (`Glue.liveHubs`), so the one pairing reaches the
 * runs of every IDE window and project. The platform's own check of the `Host` header applies to
 * both (a page reached under another name is refused), and every answer to a request carrying a
 * challenge carries the proof that this IDE holds the token (`Glue.editorTokenProof`), paired or
 * not, so Piwi Picker sends the token only here.
 */
class PiwiSendHandler : HttpRequestHandler() {
    override fun isSupported(request: FullHttpRequest): Boolean {
        val path = QueryStringDecoder(request.uri()).path()
        val method = request.method()
        return (path == PATH && (method == HttpMethod.POST || method == HttpMethod.OPTIONS)) ||
            (path == LIVE_PATH && (method == HttpMethod.GET || method == HttpMethod.OPTIONS))
    }

    /**
     * A browser extension's origin is allowed on these paths, which the token authenticates; another origin is as the
     * platform rules. The platform's `isAccessible` keeps its check of the `Host` header.
     */
    override fun isOriginAllowed(request: HttpRequest): OriginCheckResult {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        val ours = QueryStringDecoder(request.uri()).path() in setOf(PATH, LIVE_PATH)
        return if (ours && origin != null && EXTENSION_ORIGIN.matches(origin)) OriginCheckResult.ALLOW else super.isOriginAllowed(request)
    }

    override fun process(urlDecoder: QueryStringDecoder, request: FullHttpRequest, context: ChannelHandlerContext): Boolean {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        val challenge = request.headers().get(Glue.EDITOR_CHALLENGE_HEADER)?.takeIf { Glue.isEditorChallenge(it) }
        val port = (context.channel().localAddress() as? InetSocketAddress)?.port
        val preflight = request.method() == HttpMethod.OPTIONS
        // A preflight carries no challenge, and needs no token: it is answered here, on the server's thread.
        if (preflight && challenge == null) {
            respond(context, origin, HttpResponseStatus.NO_CONTENT, null, null)
            return true
        }
        val authorization = request.headers().get(HttpHeaderNames.AUTHORIZATION)
        val live = urlDecoder.path() == LIVE_PATH
        // The request is released once this returns: its body is taken here, and checked on the pooled thread.
        val body = when {
            preflight || live -> ""
            request.content().readableBytes() > Glue.MAX_SEND_BYTES -> null
            else -> request.content().toString(Charsets.UTF_8)
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            val token = runCatching { PiwiSendToken.current() }.getOrNull()
            val proof = if (token.isNullOrEmpty() || challenge == null || port == null) null else Glue.editorTokenProof(token, port, challenge)
            val (status, answer) = when {
                token == null -> HttpResponseStatus.INTERNAL_SERVER_ERROR to mapOf("error" to "the pairing's token could not be read")
                preflight -> HttpResponseStatus.NO_CONTENT to null
                live -> try {
                    live(authorization, token)
                } catch (e: Exception) {
                    HttpResponseStatus.INTERNAL_SERVER_ERROR to mapOf("error" to "the live hubs could not be read")
                }
                else -> try {
                    answer(authorization, token, body)
                } catch (e: Exception) {
                    HttpResponseStatus.UNPROCESSABLE_ENTITY to mapOf("error" to (e.message ?: e.javaClass.simpleName))
                }
            }
            respond(context, origin, status, answer, proof)
        }
        return true
    }

    /** The live hubs, with the pairing's token: those of the services whose discovery file names a running process. */
    private fun live(authorization: String?, token: String): Pair<HttpResponseStatus, Map<String, Any?>> {
        if (!Glue.sendAuthorized(authorization, token)) {
            return HttpResponseStatus.UNAUTHORIZED to mapOf("error" to "not paired")
        }
        val dir = Glue.editorsDir(System.getenv(), System.getProperty("user.home"))
        val hubs = Glue.liveHubs(dir, Glue.machineName) { pid -> ProcessHandle.of(pid).map { it.isAlive }.orElse(false) }
        return HttpResponseStatus.OK to mapOf("hubs" to hubs)
    }

    /** The answer to a request: the token first, then the body's size and shape, then the insertion. */
    private fun answer(authorization: String?, token: String, body: String?): Pair<HttpResponseStatus, Map<String, Any?>> {
        if (!Glue.sendAuthorized(authorization, token)) {
            return HttpResponseStatus.UNAUTHORIZED to mapOf("error" to "not paired")
        }
        if (body == null) return HttpResponseStatus.REQUEST_ENTITY_TOO_LARGE to mapOf("error" to "too large")
        return when (val payload = Glue.parseSendPayload(body)) {
            is Glue.SendPayload.Refused -> HttpResponseStatus.BAD_REQUEST to mapOf("error" to payload.error)
            else -> HttpResponseStatus.OK to mapOf("inserted" to true, "file" to insert(payload))
        }
    }

    /**
     * Inserts the payload in the focused project and answers the path of the file written, null for a scratch file. A
     * pick at a line goes through `piwi/applyPick`; a recorded flow is rendered by the editor service for the caret,
     * its page expression and its line's indentation, with its import edit apart. On a pooled thread.
     */
    private fun insert(payload: Glue.SendPayload): String? {
        val project = targetProject() ?: throw IllegalStateException("no project is open")
        var outcome: Glue.PickOutcome? = null
        val picked = payload as? Glue.SendPayload.Locator
        val at = picked?.at
        if (picked != null && at != null) {
            val server = project.service<PiwiProjectService>().server()
            val answer = server?.applyPick(ApplyPickParams(file = at.file, line = at.line - 1, locator = picked.text))?.orNull()
            val uri = answer?.uri
            val edit = answer?.edit
            if (uri != null && edit != null) {
                val file = try {
                    replaceOnLine(project, uri, edit, at)
                } catch (e: IllegalStateException) {
                    PiwiCommands.notify(project, "Piwi: ${e.message}", NotificationType.WARNING)
                    throw e
                }
                PiwiCommands.notify(project, Glue.pickNotice(at, Glue.PickOutcome.REPLACED))
                return file
            }
            outcome = when {
                server == null -> Glue.PickOutcome.NOT_RUNNING
                answer == null -> Glue.PickOutcome.NO_ANSWER
                uri == null -> Glue.PickOutcome.NO_FILE
                else -> Glue.PickOutcome.NO_LOCATOR
            }
        }
        val caret = caretOf(project)
        var importEdit: FileEdit? = null
        val text = when (payload) {
            is Glue.SendPayload.Locator -> payload.text
            is Glue.SendPayload.Steps -> {
                val server = project.service<PiwiProjectService>().server()
                    ?: throw IllegalStateException("the Piwi editor service is not running in this project")
                val params = RenderStepsParams(caret?.uri ?: "", payload.steps, caret?.line, caret?.character, "separate")
                val rendered = server.renderSteps(params).orNull()
                importEdit = rendered?.importEdit
                rendered?.code?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException(rendered?.warnings?.joinToString("; ") ?: "nothing to insert")
            }
            is Glue.SendPayload.Refused -> throw IllegalStateException(payload.error)
        }
        val insertion = Insertion(text, importEdit, payload is Glue.SendPayload.Locator, at, outcome)
        return onEventThread { insertAtCaret(project, insertion) }
    }

    private fun targetProject(): Project? =
        IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project
            ?: ProjectManager.getInstance().openProjects.firstOrNull { !it.isDefault }

    /** What goes in, and what the balloon says once it did: where a pick went and why, else what was inserted. */
    private class Insertion(
        val text: String,
        val importEdit: FileEdit?,
        val locator: Boolean,
        val at: Glue.SendPlace?,
        val outcome: Glue.PickOutcome?,
    ) {
        fun notice(scratch: Boolean): String {
            if (at != null && outcome != null) return Glue.pickNotice(at, outcome, scratch)
            val what = if (locator) "the locator" else "the recorded steps"
            return if (scratch) "Inserted $what from Piwi Picker in a new scratch file: no editor was open." else "Inserted $what from Piwi Picker."
        }
    }

    /** The file open in the project's editor (its URI, when it is on disk) and its caret, 0-based; null without an editor. */
    private data class Caret(val uri: String?, val line: Int, val character: Int)

    private fun caretOf(project: Project): Caret? = onEventThread {
        FileEditorManager.getInstance(project).selectedTextEditor?.let {
            val offset = it.caretModel.offset
            val line = it.document.getLineNumber(offset)
            val uri = it.virtualFile?.let { file -> runCatching { file.toNioPath().toUri().toString() }.getOrNull() }
            Caret(uri, line, offset - it.document.getLineStartOffset(line))
        }
    }

    /** Runs `block` on the event thread and waits for its answer, at most [EVENT_THREAD_WAIT_SECONDS]; what it throws is thrown here. */
    private fun <T> onEventThread(block: () -> T): T {
        val done = CompletableFuture<T>()
        ApplicationManager.getApplication().invokeLater {
            try {
                done.complete(block())
            } catch (e: Exception) {
                done.completeExceptionally(e)
            }
        }
        return try {
            done.get(EVENT_THREAD_WAIT_SECONDS, TimeUnit.SECONDS)
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        } catch (_: TimeoutException) {
            throw IllegalStateException("the IDE did not take the insertion within $EVENT_THREAD_WAIT_SECONDS seconds")
        }
    }

    /**
     * Replaces the range `edit` names, on one line of the file at `uri`, with its text, as one command, and answers
     * the file's path. The file and its document are read here, on the pooled thread; the write alone runs on the
     * event thread, against the document as it stands then. Throws, with why, when nothing was replaced.
     */
    private fun replaceOnLine(project: Project, uri: String, edit: FileEdit, at: Glue.SendPlace): String {
        val name = at.file.substringAfterLast('/')
        fun refuse(why: String): Nothing = throw IllegalStateException("the locator at line ${at.line} of $name was not replaced: $why")
        val start = edit.range?.start ?: refuse("the editor service named no range")
        val end = edit.range?.end ?: refuse("the editor service named no range")
        if (start.line != end.line) refuse("the range spans several lines")
        val path = runCatching { Path.of(URI(uri)) }.getOrNull() ?: refuse("$uri is not a file")
        val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path) ?: refuse("$name is not on disk")
        val document = ApplicationManager.getApplication().runReadAction(Computable { FileDocumentManager.getInstance().getDocument(file) })
            ?: refuse("$name cannot be edited as text")
        onEventThread {
            WriteCommandAction.runWriteCommandAction(project, "Replace with the Locator Picked in Piwi", null, {
                if (start.line >= document.lineCount) refuse("line ${at.line} is not there anymore")
                val lineStart = document.getLineStartOffset(start.line)
                if (start.character > end.character || lineStart + end.character > document.getLineEndOffset(start.line)) {
                    refuse("line ${at.line} changed")
                }
                try {
                    document.replaceString(lineStart + start.character, lineStart + end.character, edit.newText ?: "")
                } catch (_: ReadOnlyModificationException) {
                    refuse("$name is read-only")
                }
            })
        }
        return file.path
    }

    /**
     * Inserts the text at the caret (the service indented it for the caret's line), and the service's import edit,
     * placed in the text before the code goes in, as one command. Without an editor, a scratch file takes it.
     */
    private fun insertAtCaret(project: Project, insertion: Insertion): String? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return insertInScratch(project, insertion)
        val document = editor.document
        val caret = editor.caretModel.primaryCaret
        val text = insertion.text
        val importEdit = insertion.importEdit
        WriteCommandAction.runWriteCommandAction(project, "Insert from Piwi Picker", null, {
            val start = caret.selectionStart
            val end = caret.selectionEnd
            // Inside the selection the code replaces, the imports go at the start of its first line.
            val at = Glue.offsetOf(document.immutableCharSequence, importEdit?.range?.start)
                ?.let { if (it > start && it < end) document.getLineStartOffset(document.getLineNumber(start)) else it }
            val imports = Glue.importWrite(at, importEdit?.newText, Glue.BlockWrite(start, end, text, start))
            if (imports?.first == true) document.insertString(imports.offset, imports.text)
            document.replaceString(start, end, text)
            var after = start + text.length
            if (imports?.first == false) {
                document.insertString(imports.offset, imports.text)
                after += imports.text.length
            }
            caret.moveToOffset(after)
        })
        PiwiCommands.notify(project, insertion.notice(scratch = false))
        return editor.virtualFile?.path
    }

    /**
     * No editor open: the text, after its import lines, goes into a new scratch file, opened with the caret at its end.
     * The answer names no file, a scratch file being none of the project's.
     */
    private fun insertInScratch(project: Project, insertion: Insertion): String? {
        val content = insertion.importEdit?.newText.orEmpty() + insertion.text
        val file = ScratchRootType.getInstance().createScratchFile(project, SCRATCH_NAME, null, content)
            ?: throw IllegalStateException("no editor is open in ${project.name}, and no scratch file could be created")
        FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, file, content.length), true)
        PiwiCommands.notify(project, insertion.notice(scratch = true))
        return null
    }

    private fun respond(
        context: ChannelHandlerContext,
        origin: String?,
        status: HttpResponseStatus,
        body: Map<String, Any?>?,
        proof: String?,
    ) {
        val bytes = body?.let { JSON.toJson(it).toByteArray() } ?: ByteArray(0)
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(bytes))
        val headers = response.headers()
        if (body != null) headers.set(HttpHeaderNames.CONTENT_TYPE, "application/json")
        headers.set(HttpHeaderNames.CONTENT_LENGTH, bytes.size)
        if (proof != null) headers.set(Glue.EDITOR_PROOF_HEADER, proof)
        if (origin != null && EXTENSION_ORIGIN.matches(origin)) {
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS, "Authorization, Content-Type, ${Glue.EDITOR_CHALLENGE_HEADER}")
            headers.set(HttpHeaderNames.ACCESS_CONTROL_EXPOSE_HEADERS, Glue.EDITOR_PROOF_HEADER)
            headers.set(HttpHeaderNames.VARY, "Origin")
        }
        context.channel().writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
    }

    companion object {
        const val PATH = "/api/piwi/send"
        const val LIVE_PATH = "/api/piwi/live"
        private val EXTENSION_ORIGIN = Regex("^(chrome|moz)-extension://.+")

        /** The answers carry `file: null` for a scratch file, as the VS Code extension's do. */
        private val JSON = GsonBuilder().serializeNulls().create()

        /** The scratch file a request opens while no editor is; the platform numbers it when one exists. */
        private const val SCRATCH_NAME = "piwi-picker.ts"

        /** How long the event thread may take to apply an insertion: a modal dialog holds it meanwhile. */
        private const val EVENT_THREAD_WAIT_SECONDS = 10L
    }
}

/** Piwi: Pair with Piwi Picker — copies the address Piwi Picker's options take. */
class PairPickerAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        ApplicationManager.getApplication().executeOnPooledThread {
            val token = PiwiSendToken.ensure()
            val port = BuiltInServerManager.getInstance().waitForStart().port
            val address = "http://127.0.0.1:$port${PiwiSendHandler.PATH}#$token"
            ApplicationManager.getApplication().invokeLater {
                CopyPasteManager.getInstance().setContents(StringSelection(address))
                if (project != null) {
                    PiwiCommands.notify(
                        project,
                        "The pairing address is on the clipboard. Paste it in Piwi Picker's options, under Send to editor.",
                    )
                }
            }
        }
    }
}
