import { highlightLocator, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { copyWithFeedback } from '../shared/clipboard.js';
import { COPY_MODE_ICONS, COPY_MODES, copyModeLabel, copyModeMethod, renderCopyMode } from '../shared/copy-modes.js';
import { describeSelection, type SelectionLocator, type SelectionRanking } from '../shared/devtools-selection.js';
import { initI18n, localizeDocument, t, uiLanguage } from '../shared/i18n.js';
import { decorateIcons, icon } from '../shared/icons.js';
import { PATTERN_CSS } from '../shared/pattern-view.js';
import { STEP_CSS } from '../shared/step-view.js';
import { verdictWords } from '../shared/verdict-words.js';
import { patternOrigin } from '../shared/web-origin.js';
import { getEditorPairing } from '../shared/editor-pairing.js';
import { sendToEditor, showSendResult } from '../shared/editor-send.js';
import { getLastCopyMode, setLastCopyMode } from '../shared/storage.js';
import { requestSiteAccess } from './inspected.js';
import { openSessionForm } from './session-form.js';
import { button, el, emptyState, noAccessText, type IconName } from './ui.js';
import { rankDevtoolsSelection, type RankOutcome } from './selection.js';

/**
 * The Piwi pane of the Elements panel: the ranked, verified locators of the
 * node selected in DevTools, with the Pick results' copy actions, Add to
 * session and, with an editor paired, Send to editor for the top locator. It
 * ranks again when the selection changes and after the page navigates.
 */

const content = document.getElementById('content') as HTMLElement;
const selection = document.getElementById('selection') as HTMLElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;

let generation = 0;
/** Whether an editor is paired, read again with each ranking. */
let editorPaired = false;

async function refresh(): Promise<void> {
  const current = ++generation;
  refreshBtn.disabled = true;
  content.setAttribute('aria-busy', 'true');
  const [outcome, pairing] = await Promise.all([
    rankDevtoolsSelection().catch(
      (err: unknown): RankOutcome => ({ kind: 'failed', message: err instanceof Error ? err.message : String(err) }),
    ),
    getEditorPairing().catch(() => null),
  ]);
  if (current !== generation) return;
  editorPaired = pairing !== null;
  refreshBtn.disabled = false;
  content.removeAttribute('aria-busy');
  render(outcome);
}

function show(heading: SelectionRanking | null, ...nodes: HTMLElement[]): void {
  if (heading?.status === 'ranked') {
    const kind = el('span', 'role', heading.role ?? heading.tag);
    selection.replaceChildren(kind);
    if (heading.name) selection.append(el('span', 'sep', ' · '), el('span', '', heading.name));
    selection.title = describeSelection(heading);
  } else {
    selection.replaceChildren();
    selection.removeAttribute('title');
  }
  content.replaceChildren(...nodes);
}

function empty(name: IconName, text: string | Array<Node | string>, ...actions: HTMLElement[]): HTMLElement {
  const box = emptyState(name, text, ...actions);
  box.classList.add('pane-empty');
  return box;
}

function render(outcome: RankOutcome): void {
  switch (outcome.kind) {
    case 'restricted':
      show(null, empty('blocked', t('devtools_restricted')));
      return;
    case 'failed':
      show(
        null,
        empty(
          'blocked',
          outcome.message ? t('devtools_rankFailed', { error: outcome.message }) : t('devtools_rankFailedPlain'),
        ),
      );
      return;
    case 'no-access': {
      const allow = button(
        t('devtools_allowSite'),
        () => {
          void requestSiteAccess(outcome.pattern).then((granted) => {
            if (granted) void refresh();
          });
        },
        { icon: 'check', tone: 'primary' },
      );
      show(null, empty('lock', noAccessText(patternOrigin(outcome.pattern)), allow));
      return;
    }
    case 'ranked':
      renderRanking(outcome.ranking);
  }
}

function renderRanking(ranking: SelectionRanking): void {
  if (ranking.status === 'none') return show(null, empty('select', t('devtools_selectElement')));
  if (ranking.status === 'frame') return show(null, empty('blocked', t('devtools_inFrame')));
  if (ranking.status === 'extension') return show(null, empty('blocked', t('devtools_ownElement')));
  if (ranking.locators.length === 0) return show(ranking, empty('blocked', t('devtools_noLocator')));
  const list = el('ul', 'locators');
  ranking.locators.forEach((locator, i) => list.appendChild(locatorRow(locator, ranking, i === 0)));
  show(ranking, list);
}

function locatorRow(
  locator: SelectionLocator,
  ranking: Extract<SelectionRanking, { status: 'ranked' }>,
  best: boolean,
): HTMLElement {
  const row = el('li', best && locator.verdict !== 'ambiguous' ? 'locator best' : 'locator');
  const code = el('code', 'piwi-loc');
  code.innerHTML = highlightLocator(locator.locator);
  const verdict = verdictWords(locator);
  const badge = el('div', `locator-verdict badge ${verdict.tone}`);
  badge.append(icon(verdict.tone === 'good' ? 'check-circle' : 'alert'), verdict.explanation);

  const actions = el('div', 'row-actions');
  actions.appendChild(el('span', 'copy-label', t('devtools_copyAs')));
  for (const mode of COPY_MODES) {
    const text = renderCopyMode(locator, mode, ranking.facts);
    const label = copyModeLabel(mode, copyModeMethod(locator, mode, ranking.facts));
    const copy = button(
      label,
      () => {
        void copyWithFeedback(text, copy);
        void setLastCopyMode(mode);
      },
      { icon: COPY_MODE_ICONS[mode], tone: 'ghost', title: text },
    );
    actions.appendChild(copy);
  }
  // The top locator goes to the editor in the copy mode chosen last, as the Pick results send it.
  if (best && editorPaired) {
    const send = button(
      t('devtools_sendToEditor'),
      () => {
        void getLastCopyMode()
          .catch(() => 'bare' as const)
          .then((mode) => sendToEditor({ kind: 'locator', text: renderCopyMode(locator, mode, ranking.facts) }))
          .then((result) => showSendResult(send, result));
      },
      { icon: 'send', tone: 'ghost', className: 'send' },
    );
    actions.appendChild(send);
  }
  actions.appendChild(
    button(t('devtools_addToSession'), () => openSessionForm(row, locator.locator, () => ranking.pageUrl), {
      icon: 'plus',
      tone: 'ghost',
      className: 'add-to-session',
    }),
  );

  row.append(code, badge, actions);
  return row;
}

async function start(): Promise<void> {
  await initI18n();
  document.documentElement.lang = uiLanguage();
  const style = document.createElement('style');
  style.textContent = `${LOCATOR_SYNTAX_CSS}${STEP_CSS}${PATTERN_CSS}`;
  document.head.appendChild(style);
  localizeDocument();
  decorateIcons();
  refreshBtn.addEventListener('click', () => void refresh());
  chrome.devtools.panels.elements.onSelectionChanged.addListener(() => void refresh());
  chrome.devtools.network.onNavigated.addListener(() => void refresh());
  await refresh();
}

void start();
