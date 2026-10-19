/**
 * The page model Playwright's locators match against: ARIA roles, accessible
 * names and descriptions, ARIA states, visibility and element text. The rules
 * follow WAI-ARIA 1.2, the Accessible Name and Description Computation and
 * HTML-AAM the way Playwright applies them, so a locator evaluated here finds
 * the elements the test runner finds. `tests/e2e/locator-engine.spec.ts` runs
 * both on the same pages and compares the results.
 *
 * A `DomModel` caches every lookup for one evaluation pass: create one, run the
 * queries, drop it. The DOM must not change while one is in use.
 *
 * Elements can come from a same-origin frame, which is another JavaScript
 * realm, so nothing here relies on `instanceof` or on the top window's globals.
 */

import { normalizeWhiteSpace, type TextMatchKind } from '@piwitests/core/locator-text-match';

export { normalizeWhiteSpace, textMatcher, type TextMatchKind } from '@piwitests/core/locator-text-match';

export interface ElementText {
  /** Every text node below the element, open shadow roots included, concatenated. */
  full: string;
  /** `full` with whitespace collapsed and trimmed. */
  normalized: string;
  /** The runs of text sitting directly inside the element, between its child elements. */
  immediate: string[];
  /** `normalized` in lower case, filled in by the first case-insensitive comparison. */
  lower?: string;
}

/** A text predicate, as `getByText`, `getByLabel` and `filter({ hasText })` build it. */
export type TextMatcher = (text: ElementText) => boolean;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

const tagNameGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName')!.get!;

/** Upper-case tag name, read through the prototype so a form field named `tagName` can't shadow it. */
export function tagNameOf(element: Element): string {
  return String(tagNameGetter.call(element)).toUpperCase();
}

/** Whitespace collapsed the way accessible names are, keeping non-breaking spaces apart. */
function flatString(text: string): string {
  return text
    .split(' ')
    .map((chunk) =>
      chunk
        .replace(/\r\n/g, '\n')
        .replace(/[​­]/g, '')
        .replace(/\s\s*/g, ' '),
    )
    .join(' ')
    .trim();
}

export function isElementNode(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === ELEMENT_NODE;
}

/** The parent element, or the host when the element sits at the top of a shadow root. */
export function parentElementOrShadowHost(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const parent = element.parentNode;
  if (parent && parent.nodeType === DOCUMENT_FRAGMENT_NODE && (parent as ShadowRoot).host) {
    return (parent as ShadowRoot).host;
  }
  return undefined;
}

function enclosingShadowRootOrDocument(element: Element): Document | ShadowRoot | undefined {
  let node: Node = element;
  while (node.parentNode) node = node.parentNode;
  if (node.nodeType === DOCUMENT_FRAGMENT_NODE || node.nodeType === DOCUMENT_NODE) {
    return node as Document | ShadowRoot;
  }
  return undefined;
}

function enclosingShadowHost(element: Element): Element | undefined {
  let top = element;
  while (top.parentElement) top = top.parentElement;
  return parentElementOrShadowHost(top);
}

/** `closest()` that keeps climbing out through shadow hosts. */
function closestCrossShadow(element: Element | undefined, css: string): Element | undefined {
  let current = element;
  while (current) {
    const found = current.closest(css);
    if (found) return found;
    current = enclosingShadowHost(current);
  }
  return undefined;
}

/** The elements an ID-reference attribute (`aria-labelledby`, `aria-owns`, …) points at, first match per id. */
function idRefs(element: Element, ref: string | null): Element[] {
  if (!ref) return [];
  const root = enclosingShadowRootOrDocument(element);
  if (!root) return [];
  const out: Element[] = [];
  try {
    for (const id of ref.split(' ')) {
      if (!id) continue;
      const found = root.querySelector('#' + CSS.escape(id));
      if (found && !out.includes(found)) out.push(found);
    }
  } catch {
    return [];
  }
  return out;
}

const VALID_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'mark',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

/** Sectioning ancestors that stop `<header>`/`<footer>` from being the page banner/contentinfo. */
const LANDMARK_BLOCKERS =
  'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

const NAME_PROHIBITED_FOR = [
  'caption',
  'code',
  'deletion',
  'emphasis',
  'generic',
  'insertion',
  'paragraph',
  'presentation',
  'strong',
  'subscript',
  'superscript',
];

/** Global ARIA attributes, with the roles on which each one does not count. */
const GLOBAL_ARIA_ATTRIBUTES: ReadonlyArray<readonly [string, readonly string[] | undefined]> = [
  ['aria-atomic', undefined],
  ['aria-busy', undefined],
  ['aria-controls', undefined],
  ['aria-current', undefined],
  ['aria-describedby', undefined],
  ['aria-details', undefined],
  ['aria-dropeffect', undefined],
  ['aria-flowto', undefined],
  ['aria-grabbed', undefined],
  ['aria-hidden', undefined],
  ['aria-keyshortcuts', undefined],
  ['aria-label', NAME_PROHIBITED_FOR],
  ['aria-labelledby', NAME_PROHIBITED_FOR],
  ['aria-live', undefined],
  ['aria-owns', undefined],
  ['aria-relevant', undefined],
  ['aria-roledescription', ['generic']],
];

const INPUT_TYPE_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  checkbox: 'checkbox',
  image: 'button',
  number: 'spinbutton',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  submit: 'button',
};

/** Elements that take on a `none`/`presentation` role from these parents. */
const PRESENTATION_PARENTS: Readonly<Record<string, readonly string[]>> = {
  DD: ['DL', 'DIV'],
  DIV: ['DL'],
  DT: ['DL', 'DIV'],
  LI: ['OL', 'UL'],
  TBODY: ['TABLE'],
  TD: ['TR'],
  TFOOT: ['TABLE'],
  TH: ['TR'],
  THEAD: ['TABLE'],
  TR: ['THEAD', 'TBODY', 'TFOOT', 'TABLE'],
};

