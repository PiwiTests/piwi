import type { BrowserConfig, WireBrowserEnvironment, WireRunnerEnvironment, WireServerEnvironment } from './types';
import { shownWorkerNumber } from './worker-lane';
import {
  BROWSER_FIELDS,
  RUNNER_FIELDS,
  SERVER_FIELDS,
  environmentValue,
  type EnvironmentField,
} from './environment-snapshots';

/**
 * The one registry of environment keys, read by both environment diffs: the execution-level diff (a failing
 * execution against the same test's last pass) and the run-level diff of the Changes tab. Each key has a label, a
 * group (the run, its runner, a browser, a server under test), whether it is informational and whether a null means
 * "not recorded". Only registered keys ever enter a diff: a generic object walk would leak arbitrary metadata and
 * drown the signal in noise.
 */

export type EnvironmentGroup = 'run' | 'runner' | 'browser' | 'server';

export interface EnvironmentKeyDef {
  key: string;
  label: string;
  group: EnvironmentGroup;
  /** Changes naturally between runs (worker placement, a host name): shown de-emphasized. */
  informational?: boolean;
  /** A null is "not recorded" rather than "unset": a side without it is never a change. */
  unrecordedWhenNull?: boolean;
}

/** The run's and the declared browser settings' keys (`test_runs` and `test_runs_cases.browser`). */
const STATIC_KEYS: readonly EnvironmentKeyDef[] = [
  { key: 'playwrightVersion', label: 'Playwright version', group: 'run' },
  { key: 'reporterVersion', label: 'Reporter version', group: 'run' },
  { key: 'environment', label: 'Environment label', group: 'run' },
  { key: 'ciProvider', label: 'CI provider', group: 'run' },
  { key: 'scmBranch', label: 'Branch', group: 'run' },
  // The baseline is the same Playwright project, so a browser engine one side did not record is not a different one.
  { key: 'browserName', label: 'Browser', group: 'browser', unrecordedWhenNull: true },
  { key: 'channel', label: 'Browser channel', group: 'browser' },
  { key: 'viewport', label: 'Viewport', group: 'browser' },
  { key: 'deviceScaleFactor', label: 'Device scale factor', group: 'browser' },
  { key: 'isMobile', label: 'Mobile emulation', group: 'browser' },
  { key: 'hasTouch', label: 'Touch support', group: 'browser' },
  { key: 'locale', label: 'Locale (declared)', group: 'browser' },
  { key: 'timezoneId', label: 'Timezone (declared)', group: 'browser' },
  { key: 'colorScheme', label: 'Color scheme', group: 'browser' },
  { key: 'reducedMotion', label: 'Reduced motion', group: 'browser' },
  { key: 'forcedColors', label: 'Forced colors', group: 'browser' },
  { key: 'contrast', label: 'Contrast preference', group: 'browser' },
  { key: 'offline', label: 'Offline mode', group: 'browser' },
  { key: 'javaScriptEnabled', label: 'JavaScript enabled', group: 'browser' },
  { key: 'serviceWorkers', label: 'Service workers', group: 'browser' },
  { key: 'userAgent', label: 'User agent', group: 'browser' },
  { key: 'headless', label: 'Headless', group: 'browser', unrecordedWhenNull: true },
  { key: 'worker', label: 'Worker', group: 'run', informational: true },
  { key: 'shardIndex', label: 'Shard index', group: 'run', informational: true },
];

function snapshotKeys(prefix: 'runner' | 'browser', fields: readonly EnvironmentField[]): EnvironmentKeyDef[] {
  return fields.map((field) => ({
    key: `${prefix}.${field.key}`,
    label: field.label,
    group: prefix,
    informational: field.informational,
    unrecordedWhenNull: true,
  }));
}

/** The browser snapshot's own engine is the declared `browserName` key: not registered twice. */
const OBSERVED_BROWSER_FIELDS = BROWSER_FIELDS.filter((f) => f.key !== 'browserName');

/** Every key with a fixed name, in diff order. Server keys add one set per origin (`serverKeys`). */
export const ENVIRONMENT_KEYS: readonly EnvironmentKeyDef[] = [
  ...STATIC_KEYS,
  ...snapshotKeys('runner', RUNNER_FIELDS),
  ...snapshotKeys('browser', OBSERVED_BROWSER_FIELDS),
];

const SERVER_KEY_PREFIX = 'server.';

/** The key of a server field: `server.<field>@<origin>`. */
export function serverKey(field: string, origin: string): string {
  return `${SERVER_KEY_PREFIX}${field}@${origin}`;
}

