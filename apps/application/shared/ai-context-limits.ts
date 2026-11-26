/**
 * Caps that bound the size of the AI diagnosis context (and therefore token cost).
 * Defaults can be overridden per-deployment via Settings → AI or `PIWI_AI_MAX_*`
 * environment variables (env takes precedence over the stored settings).
 */

export interface ContextLimits {
  /** Max characters of raw error text (cluster sample + execution error). */
  sampleErrorChars: number;
  /** Total characters of SCM diff patches included across all changed files. */
  scmPatchBudget: number;
  /** Max affected tests listed. */
  affectedTests: number;
  /** Max recent test steps included. */
  steps: number;
  /** Max console error/warning entries included. */
  consoleEntries: number;
  /** Max characters per console entry. */
  consoleEntryChars: number;
  /** Max failed network requests included. */
  networkRequests: number;
  /** Max characters of the ARIA snapshot. */
  ariaSnapshotChars: number;
  /** Max characters of the test source snippet. */
  testSourceChars: number;
  /** Max number of full source files fetched from SCM to ground patches (0 disables). */
  maxSourceFiles: number;
  /** Max characters per fetched full source file. */
  sourceFileChars: number;
  /** When > 0, parse the Playwright trace ZIP to extract failing action context. */
  maxTraceActions: number;
  /** Max characters for trace-derived DOM/ARIA excerpt. */
  traceDomChars: number;
  /** Max stack frames from the trace's call-stack index, with source windows (0 disables the section). */
  traceStackFrames: number;
  /** Max requests from the trace's network stream (0 disables the section). */
  traceNetworkRequests: number;
  /** Max characters of the trace-derived failure-time DOM snapshot (0 disables the section). */
  domSnapshotChars: number;
  /** Max backend server log entries (from X-Piwi-Logs header) included. */
  serverLogEntries: number;
  /** Max characters per backend server log entry. */
  serverLogEntryChars: number;
  /** Max backend server spans (from X-Piwi-Trace header) included (0 disables the section). */
  serverTraceSpans: number;
  /** Max screenshots auto-included in the diagnosis context. */
  maxImages: number;
  /** Max peer tests in the same file listed when they passed. */
  maxPassedPeers: number;
  /** Max console entries of any type in the window before failure. */
  maxConsoleWindow: number;
  /** Network request duration (ms) threshold for flagging as slow. */
  slowRequestMs: number;
  /** Screenshots are downscaled so their long edge is at most this many pixels before being sent. */
  imageMaxEdge: number;
  /** Max AI-step intent mappings (prompt → compiled locator) included (0 disables the section). */
  aiStepIntents: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  sampleErrorChars: 10000,
  scmPatchBudget: 15000,
  affectedTests: 30,
  steps: 50,
  consoleEntries: 30,
  consoleEntryChars: 1000,
  networkRequests: 25,
  ariaSnapshotChars: 12000,
  testSourceChars: 8000,
  maxSourceFiles: 4,
  sourceFileChars: 12000,
  serverLogEntries: 50,
  serverLogEntryChars: 1000,
  serverTraceSpans: 40,
  maxImages: 5,
  maxPassedPeers: 20,
  maxConsoleWindow: 50,
  slowRequestMs: 1500,
  maxTraceActions: 10,
  traceDomChars: 6000,
  traceStackFrames: 10,
  traceNetworkRequests: 20,
  domSnapshotChars: 8000,
  imageMaxEdge: 1920,
  aiStepIntents: 20,
};

export interface ContextLimitField {
  key: keyof ContextLimits;
  label: string;
  /** Environment variable that overrides this limit. */
  envVar: string;
  description: string;
  min: number;
  max: number;
}

