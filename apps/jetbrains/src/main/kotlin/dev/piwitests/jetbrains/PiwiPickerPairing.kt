package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.BrowserUtil
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationNamesInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.Alarm
import com.intellij.util.ui.JBUI
import org.jetbrains.ide.BuiltInServerManager
import java.util.concurrent.ConcurrentHashMap
import javax.swing.JComponent

/**
 * Piwi Picker's pairing by code on this IDE: the requests the built-in server takes (`PiwiSendHandler`), each answered
 * in a notification or the **Piwi Picker** tab; the pairing kept, and when Piwi Picker was last heard from
 * (application-level properties). The open projects' tabs are drawn again as it changes.
 */
object PiwiPickerPairing {
    /** The requests waiting: a change draws the tabs again and asks the person about a new one. */
    val requests = Glue.EditorPairingRequests(changed = ::changed)

    /** The requests the person was asked about already. */
    private val prompted = ConcurrentHashMap.newKeySet<String>()

    private const val PAIRED_AT = "piwi.pickerPaired.at"
    private const val PAIRED_CLIENT = "piwi.pickerPaired.client"
    private const val HEARD = "piwi.pickerHeard"

    /** How often the time Piwi Picker was last heard from is written: once a minute at most. */
    private const val HEARD_EVERY_MILLIS = 60_000L

    /** Where Piwi Picker comes from. */
    const val GET_PICKER_URL = "https://piwitests.dev/features/extension"

    /** The hello of `GET /api/piwi/hello`: this IDE, and the projects it has open. Off the event thread. */
    fun hello(): Map<String, Any> = Glue.editorHello(
        ApplicationNamesInfo.getInstance().fullProductName,
        ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.map { it.name },
    )

    /** The pairing kept: when, and the browser of a pairing by code; null before one, and after Unpair. */
    fun paired(): Glue.PickerPaired? {
        val properties = PropertiesComponent.getInstance()
        val at = properties.getValue(PAIRED_AT)?.toLongOrNull() ?: return null
        return Glue.PickerPaired(at, properties.getValue(PAIRED_CLIENT)?.takeIf { it.isNotEmpty() })
    }

    /** When Piwi Picker was last heard from; null before. */
    fun heardAt(): Long? = PropertiesComponent.getInstance().getValue(HEARD)?.toLongOrNull()

    /** Piwi Picker reached the pairing: the time is kept, once a minute at most, and the tabs drawn again. */
    fun heard() {
        val now = System.currentTimeMillis()
        val last = heardAt()
        if (last != null && now - last < HEARD_EVERY_MILLIS) return
        PropertiesComponent.getInstance().setValue(HEARD, now.toString())
        changed()
    }

    /** The tabs drawn again, and the person asked about each request that came since. */
    private fun changed() {
        val waiting = requests.waiting()
        ApplicationManager.getApplication().invokeLater {
            for (project in ProjectManager.getInstance().openProjects) {
                if (!project.isDisposed) project.getServiceIfCreated(PiwiPickerTab::class.java)?.drawAgain()
            }
            for (request in waiting) if (prompted.add(request.id)) ask(request)
        }
    }

    /**
     * Asks about a request in the project in use: a notification with Allow and Deny, the Piwi Picker tab shown beside,
     * and the IDE's icon asking for attention, the person having just clicked Pair in the browser. On the event thread.
     */
    private fun ask(request: Glue.PairingRequestView) {
        val project = IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project?.takeIf { !it.isDisposed }
            ?: ProjectManager.getInstance().openProjects.firstOrNull { !it.isDisposed }
            ?: return
        PiwiNotifier.create(PiwiNotice.REQUEST, Glue.escapeHtml(Glue.pairingPrompt(request.client, request.code)))
            .addAction(NotificationAction.createSimpleExpiring("Allow") { allow(project, request.id) })
            .addAction(NotificationAction.createSimpleExpiring("Deny") { requests.answer(request.id, null) })
            .notify(project)
        project.service<PiwiPickerTab>().open(focus = false)
        com.intellij.ui.AppIcon.getInstance().requestAttention(project, false)
    }

    /** Allow: the token goes to the Piwi Picker that asked, on its next poll; the pairing is kept. */
    fun allow(project: Project, id: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val request = requests.waiting().firstOrNull { it.id == id }
            val token = request?.let { PiwiSendToken.ensure() }
            if (request == null || token == null || !requests.answer(id, token)) {
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) {
                        PiwiCommands.notify(
                            project,
                            "This pairing request no longer waits. Click Pair in Piwi Picker's settings again.",
                            NotificationType.WARNING,
                        )
                    }
                }
                return@executeOnPooledThread
            }
            val properties = PropertiesComponent.getInstance()
            properties.setValue(PAIRED_AT, System.currentTimeMillis().toString())
            properties.setValue(PAIRED_CLIENT, request.client)
            PiwiGetStarted.done("pair")
            changed()
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) PiwiNotifier.confirm(project, "Paired with Piwi Picker in ${request.client}.")
            }
        }
    }

    /** Unpair: a new token, and the pairing forgotten. Off the event thread: the token goes to the password safe. */
    fun unpair() {
        PiwiSendToken.renew()
        val properties = PropertiesComponent.getInstance()
        properties.unsetValue(PAIRED_AT)
        properties.unsetValue(PAIRED_CLIENT)
        properties.unsetValue(HEARD)
        changed()
    }
}

