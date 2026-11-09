/**
 * The three states an evidence card can be in, and the one decision that picks
 * between them. Shared by the humans' empty cards (execution and cluster pages)
 * and the model's "Data Coverage" map, so both read the same answer to "is this
 * blank because it was never switched on, because nothing happened, or because
 * it does not apply here?".
 *
 * Deliberately pure and node-free: callers hand it the facts (does the row hold
 * this evidence, was it recovered from the trace, were the capture fixtures
 * active for this execution) and get back the state plus the copy to show.
 */

import type { CapabilityState } from '#shared/capabilities';

/** Evidence cards that fold away when empty and now show one of three states. */
export type EvidenceCardId = 'console' | 'network' | 'appState' | 'ariaSnapshot' | 'backendLogs' | 'webVitals';

export const EVIDENCE_CARD_IDS: readonly EvidenceCardId[] = [
  'console',
  'network',
  'appState',
  'ariaSnapshot',
  'backendLogs',
  'webVitals',
];

/** Facts about one execution's card, gathered at the call site. */
export interface EvidenceStateInput {
  /** Whether the row holds any data for this card (fixture- or trace-derived). */
  hasData: boolean;
  /** How the present data was captured — `'trace'` when recovered without the fixtures. */
  source?: 'fixture' | 'trace';
  /** Whether Piwi's capture fixtures were active for this execution (any fixture field present). */
  fixturesActive: boolean;
  /** Resolved state of the capability backing this card, when the caller knows it. */
  capability?: CapabilityState;
}

export type EvidenceState =
  /** Data is present; `derivedFromTrace` drives the "derived from the trace" chip. */
  | { state: 'present'; derivedFromTrace: boolean }
  /** The capability behind this card is declined for this project. */
  | { state: 'declined'; title: string; description: string }
  /** The fixtures were never switched on for this project — the card links to the connect wizard (`/settings/connect`). */
  | { state: 'not-captured'; title: string; description: string; to: string; toLabel: string }
  /** The fixtures were active and this run simply produced nothing. */
  | { state: 'nothing-happened'; title: string; description: string }
  /** The card needs a capability the app under test does not have. */
  | { state: 'not-applicable'; title: string; description: string };

interface CardCopy {
  /** Card title, reused as the empty-state heading. */
  title: string;
  /** What to add to start capturing this evidence. */
  enable: string;
  /** What "the fixtures ran but produced nothing" reads like for this card. */
  nothing: string;
}

const CARD_COPY: Record<EvidenceCardId, CardCopy> = {
  console: {
    title: 'Console output',
    enable: 'add the capture fixtures',
    nothing: 'the page logged nothing',
  },
  network: {
    title: 'Network requests',
    enable: 'add the capture fixtures',
    nothing: 'the page made no API or document requests',
  },
  appState: {
    title: 'App state',
    enable: 'add the capture fixtures (the capturePageState option, on by default, records it)',
    nothing: 'nothing about the page state was recorded',
  },
  ariaSnapshot: {
    title: 'ARIA snapshot',
    enable: 'add the capture fixtures',
    nothing: 'the page had no accessibility tree to snapshot',
  },
  backendLogs: {
    title: 'Backend logs',
    enable: 'add the capture fixtures',
    nothing: 'no request returned Piwi backend logs',
  },
  webVitals: {
    title: 'Web Vitals',
    enable: 'add the capture fixtures',
    nothing: 'no Web Vitals were recorded (they need a Chromium browser)',
  },
};

/**
 * Decide which of the three empty states a card is in — or that it holds data.
 *
 * `not-captured` is the "you never switched this on" state and always links to
 * the connect wizard; `nothing-happened` is the fixtures running and finding nothing;
 * `not-applicable` is reserved for backend logs, which need a Piwi backend
 * integration on the app under test on top of the fixtures.
 */
export function resolveEvidenceState(id: EvidenceCardId, input: EvidenceStateInput): EvidenceState {
  if (input.hasData) {
    return { state: 'present', derivedFromTrace: input.source === 'trace' };
  }

  const copy = CARD_COPY[id];

  // A declined capability is gone, not empty: data still wins above, but with no
  // data the card names the decision rather than offering to switch it on.
  if (input.capability === 'declined') {
    return { state: 'declined', title: copy.title, description: `${copy.title} is declined for this project.` };
  }

  // Backend logs ride on the fixtures but need instrumentation on the app under
  // test. With the fixtures active and still nothing, the missing piece is the
  // backend integration, not the fixtures.
  if (id === 'backendLogs' && input.fixturesActive) {
    return {
      state: 'not-applicable',
      title: copy.title,
      description: 'Backend logs need a Piwi backend integration on the app under test.',
    };
  }

  if (input.fixturesActive) {
    return {
      state: 'nothing-happened',
      title: copy.title,
      description: `The fixtures were active and ${copy.nothing}.`,
    };
  }

  return {
    state: 'not-captured',
    title: copy.title,
    description: `${copy.title} is not captured for this project — ${copy.enable}.`,
    to: '/settings/connect',
    toLabel: 'Open setup',
  };
}

/**
 * Short reason string for the model's "Data Coverage" map, or `null` when the
 * card holds data. Mirrors {@link resolveEvidenceState} so the humans' cards and
 * the model's map name the same cause; `not applicable` is returned bare so the
 * caller can route it to its own coverage bucket.
 */
export function evidenceAbsenceReason(id: EvidenceCardId, input: EvidenceStateInput): string | null {
  const resolved = resolveEvidenceState(id, input);
  switch (resolved.state) {
    case 'present':
      return null;
    case 'declined':
      return 'declined for this project';
    case 'not-captured':
      return 'not captured — capture fixtures not active for this project';
    case 'nothing-happened':
      return 'fixtures active, nothing recorded';
    case 'not-applicable':
      return 'needs a Piwi backend integration on the app under test';
  }
}