/** Field metadata driving env-var parsing, validation and the settings UI. */
export const CONTEXT_LIMIT_FIELDS: ContextLimitField[] = [
  {
    key: 'sampleErrorChars',
    label: 'Error text characters',
    envVar: 'PIWI_AI_MAX_SAMPLE_ERROR_CHARS',
    description: 'Max characters of raw error text (per error block).',
    min: 200,
    max: 50000,
  },
  {
    key: 'scmPatchBudget',
    label: 'SCM patch budget',
    envVar: 'PIWI_AI_MAX_SCM_PATCH_BUDGET',
    description: 'Total characters of diff patches across changed files.',
    min: 0,
    max: 50000,
  },
  {
    key: 'affectedTests',
    label: 'Affected tests',
    envVar: 'PIWI_AI_MAX_AFFECTED_TESTS',
    description: 'Max affected tests listed.',
    min: 1,
    max: 200,
  },
  {
    key: 'steps',
    label: 'Test steps',
    envVar: 'PIWI_AI_MAX_STEPS',
    description: 'Max recent test steps included.',
    min: 1,
    max: 200,
  },
  {
    key: 'consoleEntries',
    label: 'Console entries',
    envVar: 'PIWI_AI_MAX_CONSOLE_ENTRIES',
    description: 'Max console error/warning entries included.',
    min: 0,
    max: 200,
  },
  {
    key: 'consoleEntryChars',
    label: 'Console entry characters',
    envVar: 'PIWI_AI_MAX_CONSOLE_ENTRY_CHARS',
    description: 'Max characters per console entry.',
    min: 50,
    max: 5000,
  },
  {
    key: 'networkRequests',
    label: 'Network requests',
    envVar: 'PIWI_AI_MAX_NETWORK_REQUESTS',
    description: 'Max failed network requests included.',
    min: 0,
    max: 200,
  },
  {
    key: 'ariaSnapshotChars',
    label: 'ARIA snapshot characters',
    envVar: 'PIWI_AI_MAX_ARIA_SNAPSHOT_CHARS',
    description: 'Max characters of the page ARIA snapshot.',
    min: 0,
    max: 50000,
  },
  {
    key: 'testSourceChars',
    label: 'Test source characters',
    envVar: 'PIWI_AI_MAX_TEST_SOURCE_CHARS',
    description: 'Max characters of the test source snippet.',
    min: 0,
    max: 50000,
  },
  {
    key: 'maxSourceFiles',
    label: 'Full source files',
    envVar: 'PIWI_AI_MAX_SOURCE_FILES',
    description: 'Max full source files fetched from SCM to ground patches (0 disables).',
    min: 0,
    max: 20,
  },
  {
    key: 'sourceFileChars',
    label: 'Source file characters',
    envVar: 'PIWI_AI_MAX_SOURCE_FILE_CHARS',
    description: 'Max characters per fetched full source file.',
    min: 0,
    max: 50000,
  },
  {
    key: 'serverLogEntries',
    label: 'Server log entries',
    envVar: 'PIWI_AI_MAX_SERVER_LOG_ENTRIES',
    description: 'Max backend server log entries (from X-Piwi-Logs header) included.',
    min: 0,
    max: 200,
  },
  {
    key: 'serverLogEntryChars',
    label: 'Server log entry characters',
    envVar: 'PIWI_AI_MAX_SERVER_LOG_ENTRY_CHARS',
    description: 'Max characters per backend server log entry.',
    min: 50,
    max: 5000,
  },
  {
    key: 'serverTraceSpans',
    label: 'Server trace spans',
    envVar: 'PIWI_AI_MAX_SERVER_TRACE_SPANS',
    description: 'Max backend server spans (from X-Piwi-Trace header) included (0 disables).',
    min: 0,
    max: 500,
  },
  {
    key: 'maxImages',
    label: 'Max screenshots',
    envVar: 'PIWI_AI_MAX_IMAGES',
    description: 'Max screenshots auto-included in the diagnosis context.',
    min: 0,
    max: 20,
  },
  {
    key: 'maxPassedPeers',
    label: 'Max passed peers',
    envVar: 'PIWI_AI_MAX_PASSED_PEERS',
    description: 'Max peer tests in the same file listed when they passed.',
    min: 0,
    max: 100,
  },
  {
    key: 'maxConsoleWindow',
    label: 'Console window entries',
    envVar: 'PIWI_AI_MAX_CONSOLE_WINDOW',
    description: 'Max console entries of any type in the window before failure.',
    min: 0,
    max: 200,
  },
  {
    key: 'slowRequestMs',
    label: 'Slow request threshold (ms)',
    envVar: 'PIWI_AI_SLOW_REQUEST_MS',
    description: 'Network request duration threshold for flagging as slow.',
    min: 100,
    max: 30000,
  },
  {
    key: 'maxTraceActions',
    label: 'Trace actions',
    envVar: 'PIWI_AI_MAX_TRACE_ACTIONS',
    description: 'Max actions extracted from trace ZIP for failing-action context (0 disables).',
    min: 0,
    max: 50,
  },
  {
    key: 'traceDomChars',
    label: 'Trace DOM excerpt characters',
    envVar: 'PIWI_AI_TRACE_DOM_CHARS',
    description: 'Max characters for the trace-derived DOM/ARIA excerpt in failing-action context.',
    min: 0,
    max: 20000,
  },
  {
    key: 'traceStackFrames',
    label: 'Trace stack frames',
    envVar: 'PIWI_AI_MAX_TRACE_STACK_FRAMES',
    description: 'Max call-stack frames (with source windows) from the trace (0 disables).',
    min: 0,
    max: 50,
  },
  {
    key: 'traceNetworkRequests',
    label: 'Trace network requests',
    envVar: 'PIWI_AI_MAX_TRACE_NETWORK_REQUESTS',
    description: 'Max requests from the trace network stream (0 disables).',
    min: 0,
    max: 200,
  },
  {
    key: 'domSnapshotChars',
    label: 'DOM snapshot characters',
    envVar: 'PIWI_AI_MAX_DOM_SNAPSHOT_CHARS',
    description: 'Max characters of the failure-time DOM snapshot rendered from the trace (0 disables).',
    min: 0,
    max: 50000,
  },
  {
    key: 'imageMaxEdge',
    label: 'Screenshot max edge (px)',
    envVar: 'PIWI_AI_IMAGE_MAX_EDGE',
    description: 'Screenshots are downscaled to at most this many pixels on the long edge before being sent.',
    min: 512,
    max: 8192,
  },
  {
    key: 'aiStepIntents',
    label: 'AI-step intents',
    envVar: 'PIWI_AI_MAX_STEP_INTENTS',
    description: 'Max AI-step intent mappings (prompt → compiled locator) included (0 disables the section).',
    min: 0,
    max: 100,
  },
];

