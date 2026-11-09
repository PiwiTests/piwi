/**
 * Hand-back outcomes: what happened to something Piwi handed back to a person
 * or an agent. These value sets are a contract: rows store them, and the MCP
 * tools and the metrics read them.
 */

import { fnv1a32 } from '@piwitests/core/hash';

/** What was handed back. */
export const HANDBACK_KINDS = [
  'locator-heal',
  'auto-heal-pr',
  'diagnosis',
  'fix-attempt',
  'gap-draft',
  'bug-spec',
  'quarantine-proposal',
  'merge-suggestion',
  'gate',
  'flake-verify',
] as const;
export type HandbackKind = (typeof HANDBACK_KINDS)[number];

/**
 * What happened to it: handed out, applied, proven by a later run, turned down
 * by a person, or contradicted by a later run.
 */
export const HANDBACK_OUTCOMES = ['suggested', 'applied', 'verified', 'rejected', 'regressed'] as const;
export type HandbackOutcome = (typeof HANDBACK_OUTCOMES)[number];

/** How the outcome was learned: read from the runs (`inferred`) or reported through a surface. */
export const HANDBACK_CHANNELS = ['inferred', 'ui', 'mcp', 'editor', 'desktop', 'cli', 'ci'] as const;
export type HandbackChannel = (typeof HANDBACK_CHANNELS)[number];

/** The channels a report over the REST API may name; a report over MCP is `mcp`. */
export const REST_REPORT_CHANNELS = ['ui', 'editor', 'desktop', 'cli', 'ci'] as const;
export type RestReportChannel = (typeof REST_REPORT_CHANNELS)[number];

/** What a row's `subject_id` points at. */
export const HANDBACK_SUBJECT_TYPES = [
  'test-case',
  'cluster',
  'gap',
  'bug-report',
  'heal-action',
  'gate-evaluation',
] as const;
export type HandbackSubjectType = (typeof HANDBACK_SUBJECT_TYPES)[number];

/**
 * The label of an `applied` locator heal read from the runs: the code that ran
 * now uses the recommended locator, whoever wrote it.
 */
export const MATCHED_RECOMMENDATION_LABEL = 'matched-recommendation';

/** What a `locator-heal` row's details carry. */
export interface LocatorHealDetails {
  /** The failing call site, `file:line:col`. */
  location: string;
  failingLocator: string | null;
  recommendedLocator: string;
  recommendedSig: string;
  /** The run the failure was seen in. */
  failingRunId: number;
  executionId?: number;
  /** On `applied`: the run whose code first used the recommendation. */
  appliedRunId?: number;
  label?: string;
}

/**
 * What a `gate` row's details carry. A failed gate records `suggested`; a pull
 * request merged while its last gate evaluation failed records `rejected` (an
 * override); a cluster that gate caught failing again on an eligible
 * default-branch run after the merge records `regressed` (an escape).
 */
export interface GateOutcomeDetails {
  prNumber: number | null;
  verdict: 'passed' | 'failed' | 'inconclusive';
  /** The rules the evaluation violated. */
  rules: string[];
  /** On `regressed`: the cluster that failed again, and the run it failed in. */
  clusterId?: number;
  escapedRunId?: number;
}

/** Who reported an outcome, for the outcomes a person or an agent reports. */
export interface HandbackActor {
  channel: Exclude<HandbackChannel, 'inferred'>;
  /** The signed-in user; null or 0 when authentication is off. */
  userId?: number | null;
  /** The API key the call was made with. */
  apiKeyId?: number | null;
}

/** FNV-1a 32-bit as 8 hex characters: a short, stable key for what was suggested. */
export function suggestionHash(parts: ReadonlyArray<string | number | null | undefined>): string {
  return fnv1a32(parts.map((p) => (p == null ? '' : String(p))).join('\u0000'));
}
