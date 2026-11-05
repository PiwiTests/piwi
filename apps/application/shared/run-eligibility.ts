/**
 * Which runs may feed which analysis: the one eligibility rule.
 *
 * A run's origin says what launched it (`metadata.piwiOrigin`, stamped by the
 * reporter from `PIWI_ORIGIN`, or by the server for imports and CI re-runs). A
 * run replaying a test under injected conditions (Flake Lab, a probe), a bisect
 * step or a reproduction at an older commit says nothing about how the suite
 * behaves today, so each use below names the origins it leaves out, whether it
 * reads complete runs only, and whether an environment incident counts.
 * `isEligibleRun` decides for a run in hand, `eligibleRunSql` and
 * `eligibleExecutionSql` decide the same in a query, from the origin stored in
 * `test_runs.origin`: every write of a run's metadata also writes `runOrigin`
 * of that metadata to the column.
 *
 * Runs stored before the origin existed read as `probe` or `flake-lab` from
 * their lab stamp, `import` from their import record, `ci` when the reporter
 * recorded a CI provider, and `local` otherwise.
 *
 * Local runs (a developer's machine, the desktop app, an editor) count like CI
 * runs, except as the editor's CI failures while a CI run exists on the branch,
 * and for their outbound effects, which follow this policy:
 *
 * - A complete run (the whole suite, finished) from a developer's machine
 *   (`local`) or the desktop app (`desktop`) sends what a CI run sends
 *   (`notifications`, `tracker`): the run events (`run.finished`, `run.failed`,
 *   `run.failed.default_branch`, and `run.interrupted` for one the stale-run
 *   sweep ended), the cluster events, `flakiness.spike`, `perf.regression` and
 *   `bug.looks_fixed`, or one `environment.incident` in their place; the
 *   pull-request comment and commit status; AI diagnosis
 *   (`diagnosis.completed`) and auto-heal (`auto_heal.pr_opened`); the
 *   tracker's own writes; and, while it runs, `test.stuck` (`test-stuck`, for
 *   which a full run counts as complete before it finishes). Such a run of
 *   part of the suite sends none of them.
 * - A run from an editor (`editor`) sends none of them, complete or not.
 * - An interactive run, one a local hub steers (an editor service's or the
 *   desktop app's, whose run channel its workers connect to; the reporter
 *   stamps it `piwiInteractive`), never sends `test.stuck`, its tests stopping
 *   at a person's breakpoints. Its other effects follow its origin, so a
 *   complete `local` or `desktop` run a hub steers still sends its run's
 *   notifications.
 *
 * A finished run's analysis (fix verification, change coverage, the hand-back
 * outcomes) does not follow that policy: each step reads the run under its own
 * use. A run from an editor does not make a failure cluster recur either
 * (`cluster-occurrences`).
 */

import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { FLAKE_LAB_RUN_METADATA_KEY } from '@piwitests/core/flake-plan';
import {
  parseRunOrigin,
  parseRunOriginRef,
  RUN_INTERACTIVE_METADATA_KEY,
  RUN_ORIGIN_KINDS,
  RUN_ORIGIN_METADATA_KEY,
  RUN_REF_METADATA_KEY,
  type RunOriginKind,
} from '@piwitests/core/wire';
import { testRuns } from '../server/database/schema';
import { INCIDENT_RUN_METADATA_KEY } from './run-incident';

export { RUN_ORIGIN_KINDS, RUN_ORIGIN_METADATA_KEY, FLAKE_LAB_RUN_METADATA_KEY, type RunOriginKind };

/** The run-metadata flag that stamps a run as a probe run (never a real run). */
export const PROBE_RUN_METADATA_KEY = 'piwiProbe';

export { INCIDENT_RUN_METADATA_KEY };

/** A run's origin kind; `other` for a stamp naming a kind this version does not know. */
export type RunOriginRead = RunOriginKind | 'other';

/** The origins of lab runs, which replay tests under conditions Piwi injected. */
export const LAB_RUN_ORIGINS = ['flake-lab', 'probe'] as const satisfies readonly RunOriginKind[];

/** The origins of runs at a commit chosen to investigate a failure, not the branch's current state. */
export const INVESTIGATION_RUN_ORIGINS = ['bisect', 'reproduce'] as const satisfies readonly RunOriginKind[];

