/**
 * Environment snapshots: the closed list of fields each kind keeps, how a delivered snapshot is read field by field,
 * its scope (one stored row per run, kind and scope) and its digest. Pure, shared by the server, the demo and the UI.
 */
import { fnv1a32 } from '@piwitests/core/hash';
import {
  ENVIRONMENT_SNAPSHOTS_MAX,
  ENVIRONMENT_STRING_MAX,
  type EnvironmentKind,
  type WireBrowserEnvironment,
  type WireEnvironmentSnapshot,
  type WireRunnerEnvironment,
  type WireServerEnvironment,
} from '@piwitests/core/wire';

export { ENVIRONMENT_SNAPSHOTS_MAX };

/** The most snapshot rows a run keeps, its shards together: a new scope past it is dropped. */
export const RUN_ENVIRONMENT_ROWS_MAX = 512;

/** The server's clock offset from the runner's above which the run page warns. */
export const CLOCK_OFFSET_WARN_MS = 2000;

type FieldType = 'string' | 'number' | 'boolean';

/** One field of a snapshot kind: its label, how it is typed and whether its change is a possible cause. */
export interface EnvironmentField {
  key: string;
  label: string;
  type: FieldType;
  /** Changes naturally between runs (a host name, a UTC offset): shown de-emphasized, never in the digest. */
  informational?: boolean;
}

export const RUNNER_FIELDS: readonly EnvironmentField[] = [
  { key: 'timeZone', label: 'Time zone', type: 'string' },
  { key: 'tzVariable', label: 'TZ variable', type: 'string' },
  { key: 'locale', label: 'Locale', type: 'string' },
  { key: 'langVariables', label: 'Locale variables', type: 'string' },
  { key: 'os', label: 'Operating system', type: 'string' },
  { key: 'arch', label: 'Architecture', type: 'string' },
  { key: 'nodeVersion', label: 'Node.js version', type: 'string' },
  { key: 'icuVersion', label: 'ICU version', type: 'string' },
  { key: 'ciImage', label: 'CI runner image', type: 'string' },
  { key: 'container', label: 'Container', type: 'string' },
  { key: 'utcOffsetMinutes', label: 'UTC offset (minutes)', type: 'number', informational: true },
  { key: 'cpuModel', label: 'CPU model', type: 'string', informational: true },
  { key: 'cores', label: 'CPU cores', type: 'number', informational: true },
  { key: 'memoryBytes', label: 'Memory', type: 'number', informational: true },
  { key: 'hostname', label: 'Host name', type: 'string', informational: true },
];

export const BROWSER_FIELDS: readonly EnvironmentField[] = [
  { key: 'browserName', label: 'Browser', type: 'string' },
  { key: 'browserVersion', label: 'Browser version', type: 'string' },
  { key: 'timeZone', label: 'Time zone', type: 'string' },
  { key: 'locale', label: 'Locale', type: 'string' },
  { key: 'languages', label: 'Languages', type: 'string' },
  { key: 'formatSample', label: 'Formatting', type: 'string' },
  { key: 'prefersColorScheme', label: 'Color scheme', type: 'string' },
  { key: 'prefersReducedMotion', label: 'Reduced motion', type: 'string' },
  { key: 'headless', label: 'Headless', type: 'boolean' },
  { key: 'screen', label: 'Screen', type: 'string', informational: true },
  { key: 'devicePixelRatio', label: 'Device pixel ratio', type: 'number', informational: true },
  { key: 'userAgent', label: 'User agent', type: 'string', informational: true },
];

export const SERVER_FIELDS: readonly EnvironmentField[] = [
  { key: 'runtime', label: 'Runtime', type: 'string' },
  { key: 'os', label: 'Operating system', type: 'string' },
  { key: 'arch', label: 'Architecture', type: 'string' },
  { key: 'timeZone', label: 'Time zone', type: 'string' },
  { key: 'locale', label: 'Culture', type: 'string' },
  { key: 'globalization', label: 'Globalization', type: 'string' },
  { key: 'environmentName', label: 'Environment name', type: 'string' },
  { key: 'appVersion', label: 'App version', type: 'string' },
  { key: 'utcOffsetMinutes', label: 'UTC offset (minutes)', type: 'number', informational: true },
  { key: 'hostname', label: 'Host name', type: 'string', informational: true },
  { key: 'instance', label: 'Process', type: 'string', informational: true },
  { key: 'startedAt', label: 'Started at', type: 'string', informational: true },
  { key: 'clockOffsetMs', label: 'Clock offset (ms)', type: 'number', informational: true },
  { key: 'clockOffsetErrorMs', label: 'Clock offset error (ms)', type: 'number', informational: true },
  { key: 'fetchedAt', label: 'Read at', type: 'number', informational: true },
  { key: 'restarted', label: 'Restarted during the run', type: 'boolean', informational: true },
];