/**
 * The **Piwi Picker** tab of the Piwi tool window: a request Piwi Picker's Pair made, with Allow and Deny; once paired,
 * since when, when Piwi Picker was last heard from and the port it reaches this IDE on; not paired, how to pair. Its
 * words are `Glue.pickerRows`, as the VS Code extension's Piwi Picker view says them. **Pair with Piwi Picker** opens it.
 */
@Service(Service.Level.PROJECT)
class PiwiPickerTab(private val project: Project) : Disposable {
    private var tab: Content? = null

    /** Draws the tab again every half minute while it shows, for "Last heard 2 min ago". */
    private val redraw = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    /** The tab, opened or brought forward, and the tool window shown; focused when `focus`. On the event thread. */
    fun open(focus: Boolean = true) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return
        val shown = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
            ?: ContentFactory.getInstance().createContent(JBScrollPane(content()), TAB, false).apply {
                isCloseable = true
                val drawn = Disposer.newDisposable(this@PiwiPickerTab, "Piwi Picker tab")
                setDisposer {
                    Disposer.dispose(drawn)
                    if (tab === this) tab = null
                }
                window.contentManager.addContent(this)
                tab = this
            }
        window.contentManager.setSelectedContent(shown, focus)
        window.show()
        scheduleRedraw()
    }

    private fun scheduleRedraw() {
        redraw.cancelAllRequests()
        redraw.addRequest({
            if (tab != null) {
                drawAgain()
                scheduleRedraw()
            }
        }, REDRAW_MILLIS)
    }

    /** The tab drawn again as the pairing stands. On the event thread. */
    fun drawAgain() {
        val shown = tab ?: return
        (shown.component as? JBScrollPane)?.setViewportView(content())
    }

    private fun content(): JComponent {
        val state = Glue.PickerState(
            waiting = PiwiPickerPairing.requests.waiting(),
            paired = PiwiPickerPairing.paired(),
            heard = PiwiPickerPairing.heardAt(),
            port = BuiltInServerManager.getInstance().port,
        )
        val rows = Glue.pickerRows(state, System.currentTimeMillis())
        return panel {
            row { label(TAB).applyToComponent { font = JBUI.Fonts.label(16f).asBold() } }
            row { comment(Glue.PICKER_INTRO) }
            for (request in state.waiting) {
                group("${request.client} asks to pair") {
                    row { text(Glue.escapeHtml(Glue.pairingPrompt(request.client, request.code)), maxLineLength = 90) }
                    row {
                        button("Allow") { PiwiPickerPairing.allow(project, request.id) }
                        button("Deny") { PiwiPickerPairing.requests.answer(request.id, null) }
                    }
                }
            }
            if (rows.isEmpty()) {
                row { text(Glue.escapeHtml(Glue.PICKER_HOW_TO_PAIR), maxLineLength = 90) }
                row { browserLink("Get Piwi Picker", PiwiPickerPairing.GET_PICKER_URL) }
            }
            for (line in rows) {
                row {
                    icon(if (line.ok) AllIcons.General.InspectionsOK else AllIcons.General.Information)
                    label(line.label)
                    if (line.description.isNotEmpty()) comment(line.description)
                }
            }
            row {
                button("Copy the pairing address") { run("Piwi.CopyPickerAddress", it.source as? JComponent) }
                if (state.paired != null || state.heard != null) {
                    button("Unpair") { run("Piwi.UnpairPicker", it.source as? JComponent) }
                }
            }
            row { comment(Glue.escapeHtml(Glue.PICKER_ADDRESS_HINT)) }
        }.withBorder(JBUI.Borders.empty(8, 12))
    }

    /** One of the tab's actions, as from the tab. */
    private fun run(id: String, from: JComponent?) {
        val actions = ActionManager.getInstance()
        val action = actions.getAction(id) ?: return
        actions.tryToExecute(action, null, from, PLACE, true)
    }

    override fun dispose() {
        tab = null
    }

    companion object {
        const val TAB = "Piwi Picker"
        private const val PLACE = "PiwiPickerTab"
        private const val REDRAW_MILLIS = 30_000
    }
}
