import type { LocatorMatch, LocatorQueryResult } from '../shared/devtools-selection.js';
import { formatNumber, t, tn } from '../shared/i18n.js';
import { patternOrigin } from '../shared/web-origin.js';
import { requestSiteAccess } from './inspected.js';
import { callPageScript, revealMatch } from './page-script.js';
import { button, el, emptyState, iconLine, noAccessText } from './ui.js';

/**
 * The Locators tab: the locator console beside DevTools. A locator typed here
 * is read by the shared parser and resolved by the engine over the inspected
 * page, as Playwright resolves it; each element it finds is listed, outlined on
 * the page while hovered, and selected in the Elements panel with Reveal.
 */

/** How long typing pauses before the locator is tried. */
const TYPING_MS = 150;
/** How many matches the content script lists; more are counted, not listed. */
const LISTED = 50;

let expression = '';

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
  input.value = expression;
  input.placeholder = t('devtools_locatorPlaceholder');
  input.setAttribute('aria-label', t('console_expression'));
  const verdict = el('p', 'status');
  verdict.setAttribute('role', 'status');
  const head = el('div', 'view-head locator-head');
  head.append(input, verdict);
  const results = el('div', 'locator-results');
  container.replaceChildren(head, results);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const run = async () => {
    const mine = ++generation;
    expression = input.value.trim();
    if (!expression) {
      verdict.replaceChildren();
      results.replaceChildren(iconLine('info', 'view-note', t('devtools_locatorsHint')));
      void callPageScript('highlight', null);
      return;
    }
    const answer = await callPageScript<LocatorQueryResult>('query', expression);
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
    verdict.className = result.count === 1 ? 'status good-text' : 'status warn-text';
    verdict.textContent =
      result.count === 1
        ? `✓ ${t('console_unique')}`
        : result.count === 0
          ? t('console_none')
          : `⚠ ${tn('console_many', result.count)}`;
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
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), TYPING_MS);
  });
  void run();
}