export const ENVIRONMENT_FIELDS: Record<EnvironmentKind, readonly EnvironmentField[]> = {
  runner: RUNNER_FIELDS,
  browser: BROWSER_FIELDS,
  server: SERVER_FIELDS,
};

/** Fields that are shown nowhere a run is shared publicly. */
export const PRIVATE_FIELDS = new Set(['hostname']);

function readField(value: unknown, type: FieldType): string | number | boolean | null {
  if (type === 'string') {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > ENVIRONMENT_STRING_MAX ? trimmed.slice(0, ENVIRONMENT_STRING_MAX) : trimmed;
  }
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null;
  return typeof value === 'boolean' ? value : null;
}

function readShardIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000 ? value : null;
}

/**
 * One delivered snapshot rebuilt from its listed fields only, its strings cut to `ENVIRONMENT_STRING_MAX`; null when
 * it is not a snapshot of a known kind. Nothing outside the field lists is kept.
 */
export function sanitizeEnvironmentSnapshot(value: unknown): WireEnvironmentSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (raw.v !== 1 || (kind !== 'runner' && kind !== 'browser' && kind !== 'server')) return null;
  const out: Record<string, unknown> = { kind, v: 1 };
  for (const field of ENVIRONMENT_FIELDS[kind]) out[field.key] = readField(raw[field.key], field.type);
  if (kind === 'runner' || kind === 'browser') out.shardIndex = readShardIndex(raw.shardIndex);
  if (kind === 'runner' && raw.imported === true) out.imported = true;
  if (kind === 'browser') {
    const project = readField(raw.project, 'string');
    if (typeof project !== 'string' && raw.project !== '') return null;
    out.project = project ?? '';
  }
  if (kind === 'server') {
    const origin = readField(raw.origin, 'string');
    if (typeof origin !== 'string') return null;
    out.origin = origin;
  }
  return out as unknown as WireEnvironmentSnapshot;
}

