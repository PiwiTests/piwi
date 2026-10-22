import { t, tNodes } from '../shared/i18n.js';
import { pickNameProblem, type PickNameProblem } from '../shared/session-export.js';
import { addSessionPick, getSessionPicks } from '../shared/session-storage.js';
import { button, el, iconLine } from './ui.js';

/**
 * Add to session in the DevTools pages: a name for the locator, checked as the
 * page object needs it (a class field, none taken), then the pick kept in the
 * session the Session tab lists.
 */

function problemText(problem: PickNameProblem, name: string): string {
  switch (problem) {
    case 'required':
      return t('session_nameRequired');
    case 'reserved':
      return t('session_nameReserved', { name });
    case 'invalid':
      return t('session_nameInvalid');
    case 'taken':
      return t('session_nameTaken', { name });
  }
}

/**
 * Opens the name form at the end of `host`, in place of a form or a
 * confirmation already there; `pageUrl` is read when the name is saved.
 */
export function openSessionForm(host: HTMLElement, locator: string, pageUrl: () => Promise<string>): void {
  host.querySelector(':scope > .session-form')?.remove();
  host.querySelector(':scope > .confirm')?.remove();
  const form = el('form', 'session-form');
  const input = el('input');
  input.type = 'text';
  input.placeholder = t('session_namePlaceholder');
  input.setAttribute('aria-label', t('session_nameLabel'));
  // Save submits the form, which checks the name.
  const save = button(t('common_save'), () => undefined, { icon: 'save', tone: 'primary' });
  save.type = 'submit';
  const cancel = button(t('common_cancel'), () => form.remove(), { icon: 'close' });
  const message = el('div', 'form-message');
  message.setAttribute('role', 'status');
  form.append(input, save, cancel, message);
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') form.remove();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const name = input.value.trim();
      const problem = pickNameProblem(name, await getSessionPicks());
      if (problem) {
        message.textContent = problemText(problem, name);
        return;
      }
      await addSessionPick({ name, locator, pageUrl: await pageUrl() });
      form.remove();
      const added = el('code', 'pick-name', name);
      host.appendChild(iconLine('check-circle', 'confirm', ...tNodes('devtools_addedToSession', { name: added })));
    })();
  });
  host.appendChild(form);
  input.focus();
}
