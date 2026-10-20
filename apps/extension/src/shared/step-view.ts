import { highlightLocator } from '@piwitests/picker-dom';
import { describeStepInWords } from '@piwitests/core/bug-report';
import type { BugPhrases } from '@piwitests/core/bug-phrases';
import type { RecordedStep } from '@piwitests/core/recording';
import { interfacePhrases } from './core-words.js';
import { ICON_CSS, icon, type IconName } from './icons.js';
import { urlParts, wordTokens, type WordToken } from './step-tokens.js';

export { urlParts } from './step-tokens.js';

/**
 * A step as the panels show it: a badge saying what kind of action it is, and
 * its words with what a reader looks for set apart: the names and values in
 * quotes, the keys, the addresses and the locators.
 */

/** The kinds of step, each with its badge color: going somewhere, acting, typing or choosing, checking, by hand. */
type StepKind = 'nav' | 'act' | 'input' | 'assert' | 'manual';

const STEP_BADGES: Record<RecordedStep['action'], { icon: IconName; kind: StepKind }> = {
  goto: { icon: 'globe', kind: 'nav' },
  click: { icon: 'pointer', kind: 'act' },
  dblclick: { icon: 'pointer', kind: 'act' },
  hover: { icon: 'pointer', kind: 'act' },
  dragTo: { icon: 'move', kind: 'act' },
  fill: { icon: 'keyboard', kind: 'input' },
  press: { icon: 'keyboard', kind: 'input' },
  selectOption: { icon: 'select', kind: 'input' },
  check: { icon: 'check-square', kind: 'input' },
  uncheck: { icon: 'square', kind: 'input' },
  setInputFiles: { icon: 'file', kind: 'input' },
  assert: { icon: 'check-circle', kind: 'assert' },
  assertVisible: { icon: 'check-circle', kind: 'assert' },
  manual: { icon: 'hand', kind: 'manual' },
};

/** The step's badge alone, for a list that puts the step's number or state beside it. */
export function stepBadge(step: RecordedStep): HTMLElement {
  const badge = STEP_BADGES[step.action] ?? { icon: 'pointer', kind: 'act' };
  const el = document.createElement('span');
  el.className = 'piwi-step-badge';
  el.dataset.kind = badge.kind;
  el.append(icon(badge.icon));
  return el;
}

/** The step's words, its parts set apart, in the interface language. */
export function stepWords(step: RecordedStep, phrases: BugPhrases = interfacePhrases()): HTMLElement {
  const words = document.createElement('span');
  words.className = 'piwi-step-words';
  words.append(...richWords(describeStepInWords(step, phrases), step, phrases));
  return words;
}

/** The step's badge and its words, side by side. */
export function stepView(step: RecordedStep, phrases: BugPhrases = interfacePhrases()): HTMLElement {
  const view = document.createElement('span');
  view.className = 'piwi-step';
  view.append(stepBadge(step), stepWords(step, phrases));
  return view;
}

/** `text` as nodes, its parts set apart: see {@link wordTokens}. */
export function richWords(text: string, step: RecordedStep | null, phrases: BugPhrases): Node[] {
  return wordTokens(text, step, phrases).map(tokenNode);
}

/** A sentence that is no step, such as why a step failed: its locators, addresses and quoted texts set apart. */
export function richText(text: string, phrases: BugPhrases = interfacePhrases()): Node[] {
  return richWords(text, null, phrases);
}

function tokenNode(token: WordToken): Node {
  switch (token.kind) {
    case 'text':
      return document.createTextNode(token.text);
    case 'url':
      return urlView(token.text);
    case 'locator': {
      const code = document.createElement('code');
      code.className = 'piwi-loc piwi-inline';
      code.innerHTML = highlightLocator(token.text);
      return code;
    }
    case 'code':
    case 'key': {
      const code = document.createElement(token.kind === 'key' ? 'kbd' : 'code');
      code.className = token.kind === 'key' ? 'piwi-kbd' : 'piwi-code';
      code.textContent = token.text;
      return code;
    }
    default: {
      const quoted = document.createElement('span');
      quoted.className = `piwi-${token.kind}`;
      quoted.textContent = token.text;
      return quoted;
    }
  }
}

