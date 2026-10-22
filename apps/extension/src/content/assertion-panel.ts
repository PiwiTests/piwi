import { initI18n, t, tn, tNodes, uiLanguage } from '../shared/i18n.js';
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
import { suggestAssertions, type AssertionSuggestion } from './assertion-suggest.js';
import { attachPanelShadow } from './panel-root.js';
import { pickerOverlayStrings } from './picker-strings.js';
import { holdFocus } from './modal-panel.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { icon } from '../shared/icons.js';
import { STEP_CSS } from '../shared/step-view.js';
import { interfacePhrases } from '../shared/core-words.js';
import { assertionMethod } from '../shared/copy-modes.js';

const HOST_ID = 'piwi-assertion-panel-host';

const PICK_GLOBALS = ['__piwiPickState', '__piwiPickedElement'] as const;

function clearPickGlobals(): void {
  for (const key of PICK_GLOBALS) delete (globalThis as any)[key];
}

async function renderAssertionPanel(suggestion: AssertionSuggestion, toolEpoch: number): Promise<void> {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  // Exposed for assertion-suggest.spec.ts: suggestAssertions calls
  // @piwitests/core's generateAlternatives, which has its own private
  // module-level helpers that Function.prototype.toString() reconstruction
  // can't carry along — real bundling is the only way to exercise it
  // correctly, so the result is bridged out here the same way lint findings
  // are bridged out of lint-overlay.ts.
  (globalThis as any).__piwiAssertionSuggestion = suggestion;

  const style = document.createElement('style');
  style.textContent = `
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${STEP_CSS}
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
    .sub { color: #9ca3af; font-size: 12px; overflow-wrap: anywhere; }
    .empty { color: #9ca3af; font-size: 12.5px; overflow-wrap: anywhere; }
    .row {
      display: flex; flex-direction: column; gap: 7px;
      border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px;
    }
    .row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .method {
      display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere;
      color: #c4b5fd; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; font-weight: 600;
    }
    .detail { font-size: 12px; word-break: break-word; }
    .row code {
      display: block; font-size: 12.5px; line-height: 1.55; padding: 6px 8px; border-radius: 6px;
      background: rgba(148,163,184,.1); border: 1px solid rgba(148,163,184,.2);
    }
    @media (prefers-color-scheme: light) {
      .sub, .empty { color: #6b7280; }
      .method { color: #6d28d9; }
      .row code { background: rgba(100,116,139,.06); border-color: rgba(100,116,139,.18); }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('assert_dialog'));
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent =
    suggestion.candidates.length === 0 ? t('assert_none') : tn('assert_count', suggestion.candidates.length);
  const sub = document.createElement('div');
  sub.className = 'sub';
  if (suggestion.locator) {
    const locator = document.createElement('span');
    locator.className = 'piwi-loc';
    locator.innerHTML = highlightLocator(suggestion.locator);
    sub.append(...tNodes('assert_locator', { locator }));
  }
  titleWrap.append(title, sub);
  header.append(titleWrap);
  panel.appendChild(header);

  if (suggestion.candidates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('assert_noLocator');
    panel.appendChild(empty);
  }

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

    for (const candidate of suggestion.candidates) {
      const row = document.createElement('div');
      row.className = 'row';
      const top = document.createElement('div');
      top.className = 'row-top';
      const method = document.createElement('span');
      method.className = 'method';
      const badge = document.createElement('span');
      badge.className = 'piwi-step-badge';
      badge.dataset.kind = 'assert';
      badge.appendChild(icon('check-circle'));
      const name = document.createElement('span');
      name.textContent = assertionMethod(candidate.assertion);
      method.append(badge, name);
      const btn = makeButton(t('common_copy'), () => void copyWithFeedback(candidate.expectLine, btn), {
        icon: 'copy',
        small: true,
        className: 'copy',
      });
      top.append(method, btn);
      row.appendChild(top);

      const shown = candidate.values ?? (candidate.detail != null ? [candidate.detail] : []);
      if (shown.length > 0) {
        const detail = document.createElement('div');
        detail.className = 'detail';
        shown.forEach((text, i) => {
          const value = document.createElement('span');
          value.className = 'piwi-value';
          value.textContent = interfacePhrases().quote(text);
          detail.append(...(i > 0 ? [', '] : []), value);
        });
        row.appendChild(detail);
      }

      const code = document.createElement('code');
      code.className = 'piwi-loc';
      code.innerHTML = highlightLocator(candidate.expectLine);
      row.appendChild(code);

      panel.appendChild(row);
    }

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    releaseFocus = holdFocus(panel);
  });
}

/**
 * Runs the assertion-suggester flow: pick a single element or region,
 * then suggest ranked `expect(...)` candidates against its top-ranked
 * locator. Reuses the same single-pick mechanism as `pick.ts` but skips the
 * anchors step — this is about assertions, not refining the locator itself
 * (it suggests assertions against the top-ranked locator, not a refined one).
 * Injected again while it runs, it leaves the running one be; any other tool,
 * a pick included, gives way to it.
 */
async function runAssertionSuggester(): Promise<void> {
  const g = globalThis as any;
  if (isToolActive('assertion-panel')) return;
  const toolEpoch = startTool('assertion-panel', teardownToolSurfaces);
  installEscapeToCancel();
  try {
    // The overlay and the panel speak the language chosen in the settings.
    await initI18n();
    if (!toolIsCurrent(toolEpoch)) return;
    clearPickGlobals();
    const overlayArg: PickerOverlayArg = { transport: 'global', failing: null, strings: pickerOverlayStrings() };
    installPickerOverlay(overlayArg);
    const state = await waitForGlobal<string>('__piwiPickState', toolEpoch);
    if (state !== 'picked' || !toolIsCurrent(toolEpoch)) return;
    // Done with the picking overlay — otherwise it stays up behind this
    // tool's own panel, still reading "Analyzing element…".
    removePickerOverlay();

    const el = g.__piwiPickedElement as Element;
    const suggestion = suggestAssertions(el);
    await renderAssertionPanel(suggestion, toolEpoch);
  } finally {
    // A flow another tool took over from leaves the pick globals to that tool.
    if (toolIsCurrent(toolEpoch)) clearPickGlobals();
    endTool(toolEpoch);
  }
}

void runAssertionSuggester();