const KEY_BY_NAME = new Map(ENVIRONMENT_KEYS.map((def) => [def.key, def]));

/** The registry entry of a key, server keys included; undefined for an unregistered key. */
export function environmentKeyDef(key: string): EnvironmentKeyDef | undefined {
  const known = KEY_BY_NAME.get(key);
  if (known) return known;
  if (!key.startsWith(SERVER_KEY_PREFIX)) return undefined;
  const at = key.indexOf('@');
  if (at < 0) return undefined;
  const field = SERVER_FIELDS.find((f) => f.key === key.slice(SERVER_KEY_PREFIX.length, at));
  if (!field) return undefined;
  const origin = key.slice(at + 1);
  return {
    key,
    label: `${field.label} · ${origin}`,
    group: 'server',
    informational: field.informational,
    unrecordedWhenNull: true,
  };
}

/** The browser keys a missing browser snapshot has inferred: from the declared value, else the runner's. */
const INFERABLE_BROWSER_KEYS = [
  { key: 'browser.timeZone', declared: 'timezoneId', runner: 'runner.timeZone' },
  { key: 'browser.locale', declared: 'locale', runner: 'runner.locale' },
] as const;

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
  /** The runner snapshot of the execution's shard. */
  runner?: WireRunnerEnvironment | null;
  /** The browser snapshot of the execution's shard and project, as the page reported itself. */
  observedBrowser?: WireBrowserEnvironment | null;
  /** The servers under test the run recorded. */
  servers?: readonly WireServerEnvironment[] | null;
}

/** One execution's environment, flattened: each registered key to its display value, null when unset or unrecorded. */
export interface EnvironmentSnapshot {
  values: Record<string, string | null>;
  /** The keys whose value was inferred, not observed. */
  inferred: Set<string>;
}

export interface EnvironmentDiffEntry {
  key: string;
  label: string;
  group: EnvironmentGroup;
  failing: string | null;
  baseline: string | null;
  /** Keys that legitimately differ between runs: shown de-emphasized so they never read as a root-cause signal. */
  informational?: boolean;
  /** The failing side's value was inferred (the browser read nothing): labeled so in the UI. */
  failingInferred?: boolean;
  baselineInferred?: boolean;
}