/** The delivered snapshots that read as snapshots, at most `ENVIRONMENT_SNAPSHOTS_MAX`. */
export function sanitizeEnvironmentSnapshots(value: unknown): WireEnvironmentSnapshot[] {
  if (!Array.isArray(value)) return [];
  const out: WireEnvironmentSnapshot[] = [];
  for (const item of value) {
    if (out.length >= ENVIRONMENT_SNAPSHOTS_MAX) break;
    const snapshot = sanitizeEnvironmentSnapshot(item);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

/** The row a snapshot is stored in: the shard for a runner, `<shard>|<project>` for a browser, the origin for a server. */
export function environmentScope(snapshot: WireEnvironmentSnapshot): string {
  if (snapshot.kind === 'server') return snapshot.origin;
  const shard = snapshot.shardIndex != null ? String(snapshot.shardIndex) : '';
  return snapshot.kind === 'browser' ? `${shard}|${snapshot.project}` : shard;
}

/**
 * The digest of a snapshot's compared fields: `fnv1a32` of their canonical JSON, the keys in the field list's order.
 * Equal digests mean no compared field changed; a change detector, not a security hash.
 */
export function environmentDigest(snapshot: WireEnvironmentSnapshot): string {
  const record = snapshot as unknown as Record<string, unknown>;
  const compared = ENVIRONMENT_FIELDS[snapshot.kind]
    .filter((field) => !field.informational)
    .map((field) => [field.key, record[field.key] ?? null]);
  return fnv1a32(JSON.stringify(compared));
}

/**
 * Runner fields whose null in a recorded snapshot means the variable or container is absent, not that it was not
 * read: shown as `unset`, so setting `TZ` shows as a change. An imported snapshot read none of them.
 */
const UNSET_WHEN_NULL = new Set(['tzVariable', 'langVariables', 'container']);

/** A snapshot's field as display text: null when not recorded. */
export function environmentValue(snapshot: WireEnvironmentSnapshot | null | undefined, key: string): string | null {
  if (!snapshot) return null;
  const value = (snapshot as unknown as Record<string, unknown>)[key];
  if ((value === null || value === undefined) && snapshot.kind === 'runner' && !snapshot.imported) {
    return UNSET_WHEN_NULL.has(key) ? 'unset' : null;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (key === 'memoryBytes' && typeof value === 'number') return `${Math.round(value / 1024 ** 3)} GB`;
  return String(value);
}

/**
 * The runner of one shard among a run's snapshots: the shard's own, else, for an execution with no shard, the run's
 * single runner. Never another shard's.
 */
export function runnerOfShard(
  snapshots: readonly WireEnvironmentSnapshot[],
  shardIndex: number | null | undefined,
): WireRunnerEnvironment | null {
  const runners = snapshots.filter((s): s is WireRunnerEnvironment => s.kind === 'runner');
  const own = runners.find((s) => (s.shardIndex ?? null) === (shardIndex ?? null));
  if (own) return own;
  return shardIndex == null && runners.length === 1 ? runners[0]! : null;
}

/**
 * The snapshots a comparison reads: an imported runner is left out, its fields read from another source (a blob
 * report's user agent) in another format.
 */
export function comparableSnapshots(snapshots: readonly WireEnvironmentSnapshot[]): WireEnvironmentSnapshot[] {
  return snapshots.filter((s) => !(s.kind === 'runner' && s.imported));
}

/** A run's snapshots grouped by kind, each kind in scope order. */
export interface RunEnvironments {
  runner: WireRunnerEnvironment[];
  browser: WireBrowserEnvironment[];
  server: WireServerEnvironment[];
}

export function groupEnvironments(snapshots: readonly WireEnvironmentSnapshot[]): RunEnvironments {
  const groups: RunEnvironments = { runner: [], browser: [], server: [] };
  const sorted = [...snapshots].sort((a, b) =>
    environmentScope(a).localeCompare(environmentScope(b), 'en', { numeric: true }),
  );
  for (const s of sorted) (groups[s.kind] as WireEnvironmentSnapshot[]).push(s);
  return groups;
}

/** The compared fields of a kind whose values differ between the snapshots (shards that disagree); none for one. */
export function disagreeingFields(snapshots: readonly WireEnvironmentSnapshot[]): EnvironmentField[] {
  if (snapshots.length < 2) return [];
  const kind = snapshots[0]!.kind;
  return ENVIRONMENT_FIELDS[kind].filter((field) => {
    if (field.informational) return false;
    const values = new Set(snapshots.map((s) => environmentValue(s, field.key)));
    return values.size > 1;
  });
}

/** The run's environments with what a public share leaves out (`PRIVATE_FIELDS`) removed. */
export function withoutPrivateFields(environments: RunEnvironments): RunEnvironments {
  const strip = <T extends WireEnvironmentSnapshot>(s: T): T => {
    const copy = { ...s } as Record<string, unknown>;
    for (const key of PRIVATE_FIELDS) if (key in copy) copy[key] = null;
    return copy as unknown as T;
  };
  return {
    runner: environments.runner.map(strip),
    browser: environments.browser.map(strip),
    server: environments.server.map(strip),
  };
}

/**
 * A server snapshot delivered for an origin another shard already reported: the newer one, keeping a restart either
 * saw and the clock offset furthest from zero, so one shard's report never hides another's warning.
 */
export function mergeServerSnapshots(
  stored: WireServerEnvironment,
  delivered: WireServerEnvironment,
): WireServerEnvironment {
  const offset = (s: WireServerEnvironment) => (s.clockOffsetMs == null ? -1 : Math.abs(s.clockOffsetMs));
  const clock = offset(stored) > offset(delivered) ? stored : delivered;
  return {
    ...delivered,
    restarted: stored.restarted || delivered.restarted ? true : (delivered.restarted ?? stored.restarted ?? null),
    clockOffsetMs: clock.clockOffsetMs ?? null,
    clockOffsetErrorMs: clock.clockOffsetErrorMs ?? null,
  };
}

/** The servers that warn: one that restarted during the run, or whose clock is off by more than `CLOCK_OFFSET_WARN_MS`. */
export function serverWarnings(server: WireServerEnvironment): Array<'restarted' | 'clock'> {
  const warnings: Array<'restarted' | 'clock'> = [];
  if (server.restarted) warnings.push('restarted');
  if (server.clockOffsetMs != null && Math.abs(server.clockOffsetMs) > CLOCK_OFFSET_WARN_MS) warnings.push('clock');
  return warnings;
}

/** One field that changed between two runs' snapshots. */
export interface SnapshotDiffEntry {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  group: 'runner' | 'browser' | 'server';
}

/** Said after the values of a field the shards of one run disagree on. */
export const SHARDS_DIFFER = '(differs between shards)';

/** One run's value of a field across its snapshots: one value, every value when they differ, null when none. */
function combinedValue(snapshots: readonly WireEnvironmentSnapshot[], key: string): string | null {
  const values = [...new Set(snapshots.map((s) => environmentValue(s, key)).filter((v): v is string => v !== null))];
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  return `${values.join(', ')} ${SHARDS_DIFFER}`;
}

/**
 * The compared fields of the runner, each browser (by project) and each server (by origin) that changed between two
 * runs. A field one run did not record is not a change, nor is an imported runner's; informational fields are left
 * out.
 */
export function computeSnapshotDiff(
  before: readonly WireEnvironmentSnapshot[],
  after: readonly WireEnvironmentSnapshot[],
): SnapshotDiffEntry[] {
  before = comparableSnapshots(before);
  after = comparableSnapshots(after);
  const diff: SnapshotDiffEntry[] = [];
  const push = (
    group: SnapshotDiffEntry['group'],
    fields: readonly EnvironmentField[],
    a: readonly WireEnvironmentSnapshot[],
    b: readonly WireEnvironmentSnapshot[],
    scope: string | null,
  ) => {
    if (a.length === 0 || b.length === 0) return;
    for (const field of fields) {
      if (field.informational) continue;
      const prev = combinedValue(a, field.key);
      const curr = combinedValue(b, field.key);
      if (prev === null || curr === null || prev === curr) continue;
      diff.push({
        key: `${group}.${field.key}${scope ? `@${scope}` : ''}`,
        label: scope ? `${field.label} · ${scope}` : field.label,
        before: prev,
        after: curr,
        group,
      });
    }
  };
  push(
    'runner',
    RUNNER_FIELDS,
    before.filter((s) => s.kind === 'runner'),
    after.filter((s) => s.kind === 'runner'),
    null,
  );
  const projects = new Set(after.flatMap((s) => (s.kind === 'browser' ? [s.project] : [])));
  for (const project of projects) {
    const of = (list: readonly WireEnvironmentSnapshot[]) =>
      list.filter((s) => s.kind === 'browser' && s.project === project);
    push('browser', BROWSER_FIELDS, of(before), of(after), project);
  }
  const origins = new Set(after.flatMap((s) => (s.kind === 'server' ? [s.origin] : [])));
  for (const origin of origins) {
    const of = (list: readonly WireEnvironmentSnapshot[]) =>
      list.filter((s) => s.kind === 'server' && s.origin === origin);
    push('server', SERVER_FIELDS, of(before), of(after), origin);
  }
  return diff;
}

/** What an environment change marker's description starts with, which tells it from the other auto markers. */
export const ENVIRONMENT_MARKER_PREFIX = 'Environment change';

const MARKER_CATEGORY: Record<EnvironmentKind, string> = { runner: 'infra', browser: 'infra', server: 'config' };
const KIND_TITLE: Record<EnvironmentKind, string> = { runner: 'Runner', browser: 'Browser', server: 'Server' };

/** The digests of a run's snapshots of one kind, as a set. */
function digestsOf(snapshots: readonly WireEnvironmentSnapshot[], kind: EnvironmentKind): string {
  return [...new Set(snapshots.filter((s) => s.kind === kind).map(environmentDigest))].sort().join(',');
}

/**
 * The automatic markers a run's snapshots call for against the previous run's: one per kind whose compared fields
 * changed (runner and browser `infra`, server `config`), labeled with the fields. A kind either run did not record,
 * and an imported runner, are no change. Shared by the server and the demo seed.
 */
export function environmentChangeMarkers(
  before: readonly WireEnvironmentSnapshot[],
  after: readonly WireEnvironmentSnapshot[],
): Array<{ kind: EnvironmentKind; label: string; description: string; category: string }> {
  const a = comparableSnapshots(before);
  const b = comparableSnapshots(after);
  const out: Array<{ kind: EnvironmentKind; label: string; description: string; category: string }> = [];
  for (const kind of ['runner', 'browser', 'server'] as const) {
    const da = digestsOf(a, kind);
    const db = digestsOf(b, kind);
    if (!da || !db || da === db) continue;
    const changes = computeSnapshotDiff(
      a.filter((s) => s.kind === kind),
      b.filter((s) => s.kind === kind),
    );
    if (changes.length === 0) continue;
    const label = `${KIND_TITLE[kind]}: ${changes.map((c) => `${c.label} ${c.before} → ${c.after}`).join(', ')}`;
    out.push({
      kind,
      label: label.length > 300 ? `${label.slice(0, 299)}…` : label,
      description: `${ENVIRONMENT_MARKER_PREFIX}: ${KIND_TITLE[kind].toLowerCase()}`,
      category: MARKER_CATEGORY[kind],
    });
  }
  return out;
}
