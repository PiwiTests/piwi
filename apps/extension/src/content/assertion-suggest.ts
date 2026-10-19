import { quoteJsString } from '@piwitests/core/locator-chain';
import { deriveTopLocator } from './verified-locators.js';
import { isSensitiveField } from './sensitive-fields.js';

interface AssertionCandidate {
  /** Which Playwright assertion this suggests. */
  method: 'toHaveValue' | 'toHaveValues' | 'toHaveText' | 'toHaveAccessibleName' | 'toBeVisible';
  /** The literal value being asserted, for display next to the method name (a multiple select's values joined by commas) — null for `toBeVisible`, which takes no argument. */
  detail: string | null;
  /** The full copy-pastable assertion line, built against the element's top-ranked locator. */
  expectLine: string;
}

export interface AssertionSuggestion {
  /** The best locator finding the element alone, which every candidate's `expectLine` is built against, or null when none does (then `candidates` is empty). */
  locator: string | null;
  candidates: AssertionCandidate[];
}

/**
 * Given a single picked element, suggest ranked `expect(...)` candidates
 * against its best locator that finds it alone on the page (`deriveTopLocator`):
 * `toHaveValue` for form controls (`toHaveValues` for a multiple select; never
 * for a field that holds a secret, `isSensitiveField`; not for checkbox/radio,
 * which assert `checked` state, not `value` — out of scope
 * here), `toHaveText` (whitespace-normalized, reading the live DOM directly
 * rather than the truncated 80-char `textContent` `generateAlternatives`
 * itself works from), `toHaveAccessibleName` (the name Playwright computes,
 * from `DomModel`), and `toBeVisible` as the
 * universal fallback. Ordered most-specific-to-the-element first.
 * `toMatchAriaSnapshot` is not suggested.
 *
 * Depends (via `deriveTopLocator`) on `generateAlternatives`, which — like
 * `scanForLintIssues` — has its own web of private module-level helpers that
 * `Function.prototype.toString()` reconstruction can't carry along; tested
 * via the real built bundle instead (see `assertion-panel.ts`).
 */
export function suggestAssertions(el: Element): AssertionSuggestion {
  function normalizeText(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
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

  const { locator, accessibleName } = deriveTopLocator(el);
  if (locator == null) return { locator: null, candidates: [] };

  const candidates: AssertionCandidate[] = [];

  const selected = el instanceof HTMLSelectElement && el.multiple ? [...el.selectedOptions].map((o) => o.value) : null;
  const value = selected ? null : formValue(el);
  if (selected && selected.length > 0) {
    candidates.push({
      method: 'toHaveValues',
      detail: selected.join(', '),
      expectLine: `await expect(page.${locator}).toHaveValues([${selected.map((v) => quoteJsString(v)).join(', ')}]);`,
    });
  } else if (value != null && value.trim() !== '') {
    candidates.push({
      method: 'toHaveValue',
      detail: value,
      expectLine: `await expect(page.${locator}).toHaveValue(${quoteJsString(value)});`,
    });
  }

  const text = normalizeText(el.textContent ?? '');
  if (text !== '') {
    candidates.push({
      method: 'toHaveText',
      detail: text,
      expectLine: `await expect(page.${locator}).toHaveText(${quoteJsString(text)});`,
    });
  }

  if (accessibleName) {
    candidates.push({
      method: 'toHaveAccessibleName',
      detail: accessibleName,
      expectLine: `await expect(page.${locator}).toHaveAccessibleName(${quoteJsString(accessibleName)});`,
    });
  }

  candidates.push({
    method: 'toBeVisible',
    detail: null,
    expectLine: `await expect(page.${locator}).toBeVisible();`,
  });

  return { locator, candidates };
}
