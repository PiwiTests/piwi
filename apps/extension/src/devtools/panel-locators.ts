import { copyWithFeedback } from '../shared/clipboard.js';
import { COPY_MODE_ICONS, COPY_MODES, copyModeLabel, renderCopyMode, type CopyMode } from '../shared/copy-modes.js';
import type { LocatorMatch, LocatorQueryResult } from '../shared/devtools-selection.js';
import { getEditorPairing } from '../shared/editor-pairing.js';
import { sendToEditor, showSendResult } from '../shared/editor-send.js';
import { formatNumber, t, tn } from '../shared/i18n.js';
import { bareLocator, getLocatorHistory, HistoryCursor, rememberLocator } from '../shared/locator-console.js';
import { patternOrigin } from '../shared/web-origin.js';
import { evalInPage, requestSiteAccess } from './inspected.js';
import { callPageScript, revealMatch } from './page-script.js';
import { icon } from '../shared/icons.js';
import { openSessionForm } from './session-form.js';
import { button, el, emptyState, iconLine, noAccessText } from './ui.js';

/**
 * The Locators tab: the locator console beside DevTools. A locator typed here
 * is read by the shared parser and resolved by the engine over the inspected
 * page, as Playwright resolves it; each element it finds is listed, outlined on
 * the page while hovered, and selected in the Elements panel with Reveal. A
 * locator that reads is copied in a copy mode, added to the session, or sent to
 * the paired editor from the row under the field. Enter evaluates the expression at once and keeps it in
 * the history (`locator-console.ts`), which the arrow keys walk from the field.
 */

/** How long typing pauses before the locator is tried. */
const TYPING_MS = 150;
/** How many matches the content script lists; more are counted, not listed. */
const LISTED = 50;

/** The field's text while the panel stays open; null until the first draw, which recalls the newest of the history. */
let expression: string | null = null;

/** The copy mode chosen last, which Send to editor sends. */
let sendMode: CopyMode = 'bare';

/** The locator as `mode` writes it: the console's one rendering of a copy mode. */
function inMode(locator: string, mode: CopyMode): string {
  return renderCopyMode({ locator }, mode);
}

/** The inspected page's address, read in the page, for a pick added to the session. */
async function inspectedHref(): Promise<string> {
  const href = await evalInPage<string>('location.href');
  return href.ok && typeof href.value === 'string' ? href.value : '';
}

/**
 * What the console does with a locator that reads: Copy as each copy mode, Add
 * to session and, with an editor paired, Send to editor in the copy mode chosen
 * last, each keeping the expression in the history first.
 */
function actionsRow(host: HTMLElement, locator: string, paired: boolean, remember: () => void): HTMLElement {
  const row = el('div', 'row-actions');
  row.appendChild(el('span', 'copy-label', t('devtools_copyAs')));
  let send: HTMLButtonElement | null = null;
  for (const mode of COPY_MODES) {
    const text = inMode(locator, mode);
    const copy = button(
      copyModeLabel(mode),
      () => {
        remember();
        sendMode = mode;
        if (send) send.title = text;
        void copyWithFeedback(text, copy);
      },
      { icon: COPY_MODE_ICONS[mode], tone: 'ghost', title: text },
    );
    row.appendChild(copy);
  }
  if (paired) {
    const sent = button(
      t('devtools_sendToEditor'),
      () => {
        remember();
        void sendToEditor({ kind: 'locator', text: inMode(locator, sendMode) }).then((result) =>
          showSendResult(sent, result),
        );
      },
      { icon: 'send', tone: 'ghost', className: 'send', title: inMode(locator, sendMode) },
    );
    send = sent;
    row.appendChild(sent);
  }
  row.appendChild(
    button(
      t('devtools_addToSession'),
      () => {
        remember();
        openSessionForm(host, locator, inspectedHref);
      },
      { icon: 'plus', tone: 'ghost', className: 'add-to-session' },
    ),
  );
  return row;
}

/** What a match is: its role on a chip and its name, or its tag when it has no role. */
function matchView(match: LocatorMatch): HTMLElement {
  const words = el('div', 'step-words');
  if (!match.role) {
    words.appendChild(el('code', 'role', `<${match.tag}>`));
    return words;
  }
  words.appendChild(el('span', 'role', match.role));
  if (match.name) words.append(' · ', el('span', 'match-name', match.name));
  return words;
}

