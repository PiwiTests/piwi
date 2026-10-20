import { initI18n, t, tn, uiLanguage } from '../shared/i18n.js';
import {
  bindToTool,
  endTool,
  installEscapeToCancel,
  isToolActive,
  startTool,
  teardownToolSurfaces,
  toolIsCurrent,
  waitForGlobal,
} from '../shared/tool-session.js';
import {
  installPickerOverlay,
  removePickerOverlay,
  highlightLocator,
  LOCATOR_SYNTAX_CSS,
  type PickerOverlayArg,
} from '@piwitests/picker-dom';
import { derivePattern, type PatternResult } from './multi-pick-derive.js';
import { TAG_TO_ROLE, INPUT_TYPE_TO_ROLE } from '@piwitests/core/locator-generation';
import { getLastCopyMode } from '../shared/storage.js';
import { createPageEngine, installDescribeHook } from './verified-locators.js';
import { attachPanelShadow } from './panel-root.js';
import { pickerOverlayStrings } from './picker-strings.js';
import { holdFocus } from './modal-panel.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { ICON_CSS, icon } from '../shared/icons.js';
import { COPY_MODE_CSS, copyModeButtons } from './copy-mode-row.js';

const ROLE_MAPS = { tagRoles: TAG_TO_ROLE, inputRoles: INPUT_TYPE_TO_ROLE };
const MIN_PICKS = 2;
const MAX_PICKS = 3;
const PANEL_HOST_ID = 'piwi-multi-pick-panel-host';

const PICK_GLOBALS = ['__piwiPickState', '__piwiPickedElement'] as const;

function clearPickGlobals(): void {
  for (const key of PICK_GLOBALS) delete (globalThis as any)[key];
}

/** One element-pick step (multi-pick never needs the anchors step); null when skipped, or once the tool has ended. */
async function pickOne(toolEpoch: number): Promise<Element | null> {
  clearPickGlobals();
  const overlayArg: PickerOverlayArg = { transport: 'global', failing: null, strings: pickerOverlayStrings() };
  installPickerOverlay(overlayArg);
  const state = await waitForGlobal<string>('__piwiPickState', toolEpoch);
  if (!toolIsCurrent(toolEpoch)) return null;
  const el = state === 'picked' ? ((globalThis as any).__piwiPickedElement as Element) : null;
  // A pick (as opposed to a skip) leaves the banner/highlight mounted — fine
  // for pick.ts's single-shot flow, but this runs the overlay 2-3 times in a
  // row, so each cycle must tear its own down before the next installs one.
  removePickerOverlay();
  clearPickGlobals();
  return el;
}

/** A dismissible bottom bar shown between mandatory picks, once the 2-pick minimum is met: derive now, pick a 3rd, or cancel. Not shown while a pick itself is in progress, so it never contends with the picker overlay's own key handling. */
function showBetweenPicksBar(count: number, toolEpoch: number): Promise<'pick-more' | 'derive' | 'cancel'> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = 'piwi-multi-pick-bar-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    const root = attachPanelShadow(host, { mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      ${BUTTON_CSS}
      .bar {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px; background: #111827; color: #f9fafb;
        border-radius: 12px; padding: 8px 8px 8px 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4);
        width: max-content; max-width: min(640px, calc(100vw - 32px)); box-sizing: border-box;
        font: 13px ui-sans-serif, system-ui, -apple-system, sans-serif;
      }
      @media (prefers-color-scheme: light) {
        .bar { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
      }
      .label {
        display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; hyphens: auto;
        font-weight: 500; line-height: 18px;
      }
      .label .piwi-icon { color: #c4b5fd; }
      @media (prefers-color-scheme: light) {
        .label .piwi-icon { color: #6d28d9; }
      }
    `;
    root.appendChild(style);

    let result: 'pick-more' | 'derive' | 'cancel' = 'cancel';
    const finish = (chosen: typeof result) => {
      result = chosen;
      close();
    };
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.lang = uiLanguage();
    const label = document.createElement('span');
    label.className = 'label';
    const words = document.createElement('span');
    words.textContent = tn('multipick_picked', count);
    label.append(icon('layers'), words);
    const deriveBtn = makeButton(t('multipick_derive'), () => finish('derive'), { icon: 'wand', tone: 'primary' });
    const moreBtn = makeButton(t('multipick_pickMore', { max: MAX_PICKS }), () => finish('pick-more'), {
      icon: 'plus',
    });
    const closeBtn = makeButton(t('multipick_cancel'), () => finish('cancel'), {
      icon: 'close',
      iconOnly: true,
      tone: 'ghost',
      className: 'close',
    });
    bar.append(label, moreBtn, deriveBtn, closeBtn);
    root.appendChild(bar);

    // Escape is the only global shortcut — Enter is deliberately *not*
    // hijacked here: deriveBtn is focused by default, so Enter/Space already
    // activates it natively, and Tab must still reach moreBtn/closeBtn and
    // have Enter/Space activate whichever of those is actually focused
    // instead of always deriving.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish('cancel');
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const close = bindToTool(toolEpoch, () => {
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      resolve(result);
    });
    deriveBtn.focus();
  });
}

/** A transient, auto-dismissing message — used only for "no common pattern found" today. */
function showMessage(text: string, toolEpoch: number): Promise<void> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.id = 'piwi-multi-pick-message-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);
    const root = attachPanelShadow(host, { mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      ${ICON_CSS}
      .bar {
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
        display: flex; align-items: flex-start; gap: 8px;
        background: #111827; color: #f9fafb; border-radius: 12px; padding: 10px 14px;
        box-shadow: 0 8px 30px rgba(0,0,0,.4); font: 13px ui-sans-serif, system-ui, -apple-system, sans-serif;
        max-width: min(480px, 90vw); width: max-content; box-sizing: border-box; cursor: pointer;
        overflow-wrap: anywhere; hyphens: auto; line-height: 18px;
      }
      .bar .piwi-icon { color: #fbbf24; margin-top: 1px; }
      @media (prefers-color-scheme: light) {
        .bar { background: #ffffff; color: #111827; box-shadow: 0 8px 30px rgba(0,0,0,.2); }
        .bar .piwi-icon { color: #b45309; }
      }
    `;
    root.appendChild(style);
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.lang = uiLanguage();
    const words = document.createElement('span');
    words.textContent = text;
    bar.append(icon('info'), words);
    root.appendChild(bar);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const finish = bindToTool(toolEpoch, () => {
      document.removeEventListener('keydown', onKeyDown, true);
      clearTimeout(timer);
      host.remove();
      resolve();
    });
    bar.addEventListener('click', finish);
    timer = setTimeout(finish, 4000);
  });
}

