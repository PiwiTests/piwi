/**
 * Shared utilities for locator healing — pure functions that work in both
 * Node.js and browser (Web Crypto) environments.
 */
import type { RankedLocator, NarrowingSuggestion, LocatorHealingResult } from './locator-healing.types';
import { sha256Hex } from './utils/hash';
import { compareVersions } from './piwi-env-vars';
import { locatorCallValues, parseLeafLocatorCall } from '#shared/locator-chain';

// The recommended-fix ladder lives in `@piwitests/core`, shared with the browser
// extension; re-exported so app/server code keeps importing it from here.
export { CONVENTION_STABILITY_FLOOR, recommendLocatorFix } from '@piwitests/core/locator-fix';

/** The fields of a healing answer that say whether it has replacement locators. */
type HealingLists = Pick<
  LocatorHealingResult,
  'source' | 'fromDiffRename' | 'fromElementMatch' | 'fromPriorSuccess' | 'fromAriaSnapshot'
>;

/**
 * True when a healing answer has replacement locators to show: a source other
 * than `none` and at least one ranked list, whichever rung of the lookup filled
 * it (the run's own diff, the failing page, a prior pass or the ARIA snapshot).
 * The Locator fix section and its panel both show on this one rule.
 */
export function hasHealingAlternatives(healing: HealingLists | null | undefined): boolean {
  if (!healing || healing.source === 'none') return false;
  return Boolean(
    healing.fromDiffRename?.length ||
    healing.fromElementMatch?.length ||
    healing.fromPriorSuccess?.length ||
    healing.fromAriaSnapshot?.length,
  );
}

/** Playwright's first release with `locator.visible()`. */
const VISIBLE_MIN_VERSION = '1.63';

/**
 * Suggest narrowing a strict-mode-ambiguous locator with `.visible()` when the
 * run is on Playwright 1.63 or later, the failing locator matched several
 * elements, and exactly one of them was visible. Null in every other case — a
 * non-strict failure, an older Playwright, an unknown match count, or more than
 * one visible match (where `.visible()` would not resolve the ambiguity).
 */
export function computeNarrowingSuggestion(input: {
  playwrightVersion: string | null | undefined;
  matchCount: number | null | undefined;
  visibleMatchCount: number | null | undefined;
}): NarrowingSuggestion | null {
  const version = input.playwrightVersion;
  if (!version || compareVersions(version, VISIBLE_MIN_VERSION) < 0) return null;
  const matchCount = input.matchCount;
  if (typeof matchCount !== 'number' || matchCount < 2) return null;
  if (input.visibleMatchCount !== 1) return null;
  return { method: 'visible', matchCount, visibleCount: 1 };
}

/**
 * A locator's identity is the method plus the string literals it targets, in
 * source order — the role/testid/text/selector and any string option values
 * (e.g. `name`). Booleans (`exact`), numbers and regex carry no element
 * identity and are skipped. This is the single normalization both sides of the
 * healing round-trip rely on:
 *
 *  - capture (server `persistRunCases`) calls {@link locatorSignature} with the
 *    raw args the test passed, e.g. `('getByRole', ['button', { name: 'Submit' }])`;
 *  - lookup (server `getLocatorHealing`) calls {@link locatorSignatureFromExpression}
 *    with the locator expression parsed out of the failure error,
 *    e.g. `getByRole('button', { name: 'Submit' })`.
 *
 * Both must produce the same hash, so the stored snapshot is found again.
 */
export function locatorArgStrings(args: unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object' && !(v instanceof RegExp)) {
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        if (key === 'exact') continue; // matching mode, not identity
        walk(val);
      }
    }
  };
  args.forEach(walk);
  return out;
}

/**
 * The method of a locator expression's leaf — its last locating call
 * (`getByRole('button')` → `getByRole`, `page.locator('.x')` → `locator`).
 * Null when the expression does not parse.
 */
export function locatorExpressionMethod(expr: string): string | null {
  return parseLeafLocatorCall(expr)?.method ?? null;
}

/**
 * The string values of a locator expression's leaf call, in order, read with
 * the shared parser — mirroring {@link locatorArgStrings} on the capture side.
 * Empty when the expression does not parse.
 */
export function locatorExpressionStrings(expr: string): string[] {
  const leaf = parseLeafLocatorCall(expr);
  return leaf ? locatorArgStrings(locatorCallValues(leaf)) : [];
}

/**
 * True when two locators target the same element identity — same method and
 * the same string literals (order-insensitive: option-object key order differs
 * between capture-side args and expression-parsed args). Used to keep the
 * locator that just failed out of the recommendation pool.
 */
