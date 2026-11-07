/**
 * Helpers for reading a run's `metadata` JSON and diffing the environment / SCM /
 * browser context of two runs. Shared by the run-comparison handler and the
 * server-side regression-context builder so the diff stays identical on both.
 */

import { compareUrl, isPlainRevision } from '#shared/scm-urls';
import type { EnvironmentGroup } from '#shared/environment-diff';
import {
  BROWSER_FIELDS,
  RUNNER_FIELDS,
  SERVER_FIELDS,
  comparableSnapshots,
  environmentValue,
  type EnvironmentField,
} from '#shared/environment-snapshots';
import type { WireEnvironmentSnapshot } from '#shared/types';

/** One field that changed between two runs, for the "what changed" summary. */
export interface MetaDiffEntry {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  /** Where the field belongs: the run, its runner, a browser or a server under test. Absent reads as `run`. */
  group?: EnvironmentGroup;
}

/** What the run-level diff reads of a run beyond its metadata. */
export interface RunEnvironmentSide {
  playwrightVersion?: string | null;
  snapshots?: readonly WireEnvironmentSnapshot[];
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
): MetaDiffEntry[] {
  before = comparableSnapshots(before);
  after = comparableSnapshots(after);
  const diff: MetaDiffEntry[] = [];
  const push = (
    group: EnvironmentGroup,
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

/** The commit span between a baseline run and a later run, with a copyable git command. */
export interface CommitRange {
  fromSha: string;
  toSha: string;
  fromShort: string;
  toShort: string;
  repositoryUrl: string | null;
  compareUrl: string | null;
  gitCommand: string;
}

/** The slice of `test_runs.metadata` these helpers read. */
interface RunMetadataLike {
  scm?: { branch?: string | null } | null;
  ci?: { provider?: string | null } | null;
  htmlReport?: { projects?: Array<{ use?: { browserName?: string | null } | null }> } | null;
  playwrightConfig?: { shuffleSeed?: unknown } | null;
}

/**
 * The seed of a run Playwright scheduled in random order (`--shuffle`,
 * Playwright 1.64+), or null for a run in the order the files declare. Only a
 * plain token that does not start with `-` is returned, since the seed is shown
 * in a copyable `--shuffle <seed>` command.
 */
export function readShuffleSeed(meta: RunMetadataLike | null | undefined): string | null {
  const seed = meta?.playwrightConfig?.shuffleSeed;
  const text = typeof seed === 'number' && Number.isFinite(seed) ? String(seed) : seed;
  return typeof text === 'string' && /^\w[\w.-]{0,63}$/.test(text) ? text : null;
}

/** A run's test order in words: its shuffle seed, or the declared order. */
export function describeTestOrder(meta: RunMetadataLike | null | undefined): string {
  const seed = readShuffleSeed(meta);
  return seed ? `Shuffled, seed ${seed}` : 'Declared order';
}

/** Build a provider-specific "compare two commits" URL, or null when the host is unknown. */
export function buildCompareUrl(repositoryUrl: string, fromSha: string, toSha: string): string | null {
  return compareUrl(repositoryUrl, fromSha, toSha);
}

/**
 * The commit span from a baseline commit to a later one, with a compare URL when
 * the repository host is known and the `git log --oneline` command that lists it.
 * Returns null when either commit is missing, the two are the same, or either is
 * not a plain revision (the commits come from the reporter, and the command is
 * copied into a shell).
 */
export function buildCommitRange(
  repositoryUrl: string | null,
  fromSha: string | null | undefined,
  toSha: string | null | undefined,
): CommitRange | null {
  if (!fromSha || !toSha || fromSha === toSha) return null;
  if (!isPlainRevision(fromSha) || !isPlainRevision(toSha)) return null;
  return {
    fromSha,
    toSha,
    fromShort: fromSha.slice(0, 7),
    toShort: toSha.slice(0, 7),
    repositoryUrl,
    compareUrl: repositoryUrl ? buildCompareUrl(repositoryUrl, fromSha, toSha) : null,
    gitCommand: `git log --oneline ${fromSha}..${toSha}`,
  };
}

/** Comma-separated list of the distinct browser names configured in a run's report. */
export function getBrowserList(meta: RunMetadataLike | null | undefined): string {
  const projects = meta?.htmlReport?.projects;
  if (!projects?.length) return '';
  const names = [...new Set(projects.map((p) => p.use?.browserName).filter(Boolean))] as string[];
  return names.join(', ');
}

/**
 * Diff two runs' environment label, branch, CI provider, Playwright version, browser set and test order, then the
 * compared fields of their environment snapshots (`computeSnapshotDiff`), when the sides carry them. The test order
 * counts as changed when one run was shuffled and the other was not; two shuffled runs with different seeds do not
 * differ here.
 */
export function computeMetadataDiff(
  prevMeta: RunMetadataLike | null | undefined,
  currMeta: RunMetadataLike | null | undefined,
  prevEnv: string | null,
  currEnv: string | null,
  sides?: { before: RunEnvironmentSide; after: RunEnvironmentSide },
): MetaDiffEntry[] {
  const diff: MetaDiffEntry[] = [];

  if (prevEnv !== currEnv) {
    diff.push({ key: 'environment', label: 'Environment', before: prevEnv, after: currEnv });
  }
  const prevBranch: string | null = prevMeta?.scm?.branch ?? null;
  const currBranch: string | null = currMeta?.scm?.branch ?? null;
  if (prevBranch !== currBranch) {
    diff.push({ key: 'branch', label: 'Branch', before: prevBranch, after: currBranch });
  }
  const prevCi: string | null = prevMeta?.ci?.provider ?? null;
  const currCi: string | null = currMeta?.ci?.provider ?? null;
  if (prevCi !== currCi) {
    diff.push({ key: 'ci_provider', label: 'CI provider', before: prevCi, after: currCi });
  }
  const prevPlaywright = sides?.before.playwrightVersion ?? null;
  const currPlaywright = sides?.after.playwrightVersion ?? null;
  if (prevPlaywright && currPlaywright && prevPlaywright !== currPlaywright) {
    diff.push({
      key: 'playwright_version',
      label: 'Playwright version',
      before: prevPlaywright,
      after: currPlaywright,
    });
  }
  const prevBrowsers = getBrowserList(prevMeta);
  const currBrowsers = getBrowserList(currMeta);
  if (prevBrowsers !== currBrowsers) {
    diff.push({ key: 'browsers', label: 'Browsers', before: prevBrowsers || null, after: currBrowsers || null });
  }
  if ((readShuffleSeed(prevMeta) === null) !== (readShuffleSeed(currMeta) === null)) {
    diff.push({
      key: 'test_order',
      label: 'Test order',
      before: describeTestOrder(prevMeta),
      after: describeTestOrder(currMeta),
    });
  }
  if (sides) diff.push(...computeSnapshotDiff(sides.before.snapshots ?? [], sides.after.snapshots ?? []));

  return diff;
}
