import { parseLocatorChain, tryParseLocatorChain } from '@piwitests/core/locator-chain';
import { assessLocatorChain, type LocatorStabilityRuleId } from '@piwitests/core/locator-stability';
import { normalizeWhiteSpace } from './engine-aria.js';
import { elementFacts } from './element-facts.js';
import { attachPanelShadow } from './panel-root.js';
import {
  HIGHLIGHT_MESSAGE,
  MARK_MATCH_MESSAGE,
  QUERY_MESSAGE,
  REVEAL_MARK,
  DEVTOOLS_GLOBAL,
  type LocatorQueryResult,
  RANK_MARKED_MESSAGE,
  RANK_SELECTED_GLOBAL,
  SELECTION_MARK,
  type SelectionLocator,
  type SelectionRanking,
} from '../shared/devtools-selection.js';
import {
  checkLocators,
  createPageEngine,
  isPiwiElement,
  rankElement,
  type CheckedLocator,
} from './verified-locators.js';

/**
 * Ranks the node selected in DevTools for the Elements sidebar, with the same
 * verified ranking the Pick tool shows. Injected into the inspected tab by the
 * sidebar; the sidebar calls {@link RANK_SELECTED_GLOBAL} with `$0` through
 * `chrome.devtools.inspectedWindow.eval(…, { useContentScriptContext: true })`,
 * or, where that option is missing, marks `$0` with {@link SELECTION_MARK} in
 * the page's world and asks by message.
 */

/** How many locators the sidebar lists. */
const MAX_LOCATORS = 6;

function toSelectionLocator(alt: CheckedLocator): SelectionLocator {
  const chain = tryParseLocatorChain(alt.locator);
  const stability = chain ? assessLocatorChain(chain) : null;
  const rules: LocatorStabilityRuleId[] = [];
  for (const finding of stability?.findings ?? []) if (!rules.includes(finding.rule)) rules.push(finding.rule);
  return {
    locator: alt.locator,
    verdict: alt.verdict,
    count: alt.count,
    fromCount: alt.from?.count ?? null,
    stability: stability?.level ?? 'watch',
    rules,
  };
}

function rankSelected(node: unknown): SelectionRanking {
  const candidate = node as Node | null | undefined;
  const el = candidate?.nodeType === Node.TEXT_NODE ? candidate.parentElement : candidate;
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return { status: 'none' };
  const element = el as Element;
  if (element.ownerDocument !== document) return { status: 'frame' };
  if (isPiwiElement(element)) return { status: 'extension' };
  const { ranked, accessibleName, role } = rankElement(element);
  const checked = checkLocators(element, ranked, { keepAmbiguous: true });
  return {
    status: 'ranked',
    pageUrl: location.href,
    tag: element.localName,
    role,
    name: accessibleName,
    locators: checked.slice(0, MAX_LOCATORS).map(toSelectionLocator),
    facts: elementFacts(element),
  };
}

/** How many matches the Locators tab lists. */
const MAX_MATCHES = 50;
const HIGHLIGHT_HOST_ID = 'piwi-devtools-highlight';

/** The elements the last query found, for the outline and the reveal that follow it. */
let lastMatches: Element[] = [];

function queryLocator(expression: string): LocatorQueryResult {
  try {
    const engine = createPageEngine(document);
    lastMatches = engine.queryAll(parseLocatorChain(expression));
    return {
      ok: true,
      count: lastMatches.length,
      matches: lastMatches.slice(0, MAX_MATCHES).map((element) => {
        const role = engine.model.role(element);
        const text = normalizeWhiteSpace(element.textContent ?? '');
        return {
          tag: element.localName,
          role: role && role !== 'generic' ? role : null,
          name: normalizeWhiteSpace(engine.model.accessibleName(element, false)),
          text: text.length > 60 ? `${text.slice(0, 59)}…` : text,
        };
      }),
    };
  } catch (error) {
    lastMatches = [];
    const selector = (error as { invalidSelector?: unknown } | null)?.invalidSelector;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      selector: typeof selector === 'string' ? selector : null,
    };
  }
}

/** How long an outline stays at most: the DevTools page that drew it may be gone before it asks for it to go. */
const HIGHLIGHT_MS = 5000;

/** Takes the outline off the page, with its listeners and its timer. */
let clearHighlight = (): void => document.getElementById(HIGHLIGHT_HOST_ID)?.remove();

/**
 * Outlines match `index` on the page, scrolled into view; none when it is
 * null. The outline follows the element as the page scrolls or resizes, and
 * goes after `HIGHLIGHT_MS`. Whether one is outlined.
 */
function highlight(index: number | null): boolean {
  clearHighlight();
  const element = index === null ? undefined : lastMatches[index];
  if (!element?.isConnected) return false;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const host = document.createElement('div');
  host.id = HIGHLIGHT_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = attachPanelShadow(host, { mode: 'closed' });
  const box = document.createElement('div');
  const place = () => {
    const r = element.getBoundingClientRect();
    box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;box-sizing:border-box;border:2px solid #a855f7;background:rgba(168,85,247,.16);border-radius:3px;`;
  };
  place();
  root.appendChild(box);
  document.documentElement.appendChild(host);
  let frame = 0;
  const follow = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);
  const timer = setTimeout(() => clearHighlight(), HIGHLIGHT_MS);
  clearHighlight = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    window.removeEventListener('scroll', follow, true);
    window.removeEventListener('resize', follow);
    host.remove();
  };
  return true;
}

/** The elements matching `selector` in `root` and in every open shadow root under it. */
function queryAllDeep(root: Document | ShadowRoot, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) found.push(...queryAllDeep(element.shadowRoot, selector));
  }
  return found;
}

/**
 * Marks match `index`, the only element marked, for the DevTools page, which
 * reveals it with `inspect()` in the page's world. False when it has left the page.
 */
function markMatch(index: number): boolean {
  for (const marked of queryAllDeep(document, `[${REVEAL_MARK}]`)) marked.removeAttribute(REVEAL_MARK);
  const element = lastMatches[index];
  if (!element?.isConnected) return false;
  element.setAttribute(REVEAL_MARK, '');
  return true;
}

const g = globalThis as Record<string, unknown>;
if (typeof g[RANK_SELECTED_GLOBAL] !== 'function') {
  g[RANK_SELECTED_GLOBAL] = rankSelected;
  g[DEVTOOLS_GLOBAL] = {
    query: queryLocator,
    highlight,
    mark: markMatch,
  };
  // Absent when a test runs the bundle in a page's own world.
  (globalThis as { chrome?: typeof chrome }).chrome?.runtime?.onMessage?.addListener(
    (message, _sender, sendResponse) => {
      if (message?.type === QUERY_MESSAGE && typeof message.expression === 'string') {
        sendResponse(queryLocator(message.expression));
        return undefined;
      }
      if (message?.type === HIGHLIGHT_MESSAGE) {
        sendResponse(highlight(typeof message.index === 'number' ? message.index : null));
        return undefined;
      }
      if (message?.type === MARK_MATCH_MESSAGE && typeof message.index === 'number') {
        sendResponse(markMatch(message.index));
        return undefined;
      }
      if (message?.type !== RANK_MARKED_MESSAGE || typeof message.token !== 'string') return undefined;
      const marked = document.querySelector(`[${SELECTION_MARK}="${CSS.escape(message.token)}"]`);
      marked?.removeAttribute(SELECTION_MARK);
      sendResponse(rankSelected(marked));
      return undefined;
    },
  );
}
