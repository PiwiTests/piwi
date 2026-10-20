import { initI18n, t, uiLanguage } from '../shared/i18n.js';
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
  highlightLocator,
  installPickerOverlay,
  LOCATOR_SYNTAX_CSS,
  removePickerOverlay,
  type PickerOverlayArg,
} from '@piwitests/picker-dom';
import { buildAgentContext } from './agent-context.js';
import { attachPanelShadow } from './panel-root.js';
import { pickerOverlayStrings } from './picker-strings.js';
import { holdFocus } from './modal-panel.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { STEP_CSS, urlView } from '../shared/step-view.js';

const HOST_ID = 'piwi-agent-context-host';

const PICK_GLOBALS = ['__piwiPickState', '__piwiPickedElement'] as const;

function clearPickGlobals(): void {
  for (const key of PICK_GLOBALS) delete (globalThis as any)[key];
}

/** A span of `text` with `className`. */
function part(className: string, text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** A locator, highlighted. */
function locatorPart(locator: string): HTMLElement {
  const code = document.createElement('span');
  code.className = 'piwi-loc';
  code.innerHTML = highlightLocator(locator);
  return code;
}

/** The ranked line's note on what the locator finds on the page, as `buildAgentContext` writes it. */
const RANKED_NOTE = / \((?:narrowed from |by position: |finds |not checked on this page)[\s\S]*\)$/;
/** An attribute of the Attributes line: its name, and its quoted value up to the next attribute. */
const ATTRIBUTE = /([\w:-]+)=("[\s\S]*?")(?= [\w:-]+="|$)/g;
/** A quoted name or text. */
const QUOTED = /("[^"]*")/;

/** `text` with its quoted parts as strings. */
function quotedParts(text: string): Node[] {
  return text
    .split(QUOTED)
    .filter(Boolean)
    .map((piece) => (QUOTED.test(piece) ? part('ctx-string', piece) : document.createTextNode(piece)));
}

/**
 * One line of the block as `buildAgentContext` writes it, its parts set
 * apart: the heading, each label, the address, the tag, the attributes'
 * names, and each ranked locator with its score. The text stays the block's,
 * character for character.
 */
function contextLine(line: string): Node[] {
  if (line.startsWith('## ')) return [part('ctx-head', line)];
  const ranked = /^(\d+\. )\[(\d+)\] (.+)$/.exec(line);
  if (ranked) {
    const [, number, score, rest] = ranked as unknown as [string, string, string, string];
    const note = RANKED_NOTE.exec(rest);
    const locator = note ? rest.slice(0, note.index) : rest;
    const nodes: Node[] = [part('ctx-dim', number), part('ctx-score', `[${score}]`), document.createTextNode(' ')];
    nodes.push(locatorPart(locator));
    if (note) nodes.push(part('ctx-dim', note[0]));
    return nodes;
  }
  if (line.endsWith(':')) return [part('ctx-label', line)];
  const labelled = /^([A-Z][A-Za-z ]*:) (.*)$/.exec(line);
  if (!labelled) return [document.createTextNode(line)];
  const [, label, rest] = labelled as unknown as [string, string, string];
  const nodes: Node[] = [part('ctx-label', label), document.createTextNode(' ')];
  if (label === 'Page:') {
    nodes.push(urlView(rest));
  } else if (label === 'Element:') {
    const tag = /^(<[^>]+>)([\s\S]*)$/.exec(rest);
    if (tag) nodes.push(part('ctx-tag', tag[1]!), ...quotedParts(tag[2]!));
    else nodes.push(...quotedParts(rest));
  } else if (label === 'Attributes:') {
    let last = 0;
    for (const match of rest.matchAll(ATTRIBUTE)) {
      if (match.index > last) nodes.push(document.createTextNode(rest.slice(last, match.index)));
      nodes.push(part('ctx-attr', match[1]!), document.createTextNode('='), part('ctx-string', match[2]!));
      last = match.index + match[0].length;
    }
    if (last < rest.length) nodes.push(document.createTextNode(rest.slice(last)));
  } else if (label === 'Text:') {
    nodes.push(part('ctx-string', rest));
  } else {
    nodes.push(document.createTextNode(rest));
  }
  return nodes;
}

/** The block, line by line, its parts set apart by {@link contextLine}. */
function contextNodes(context: string): Node[] {
  const nodes: Node[] = [];
  for (const [i, line] of context.split('\n').entries()) {
    if (i > 0) nodes.push(document.createTextNode('\n'));
    nodes.push(...contextLine(line));
  }
  return nodes;
}

function renderContextPanel(context: string, toolEpoch: number): Promise<void> {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  // Exposed for agent-context.spec.ts: buildAgentContext calls
  // @piwitests/core's generateAlternatives, which has its own private
  // module-level helpers Function.prototype.toString() reconstruction can't
  // carry along — real bundling is the only way to exercise it correctly,
  // same as lint-overlay.ts/assertion-panel.ts.
  (globalThis as any).__piwiAgentContext = context;

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
    .header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; hyphens: auto; }
    .sub { color: #9ca3af; font-size: 12px; overflow-wrap: anywhere; hyphens: auto; }
    pre {
      background: rgba(128,128,128,.1); border: 1px solid rgba(128,128,128,.3); border-radius: 8px;
      padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-word; max-height: 56vh; overflow: auto; margin: 0;
    }
    pre .piwi-loc, pre .piwi-url { font-family: inherit; }
    pre .piwi-url { font-size: inherit; padding: 0; border: 0; background: none; }
    .ctx-head { font-weight: 700; color: #c4b5fd; }
    .ctx-label { color: #9ca3af; }
    .ctx-dim { color: #9ca3af; }
    .ctx-score {
      color: #c4b5fd; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .ctx-tag { color: #f87171; font-weight: 600; }
    .ctx-attr { color: #93c5fd; }
    .ctx-string { color: #86efac; }
    @media (prefers-color-scheme: light) {
      .sub, .ctx-label, .ctx-dim { color: #6b7280; }
      .ctx-head, .ctx-score { color: #6d28d9; }
      .ctx-tag { color: #b91c1c; }
      .ctx-attr { color: #1d4ed8; }
      .ctx-string { color: #15803d; }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('agent_title'));
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = t('agent_title');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${t('agent_hint')} · ${t('common_escToClose')}`;
  titleWrap.append(title, sub);
  const headerActions = document.createElement('div');
  headerActions.className = 'header-actions';
  const copyBtn = makeButton(t('common_copy'), () => void copyWithFeedback(context, copyBtn), {
    icon: 'copy',
    tone: 'primary',
    className: 'copy',
  });
  headerActions.append(copyBtn);
  header.append(titleWrap, headerActions);
  panel.appendChild(header);

  const pre = document.createElement('pre');
  // The block is written for a coding agent, in English, whatever the interface language.
  pre.lang = 'en';
  pre.append(...contextNodes(context));
  panel.appendChild(pre);

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
    headerActions.append(
      makeButton(t('common_close'), finish, { icon: 'close', iconOnly: true, tone: 'ghost', className: 'close' }),
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish();
    });

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    releaseFocus = holdFocus(panel);
  });
}

/**
 * Runs the copy-context-for-agent flow: pick a single element, then show one
 * paste-able block (page URL, element summary, ranked locators) with a single
 * copy button. Reuses pick.ts's single-pick mechanism but skips the anchors
 * step, same reasoning as `assertion-panel.ts`. Injected again while it runs,
 * it leaves the running one be; any other tool, a pick included, gives way to
 * it.
 */
async function runAgentContextPanel(): Promise<void> {
  const g = globalThis as any;
  if (isToolActive('agent-context-panel')) return;
  const toolEpoch = startTool('agent-context-panel', teardownToolSurfaces);
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
    const context = buildAgentContext(el, location.href);
    await renderContextPanel(context, toolEpoch);
  } finally {
    // A flow another tool took over from leaves the pick globals to that tool.
    if (toolIsCurrent(toolEpoch)) clearPickGlobals();
    endTool(toolEpoch);
  }
}

void runAgentContextPanel();
