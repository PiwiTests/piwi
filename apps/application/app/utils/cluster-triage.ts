/**
 * The status PATCH body of the cluster state line's Triage panel, or null when
 * the person changed nothing: the status only when they changed it, and the
 * note only when they edited it. What they left alone is not sent, so the
 * server keeps it as it is stored: a status Piwi set or a line it added since
 * the page loaded.
 */
export function triagePanelPatch(
  draft: { status: string; note: string },
  stored: { status: string | null | undefined; triageNote: string | null | undefined },
): { status?: string; triageNote?: string | null } | null {
  const note = draft.note.trim() || null;
  const statusChanged = draft.status !== (stored.status ?? 'open');
  const noteChanged = note !== (stored.triageNote?.trim() || null);
  if (!statusChanged && !noteChanged) return null;
  return { ...(statusChanged ? { status: draft.status } : {}), ...(noteChanged ? { triageNote: note } : {}) };
}