/** Clamp a candidate value to a field's allowed range; returns null when not a finite number. */
export function clampLimit(field: ContextLimitField, value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(field.max, Math.max(field.min, Math.floor(n)));
}

/** App-setting key the effective overrides are stored under (server DB and demo DB alike). */
export const CONTEXT_LIMITS_SETTING_KEY = 'ai_context_limits';

/**
 * Merge stored per-field overrides over the defaults, clamping each to its
 * field range. Env-var precedence (server-only) is layered on top by the
 * caller — this is the part the demo shares verbatim since it has no env.
 */
export function resolveStoredContextLimits(stored: Partial<ContextLimits> | null | undefined): ContextLimits {
  const limits: ContextLimits = { ...DEFAULT_CONTEXT_LIMITS };
  if (!stored) return limits;
  for (const field of CONTEXT_LIMIT_FIELDS) {
    const storedVal = clampLimit(field, stored[field.key]);
    if (storedVal != null) limits[field.key] = storedVal;
  }
  return limits;
}

/**
 * Merge an incoming partial update into a stored overrides map: null/empty
 * resets a field to its default, an env-managed field is ignored, everything
 * else is clamped to its field range. Shared so the server and demo persist
 * identically.
 */
export function mergeContextLimitsUpdate(
  stored: Partial<ContextLimits> | null | undefined,
  incoming: Partial<Record<keyof ContextLimits, unknown>>,
  envManaged: ReadonlySet<keyof ContextLimits> = new Set(),
): Partial<ContextLimits> {
  const next: Partial<ContextLimits> = { ...stored };
  for (const field of CONTEXT_LIMIT_FIELDS) {
    if (envManaged.has(field.key)) continue;
    if (!(field.key in incoming)) continue;
    const raw = incoming[field.key];
    if (raw === null || raw === undefined || raw === '') {
      delete next[field.key];
      continue;
    }
    const clamped = clampLimit(field, raw);
    if (clamped != null) next[field.key] = clamped;
  }
  return next;
}
