import type { BrowserConfig } from './types';
import { shownWorkerNumber } from './worker-lane';

/**
 * Pure environment-diff helpers: flatten a whitelisted set of run/browser
 * metadata keys into a comparable snapshot, then diff a failing execution's
 * snapshot against its last passing baseline. Only whitelisted keys ever enter
 * the diff — a generic object walk would leak arbitrary metadata and drown the
 * signal in noise.
 */

export interface EnvironmentSnapshotSource {
  /** Playwright framework version recorded on the run. */
  playwrightVersion?: string | null;
  /** Piwi reporter package version recorded on the run. */
  reporterVersion?: string | null;
  /** Deployment environment label of the run (e.g. 'staging'). */
  environment?: string | null;
  /** CI provider name from run metadata. */
  ciProvider?: string | null;
  /** Git branch from run metadata. */
  scmBranch?: string | null;
  /** Per-execution browser/context configuration. */
  browser?: BrowserConfig | null;
  /** Playwright's worker process, which names the worker only for a result without a lane. */
  workerIndex?: number | null;
  /** The worker's lane (Playwright's `parallelIndex`), which names it from 1. */
  parallelIndex?: number | null;
  shardIndex?: number | null;
}

export interface EnvironmentDiffEntry {
  key: string;
  label: string;
  failing: string | null;
  baseline: string | null;
  /**
   * Keys that legitimately differ between runs (worker/shard placement) —
   * shown de-emphasized so they never read as a root-cause signal.
   */
  informational?: boolean;
}

const INFORMATIONAL_KEYS = new Set(['worker', 'shardIndex']);

/**
 * Keys whose null means not recorded rather than unset. The baseline is the same Playwright project, so a browser
 * engine one side did not record is not a different engine.
 */
const UNRECORDED_WHEN_NULL_KEYS = new Set(['browserName']);

const KEY_LABELS: Record<string, string> = {
  playwrightVersion: 'Playwright version',
  reporterVersion: 'Reporter version',
  environment: 'Environment label',
  ciProvider: 'CI provider',
  scmBranch: 'Branch',
  browserName: 'Browser',
  channel: 'Browser channel',
  viewport: 'Viewport',
  deviceScaleFactor: 'Device scale factor',
  isMobile: 'Mobile emulation',
  hasTouch: 'Touch support',
  locale: 'Locale',
  timezoneId: 'Timezone',
  colorScheme: 'Color scheme',
  reducedMotion: 'Reduced motion',
  forcedColors: 'Forced colors',
  contrast: 'Contrast preference',
  offline: 'Offline mode',
  javaScriptEnabled: 'JavaScript enabled',
  serviceWorkers: 'Service workers',
  userAgent: 'User agent',
  worker: 'Worker',
  shardIndex: 'Shard index',
};

/** Ordered whitelist — diff output follows this order. */
const KEY_ORDER = Object.keys(KEY_LABELS);

function str(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * Flatten the whitelisted environment keys of one execution into a comparable
 * `key → string|null` record. Unknown metadata keys never enter the snapshot.
 */
export function buildEnvironmentSnapshot(source: EnvironmentSnapshotSource): Record<string, string | null> {
  const b = source.browser ?? null;
  return {
    playwrightVersion: str(source.playwrightVersion),
    reporterVersion: str(source.reporterVersion),
    environment: str(source.environment),
    ciProvider: str(source.ciProvider),
    scmBranch: str(source.scmBranch),
    browserName: str(b?.browserName),
    channel: str(b?.channel),
    viewport: b?.viewport ? `${b.viewport.width}x${b.viewport.height}` : null,
    deviceScaleFactor: str(b?.deviceScaleFactor),
    isMobile: str(b?.isMobile),
    hasTouch: str(b?.hasTouch),
    locale: str(b?.locale),
    timezoneId: str(b?.timezoneId),
    colorScheme: str(b?.colorScheme),
    reducedMotion: str(b?.reducedMotion),
    forcedColors: str(b?.forcedColors),
    contrast: str(b?.contrast),
    offline: str(b?.offline),
    javaScriptEnabled: str(b?.javaScriptEnabled),
    serviceWorkers: str(b?.serviceWorkers),
    userAgent: str(b?.userAgent),
    worker: str(shownWorkerNumber(source)),
    shardIndex: str(source.shardIndex),
  };
}

/**
 * Render the diff as the AI-context markdown section. Shared by the server and
 * demo context builders so the model sees the same shape in both. Returns null
 * when there is no baseline to compare against (absent-reason handles that);
 * zero changed keys still renders — identical environment is positive evidence.
 */
export function renderEnvironmentDiffMarkdown(result: {
  status: string;
  baseline?: { runId: number } | null;
  baselineNote?: string | null;
  entries?: EnvironmentDiffEntry[];
}): string | null {
  if (result.status !== 'ok' || !result.baseline) return null;
  const entries = result.entries ?? [];
  const note = result.baselineNote ? ` — ${result.baselineNote}` : '';
  const header = `## Environment Diff vs Last Pass\nFailing execution's environment compared to the same test's most recent passing execution (run #${result.baseline.runId}${note}):`;
  if (entries.length === 0) {
    return `${header}\n- No differences — the environment is identical to the last pass, so environment drift is unlikely to explain this failure.`;
  }
  const body = entries
    .map((e) => {
      const note = e.informational ? ' (informational — varies naturally between runs)' : '';
      return `- ${e.label}: ${e.failing ?? '(unset)'} ← was ${e.baseline ?? '(unset)'}${note}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * Diff two environment snapshots, returning only the keys whose values differ.
 * A key missing on one side (null) still counts as a difference when the other
 * side has a value — a newly-set locale is exactly the kind of drift to surface —
 * except a key one side may not have recorded (`UNRECORDED_WHEN_NULL_KEYS`).
 */
export function computeEnvironmentDiff(
  failing: Record<string, string | null>,
  baseline: Record<string, string | null>,
): EnvironmentDiffEntry[] {
  const entries: EnvironmentDiffEntry[] = [];
  for (const key of KEY_ORDER) {
    const f = failing[key] ?? null;
    const p = baseline[key] ?? null;
    if (f === p) continue;
    if (f === null && p === null) continue;
    if ((f === null || p === null) && UNRECORDED_WHEN_NULL_KEYS.has(key)) continue;
    entries.push({
      key,
      label: KEY_LABELS[key] ?? key,
      failing: f,
      baseline: p,
      ...(INFORMATIONAL_KEYS.has(key) ? { informational: true } : {}),
    });
  }
  return entries;
}
