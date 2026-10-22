import type { CopyAction, ElementFacts } from '../shared/copy-modes.js';
import { assertionsFor } from './assertion-suggest.js';
import { DomModel } from './engine-aria.js';
import { isSensitiveField } from './sensitive-fields.js';

/** The `<input>` types Playwright's `fill` accepts. */
const FILLABLE_INPUT_TYPES = new Set([
  'text',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'url',
  'color',
  'date',
  'time',
  'datetime-local',
  'month',
  'range',
  'week',
]);

/** Roles Playwright's `check` acts on. */
const CHECK_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

/** What a field holds, for `fill`: null when it is empty or holds a secret, which the copy writes as a placeholder. */
function fillValue(el: Element, value: string): string | null {
  return isSensitiveField(el) || value === '' ? null : value;
}

/**
 * How a test acts on `el`: `fill` with what a text field, a text area or an
 * editable element holds, `check` for a checkbox, a radio or a switch,
 * `selectOption` with a select's chosen values, `click` for anything else.
 */
function elementAction(el: Element, model: DomModel): CopyAction {
  switch (el.localName) {
    case 'select':
      return {
        method: 'selectOption',
        values: [...(el as HTMLSelectElement).selectedOptions].map((o) => o.value).filter((v) => v !== ''),
      };
    case 'input': {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return { method: 'check' };
      if (FILLABLE_INPUT_TYPES.has(type))
        return { method: 'fill', value: fillValue(el, (el as HTMLInputElement).value) };
      return { method: 'click' };
    }
    case 'textarea':
      return { method: 'fill', value: fillValue(el, (el as HTMLTextAreaElement).value) };
  }
  if ((el as HTMLElement).isContentEditable) {
    return { method: 'fill', value: fillValue(el, (el.textContent ?? '').replace(/\s+/g, ' ').trim()) };
  }
  if (CHECK_ROLES.has(model.role(el) ?? '')) return { method: 'check' };
  return { method: 'click' };
}

/** What the Action and Assertion copy modes write for `el`, read from it as it is now. */
export function elementFacts(el: Element, model: DomModel = new DomModel()): ElementFacts {
  return { action: elementAction(el, model), assertion: assertionsFor(el, model)[0]! };
}
