package dev.piwitests.jetbrains

import com.intellij.ui.JBColor
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.panels.HorizontalLayout
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.NamedColorUtil
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.ToolTipManager

/**
 * A test's card (`piwi/testCard`), as a click on its result icon shows it: its title by that icon, its latest results as
 * the dashboard's strip, each to its run, how they went, its latest failure and why, its owner, tags and quarantine,
 * then the links the click offers (**Run**, **Open in dashboard**, **More…**). The words are the service's, drawn as
 * plain text.
 */
internal object PiwiTestCard {
    /** A link at the card's foot. */
    class Link(val text: String, val icon: Icon, val act: () -> Unit)

    /**
     * The strip's colors: the `fill` of the dashboard's `STATUS_COLORS`, as the service's card draws them in VS Code
     * (`STRIP_FILLS`); `apps/application/tests/unit/status-mark-colors.test.ts` holds both to it.
     */
    val STATUS_FILLS: Map<String, Color> = mapOf(
        "passed" to Color(0x10b981),
        "failed" to Color(0xf43f5e),
        "flaky" to Color(0xd946ef),
        "skipped" to Color(0xa1a1aa),
    )

    /** The card of `card` for a test whose latest result is `status`; `browse` opens a run's or the test's page. */
    fun panel(card: TestCard, status: String?, links: List<Link>, browse: (String) -> Unit): JComponent {
        // The layouts scale their gaps themselves.
        val body = JPanel(VerticalLayout(6)).apply {
            isOpaque = false
            border = JBUI.Borders.empty(10, 12, 10, 12)
        }
        body.add(text(card.title.orEmpty()).apply {
            icon = PiwiIcons.outcome(status, turning = false)
            iconTextGap = JBUI.scale(6)
            font = JBFont.label().asBold()
        })
        val results = card.results.orEmpty()
        val history = JPanel(HorizontalLayout(8)).apply { isOpaque = false }
        // The strip reads as the dashboard's: oldest on the left, newest on the right.
        if (results.isNotEmpty()) history.add(ResultStrip(results.reversed(), browse))
        card.summary?.takeIf { it.isNotBlank() }?.let { history.add(hint(it)) }
        if (history.componentCount > 0) body.add(history)
        card.failure?.let { failure ->
            val block = JPanel(VerticalLayout(2)).apply {
                isOpaque = false
                border = JBUI.Borders.emptyTop(2)
            }
            failure.where?.let { block.add(hint(it)) }
            failure.why?.takeIf { it.isNotBlank() }?.let { block.add(text(it).apply { foreground = NamedColorUtil.getErrorForeground() }) }
            body.add(block)
        }
        card.about?.filter { it.isNotBlank() }?.takeIf { it.isNotEmpty() }?.let { body.add(hint(it.joinToString(" · "))) }

        val foot = JPanel(HorizontalLayout(16)).apply {
            isOpaque = false
            border = JBUI.Borders.compound(
                JBUI.Borders.customLineTop(JBUI.CurrentTheme.Popup.separatorColor()),
                JBUI.Borders.empty(6, 12, 7, 12),
            )
        }
        for (link in links) {
            foot.add(ActionLink(link.text) { link.act() }.apply { icon = link.icon })
        }
        return JPanel(BorderLayout()).apply {
            background = JBUI.CurrentTheme.Editor.Tooltip.BACKGROUND
            add(body, BorderLayout.CENTER)
            if (links.isNotEmpty()) add(foot, BorderLayout.SOUTH)
        }
    }

    /**
     * A line of the card's words: text from a run, never HTML. The label is made empty: a label made with its text reads
     * it as HTML before `html.disable` is set, and loads the images it names.
     */
    private fun text(words: String): JBLabel = JBLabel().apply {
        putClientProperty("html.disable", true)
        horizontalAlignment = SwingConstants.LEFT
        text = words
    }

    /** A line of the card's words in the secondary color. */
    private fun hint(words: String): JBLabel = text(words).apply { foreground = UIUtil.getContextHelpForeground() }

    /**
     * The latest results as the dashboard's strip, one bar each in its outcome's color, oldest first: a bar's tooltip
     * says its run, and a click on it opens the run.
     */
    private class ResultStrip(private val results: List<TestCardResult>, private val browse: (String) -> Unit) : JComponent() {
        private val bar get() = JBUI.scale(6)
        private val gap get() = JBUI.scale(2)
        private val tall get() = JBUI.scale(14)

        init {
            ToolTipManager.sharedInstance().registerComponent(this)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) at(e.x)?.let { results[it].url }?.let(browse)
                }
            })
        }

        /** The index of the bar at `x`; null between bars and past the last. */
        private fun at(x: Int): Int? {
            if (x < 0) return null
            val index = x / (bar + gap)
            return index.takeIf { it < results.size && x - it * (bar + gap) < bar }
        }

        override fun getPreferredSize(): Dimension = Dimension(maxOf(0, results.size * (bar + gap) - gap), tall)

        override fun getMinimumSize(): Dimension = preferredSize

        override fun getToolTipText(event: MouseEvent): String? = at(event.x)?.let { results[it].label }?.let(Glue::htmlTooltip)

        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                val arc = JBUI.scale(3)
                val top = (height - tall) / 2
                results.forEachIndexed { i, result ->
                    g2.color = STATUS_FILLS[result.status] ?: JBColor.GRAY
                    g2.fillRoundRect(i * (bar + gap), top, bar, tall, arc, arc)
                }
            } finally {
                g2.dispose()
            }
        }
    }
}
