package dev.piwitests.jetbrains

import com.intellij.notification.Notification
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.text.StringUtil

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

    /** What went wrong: the editor service, a download, a project Piwi waits for. */
    PROBLEM("Piwi problems"),

    /** A confirmation of what the person just did (`Copied.`, `Connected to …`): it fades on its own. */
    CONFIRMATION("Piwi confirmations"),
}

/**
 * Every Piwi balloon: titled Piwi (a run's verdict, by its run), in the group of its kind ([PiwiNotice]), with Piwi's
 * icon when it is an information (a warning or an error keeps the platform's icon, which says how serious it is).
 */
object PiwiNotifier {

    /**
     * A balloon of `kind` saying `content` (HTML: escape plain text first), not shown until `notify`, titled Piwi or,
     * for a run's verdict, by its run (`Glue.runVerdictTitle`).
     */
    fun create(
        kind: PiwiNotice,
        content: String,
        type: NotificationType = NotificationType.INFORMATION,
        title: String = TITLE,
    ): Notification =
        NotificationGroupManager.getInstance().getNotificationGroup(kind.group)
            .createNotification(title, content, type)
            .setIcon(if (type == NotificationType.INFORMATION) PiwiIcons.PIWI else null)
            .setSuggestionType(kind == PiwiNotice.OFFER)

    /** The kind of a message `PiwiCommands.notify` shows: a warning or an error is a problem, anything else a result. */
    fun kindOf(type: NotificationType): PiwiNotice =
        if (type == NotificationType.WARNING || type == NotificationType.ERROR) PiwiNotice.PROBLEM else PiwiNotice.RESULT

    /** A confirmation of what the person just did (`Copied.`, `Connected to …`), plain text, in its own group. */
    fun confirm(project: Project, message: String) {
        create(PiwiNotice.CONFIRMATION, StringUtil.escapeXmlEntities(message)).notify(project)
    }

    const val TITLE = "Piwi"
}
