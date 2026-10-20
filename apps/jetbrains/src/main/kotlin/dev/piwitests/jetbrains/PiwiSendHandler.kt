package dev.piwitests.jetbrains

import com.google.gson.Gson
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
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
import java.awt.datatransfer.StringSelection
import java.net.URI
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.CompletableFuture

/** The pairing token Piwi Picker sends with each request, kept in the password safe. */
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
 * `POST /api/piwi/send` on the IDE's built-in server: what Piwi Picker sends,
 * inserted at the caret of the focused project's editor. A locator picked while
 * a run was paused at a breakpoint replaces the locator of its line instead
 * (`piwi/applyPick`), and goes to the caret when the line holds none.
 */
class PiwiSendHandler : HttpRequestHandler() {
    override fun isSupported(request: FullHttpRequest): Boolean =
        QueryStringDecoder(request.uri()).path() == PATH &&
            (request.method() == HttpMethod.POST || request.method() == HttpMethod.OPTIONS)

    // The token authenticates each request; the extension's origin is not a local one.
    override fun isAccessible(request: HttpRequest): Boolean = QueryStringDecoder(request.uri()).path() == PATH

    override fun process(urlDecoder: QueryStringDecoder, request: FullHttpRequest, context: ChannelHandlerContext): Boolean {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        if (request.method() == HttpMethod.OPTIONS) {
            respond(context, origin, HttpResponseStatus.NO_CONTENT, null)
            return true
        }
        if (!Glue.sendAuthorized(request.headers().get(HttpHeaderNames.AUTHORIZATION), PiwiSendToken.current())) {
            respond(context, origin, HttpResponseStatus.UNAUTHORIZED, mapOf("error" to "not paired"))
            return true
        }
        if (request.content().readableBytes() > Glue.MAX_SEND_BYTES) {
            respond(context, origin, HttpResponseStatus.REQUEST_ENTITY_TOO_LARGE, mapOf("error" to "too large"))
            return true
        }
        when (val payload = Glue.parseSendPayload(request.content().toString(Charsets.UTF_8))) {
            is Glue.SendPayload.Refused -> respond(context, origin, HttpResponseStatus.BAD_REQUEST, mapOf("error" to payload.error))
            else -> insert(payload).whenComplete { file, error ->
                if (error != null) {
                    respond(context, origin, HttpResponseStatus.UNPROCESSABLE_ENTITY, mapOf("error" to (error.cause ?: error).message))
                } else {
                    respond(context, origin, HttpResponseStatus.OK, mapOf("inserted" to true, "file" to file))
                }
            }
        }
        return true
    }

