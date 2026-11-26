/**
 * Decide, from a Playwright error's text, whether the failing locator ever
 * resolved. Locator healing (replacement locators) only helps when it did not:
 * the element was never found, matched nothing, or matched several elements.
 * A locator that resolved and then failed an action or an assertion is a
 * different problem, and rewriting it would be a harmful edit.
 *
 * Pure text analysis, shared by the server ladder, the run's failure groups and
 * the demo. Playwright's call log is the evidence: a `waiting for <locator>`
 * line followed by `locator resolved to …` means the locator worked.
 */
import { parsePlaywrightError, type ParsedPlaywrightError } from '#shared/error-parse';

export type LocatorResolutionKind =
  /** `waiting for <locator>` with no later `locator resolved to` line. */
  | 'never-resolved'
  /** An explicit `resolved to 0 elements`. */
  | 'zero-elements'
  /** A strict-mode violation — the locator matched several elements. */
  | 'strict-mode'
  /** The locator resolved; the action or assertion failed afterwards. */
  | 'resolved'
  /** A navigation error (`page.goto`, `waitForURL`, `net::ERR_*`). */
  | 'navigation'
  /** No locator expression in the error text. */
  | 'no-locator'
  /** A locator is named but the text carries no call log to judge from. */
  | 'unknown';

export interface LocatorResolutionVerdict {
  kind: LocatorResolutionKind;
  /** True when a replacement locator can address the failure. */
  applicable: boolean;
  /** One sentence for the UI when healing does not apply; null otherwise. */
  reason: string | null;
}

/** Call-log states in which the locator did match an element at least once. */
const RESOLVED_STATES = new Set<ParsedPlaywrightError['lastState']>([
  'resolved',
  'hidden',
  'not-visible',
  'not-enabled',
  'not-editable',
  'inert',
  'not-stable',
  'outside-viewport',
  'intercepts-pointer',
  'detached',
]);

const NO_LOCATOR: LocatorResolutionVerdict = {
  kind: 'no-locator',
  applicable: false,
  reason: 'No locator in the error; nothing to heal.',
};

/**
 * Classify from the parsed error, so this gate and
 * `ParsedPlaywrightError.isLocatorResolutionFailure` always agree.
 */
export function classifyParsedLocatorResolution(parsed: ParsedPlaywrightError): LocatorResolutionVerdict {
  if (parsed.kind === 'strict-mode') return { kind: 'strict-mode', applicable: true, reason: null };

  if (parsed.isNavigationFailure) {
    return {
      kind: 'navigation',
      applicable: false,
      reason: 'The page failed to navigate before any locator ran; this is not a locator problem.',
    };
  }

  if (!parsed.leafLocator) return NO_LOCATOR;

  if (parsed.lastState === 'resolved-count') {
    if (parsed.resolvedCount === 0) return { kind: 'zero-elements', applicable: true, reason: null };
    return { kind: 'resolved', applicable: false, reason: 'The locator resolved; this is not a locator problem.' };
  }
  if (RESOLVED_STATES.has(parsed.lastState)) {
    return { kind: 'resolved', applicable: false, reason: 'The locator resolved; this is not a locator problem.' };
  }
  if (parsed.lastState === 'not-found') return { kind: 'never-resolved', applicable: true, reason: null };
  return { kind: 'unknown', applicable: true, reason: null };
}

export function classifyLocatorResolution(error: string | null | undefined): LocatorResolutionVerdict {
  if (!error || !error.trim()) return NO_LOCATOR;
  return classifyParsedLocatorResolution(parsePlaywrightError(error));
}

/**
 * The AI-context line for a healing result the gate rejected, so the model is
 * told not to propose a replacement locator. Null when healing applies.
 */
export function healingNotApplicableMarkdown(healing: { applicable?: boolean; reason?: string | null }): string | null {
  if (healing.applicable !== false) return null;
  return `## Alternative Locators (Locator Healing)\nNot applicable — ${healing.reason ?? 'this is not a locator problem.'} Do not propose a replacement locator.`;
}
