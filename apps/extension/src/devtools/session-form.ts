import { tNodes, t } from '../shared/i18n.js';
import { addNamedPick } from '../shared/session-add.js';
import { button, el, iconLine } from './ui.js';

/**
 * Add to session in the DevTools pages (the Elements sidebar, the Locators
 * console): a name for the locator, checked and kept by `addNamedPick`, which
 * says why a name is refused or the session storage failed.
 */

/**
 * Opens the name form at the end of `host`, in place of a form or a
 * confirmation already there; `pageUrl` is read when the name is saved.
 */
export function openSessionForm(host: HTMLElement, locator: string, pageUrl: () => string | Promise<string>): void {
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
      const refused = await addNamedPick(name, locator, pageUrl);
      if (refused !== null) {
        message.textContent = refused;
        return;
      }
      form.remove();
      const added = el('code', 'pick-name', name);
      host.appendChild(iconLine('check-circle', 'confirm', ...tNodes('devtools_addedToSession', { name: added })));
    })();
  });
  host.appendChild(form);
  input.focus();
}
