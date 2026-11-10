package dev.piwitests.jetbrains

import com.intellij.codeInsight.codeVision.CodeVisionAnchorKind
import com.intellij.codeInsight.codeVision.CodeVisionEntry
import com.intellij.codeInsight.codeVision.CodeVisionRelativeOrdering
import com.intellij.codeInsight.codeVision.settings.CodeVisionGroupSettingProvider
import com.intellij.codeInsight.codeVision.ui.model.ClickableTextCodeVisionEntry
import com.intellij.codeInsight.hints.codeVision.DaemonBoundCodeVisionProvider
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiFile

/**
 * The lines above a file, a test and a locator (`piwi/fileSummary`): the
 * tests behind each locator line, each test's pass rate, the tests that reach
 * an application file, a failure's reason and evidence. A click runs what the
 * entry names.
 *
 * The platform draws one entry per provider on a line, so a line's entries are
 * drawn by one provider each, in their order: this one the first, then
 * [PiwiCodeVisionSlot2] to [PiwiCodeVisionSlot8], all in the group
 * [PiwiCodeVisionProvider.GROUP_ID] that the settings name Piwi
 * ([PiwiCodeVisionSettings]).
 */
open class PiwiCodeVisionProvider(private val slot: Int = 0) : DaemonBoundCodeVisionProvider {
    override val id = providerId(slot)
    override val name = "Piwi"
    override val groupId = GROUP_ID
    override val defaultAnchor: CodeVisionAnchorKind = CodeVisionAnchorKind.Top
    override val relativeOrderings: List<CodeVisionRelativeOrdering> =
        if (slot == 0) {
            listOf(CodeVisionRelativeOrdering.CodeVisionRelativeOrderingFirst)
        } else {
            listOf(CodeVisionRelativeOrdering.CodeVisionRelativeOrderingAfter(providerId(slot - 1)))
        }

    override fun computeForEditor(editor: Editor, file: PsiFile): List<Pair<TextRange, CodeVisionEntry>> {
        val project = editor.project ?: return emptyList()
        val virtualFile = file.virtualFile ?: return emptyList()
        if (!PiwiLspServerSupportProvider.isSupported(virtualFile)) return emptyList()
        val document = editor.document
        // The daemon computes this in a read action: the wait gives way to a write action. The gutter's request for the
        // same text answers it, and so does each slot's, whichever comes first.
        val summary = project.service<PiwiProjectService>()
            .fileSummary(virtualFile, document.modificationStamp)
            ?.awaitCancellably(3_000)
            ?: return emptyList()
        return Glue.codeVisionSlot(summary, slot).mapNotNull { line ->
            if (line.line < 0 || line.line >= document.lineCount) return@mapNotNull null
            val range = TextRange(document.getLineStartOffset(line.line), document.getLineEndOffset(line.line))
            val entry = ClickableTextCodeVisionEntry(line.title.orEmpty(), id, { _, _ ->
                line.command?.let { PiwiCommands.execute(project, it.command, it.arguments.orEmpty()) }
            })
            range to entry
        }
    }

    companion object {
        /** The group every slot belongs to, which Settings → Editor → Inlay Hints → Code Vision shows as Piwi. */
        const val GROUP_ID = "piwi.summary"

        /** The id of the provider of a line's entry at `slot`: the first keeps the group's id. */
        fun providerId(slot: Int) = if (slot == 0) GROUP_ID else "$GROUP_ID.${slot + 1}"
    }
}

class PiwiCodeVisionSlot2 : PiwiCodeVisionProvider(1)
class PiwiCodeVisionSlot3 : PiwiCodeVisionProvider(2)
class PiwiCodeVisionSlot4 : PiwiCodeVisionProvider(3)
class PiwiCodeVisionSlot5 : PiwiCodeVisionProvider(4)
class PiwiCodeVisionSlot6 : PiwiCodeVisionProvider(5)
class PiwiCodeVisionSlot7 : PiwiCodeVisionProvider(6)
class PiwiCodeVisionSlot8 : PiwiCodeVisionProvider(7)

/** Piwi's lines in the Code Vision settings, so they can be hidden or moved apart from the IDE's own. */
class PiwiCodeVisionSettings : CodeVisionGroupSettingProvider {
    override val groupId = PiwiCodeVisionProvider.GROUP_ID
    override val groupName = "Piwi"
    override val description =
        "Piwi's lines above a spec, a test and a locator: the tests behind a locator, a test's pass rate, a failure's " +
            "reason, Run this test, its screenshot and trace, and Flake Lab."
}
