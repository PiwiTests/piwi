/**
 * The nudges the dashboard can show, by id: rare, rule-based suggestions a page
 * offers when a condition over what it already loaded holds (the registry is
 * `app/utils/nudges/`). The dismissal routes accept these ids only, and a
 * dismissal is stored per user on the server, so a nudge dismissed in one
 * browser stays dismissed in every other.
 */

export const ASSISTANT_NUDGE_IDS = [
  'undecided-capabilities',
  'diagnosis-without-diff',
  'failure-without-fixtures',
] as const;

export type AssistantNudgeId = (typeof ASSISTANT_NUDGE_IDS)[number];

const NUDGE_IDS = new Set<string>(ASSISTANT_NUDGE_IDS);

export function isAssistantNudgeId(value: unknown): value is AssistantNudgeId {
  return typeof value === 'string' && NUDGE_IDS.has(value);
}

/** A nudge the caller dismissed for good, and when. */
export interface AssistantNudgeDismissal {
  nudgeId: AssistantNudgeId;
  dismissedAt: string;
}
