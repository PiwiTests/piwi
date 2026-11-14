/**
 * Caps applied to per-execution payloads at ingest time, before persistence.
 *
 * These bound what gets stored (forever) on `test_runs_cases` rows and the
 * failure-cluster sample error — a different concern from the AI context
 * limits (`PIWI_AI_MAX_*`, `shared/ai-context-limits.ts`), which bound what
 * enters a diagnosis prompt. Storage defaults sit at or above the AI-limit
 * defaults, so at their defaults the AI limits remain the binding constraint
 * for prompts.
 *
 * Overridable per deployment via `PIWI_INGEST_MAX_*` environment variables
 * only (no settings UI — see `server/utils/ingest-limits.ts`).
 */

export interface IngestLimits {
  /** Max stored console entries per execution (first 20 + newest are kept). */
  consoleEntries: number;
  /** Max characters per stored console entry text. */
  consoleEntryChars: number;
  /** Max stored test steps per execution. */
  steps: number;
  /** Max stored param keys kept per step. */
  stepParamKeys: number;
  /** Max characters kept per stored step param value. */
  stepParamValueChars: number;
  /** Max stored step events per execution. */
  stepEvents: number;
  /** Max stored lock names per execution. */
  locks: number;
  /** Max stored browser dialogs per execution. */
  dialogs: number;
  /** Max characters of the stored ARIA snapshot. */
  ariaSnapshotChars: number;
  /** Max characters of the stored per-execution error (head + tail are kept). */
  errorChars: number;
  /** Max characters of the failure-cluster sample error (the full exemplar). */
  sampleErrorChars: number;
  /** Max characters of the stored test source snippet. */
  testSourceChars: number;
  /** Max stored source stack frames per execution. */
  sourceFrames: number;
  /** Max characters per stored source frame snippet. */
  sourceFrameChars: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  consoleEntries: 200,
  consoleEntryChars: 2000,
  steps: 500,
  stepParamKeys: 20,
  stepParamValueChars: 200,
  stepEvents: 1000,
  locks: 20,
  dialogs: 50,
  ariaSnapshotChars: 100000,
  errorChars: 20000,
  sampleErrorChars: 50000,
  testSourceChars: 50000,
  sourceFrames: 8,
  sourceFrameChars: 4000,
};

export interface IngestLimitField {
  key: keyof IngestLimits;
  /** Environment variable that overrides this limit. */
  envVar: string;
  description: string;
  min: number;
  max: number;
}

/** Field metadata driving env-var parsing and validation. */
export const INGEST_LIMIT_FIELDS: IngestLimitField[] = [
  {
    key: 'consoleEntries',
    envVar: 'PIWI_INGEST_MAX_CONSOLE_ENTRIES',
    description: 'Max console entries stored per execution.',
    min: 10,
    max: 5000,
  },
  {
    key: 'consoleEntryChars',
    envVar: 'PIWI_INGEST_MAX_CONSOLE_ENTRY_CHARS',
    description: 'Max characters stored per console entry.',
    min: 200,
    max: 20000,
  },
  {
    key: 'steps',
    envVar: 'PIWI_INGEST_MAX_STEPS',
    description: 'Max test steps stored per execution.',
    min: 20,
    max: 5000,
  },
  {
    key: 'stepParamKeys',
    envVar: 'PIWI_INGEST_MAX_STEP_PARAM_KEYS',
    description: 'Max param keys stored per step.',
    min: 1,
    max: 100,
  },
  {
    key: 'stepParamValueChars',
    envVar: 'PIWI_INGEST_MAX_STEP_PARAM_VALUE_CHARS',
    description: 'Max characters stored per step param value.',
    min: 20,
    max: 2000,
  },
  {
    key: 'stepEvents',
    envVar: 'PIWI_INGEST_MAX_STEP_EVENTS',
    description: 'Max step events stored per execution.',
    min: 20,
    max: 10000,
  },
  {
    key: 'locks',
    envVar: 'PIWI_INGEST_MAX_LOCKS',
    description: 'Max lock names stored per execution.',
    min: 1,
    max: 100,
  },
  {
    key: 'dialogs',
    envVar: 'PIWI_INGEST_MAX_DIALOGS',
    description: 'Max browser dialogs stored per execution.',
    min: 1,
    max: 500,
  },
  {
    key: 'ariaSnapshotChars',
    envVar: 'PIWI_INGEST_MAX_ARIA_CHARS',
    description: 'Max characters of the ARIA snapshot stored per failing execution.',
    min: 1000,
    max: 1000000,
  },
  {
    key: 'errorChars',
    envVar: 'PIWI_INGEST_MAX_ERROR_CHARS',
    description: 'Max characters of error text stored per execution.',
    min: 1000,
    max: 100000,
  },
  {
    key: 'sampleErrorChars',
    envVar: 'PIWI_INGEST_MAX_SAMPLE_ERROR_CHARS',
    description: 'Max characters of the sample error stored per failure cluster.',
    min: 1000,
    max: 200000,
  },
  {
    key: 'testSourceChars',
    envVar: 'PIWI_INGEST_MAX_TEST_SOURCE_CHARS',
    description: 'Max characters of the test source snippet stored per failing execution.',
    min: 1000,
    max: 200000,
  },
  {
    key: 'sourceFrames',
    envVar: 'PIWI_INGEST_MAX_SOURCE_FRAMES',
    description: 'Max source stack frames stored per failing execution.',
    min: 1,
    max: 32,
  },
  {
    key: 'sourceFrameChars',
    envVar: 'PIWI_INGEST_MAX_SOURCE_FRAME_CHARS',
    description: 'Max characters per stored source frame snippet.',
    min: 500,
    max: 20000,
  },
];

/** Clamp a candidate value to a field's allowed range; returns null when not a finite number. */
export function clampIngestLimit(field: IngestLimitField, value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(field.max, Math.max(field.min, Math.floor(n)));
}
