import { COPY_MODE_ICONS, COPY_MODES, copyModeLabel, renderCopyMode, type CopyMode } from '../shared/copy-modes.js';
import { setLastCopyMode } from '../shared/storage.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { makeButton } from '../shared/buttons.js';
import { icon } from '../shared/icons.js';
import { t } from '../shared/i18n.js';

/**
 * The copy buttons under a locator, one per copy mode, joined as one control
 * after a Copy label. A click copies the locator in that mode and makes it the
 * panel's mode: every copy button of `panel` marks it, and `onChoose` hears it.
 */
export function copyModeButtons(
  locator: string,
  panel: HTMLElement,
  active: CopyMode,
  onChoose?: (mode: CopyMode) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'copy-modes';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', t('common_copy'));
  const lead = document.createElement('span');
  lead.className = 'copy-lead';
  lead.setAttribute('aria-hidden', 'true');
  lead.append(icon('copy'), t('common_copy'));
  group.appendChild(lead);
  for (const mode of COPY_MODES) {
    const button = makeButton(
      copyModeLabel(mode),
      () => {
        void copyWithFeedback(renderCopyMode({ locator }, mode), button);
        void setLastCopyMode(mode);
        for (const other of panel.querySelectorAll<HTMLElement>('button.copy[data-mode]')) {
          other.dataset.active = String(other.dataset.mode === mode);
        }
        onChoose?.(mode);
      },
      { icon: COPY_MODE_ICONS[mode], small: true, className: 'copy' },
    );
    button.dataset.mode = mode;
    button.dataset.active = String(mode === active);
    group.appendChild(button);
  }
  return group;
}

/** The look of {@link copyModeButtons}, beside `BUTTON_CSS`. */
export const COPY_MODE_CSS = `
  .copy-modes { display: inline-flex; flex-wrap: wrap; align-items: center; row-gap: 4px; }
  .copy-lead {
    display: inline-flex; align-items: center; gap: 4px; margin-inline-end: 6px;
    color: #9ca3af; font-size: 11px; font-weight: 500; line-height: 16px;
  }
  .copy-lead .piwi-icon { width: 12px; height: 12px; }
  .copy-modes .piwi-btn { border-radius: 0; }
  .copy-modes .piwi-btn + .piwi-btn { margin-inline-start: -1px; }
  .copy-modes .piwi-btn:first-of-type { border-start-start-radius: 6px; border-end-start-radius: 6px; }
  .copy-modes .piwi-btn:last-of-type { border-start-end-radius: 6px; border-end-end-radius: 6px; }
  .copy-modes .piwi-btn:hover, .copy-modes .piwi-btn:focus-visible, .copy-modes .piwi-btn[data-active="true"] {
    position: relative; z-index: 1;
  }
  .copy-modes .piwi-btn[data-active="true"] {
    background: var(--piwi-btn-pressed-bg); border-color: var(--piwi-btn-pressed-border);
  }
  @media (prefers-color-scheme: light) {
    .copy-lead { color: #6b7280; }
  }
`;
