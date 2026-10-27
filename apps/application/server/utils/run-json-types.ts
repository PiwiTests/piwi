import type { BrowserConfig } from '#shared/types';
import type { RunOrigin } from '@piwitests/core/wire';
import type { ServerLogEntry, ServerSpanEntry } from '~~/types/api';

/**
 * View-types for the JSON columns on `test_runs` / `test_runs_cases`, covering
 * the fields the server reads. The columns are stored as untyped JSON (`mode:
 * 'json'`), so these provide a typed lens instead of scattered `as any` casts.
 */

export interface TestStepInfo {
  title: string;
  /** The step's target (rendered locator or URL), carried separately by newer Playwright. */
  subtitle?: string;
  /** Curated per-step arguments (rendered locator, URL, value, `test.step` author values). */
  params?: Record<string, string | number | boolean>;
  duration?: number;
  category?: string;
  /**
   * The step's error when it failed (undefined when the step passed): its
   * message, and where it was thrown (`file:line:col`) on runs from a recent reporter.
   */
  error?: { message?: string; location?: string };
  /** True when the step carried an error — the signal for inline failure markers. */
  failed?: boolean;
  /** True when the test caught the step's error and went on; set by a recent reporter. */
  recovered?: boolean;
  /** Source pointer `file:line:col` (not a code snippet); present on runs from a recent reporter. */
  location?: string;
  /** Absolute start time in ms; present on runs from a recent reporter. */
  startTime?: number;
}

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp?: number;
  location?: string | null;
}

export interface WebVitals {
  navigation?: { domContentLoaded?: number | null; loadComplete?: number | null } | null;
  paint?: { firstPaint?: number | null; firstContentfulPaint?: number | null } | null;
  vitals?: { lcp?: number | null; cls?: number | null; inp?: number | null } | null;
}

/** SCM block of `test_runs.metadata`. */
export interface RunScmMetadata {
  commit?: string | null;
  /** The logical branch resolved by the reporter's fallback chain — never `HEAD`. */
  branch?: string | null;
  /** Pull-request number captured from the CI provider, when it exposes one. */
  prNumber?: string | number | null;
  /** The branch a pull-request build targets, when the CI provider exposes it. */
  baseBranch?: string | null;
  remoteUrl?: string | null;
}

/** `test_runs.metadata` JSON — the fields the server reads. */
export interface RunMetadata {
  scm?: RunScmMetadata | null;
  /**
   * The repository's default branch, when the reporter's `defaultBranch` option
   * recorded one. Optional and often absent — the server resolves the effective
   * default branch through `resolveDefaultBranch` (project setting → SCM
   * provider → this hint → `'main'`).
   */
  defaultBranch?: string | null;
  ci?: { provider?: string | null; pipelineId?: string | null; buildNumber?: string | null } | null;
  /** What launched the run (`PIWI_ORIGIN`); read through `runOrigin` in `#shared/run-eligibility`. */
  piwiOrigin?: RunOrigin | null;
  htmlReport?: {
    projects?: Array<{ use?: { browserName?: string | null; baseURL?: string | null } | null }>;
  } | null;
}

export type { BrowserConfig, ServerLogEntry, ServerSpanEntry };
