package dev.piwitests.jetbrains

import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.IconLoader
import com.intellij.openapi.wm.StatusBar
import javax.swing.Icon

/**
 * What a Piwi notification is, and so its group in **Settings → Appearance & Behavior → Notifications**, where each
 * kind is shown, muted or logged on its own (`plugin.xml` declares the groups).
 */
enum class PiwiNotice(val group: String) {
    /** What a run, a job, a recording or an action came to. */
    RESULT("Piwi"),

    /** A question that waits for the person, such as Debug in my editor or a run shared live: it stays until answered. */
    REQUEST("Piwi requests"),

    /** An offer Piwi makes once, such as its MCP server or the desktop app: a suggestion. */
    OFFER("Piwi suggestions"),

    /** What went wrong: the editor service, a download, a refusal. */
    PROBLEM("Piwi problems"),
}

/**
 * Every Piwi balloon: titled Piwi, with Piwi's icon, in the group of its kind ([PiwiNotice]); a confirmation of what the
 * person just did goes to the status bar instead ([confirm]).
 */
object PiwiNotifier {
    private val ICON: Icon = IconLoader.getIcon("/icons/piwi.svg", PiwiNotifier::class.java)

    /** A balloon of `kind` saying `content` (HTML: escape plain text first), not shown until `notify`. */
    fun create(kind: PiwiNotice, content: String, type: NotificationType = NotificationType.INFORMATION): Notification =
        NotificationGroupManager.getInstance().getNotificationGroup(kind.group)
            .createNotification(TITLE, content, type)
            .setIcon(ICON)
            .setSuggestionType(kind == PiwiNotice.OFFER)

    /** The kind of a message `PiwiCommands.notify` shows: a warning or an error is a problem, anything else a result. */
    fun kindOf(type: NotificationType): PiwiNotice =
        if (type == NotificationType.WARNING || type == NotificationType.ERROR) PiwiNotice.PROBLEM else PiwiNotice.RESULT

    /** A confirmation of what the person just did (`Copied.`, `Connected to …`): the status bar's text, no balloon. */
    fun confirm(project: Project, message: String) {
        StatusBar.Info.set("$TITLE: $message", project)
    }

    const val TITLE = "Piwi"
}
