/**
 * Line edits for locators: a locator-healing recommendation turned into the
 * one-line change at the failing call site, and a renamed string replaced
 * inside the quotes the author wrote.
 *
 * The end deliverable of healing is an edited test file, so the dashboard offers the
 * exact one-line change rather than only a copyable locator string.
 */

import { safeLocator } from './codegen';

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * From an open paren, return the index of its matching close paren, skipping
 * over string literals and nested parens. Returns -1 when unbalanced.
 */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Rewrite the failing locator call on a source line with the recommended
 * locator. Finds the failing method's call (as a whole word, so `getByRole`
 * doesn't match inside `myGetByRole`) and replaces that call — from the method
 * name through its matching close paren — with the recommendation. A chained
 * recommendation (`getByTestId('x').getByRole('button')`) therefore slots in
 * ahead of any trailing `.click()`.
 *
 * The recommendation goes in only as {@link safeLocator} re-renders it: a
 * chain of known Playwright methods with literal arguments, in canonical form.
 * Anything else is refused, so no generated text is pasted into a test as is.
 *
 * Returns null when the recommendation is not such a locator, the method isn't
 * found on the line, the parens are unbalanced, or the replacement would be a
 * no-op — the caller then falls back to showing the line number and a copy
 * button.
 */
export function buildLocatorEdit(
  sourceLine: string,
  failingMethod: string | null | undefined,
  recommendedLocator: string,
): { old: string; new: string } | null {
  if (!sourceLine || !failingMethod || !recommendedLocator) return null;
  const safe = safeLocator(recommendedLocator);
  if (!safe) return null;
  const re = new RegExp(`${escapeRegExp(failingMethod)}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceLine)) !== null) {
    const methodStart = m.index;
    const before = methodStart > 0 ? sourceLine[methodStart - 1] : '';
    // Skip a hit that's the tail of a longer identifier (e.g. `xGetByRole`).
    if (before && /[A-Za-z0-9_$]/.test(before)) continue;
    const openParen = methodStart + m[0].lastIndexOf('(');
    const close = matchingParen(sourceLine, openParen);
    if (close === -1) return null;
    const next = sourceLine.slice(0, methodStart) + safe.text + sourceLine.slice(close + 1);
    return next === sourceLine ? null : { old: sourceLine, new: next };
  }
  return null;
}

/** Escape a value for a string literal delimited by `quote`, on one line. */
function escapeForQuote(value: string, quote: string): string {
  let out = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  out = out.split(quote).join(`\\${quote}`);
  return quote === '`' ? out.replace(/\$\{/g, '\\${') : out;
}

/**
 * Replace a string literal on a source line whose value is `oldValue` with
 * `newValue`, keeping the author's quote character. The first literal with
 * that exact value wins. Returns null when no literal on the line holds it,
 * as when the string comes from a constant or a helper argument.
 */
export function buildLiteralEdit(
  sourceLine: string,
  oldValue: string,
  newValue: string,
): { old: string; new: string } | null {
  if (!sourceLine || oldValue === newValue) return null;
  for (let i = 0; i < sourceLine.length; i++) {
    const quote = sourceLine[i]!;
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    let value = '';
    let end = -1;
    for (let j = i + 1; j < sourceLine.length; j++) {
      const ch = sourceLine[j]!;
      if (ch === '\\' && j + 1 < sourceLine.length) {
        const next = sourceLine[j + 1]!;
        value += next === 'n' ? '\n' : next;
        j++;
        continue;
      }
      if (quote === '`' && ch === '$' && sourceLine[j + 1] === '{') break;
      if (ch === quote) {
        end = j;
        break;
      }
      value += ch;
    }
    if (end === -1) continue;
    if (value === oldValue) {
      const next = sourceLine.slice(0, i + 1) + escapeForQuote(newValue, quote) + sourceLine.slice(end);
      return { old: sourceLine, new: next };
    }
    i = end;
  }
  return null;
}

/**
 * Build a two-line unified-diff patch string for `DiffPatch.vue` from a locator
 * edit, with an optional `@@` header naming the call site.
 */
export function locatorEditPatch(edit: { old: string; new: string }, location?: string | null): string {
  const header = location ? `@@ ${location} @@\n` : '';
  return `${header}-${edit.old.trimEnd()}\n+${edit.new.trimEnd()}`;
}

/** One changed locator argument, for the compact args diff when methods match. */
export interface LocatorArgChange {
  key: string;
  from: string | null;
  to: string | null;
}

/**
 * The scalar args that changed between the failing locator and a recommendation
 * of the same method — e.g. `name: 'Pay' → 'Pay now'`. Object/array args are
 * compared by their JSON form. Used when there is no captured source line to
 * rewrite but the recommendation keeps the method family.
 */
export function diffLocatorArgs(
  from: Record<string, unknown> | null | undefined,
  to: Record<string, unknown> | null | undefined,
): LocatorArgChange[] {
  const a = from ?? {};
  const b = to ?? {};
  const stringify = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const changes: LocatorArgChange[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = stringify(a[key]);
    const bv = stringify(b[key]);
    if (av !== bv) changes.push({ key, from: av, to: bv });
  }
  return changes;
}

/**
 * A copyable instruction for an AI coding agent to apply the recommended fix —
 * file:line, the broken locator, the replacement, and the current line.
 */
export function buildLocatorFixPrompt(input: {
  location: string | null;
  sourceLine: { line: number; text: string } | null;
  failing: string;
  recommended: string;
}): string {
  const where = input.location ?? (input.sourceLine ? `line ${input.sourceLine.line}` : 'the failing test');
  const lines = [
    `In ${where}, the Playwright locator \`${input.failing}\` no longer matches its element.`,
    `Replace it with \`${input.recommended}\`.`,
  ];
  if (input.sourceLine) lines.push('', 'Current line:', input.sourceLine.text.trim());
  return lines.join('\n');
}
