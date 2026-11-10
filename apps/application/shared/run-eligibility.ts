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
 * and for a finished run's outbound effects (its notifications, pull-request
 * comment and commit status, AI diagnosis and auto-heal): a run from an editor
 * never sends them, and a run from a developer's machine or the desktop app
 * sends them only when it ran the whole suite. A finished run's analysis (fix
 * verification, change coverage, the hand-back outcomes) does not follow that
 * rule: each step reads the run under its own use. A run from an editor does
 * not make a failure cluster recur either (`cluster-occurrences`). No run
 * started on a developer's machine (a local run, `piwi preflight --run`,
 * `piwi bug --write`) sends `test.stuck`, complete or not
 * (`stuck-notifications`).
 */

import { and, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { FLAKE_LAB_RUN_METADATA_KEY } from '@piwitests/core/flake-plan';
import {
  parseRunOrigin,
  parseRunOriginRef,
  RUN_ORIGIN_KINDS,
  RUN_ORIGIN_METADATA_KEY,
  RUN_REF_METADATA_KEY,
  type RunOrigin,
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

/**
 * The origins of private runs: a run a person asked for on their own machine, seen by them alone, on a branch and a
 * machine the team did not choose. No use reads them.
 */
export const PRIVATE_RUN_ORIGINS = ['request'] as const satisfies readonly RunOriginKind[];

const LAB_AND_INVESTIGATION: readonly RunOriginKind[] = [...LAB_RUN_ORIGINS, ...INVESTIGATION_RUN_ORIGINS];

/** The origins no use reads: lab runs, runs at a commit chosen to investigate a failure, and private runs. */
const NO_TEAM_USE: readonly RunOriginKind[] = [...LAB_AND_INVESTIGATION, ...PRIVATE_RUN_ORIGINS];

/**
 * The origins of the runs set aside from everything that reads the suite as a whole (`isLabRun`, `notLabRun`): lab
 * runs, whose failures are injected, and private runs. Neither forms failure clusters.
 */
const SET_ASIDE_RUN_ORIGINS: readonly RunOriginKind[] = [...LAB_RUN_ORIGINS, ...PRIVATE_RUN_ORIGINS];

/**
 * The origins of runs started on a developer's machine: their own runs (`LOCAL_RUN_ORIGINS`), `piwi preflight --run`
 * and `piwi bug --write`.
 */
const DEVELOPER_MACHINE_RUN_ORIGINS: readonly RunOriginKind[] = [...LOCAL_RUN_ORIGINS, 'preflight', 'bug'];

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
  | 'stuck-notifications'
  | 'tracker'
  | 'cluster-occurrences'
  | 'run-health'
  | 'pass-reuse';

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
 */
export const RUN_USES: Record<RunUse, RunUseRule> = {
  /** Execution baselines: the environment, visual and page diffs, the AI's baseline comparison, the last pass. */
  baseline: {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Run baselines: a run compared with a whole earlier run. */
  'run-baseline': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: true,
    excludesHistoricalImports: false,
  },
  'fix-verification': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  flakiness: {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Pass rates, last statuses, recent failures and durations behind selections and their suggestions. */
  'selection-catalog': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** What the editor shows as the branch's CI failures. */
  'branch-failures': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: true,
    excludesHistoricalImports: false,
  },
  /** The runs the editor overlays on the branch's latest complete run. */
  'editor-overlay': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Change coverage and every "not reached in the last N runs" analysis. */
  'change-coverage': {
    excludes: NO_TEAM_USE,
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
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** Locator snapshots, the locator index, test metadata and green samples. */
  'shared-state': {
    excludes: NO_TEAM_USE,
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: true,
  },
  'auto-heal': {
    excludes: NO_TEAM_USE,
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  'bug-lifecycle': {
    excludes: ['bug', ...NO_TEAM_USE],
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
    excludes: [...NO_TEAM_USE, 'editor'],
    excludesIncidents: true,
    completeOnly: false,
    completeOnlyFor: ['local', 'desktop'],
    excludesHistoricalImports: false,
  },
  /**
   * The `test.stuck` notification of a live run's running attempt: the runs of `notifications` but those started on a
   * developer's machine. The run page's **Stuck?** mark reads no use.
   */
  'stuck-notifications': {
    excludes: [...NO_TEAM_USE, ...DEVELOPER_MACHINE_RUN_ORIGINS],
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /**
   * The writes Piwi makes to an issue tracker on its own: automatic creation,
   * and the comments, transitions and description updates a run's verdicts
   * trigger. The rule of `notifications`.
   */
  tracker: {
    excludes: [...NO_TEAM_USE, 'editor'],
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
    excludes: [...NO_TEAM_USE, 'editor'],
    excludesIncidents: false,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /**
   * The results pass reuse reads: the passes that may stand in for a later result, and the results its forecast
   * counts. A `piwi bug` run replays a reported bug, not the suite.
   */
  'pass-reuse': {
    excludes: [...NO_TEAM_USE, 'bug'],
    excludesIncidents: true,
    completeOnly: false,
    excludesHistoricalImports: false,
  },
  /** The runs the incident classifier judges, and the runs of other projects it compares them with. */
  'run-health': {
    excludes: [...LAB_RUN_ORIGINS, ...PRIVATE_RUN_ORIGINS],
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

/** Metadata stamped as a requested run's: origin `request`, with the request's id as its ref. */
export function withRequestOrigin(
  metadata: Record<string, unknown> | null,
  requestId: string,
): Record<string, unknown> {
  return requestStamped(metadata, { kind: 'request', ref: requestId });
}

/** `metadata` with a requested run's origin, and without the lab stamps that would name it a lab run. */
function requestStamped(metadata: Record<string, unknown> | null, origin: RunOrigin): Record<string, unknown> {
  const { [PROBE_RUN_METADATA_KEY]: _probe, [FLAKE_LAB_RUN_METADATA_KEY]: _lab, ...rest } = metadata ?? {};
  return { ...rest, [RUN_ORIGIN_METADATA_KEY]: origin };
}

/**
 * Metadata replacing a run's stored metadata, with a requested run's origin carried over. The reporter never sends
 * `request` (`sanitizeMetadata` drops it), and every write of the reporter's metadata over a stored run passes
 * through this.
 */
export function carryRequestOrigin(
  next: Record<string, unknown> | null,
  stored: unknown,
): Record<string, unknown> | null {
  const origin = record(stored)?.[RUN_ORIGIN_METADATA_KEY];
  const parsed = parseRunOrigin(origin);
  if (parsed?.kind !== 'request') return next;
  return requestStamped(next, parsed);
}

/** What launched a run, read from its metadata. */
export function runOrigin(metadata: unknown): RunOriginRead {
  const meta = record(metadata);
  // The server's `request` stamp wins over every key the reporter writes.
  if (parseRunOrigin(meta?.[RUN_ORIGIN_METADATA_KEY])?.kind === 'request') return 'request';
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
 * True for a lab run, one that replays tests under conditions Piwi injected (a
 * probe run or a flake-lab run), and for a private run (`PRIVATE_RUN_ORIGINS`).
 * Neither counts as a real run: no use reads it and it forms no clusters.
 */
export function isLabRun(metadata: unknown): boolean {
  return (SET_ASIDE_RUN_ORIGINS as readonly string[]).includes(runOrigin(metadata));
}

/**
 * True for the origin of a lab run or of a run at a commit chosen to investigate a failure: a Flake Lab or probe run,
 * a bisect step, a reproduction. Such a run is a step of a job whose verdict says what its failures mean: no use
 * reading the suite as it behaves today reads it, and it sends no notification (`RUN_USES`).
 */
export function isLabOrInvestigationOrigin(origin: string): boolean {
  return (LAB_AND_INVESTIGATION as readonly string[]).includes(origin);
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
  return true;
}

// ── The same rule in SQL ─────────────────────────────────────────────────────
//
// A run's origin is stored in `test_runs.origin`: every write of a run's
// metadata writes `runOrigin` of that metadata beside it, so the SQL form reads
// one column. The incident flag and an origin's ref are read from the metadata
// itself. Metadata is JSON text on SQLite and `jsonb` on PostgreSQL, and the
// demo's database is SQLite in the browser, so those keys are matched in the
// serialized text, in both spellings: SQLite keeps the text as written
// (`"k":v`), and `jsonb` puts a space after each colon and comma and sorts an
// object's keys shortest first (`{"ref": "…", "kind": "…"}`). The server writes
// the origin as `{ kind, ref? }`, kind first, and its ref holds no quote.

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

/** The columns of a run its visibility reads. */
export interface RunVisibilityFields {
  origin: string | null;
  requesterId: number | null;
}

/** Whether a run of `origin` is private: its requester's alone. */
export function isPrivateRunOrigin(origin: string | null | undefined): boolean {
  return (PRIVATE_RUN_ORIGINS as readonly (string | null | undefined)[]).includes(origin);
}

/**
 * Whether a person sees a run: every run but a private one (`PRIVATE_RUN_ORIGINS`), which its requester alone sees.
 * A private run whose requester is gone, or read with no person (sign-in off), is seen by nobody.
 */
export function isVisibleRun(run: RunVisibilityFields, viewerId: number | null): boolean {
  if (!isPrivateRunOrigin(run.origin)) return true;
  return viewerId != null && run.requesterId === viewerId;
}

/** SQL predicate: the run is not a private run, for the lists every member of a project reads. */
export function notPrivateRun(origin: SQLWrapper = testRuns.origin): SQL {
  return sql`NOT ${runOriginIn(origin, PRIVATE_RUN_ORIGINS)}`;
}

/**
 * SQL predicate: the run is set aside from team use (`notLabRun`), except the viewer's own private runs, for a list
 * that shows them to their requester.
 */
export function notLabRunOrOwn(viewerId: number | null, origin: SQLWrapper = testRuns.origin): SQL {
  if (viewerId === null) return notLabRun(origin);
  return or(
    notLabRun(origin),
    and(runOriginIn(origin, PRIVATE_RUN_ORIGINS), eq(testRuns.requesterId, viewerId)),
  ) as SQL;
}

/** `notPrivateRun` on an execution's run id, for queries over `test_runs_cases` that do not join `test_runs`. */
export function notPrivateExecution(testRunId: SQLWrapper): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM ${testRuns} WHERE ${testRuns.id} = ${testRunId} AND ${runOriginIn(testRuns.origin, PRIVATE_RUN_ORIGINS)})`;
}

/** SQL predicate: the run is flagged as an environment incident (`isIncidentRun`). */
export function incidentRunSql(metadata: SQLWrapper): SQL {
  return hasKey(text(metadata), INCIDENT_RUN_METADATA_KEY, '{');
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

/**
 * SQL predicate keeping only runs that are neither lab runs nor private runs: the SQL form of `!isLabRun(metadata)`.
 * `origin` is the run's stored origin.
 */
export function notLabRun(origin: SQLWrapper): SQL {
  return sql`NOT ${runOriginIn(origin, SET_ASIDE_RUN_ORIGINS)}`;
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
