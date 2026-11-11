package dev.piwitests.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Component
import java.awt.Container
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import java.awt.image.BufferedImage
import javax.swing.ImageIcon
import javax.swing.JCheckBox
import javax.swing.JLabel

/**
 * The native preview keeps watching and interaction separate, releases the keys held with a click, keeps Interact for
 * the next watch only when asked, and gives the stop back whenever Interact goes off, Escape included.
 */
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
        var givenBack = 0
        panel.interactOff = { givenBack++ }
        // Turned on, Interact only routes the input: it takes no stop.
        interact.doClick()
        assertTrue(panel.interacting)
        assertEquals(0, givenBack)
        // The stop went on: Interact stays selected for the next stop of the slot, unusable until its watch is accepted.
        panel.ended("The test went on.")
        assertFalse(live.isVisible)
        assertFalse(interact.isVisible)
        assertTrue(panel.liveWanted)
        assertTrue(interact.isSelected)
        panel.configureLive(true, true, true, keepInteract = true) { asked += it }
        assertTrue(live.isVisible)
        assertTrue(interact.isSelected)
        assertFalse(interact.isEnabled)
        panel.watching(true)
        assertTrue(interact.isEnabled)
        assertTrue(interact.isSelected)
        assertEquals(0, givenBack)
        // Another slot's stop, or one that takes no input, turns it off and gives the stop back.
        panel.configureLive(true, true, true) { asked += it }
        assertFalse(interact.isSelected)
        assertEquals(1, givenBack)
        panel.watching(true)
        interact.doClick()
        panel.configureLive(true, false, true, keepInteract = true) { asked += it }
        assertFalse(interact.isSelected)
        assertEquals(2, givenBack)
        // Between two stops, hiding the tab turns it off and gives the stop back too.
        panel.configureLive(true, true, true) { asked += it }
        panel.watching(true)
        interact.doClick()
        panel.ended("The test went on.")
        assertTrue(interact.isSelected)
        panel.visibilityChanged?.invoke(false)
        assertFalse(interact.isSelected)
        assertEquals(3, givenBack)
        // The run ended or the tab closed: it goes off, once.
        panel.configureLive(true, true, true) { asked += it }
        panel.watching(true)
        interact.doClick()
        panel.stopInteracting()
        panel.stopInteracting()
        assertFalse(interact.isSelected)
        assertEquals(4, givenBack)
        panel.configureLive(false, false, false) {}
        assertFalse(live.isVisible)
        assertFalse(interact.isVisible)
    }

    fun testInteractGoingOffGivesTheStopBackAndTurningItOnTakesNone() {
        val (panel, picture, sent) = interacting(clickCounts = true)
        val interact = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Interact" }
        val heard = mutableListOf<String>()
        panel.interactOff = { heard += "given back" }
        panel.releaseInput = { heard += "released" }
        interact.doClick()
        assertEquals(listOf("released", "given back"), heard)
        assertFalse(panel.interacting)
        heard.clear()
        interact.doClick()
        assertEquals(listOf("released"), heard)
        // Escape lets go of the input held, then turns Interact off, which gives the stop back.
        picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON1)) }
        heard.clear()
        picture.keyListeners.forEach { it.keyPressed(KeyEvent(picture, KeyEvent.KEY_PRESSED, 1L, 0, KeyEvent.VK_ESCAPE, KeyEvent.CHAR_UNDEFINED)) }
        assertEquals(listOf("released", "given back"), heard)
        assertFalse(interact.isSelected)
        // Escape while Interact is off sends nothing.
        sent.clear()
        heard.clear()
        picture.keyListeners.forEach { it.keyPressed(KeyEvent(picture, KeyEvent.KEY_PRESSED, 1L, 0, KeyEvent.VK_ESCAPE, KeyEvent.CHAR_UNDEFINED)) }
        assertEmpty(heard)
        assertEmpty(sent)
        // Watch live off, or a watch refused, turns Interact off and gives the stop back; off already, nothing more.
        interact.doClick()
        heard.clear()
        panel.watching(false)
        assertEquals(listOf("given back"), heard)
        panel.watching(false)
        assertEquals(listOf("given back"), heard)
    }

    /**
     * Watch live turned off with Interact on, and Interact going off as its watch ends (`letGo`), send the click held
     * back for a second one, then the release, then give the stop back: Watch live's change is told last.
     */
    fun testTheInputHeldGoesBeforeTheGiveBackAndTheEndOfTheWatch() {
        val heard = mutableListOf<String>()
        val panel = PausedPagePanel()
        panel.configureLive(true, true, false) { heard += "watch $it" }
        panel.input = { events -> heard += events.joinToString { "${it.type} ${it.action}" } }
        panel.releaseInput = { heard += "released" }
        panel.interactOff = { heard += "given back" }
        panel.show("Paused", BufferedImage(800, 600, BufferedImage.TYPE_INT_RGB))
        panel.viewport = PausedImage("image/jpeg", null, 800, 600)
        val live = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Watch live" }
        val interact = descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Interact" }
        val picture = descendants(panel).filterIsInstance<JLabel>().single { it.icon is ImageIcon }
        fun clickHeldBack() {
            live.doClick()
            panel.watching(true)
            interact.doClick()
            heard.clear()
            picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON1)) }
            picture.mouseListeners.forEach { it.mouseReleased(press(picture, MouseEvent.MOUSE_RELEASED, MouseEvent.BUTTON1)) }
            assertEmpty(heard)
        }
        clickHeldBack()
        live.doClick()
        assertEquals(listOf("mouse click", "released", "given back", "watch false"), heard)
        assertFalse(panel.interacting)
        panel.watching(false)
        clickHeldBack()
        panel.letGo()
        assertEquals(listOf("mouse click", "released", "given back"), heard)
        assertFalse(panel.interacting)
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
        // The next watch asked, Interact kept: input waits for it.
        panel.watching(false, keepInteract = true)
        assertTrue(interact.isSelected)
        assertFalse(interact.isEnabled)
        picture.mouseListeners.forEach { it.mousePressed(mouse(MouseEvent.MOUSE_PRESSED)) }
        assertEmpty(sent)
        panel.watching(false)
        assertFalse(interact.isSelected)
        assertFalse(interact.isEnabled)
    }

    fun testASecondButtonLetsGoOfTheFirstAndAPrintableCharacterIsPressed() {
        val (panel, picture, sent) = interacting(clickCounts = true)
        picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON1)) }
        picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON3)) }
        assertEquals(listOf(
            PageInput("mouse", "down", 10.0, 20.0, "left", 1),
            PageInput("mouse", "up", 10.0, 20.0, "left", 1),
            PageInput("mouse", "down", 10.0, 20.0, "right", 1),
        ), sent)
        sent.clear()
        picture.keyListeners.forEach { it.keyTyped(KeyEvent(picture, KeyEvent.KEY_TYPED, 1L, 0, KeyEvent.VK_UNDEFINED, ' ')) }
        picture.keyListeners.forEach { it.keyTyped(KeyEvent(picture, KeyEvent.KEY_TYPED, 1L, 0, KeyEvent.VK_UNDEFINED, 'é')) }
        assertEquals(listOf(PageInput("key", "press", key = " "), PageInput("text", text = "é")), sent)
        panel.watching(false)
    }

    fun testAStopWithoutClickCountsGetsOneClickWithItsCountAndADragAsButtonsHeld() {
        val (panel, picture, sent) = interacting(clickCounts = false)
        repeat(2) {
            picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON1)) }
            picture.mouseListeners.forEach { it.mouseReleased(press(picture, MouseEvent.MOUSE_RELEASED, MouseEvent.BUTTON1)) }
        }
        assertEmpty(sent)
        picture.keyListeners.forEach { it.keyTyped(KeyEvent(picture, KeyEvent.KEY_TYPED, 1L, 0, KeyEvent.VK_UNDEFINED, 'x')) }
        assertEquals(listOf(PageInput("mouse", "click", 10.0, 20.0, "left", 2), PageInput("key", "press", key = "x")), sent)
        sent.clear()
        picture.mouseListeners.forEach { it.mousePressed(press(picture, MouseEvent.MOUSE_PRESSED, MouseEvent.BUTTON1)) }
        picture.mouseMotionListeners.forEach { it.mouseDragged(press(picture, MouseEvent.MOUSE_DRAGGED, MouseEvent.BUTTON1, x = 60)) }
        picture.mouseListeners.forEach { it.mouseReleased(press(picture, MouseEvent.MOUSE_RELEASED, MouseEvent.BUTTON1, x = 60)) }
        assertEquals(listOf(
            PageInput("mouse", "down", 10.0, 20.0, "left"),
            PageInput("mouse", "move", 60.0, 20.0),
            PageInput("mouse", "up", 60.0, 20.0, "left"),
        ), sent)
        panel.watching(false)
    }

    private fun interacting(clickCounts: Boolean): Triple<PausedPagePanel, JLabel, MutableList<PageInput>> {
        val panel = PausedPagePanel()
        panel.configureLive(true, true, clickCounts) {}
        val sent = mutableListOf<PageInput>()
        panel.input = { sent += it }
        panel.show("Paused", BufferedImage(800, 600, BufferedImage.TYPE_INT_RGB))
        panel.viewport = PausedImage("image/jpeg", null, 800, 600)
        panel.watching(true)
        descendants(panel).filterIsInstance<JCheckBox>().single { it.text == "Interact" }.doClick()
        val picture = descendants(panel).filterIsInstance<JLabel>().single { it.icon is ImageIcon }
        return Triple(panel, picture, sent)
    }

    private fun press(source: JLabel, id: Int, button: Int, x: Int = 10) = MouseEvent(source, id, 1L, 0, x, 20, 1, false, button)

    private fun descendants(container: Container): List<Component> = container.components.flatMap {
        listOf(it) + if (it is Container) descendants(it) else emptyList()
    }
}
