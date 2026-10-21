import { makeButton, type ButtonOptions } from '../shared/buttons.js';

/** What the replay's panel and its dialogs (Run with Playwright, Share result) build with. */

/** A small button of the replay's surfaces: its icon, its label and its tone. */
export function button(label: string, onClick: () => void, options: ButtonOptions = {}): HTMLButtonElement {
  return makeButton(label, onClick, { small: true, ...options });
}

/** Sends a message to the background worker: its answer, or `fallback` when it gives none or cannot be reached. */
export async function askWorker<T>(message: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return ((await chrome.runtime.sendMessage(message)) as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

/** A replay dialog's backdrop, dimming the page under the dialog at the top of the viewport. */
export const DIALOG_CSS = `
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start;
    justify-content: center; padding-top: 8vh; }
  [role=dialog]:focus { outline: none; }`;

/**
 * Makes `panel`, on the page already, a modal dialog: it takes the focus, and
 * Escape calls `close`. Answers what gives the focus back to the element that
 * had it before, for `close` to call.
 */
export function holdFocus(panel: HTMLElement, close: () => void): () => void {
  const before = document.activeElement;
  panel.setAttribute('aria-modal', 'true');
  panel.tabIndex = -1;
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  });
  panel.focus({ preventScroll: true });
  return () => {
    if ((before instanceof HTMLElement || before instanceof SVGElement) && before.isConnected) {
      before.focus({ preventScroll: true });
    }
  };
}
