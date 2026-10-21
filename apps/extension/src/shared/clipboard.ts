import { t } from './i18n.js';
import { labelText, setLabel, withIcon, type IconName } from './icons.js';

/** How long a button shows what a copy did before its own label comes back. */
const FEEDBACK_MS = 1200;

/** A button showing a passing text: its own label and icon, and the timer that puts them back. */
const flashing = new WeakMap<
  HTMLElement,
  { label: string; icon: IconName | null; timer: ReturnType<typeof setTimeout> }
>();

/**
 * Shows `text` on `button` for a moment, then the button's own label again.
 * A second call meanwhile replaces the first: its timer starts over, and the
 * label it goes back to is still the button's own. With `outcome`, a button
 * with an icon shows a check or a cross in its place meanwhile.
 */
export function flashLabel(button: HTMLElement, text: string, ms = FEEDBACK_MS, outcome?: 'ok' | 'fail'): void {
  const shown = flashing.get(button);
  if (shown) clearTimeout(shown.timer);
  const glyph = button.querySelector(':scope > .piwi-icon')?.getAttribute('data-icon') as IconName | undefined;
  const label = shown?.label ?? labelText(button);
  const own = shown ? shown.icon : (glyph ?? null);
  setLabel(button, text);
  if (own && outcome) {
    withIcon(button, outcome === 'ok' ? 'check' : 'close');
    button.dataset.flash = outcome;
  }
  const timer = setTimeout(() => {
    flashing.delete(button);
    setLabel(button, label);
    if (own) withIcon(button, own);
    delete button.dataset.flash;
  }, ms);
  flashing.set(button, { label, icon: own, timer });
}

/**
 * Writes `text` to the clipboard. Where the asynchronous API is missing or
 * refuses (a page served over plain http, a document without the focus), the
 * copy command takes over, from a field placed in `near`'s root and removed
 * at once, the focus then going back where it was. False when neither copied.
 */
async function writeClipboard(text: string, near: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The copy command below.
  }
  const root = (near.isConnected ? near.getRootNode() : document) as Document | ShadowRoot;
  const focused = root.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  (root.nodeType === Node.DOCUMENT_NODE ? (document.body ?? document.documentElement) : root).appendChild(area);
  let copied = false;
  try {
    area.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  focused?.focus?.({ preventScroll: true });
  return copied;
}

/**
 * Copies `text`, then says on `button` whether it worked: Copied, or Not
 * copied when the browser refused. True when it copied.
 */
export async function copyWithFeedback(text: string, button: HTMLElement): Promise<boolean> {
  const copied = await writeClipboard(text, button);
  flashLabel(button, copied ? t('common_copied') : t('common_copyFailed'), FEEDBACK_MS, copied ? 'ok' : 'fail');
  return copied;
}
