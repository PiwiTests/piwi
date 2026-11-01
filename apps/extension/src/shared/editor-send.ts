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

/** The status line of each Send to editor button that has shown a failure. */
const statusLines = new WeakMap<HTMLButtonElement, HTMLElement>();

/**
 * A Send to editor button's feedback: its label for a moment, and on failure the reason in a status line at the end of
 * the button's row, under its buttons, which the next result replaces or empties.
 */
export function showSendResult(btn: HTMLButtonElement, result: SendToEditorResult): void {
  // A second click meanwhile restarts the feedback, and the label still goes back to the button's own.
  flashLabel(
    btn,
    result.ok ? t('common_sentToEditor') : t('common_sendToEditorFailed'),
    1500,
    result.ok ? 'ok' : 'fail',
  );
  const reason = result.ok ? '' : result.error;
  const shown = statusLines.get(btn);
  if (shown?.isConnected) {
    shown.textContent = reason;
    return;
  }
  if (!reason) return;
  const line = btn.ownerDocument.createElement('div');
  line.className = SEND_STATUS_CLASS;
  line.setAttribute('role', 'status');
  if (btn.parentElement) btn.parentElement.append(line);
  else btn.after(line);
  statusLines.set(btn, line);
  // A live region is read out as its text changes, not as it is added with its text: an empty one stays in the
  // accessibility tree, out of sight.
  setTimeout(() => {
    line.textContent = reason;
  }, 0);
}

/** The class of the line `showSendResult` writes a failure's reason in, styled by `BUTTON_CSS` and `devtools.css`. */
export const SEND_STATUS_CLASS = 'piwi-send-status';
