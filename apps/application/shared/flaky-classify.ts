/**
 * Flaky-test root-cause classification — pure keyword scoring over recent
 * failure evidence (error messages, step titles/errors, browser spread), and
 * the order dependency coverage measures. No DB/network access, so it works
 * identically on the server and in the demo's in-browser handler
 * (`shared/handlers/flaky-classify.ts`).
 */

export type FlakyRootCause = 'timing' | 'network' | 'assertion' | 'environment' | 'order' | 'other';

interface ClassifyInput {
  errorMessages: string[];
  stepErrors: string[];
  stepNames: string[];
  networkErrorCount: number;
  status5xxCount: number;
  /**
   * How many of the test's recent flaky executions had a request that failed (or
   * returned 5xx) on the failing attempt but not on the attempt that passed on
   * retry. That delta is the sharpest available evidence that the flakiness is a
   * network problem, so each vote weighs several keyword matches.
   */
  attemptDiffNetworkVotes?: number;
  /** Per browser (Playwright project), how many of the recent attempts passed and failed. */
  browserDistribution: Record<string, BrowserOutcomes>;
  /**
   * The test's coverage varies with whether another test finished before it in
   * the same run, and its failures follow that variation (a path variation's
   * `orderDependent`): it depends on state an earlier test leaves behind.
   */
  orderDependent?: boolean;
}

export interface BrowserOutcomes {
  passed: number;
  failed: number;
}

/** Failures on the one failing browser, and passes on another, needed to call it environment. */
const ENVIRONMENT_MIN_ATTEMPTS = 3;

/** Weight of one attempt-diff network vote, in keyword-match equivalents. */
const ATTEMPT_DIFF_NETWORK_WEIGHT = 3;

const TIMING_KEYWORDS = [
  'timeout',
  'to be visible',
  'to be enabled',
  'waitFor',
  'not found within',
  'element is not visible',
];

const NETWORK_KEYWORDS = [
  'net::',
  'ERR_',
  '5xx',
  'status 500',
  'status 502',
  'status 503',
  'ECONNREFUSED',
  'waitForResponse',
];

const ASSERTION_MARKERS = [
  'expect(',
  'Expected:',
  'to equal',
  'toBe',
  'toMatch',
  'Screenshot comparison',
  'toMatchSnapshot',
];

const TIMING_NETWORK_MARKERS = [...TIMING_KEYWORDS, ...NETWORK_KEYWORDS];

function countKeywordMatches(texts: string[], keywords: string[]): number {
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  let count = 0;
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const kw of lowerKeywords) {
      if (lower.includes(kw)) {
        count++;
      }
    }
  }
  return count;
}

function hasAnyKeyword(texts: string[], keywords: string[]): boolean {
  const lowerTexts = texts.map((t) => t.toLowerCase());
  const lowerKeywords = keywords.map((k) => k.toLowerCase());
  return lowerTexts.some((t) => lowerKeywords.some((kw) => t.includes(kw)));
}

const hasTimingOrNetwork = (texts: string[]) => hasAnyKeyword(texts, TIMING_NETWORK_MARKERS);

export function classifyFlakyRootCause(input: ClassifyInput): FlakyRootCause {
  // An order dependency, measured from coverage, outranks every other signal.
  if (input.orderDependent) return 'order';

  const allTexts = [...input.errorMessages, ...input.stepErrors, ...input.stepNames];

  if (allTexts.length === 0) return 'other';

  // Environment: one browser fails repeatedly, while another browser ran and
  // passed repeatedly without failing once.
  const outcomes = Object.values(input.browserDistribution);
  const failing = outcomes.filter((o) => o.failed > 0);
  const cleanPassing = outcomes.filter((o) => o.failed === 0 && o.passed >= ENVIRONMENT_MIN_ATTEMPTS);
  if (failing.length === 1 && failing[0]!.failed >= ENVIRONMENT_MIN_ATTEMPTS && cleanPassing.length > 0) {
    return 'environment';
  }

  const timingCount = countKeywordMatches(allTexts, TIMING_KEYWORDS);
  const networkCount =
    countKeywordMatches(allTexts, NETWORK_KEYWORDS) +
    input.networkErrorCount +
    input.status5xxCount +
    (input.attemptDiffNetworkVotes ?? 0) * ATTEMPT_DIFF_NETWORK_WEIGHT;
  const assertionCount = countKeywordMatches(allTexts, ASSERTION_MARKERS);

  // Assertion requires NO timing/network keywords present
  const cleanAssertionCount = assertionCount > 0 && !hasTimingOrNetwork(allTexts) ? assertionCount : 0;

  const scores: Array<{ category: FlakyRootCause; score: number }> = [
    { category: 'timing', score: timingCount },
    { category: 'network', score: networkCount },
    { category: 'assertion', score: cleanAssertionCount },
  ];

  scores.sort((a, b) => b.score - a.score);

  if (scores[0]!.score > 0) return scores[0]!.category;
  return 'other';
}
