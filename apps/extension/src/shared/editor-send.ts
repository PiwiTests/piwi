/**
 * Send to editor, from a content script or a DevTools page: neither reaches
 * the editor itself; the background worker posts (`piwi-send-to-editor`) with
 * the pairing it keeps (`editor-pairing.ts`).
 */
import type { EditorSendPayload } from '@piwitests/core/editor-send';
import { flashLabel } from './clipboard.js';
import { t } from './i18n.js';
import { outdatedWorkerMessage } from './worker-status.js';

export type SendToEditorResult = { ok: true; file: string | null } | { ok: false; error: string };

/** Asks the background worker to send to the paired editor. */
export async function sendToEditor(payload: EditorSendPayload): Promise<SendToEditorResult> {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-send-to-editor', payload })) as
      | SendToEditorResult
      | undefined;
    return answer ?? { ok: false, error: outdatedWorkerMessage() };
  } catch {
    return { ok: false, error: t('common_workerNoAnswer') };
  }
}

/** A Send to editor button's feedback: its label for a moment, and the reason in its tooltip on failure. */
export function showSendResult(btn: HTMLButtonElement, result: SendToEditorResult): void {
  // A second click meanwhile restarts the feedback, and the label still goes back to the button's own.
  flashLabel(
    btn,
    result.ok ? t('common_sentToEditor') : t('common_sendToEditorFailed'),
    1500,
    result.ok ? 'ok' : 'fail',
  );
  btn.title = result.ok ? '' : result.error;
}