    /**
     * Render a recorded flow through the editor service, for the page expression at the caret and with its imports
     * apart, then insert it at the caret; completes with the file's path.
     */
    private fun insert(payload: Glue.SendPayload): CompletableFuture<String?> {
        val result = CompletableFuture<String?>()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val project = targetProject() ?: throw IllegalStateException("no project is open")
                var notice: String? = null
                val picked = payload as? Glue.SendPayload.Locator
                val at = picked?.at
                if (picked != null && at != null) {
                    val server = project.service<PiwiProjectService>().server()
                    val answer = server?.applyPick(ApplyPickParams(file = at.file, line = at.line - 1, locator = picked.text))?.orNull()
                    val uri = answer?.uri
                    val edit = answer?.edit
                    if (uri != null && edit != null) {
                        val done = CompletableFuture<String?>()
                        ApplicationManager.getApplication().invokeLater {
                            done.complete(runCatching { replaceOnLine(project, uri, edit) }.getOrNull())
                        }
                        val file = done.get(10, java.util.concurrent.TimeUnit.SECONDS)
                        if (file != null) {
                            PiwiCommands.notify(project, Glue.pickNotice(at, Glue.PickOutcome.REPLACED))
                            result.complete(file)
                            return@executeOnPooledThread
                        }
                    }
                    notice = Glue.pickNotice(at, if (uri != null) Glue.PickOutcome.NO_LOCATOR else Glue.PickOutcome.NO_FILE)
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
                ApplicationManager.getApplication().invokeLater {
                    try {
                        result.complete(insertAtCaret(project, text, importEdit, payload is Glue.SendPayload.Locator, notice))
                    } catch (e: Exception) {
                        result.completeExceptionally(e)
                    }
                }
            } catch (e: Exception) {
                result.completeExceptionally(e)
            }
        }
        return result
    }

    private fun targetProject(): Project? =
        IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project
            ?: ProjectManager.getInstance().openProjects.firstOrNull { !it.isDefault }

    /** The file open in the project's editor (its URI, when it is on disk) and its caret, 0-based. */
    private data class Caret(val uri: String?, val line: Int, val character: Int)

    private fun caretOf(project: Project): Caret? {
        val future = CompletableFuture<Caret?>()
        ApplicationManager.getApplication().invokeLater {
            val editor = FileEditorManager.getInstance(project).selectedTextEditor
            future.complete(
                editor?.let {
                    val offset = it.caretModel.offset
                    val line = it.document.getLineNumber(offset)
                    val uri = it.virtualFile?.let { file -> runCatching { file.toNioPath().toUri().toString() }.getOrNull() }
                    Caret(uri, line, offset - it.document.getLineStartOffset(line))
                },
            )
        }
        return future.get(10, java.util.concurrent.TimeUnit.SECONDS)
    }

    /**
     * Replaces the range of `edit`, on one line of the file at `uri`, with its text, as one command; the file's path, or
     * null when the file or the line is not there.
     */
    private fun replaceOnLine(project: Project, uri: String, edit: FileEdit): String? {
        val range = edit.range ?: return null
        val start = range.start ?: return null
        val end = range.end ?: return null
        val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(URI(uri))) ?: return null
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return null
        if (start.line != end.line || start.line >= document.lineCount) return null
        val lineStart = document.getLineStartOffset(start.line)
        val lineEnd = document.getLineEndOffset(start.line)
        if (start.character > end.character || lineStart + end.character > lineEnd) return null
        WriteCommandAction.runWriteCommandAction(project, "Replace with the Locator Picked in Piwi", null, {
            document.replaceString(lineStart + start.character, lineStart + end.character, edit.newText ?: "")
        })
        return file.path
    }

    /**
     * Inserts `text` at the caret (the service indented it for the caret's line), and the service's import edit, placed in
     * the text before the code goes in, as one command.
     */
    private fun insertAtCaret(
        project: Project,
        text: String,
        importEdit: FileEdit?,
        locator: Boolean,
        notice: String? = null,
    ): String? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
            ?: throw IllegalStateException("no editor is open in ${project.name}")
        val document = editor.document
        val caret = editor.caretModel.primaryCaret
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
        PiwiCommands.notify(
            project,
            notice ?: if (locator) "Inserted the locator from Piwi Picker." else "Inserted the recorded steps from Piwi Picker.",
        )
        return editor.virtualFile?.path
    }

    private fun respond(context: ChannelHandlerContext, origin: String?, status: HttpResponseStatus, body: Map<String, Any?>?) {
        val bytes = body?.let { Gson().toJson(it).toByteArray() } ?: ByteArray(0)
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(bytes))
        val headers = response.headers()
        if (body != null) headers.set(HttpHeaderNames.CONTENT_TYPE, "application/json")
        headers.set(HttpHeaderNames.CONTENT_LENGTH, bytes.size)
        if (origin != null && EXTENSION_ORIGIN.matches(origin)) {
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS")
            headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS, "Authorization, Content-Type")
            headers.set(HttpHeaderNames.VARY, "Origin")
        }
        context.channel().writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
    }

    companion object {
        const val PATH = "/api/piwi/send"
        private val EXTENSION_ORIGIN = Regex("^(chrome|moz)-extension://.+")
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
