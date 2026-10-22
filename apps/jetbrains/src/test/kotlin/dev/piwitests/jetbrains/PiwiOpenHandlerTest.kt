package dev.piwitests.jetbrains

import com.intellij.openapi.components.service
import com.intellij.openapi.util.io.FileUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

class PiwiOpenHandlerTest : BasePlatformTestCase() {
    /** The handler reads the addresses the project service read last: the snapshot the settings, the configs and the status refresh. */
    private fun refresh() = project.service<PiwiProjectService>().readKnownAddresses()

    fun testOpensFilesOnlyForTheInstanceAProjectIsConnectedTo() = withHome(desktopJson = null) {
        val settings = project.service<PiwiSettings>().state
        val saved = settings.serverUrl
        val handler = PiwiOpenHandler()
        try {
            settings.serverUrl = ""
            refresh()
            assertFalse("no instance named, nothing is trusted", handler.trusts("https://piwi.example.com"))

            settings.serverUrl = "https://piwi.example.com"
            assertFalse("the addresses are read when the settings are saved, not per request", handler.trusts("https://piwi.example.com"))
            refresh()
            assertTrue(handler.trusts("https://piwi.example.com"))
            assertEquals("the files of the project connected to it", listOf(project), handler.projectsFor("https://piwi.example.com"))
            assertEquals("no project for another site", emptyList<Any>(), handler.projectsFor("https://evil.example"))
            assertFalse("another site", handler.trusts("https://evil.example"))
            assertFalse("a page on this machine", handler.trusts("http://localhost:5173"))
            assertFalse("a request without an origin", handler.trusts(null))
            assertFalse("a local file or a sandboxed frame", handler.trusts("null"))

            settings.serverUrl = "http://localhost:3000"
            refresh()
            assertTrue("the same server under another loopback name", handler.trusts("http://127.0.0.1:3000"))
            assertFalse("another server on this machine", handler.trusts("http://127.0.0.1:3001"))
        } finally {
            settings.serverUrl = saved
            refresh()
        }
    }

    fun testOpensFilesForTheDesktopApp() {
        // PIWI_DESKTOP_CONFIG names another discovery file than the home folder's.
        if (!System.getenv("PIWI_DESKTOP_CONFIG").isNullOrBlank()) return
        val handler = PiwiOpenHandler()
        withHome(desktopJson = """{"url":"http://127.0.0.1:41234/","token":"t"}""") {
            refresh()
            assertTrue(handler.trusts("http://127.0.0.1:41234"))
            assertTrue("the same server under another loopback name", handler.trusts("http://localhost:41234"))
            assertEquals("every open project, none connected to an instance", listOf(project), handler.projectsFor("http://127.0.0.1:41234"))
            assertFalse("another server on this machine", handler.trusts("http://127.0.0.1:41235"))
        }
        withHome(desktopJson = null) {
            refresh()
            assertFalse("the desktop app does not run", handler.trusts("http://127.0.0.1:41234"))
        }
    }

    /** Runs [block] with a home folder that holds [desktopJson] as the desktop app's discovery file, or none. */
    private fun withHome(desktopJson: String?, block: () -> Unit) {
        val home = FileUtil.createTempDirectory("piwi-home", null)
        if (desktopJson != null) File(home, ".piwi").apply { mkdirs() }.resolve("desktop.json").writeText(desktopJson)
        val saved = System.getProperty("user.home")
        System.setProperty("user.home", home.path)
        try {
            block()
        } finally {
            System.setProperty("user.home", saved)
        }
    }
}