/**
 * An address with its parts told apart: the origin dimmed, the path in front,
 * the query and the fragment dimmed; an origin alone is in front. `origin:
 * false` leaves the origin out when the surface already names the site.
 */
export function urlView(address: string, options: { origin?: boolean } = {}): HTMLElement {
  const view = document.createElement('span');
  view.className = 'piwi-url';
  view.title = address;
  const parts = urlParts(address);
  const add = (text: string, className: string) => {
    if (!text) return;
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    view.append(span);
  };
  const originOnly = !parts.path && !parts.rest;
  if (options.origin !== false || originOnly) add(parts.origin, originOnly ? 'piwi-url-path' : 'piwi-url-origin');
  if (!originOnly) add(parts.path || '/', 'piwi-url-path');
  add(parts.rest, 'piwi-url-rest');
  return view;
}

/**
 * The look of steps, addresses, quoted names and values, keys and code, its
 * colors set on the surface's root (`:host` in a shadow root, `:root` on a
 * page). Dark first, with the light scheme's colors; `piwi-dark` on an
 * ancestor keeps the dark ones. Panels that show a locator also need
 * `LOCATOR_SYNTAX_CSS`.
 */
export const STEP_CSS = `
  ${ICON_CSS}
  :host, :root, .piwi-dark {
    --piwi-nav: #38bdf8; --piwi-act: #a78bfa; --piwi-input: #fbbf24; --piwi-assert: #34d399; --piwi-manual: #f472b6;
    --piwi-name: #f9fafb; --piwi-value: #fcd34d; --piwi-chip: rgba(148,163,184,.16); --piwi-chip-border: rgba(148,163,184,.28);
    --piwi-url-path: #7dd3fc; --piwi-url-dim: #94a3b8;
  }
  @media (prefers-color-scheme: light) {
    :host, :root {
      --piwi-nav: #0369a1; --piwi-act: #6d28d9; --piwi-input: #b45309; --piwi-assert: #047857; --piwi-manual: #be185d;
      --piwi-name: #111827; --piwi-value: #92400e; --piwi-chip: rgba(100,116,139,.1); --piwi-chip-border: rgba(100,116,139,.25);
      --piwi-url-path: #0369a1; --piwi-url-dim: #64748b;
    }
  }
  .piwi-step { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .piwi-step-badge {
    --piwi-kind: var(--piwi-act);
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
    width: 20px; height: 20px; border-radius: 6px; color: var(--piwi-kind);
    background: color-mix(in srgb, var(--piwi-kind) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--piwi-kind) 30%, transparent);
  }
  .piwi-step-badge[data-kind="nav"] { --piwi-kind: var(--piwi-nav); }
  .piwi-step-badge[data-kind="input"] { --piwi-kind: var(--piwi-input); }
  .piwi-step-badge[data-kind="assert"] { --piwi-kind: var(--piwi-assert); }
  .piwi-step-badge[data-kind="manual"] { --piwi-kind: var(--piwi-manual); }
  .piwi-step-badge .piwi-icon { width: 14px; height: 14px; }
  .piwi-step-words { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; padding-top: 1px; }
  .piwi-name { color: var(--piwi-name); font-weight: 600; }
  .piwi-value { color: var(--piwi-value); font-weight: 600; }
  .piwi-quote { font-weight: 600; }
  .piwi-kbd, .piwi-code, .piwi-url, .piwi-loc.piwi-inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em;
    padding: 0 4px; border-radius: 4px; background: var(--piwi-chip); border: 1px solid var(--piwi-chip-border);
    overflow-wrap: anywhere; word-break: break-word;
  }
  .piwi-kbd, .piwi-code, .piwi-url, .piwi-loc, .piwi-name, .piwi-value, .piwi-quote { hyphens: manual; }
  .piwi-kbd { font-weight: 600; border-bottom-width: 2px; }
  .piwi-url-origin, .piwi-url-rest { color: var(--piwi-url-dim); }
  .piwi-url-path { color: var(--piwi-url-path); font-weight: 600; }
`;
