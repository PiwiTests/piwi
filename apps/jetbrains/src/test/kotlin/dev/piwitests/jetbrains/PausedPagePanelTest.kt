package dev.piwitests.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Component
import java.awt.Container
import java.awt.event.InputEvent
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import javax.swing.ImageIcon
import javax.swing.JCheckBox
import javax.swing.JLabel

/** The native preview keeps watching and interaction separate, and releases the keys held with a click. */
class PausedPagePanelTest : BasePlatformTestCase() {
    fun testWatchingAndInteractionAreOptInAndAnOlderReporterShowsNeither() {
        val panel = PausedPagePanel()
        val asked = mutableListOf<Boolean>()
        panel.configureLive(true, true, true) { asked += it }
        val live = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Watch live" }
        val interact = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Interact" }
        assertFalse(live.isSelected)
        assertFalse(interact.isSelected)
        assertFalse(interact.isEnabled)
        live.doClick()
        assertEquals(listOf(true), asked)
        panel.watching(true)
        assertTrue(interact.isEnabled)
        assertFalse(interact.isSelected)
        panel.ended("The test went on.")
        assertFalse(live.isVisible)
        assertFalse(interact.isVisible)
        assertTrue(panel.liveWanted)
        panel.configureLive(true, true, true) { asked += it }
        assertTrue(live.isVisible)
        panel.configureLive(false, false, false) {}
        assertFalse(live.isVisible)
        assertFalse(interact.isVisible)
    }

    fun testMouseInputUsesViewportCoordinatesAndReleasesItsClickCountAndModifiers() {
        val panel = PausedPagePanel()
        panel.configureLive(true, true, true) {}
        val sent = mutableListOf<PageInput>()
        panel.input = { sent += it }
        panel.show("Paused", BufferedImage(800, 600, BufferedImage.TYPE_INT_RGB))
        panel.viewport = PausedImage("image/jpeg", null, 400, 300)
        panel.watching(true)
        val interact = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Interact" }
        val picture = descendants(panel).filterIsInstance<JLabel>().single { it.icon is ImageIcon }
        fun mouse(id: Int, modifiers: Int = InputEvent.CTRL_DOWN_MASK) = MouseEvent(picture, id, 1L, modifiers, 200, 100, 2, false, MouseEvent.BUTTON1)
        picture.mouseListeners.forEach { it.mousePressed(mouse(MouseEvent.MOUSE_PRESSED)) }
        assertEmpty(sent)
        interact.doClick()
        picture.mouseListeners.forEach { it.mousePressed(mouse(MouseEvent.MOUSE_PRESSED)) }
        picture.mouseListeners.forEach { it.mouseReleased(mouse(MouseEvent.MOUSE_RELEASED)) }
        assertEquals(listOf(
            PageInput("key", "down", key = "Control"),
            PageInput("mouse", "down", 100.0, 50.0, "left", 2),
            PageInput("mouse", "up", 100.0, 50.0, "left", 2),
            PageInput("key", "up", key = "Control"),
        ), sent)
        sent.clear()
        picture.mouseListeners.forEach { it.mousePressed(mouse(MouseEvent.MOUSE_PRESSED, InputEvent.SHIFT_DOWN_MASK)) }
        assertEmpty(sent)
        panel.watching(false)
        assertFalse(interact.isSelected)
        assertFalse(interact.isEnabled)
    }

    private fun descendants(container: Container): List<Component> = container.components.flatMap {
        listOf(it) + if (it is Container) descendants(it) else emptyList()
    }
}
