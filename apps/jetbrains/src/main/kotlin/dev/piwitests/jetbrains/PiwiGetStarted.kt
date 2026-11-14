package dev.piwitests.jetbrains

import com.intellij.icons.AllIcons
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.AnActionResult
import com.intellij.openapi.actionSystem.ex.AnActionListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import java.awt.Image
import javax.swing.ImageIcon
import javax.swing.JComponent

/**
 * **Get started**: the onboarding script (`OnboardingSteps`) as a tab of the Piwi tool window, each step with its
 * button, its screenshot where the docs have one, and a check mark once done. It opens once per installation, on the
 * first trusted project that holds a Playwright config, and `Piwi.GetStarted` opens it again.
 */
@Service(Service.Level.PROJECT)
class PiwiGetStarted(private val project: Project) : Disposable {
    private var tab: Content? = null

    /** The tab, opened or brought forward, and the tool window shown; focused when `focus`. */
    fun open(focus: Boolean = true) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(PiwiFailuresToolWindowFactory.ID) ?: return
        val shown = tab?.takeIf { window.contentManager.getIndexOfContent(it) >= 0 }
            ?: ContentFactory.getInstance().createContent(JBScrollPane(content()), TAB, false).apply {
                isCloseable = true
                setDisposer { if (tab === this) tab = null }
                window.contentManager.addContent(this)
                tab = this
            }
        window.contentManager.setSelectedContent(shown, focus)
        window.show()
    }

    /** The tab drawn again, its check marks as the steps stand. On the event thread. */
    fun drawAgain() {
        val shown = tab ?: return
        (shown.component as? JBScrollPane)?.setViewportView(content())
    }

    private fun content(): JComponent {
        val connected = project.service<PiwiProjectService>().status?.contexts.orEmpty().any { it.connected }
        return panel {
            row { label(OnboardingSteps.TITLE).applyToComponent { font = JBUI.Fonts.label(16f).asBold() } }
            row { comment(OnboardingSteps.DESCRIPTION) }
            for (step in OnboardingSteps.STEPS) {
                val done = isDone(step.id) || (step.id == "connect" && connected)
                group(step.title) {
                    row {
                        if (done) icon(AllIcons.Actions.Checked).comment("Done")
                        text(Glue.onboardingHtml(step.text), maxLineLength = 90)
                    }
                    row {
                        button(step.label) { e ->
                            val actions = ActionManager.getInstance()
                            actions.getAction(step.actionId)?.let { actions.tryToExecute(it, null, e.source as? java.awt.Component, PLACE, true) }
                        }
                    }
                    step.image?.let(::image)?.let { image -> row { icon(image) } }
                }
            }
        }.withBorder(JBUI.Borders.empty(8, 12))
    }

    override fun dispose() {
        tab = null
    }

    /** Get started: the tab of the onboarding script, from Tools → Piwi, the tool window's gear menu and Help. */
    class Open : AnAction(), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.BGT

        override fun actionPerformed(e: AnActionEvent) {
            e.project?.service<PiwiGetStarted>()?.open()
        }
    }

    /** Checks a step off once the action of its button ran, from the tab or anywhere else. */
    class Progress : AnActionListener {
        override fun afterActionPerformed(action: AnAction, event: AnActionEvent, result: AnActionResult) {
            val id = ActionManager.getInstance().getId(action) ?: return
            OnboardingSteps.STEPS.filter { it.actionId == id }.forEach { done(it.id) }
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

        fun isDone(step: String): Boolean = PropertiesComponent.getInstance().getBoolean(DONE + step)

        /** Check `step` off, once, and draw the open tabs again. */
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
        private fun image(name: String): ImageIcon? {
            val url = PiwiGetStarted::class.java.getResource("/onboarding/$name") ?: return null
            val full = ImageIcon(url)
            if (full.iconWidth <= 0) return null
            val width = JBUI.scale(IMAGE_WIDTH).coerceAtMost(full.iconWidth)
            val height = full.iconHeight * width / full.iconWidth
            return ImageIcon(full.image.getScaledInstance(width, height, Image.SCALE_SMOOTH))
        }
    }
}
