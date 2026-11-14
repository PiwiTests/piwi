package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.ui.MessageType
import com.intellij.openapi.ui.popup.Balloon
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import java.awt.Component
import java.awt.Image
import java.util.concurrent.ConcurrentHashMap
import javax.swing.Icon
import javax.swing.ImageIcon
import javax.swing.JComponent

/**
 * **Get started**: the onboarding script (`OnboardingSteps`) as a tab of the Piwi tool window, each step with its
 * button, its screenshot where the docs have one, and a check mark once done: the connection while this project is
 * connected, any other step once its action succeeded somewhere (`done`). It opens once per installation, on the first
 * trusted project that holds a Playwright config, and `Piwi.GetStarted` opens it again.
 */
@Service(Service.Level.PROJECT)
class PiwiGetStarted(private val project: Project) : Disposable {
    private var tab: Content? = null

    /** Whether the tab last drew this project as connected: a change draws it again. */
    private var drawnConnected = false

    /** The tab, opened or brought forward, and the tool window shown; focused when `focus`. Whether it could open. */
    fun open(focus: Boolean = true): Boolean {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return false
        val shown = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
            ?: ContentFactory.getInstance().createContent(JBScrollPane(content()), TAB, false).apply {
                isCloseable = true
                val watching = Disposer.newDisposable(this@PiwiGetStarted, "Piwi Get started tab")
                setDisposer {
                    Disposer.dispose(watching)
                    if (tab === this) tab = null
                }
                project.service<PiwiProjectService>().onChange(watching) { if (connected() != drawnConnected) drawAgain() }
                window.contentManager.addContent(this)
                tab = this
            }
        window.contentManager.setSelectedContent(shown, focus)
        window.show()
        return true
    }

    /** The tab drawn again, its check marks as the steps stand. On the event thread. */
    fun drawAgain() {
        val shown = tab ?: return
        (shown.component as? JBScrollPane)?.setViewportView(content())
    }

    private fun connected(): Boolean = project.service<PiwiProjectService>().status?.contexts.orEmpty().any { it.connected }

    private fun content(): JComponent {
        drawnConnected = connected()
        return panel {
            row { label(OnboardingSteps.TITLE).applyToComponent { font = JBUI.Fonts.label(16f).asBold() } }
            row { comment(OnboardingSteps.DESCRIPTION) }
            for (step in OnboardingSteps.STEPS) {
                val done = if (step.id == "connect") drawnConnected else isDone(step.id)
                group(step.title) {
                    row {
                        if (done) icon(AllIcons.Actions.Checked).comment("Done")
                        text(Glue.onboardingHtml(step.text), maxLineLength = 90)
                    }
                    row { button(step.label) { e -> run(step, e.source as? JComponent) } }
                    step.image?.let(::image)?.let { image -> row { icon(image) } }
                }
            }
        }.withBorder(JBUI.Borders.empty(8, 12))
    }

    /**
     * Run a step's action as from the editor in use, which an action on the code at the caret needs; one that cannot run
     * now says so beside its button.
     */
    private fun run(step: OnboardingSteps.Step, button: JComponent?) {
        val actions = ActionManager.getInstance()
        val action = actions.getAction(step.actionId) ?: return
        val from: Component? = FileEditorManager.getInstance(project).selectedTextEditor?.contentComponent ?: button
        actions.tryToExecute(action, null, from, PLACE, true).doWhenRejected(Runnable {
            if (button == null || !button.isShowing) return@Runnable
            JBPopupFactory.getInstance()
                .createHtmlTextBalloonBuilder(Glue.escapeHtml(Glue.notNowText(step.label)), MessageType.INFO, null)
                .setFadeoutTime(6_000)
                .createBalloon()
                .show(RelativePoint.getSouthOf(button), Balloon.Position.below)
        })
    }

    override fun dispose() {
        tab = null
    }

    /** Get started: the tab of the onboarding script, from Tools → Piwi, the tool window's gear menu and Help. */
    class Open : AnAction(), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabledAndVisible = e.project != null
        }

        override fun actionPerformed(e: AnActionEvent) {
            e.project?.service<PiwiGetStarted>()?.open()
        }
    }

    companion object {
        const val TAB = "Get started"

        private const val PLACE = "PiwiGetStarted"

        /** Whether the tab was opened on its own once: an application-level property. */
        const val SHOWN = "piwi.getStartedShown"

        private const val DONE = "piwi.getStarted.done."

        /** The widest a screenshot is drawn, in pixels before the IDE's scale. */
        private const val IMAGE_WIDTH = 560

        /** Each screenshot, decoded and scaled once. */
        private val images = ConcurrentHashMap<String, Icon>()

        fun isDone(step: String): Boolean = PropertiesComponent.getInstance().getBoolean(DONE + step)

        /** Check `step` off, once, from where its action succeeded, and draw the open tabs again. */
        fun done(step: String) {
            val properties = PropertiesComponent.getInstance()
            if (properties.getBoolean(DONE + step)) return
            properties.setValue(DONE + step, true)
            ApplicationManager.getApplication().invokeLater {
                for (project in ProjectManager.getInstance().openProjects) {
                    if (!project.isDisposed) project.getServiceIfCreated(PiwiGetStarted::class.java)?.drawAgain()
                }
            }
        }

        /** A step's screenshot from `onboarding/`, drawn at `IMAGE_WIDTH` at most. */
        private fun image(name: String): Icon? = images[name] ?: run {
            val url = PiwiGetStarted::class.java.getResource("/onboarding/$name") ?: return null
            val full = ImageIcon(url)
            if (full.iconWidth <= 0) return null
            val width = JBUI.scale(IMAGE_WIDTH).coerceAtMost(full.iconWidth)
            val height = full.iconHeight * width / full.iconWidth
            ImageIcon(full.image.getScaledInstance(width, height, Image.SCALE_SMOOTH)).also { images[name] = it }
        }
    }
}
