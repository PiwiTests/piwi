import { ICON_CSS, icon, withIcon, type IconName } from './icons.js';

/**
 * What a button does, by its color:
 * - `primary`, violet: the surface's main action, one per group.
 * - `success`, green: completes a flow or goes on with it (Finish, I did it, continue).
 * - `danger`, red: stops what runs (Stop, Stop here).
 * - `remove`, red text: discards or takes something away (Discard, Remove, Unpair).
 * - `neutral`, the default: any other action, its icon in the accent color.
 * - `ghost`: no frame until hovered (a panel's close button, a small inline action).
 */
export type ButtonTone = 'primary' | 'success' | 'danger' | 'remove' | 'neutral' | 'ghost';

export interface ButtonOptions {
  icon?: IconName;
  tone?: ButtonTone;
  /** Only the icon shows; the label becomes the button's name and its tooltip. */
  iconOnly?: boolean;
  small?: boolean;
  title?: string;
  className?: string;
}

/** A button styled by {@link BUTTON_CSS}: its icon, its label and its tone. */
export function makeButton(
  label: string,
  onClick: (event: MouseEvent) => void,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  styleButton(button, options);
  if (options.iconOnly && options.icon) {
    button.append(icon(options.icon));
    button.setAttribute('aria-label', label);
    button.title = options.title ?? label;
  } else {
    button.textContent = label;
    if (options.icon) withIcon(button, options.icon);
    if (options.title) button.title = options.title;
  }
  button.addEventListener('click', onClick);
  return button;
}

/** Gives a button made elsewhere the look of {@link makeButton}'s, keeping its text. */
export function styleButton<T extends HTMLElement>(button: T, options: ButtonOptions = {}): T {
  button.classList.add('piwi-btn');
  if (options.className) button.classList.add(...options.className.split(/\s+/).filter(Boolean));
  if (options.tone && options.tone !== 'neutral') button.dataset.tone = options.tone;
  if (options.small) button.dataset.size = 'sm';
  if (options.iconOnly) button.dataset.iconOnly = '';
  if (options.icon && !options.iconOnly) withIcon(button, options.icon);
  return button;
}

/**
 * The buttons' look in a panel on the page. Dark first, with the light
 * scheme's colors under `prefers-color-scheme: light`; a surface that stays
 * dark in both puts `piwi-dark` on an ancestor.
 */
export const BUTTON_CSS = `
  ${ICON_CSS}
  .piwi-btn, .piwi-dark .piwi-btn {
    --piwi-btn-bg: rgba(148,163,184,.13); --piwi-btn-border: rgba(148,163,184,.32);
    --piwi-btn-hover-bg: rgba(148,163,184,.25); --piwi-btn-hover-border: rgba(148,163,184,.55);
    --piwi-btn-icon: #c4b5fd; --piwi-btn-focus: #a78bfa;
    --piwi-btn-remove: #fca5a5; --piwi-btn-remove-bg: rgba(248,113,113,.16); --piwi-btn-remove-border: #f87171;
    --piwi-btn-pressed-bg: rgba(124,58,237,.24); --piwi-btn-pressed-border: #a78bfa;
    --piwi-btn-ok: #34d399; --piwi-btn-fail: #f87171;
  }
  @media (prefers-color-scheme: light) {
    .piwi-btn {
      --piwi-btn-bg: rgba(100,116,139,.07); --piwi-btn-border: rgba(100,116,139,.32);
      --piwi-btn-hover-bg: rgba(100,116,139,.15); --piwi-btn-hover-border: rgba(100,116,139,.6);
      --piwi-btn-icon: #6d28d9; --piwi-btn-focus: #7c3aed;
      --piwi-btn-remove: #b91c1c; --piwi-btn-remove-bg: rgba(220,38,38,.08); --piwi-btn-remove-border: #dc2626;
      --piwi-btn-pressed-bg: rgba(124,58,237,.1); --piwi-btn-pressed-border: #7c3aed;
      --piwi-btn-ok: #059669; --piwi-btn-fail: #dc2626;
    }
  }
  .piwi-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 28px; padding: 4px 11px; border-radius: 7px;
    border: 1px solid var(--piwi-btn-border); background: var(--piwi-btn-bg); color: inherit;
    font: inherit; font-size: 12px; font-weight: 500; line-height: 1.25; text-align: start;
    cursor: pointer; text-decoration: none; overflow-wrap: break-word;
    transition: background-color .12s ease, border-color .12s ease, color .12s ease;
  }
  .piwi-btn:hover { background: var(--piwi-btn-hover-bg); border-color: var(--piwi-btn-hover-border); }
  .piwi-btn:focus-visible { outline: 2px solid var(--piwi-btn-focus); outline-offset: 1px; }
  .piwi-btn:disabled { opacity: .5; cursor: default; }
  .piwi-btn:disabled:hover { background: var(--piwi-btn-bg); border-color: var(--piwi-btn-border); }
  .piwi-btn > .piwi-icon { width: 16px; height: 16px; color: var(--piwi-btn-icon); }
  .piwi-btn[data-size="sm"] { min-height: 24px; padding: 2px 8px; font-size: 11.5px; gap: 5px; border-radius: 6px; }
  .piwi-btn[data-size="sm"] > .piwi-icon { width: 14px; height: 14px; }
  .piwi-btn[data-icon-only] { padding: 0; width: 28px; flex-shrink: 0; }
  .piwi-btn[data-icon-only][data-size="sm"] { width: 24px; }
  .piwi-btn[aria-pressed="true"] { background: var(--piwi-btn-pressed-bg); border-color: var(--piwi-btn-pressed-border); }
  .piwi-btn[data-flash="ok"] { border-color: var(--piwi-btn-ok); }
  .piwi-btn[data-flash="ok"] > .piwi-icon { color: var(--piwi-btn-ok); }
  .piwi-btn[data-flash="fail"] { border-color: var(--piwi-btn-fail); }
  .piwi-btn[data-flash="fail"] > .piwi-icon { color: var(--piwi-btn-fail); }
  .piwi-btn[data-tone="primary"] { background: #7c3aed; border-color: #7c3aed; color: #fff; }
  .piwi-btn[data-tone="primary"]:hover { background: #6d28d9; border-color: #6d28d9; }
  .piwi-btn[data-tone="success"] { background: #059669; border-color: #059669; color: #fff; }
  .piwi-btn[data-tone="success"]:hover { background: #047857; border-color: #047857; }
  .piwi-btn[data-tone="danger"] { background: #dc2626; border-color: #dc2626; color: #fff; }
  .piwi-btn[data-tone="danger"]:hover { background: #b91c1c; border-color: #b91c1c; }
  .piwi-btn[data-tone="remove"] { color: var(--piwi-btn-remove); }
  .piwi-btn[data-tone="remove"]:hover { background: var(--piwi-btn-remove-bg); border-color: var(--piwi-btn-remove-border); }
  .piwi-btn[data-tone="ghost"] { background: none; border-color: transparent; }
  .piwi-btn[data-tone="ghost"]:hover { background: var(--piwi-btn-hover-bg); }
  .piwi-btn[data-tone] > .piwi-icon, .piwi-btn[data-tone][data-flash] > .piwi-icon { color: currentColor; }
  .piwi-btn[data-tone="ghost"] > .piwi-icon { opacity: .8; }
  .piwi-btn[data-tone="ghost"]:hover > .piwi-icon { opacity: 1; }
  .piwi-btn[data-tone][data-flash] { border-color: currentColor; }
  .piwi-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
`;
