package dev.piwitests.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.components.ActionLink
import com.sun.net.httpserver.HttpServer
import java.awt.Component
import java.awt.Container
import java.awt.event.InputEvent
import java.awt.event.MouseEvent
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.plaf.basic.BasicHTML

/** A test's card draws the service's words as plain text, its strip one bar per result to its run, then its links. */
class PiwiTestCardTest : BasePlatformTestCase() {
    private val card = TestCard(
        testCaseId = 4,
        title = "checkout › <b>pays</b> by card",
        url = "https://piwi.test/test-cases/4",
        results = listOf(
            TestCardResult("failed", 124, "https://piwi.test/test-runs/124", null, 15_400, "run #124 · failed · 15.4 s"),
            TestCardResult("passed", 123, "https://piwi.test/test-runs/123", null, 3_100, "run #123 · passed · 3.1 s"),
        ),
        summary = "Passed 1 of the last 2 runs · median 9.3 s",
        failure = TestCardFailure(124, "https://piwi.test/test-runs/124", "Last failed in run #124, 2 h ago", "<img src=x> was not found"),
        about = listOf("owner alice", "@smoke"),
    )

    fun testTheServicesWordsAreDrawnAsPlainText() {
        val panel = PiwiTestCard.panel(card, "failed", emptyList()) {}
        val labels = descendants(panel).filterIsInstance<JLabel>()
        assertEquals(
            listOf(
                "checkout › <b>pays</b> by card",
                "Passed 1 of the last 2 runs · median 9.3 s",
                "Last failed in run #124, 2 h ago",
                "<img src=x> was not found",
                "owner alice · @smoke",
            ),
            labels.map { it.text },
        )
        for (label in labels) assertEquals(label.text, true, label.getClientProperty("html.disable"))
    }

    fun testATextThatStartsAsHtmlIsNeverReadAsHtml() {
        val asked = AtomicInteger()
        val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/") { exchange ->
            asked.incrementAndGet()
            exchange.sendResponseHeaders(404, -1)
            exchange.close()
        }
        server.start()
        try {
            val image = "<html><img src=\"http://127.0.0.1:${server.address.port}/x.png\">"
            val html = card.copy(title = "${image}pays", failure = card.failure!!.copy(why = "${image}boom"))
            val panel = PiwiTestCard.panel(html, "failed", emptyList()) {}
            val labels = descendants(panel).filterIsInstance<JLabel>()
            assertEquals(listOf("${image}pays", "${image}boom"), labels.map { it.text }.filter { it.startsWith("<html>") })
            for (label in labels) assertNull(label.text, label.getClientProperty(BasicHTML.propertyKey))
            assertEquals(0, asked.get())
        } finally {
            server.stop(0)
        }
    }

    fun testTheStripOpensEachResultsRunOldestFirstAndNamesItInItsTooltip() {
        val opened = mutableListOf<String>()
        val panel = PiwiTestCard.panel(card, "failed", emptyList()) { opened += it }
        val strip = descendants(panel).filterIsInstance<JComponent>().single { it.javaClass.simpleName == "ResultStrip" }
        strip.setSize(strip.preferredSize)
        val first = MouseEvent(strip, MouseEvent.MOUSE_CLICKED, 0, 0, 1, strip.height / 2, 1, false)
        val last = MouseEvent(strip, MouseEvent.MOUSE_CLICKED, 0, 0, strip.width - 1, strip.height / 2, 1, false)
        assertEquals("<html>run #123 · passed · 3.1 s</html>", strip.getToolTipText(first))
        assertEquals("<html>run #124 · failed · 15.4 s</html>", strip.getToolTipText(last))
        val click = MouseEvent(strip, MouseEvent.MOUSE_CLICKED, 0, 0, strip.width - 1, strip.height / 2, 1, false, MouseEvent.BUTTON1)
        strip.mouseListeners.forEach { it.mouseClicked(click) }
        assertEquals(listOf("https://piwi.test/test-runs/124"), opened)
        // A right click is the context menu's gesture: it opens nothing.
        val right = MouseEvent(strip, MouseEvent.MOUSE_CLICKED, 0, InputEvent.META_DOWN_MASK, 1, strip.height / 2, 1, false, MouseEvent.BUTTON3)
        strip.mouseListeners.forEach { it.mouseClicked(right) }
        assertEquals(1, opened.size)
    }

    fun testTheLinksActInTheirOrder() {
        val acted = mutableListOf<String>()
        val links = listOf("Run", "Open in dashboard", "More…").map { name ->
            PiwiTestCard.Link(name, PiwiIcons.OPEN_IN_DASHBOARD) { acted += name }
        }
        val panel = PiwiTestCard.panel(card.copy(failure = null, about = null), "failed", links) {}
        val drawn = descendants(panel).filterIsInstance<ActionLink>()
        assertEquals(listOf("Run", "Open in dashboard", "More…"), drawn.map { it.text })
        drawn.forEach { it.doClick() }
        assertEquals(listOf("Run", "Open in dashboard", "More…"), acted)
    }

    private fun descendants(container: Container): List<Component> = container.components.flatMap {
        listOf(it) + if (it is Container) descendants(it) else emptyList()
    }
}