/** The panel's title, its `$base$` placeholder filled by the highlighted base locator. */
function titleNodes(count: number, base: Node): Array<Node | string> {
  const slot = '\u{F8FF}';
  const [before = '', after = ''] = tn('multipick_title', count, { base: slot }).split(slot);
  return [before, base, after].filter((part) => part !== '');
}

async function renderPatternPanel(result: PatternResult, toolEpoch: number): Promise<void> {
  const activeMode = await getLastCopyMode().catch(() => 'bare' as const);
  if (!toolIsCurrent(toolEpoch)) return;
  document.getElementById(PANEL_HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${COPY_MODE_CSS}
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.35);
      display: flex; align-items: flex-start; justify-content: center; padding-top: 8vh;
    }
    .panel {
      background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px;
      width: min(640px, 92vw); max-height: 78vh; overflow: auto;
      box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5;
    }
    @media (prefers-color-scheme: light) {
      .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); }
    }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .header > div { min-width: 0; }
    .title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; hyphens: auto; }
    .sub { color: #9ca3af; font-size: 12px; }
    .row {
      display: flex; flex-direction: column; gap: 7px;
      border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px;
    }
    .row code { display: block; font-size: 13px; line-height: 1.55; }
    .warn {
      display: flex; align-items: flex-start; gap: 5px; color: #fbbf24; font-size: 11.5px; line-height: 16px;
      overflow-wrap: anywhere; hyphens: auto;
    }
    .warn .piwi-icon { width: 14px; height: 14px; margin-top: 1px; }
    @media (prefers-color-scheme: light) {
      .sub { color: #6b7280; }
      .warn { color: #b45309; }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('multipick_dialog'));
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  const base = document.createElement('span');
  base.className = 'piwi-loc';
  base.innerHTML = highlightLocator(result.baseLocator ?? '');
  title.append(...titleNodes(result.rows.length, base));
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = t('common_escToClose');
  titleWrap.append(title, sub);
  header.append(titleWrap);
  panel.appendChild(header);

  return new Promise<void>((resolve) => {
    let releaseFocus = () => {};
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const finish = bindToTool(toolEpoch, () => {
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      releaseFocus();
      resolve();
    });
    header.append(
      makeButton(t('common_close'), finish, { icon: 'close', iconOnly: true, tone: 'ghost', className: 'close' }),
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish();
    });

    for (const row of result.rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      const code = document.createElement('code');
      code.className = 'piwi-loc';
      code.innerHTML = highlightLocator(row.locator);
      rowEl.appendChild(code);

      if (row.indexBased) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        const words = document.createElement('span');
        words.textContent = t('multipick_byPosition');
        warn.append(icon('alert'), words);
        rowEl.appendChild(warn);
      }

      rowEl.appendChild(copyModeButtons(row.locator, panel, activeMode));
      panel.appendChild(rowEl);
    }

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    releaseFocus = holdFocus(panel);
  });
}

/**
 * Runs the multi-pick flow: pick 2-3 similar items, then derive a
 * shared list-locator pattern. Requires the mandatory first two picks, then
 * offers a 3rd (stronger sample) or deriving now — Escape at any step
 * cancels the whole session, as closing the between-picks bar or the results
 * panel does. Injected again while a session runs, it leaves that session be.
 */
async function runMultiPick(): Promise<void> {
  if (isToolActive('multi-pick')) return;
  const toolEpoch = startTool('multi-pick', teardownToolSurfaces);
  installEscapeToCancel();
  const removeDescribeHook = bindToTool(toolEpoch, installDescribeHook());
  try {
    // The overlay, the bar and the panel speak the language chosen in the settings.
    await initI18n();
    if (!toolIsCurrent(toolEpoch)) return;
    const picked: Element[] = [];
    for (let i = 0; i < MIN_PICKS; i++) {
      const el = await pickOne(toolEpoch);
      if (!el) return;
      picked.push(el);
    }

    while (picked.length < MAX_PICKS) {
      if (!toolIsCurrent(toolEpoch)) return;
      const action = await showBetweenPicksBar(picked.length, toolEpoch);
      if (action === 'cancel') return;
      if (action === 'derive') break;
      const el = await pickOne(toolEpoch);
      if (!el) return;
      picked.push(el);
    }

    const engine = createPageEngine(document);
    const result = derivePattern(picked, ROLE_MAPS, {
      elements: engine.elements(),
      isHidden: (el) => engine.model.isHiddenForAria(el),
    });
    if (result.rows.length === 0) {
      await showMessage(t('multipick_noPattern'), toolEpoch);
      return;
    }
    await renderPatternPanel(result, toolEpoch);
  } finally {
    removeDescribeHook();
    endTool(toolEpoch);
  }
}

void runMultiPick();