/** The origins of CI runs, which the editor shows as the branch's CI failures. */
export const CI_RUN_ORIGINS = ['ci', 'ci-rerun'] as const satisfies readonly RunOriginKind[];

/** The origins of a developer's own runs: their machine, the desktop app, an editor. */
export const LOCAL_RUN_ORIGINS = ['local', 'desktop', 'editor'] as const satisfies readonly RunOriginKind[];

const LAB_AND_INVESTIGATION: readonly RunOriginKind[] = [...LAB_RUN_ORIGINS, ...INVESTIGATION_RUN_ORIGINS];

/** What a use reads runs for. */
export type RunUse =
  | 'baseline'
  | 'run-baseline'
  | 'fix-verification'
  | 'flakiness'
  | 'selection-catalog'
  | 'branch-failures'
  | 'editor-overlay'
  | 'change-coverage'
  | 'test-map'
  | 'shared-state'
  | 'auto-heal'
  | 'bug-lifecycle'
  | 'notifications'
  | 'test-stuck'
  | 'tracker'
  | 'cluster-occurrences'
  | 'run-health';

export interface RunUseRule {
  /** The origins whose runs this use never reads. */
  excludes: readonly RunOriginKind[];
  /** Leave out a run flagged as an environment incident. */
  excludesIncidents: boolean;
  /** Read only complete runs: the whole suite, finished. */
  completeOnly: boolean;
  /** The origins whose runs this use reads only when complete; none when absent. */
  completeOnlyFor?: readonly RunOriginKind[];
  /** Leave out a historical import: a report imported after newer runs were stored. */
  excludesHistoricalImports: boolean;
  /** Leave out an interactive run, one a local hub steers (`isInteractiveRun`); false when absent. */
  excludesInteractive?: boolean;
}

/**
 * The rule per use. Further conditions stay with the use that owns them: fix
 * verification also needs a new commit on the cluster's branch or the default
 * branch, the editor's CI failures prefer a CI run on the branch
 * (`CI_RUN_ORIGINS`), the runs the editor overlays on that run are the finished
 * runs of its branch started after it, and the bug-report lifecycle reads the
 * default branch. The `notifications` use decides a finished run's outbound
 * effects alone: never for a run from an editor, a bisect step or a
 * reproduction, and for a run from a developer's machine or the desktop app
 * only when it ran the whole suite
 * (`completeOnlyFor`); the analysis behind them follows its own uses.
 * `test-stuck` decides a running attempt's `test.stuck` by the same rule, and
 * never for an interactive run.
 */
