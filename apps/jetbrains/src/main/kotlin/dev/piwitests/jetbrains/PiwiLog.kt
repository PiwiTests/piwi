package dev.piwitests.jetbrains

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.jsonrpc.services.JsonRequest
import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.time.LocalTime
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The editor service's log in this project, as VS Code's Piwi output channel holds it: the service's starts and ends,
 * why it could not start, what it wrote to stderr (its errors, a crash's stack) and the plugin's requests that failed.
 * The Piwi tool window's **Log** tab shows it, opened by **Open Log**; the last [Glue.LOG_LINES] lines are kept.
 */
@Service(Service.Level.PROJECT)
class PiwiLog(private val project: Project) : Disposable {
    private val buffer = Glue.LogBuffer()

    /** The open Log tabs' consoles, each told every line written after it opened. */
    private val readers = CopyOnWriteArrayList<(List<String>) -> Unit>()

    /** The Log tab while the tool window holds it; on the event thread. */
    private var tab: Content? = null

    fun write(text: String) {
        val lines = Glue.logLines(LocalTime.now(), text)
        if (lines.isEmpty()) return
        synchronized(buffer) {
            buffer.add(lines)
            readers.forEach { it(lines) }
        }
    }

    /** A request to the service that failed, once a minute at most for each method. */
    fun requestFailed(method: String, cause: Throwable) {
        val written = synchronized(buffer) { buffer.writesFailure(method, System.currentTimeMillis()) }
        if (written) write("$method failed: ${cause.message ?: cause.javaClass.simpleName}")
    }

    fun lines(): List<String> = synchronized(buffer) { buffer.lines() }

    /**
     * What the service's process writes to stderr, line by line as it writes it, until it ends. Called before the
     * platform starts reading it.
     */
    fun watch(process: ProcessHandler) {
        val watching = Disposer.newDisposable(this, "Piwi editor service stderr")
        process.addProcessListener(
            object : ProcessListener {
                override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                    if (outputType == ProcessOutputTypes.STDERR) write(event.text)
                }

                override fun processTerminated(event: ProcessEvent) {
                    Disposer.dispose(watching)
                }
            },
            watching,
        )
    }

    /** The Log tab of the Piwi tool window, opened and selected, the lines kept until now first. On the event thread. */
    fun show() {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return
        val content = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 } ?: run {
            val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).apply { setViewer(true) }.console
            val reader: (List<String>) -> Unit = { lines ->
                console.print(lines.joinToString("\n", postfix = "\n"), ConsoleViewContentType.NORMAL_OUTPUT)
            }
            synchronized(buffer) {
                buffer.lines().takeIf { it.isNotEmpty() }?.let(reader)
                readers.add(reader)
            }
            ContentFactory.getInstance().createContent(console.component, Glue.LOG_TAB, false).apply {
                isCloseable = true
                setDisposer {
                    readers.remove(reader)
                    Disposer.dispose(console)
                    if (tab === this) tab = null
                }
                window.contentManager.addContent(this)
                tab = this
            }
        }
        window.contentManager.setSelectedContent(content)
        window.activate(null)
    }

    override fun dispose() {
        readers.clear()
    }

    companion object {
        /**
         * The service's proxy, its requests' failures written to the project's log under their method. Every request
         * the plugin sends goes through it (`piwiServer`), whatever waits for its answer.
         */
        fun logged(project: Project, server: PiwiLanguageServer): PiwiLanguageServer =
            Proxy.newProxyInstance(
                PiwiLanguageServer::class.java.classLoader,
                arrayOf(PiwiLanguageServer::class.java),
                InvocationHandler { _, method, args ->
                    val result = try {
                        method.invoke(server, *(args ?: emptyArray()))
                    } catch (e: InvocationTargetException) {
                        throw e.targetException
                    }
                    val name = method.getAnnotation(JsonRequest::class.java)?.value?.ifEmpty { null }
                        ?: method.getAnnotation(JsonNotification::class.java)?.value?.ifEmpty { null }
                        ?: method.name
                    (result as? CompletableFuture<*>)?.whenComplete { _, error ->
                        val cause = (error as? CompletionException)?.cause ?: error
                        if (cause != null && cause !is java.util.concurrent.CancellationException) {
                            project.getServiceIfCreated(PiwiLog::class.java)?.requestFailed(name, cause)
                        }
                    }
                    result
                },
            ) as PiwiLanguageServer
    }
}
