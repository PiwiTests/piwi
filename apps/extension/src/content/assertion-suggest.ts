import { renderAssertion, type CopyAssertion } from '../shared/copy-modes.js';
import { DomModel } from './engine-aria.js';
import { createPageEngine, deriveTopLocator } from './verified-locators.js';
import { isSensitiveField } from './sensitive-fields.js';

interface AssertionCandidate {
  /** Which Playwright assertion this suggests. */
  method: CopyAssertion['method'];
  /** The literal value being asserted, for display next to the method name — null for a matcher that takes no text (`toBeVisible`, `toBeChecked`) and for `toHaveValues`, which lists `values`. */
  detail: string | null;
  /** A multiple select's selected values, for `toHaveValues`. */
  values?: string[];
  /** The assertion, whatever locator finds the element. */
  assertion: CopyAssertion;
  /** The full copy-pastable assertion line, built against the element's top-ranked locator. */
  expectLine: string;
}

export interface AssertionSuggestion {
  /** The best locator finding the element alone, which every candidate's `expectLine` is built against, or null when none does (then `candidates` is empty). */
  locator: string | null;
  candidates: AssertionCandidate[];
}

/** A text longer than this is asserted by its start first (`toContainText`): a whole block's text makes a brittle check. */
const LONG_TEXT = 80;

/** Roles whose state `toBeChecked` reads. */
const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The start of a long text, cut at a space within {@link LONG_TEXT} characters. */
function leadingText(text: string): string {
  const head = text.slice(0, LONG_TEXT);
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).trim();
}

function formValue(element: Element): string | null {
  if (isSensitiveField(element)) return null;
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') return null;
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  return null;
}

/**
 * The assertions that hold for `el` as it is now, most specific to the element
 * first: `toHaveValue` for a form control (`toHaveValues` for a multiple
 * select; never for a field that holds a secret, `isSensitiveField`, nor for a
 * checkbox or radio), `toBeChecked` (or `not.toBeChecked`) for a checkable
 * role, `toContainText` with the start of a long text then `toHaveText` with
 * the whole of it (whitespace-normalized, read from the live DOM rather than
 * the truncated text `generateAlternatives` works from), `toHaveAccessibleName`
 * when the element has a name (the engine's `DomModel` computes it as
 * Playwright does; a paragraph has none), and `toBeVisible` last, always.
 * `toMatchAriaSnapshot` is not suggested.
 */
export function assertionsFor(el: Element, model: DomModel = new DomModel()): CopyAssertion[] {
  const assertions: CopyAssertion[] = [];

  const selected = el instanceof HTMLSelectElement && el.multiple ? [...el.selectedOptions].map((o) => o.value) : null;
  const value = selected ? null : formValue(el);
  if (selected && selected.length > 0) assertions.push({ method: 'toHaveValues', values: selected });
  else if (value != null && value.trim() !== '') assertions.push({ method: 'toHaveValue', value });

  if (CHECKABLE_ROLES.has(model.role(el) ?? '')) {
    const checked = model.checked(el);
    if (checked !== 'mixed') assertions.push({ method: 'toBeChecked', checked });
  }

  const text = normalizeText(el.textContent ?? '');
  if (text.length > LONG_TEXT) assertions.push({ method: 'toContainText', value: leadingText(text) });
  if (text !== '') assertions.push({ method: 'toHaveText', value: text });

  const name = model.normalizedAccessibleName(el, false);
  if (name) assertions.push({ method: 'toHaveAccessibleName', value: name });

  assertions.push({ method: 'toBeVisible' });
  return assertions;
}

/**
 * Given a single picked element, suggest ranked `expect(...)` candidates
 * ({@link assertionsFor}) against its best locator that finds it alone on the
 * page (`deriveTopLocator`).
 *
 * Depends (via `deriveTopLocator`) on `generateAlternatives`, which — like
 * `scanForLintIssues` — has its own web of private module-level helpers that
 * `Function.prototype.toString()` reconstruction can't carry along; tested
 * via the real built bundle instead (see `assertion-panel.ts`).
 */
export function suggestAssertions(el: Element): AssertionSuggestion {
  const engine = createPageEngine(el.ownerDocument);
  const { locator } = deriveTopLocator(el, engine);
  if (locator == null) return { locator: null, candidates: [] };
  const candidates = assertionsFor(el, engine.model).map((assertion): AssertionCandidate => {
    const expectLine = renderAssertion(locator, assertion);
    switch (assertion.method) {
      case 'toHaveValue':
      case 'toHaveText':
      case 'toContainText':
      case 'toHaveAccessibleName':
        return { method: assertion.method, detail: assertion.value, assertion, expectLine };
      case 'toHaveValues':
        return { method: assertion.method, detail: null, values: assertion.values, assertion, expectLine };
      default:
        return { method: assertion.method, detail: null, assertion, expectLine };
    }
  });
  return { locator, candidates };
}
