import { highlightLocator } from '@piwitests/picker-dom';
import { copyWithFeedback } from '../shared/clipboard.js';
import { t, tn } from '../shared/i18n.js';
import { renderFixture, renderJson, renderMarkdown } from '../shared/session-export.js';
import { clearSessionPicks, getSessionPicks, removeSessionPick } from '../shared/session-storage.js';
import { urlView } from '../shared/step-view.js';
import { viewHead } from './panel-record.js';
import { button, el, emptyState } from './ui.js';

/**
 * The Session tab: the elements named so far with Add to session in the
 * Elements sidebar, kept in session storage. Copies them as a page object, a
 * Markdown table or JSON.
 */

export async function renderSessionTab(container: HTMLElement): Promise<void> {
  const picks = await getSessionPicks();
  if (picks.length === 0) {
    container.replaceChildren(emptyState('pointer', t('devtools_sessionEmpty')));
    return;
  }
  const copies = [
    [t('session_copyPageObject'), () => renderFixture(picks)],
    [t('session_copyMarkdown'), () => renderMarkdown(picks)],
    [t('session_copyJson'), () => renderJson(picks)],
  ] as const;
  const actions: HTMLElement[] = copies.map(([label, render], i) => {
    const copy = button(label, () => void copyWithFeedback(render(), copy), {
      icon: 'copy',
      ...(i === 0 ? { tone: 'primary' as const } : {}),
    });
    return copy;
  });
  actions.push(button(t('session_clear'), () => void clearSessionPicks(), { icon: 'trash', tone: 'remove' }));

  const list = el('ol', 'steps');
  for (const pick of picks) {
    const row = el('li');
    const code = el('code', 'piwi-loc');
    code.innerHTML = highlightLocator(pick.locator);
    const page = el('div', 'detail');
    page.appendChild(urlView(pick.pageUrl, { origin: false }));
    row.append(el('span', 'glyph'), el('div', 'step-words pick-name', pick.name), code, page);
    const remove = button(t('devtools_remove'), () => void removeSessionPick(pick.name), {
      icon: 'trash',
      tone: 'remove',
      small: true,
      className: 'reveal',
    });
    remove.setAttribute('aria-label', t('session_remove', { name: pick.name }));
    row.appendChild(remove);
    list.appendChild(row);
  }
  container.replaceChildren(viewHead('', tn('devtools_sessionCount', picks.length), ...actions), list);
}