const ALWAYS_NAMED_FROM_CONTENT = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Roles that contribute their content when they sit inside the element being named. */
const NAMED_FROM_CONTENT_AS_DESCENDANT = new Set([
  '',
  'caption',
  'code',
  'contentinfo',
  'definition',
  'deletion',
  'emphasis',
  'insertion',
  'list',
  'listitem',
  'mark',
  'none',
  'paragraph',
  'presentation',
  'region',
  'row',
  'rowgroup',
  'section',
  'strong',
  'subscript',
  'superscript',
  'table',
  'term',
  'time',
]);

/** Roles whose accessible name is always empty. */
const NAMING_PROHIBITED_ROLES = new Set([
  'caption',
  'code',
  'definition',
  'deletion',
  'emphasis',
  'generic',
  'insertion',
  'mark',
  'paragraph',
  'presentation',
  'strong',
  'subscript',
  'suggestion',
  'superscript',
  'term',
  'time',
]);

/** Roles each ARIA state option applies to, as Playwright validates `getByRole` options. */
export const ARIA_CHECKED_ROLES = [
  'checkbox',
  'menuitemcheckbox',
  'option',
  'radio',
  'switch',
  'menuitemradio',
  'treeitem',
];
export const ARIA_PRESSED_ROLES = ['button'];
export const ARIA_SELECTED_ROLES = ['gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
export const ARIA_EXPANDED_ROLES = [
  'application',
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'row',
  'rowheader',
  'tab',
  'treeitem',
  'columnheader',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
];
export const ARIA_LEVEL_ROLES = ['heading', 'listitem', 'row', 'treeitem'];
const ARIA_DISABLED_ROLES = new Set([
  'application',
  'button',
  'composite',
  'gridcell',
  'group',
  'input',
  'link',
  'menuitem',
  'scrollbar',
  'separator',
  'tab',
  'checkbox',
  'columnheader',
  'combobox',
  'grid',
  'listbox',
  'menu',
  'menubar',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'radiogroup',
  'row',
  'rowheader',
  'searchbox',
  'select',
  'slider',
  'spinbutton',
  'switch',
  'tablist',
  'textbox',
  'toolbar',
  'tree',
  'treegrid',
  'treeitem',
]);

function hasExplicitAccessibleName(element: Element): boolean {
  return element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby');
}

function hasGlobalAriaAttribute(element: Element, forRole?: string | null): boolean {
  return GLOBAL_ARIA_ATTRIBUTES.some(
    ([attr, prohibited]) => !prohibited?.includes(forRole || '') && element.hasAttribute(attr),
  );
}

function hasTabIndex(element: Element): boolean {
  return !Number.isNaN(Number(String(element.getAttribute('tabindex'))));
}

function isNativelyFocusable(element: Element): boolean {
  const tag = tagNameOf(element);
  if (tag === 'BUTTON' || tag === 'DETAILS' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'A' || tag === 'AREA') return element.hasAttribute('href');
  if (tag === 'INPUT') return !(element as HTMLInputElement).hidden;
  return false;
}

function belongsToDisabledFieldSet(element: Element): boolean {
  const fieldset = element.closest('FIELDSET[DISABLED]');
  if (!fieldset) return false;
  const legend = fieldset.querySelector(':scope > LEGEND');
  return !legend || !legend.contains(element);
}

function isNativelyDisabled(element: Element): boolean {
  const tag = tagNameOf(element);
  const isFormControl = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(tag);
  return (
    isFormControl &&
    (element.hasAttribute('disabled') ||
      (tag === 'OPTION' && !!element.closest('OPTGROUP[DISABLED]')) ||
      belongsToDisabledFieldSet(element))
  );
}

function isFocusable(element: Element): boolean {
  return !isNativelyDisabled(element) && (isNativelyFocusable(element) || hasTabIndex(element));
}

/** The first valid token of the `role` attribute. */
function explicitRole(element: Element): string | null {
  for (const token of (element.getAttribute('role') || '').split(' ')) {
    const role = token.trim();
    if (VALID_ROLES.has(role)) return role;
  }
  return null;
}

function hasPresentationConflictResolution(element: Element, role: string | null): boolean {
  return hasGlobalAriaAttribute(element, role) || isFocusable(element);
}

function isHeaderCell(element: Element | null): boolean {
  return !!element && tagNameOf(element) === 'TH';
}

function isNonEmptyDataCell(element: Element | null): boolean {
  if (!element || tagNameOf(element) !== 'TD') return false;
  return !!(element.textContent?.trim() || element.children.length > 0);
}

function tableHeaderRole(th: Element): string | null {
  const scope = th.getAttribute('scope');
  if (scope === 'col' || scope === 'colgroup') return 'columnheader';
  if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
  const next = th.nextElementSibling;
  const prev = th.previousElementSibling;
  const row = th.parentElement && tagNameOf(th.parentElement) === 'TR' ? th.parentElement : undefined;
  if (!next && !prev) {
    if (row) {
      const table = closestCrossShadow(row, 'table') as HTMLTableElement | undefined;
      if (table && table.rows.length <= 1) return null;
    }
    return 'columnheader';
  }
  if (isHeaderCell(next) && isHeaderCell(prev)) return 'columnheader';
  if (isNonEmptyDataCell(next) || isNonEmptyDataCell(prev)) return 'rowheader';
  return 'columnheader';
}

function implicitRoleOfTag(element: Element): string | null {
  const tag = tagNameOf(element);
  switch (tag) {
    case 'A':
    case 'AREA':
      return element.hasAttribute('href') ? 'link' : null;
    case 'ARTICLE':
      return 'article';
    case 'ASIDE':
      return 'complementary';
    case 'BLOCKQUOTE':
      return 'blockquote';
    case 'BUTTON':
      return 'button';
    case 'CAPTION':
      return 'caption';
    case 'CODE':
      return 'code';
    case 'DATALIST':
      return 'listbox';
    case 'DD':
      return 'definition';
    case 'DEL':
      return 'deletion';
    case 'DETAILS':
      return 'group';
    case 'DFN':
      return 'term';
    case 'DIALOG':
      return 'dialog';
    case 'DT':
      return 'term';
    case 'EM':
      return 'emphasis';
    case 'FIELDSET':
      return 'group';
    case 'FIGURE':
      return 'figure';
    case 'FOOTER':
      return closestCrossShadow(element, LANDMARK_BLOCKERS) ? null : 'contentinfo';
    case 'FORM':
      return hasExplicitAccessibleName(element) ? 'form' : null;
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'HEADER':
      return closestCrossShadow(element, LANDMARK_BLOCKERS) ? null : 'banner';
    case 'HR':
      return 'separator';
    case 'HTML':
      return 'document';
    case 'IMG':
      return element.getAttribute('alt') === '' &&
        !element.getAttribute('title') &&
        !hasGlobalAriaAttribute(element) &&
        !hasTabIndex(element)
        ? 'presentation'
        : 'img';
    case 'INPUT': {
      const type = (element as HTMLInputElement).type.toLowerCase();
      if (['email', 'search', 'tel', 'text', 'url', ''].includes(type)) {
        const list = idRefs(element, element.getAttribute('list'))[0];
        if (list && tagNameOf(list) === 'DATALIST') return 'combobox';
        return type === 'search' ? 'searchbox' : 'textbox';
      }
      if (type === 'hidden') return null;
      if (type === 'file') return 'button';
      return INPUT_TYPE_ROLES[type] || 'textbox';
    }
    case 'INS':
      return 'insertion';
    case 'LI':
      return 'listitem';
    case 'MAIN':
      return 'main';
    case 'MARK':
      return 'mark';
    case 'MATH':
      return 'math';
    case 'MENU':
      return 'list';
    case 'METER':
      return 'meter';
    case 'NAV':
      return 'navigation';
    case 'OL':
    case 'UL':
      return 'list';
    case 'OPTGROUP':
      return 'group';
    case 'OPTION':
      return 'option';
    case 'OUTPUT':
      return 'status';
    case 'P':
      return 'paragraph';
    case 'PROGRESS':
      return 'progressbar';
    case 'SEARCH':
      return 'search';
    case 'SECTION':
      return hasExplicitAccessibleName(element) ? 'region' : null;
    case 'SELECT':
      return element.hasAttribute('multiple') || (element as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'STRONG':
      return 'strong';
    case 'SUB':
      return 'subscript';
    case 'SUP':
      return 'superscript';
    case 'SVG':
      return 'img';
    case 'TABLE':
      return 'table';
    case 'TBODY':
    case 'THEAD':
    case 'TFOOT':
      return 'rowgroup';
    case 'TD': {
      const table = closestCrossShadow(element, 'table');
      const role = table ? explicitRole(table) : '';
      return role === 'grid' || role === 'treegrid' ? 'gridcell' : 'cell';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'TH':
      return tableHeaderRole(element);
    case 'TIME':
      return 'time';
    case 'TR':
      return 'row';
    default:
      return null;
  }
}

function implicitRole(element: Element): string | null {
  const role = implicitRoleOfTag(element);
  if (!role) return null;
  // A list item inside `<ul role="none">`, a cell inside `<tr role="presentation">`, … inherit that role.
  let current = element;
  for (;;) {
    const parent = parentElementOrShadowHost(current);
    const parents = PRESENTATION_PARENTS[tagNameOf(current)];
    if (!parents || !parent || !parents.includes(tagNameOf(parent))) break;
    const parentRole = explicitRole(parent);
    if (
      (parentRole === 'none' || parentRole === 'presentation') &&
      !hasPresentationConflictResolution(parent, parentRole)
    ) {
      return parentRole;
    }
    current = parent;
  }
  return role;
}

function ariaBoolean(value: string | null): boolean | undefined {
  return value === null ? undefined : value.toLowerCase() === 'true';
}

function isIgnoredForAria(element: Element): boolean {
  return ['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'].includes(tagNameOf(element));
}

function allowsNameFromContent(role: string, asDescendant: boolean): boolean {
  return ALWAYS_NAMED_FROM_CONTENT.has(role) || (asDescendant && NAMED_FROM_CONTENT_AS_DESCENDANT.has(role));
}

/** Where a text alternative is being computed from, for the accessible-name rules that depend on it. */
interface Embedding {
  element: Element;
  hidden: boolean;
}

interface NameContext {
  includeHidden: boolean;
  visited: Set<Element>;
  labelledBy?: Embedding;
  describedBy?: Embedding;
  label?: Embedding;
  nativeTextAlternative?: Embedding;
  /** `self` for the element being named, `descendant` for anything inside it. */
  target?: 'self' | 'descendant';
}

/** One CSS `content` token: a string, an `attr()` call, the `/` alt-text separator, or anything else. */
type ContentToken =
  | { kind: 'string'; value: string }
  | { kind: 'attr'; name: string }
  | { kind: 'slash' }
  | { kind: 'other' };

function readCssString(value: string, start: number): { text: string; end: number } | null {
  const quote = value[start];
  let text = '';
  let i = start + 1;
  while (i < value.length) {
    const c = value[i]!;
    if (c === quote) return { text, end: i + 1 };
    if (c !== '\\') {
      text += c;
      i++;
      continue;
    }
    const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(value.slice(i + 1));
    if (hex) {
      text += String.fromCodePoint(parseInt(hex[0].trim(), 16) || 0xfffd);
      i += 1 + hex[0].length;
      continue;
    }
    if (value[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (i + 1 < value.length) text += value[i + 1];
    i += 2;
  }
  return null;
}

function tokenizeCssContent(value: string): ContentToken[] | null {
  const tokens: ContentToken[] = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const str = readCssString(value, i);
      if (!str) return null;
      tokens.push({ kind: 'string', value: str.text });
      i = str.end;
      continue;
    }
    if (c === '/') {
      tokens.push({ kind: 'slash' });
      i++;
      continue;
    }
    const attr = /^attr\(\s*([-\w]+)\s*\)/i.exec(value.slice(i));
    if (attr) {
      tokens.push({ kind: 'attr', name: attr[1]! });
      i += attr[0].length;
      continue;
    }
    const fn = /^[-\w]+\(/.exec(value.slice(i));
    if (fn) {
      // Skip a whole function call, strings and nested parentheses included.
      let depth = 0;
      let j = i;
      while (j < value.length) {
        const ch = value[j]!;
        if (ch === '"' || ch === "'") {
          const str = readCssString(value, j);
          if (!str) return null;
          j = str.end;
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      tokens.push({ kind: 'other' });
      i = j;
      continue;
    }
    const word = /^[^\s"'/]+/.exec(value.slice(i));
    tokens.push({ kind: 'other' });
    i += word ? word[0].length : 1;
  }
  return tokens;
}

/**
 * The text a CSS `content` value contributes: its strings and `attr()` values,
 * or only its alternative text after `/` when it has one. The element's own
 * `content` (not a pseudo-element) only counts through alternative text.
 */
function cssContentText(element: Element, value: string, isPseudo: boolean): string | undefined {
  if (!value || value === 'none' || value === 'normal') return undefined;
  let tokens = tokenizeCssContent(value);
  if (!tokens) return undefined;
  const slash = tokens.findIndex((t) => t.kind === 'slash');
  if (slash !== -1) tokens = tokens.slice(slash + 1);
  else if (!isPseudo) return undefined;
  const parts: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'string') parts.push(token.value);
    else if (token.kind === 'attr') parts.push(element.getAttribute(token.name) || '');
    else return undefined;
  }
  return parts.join('');
}

export class DomModel {
  private readonly styles = new Map<Element, CSSStyleDeclaration | undefined>();
  private readonly beforeStyles = new Map<Element, CSSStyleDeclaration | undefined>();
  private readonly afterStyles = new Map<Element, CSSStyleDeclaration | undefined>();
  private readonly styleVisibility = new Map<Element, boolean>();
  private readonly roles = new Map<Element, string | null>();
  private readonly hiddenChain = new Map<Element, boolean>();
  private readonly names = new Map<Element, string>();
  private readonly hiddenNames = new Map<Element, string>();
  private readonly contents = new Map<Element, string | undefined>();
  private readonly beforeContents = new Map<Element, string | undefined>();
  private readonly afterContents = new Map<Element, string | undefined>();
  private readonly disabledChain = new Map<Element, boolean>();
  private readonly texts = new Map<Element | ShadowRoot, ElementText>();
  private readonly labelTexts = new Map<Element, ElementText[]>();
  private readonly hiddenForAria = new Map<Element, boolean>();
  private readonly normalizedNames = new Map<Element, string>();
  private readonly normalizedHiddenNames = new Map<Element, string>();

  style(element: Element, pseudo?: '::before' | '::after'): CSSStyleDeclaration | undefined {
    const cache = pseudo === '::before' ? this.beforeStyles : pseudo === '::after' ? this.afterStyles : this.styles;
    if (cache.has(element)) return cache.get(element);
    const view = element.ownerDocument?.defaultView;
    const style = view ? view.getComputedStyle(element, pseudo) : undefined;
    cache.set(element, style);
    return style;
  }

  /** Rendered and not `visibility: hidden` — no box check. */
  isStyleVisible(element: Element, style?: CSSStyleDeclaration): boolean {
    if (!style) {
      const cached = this.styleVisibility.get(element);
      if (cached !== undefined) return cached;
    }
    const computed = style ?? this.style(element);
    let visible = true;
    if (computed) {
      const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
      if (typeof check === 'function') {
        if (!check.call(element)) visible = false;
      } else {
        const details = element.closest('details,summary');
        if (
          details !== element &&
          details &&
          tagNameOf(details) === 'DETAILS' &&
          !(details as HTMLDetailsElement).open
        ) {
          visible = false;
        }
      }
      if (visible && computed.visibility !== 'visible') visible = false;
    }
    if (!style) this.styleVisibility.set(element, visible);
    return visible;
  }

  /** Visible the way Playwright's `visible` filter means it: rendered, not hidden, with a non-empty box. */
  isVisible(element: Element): boolean {
    const style = this.style(element);
    if (!style) return true;
    if (style.display === 'contents') {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === ELEMENT_NODE && this.isVisible(child as Element)) return true;
        if (child.nodeType === TEXT_NODE && isVisibleTextNode(child as Text)) return true;
      }
      return false;
    }
    if (!this.isStyleVisible(element, style)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  role(element: Element): string | null {
    const cached = this.roles.get(element);
    if (cached !== undefined) return cached;
    const explicit = explicitRole(element);
    let role: string | null;
    if (!explicit) {
      role = implicitRole(element);
    } else if (explicit === 'none' || explicit === 'presentation') {
      const implicit = implicitRole(element);
      role = hasPresentationConflictResolution(element, implicit) ? implicit : explicit;
    } else {
      role = explicit;
    }
    this.roles.set(element, role);
    return role;
  }

  /** Left out of the accessibility tree: not rendered, `aria-hidden`, or unslotted shadow content. */
  isHiddenForAria(element: Element): boolean {
    let hidden = this.hiddenForAria.get(element);
    if (hidden === undefined) {
      hidden = this.computeHiddenForAria(element);
      this.hiddenForAria.set(element, hidden);
    }
    return hidden;
  }

  private computeHiddenForAria(element: Element): boolean {
    if (isIgnoredForAria(element)) return true;
    const style = this.style(element);
    const isSlot = element.nodeName === 'SLOT';
    if (style?.display === 'contents' && !isSlot) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === ELEMENT_NODE && !this.isHiddenForAria(child as Element)) return false;
        if (child.nodeType === TEXT_NODE && isVisibleTextNode(child as Text)) return false;
      }
      return true;
    }
    const isOptionInsideSelect = element.nodeName === 'OPTION' && !!element.closest('select');
    if (!isOptionInsideSelect && !isSlot && !this.isStyleVisible(element, style)) return true;
    return this.belongsToHiddenSubtree(element);
  }

  private belongsToHiddenSubtree(element: Element): boolean {
    const cached = this.hiddenChain.get(element);
    if (cached !== undefined) return cached;
    let hidden = false;
    if (element.parentElement && element.parentElement.shadowRoot && !element.assignedSlot) hidden = true;
    if (!hidden) {
      const style = this.style(element);
      hidden = !style || style.display === 'none' || ariaBoolean(element.getAttribute('aria-hidden')) === true;
    }
    if (!hidden) {
      const parent = parentElementOrShadowHost(element);
      if (parent) hidden = this.belongsToHiddenSubtree(parent);
    }
    this.hiddenChain.set(element, hidden);
    return hidden;
  }

  /** The accessible name, whitespace collapsed. */
  accessibleName(element: Element, includeHidden: boolean): string {
    const cache = includeHidden ? this.hiddenNames : this.names;
    const cached = cache.get(element);
    if (cached !== undefined) return cached;
    let name = '';
    if (!NAMING_PROHIBITED_ROLES.has(this.role(element) || '')) {
      name = flatString(this.textAlternative(element, { includeHidden, visited: new Set(), target: 'self' }));
    }
    cache.set(element, name);
    return name;
  }

  /** The accessible name as `getByRole` compares it: whitespace collapsed and trimmed. */
  normalizedAccessibleName(element: Element, includeHidden: boolean): string {
    const cache = includeHidden ? this.normalizedHiddenNames : this.normalizedNames;
    let name = cache.get(element);
    if (name === undefined) {
      name = normalizeWhiteSpace(this.accessibleName(element, includeHidden));
      cache.set(element, name);
    }
    return name;
  }

  accessibleDescription(element: Element, includeHidden: boolean): string {
    if (element.hasAttribute('aria-describedby')) {
      const refs = idRefs(element, element.getAttribute('aria-describedby'));
      return flatString(
        refs
          .map((ref) =>
            this.textAlternative(ref, {
              includeHidden,
              visited: new Set(),
              describedBy: { element: ref, hidden: this.isHiddenForAria(ref) },
            }),
          )
          .join(' '),
      );
    }
    if (element.hasAttribute('aria-description')) return flatString(element.getAttribute('aria-description') || '');
    return flatString(element.getAttribute('title') || '');
  }

  private cssContent(element: Element, pseudo?: '::before' | '::after'): string | undefined {
    const cache =
      pseudo === '::before' ? this.beforeContents : pseudo === '::after' ? this.afterContents : this.contents;
    if (cache.has(element)) return cache.get(element);
    const style = this.style(element, pseudo);
    let content: string | undefined;
    if (style && style.content && style.content !== 'none' && style.content !== 'normal') {
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        content = cssContentText(element, style.content, !!pseudo);
      }
    }
    if (pseudo && content !== undefined && (style?.display || 'inline') !== 'inline') content = ` ${content} `;
    cache.set(element, content);
    return content;
  }

  private labelsText(labels: ArrayLike<Element>, ctx: NameContext): string {
    return Array.from(labels)
      .map((label) =>
        this.textAlternative(label, {
          ...ctx,
          label: { element: label, hidden: this.isHiddenForAria(label) },
          nativeTextAlternative: undefined,
          labelledBy: undefined,
          describedBy: undefined,
          target: undefined,
        }),
      )
      .filter((text) => !!text)
      .join(' ');
  }

  private textAlternative(element: Element, ctx: NameContext): string {
    if (ctx.visited.has(element)) return '';
    const childCtx: NameContext = { ...ctx, target: ctx.target === 'self' ? 'descendant' : ctx.target };

    if (!ctx.includeHidden) {
      const inHiddenReference =
        !!ctx.labelledBy?.hidden ||
        !!ctx.describedBy?.hidden ||
        !!ctx.nativeTextAlternative?.hidden ||
        !!ctx.label?.hidden;
      if (isIgnoredForAria(element) || (!inHiddenReference && this.isHiddenForAria(element))) {
        ctx.visited.add(element);
        return '';
      }
    }

    const labelledByAttr = element.getAttribute('aria-labelledby');
    const labelledBy = labelledByAttr === null ? null : idRefs(element, labelledByAttr);
    const labelledByRefs = labelledBy && labelledBy.length ? labelledBy : null;
    if (!ctx.labelledBy && labelledByRefs) {
      const name = labelledByRefs
        .map((ref) =>
          this.textAlternative(ref, {
            ...ctx,
            labelledBy: { element: ref, hidden: this.isHiddenForAria(ref) },
            describedBy: undefined,
            target: undefined,
            label: undefined,
            nativeTextAlternative: undefined,
          }),
        )
        .join(' ');
      if (name) return name;
    }

    const role = this.role(element) || '';
    const tag = tagNameOf(element);

    // A control embedded in the text being computed contributes its value.
    if (!!ctx.label || !!ctx.labelledBy || ctx.target === 'descendant') {
      const labels = (element as HTMLInputElement).labels;
      const isOwnLabel = !!labels && Array.from(labels).includes(element as HTMLLabelElement);
      const isOwnLabelledBy = !!labelledByRefs && labelledByRefs.includes(element);
      if (!isOwnLabel && !isOwnLabelledBy) {
        if (role === 'textbox' || role === 'searchbox') {
          ctx.visited.add(element);
          if (tag === 'INPUT' || tag === 'TEXTAREA') return (element as HTMLInputElement).value || '';
          return element.textContent || '';
        }
        if (role === 'combobox' || role === 'listbox') {
          ctx.visited.add(element);
          let selected: Element[];
          if (tag === 'SELECT') {
            const select = element as HTMLSelectElement;
            selected = Array.from(select.selectedOptions);
            if (!selected.length && select.options.length) selected.push(select.options[0]!);
          } else {
            const listbox =
              role === 'combobox'
                ? this.queryInAriaOwned(element, '*').find((e) => this.role(e) === 'listbox')
                : element;
            selected = listbox
              ? this.queryInAriaOwned(listbox, '[aria-selected="true"]').filter((e) => this.role(e) === 'option')
              : [];
          }
          if (!selected.length && tag === 'INPUT') return (element as HTMLInputElement).value || '';
          return selected.map((option) => this.textAlternative(option, childCtx)).join(' ');
        }
        if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
          ctx.visited.add(element);
          if (element.hasAttribute('aria-valuetext')) return element.getAttribute('aria-valuetext') || '';
          if (element.hasAttribute('aria-valuenow')) return element.getAttribute('aria-valuenow') || '';
          return element.getAttribute('value') || '';
        }
        if (role === 'menu') {
          ctx.visited.add(element);
          return '';
        }
      }
    }

    const ariaLabel = element.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) {
      ctx.visited.add(element);
      return ariaLabel;
    }

    if (role !== 'presentation' && role !== 'none') {
      const native = this.nativeTextAlternative(element, tag, !!labelledByRefs, ctx, childCtx);
      if (native !== undefined) return native;
    }

    const summaryNamedFromContent = tag === 'SUMMARY' && role !== 'presentation' && role !== 'none';
    if (
      allowsNameFromContent(role, ctx.target === 'descendant') ||
      summaryNamedFromContent ||
      !!ctx.labelledBy ||
      !!ctx.describedBy ||
      !!ctx.label ||
      !!ctx.nativeTextAlternative
    ) {
      ctx.visited.add(element);
      const text = this.accumulatedText(element, childCtx);
      const kept = ctx.target === 'self' ? text.trim() : text;
      if (kept) return text;
    }

    if ((role !== 'presentation' && role !== 'none') || tag === 'IFRAME' || tag === 'FRAME') {
      ctx.visited.add(element);
      const title = element.getAttribute('title') || '';
      if (title.trim()) return title;
    }

    ctx.visited.add(element);
    return '';
  }

  /** The name HTML gives an element through its own attributes or children, or undefined to fall through. */
  private nativeTextAlternative(
    element: Element,
    tag: string,
    hasLabelledBy: boolean,
    ctx: NameContext,
    childCtx: NameContext,
  ): string | undefined {
    const input = element as HTMLInputElement;
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(input.type)) {
      ctx.visited.add(element);
      const value = input.value || '';
      if (value.trim()) return value;
      if (input.type === 'submit') return 'Submit';
      if (input.type === 'reset') return 'Reset';
      return element.getAttribute('title') || '';
    }
    if (tag === 'INPUT' && input.type === 'file') {
      ctx.visited.add(element);
      const labels = input.labels || [];
      if (labels.length && !ctx.labelledBy) return this.labelsText(labels, ctx);
      return 'Choose File';
    }
    if (tag === 'INPUT' && input.type === 'image') {
      ctx.visited.add(element);
      const labels = input.labels || [];
      if (labels.length && !ctx.labelledBy) return this.labelsText(labels, ctx);
      const alt = element.getAttribute('alt') || '';
      if (alt.trim()) return alt;
      const title = element.getAttribute('title') || '';
      if (title.trim()) return title;
      return 'Submit';
    }
    if (!hasLabelledBy && tag === 'BUTTON') {
      ctx.visited.add(element);
      const labels = (element as HTMLButtonElement).labels || [];
      if (labels.length) return this.labelsText(labels, ctx);
    }
    if (!hasLabelledBy && tag === 'OUTPUT') {
      ctx.visited.add(element);
      const labels = (element as HTMLOutputElement).labels || [];
      if (labels.length) return this.labelsText(labels, ctx);
      return element.getAttribute('title') || '';
    }
    if (!hasLabelledBy && ['TEXTAREA', 'SELECT', 'INPUT', 'METER', 'PROGRESS'].includes(tag)) {
      ctx.visited.add(element);
      const labels = (element as HTMLInputElement).labels || [];
      if (labels.length) return this.labelsText(labels, ctx);
      const usesPlaceholder =
        (tag === 'INPUT' && ['text', 'password', 'number', 'search', 'tel', 'email', 'url'].includes(input.type)) ||
        tag === 'TEXTAREA';
      const placeholder = element.getAttribute('placeholder') || '';
      const title = element.getAttribute('title') || '';
      return !usesPlaceholder || title ? title : placeholder;
    }
    if (!hasLabelledBy && (tag === 'FIELDSET' || tag === 'FIGURE')) {
      ctx.visited.add(element);
      const captionTag = tag === 'FIELDSET' ? 'LEGEND' : 'FIGCAPTION';
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (tagNameOf(child) === captionTag) {
          return this.textAlternative(child, {
            ...childCtx,
            nativeTextAlternative: { element: child, hidden: this.isHiddenForAria(child) },
          });
        }
      }
      return element.getAttribute('title') || '';
    }
    if (tag === 'IMG' || tag === 'AREA') {
      ctx.visited.add(element);
      const alt = element.getAttribute('alt') || '';
      if (alt.trim()) return alt;
      return element.getAttribute('title') || '';
    }
    if (tag === 'TABLE') {
      ctx.visited.add(element);
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (tagNameOf(child) === 'CAPTION') {
          return this.textAlternative(child, {
            ...childCtx,
            nativeTextAlternative: { element: child, hidden: this.isHiddenForAria(child) },
          });
        }
      }
      const summary = element.getAttribute('summary') || '';
      if (summary) return summary;
    }
    const svgOwner = (element as SVGElement).ownerSVGElement;
    if (tag === 'SVG' || svgOwner) {
      ctx.visited.add(element);
      for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
        if (tagNameOf(child) === 'TITLE' && (child as SVGElement).ownerSVGElement) {
          return this.textAlternative(child, {
            ...childCtx,
            labelledBy: { element: child, hidden: this.isHiddenForAria(child) },
          });
        }
      }
    }
    if (svgOwner && tag === 'A') {
      const title = element.getAttribute('xlink:title') || '';
      if (title.trim()) {
        ctx.visited.add(element);
        return title;
      }
    }
    return undefined;
  }

  private queryInAriaOwned(element: Element, selector: string): Element[] {
    const result = Array.from(element.querySelectorAll(selector));
    for (const owned of idRefs(element, element.getAttribute('aria-owns'))) {
      if (owned.matches(selector)) result.push(owned);
      result.push(...Array.from(owned.querySelectorAll(selector)));
    }
    return result;
  }

  /** Name from content: pseudo-element text, then children (slotted, shadow and owned), in order. */
  private accumulatedText(element: Element, ctx: NameContext): string {
    const tokens: string[] = [];
    const visit = (node: Node, skipSlotted: boolean) => {
      if (skipSlotted && (node as Element | Text).assignedSlot) return;
      if (node.nodeType === ELEMENT_NODE) {
        const display = this.style(node as Element)?.display || 'inline';
        let token = this.textAlternative(node as Element, ctx);
        if (display !== 'inline' || node.nodeName === 'BR') token = ` ${token} `;
        tokens.push(token);
      } else if (node.nodeType === TEXT_NODE) {
        tokens.push(node.textContent || '');
      }
    };
    tokens.push(this.cssContent(element, '::before') || '');
    const content = this.cssContent(element);
    if (content !== undefined) {
      tokens.push(content);
    } else {
      const assigned = element.nodeName === 'SLOT' ? (element as HTMLSlotElement).assignedNodes() : [];
      if (assigned.length) {
        for (const child of assigned) visit(child, false);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) visit(child, true);
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling) visit(child, true);
        }
        for (const owned of idRefs(element, element.getAttribute('aria-owns'))) visit(owned, true);
      }
    }
    tokens.push(this.cssContent(element, '::after') || '');
    return tokens.join('');
  }

  /** `true`, `false` or `'mixed'` for elements that can be checked; `'error'` for any other. */
  private checkedState(element: Element): boolean | 'mixed' | 'error' {
    const tag = tagNameOf(element);
    const input = element as HTMLInputElement;
    if (tag === 'INPUT' && input.indeterminate) return 'mixed';
    if (tag === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) return input.checked;
    if (ARIA_CHECKED_ROLES.includes(this.role(element) || '')) {
      const checked = element.getAttribute('aria-checked');
      if (checked === 'true') return true;
      if (checked === 'mixed') return 'mixed';
      return false;
    }
    return 'error';
  }

  checked(element: Element): boolean | 'mixed' {
    const state = this.checkedState(element);
    return state === 'error' ? false : state;
  }

  pressed(element: Element): boolean | 'mixed' {
    if (ARIA_PRESSED_ROLES.includes(this.role(element) || '')) {
      const pressed = element.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'mixed') return 'mixed';
    }
    return false;
  }

  selected(element: Element): boolean {
    if (tagNameOf(element) === 'OPTION') return (element as HTMLOptionElement).selected;
    if (ARIA_SELECTED_ROLES.includes(this.role(element) || '')) {
      return ariaBoolean(element.getAttribute('aria-selected')) === true;
    }
    return false;
  }

  expanded(element: Element): boolean | undefined {
    if (tagNameOf(element) === 'DETAILS') return (element as HTMLDetailsElement).open;
    if (ARIA_EXPANDED_ROLES.includes(this.role(element) || '')) {
      const expanded = element.getAttribute('aria-expanded');
      if (expanded === null) return undefined;
      return expanded === 'true';
    }
    return undefined;
  }

  level(element: Element): number {
    const native = /^H([1-6])$/.exec(tagNameOf(element));
    if (native) return Number(native[1]);
    if (ARIA_LEVEL_ROLES.includes(this.role(element) || '')) {
      const attr = element.getAttribute('aria-level');
      const value = attr === null ? Number.NaN : Number(attr);
      if (Number.isInteger(value) && value >= 1) return value;
    }
    return 0;
  }

  disabled(element: Element): boolean {
    if (isNativelyDisabled(element)) return true;
    if (!ARIA_DISABLED_ROLES.has(this.role(element) || '')) return false;
    return this.ariaDisabledInChain(element);
  }

  private ariaDisabledInChain(element: Element): boolean {
    const cached = this.disabledChain.get(element);
    if (cached !== undefined) return cached;
    const attribute = (element.getAttribute('aria-disabled') || '').toLowerCase();
    let result: boolean;
    if (attribute === 'true') result = true;
    else if (attribute === 'false') result = false;
    else {
      const parent = parentElementOrShadowHost(element);
      result = parent ? this.ariaDisabledInChain(parent) : false;
    }
    this.disabledChain.set(element, result);
    return result;
  }

  /** Text as Playwright's text engines read it: text nodes, open shadow roots, and the value of button inputs. */
  text(root: Element | ShadowRoot): ElementText {
    const cached = this.texts.get(root);
    if (cached !== undefined) return cached;
    let value: ElementText = { full: '', normalized: '', immediate: [] };
    if (!skippedForTextMatching(root)) {
      const input = root as HTMLInputElement;
      if (
        root.nodeType === ELEMENT_NODE &&
        tagNameOf(root as Element) === 'INPUT' &&
        (input.type === 'submit' || input.type === 'button' || input.type === 'reset')
      ) {
        value = { full: input.value, normalized: normalizeWhiteSpace(input.value), immediate: [input.value] };
      } else {
        let current = '';
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === TEXT_NODE) {
            value.full += child.nodeValue || '';
            current += child.nodeValue || '';
          } else if (child.nodeType === COMMENT_NODE) {
            continue;
          } else {
            if (current) value.immediate.push(current);
            current = '';
            if (child.nodeType === ELEMENT_NODE) value.full += this.text(child as Element).full;
          }
        }
        if (current) value.immediate.push(current);
        const shadow = (root as Element).shadowRoot;
        if (shadow) value.full += this.text(shadow).full;
        if (value.full) value.normalized = normalizeWhiteSpace(value.full);
      }
    }
    this.texts.set(root, value);
    return value;
  }

  /**
   * Whether an element's text matches, and whether one of its children's does
   * too: text engines keep the innermost elements that match.
   */
  matchesText(element: Element, matcher: TextMatcher): 'none' | 'self' | 'selfAndChildren' {
    if (skippedForTextMatching(element)) return 'none';
    if (!matcher(this.text(element))) return 'none';
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === ELEMENT_NODE && matcher(this.text(child as Element))) return 'selfAndChildren';
    }
    if (element.shadowRoot && matcher(this.text(element.shadowRoot))) return 'selfAndChildren';
    return 'self';
  }

  /** The label texts `getByLabel` compares: `aria-labelledby`, then `aria-label`, then associated `<label>`s. */
  labels(element: Element): ElementText[] {
    let cached = this.labelTexts.get(element);
    if (!cached) {
      cached = this.computeLabels(element);
      this.labelTexts.set(element, cached);
    }
    return cached;
  }

  private computeLabels(element: Element): ElementText[] {
    const ref = element.getAttribute('aria-labelledby');
    if (ref !== null) {
      const refs = idRefs(element, ref);
      if (refs.length) return refs.map((label) => this.text(label));
    }
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim()) {
      return [{ full: ariaLabel, normalized: normalizeWhiteSpace(ariaLabel), immediate: [ariaLabel] }];
    }
    const tag = tagNameOf(element);
    const isNonHiddenInput = tag === 'INPUT' && (element as HTMLInputElement).type !== 'hidden';
    if (['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(tag) || isNonHiddenInput) {
      const labels = (element as HTMLInputElement).labels;
      if (labels) return Array.from(labels).map((label) => this.text(label));
    }
    return [];
  }
}

