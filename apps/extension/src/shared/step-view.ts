import { highlightLocator } from '@piwitests/picker-dom';
import { describeStepInWords } from '@piwitests/core/bug-report';
import type { BugPhrases } from '@piwitests/core/bug-phrases';
import type { RecordedStep } from '@piwitests/core/recording';
import { interfacePhrases } from './core-words.js';
import { ICON_CSS, icon, type IconName } from './icons.js';

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

/** One line of text, as core writes a quoted name or value. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * `text` as nodes: its Markdown code spans as addresses, locators or code,
 * and in what remains the quoted names and values, and the key of a press.
 */
export function richWords(text: string, step: RecordedStep | null, phrases: BugPhrases): Node[] {
  const nodes: Node[] = [];
  for (const part of splitCode(text)) {
    if (part.code) nodes.push(codeView(part.text));
    else nodes.push(...quotedParts(part.text, step, phrases));
  }
  return nodes;
}

/** Splits Markdown inline code spans (any fence length) out of `text`. */
function splitCode(text: string): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      plain += text[i++];
      continue;
    }
    let fence = 0;
    while (text[i + fence] === '`') fence++;
    const marker = '`'.repeat(fence);
    let close = text.indexOf(marker, i + fence);
    while (close !== -1 && text[close + fence] === '`') {
      let run = 0;
      while (text[close + run] === '`') run++;
      close = text.indexOf(marker, close + run);
    }
    if (close === -1) {
      plain += text.slice(i, i + fence);
      i += fence;
      continue;
    }
    let inner = text.slice(i + fence, close);
    if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) inner = inner.slice(1, -1);
    if (plain) parts.push({ text: plain, code: false });
    plain = '';
    parts.push({ text: inner, code: true });
    i = close + fence;
  }
  if (plain) parts.push({ text: plain, code: false });
  return parts;
}

const LOCATOR_START = /^(?:page\.|this\.page\.)?(?:getBy[A-Z]\w*|locator|frameLocator|internal:)\s*\(/;

/** A code span: an address, a locator, or other code (a test id, a file name). */
function codeView(text: string): HTMLElement {
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || text.startsWith('/')) return urlView(text);
  const code = document.createElement('code');
  if (LOCATOR_START.test(text)) {
    code.className = 'piwi-loc piwi-inline';
    code.innerHTML = highlightLocator(text);
  } else {
    code.className = 'piwi-code';
    code.textContent = text;
  }
  return code;
}

/** The quotes the phrasebook puts around a name or a value: `"…"`, `« … »`, `„…“`. */
function quoteMarks(phrases: BugPhrases): [string, string] {
  const [open = '"', close = '"'] = phrases.quote('\u0000').split('\u0000');
  return [open, close];
}

/** The key a press step names, as the phrasebook writes it (`Ctrl+A`), or null. */
function pressedKey(step: RecordedStep, phrases: BugPhrases): string | null {
  if (step.action !== 'press' || !step.value) return null;
  const [before = '', after = ''] = phrases.steps.press('\u0000', null).split('\u0000');
  const full = phrases.steps.press(step.value, null);
  if (!full.startsWith(before) || !full.endsWith(after)) return null;
  return full.slice(before.length, full.length - after.length) || null;
}

function quotedParts(text: string, step: RecordedStep | null, phrases: BugPhrases): Node[] {
  const [open, close] = quoteMarks(phrases);
  const value = step?.value != null && !step.redacted ? oneLine(step.value) : null;
  const key = step ? pressedKey(step, phrases) : null;
  const nodes: Node[] = [];
  let rest = text;
  while (rest) {
    const start = rest.indexOf(open);
    const end = start === -1 ? -1 : rest.indexOf(close, start + open.length);
    if (start === -1 || end === -1) break;
    nodes.push(...keyParts(rest.slice(0, start), key));
    const inner = rest.slice(start + open.length, end);
    const quoted = document.createElement('span');
    quoted.className = value !== null && oneLine(inner) === value ? 'piwi-value' : 'piwi-name';
    quoted.textContent = rest.slice(start, end + close.length);
    nodes.push(quoted);
    rest = rest.slice(end + close.length);
  }
  nodes.push(...keyParts(rest, key));
  return nodes;
}

function keyParts(text: string, key: string | null): Node[] {
  const at = key ? text.indexOf(key) : -1;
  if (!key || at === -1) return text ? [document.createTextNode(text)] : [];
  const kbd = document.createElement('kbd');
  kbd.className = 'piwi-kbd';
  kbd.textContent = key;
  const nodes: Node[] = [];
  if (at > 0) nodes.push(document.createTextNode(text.slice(0, at)));
  nodes.push(kbd);
  if (at + key.length < text.length) nodes.push(document.createTextNode(text.slice(at + key.length)));
  return nodes;
}

/**
 * An address with its parts told apart: the origin dimmed, the path in front,
 * the query and the fragment dimmed. `origin: false` leaves the origin out
 * when the surface already names the site.
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
  if (options.origin !== false) add(parts.origin, 'piwi-url-origin');
  add(parts.path || (parts.origin && options.origin === false ? '/' : ''), 'piwi-url-path');
  add(parts.rest, 'piwi-url-rest');
  return view;
}

/** An address split into its origin, its path, and its query and fragment; text that is no address is all path. */
export function urlParts(address: string): { origin: string; path: string; rest: string } {
  const match = /^([a-z][\w+.-]*:\/\/[^/?#]*)?([^?#]*)(.*)$/is.exec(address);
  if (!match) return { origin: '', path: address, rest: '' };
  return { origin: match[1] ?? '', path: match[2] ?? '', rest: match[3] ?? '' };
}

/**
 * The look of steps, addresses, quoted names and values, keys and code. Dark
 * first, with the light scheme's colors; `piwi-dark` on an ancestor keeps the
 * dark ones. Panels that show a locator also need `LOCATOR_SYNTAX_CSS`.
 */
export const STEP_CSS = `
  ${ICON_CSS}
  .piwi-step, .piwi-dark .piwi-step, .piwi-step-badge, .piwi-dark .piwi-step-badge, .piwi-step-words, .piwi-dark .piwi-step-words, .piwi-url, .piwi-dark .piwi-url {
    --piwi-nav: #38bdf8; --piwi-act: #a78bfa; --piwi-input: #fbbf24; --piwi-assert: #34d399; --piwi-manual: #f472b6;
    --piwi-name: #f9fafb; --piwi-value: #fcd34d; --piwi-chip: rgba(148,163,184,.16); --piwi-chip-border: rgba(148,163,184,.28);
    --piwi-url-path: #7dd3fc; --piwi-url-dim: #94a3b8;
  }
  @media (prefers-color-scheme: light) {
    .piwi-step, .piwi-step-badge, .piwi-step-words, .piwi-url {
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
  .piwi-step-badge .piwi-icon { width: 13px; height: 13px; }
  .piwi-step-words { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; padding-top: 1px; }
  .piwi-name { color: var(--piwi-name); font-weight: 600; }
  .piwi-value { color: var(--piwi-value); font-weight: 600; }
  .piwi-kbd, .piwi-code, .piwi-url, .piwi-loc.piwi-inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em;
    padding: 0 4px; border-radius: 4px; background: var(--piwi-chip); border: 1px solid var(--piwi-chip-border);
    overflow-wrap: anywhere; word-break: break-word;
  }
  .piwi-kbd { font-weight: 600; border-bottom-width: 2px; }
  .piwi-url-origin, .piwi-url-rest { color: var(--piwi-url-dim); }
  .piwi-url-path { color: var(--piwi-url-path); font-weight: 600; }
`;