export function renderLocatorsTab(container: HTMLElement): void {
  const input = el('input');
  input.type = 'text';
  input.className = 'mono locator-input';
  input.spellcheck = false;
  input.value = expression ?? '';
  input.placeholder = t('devtools_locatorPlaceholder');
  input.setAttribute('aria-label', t('console_expression'));
  const verdict = el('p', 'status');
  verdict.setAttribute('role', 'status');
  const head = el('div', 'view-head locator-head');
  head.append(input, verdict);
  const actions = el('div', 'console-actions');
  actions.hidden = true;
  const results = el('div', 'locator-results');
  container.replaceChildren(head, actions, results);

  const cursor = new HistoryCursor();
  // Read once per draw of the tab: pairing or unpairing in the settings shows the next time it opens.
  const paired = getEditorPairing()
    .then((pairing) => pairing !== null)
    .catch(() => false);
  const remember = () => {
    const value = input.value.trim();
    if (value) void rememberLocator(value).then((history) => cursor.reset(history));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const run = async () => {
    const mine = ++generation;
    expression = input.value;
    const typed = expression.trim();
    actions.hidden = true;
    if (!typed) {
      verdict.replaceChildren();
      results.replaceChildren(iconLine('info', 'view-note', t('devtools_locatorsHint')));
      void callPageScript('highlight', null);
      return;
    }
    const answer = await callPageScript<LocatorQueryResult>('query', typed);
    if (mine !== generation) return;
    if (!answer.ok) {
      verdict.replaceChildren();
      if (answer.reason === 'restricted') {
        results.replaceChildren(emptyState('blocked', t('devtools_restricted')));
        return;
      }
      const allow = button(
        t('devtools_allowSite'),
        () => {
          void requestSiteAccess(answer.pattern).then((granted) => {
            if (granted) void run();
          });
        },
        { icon: 'check', tone: 'primary' },
      );
      results.replaceChildren(emptyState('lock', noAccessText(patternOrigin(answer.pattern)), allow));
      return;
    }
    const result = answer.value;
    if (!result.ok) {
      verdict.className = 'status bad-text';
      verdict.textContent = result.selector
        ? t('console_invalidCss', { selector: result.selector })
        : t('console_unreadable', { error: result.error });
      results.replaceChildren();
      return;
    }
    const canSend = await paired;
    if (mine !== generation) return;
    actions.replaceChildren(actionsRow(actions, bareLocator(typed), canSend, remember));
    actions.hidden = false;
    verdict.className = result.count === 1 ? 'status icon-line good-text' : 'status icon-line warn-text';
    const said = el('span');
    said.textContent =
      result.count === 1
        ? t('console_unique')
        : result.count === 0
          ? t('console_none')
          : tn('console_many', result.count);
    verdict.replaceChildren(
      icon(result.count === 1 ? 'check-circle' : result.count === 0 ? 'x-circle' : 'alert'),
      said,
    );
    const list = el('ol', 'steps matches');
    list.setAttribute('aria-label', t('devtools_matches'));
    const revealNote = el('div', 'reveal-note');
    revealNote.setAttribute('aria-live', 'polite');
    result.matches.forEach((match, index) => {
      const row = el('li');
      row.append(el('span', 'glyph'), matchView(match));
      if (match.text && match.text !== match.name) row.appendChild(el('div', 'detail', match.text));
      const reveal = button(
        t('devtools_reveal'),
        () => {
          revealNote.replaceChildren();
          void revealMatch(index).then((revealed) => {
            if (!revealed) {
              revealNote.replaceChildren(iconLine('alert', 'view-note warn-text', t('devtools_revealFailed')));
            }
          });
        },
        { icon: 'pointer', tone: 'ghost', className: 'reveal' },
      );
      row.appendChild(reveal);
      const on = () => void callPageScript('highlight', index);
      const off = () => void callPageScript('highlight', null);
      row.addEventListener('mouseenter', on);
      row.addEventListener('mouseleave', off);
      reveal.addEventListener('focus', on);
      reveal.addEventListener('blur', off);
      list.appendChild(row);
    });
    const parts: HTMLElement[] = [list, revealNote];
    if (result.count > LISTED) {
      parts.push(el('p', 'view-note', t('devtools_matchesListed', { shown: formatNumber(LISTED) })));
    }
    results.replaceChildren(...parts);
  };
  const runNow = () => {
    clearTimeout(timer);
    void run();
  };
  input.addEventListener('input', () => {
    cursor.reset();
    clearTimeout(timer);
    timer = setTimeout(() => void run(), TYPING_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runNow();
      remember();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const recalled = event.key === 'ArrowUp' ? cursor.older(input.value) : cursor.newer(input.value);
    // At either end the key does what it does in a text field.
    if (recalled === null) return;
    event.preventDefault();
    input.value = recalled;
    input.setSelectionRange(recalled.length, recalled.length);
    runNow();
  });
  void getLocatorHistory().then((history) => {
    cursor.reset(history);
    // The panel opened again: the field shows the newest expression of the history.
    if (expression === null && !input.value && history.length > 0) input.value = history[history.length - 1]!;
    runNow();
  });
}