export const RUN_USES: Record<RunUse, RunUseRule> = {
  /** Execution baselines: the environment, visual and page diffs, the AI's baseline comparison, the last pass. */
  baseline: {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Run baselines: a run compared with a whole earlier run. */
  'run-baseline': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: true,
    excludesHistoricalImports: false,
  },
  'fix-verification': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  flakiness: {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Pass rates, last statuses, recent failures and durations behind selections and their suggestions. */
  'selection-catalog': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** What the editor shows as the branch's CI failures. */
  'branch-failures': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: true,
    excludesHistoricalImports: false,
  },
  /** The runs the editor overlays on the branch's latest complete run. */
  'editor-overlay': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Change coverage and every "not reached in the last N runs" analysis. */
  'change-coverage': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: false,
    completeOnly: true,
    excludesHistoricalImports: false,
  },
  /**
   * The Test Map's evidence: the statuses and the new surface the default branch's
   * runs observed, and the surface its complete runs no longer reach. An
   * environment incident's errors are the environment's, not the application's.
   */
  'test-map': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Locator snapshots, the locator index, test metadata and green samples. */
  'shared-state': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: true,
  },
  'auto-heal': {
    excludes: LAB_AND_INVESTIGATION,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  'bug-lifecycle': {
    excludes: ['bug', ...LAB_AND_INVESTIGATION],
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /**
   * A finished run's outbound effects: notifications, the pull-request comment
   * and commit status, AI diagnosis and auto-heal. Never a run at a commit
   * chosen to investigate a failure. An environment incident sends one
   * `environment.incident` event instead, and the gate reads it as
   * inconclusive.
   */
  notifications: {
    excludes: [...LAB_AND_INVESTIGATION, 'editor'],
    excludesIncidents: true,
    completeOnly: false,
    completeOnlyFor: ['local', 'desktop'],
    excludesHistoricalImports: false,
  },
  /**
   * A running attempt's `test.stuck`: the rule of `notifications`, read while
   * the run runs (its caller counts a full run as complete), and never for an
   * interactive run, whose tests stop at a person's breakpoints.
   */
  'test-stuck': {
    excludes: [...LAB_AND_INVESTIGATION, 'editor'],
    excludesIncidents: true,
    completeOnly: false,
    completeOnlyFor: ['local', 'desktop'],
    excludesHistoricalImports: false,
    excludesInteractive: true,
  },
  /**
   * The writes Piwi makes to an issue tracker on its own: automatic creation,
   * and the comments, transitions and description updates a run's verdicts
   * trigger. The rule of `notifications`.
   */
  tracker: {
    excludes: [...LAB_AND_INVESTIGATION, 'editor'],
    excludesIncidents: true,
    completeOnly: false,
    completeOnlyFor: ['local', 'desktop'],
    excludesHistoricalImports: false,
  },
  /**
   * A failure cluster's occurrences: their count, the runs the cluster was first
   * and last seen in, and the wake of an "until it recurs" snooze. A run from an
   * editor, a bisect step or a reproduction still joins its failures to their
   * clusters, without making them recur.
   */
  'cluster-occurrences': {
    excludes: [...LAB_AND_INVESTIGATION, 'editor'],
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** The runs the incident classifier judges, and the runs of other projects it compares them with. */
  'run-health': {
    excludes: LAB_RUN_ORIGINS,
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
};

/** Statuses of a run that has not finished yet. */
export const UNFINISHED_RUN_STATUSES = ['initializing', 'running', 'finalizing'] as const;

function record(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function isObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True when a run's metadata stamps it as a probe run. */
export function isProbeRun(metadata: unknown): boolean {
  return record(metadata)?.[PROBE_RUN_METADATA_KEY] === true;
}

/** True when a run's metadata stamps it as a flake-lab run. */
export function isFlakeLabRun(metadata: unknown): boolean {
  const stamp = record(metadata)?.[FLAKE_LAB_RUN_METADATA_KEY];
  return !!stamp && typeof stamp === 'object';
}

/** True when a run is flagged as an environment incident. */
export function isIncidentRun(metadata: unknown): boolean {
  return isObject(record(metadata)?.[INCIDENT_RUN_METADATA_KEY]);
}

/**
 * True for an interactive run: one a local hub steers (an editor service's or the desktop app's), which the reporter
 * stamps with the hub's client and the run's ref there (`RunInteractive`).
 */
export function isInteractiveRun(metadata: unknown): boolean {
  return isObject(record(metadata)?.[RUN_INTERACTIVE_METADATA_KEY]);
}

/** What launched a run, read from its metadata. */
export function runOrigin(metadata: unknown): RunOriginRead {
  const meta = record(metadata);
  if (isProbeRun(meta)) return 'probe';
  if (isFlakeLabRun(meta)) return 'flake-lab';
  if (meta && RUN_ORIGIN_METADATA_KEY in meta && isObject(meta[RUN_ORIGIN_METADATA_KEY])) {
    return parseRunOrigin(meta[RUN_ORIGIN_METADATA_KEY])?.kind ?? 'other';
  }
  if (isObject(meta?.import)) return 'import';
  if (isObject(meta?.ci)) return 'ci';
  return 'local';
}

/**
 * The commit a run tested, read from its metadata (`scm.commit`): 7 to 64
 * hexadecimal characters, lowercased; null when it names none. Written to
 * `test_runs.commit` with every write of the metadata.
 */
export function runCommit(metadata: unknown): string | null {
  const commit = record(record(metadata)?.scm)?.commit;
  if (typeof commit !== 'string') return null;
  const value = commit.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(value) ? value : null;
}

/** What a run was launched for (a dispatch, a cluster, a bug report), when its origin names it. */
export function runOriginRef(metadata: unknown): string | null {
  return parseRunOrigin(record(metadata)?.[RUN_ORIGIN_METADATA_KEY])?.ref ?? null;
}

/** The launcher's name for the run itself (`PIWI_RUN_REF`), when the reporter recorded one. */
export function runLauncherRef(metadata: unknown): string | null {
  return parseRunOriginRef(record(metadata)?.[RUN_REF_METADATA_KEY]) ?? null;
}

/**
 * True for a lab run, one that replays tests under conditions Piwi injected: a
 * probe run or a flake-lab run. A lab run never counts as a real run, so no use
 * reads it.
 */
export function isLabRun(metadata: unknown): boolean {
  return (LAB_RUN_ORIGINS as readonly string[]).includes(runOrigin(metadata));
}

/** The fields of a run the rule reads. */
export interface EligibleRunInput {
  metadata?: unknown;
  /** 1 (or true) when the run covered the whole suite. */
  isFullRun?: number | boolean | null;
  status?: string | null;
  /**
   * True for a historical import: a report imported after newer runs of the
   * project were stored. Known only to the caller, which has looked it up;
   * the SQL form cannot tell, so a use excluding it filters it where it is known.
   */
  historicalImport?: boolean;
}

/** True for a run that covered the whole suite and finished. */
export function isCompleteRun(run: EligibleRunInput): boolean {
  const full = run.isFullRun === undefined || run.isFullRun === null ? true : Boolean(run.isFullRun);
  return full && !(UNFINISHED_RUN_STATUSES as readonly string[]).includes(run.status ?? '');
}

/** True when `run` may feed `use`. */
export function isEligibleRun(run: EligibleRunInput, use: RunUse): boolean {
  const rule = RUN_USES[use];
  const origin = runOrigin(run.metadata);
  if ((rule.excludes as readonly string[]).includes(origin)) return false;
  if (rule.excludesIncidents && isIncidentRun(run.metadata)) return false;
  if (rule.completeOnly && !isCompleteRun(run)) return false;
  if (((rule.completeOnlyFor ?? []) as readonly string[]).includes(origin) && !isCompleteRun(run)) return false;
  if (rule.excludesHistoricalImports && run.historicalImport) return false;
  if (rule.excludesInteractive && isInteractiveRun(run.metadata)) return false;
  return true;
}

// ── The same rule in SQL ─────────────────────────────────────────────────────
//
// A run's origin is stored in `test_runs.origin`: every write of a run's
// metadata writes `runOrigin` of that metadata beside it, so the SQL form reads
// one column. The incident flag, the interactive stamp and an origin's ref are
// read from the metadata itself. Metadata is JSON text on SQLite and `jsonb` on
// PostgreSQL, and the demo's database is SQLite in the browser, so those keys
// are matched in the serialized text, in both spellings: SQLite keeps the text
// as written (`"k":v`), and `jsonb` puts a space after each colon and comma and
// sorts an object's keys shortest first (`{"ref": "…", "kind": "…"}`). The
// server writes the origin as `{ kind, ref? }`, kind first, and its ref holds
// no quote.

function text(metadata: SQLWrapper): SQL {
  return sql`COALESCE(CAST(${metadata} AS TEXT), '')`;
}

function likeAny(value: SQL, patterns: string[]): SQL {
  return sql.join(
    patterns.map((p) => sql`${value} LIKE ${p}`),
    sql` OR `,
  );
}

/** The text holds an object (or a value) under `key`, in either spelling. */
function hasKey(value: SQL, key: string, opening: string): SQL {
  return sql`(${likeAny(value, [`%"${key}":${opening}%`, `%"${key}": ${opening}%`])})`;
}

/** A run's stored origin and its metadata, for the predicates that read both. */
export interface RunOriginColumns {
  origin: SQLWrapper;
  metadata: SQLWrapper;
}

/**
 * SQL predicate: the run's origin is exactly `kind` with `ref`. The stored
 * origin narrows the runs first; the ref is matched in the metadata text, in
 * either spelling. A ref holds no quote and no LIKE wildcard
 * (`parseRunOriginRef`).
 */
export function runOriginIs(columns: RunOriginColumns, kind: RunOriginKind, ref: string): SQL {
  const key = RUN_ORIGIN_METADATA_KEY;
  return sql`(${columns.origin} = ${kind} AND (${likeAny(text(columns.metadata), [
    `%"${key}":{"kind":"${kind}","ref":"${ref}"}%`,
    `%"${key}": {"ref": "${ref}", "kind": "${kind}"}%`,
  ])}))`;
}

/** SQL predicate: the run's stored origin (`runOrigin`) is one of `kinds`. */
export function runOriginIn(origin: SQLWrapper, kinds: readonly RunOriginKind[]): SQL {
  if (kinds.length === 0) return sql`1 = 0`;
  return sql`${origin} IN (${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

/** SQL predicate: the run is flagged as an environment incident (`isIncidentRun`). */
export function incidentRunSql(metadata: SQLWrapper): SQL {
  return hasKey(text(metadata), INCIDENT_RUN_METADATA_KEY, '{');
}

/** SQL predicate: the run is interactive (`isInteractiveRun`). */
function interactiveRunSql(metadata: SQLWrapper): SQL {
  return hasKey(text(metadata), RUN_INTERACTIVE_METADATA_KEY, '{');
}

/** The run columns `eligibleRunSql` reads; `test_runs`' own by default. */
export interface EligibleRunColumns {
  origin: SQLWrapper;
  metadata: SQLWrapper;
  isFullRun: SQLWrapper;
  status: SQLWrapper;
}

const TEST_RUN_COLUMNS: EligibleRunColumns = {
  origin: testRuns.origin,
  metadata: testRuns.metadata,
  isFullRun: testRuns.isFullRun,
  status: testRuns.status,
};

/** SQL predicate: the run covered the whole suite and finished (`isCompleteRun`). */
export function completeRunSql(columns: EligibleRunColumns = TEST_RUN_COLUMNS): SQL {
  const unfinished = sql.join(
    UNFINISHED_RUN_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`(${columns.isFullRun} = 1 AND ${columns.status} NOT IN (${unfinished}))`;
}

/** SQL predicate keeping only runs that may feed `use`: the SQL form of `isEligibleRun`. */
export function eligibleRunSql(use: RunUse, columns: EligibleRunColumns = TEST_RUN_COLUMNS): SQL {
  const rule = RUN_USES[use];
  const parts = [sql`NOT ${runOriginIn(columns.origin, rule.excludes)}`];
  if (rule.excludesIncidents) parts.push(sql`NOT ${incidentRunSql(columns.metadata)}`);
  if (rule.completeOnly) parts.push(completeRunSql(columns));
  const completeOnlyFor = rule.completeOnlyFor ?? [];
  if (completeOnlyFor.length) {
    parts.push(sql`NOT (${runOriginIn(columns.origin, completeOnlyFor)} AND NOT ${completeRunSql(columns)})`);
  }
  if (rule.excludesInteractive) parts.push(sql`NOT ${interactiveRunSql(columns.metadata)}`);
  return sql`(${sql.join(parts, sql` AND `)})`;
}

/**
 * SQL predicate on an execution's run id keeping only executions of runs that
 * may feed `use`, for queries over `test_runs_cases` that do not join
 * `test_runs` (a left join from test cases, a correlated subquery).
 */
export function eligibleExecutionSql(use: RunUse, testRunId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.id} = ${testRunId} AND ${eligibleRunSql(use)})`;
}

/**
 * `eligibleExecutionSql` for a query over executions of one project's runs,
 * those `within` selects when given (a range of run ids): the runs among them
 * that may not feed `use` are listed once for the query, and an execution is
 * kept unless its run is on that list, so each run's metadata is read once and
 * not once per execution. Every execution the query reads must be of one of
 * those runs; every execution of a project's test case is of one of the
 * project's runs.
 */
export function eligibleExecutionInProject(use: RunUse, projectId: number, testRunId: SQLWrapper, within?: SQL): SQL {
  const listed = and(eq(testRuns.projectId, projectId), within, sql`${eligibleRunSql(use)} IS NOT TRUE`);
  return sql`${testRunId} NOT IN (SELECT ${testRuns.id} FROM ${testRuns} WHERE ${listed})`;
}

/** SQL predicate keeping only runs that are not lab runs: the SQL form of `!isLabRun(metadata)`. `origin` is the run's stored origin. */
export function notLabRun(origin: SQLWrapper): SQL {
  return sql`NOT ${runOriginIn(origin, LAB_RUN_ORIGINS)}`;
}

/** `notLabRun` on an execution's run id, for queries over `test_runs_cases` that do not join `test_runs`. */
export function notLabExecution(testRunId: SQLWrapper): SQL {
  return sql`EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.id} = ${testRunId} AND ${notLabRun(testRuns.origin)})`;
}

/**
 * `notLabExecution` for a query over one project's executions: the project's
 * runs that are not lab runs are listed once for the query, and each execution
 * is matched against that list.
 */
export function notLabExecutionInProject(projectId: number, testRunId: SQLWrapper): SQL {
  return sql`${testRunId} IN (SELECT ${testRuns.id} FROM ${testRuns} WHERE ${testRuns.projectId} = ${projectId} AND ${notLabRun(testRuns.origin)})`;
}