function skippedForTextMatching(node: Element | ShadowRoot): boolean {
  const name = node.nodeName;
  if (name === 'SCRIPT' || name === 'NOSCRIPT' || name === 'STYLE') return true;
  const head = node.ownerDocument?.head;
  return !!head && head.contains(node);
}

function isVisibleTextNode(node: Text): boolean {
  const range = node.ownerDocument.createRange();
  range.selectNode(node);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The legacy `text=` selector's predicate: quoted text matches one text node
 * exactly, unquoted text is a case-insensitive substring, `/re/` a regex.
 */
export function legacyTextMatcher(body: string): { matcher: TextMatcher; kind: TextMatchKind } {
  if (body[0] === '/' && body.lastIndexOf('/') > 0) {
    const last = body.lastIndexOf('/');
    const re = new RegExp(body.substring(1, last), body.substring(last + 1));
    return { matcher: (text) => re.test(text.full), kind: 'regex' };
  }
  let value = body;
  let strict = false;
  if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    value = cssUnquote(value);
    strict = true;
  }
  const needle = normalizeWhiteSpace(value);
  if (strict) {
    return {
      matcher: (text) =>
        !needle && !text.immediate.length ? true : text.immediate.some((s) => normalizeWhiteSpace(s) === needle),
      kind: 'strict',
    };
  }
  const lower = needle.toLowerCase();
  return { matcher: (text) => text.normalized.toLowerCase().includes(lower), kind: 'lax' };
}

function cssUnquote(quoted: string): string {
  const inner = quoted.substring(1, quoted.length - 1);
  if (!inner.includes('\\')) return inner;
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && i + 1 < inner.length) i++;
    out += inner[i];
  }
  return out;
}