export function locatorIdentityEquals(
  aMethod: string | null | undefined,
  aArgs: unknown,
  bMethod: string | null | undefined,
  bArgs: unknown,
): boolean {
  if (!aMethod || !bMethod || aMethod !== bMethod) return false;
  const strings = (args: unknown): string => JSON.stringify(locatorArgStrings([args]).sort());
  return strings(aArgs) === strings(bArgs);
}

/**
 * True when an alternative's identity depends on the given accessible name —
 * one of its string literals matches it (case-insensitive). Such alternatives
 * break together with the name when the element is relabeled.
 */
export function alternativeUsesName(alt: RankedLocator, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  return locatorArgStrings([alt.args]).some((s) => s.trim().toLowerCase() === needle);
}

/** Stable signature for a captured locator (method + ordered string literals). */
export async function locatorSignature(method: string, args: unknown[]): Promise<string> {
  return sha256Hex(`${method} ${JSON.stringify(locatorArgStrings(args))}`);
}

/** Stable signature for a locator expression parsed from a failure error. */
export async function locatorSignatureFromExpression(expr: string): Promise<string> {
  const method = locatorExpressionMethod(expr) ?? '';
  return sha256Hex(`${method} ${JSON.stringify(locatorExpressionStrings(expr))}`);
}

/**
 * The positional first argument of each Playwright locator method, as keyed by
 * the parsed failing locator (`{ method, args }`); every other arg key is an
 * option. `getByAltText` shares the `text` key with `getByText`.
 */
const LOCATOR_PRIMARY_ARG: Record<string, string> = {
  getByTestId: 'testId',
  getByRole: 'role',
  getByText: 'text',
  getByLabel: 'label',
  getByPlaceholder: 'placeholder',
  getByAltText: 'text',
  getByTitle: 'title',
  locator: 'selector',
  'page.locator': 'selector',
};

/**
 * Parse a locator expression into the failing locator's `{ method, args }`,
 * keyed as {@link locatorExpression} renders it back: the positional argument
 * under its primary key (`testId`, `role`, `text`, …) and, for `getByRole`, the
 * options other than `exact`. A chained expression yields its leaf — the last
 * locating call. Regexes are kept as their `/source/flags` text, for display
 * only: matching uses the locator signature, not these args. Null when the
 * expression does not parse.
 *
 *   getByRole('button', { name: 'Submit' }) → { method: 'getByRole', args: { role: 'button', name: 'Submit' } }
 */
export function parseLocatorExpression(expr: string): { method: string; args: Record<string, unknown> } | null {
  const leaf = parseLeafLocatorCall(expr);
  if (!leaf) return null;
  const values = locatorCallValues(leaf, { regexAsText: true });
  const primary = LOCATOR_PRIMARY_ARG[leaf.method];
  if (!primary) return { method: leaf.method, args: { args: values } };

  const args: Record<string, unknown> = {};
  if (values[0] !== undefined && typeof values[0] !== 'object') args[primary] = values[0];
  const options = values.find((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
  if (leaf.method === 'getByRole' && options) {
    for (const [key, value] of Object.entries(options)) {
      if (key !== 'exact') args[key] = value;
    }
  }
  return { method: leaf.method, args };
}

/** A parsed arg value as Playwright source: quoted string, bare literal, or regex text as-is. */
function locatorArgLiteral(value: unknown): string {
  if (typeof value === 'string') {
    if (value.startsWith('/') && /\/[a-z]*$/.test(value) && value.length > 1) return value;
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return 'undefined';
  return JSON.stringify(value);
}

/**
 * Render a parsed locator back to the Playwright expression a developer would
 * write, e.g. `{ method: 'getByRole', args: { role: 'row', name: 'Total' } }`
 * → `getByRole('row', { name: 'Total' })`. The inverse of the server-side
 * expression parser, so the failing locator reads like every alternative.
 */
export function locatorExpression(method: string, args: Record<string, unknown> | null | undefined): string {
  const a = args ?? {};
  const parts: string[] = [];
  if (Array.isArray(a.args) && !(method in LOCATOR_PRIMARY_ARG)) {
    return `${method}(${a.args.map(locatorArgLiteral).join(', ')})`;
  }
  const primary = LOCATOR_PRIMARY_ARG[method];
  if (primary && a[primary] !== undefined) parts.push(locatorArgLiteral(a[primary]));
  const options = Object.entries(a).filter(([key, value]) => key !== primary && value !== undefined);
  if (options.length) {
    parts.push(`{ ${options.map(([key, value]) => `${key}: ${locatorArgLiteral(value)}`).join(', ')} }`);
  }
  return `${method}(${parts.join(', ')})`;
}
