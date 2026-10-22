import type { LocatorStabilityLevel, LocatorStabilityRuleId } from '@piwitests/core/locator-stability';
import type { LocatorVerdict } from '../content/verified-locators.js';
import type { ElementFacts } from './copy-modes.js';

/**
 * What the Elements sidebar shows for the node selected in DevTools, as the
 * ranking content script (`devtools-rank.ts`) answers it: plain data, since it
 * crosses from the page to the DevTools page.
 */

export interface SelectionLocator {
  locator: string;
  verdict: LocatorVerdict;
  /** The elements it finds on the page as it is, by the engine; null when the engine cannot evaluate it. */
  count: number | null;
  /** For a narrowed or positional locator: how many elements the candidate it was built from finds. */
  fromCount: number | null;
  stability: LocatorStabilityLevel;
  /** The stability rules it breaks, each once. */
  rules: LocatorStabilityRuleId[];
}

export type SelectionRanking =
  /** Nothing selected, or a node that is not an element. */
  | { status: 'none' }
  /** An element inside a frame: its locator would need the frame's prefix. */
  | { status: 'frame' }
  /** One of the extension's own elements. */
  | { status: 'extension' }
  | {
      status: 'ranked';
      pageUrl: string;
      tag: string;
      role: string | null;
      name: string | null;
      /** The locators finding the element alone first, then those finding it among others. */
      locators: SelectionLocator[];
      /** What the Action and Assertion copy modes write for the element. */
      facts: ElementFacts;
    };

/** The attribute that marks DevTools' selection for the ranking script where `useContentScriptContext` is missing. */
export const SELECTION_MARK = 'data-piwi-devtools-selection';

/** The global the ranking script defines in the extension's isolated world. */
export const RANK_SELECTED_GLOBAL = '__piwiRankSelected';

/** The message that asks the ranking script for the element carrying {@link SELECTION_MARK}. */
export const RANK_MARKED_MESSAGE = 'piwi-rank-marked';

/** `button · Apply coupon`: how the sidebar names the selection. */
export function describeSelection(ranking: { tag: string; role: string | null; name: string | null }): string {
  const kind = ranking.role ?? ranking.tag;
  return ranking.name ? `${kind} · ${ranking.name}` : kind;
}

/** The global the DevTools content script defines for the Locators tab: `query`, `highlight` and `mark`. */
export const DEVTOOLS_GLOBAL = '__piwiDevtools';

/** Asks the DevTools content script which elements a locator expression finds. */
export const QUERY_MESSAGE = 'piwi-devtools-query';
/** Asks it to outline one of those elements on the page, or none. */
export const HIGHLIGHT_MESSAGE = 'piwi-devtools-highlight';
/** Asks it to mark one of them with {@link REVEAL_MARK}, for the DevTools page to `inspect()` in the page's world. */
export const MARK_MATCH_MESSAGE = 'piwi-devtools-mark';
export const REVEAL_MARK = 'data-piwi-devtools-reveal';

/**
 * Run in the page's world by the DevTools page, where `inspect()` exists:
 * selects the element marked with {@link REVEAL_MARK} in the Elements panel,
 * found in the document or an open shadow root, and takes the mark off. True
 * when one was found.
 */
export const REVEAL_EXPRESSION = `(() => {
  const find = (root) => {
    const hit = root.querySelector('[${REVEAL_MARK}]');
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      const inside = el.shadowRoot && find(el.shadowRoot);
      if (inside) return inside;
    }
    return null;
  };
  const el = find(document);
  if (!el) return false;
  el.removeAttribute('${REVEAL_MARK}');
  inspect(el);
  return true;
})()`;

/** One element a locator finds, as the Locators tab lists it. */
export interface LocatorMatch {
  tag: string;
  role: string | null;
  name: string;
  /** Its text, shortened. */
  text: string;
}

export type LocatorQueryResult =
  | {
      ok: true;
      count: number;
      matches: LocatorMatch[];
      /** What the Action and Assertion copy modes write for the first match; null when nothing matches. */
      facts: ElementFacts | null;
    }
  /** The expression is not a locator, or names a CSS selector the page refuses (`selector`). */
  | { ok: false; error: string; selector: string | null };