function str(value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/**
 * Flatten the registered environment keys of one execution into a comparable `key → string|null` record. Unknown
 * metadata keys never enter the snapshot. With no observed browser snapshot, the browser's time zone and locale are
 * inferred: the declared value, else the runner's, and listed in `inferred`.
 */
export function buildEnvironmentSnapshot(source: EnvironmentSnapshotSource): EnvironmentSnapshot {
  const b = source.browser ?? null;
  const values: Record<string, string | null> = {
    playwrightVersion: str(source.playwrightVersion),
    reporterVersion: str(source.reporterVersion),
    environment: str(source.environment),
    ciProvider: str(source.ciProvider),
    scmBranch: str(source.scmBranch),
    browserName: str(b?.browserName ?? source.observedBrowser?.browserName),
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
    headless: str(b?.headless ?? source.observedBrowser?.headless),
    worker: str(shownWorkerNumber(source)),
    shardIndex: str(source.shardIndex),
  };
  for (const field of RUNNER_FIELDS) values[`runner.${field.key}`] = environmentValue(source.runner, field.key);
  for (const field of OBSERVED_BROWSER_FIELDS) {
    values[`browser.${field.key}`] = environmentValue(source.observedBrowser, field.key);
  }
  for (const server of source.servers ?? []) {
    for (const field of SERVER_FIELDS)
      values[serverKey(field.key, server.origin)] = environmentValue(server, field.key);
  }
  const inferred = new Set<string>();
  if (!source.observedBrowser) {
    for (const rule of INFERABLE_BROWSER_KEYS) {
      const value = values[rule.declared] ?? values[rule.runner] ?? null;
      if (value !== null) {
        values[rule.key] = value;
        inferred.add(rule.key);
      }
    }
  }
  return { values, inferred };
}

/**
 * Render the diff as the AI-context markdown section. Shared by the server and demo context builders so the model
 * sees the same shape in both. Returns null when there is no baseline to compare against (absent-reason handles
 * that); zero changed keys still renders: an identical environment is positive evidence.
 */
export function renderEnvironmentDiffMarkdown(result: {
  status: string;
  baseline?: { runId: number } | null;
  baselineNote?: string | null;
  entries?: EnvironmentDiffEntry[];
  serverNotes?: string[];
}): string | null {
  if (result.status !== 'ok' || !result.baseline) return null;
  const entries = result.entries ?? [];
  const note = result.baselineNote ? ` — ${result.baselineNote}` : '';
  const header = `## Environment Diff vs Last Pass\nFailing execution's environment compared to the same test's most recent passing execution (run #${result.baseline.runId}${note}):`;
  const serverNotes = (result.serverNotes ?? []).map((n) => `- ${n}`);
  if (entries.length === 0) {
    return [
      header,
      '- No differences — the environment is identical to the last pass, so environment drift is unlikely to explain this failure.',
      ...serverNotes,
    ].join('\n');
  }
  const groupTitle: Record<EnvironmentGroup, string> = {
    run: 'Run',
    runner: 'Runner',
    browser: 'Browser',
    server: 'Server under test',
  };
  const lines: string[] = [header];
  for (const group of ['run', 'runner', 'browser', 'server'] as const) {
    const inGroup = entries.filter((e) => e.group === group);
    if (inGroup.length === 0) continue;
    lines.push(`### ${groupTitle[group]}`);
    for (const e of inGroup) {
      const flag = e.informational ? ' (informational — varies naturally between runs)' : '';
      const inferredNote = e.failingInferred || e.baselineInferred ? ' (inferred, not observed)' : '';
      lines.push(`- ${e.label}: ${e.failing ?? '(unset)'} ← was ${e.baseline ?? '(unset)'}${flag}${inferredNote}`);
    }
  }
  lines.push(...serverNotes);
  return lines.join('\n');
}

/** A side's value and whether it was inferred, from a snapshot or a bare record. */
function sideOf(snapshot: EnvironmentSnapshot | Record<string, string | null>): EnvironmentSnapshot {
  return 'values' in snapshot && snapshot.values && typeof snapshot.values === 'object'
    ? (snapshot as EnvironmentSnapshot)
    : { values: snapshot as Record<string, string | null>, inferred: new Set() };
}

/**
 * Diff two environment snapshots, returning only the keys whose values differ, in registry order (server keys last,
 * by origin). A key missing on one side (null) still counts as a difference when the other side has a value (a
 * newly-set locale is exactly the kind of drift to surface), except a key one side may not have recorded
 * (`unrecordedWhenNull`). An inferred value is compared only with a value on the other side, never with a null.
 */
export function computeEnvironmentDiff(
  failingSnapshot: EnvironmentSnapshot | Record<string, string | null>,
  baselineSnapshot: EnvironmentSnapshot | Record<string, string | null>,
): EnvironmentDiffEntry[] {
  const failing = sideOf(failingSnapshot);
  const baseline = sideOf(baselineSnapshot);
  const serverKeyNames = [...new Set([...Object.keys(failing.values), ...Object.keys(baseline.values)])].filter((k) =>
    k.startsWith(SERVER_KEY_PREFIX),
  );
  const serverOrder = new Map(SERVER_FIELDS.map((f, i) => [f.key, i]));
  serverKeyNames.sort((a, b) => {
    const byOrigin = a.slice(a.indexOf('@')).localeCompare(b.slice(b.indexOf('@')));
    if (byOrigin !== 0) return byOrigin;
    const field = (k: string) => serverOrder.get(k.slice(SERVER_KEY_PREFIX.length, k.indexOf('@'))) ?? 99;
    return field(a) - field(b);
  });
  const defs = [
    ...ENVIRONMENT_KEYS,
    ...serverKeyNames.map(environmentKeyDef).filter((d): d is EnvironmentKeyDef => d !== undefined),
  ];
  const entries: EnvironmentDiffEntry[] = [];
  for (const def of defs) {
    const f = failing.values[def.key] ?? null;
    const p = baseline.values[def.key] ?? null;
    if (f === p) continue;
    if ((f === null || p === null) && def.unrecordedWhenNull) continue;
    const fInferred = failing.inferred.has(def.key);
    const pInferred = baseline.inferred.has(def.key);
    entries.push({
      key: def.key,
      label: fInferred || pInferred ? `${def.label} (inferred)` : def.label,
      group: def.group,
      failing: f,
      baseline: p,
      ...(def.informational ? { informational: true } : {}),
      ...(fInferred ? { failingInferred: true } : {}),
      ...(pInferred ? { baselineInferred: true } : {}),
    });
  }
  // An inferred browser value whose declared or runner value changed too says the same thing twice.
  const changed = new Set(entries.map((e) => e.key));
  return entries.filter((e) => {
    if (!e.failingInferred && !e.baselineInferred) return true;
    const rule = INFERABLE_BROWSER_KEYS.find((r) => r.key === e.key);
    return !rule || (!changed.has(rule.declared) && !changed.has(rule.runner));
  });
}
