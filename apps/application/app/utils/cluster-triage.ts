/**
 * The status PATCH body of the cluster state line's Triage panel, or null when
 * the person changed nothing: the status, and the note only when they edited
 * it. A status change alone sends no note, so the server keeps the note as it
 * is stored, with the lines Piwi added since the page loaded.
 */
export function triagePanelPatch(
  draft: { status: string; note: string },
  stored: { status: string | null | undefined; triageNote: string | null | undefined },
): { status: string; triageNote?: string | null } | null {
  const note = draft.note.trim() || null;
  const noteChanged = note !== (stored.triageNote?.trim() || null);
  if (draft.status === stored.status && !noteChanged) return null;
  return noteChanged ? { status: draft.status, triageNote: note } : { status: draft.status };
}
