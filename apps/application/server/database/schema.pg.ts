import {
  pgTable,
  text,
  integer,
  bigint,
  serial,
  timestamp,
  jsonb,
  doublePrecision,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
  customType,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Boolean stored in an integer column (0/1). Mirrors the SQLite dialect's
 * `integer(..., { mode: 'boolean' })` columns, so application code reads and
 * writes plain booleans on both dialects while the column type stays integer
 * (no data migration for existing databases).
 *
 * `.default()` on these columns must be the driver value (`0`/`1`, cast to
 * boolean) — drizzle-kit serializes defaults into DDL without running
 * `toDriver`, and a literal `true`/`false` default is invalid SQL for an
 * integer column.
 */
const intBoolean = customType<{ data: boolean; driverData: number }>({
  dataType() {
    return 'integer';
  },
  toDriver(value) {
    return value ? 1 : 0;
  },
  fromDriver(value) {
    return Number(value) !== 0;
  },
});

const INT_BOOLEAN_FALSE = 0 as unknown as boolean;
const INT_BOOLEAN_TRUE = 1 as unknown as boolean;

// Projects table
export const projects = pgTable(
  'projects',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    label: text('label'), // Display label (defaults to name if not set)
    description: text('description'),
    diagnosisInstructions: text('diagnosis_instructions'),
    aiLanguage: text('ai_language'), // per-project AI response language override (e.g. "French")
    scmToken: text('scm_token'), // Per-project SCM token for GitHub/GitLab/Bitbucket API access
    repositoryUrl: text('repository_url'), // The repository every SCM call of the project reads (normalized https URL); pinned by the first run that names one, changed by a project admin
    defaultBranch: text('default_branch'), // Repository default branch; null = resolve from SCM provider, else 'main'
    openApiUrl: text('openapi_url'), // Declared-surface OpenAPI document URL; fetched server-side into graph route nodes with origin 'openapi'
    serverProbes: jsonb('server_probes'), // ServerProbeSettings — the level-two probe gate (enabled, allow-listed faults/routes); off by default
    routeOrigins: jsonb('route_origins'), // string[] — extra own origins whose requests become graph route nodes, beyond the run's Playwright baseURL
    ciRerun: jsonb('ci_rerun'), // CiRerunSettings — provider-specific "re-run from the dashboard" target (off by default)
    capabilities: jsonb('capabilities'), // Partial<Record<CapabilityId, 'declined' | 'enabled'>> — per-project capability decisions
    generatedSpecs: jsonb('generated_specs'), // GeneratedSpecSettings — test import and bugs folder for specs rendered from steps
    targets: jsonb('targets'), // ProjectTargets — per-project goals on catalog metrics (shared/analytics/targets.ts)
    coverageScope: jsonb('coverage_scope'), // CoverageScope — include and exclude patterns of the files coverage totals count; null = the default excludes
    coverageScopeVersion: integer('coverage_scope_version').notNull().default(0), // Bumped on every change of coverage_scope, so totals computed under another scope read as stale
    coverageAreas: jsonb('coverage_areas'), // CoverageArea[] — named areas of the code (`front`, `back`) by include patterns, each counted apart; null = none
    locatorIndexBuiltAt: timestamp('locator_index_built_at', { mode: 'date' }),
    quarantineFailsStatus: boolean('quarantine_fails_status').notNull().default(false), // true = a quarantined failure turns the run's commit status red; false = the status ignores quarantined failures
    gateStatus: boolean('gate_status').notNull().default(false), // true = each gate evaluation also posts the `<statusContext>/gate` commit status; off by default
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    updatedAtIdx: index('idx_projects_updated_at').on(table.updatedAt),
  }),
);

// Test runs table
export const testRuns = pgTable(
  'test_runs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // 'passed', 'failed', 'timedout', 'interrupted', 'running', 'cancelled', 'initializing', 'finalizing'
    startTime: timestamp('start_time', { mode: 'date' }).notNull(),
    duration: integer('duration'), // in milliseconds
    totalTests: integer('total_tests').notNull().default(0),
    passedTests: integer('passed_tests').notNull().default(0),
    failedTests: integer('failed_tests').notNull().default(0),
    skippedTests: integer('skipped_tests').notNull().default(0),
    didNotRunTests: integer('did_not_run_tests').notNull().default(0), // Tests that never executed (maxFailures cutoff or serial-group failure)
    flakyTests: integer('flaky_tests').notNull().default(0),
    avgTestDuration: integer('avg_test_duration'), // average test case duration in ms
    p90TestDuration: integer('p90_test_duration'), // 90th percentile test duration in ms
    shardTotal: integer('shard_total'), // Total number of shards for sharded runs; null = not sharded
    shardIndex: integer('shard_index'), // Reporting shard index (1-based) of the shard that created this run; null = not sharded
    shardsFinished: integer('shards_finished').notNull().default(0), // How many shards have finished
    isFullRun: integer('is_full_run').notNull().default(1), // 1 = full suite, 0 = partial/filtered (--grep, file filter, etc.)
    filterDetails: jsonb('filter_details'), // JSON: { grep?, grepInvert? }

    environment: text('environment'), // Deployment environment (e.g. 'production', 'staging', 'development')
    branch: text('branch'), // Scalar SCM branch (logical branch, never 'HEAD') for index efficiency; projects metadata.scm.branch
    metadata: jsonb('metadata'), // Additional metadata as JSON
    origin: text('origin').notNull().default('local'), // What launched the run, `runOrigin(metadata)`, written with every metadata write; read by the eligibility rule
    commit: text('commit_sha'), // The run's commit, `runCommit(metadata)` (metadata.scm.commit), written with every metadata write; null when the run names none
    setupSteps: jsonb('setup_steps'), // Array of suite-level hook/fixture steps (beforeAll/afterAll) for the timeline
    label: text('label'), // Optional human-readable label (e.g. "v2.3.1 release")
    streamToken: text('stream_token'), // Token for authenticating streaming updates
    instanceId: text('instance_id'), // Unique identifier for the reporter instance that created this run
    playwrightVersion: text('playwright_version'), // Playwright framework version used for this run
    reporterVersion: text('reporter_version'), // Piwi reporter package version that produced this run
    importHash: text('import_hash'), // SHA-256 of the imported archive; null for reported runs. Makes re-importing a no-op.
    keptAt: timestamp('kept_at', { mode: 'date' }), // Set = kept forever: retention never deletes the run
    keptBy: integer('kept_by').references(() => users.id, { onDelete: 'set null' }), // User who kept the run; null for reporter/marker keeps or with auth off
    keepSource: text('keep_source'), // 'user' | 'reporter' | 'marker' — who asked for the keep; null when not kept
    keepReason: text('keep_reason'), // Optional free-text reason shown next to the keep
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' }).$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdIdx: index('idx_test_runs_project_id').on(table.projectId),
    projectStartTimeIdx: index('idx_test_runs_project_start').on(table.projectId, table.startTime),
    projectBranchStartIdx: index('idx_test_runs_project_branch_start').on(
      table.projectId,
      table.branch,
      table.startTime,
    ),
    startTimeIdx: index('idx_test_runs_start_time').on(table.startTime),
    statusIdx: index('idx_test_runs_status').on(table.status),
    importHashIdx: uniqueIndex('idx_test_runs_import_hash').on(table.projectId, table.importHash),
    projectKeptIdx: index('idx_test_runs_project_kept').on(table.projectId, table.keptAt),
    keptByIdx: index('idx_test_runs_kept_by').on(table.keptBy),
    projectCommitIdx: index('idx_test_runs_project_commit').on(table.projectId, table.commit),
  }),
);

// Test suites table - deduplicated describe block definitions, one row per unique path
export const testSuites = pgTable(
  'test_suites',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    suitePath: text('suite_path').notNull(), // \x1f-delimited full path, e.g. 'Auth\x1fLogin'
    mode: text('mode').notNull().default('default'), // 'parallel' | 'serial' | 'default'
    annotations: jsonb('annotations'), // Array<{ type, description? }>
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueIdx: uniqueIndex('idx_test_suites_unique').on(table.projectId, table.filePath, table.suitePath),
  }),
);

// Test cases table - shared test definitions
export const testCases = pgTable(
  'test_cases',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(), // relative path from project root
    suitePath: text('suite_path').notNull().default(''), // \x1f-delimited describe block path, e.g. 'Auth\x1fLogin'
    suiteId: integer('suite_id').references(() => testSuites.id), // FK to immediate parent describe block (null for root-level tests)
    title: text('title').notNull(),
    flakyRootCause: text('flaky_root_cause'), // 'timing' | 'network' | 'assertion' | 'environment' | 'order' | 'other'
    // Latest-known test-level tags and `piwi:` metadata, refreshed on every run
    // that reports this test. Per-execution truth lives on test_runs_cases;
    // these denormalized columns let project-wide views filter without a join.
    tags: jsonb('tags'), // string[] — normalized, '@' stripped
    locks: jsonb('locks'), // string[] — lock names this test most recently declared (best effort)
    owner: text('owner'),
    priority: text('priority'), // 'critical' | 'high' | 'medium' | 'low'
    feature: text('feature'),
    link: text('link'), // absolute http(s) URL
    bugReportId: integer('bug_report_id'), // the bug report this test reproduces (`piwi:bug`), once that report exists
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdIdx: index('idx_test_cases_project_id').on(table.projectId),
    filePathTitleIdx: index('idx_test_cases_file_path_title').on(
      table.projectId,
      table.filePath,
      table.suitePath,
      table.title,
    ),
    suiteIdIdx: index('idx_test_cases_suite').on(table.suiteId),
    ownerIdx: index('idx_test_cases_owner').on(table.projectId, table.owner),
  }),
);

// Quarantined tests — a test that still runs but no longer blocks a merge.
//
// Skipping a flaky test hides it: it stops running, so nothing ever proves it
// is fixed and the quarantine becomes permanent. Here a quarantined test keeps
// executing and keeps reporting; it is only excluded from the CI gate's
// verdict. That makes the exit ramp possible — consecutive passes are counted,
// and a release is proposed once the test has earned it.
export const quarantinedTests = pgTable(
  'quarantined_tests',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    source: text('source').notNull().default('manual'), // 'manual' | 'proposed'
    /** Run id at quarantine time — passes are counted from after this run. */
    quarantinedAtRunId: integer('quarantined_at_run_id'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Null while active; set when the test is let back out. */
    releasedAt: timestamp('released_at', { mode: 'date' }),
    releasedReason: text('released_reason'),
  },
  (table) => ({
    projectIdx: index('idx_quarantined_tests_project').on(table.projectId, table.releasedAt),
    createdByIdx: index('idx_quarantined_tests_created_by').on(table.createdBy),
    // One active quarantine per test; released rows stay as history.
    activeUnique: uniqueIndex('idx_quarantined_tests_active')
      .on(table.testCaseId)
      .where(sql`released_at IS NULL`),
  }),
);

// Failure clusters table - failed run cases grouped by normalized error fingerprint
export const failureClusters = pgTable(
  'failure_clusters',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(), // SHA-256 over FINGERPRINT_VERSION + normalized error signals (shared/error-fingerprint.ts)
    signature: text('signature').notNull(), // normalized first error line — human-readable cluster name
    errorType: text('error_type'), // 'timeout', 'assertion', 'strict-mode', 'navigation', 'crash', 'unknown'
    selector: text('selector'), // locator extracted from the error, if any
    sampleError: text('sample_error'), // one raw error kept for display; refreshed to a better exemplar as the cluster recurs
    fingerprintSample: text('fingerprint_sample'), // immutable raw error captured at creation; re-fingerprinting on a version bump reads this so a display-sample refresh can't move the fingerprint source (null on rows created before this column — recluster falls back to sample_error)
    // Run ids are intentionally NOT foreign keys: runs are deleted independently
    // and clusters must survive them (stale ids are tolerated)
    firstSeenRunId: integer('first_seen_run_id').notNull(),
    lastSeenRunId: integer('last_seen_run_id').notNull(),
    status: text('status').notNull().default('open'), // 'open', 'resolved', 'ignored' — triage workflow
    triageNote: text('triage_note'), // Optional comment attached when triaging (status change)
    manualBaseCommit: text('manual_base_commit'), // user-pinned baseline commit SHA for AI diagnosis diff context
    occurrences: integer('occurrences').notNull().default(0), // denormalized count of linked test_runs_cases rows (not decremented on run deletion)
    title: text('title'), // short human-readable cluster name generated by a cheap model; falls back to `signature`
    embedding: text('embedding'), // JSON-encoded number[] — semantic centroid for near-duplicate clustering
    embeddingModel: text('embedding_model'), // `<model>#v<N>` tag (model id + embed-input recipe version) that produced `embedding`; vectors are only compared within one tag, stale ones are re-embedded by the reconciler's backfill
    // Fix verification — set when a later run stops failing this cluster, so
    // "did my fix work?" is answered rather than merely asked.
    fixLandedRunId: integer('fix_landed_run_id'), // the run in which every affected test passed again
    fixLandedAt: timestamp('fix_landed_at', { mode: 'date' }),
    fixCommit: text('fix_commit'), // commit of that run, when the reporter recorded one
    timeToResolutionMs: integer('time_to_resolution_ms'), // first seen → fix landed
    fixVerification: text('fix_verification'), // 'stopped-failing' | 'diagnosis-verified' | 'regressed'
    flakeEvidenceRunId: integer('flake_evidence_run_id'), // latest run in which every affected test passed at the commit the cluster last failed at: flake evidence, not a fix
    lastRerunDispatch: jsonb('last_rerun_dispatch'), // ClusterRerunDispatch — most recent "Re-run in CI" dispatch
    bisectResult: jsonb('bisect_result'), // BisectedCommit — first bad commit the desktop bisect found (sha, subject, author, date)
    // Inbox triage — orthogonal to `status`. A snooze hides a cluster from every
    // inbox queue until the deadline passes (or, in "until-recurs" mode, until a
    // new run adds an occurrence); `assignee` is the person a triager assigned it
    // to, taking precedence over the owner derived from the test's annotation.
    snoozedUntil: timestamp('snoozed_until', { mode: 'date' }), // hidden from queues until this instant; null when not snoozed
    snoozeMode: text('snooze_mode'), // 'until' (wake at snoozedUntil) | 'until-recurs' (wake at snoozedUntil OR a new occurrence)
    assignee: text('assignee'), // person this cluster is assigned to (name or email); overrides the derived owner
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectFingerprintIdx: uniqueIndex('idx_failure_clusters_project_fingerprint').on(
      table.projectId,
      table.fingerprint,
    ),
    projectLastSeenIdx: index('idx_failure_clusters_project_last_seen').on(table.projectId, table.lastSeenRunId),
    projectStatusIdx: index('idx_failure_clusters_project_status').on(table.projectId, table.status),
  }),
);

// Fingerprint → surviving cluster routing (see schema.sqlite.ts for rationale).
export const failureClusterAliases = pgTable(
  'failure_cluster_aliases',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    clusterId: integer('cluster_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectFingerprintIdx: uniqueIndex('idx_failure_cluster_aliases_project_fingerprint').on(
      table.projectId,
      table.fingerprint,
    ),
    clusterIdx: index('idx_failure_cluster_aliases_cluster').on(table.clusterId),
  }),
);

// Per-test routing out of a cluster (see schema.sqlite.ts).
export const failureClusterTestRoutes = pgTable(
  'failure_cluster_test_routes',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    clusterId: integer('cluster_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectFingerprintTestIdx: uniqueIndex('idx_failure_cluster_test_routes_project_fingerprint_test').on(
      table.projectId,
      table.fingerprint,
      table.testCaseId,
    ),
    clusterIdx: index('idx_failure_cluster_test_routes_cluster').on(table.clusterId),
    testCaseIdx: index('idx_failure_cluster_test_routes_test_case').on(table.testCaseId),
  }),
);

// Proposed cluster merges awaiting human review (see schema.sqlite.ts).
export const clusterMergeSuggestions = pgTable(
  'cluster_merge_suggestions',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    clusterAId: integer('cluster_a_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    clusterBId: integer('cluster_b_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    score: doublePrecision('score'),
    method: text('method').notNull(),
    llmConfidence: text('llm_confidence'),
    llmReason: text('llm_reason'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pairIdx: uniqueIndex('idx_cluster_merge_suggestions_pair').on(table.clusterAId, table.clusterBId),
    projectStatusIdx: index('idx_cluster_merge_suggestions_project_status').on(table.projectId, table.status),
    clusterBIdx: index('idx_cluster_merge_suggestions_cluster_b').on(table.clusterBId),
  }),
);

// AI failure diagnoses - scope-aware diagnosis results
export const failureDiagnoses = pgTable(
  'failure_diagnoses',
  {
    id: serial('id').primaryKey(),
    // Nullable: execution-scoped diagnoses key on `testRunsCaseId` and carry no cluster
    // (a failure may have no cluster, and it keeps the (cluster_id, scope) unique index
    // from colliding across executions of the same cluster).
    clusterId: integer('cluster_id').references(() => failureClusters.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('cluster'), // 'cluster', 'execution'
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    contextSha: text('context_sha'), // hash of the context sent, for staleness detection
    status: text('status').notNull().default('running'), // 'running', 'completed', 'failed'
    provider: text('provider'), // 'anthropic', 'openai'
    model: text('model'), // model id that produced the diagnosis
    category: text('category'), // 'app-bug', 'test-bug', 'flaky-test', 'infrastructure', 'environment', 'unknown'
    confidence: text('confidence'), // 'high', 'medium', 'low'
    summary: text('summary'), // one-line diagnosis shown in lists
    rootCause: text('root_cause'), // short root-cause explanation
    details: jsonb('details'), // full structured result: evidence, suggestedFix, preventionTips
    error: text('error'), // failure reason when status = 'failed'
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    feedback: text('feedback'), // 'up', 'down'
    feedbackNote: text('feedback_note'), // optional note from user
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    clusterScopeIdx: uniqueIndex('idx_failure_diagnoses_cluster_scope').on(table.clusterId, table.scope),
    executionIdx: uniqueIndex('idx_failure_diagnoses_execution').on(table.testRunsCaseId, table.scope),
  }),
);

// Diagnosis version history — snapshotted on each re-diagnose
export const failureDiagnosisVersions = pgTable(
  'failure_diagnosis_versions',
  {
    id: serial('id').primaryKey(),
    diagnosisId: integer('diagnosis_id')
      .notNull()
      .references(() => failureDiagnoses.id, { onDelete: 'cascade' }),
    // Nullable to match `failureDiagnoses.clusterId` (execution-scoped snapshots have no cluster).
    clusterId: integer('cluster_id').references(() => failureClusters.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull().default('cluster'),
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    provider: text('provider'),
    model: text('model'),
    category: text('category'),
    confidence: text('confidence'),
    summary: text('summary'),
    rootCause: text('root_cause'),
    details: jsonb('details'),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    contextSha: text('context_sha'),
    feedback: text('feedback'), // 'up', 'down' — captured as of the snapshot
    feedbackNote: text('feedback_note'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    diagnosisIdIdx: index('idx_fdv_diagnosis_id').on(table.diagnosisId),
    clusterIdIdx: index('idx_fdv_cluster_id').on(table.clusterId),
    testRunsCaseIdx: index('idx_fdv_test_runs_case').on(table.testRunsCaseId),
  }),
);

// Application settings - key/value store for runtime-configurable settings (e.g. AI provider)
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Content-addressed storage for large per-execution text payloads (ARIA
// snapshots, test source snippets, source-frame JSON). One row per unique
// content per project — test_runs_cases rows reference payloads by id, so a
// test failing identically across many runs stores each payload once.
export const casePayloads = pgTable(
  'case_payloads',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(), // SHA-256 hex of content
    content: text('content').notNull(),
    size: integer('size').notNull(), // content length in characters, for storage stats
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectHashIdx: uniqueIndex('idx_case_payloads_project_hash').on(table.projectId, table.hash),
  }),
);

// Test runs cases table - junction table with run-specific data
export const testRunsCases = pgTable(
  'test_runs_cases',
  {
    id: serial('id').primaryKey(),
    testRunId: integer('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // 'passed', 'failed', 'timedout', 'skipped', 'didnotrun' — canonical lowercase; a stored row may carry 'timedOut'
    duration: integer('duration'), // in milliseconds
    timeout: integer('timeout'), // Effective per-test timeout in ms (TestCase.timeout); 0 = unbounded, null = unknown/legacy
    error: text('error'),
    failureClusterId: integer('failure_cluster_id').references(() => failureClusters.id), // set for failed rows with an error — groups rows sharing a fingerprint
    retries: integer('retries').default(0),
    attempts: jsonb('attempts'), // Array of { retry, status, duration, startedAt } — per-attempt outcomes
    line: integer('line'), // line number in file
    column: integer('column'), // column number in file
    steps: jsonb('steps'), // Array of { title, duration, category, location?, startTime? } step objects
    stepEvents: jsonb('step_events'), // Array of { title, category, startedAt, duration, status, location } — hook/fixture steps for timeline
    slowestStep: text('slowest_step'), // Title of the slowest step
    slowestStepDuration: integer('slowest_step_duration'), // Duration of the slowest step in ms
    wastedTimeMs: integer('wasted_time_ms'), // Aggregated ms spent in wait steps
    webVitals: jsonb('web_vitals'), // { navigation: {...}, paint: {...} }
    resources: jsonb('resources'), // WireExecutionResources — what the execution cost its worker and browsers
    pageState: jsonb('page_state'), // URL/history/storage-keys/cookie-flags at test end (values never captured)
    aiUsage: jsonb('ai_usage'), // { entries: string[], intents?: {template,locator,kind}[] } — replayed AI-step artifacts + their prompts
    consoleLogs: jsonb('console_logs'), // Array of { type, text, timestamp, location } console entries
    dialogs: jsonb('dialogs'), // Array of { type, message, defaultValue, closedAt } browser dialogs
    evidenceSources: jsonb('evidence_sources'), // { console?, network?, aria?: 'trace' } — marks evidence recovered from the trace when the capture fixtures were absent
    // Inline payload columns: read, never written — rows store these payloads
    // content-addressed in case_payloads and reference them via the
    // *PayloadId columns below.
    ariaSnapshot: text('aria_snapshot'), // ARIA snapshot of the page (YAML-like string from locator.ariaSnapshot())
    ariaSnapshotJson: text('aria_snapshot_json'), // ARIA tree as JSON (from locator.ariaSnapshotJSON(), Playwright >= 1.63)
    testSource: text('test_source'), // Source snippet around the failing assertion (sent by reporter)
    testSourceFrames: jsonb('test_source_frames'), // Array<{ file, line, snippet }> — in-project call-stack frames (innermost first)
    ariaSnapshotPayloadId: integer('aria_snapshot_payload_id').references(() => casePayloads.id),
    ariaSnapshotJsonPayloadId: integer('aria_snapshot_json_payload_id').references(() => casePayloads.id),
    testSourcePayloadId: integer('test_source_payload_id').references(() => casePayloads.id),
    testSourceFramesPayloadId: integer('test_source_frames_payload_id').references(() => casePayloads.id),
    pageInventoryPayloadId: integer('page_inventory_payload_id').references(() => casePayloads.id), // Content-addressed page inventory (controls + links per visited page), passing runs
    locatorPagesPayloadId: integer('locator_pages_payload_id').references(() => casePayloads.id), // Content-addressed list of the page each locator call ran on (piwi-locator-pages)
    codeReachPayloadId: integer('code_reach_payload_id').references(() => casePayloads.id), // Content-addressed list of the source files the test executed (piwi-code-reach)
    coveragePayloadId: integer('coverage_payload_id').references(() => casePayloads.id), // Content-addressed list of the coverage fragments the execution recorded (coverage_fragments ids)
    browser: jsonb('browser'), // Playwright project/browser config: { projectName, browserName, channel, viewport }
    browserName: text('browser_name'), // Scalar browser identity (projectName) for index efficiency
    testAnnotations: jsonb('test_annotations'), // Array<{ type, description? }> — runtime test marks (@fixme, @slow …)
    tags: jsonb('tags'), // string[] — tags this execution declared ('@' stripped)
    locks: jsonb('locks'), // string[] — lock names this execution held (best effort; none from blob imports)
    testMeta: jsonb('test_meta'), // { owner?, priority?, feature?, link? } from `piwi:` annotations
    workerIndex: integer('worker_index'), // Parallel worker index (from Playwright's parallelIndex)
    shardIndex: integer('shard_index'), // Shard index (1-based) for sharded runs; null = not sharded
    startedAt: bigint('started_at', { mode: 'number' }), // Unix timestamp in ms when the test started (exceeds 32-bit int range)
    isNewRegression: integer('is_new_regression'), // boolean: passed in baseline, failed in this run
    isNewFlaky: integer('is_new_flaky'), // boolean: no retries in baseline, retry-pass in this run
    didNotRunReason: text('did_not_run_reason'), // Why a 'didnotrun' case never executed: 'previous-failure' | 'global-timeout' | 'max-failures' | 'interrupted'
    expectedStatus: text('expected_status'), // Playwright's expectedStatus: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
    blockedBy: text('blocked_by'), // For a 'previous-failure' cascade, the location (file:line:col) of the failing test that blocked it
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    testRunIdIdx: index('idx_test_runs_cases_test_run_id').on(table.testRunId),
    // Composite: covers plain test_case_id lookups (prefix) and the
    // per-case recency sorts used by history/flakiness queries.
    testCaseCreatedIdx: index('idx_test_runs_cases_case_created').on(table.testCaseId, table.createdAt),
    failureClusterIdIdx: index('idx_test_runs_cases_failure_cluster_id').on(table.failureClusterId),
    runCaseBrowserUnique: uniqueIndex('idx_test_runs_cases_run_browser').on(
      table.testRunId,
      table.testCaseId,
      table.retries,
      table.browserName,
    ),
    // Partial indexes back the payload-GC reachability probes; populated on
    // failures only, so the hot insert path pays almost nothing for them.
    ariaPayloadIdx: index('idx_trc_aria_payload')
      .on(table.ariaSnapshotPayloadId)
      .where(sql`aria_snapshot_payload_id IS NOT NULL`),
    ariaJsonPayloadIdx: index('idx_trc_aria_json_payload')
      .on(table.ariaSnapshotJsonPayloadId)
      .where(sql`aria_snapshot_json_payload_id IS NOT NULL`),
    sourcePayloadIdx: index('idx_trc_source_payload')
      .on(table.testSourcePayloadId)
      .where(sql`test_source_payload_id IS NOT NULL`),
    framesPayloadIdx: index('idx_trc_frames_payload')
      .on(table.testSourceFramesPayloadId)
      .where(sql`test_source_frames_payload_id IS NOT NULL`),
    pageInventoryPayloadIdx: index('idx_trc_page_inventory_payload')
      .on(table.pageInventoryPayloadId)
      .where(sql`page_inventory_payload_id IS NOT NULL`),
    locatorPagesPayloadIdx: index('idx_trc_locator_pages_payload')
      .on(table.locatorPagesPayloadId)
      .where(sql`locator_pages_payload_id IS NOT NULL`),
    codeReachPayloadIdx: index('idx_trc_code_reach_payload')
      .on(table.codeReachPayloadId)
      .where(sql`code_reach_payload_id IS NOT NULL`),
    coveragePayloadIdx: index('idx_trc_coverage_payload')
      .on(table.coveragePayloadId)
      .where(sql`coverage_payload_id IS NOT NULL`),
    // Partial indexes over the few rows the capability probes and the run list
    // look for, so finding one, or proving there is none, never reads every
    // execution. A query uses one only when it repeats the condition with
    // literals (shared/handlers/setup-status.ts, shared/utils/skip-kind.ts).
    passedAriaIdx: index('idx_trc_passed_aria')
      .on(table.testRunId)
      .where(sql`status = 'passed' AND (aria_snapshot_payload_id IS NOT NULL OR aria_snapshot IS NOT NULL)`),
    passedRetryIdx: index('idx_trc_passed_retry')
      .on(table.testRunId)
      .where(sql`status = 'passed' AND retries > 0`),
    skippedIdx: index('idx_trc_skipped')
      .on(table.testRunId)
      .where(sql`status = 'skipped'`),
  }),
);

// Locator snapshots table — one row per locator call site, upserted each run.
export const locatorSnapshots = pgTable(
  'locator_snapshots',
  {
    id: serial('id').primaryKey(),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    location: text('location').notNull(),
    usedMethod: text('used_method').notNull(),
    usedArgs: text('used_args').notNull(),
    usedArgsFp: text('used_args_fp').notNull(),
    elementTag: text('element_tag'),
    elementAttrs: text('element_attrs').notNull(),
    elementText: text('element_text'),
    alternatives: text('alternatives').notNull(),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull(),
  },
  (table) => ({
    uniqueLocation: uniqueIndex('idx_locator_snapshots_location').on(table.testCaseId, table.location),
    fingerprintIdx: index('idx_locator_snapshots_fp').on(table.testCaseId, table.usedMethod, table.usedArgsFp),
    lastSeenRunIdx: index('idx_locator_snapshots_last_seen_run').on(table.lastSeenRunId),
    // Cross-test healing looks a signature up across all of a project's cases.
    argsFpIdx: index('idx_locator_snapshots_args_fp').on(table.usedArgsFp),
  }),
);

// Locator usages — which locator chain each test used, from which call site, for which action.
export const locatorUsages = pgTable(
  'locator_usages',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    locator: text('locator').notNull(),
    target: text('target').notNull(),
    action: text('action').notNull(),
    browserName: text('browser_name').notNull(),
    callSite: text('call_site').notNull(),
    branch: text('branch').notNull().default(''),
    page: text('page').notNull().default(''), // page key the call ran on (`/orders/:id`, or origin + path off the app); '' when unknown
    arrival: boolean('arrival').notNull().default(false), // the call ran on that page before any locator interaction there
    firstSeenRunId: integer('first_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull(),
  },
  (table) => ({
    uniqueUse: uniqueIndex('idx_locator_usages_use').on(
      table.testCaseId,
      table.browserName,
      table.branch,
      table.callSite,
      table.action,
      table.locator,
      table.page,
    ),
    projectLocatorIdx: index('idx_locator_usages_project_locator').on(table.projectId, table.locator),
    projectBranchIdx: index('idx_locator_usages_project_branch').on(table.projectId, table.branch),
    projectTargetIdx: index('idx_locator_usages_project_target').on(table.projectId, table.target),
    lastSeenRunIdx: index('idx_locator_usages_last_seen_run').on(table.lastSeenRunId),
    firstSeenRunIdx: index('idx_locator_usages_first_seen_run').on(table.firstSeenRunId),
  }),
);

// Code reach: the application source files each test executed (see schema.sqlite.ts).
export const codeReach = pgTable(
  'code_reach',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull().default(''),
    runtime: text('runtime').notNull().default('browser'),
    file: text('file').notNull(),
    origin: text('origin').notNull().default('client'),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull(),
  },
  (table) => ({
    uniqueReach: uniqueIndex('idx_code_reach_unique').on(table.testCaseId, table.branch, table.runtime, table.file),
    projectFileIdx: index('idx_code_reach_project_file').on(table.projectId, table.file),
    lastSeenRunIdx: index('idx_code_reach_last_seen_run').on(table.lastSeenRunId),
  }),
);

// Coverage fragments: one file's coverage as one test recorded it (see schema.sqlite.ts).
export const coverageFragments = pgTable(
  'coverage_fragments',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    runtime: text('runtime').notNull(),
    path: text('path').notNull(),
    blob: text('blob'),
    functions: text('functions'),
    lines: text('lines'),
    executable: text('executable'),
    allFunctions: text('all_functions'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectHashIdx: uniqueIndex('idx_coverage_fragments_project_hash').on(table.projectId, table.hash),
    projectPathIdx: index('idx_coverage_fragments_project_path').on(table.projectId, table.path),
  }),
);

// Test coverage: the fragments a test's latest run with coverage recorded on a branch (see schema.sqlite.ts).
export const testCoverage = pgTable(
  'test_coverage',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull().default(''),
    runtime: text('runtime').notNull(),
    fragmentId: integer('fragment_id')
      .notNull()
      .references(() => coverageFragments.id, { onDelete: 'cascade' }),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull(),
  },
  (table) => ({
    uniqueCoverage: uniqueIndex('idx_test_coverage_unique').on(table.testCaseId, table.branch, table.fragmentId),
    fragmentIdx: index('idx_test_coverage_fragment').on(table.fragmentId),
    projectBranchIdx: index('idx_test_coverage_project_branch').on(table.projectId, table.branch),
    lastSeenRunIdx: index('idx_test_coverage_last_seen_run').on(table.lastSeenRunId),
  }),
);

// Run coverage: the coverage of a whole run per file (see schema.sqlite.ts).
export const runCoverage = pgTable(
  'run_coverage',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').notNull(), // the run's project
    runtime: text('runtime').notNull(),
    path: text('path').notNull(),
    blob: text('blob'),
    functions: text('functions'),
    lines: text('lines'),
    executable: text('executable'),
  },
  (table) => ({
    uniqueFile: uniqueIndex('idx_run_coverage_unique').on(table.runId, table.runtime, table.path),
    projectPathIdx: index('idx_run_coverage_project_path').on(table.projectId, table.path),
  }),
);

// Executable lines per file version (see schema.sqlite.ts).
export const coverageExecutable = pgTable(
  'coverage_executable',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runtime: text('runtime').notNull(), // 'browser' | 'server'
    path: text('path').notNull(), // repository-relative path
    blob: text('blob').notNull(), // git blob id of the file version
    lines: text('lines'), // executable line ranges, `12-15,20`
    functions: text('functions'), // every function's range, run or not, `12-15,20`
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueVersion: uniqueIndex('idx_coverage_executable_unique').on(
      table.projectId,
      table.runtime,
      table.path,
      table.blob,
    ),
    projectPathIdx: index('idx_coverage_executable_project_path').on(table.projectId, table.path),
  }),
);

// Coverage reports: one suite's coverage of one commit, imported from another
// tool's report (`piwi coverage upload`) and kept in Piwi's model, attributed to
// no test. Reports of the same commit and suite merge, like shards. The
// commit's file inventory (the tracked files and their blobs) is a
// `case_payloads` row.
export const coverageReports = pgTable(
  'coverage_reports',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commit: text('commit_sha').notNull(), // full commit id, lowercase hex
    branch: text('branch').notNull().default(''), // '' = the project's default branch; else the branch it ran on
    suite: text('suite').notNull(), // the name the team uploads it under, e.g. 'unit-back'
    kind: text('kind').notNull(), // 'unit' | 'e2e'
    tool: text('tool'), // 'cobertura' | 'lcov' | 'piwi', with the writer when the report names it
    incomplete: boolean('incomplete').notNull().default(false), // true when part of the report was left out (a cap, a file version that disagreed)
    fileCount: integer('file_count').notNull().default(0),
    inventoryPayloadId: integer('inventory_payload_id').references(() => casePayloads.id), // The commit's file inventory, `[[path, blob], ...]`
    inventoryCount: integer('inventory_count'), // How many files the inventory names; null without one
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueSuite: uniqueIndex('idx_coverage_reports_unique').on(table.projectId, table.commit, table.suite),
    projectBranchIdx: index('idx_coverage_reports_project_branch').on(table.projectId, table.branch, table.updatedAt),
    inventoryIdx: index('idx_coverage_reports_inventory').on(table.inventoryPayloadId),
  }),
);

// The fragment each file of a coverage report has: the file's version, its
// executable lines, the lines and functions that ran and every function the
// tool knows, shared with every report and commit that recorded the same.
export const coverageReportFiles = pgTable(
  'coverage_report_files',
  {
    id: serial('id').primaryKey(),
    reportId: integer('report_id')
      .notNull()
      .references(() => coverageReports.id, { onDelete: 'cascade' }),
    path: text('path').notNull(), // repository-relative path
    fragmentId: integer('fragment_id')
      .notNull()
      .references(() => coverageFragments.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    uniqueFile: uniqueIndex('idx_coverage_report_files_unique').on(table.reportId, table.path),
    fragmentIdx: index('idx_coverage_report_files_fragment').on(table.fragmentId),
  }),
);

// Coverage totals per project, commit and suite (see schema.sqlite.ts).
export const coverageTotals = pgTable(
  'coverage_totals',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commit: text('commit_sha').notNull(),
    branch: text('branch').notNull().default(''), // '' = the default branch
    suite: text('suite').notNull(), // a suite's name, or 'combined'
    area: text('area').notNull().default(''), // a named area of the project's code, or '' for every file
    kind: text('kind').notNull(), // 'unit' | 'e2e' | 'combined'
    executableLines: integer('executable_lines').notNull().default(0),
    executedLines: integer('executed_lines').notNull().default(0),
    undeterminedLines: integer('undetermined_lines').notNull().default(0),
    knownFunctions: integer('known_functions').notNull().default(0),
    runFunctions: integer('run_functions').notNull().default(0),
    files: integer('files').notNull().default(0),
    unitOnlyLines: integer('unit_only_lines').notNull().default(0),
    e2eOnlyLines: integer('e2e_only_lines').notNull().default(0),
    bothLines: integer('both_lines').notNull().default(0),
    filesWithoutData: integer('files_without_data'), // null without an inventory
    filesCarriedForward: integer('files_carried_forward').notNull().default(0),
    carriedFrom: text('carried_from'), // the commit an absent suite's files came from
    incomplete: boolean('incomplete').notNull().default(false),
    scopeVersion: integer('scope_version').notNull().default(0),
    commitSeenAt: timestamp('commit_seen_at', { mode: 'date' }),
    computationStartedAt: timestamp('computation_started_at', { mode: 'date' }),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    detailRemovedAt: timestamp('detail_removed_at', { mode: 'date' }), // null while the commit's reports are kept
    supersededBy: text('superseded_by'), // the newer commit whose coverage made the reports go
  },
  (table) => ({
    uniqueSuite: uniqueIndex('idx_coverage_totals_unique').on(table.projectId, table.commit, table.suite, table.area),
    projectBranchIdx: index('idx_coverage_totals_project_branch').on(table.projectId, table.branch, table.commitSeenAt),
  }),
);

// Coverage per day, branch and suite (see schema.sqlite.ts).
export const coverageDaily = pgTable(
  'coverage_daily',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // UTC date, YYYY-MM-DD
    branch: text('branch').notNull().default(''),
    suite: text('suite').notNull(),
    area: text('area').notNull().default(''), // a named area of the project's code, or '' for every file
    commit: text('commit_sha').notNull(),
    executableLines: integer('executable_lines').notNull().default(0),
    executedLines: integer('executed_lines').notNull().default(0),
    undeterminedLines: integer('undetermined_lines').notNull().default(0),
    knownFunctions: integer('known_functions').notNull().default(0),
    runFunctions: integer('run_functions').notNull().default(0),
    files: integer('files').notNull().default(0),
    unitOnlyLines: integer('unit_only_lines').notNull().default(0),
    e2eOnlyLines: integer('e2e_only_lines').notNull().default(0),
    bothLines: integer('both_lines').notNull().default(0),
    commitSeenAt: timestamp('commit_seen_at', { mode: 'date' }),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueDay: uniqueIndex('idx_coverage_daily_unique').on(
      table.projectId,
      table.day,
      table.branch,
      table.suite,
      table.area,
    ),
  }),
);

// Locator breaks a pull-request run's diff predicts: one row per chain of the
// locator index that a string the diff removed or renamed stops matching.
// Written at finish time by change coverage; read by the pull-request comment
// and by locator healing's `diff-rename` rung. Replaced on every run.
export const runLocatorBreaks = pgTable(
  'run_locator_breaks',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    locator: text('locator').notNull(),
    rewrite: text('rewrite'),
    replacements: jsonb('replacements'),
    anchor: jsonb('anchor').notNull(),
    confidence: text('confidence').notNull(),
    callSites: jsonb('call_sites').notNull(),
    testCaseIds: jsonb('test_case_ids').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index('idx_run_locator_breaks_run').on(table.runId),
    projectIdx: index('idx_run_locator_breaks_project').on(table.projectId),
  }),
);

// Network requests table - normalized child table of test_runs_cases
export const networkRequests = pgTable(
  'network_requests',
  {
    id: serial('id').primaryKey(),
    testRunsCaseId: integer('test_runs_case_id')
      .notNull()
      .references(() => testRunsCases.id, { onDelete: 'cascade' }),
    testRunId: integer('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    url: text('url'),
    normalizedUrl: text('normalized_url'),
    status: integer('status').notNull(),
    duration: integer('duration'),
    startTime: bigint('start_time', { mode: 'number' }), // Request start, Unix timestamp in ms (exceeds 32-bit int range)
    resourceType: text('resource_type'),
    contentType: text('content_type'),
    serverLogs: jsonb('server_logs'),
    serverTraces: jsonb('server_traces'),
    failure: text('failure'), // Why the request failed (Playwright's error text, e.g. net::ERR_CONNECTION_RESET); null when it finished
    fulfilled: boolean('fulfilled'), // true when no server sent the response (the test's route handler fulfilled it, or a cache or service worker); null otherwise
  },
  (t) => ({
    runIdx: index('idx_nr_run').on(t.testRunId),
    caseStatusIdx: index('idx_nr_case').on(t.testRunsCaseId, t.status),
    normalizedUrlIdx: index('idx_nr_normalized_url').on(t.normalizedUrl),
    // Server traces arrive only from instrumented backends; the capability probe looks for one.
    serverTracesIdx: index('idx_nr_server_traces')
      .on(t.testRunId)
      .where(sql`server_traces IS NOT NULL`),
  }),
);

// Trace resources table - shared pool of individual resource files extracted from trace ZIPs
export const traceResources = pgTable(
  'trace_resources',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // filename as stored in resources/ dir, e.g. "abc123.net"
    path: text('path').notNull(), // project-{id}/trace-resources/{name}
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectNameIdx: uniqueIndex('idx_trace_resources_project_name').on(table.projectId, table.name),
  }),
);

// Trace blobs table - content-addressed storage deduplicating trace files across runs
export const traceBlobs = pgTable(
  'trace_blobs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(), // SHA-256 hex digest of the trace file content
    path: text('path').notNull(), // content-addressed path: project-{id}/blobs/{hash}.zip
    size: integer('size').notNull(), // size of the trace as uploaded, the one users download
    // Bytes the blob's own files occupy in storage: the slim ZIP plus its manifest,
    // or the whole ZIP when it was stored as is. Shared pool resources are counted
    // in trace_resources, not here. Null until the startup backfill measures the
    // blob.
    storedSize: integer('stored_size'),
    // True once this blob's trace_blob_resources rows exist (written at ingest, or
    // backfilled from its manifest). Per-resource GC only trusts the join table
    // for a project whose blobs are all indexed; false blobs keep the whole-project
    // fallback until backfill catches up.
    resourcesIndexed: boolean('resources_indexed').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectHashIdx: uniqueIndex('idx_trace_blobs_project_hash').on(table.projectId, table.hash),
  }),
);

// Join table — which shared resources each trace blob references. Lets a partial
// delete reclaim a resource as soon as no surviving blob references it, instead
// of waiting for the project to lose its last blob. Both sides cascade so the
// link disappears with either end.
export const traceBlobResources = pgTable(
  'trace_blob_resources',
  {
    id: serial('id').primaryKey(),
    blobId: integer('blob_id')
      .notNull()
      .references(() => traceBlobs.id, { onDelete: 'cascade' }),
    resourceId: integer('resource_id')
      .notNull()
      .references(() => traceResources.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    blobResourceIdx: uniqueIndex('idx_trace_blob_resources_blob_resource').on(table.blobId, table.resourceId),
    resourceIdx: index('idx_trace_blob_resources_resource').on(table.resourceId),
  }),
);

// Files table - unified storage for all file references (reports, traces, screenshots, etc.)
export const files = pgTable(
  'files',
  {
    id: serial('id').primaryKey(),
    testRunId: integer('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }),
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'report', 'trace', 'screenshot', etc.
    subtype: text('subtype'), // 'html', 'monocart', 'blob' for reports; null for traces
    label: text('label'), // Display label e.g. 'HTML Report'
    path: text('path').notNull(), // Relative path in storage
    size: integer('size'), // File/directory size in bytes
    blobId: integer('blob_id').references(() => traceBlobs.id), // Set when the file is a deduplicated trace blob
    metadata: jsonb('metadata'), // Type-specific extras (e.g. visual-diff metrics)
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    testRunIdIdx: index('idx_files_test_run_id').on(table.testRunId),
    testRunsCaseIdIdx: index('idx_files_test_runs_case_id').on(table.testRunsCaseId),
    // Trace deletion refcounts blob references with a COUNT(*) on this column.
    blobIdIdx: index('idx_files_blob_id').on(table.blobId),
  }),
);

// Integration connections table - one row per external system (Jira, Confluence, …)
// an administrator connected. Global infrastructure, mirroring notification_channels
// in spirit but never user-scoped. Credentials are AES-256-GCM-encrypted JSON.
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: serial('id').primaryKey(),
    provider: text('provider').notNull(), // 'jira' | 'confluence' | 'github-issues' | …
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    config: jsonb('config'), // provider-specific, non-secret (flavor, site id, default space…)
    credentials: text('credentials'), // AES-256-GCM JSON: { email, apiToken } | { token } | { pat }
    status: text('status').notNull().default('unverified'), // 'unverified' | 'ok' | 'failed'
    lastCheckedAt: timestamp('last_checked_at', { mode: 'date' }),
    lastError: text('last_error'),
    managedBy: text('managed_by').notNull().default('db'), // 'db' | 'env'
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    providerIdx: index('idx_integration_connections_provider').on(t.provider),
  }),
);

// Entity links table - attach external URLs (Jira, GitHub, etc.) to runs, test-case runs, or test cases
export const entityLinks = pgTable(
  'entity_links',
  {
    id: serial('id').primaryKey(),

    testRunId: integer('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }),
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'cascade' }),
    failureClusterId: integer('failure_cluster_id').references(() => failureClusters.id, { onDelete: 'cascade' }),
    bugReportId: integer('bug_report_id').references(() => bugReports.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),

    // Detected nature — drives the icon
    provider: text('provider').notNull().default('generic'),

    // Smart-link enrichment (best-effort; null until/if unfurled)
    key: text('key'),
    title: text('title'),
    statusText: text('status_text'),
    statusColor: text('status_color'),
    metadata: jsonb('metadata'),
    unfurledAt: timestamp('unfurled_at', { withTimezone: true, mode: 'date' }),

    // The connection that can read/write this record, and the tracker's stable id.
    connectionId: integer('connection_id').references(() => integrationConnections.id, { onDelete: 'set null' }),
    externalId: text('external_id'), // tracker's stable id (Jira issue id, not the key — keys change on move)
    origin: text('origin').notNull().default('pinned'), // 'pinned' | 'created' | 'annotation' | 'reporter'

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bugReportIdx: index('idx_entity_links_bug_report').on(t.bugReportId),
    runIdx: index('idx_entity_links_run').on(t.testRunId),
    caseRunIdx: index('idx_entity_links_case_run').on(t.testRunsCaseId),
    caseIdx: index('idx_entity_links_case').on(t.testCaseId),
    clusterIdx: index('idx_entity_links_cluster').on(t.failureClusterId),
    createdByIdx: index('idx_entity_links_created_by').on(t.createdBy),
    connectionIdx: index('idx_entity_links_connection').on(t.connectionId),
  }),
);

// Tags table - for labeling projects
export const tags = pgTable(
  'tags',
  {
    id: serial('id').primaryKey(),
    text: text('text').notNull().unique(),
    color: text('color').notNull().default('neutral'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    updatedAtIdx: index('idx_tags_updated_at').on(table.updatedAt),
  }),
);

// Project tags junction table
export const projectTags = pgTable(
  'project_tags',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.tagId] }),
    projectIdIdx: index('idx_project_tags_project_id').on(table.projectId),
    tagIdIdx: index('idx_project_tags_tag_id').on(table.tagId),
  }),
);

// Markers table - dated timeline events per project (deploys, config changes, incidents, ...)
export const markers = pgTable(
  'markers',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { mode: 'date' }).notNull(), // The event time; drives the chart x-position
    label: text('label').notNull(),
    description: text('description'),
    category: text('category').notNull().default('event'), // 'deploy', 'config', 'infra', 'incident', 'release', 'event'
    environment: text('environment'), // Optional scope; null = applies to all environments
    source: text('source').notNull().default('manual'), // 'manual' | 'auto'
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }), // Optional link to the run that triggered/relates to the marker
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdIdx: index('idx_markers_project_id').on(table.projectId),
    projectOccurredIdx: index('idx_markers_project_occurred').on(table.projectId, table.occurredAt),
    runIdIdx: index('idx_markers_run_id').on(table.runId),
  }),
);

// Users table - for authentication
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: text('username').notNull().unique(),
    password: text('password').notNull(), // hashed password (empty string for OAuth-only users)
    role: text('role').notNull(), // InstanceRole: 'administrator' | 'member'
    name: text('name'), // Display name
    email: text('email'), // Email address (nullable; OAuth callback can populate it)
    emailVerified: intBoolean('email_verified').notNull().default(INT_BOOLEAN_FALSE),
    avatarUrl: text('avatar_url'), // Avatar from OAuth provider
    oauthProvider: text('oauth_provider'), // 'google', 'github', etc.
    oauthProviderId: text('oauth_provider_id'), // User ID from the OAuth provider
    // Incremented to revoke all of a user's existing sessions (password change/reset, role change, unlink).
    sessionEpoch: integer('session_epoch').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    oauthIdx: uniqueIndex('idx_users_oauth').on(table.oauthProvider, table.oauthProviderId),
    // One account per email address, ignoring case: OAuth sign-in links accounts by email.
    emailIdx: uniqueIndex('idx_users_email').on(sql`lower(${table.email})`),
  }),
);

// Account tokens table - single-use, hashed, expiring tokens for reset / verify / invite
export const accountTokens = pgTable(
  'account_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // 'reset' | 'verify' | 'invite'
    tokenHash: text('token_hash').notNull(), // SHA-256 of the emailed token
    // The address the token was sent to: it acts only while the account still holds it.
    email: text('email'),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    hashIdx: uniqueIndex('idx_account_tokens_hash').on(t.tokenHash),
    userIdx: index('idx_account_tokens_user').on(t.userId),
  }),
);

// Notification channels table - a configured delivery destination (email / Slack / webhook)
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'email' | 'slack' | 'webhook'
    config: jsonb('config'), // { address } | { webhookUrl } | { url, secret (encrypted) }
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = global (admin-managed)
    verified: intBoolean('verified').notNull().default(INT_BOOLEAN_FALSE),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userIdx: index('idx_notification_channels_user').on(t.userId),
  }),
);

// Subscriptions table - who wants notifications for which projects/events
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = all projects
    events: jsonb('events'), // string[] of event keys
    filters: jsonb('filters'), // { branches?, tags?, statuses?, defaultBranchOnly?, flakinessThreshold?, perfRegressionPct? }
    mode: text('mode').notNull().default('realtime'), // 'realtime' | 'digest'
    digestAt: text('digest_at'), // 'HH:mm' UTC for daily digest
    mutedUntil: timestamp('muted_until', { mode: 'date' }),
    active: intBoolean('active').notNull().default(INT_BOOLEAN_TRUE),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectIdx: index('idx_subscriptions_project').on(t.projectId),
    userIdx: index('idx_subscriptions_user').on(t.userId),
    channelIdx: index('idx_subscriptions_channel').on(t.channelId),
  }),
);

// Notification deliveries table - outbox for reliability, retries, dedup, audit
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: serial('id').primaryKey(),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload'),
    dedupeKey: text('dedupe_key'), // e.g. `${event}:${runId}:${channelId}` — prevents double-send
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'sent' | 'failed' | 'skipped'
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    scheduledFor: timestamp('scheduled_for', { mode: 'date' }), // digest batching / backoff / claim lease
    sentAt: timestamp('sent_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    statusScheduledIdx: index('idx_notification_deliveries_status').on(t.status, t.scheduledFor),
    dedupeKeyIdx: uniqueIndex('idx_notification_deliveries_dedupe').on(t.dedupeKey),
    subscriptionIdx: index('idx_notification_deliveries_subscription').on(t.subscriptionId),
    channelIdx: index('idx_notification_deliveries_channel').on(t.channelId),
  }),
);

// Auto-heal outbox — one durable row per intended fix PR. Mirrors the
// notifications outbox: a unique dedupe key is the only idempotency mechanism,
// attempts + scheduledFor drive progressive backoff, and the payload is
// snapshotted at enqueue so a retry is deterministic even if the run's SCM
// metadata later changes.
export const healActions = pgTable(
  'heal_actions',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull().default('open-pr'),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'opened' | 'merged' | 'closed' | 'failed' | 'skipped'
    attempts: integer('attempts').notNull().default(0),
    payload: jsonb('payload').notNull(),
    result: jsonb('result'),
    error: text('error'),
    scheduledFor: timestamp('scheduled_for', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    dedupeKeyIdx: uniqueIndex('idx_heal_actions_dedupe').on(t.dedupeKey),
    projectStatusIdx: index('idx_heal_actions_project_status').on(t.projectId, t.status),
    statusScheduledIdx: index('idx_heal_actions_status').on(t.status, t.scheduledFor),
    runIdx: index('idx_heal_actions_run').on(t.runId),
  }),
);

// Project integrations table — the per-project binding of a connection: which Jira
// project a project's tickets land in, the issue type, labels, owner routes, the
// include toggles and the auto-create policy (disabled by default).
export const projectIntegrations = pgTable(
  'project_integrations',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    projectKey: text('project_key'), // Jira project key (tracker binding)
    issueType: text('issue_type'),
    labels: jsonb('labels'), // string[]
    defaultAssignee: text('default_assignee'), // account id / name
    spaceId: text('space_id'), // Confluence space (wiki binding)
    parentPageId: text('parent_page_id'), // Confluence parent page
    locale: text('locale'), // ticket language for this project ('en' | 'fr'); overrides the connection default
    include: jsonb('include'), // { includeDiagnosis, includePatch, includeScreenshot, includeShareLink }
    policies: jsonb('policies'), // { commentOnFix, transitionOnFix, commentOnRegression, resolveOnClose, … }
    ownerRoutes: jsonb('owner_routes'), // { owner, projectKey?, componentId?, assigneeAccountId?, labels? }[]
    autoCreate: jsonb('auto_create'), // { enabled, minOccurrences, minRuns, dailyCap, routeUnmatched } — disabled by default
    fieldDefaults: jsonb('field_defaults'), // { [trackerFieldId]: { value, label } } — values for fields the tracker requires
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectIdx: index('idx_project_integrations_project').on(t.projectId),
    connectionIdx: index('idx_project_integrations_connection').on(t.connectionId),
    projectConnectionIdx: uniqueIndex('idx_project_integrations_project_connection').on(t.projectId, t.connectionId),
  }),
);

// Integration actions outbox — every outbound write to an external system is a
// durable row, retried with backoff, deduped by a unique key, and listable. The
// payload is snapshotted at enqueue so a retry is deterministic.
export const integrationActions = pgTable(
  'integration_actions',
  {
    id: serial('id').primaryKey(),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'create-issue' | 'comment' | 'transition' | 'attach' | 'sync-status' | 'create-page' | 'update-page'
    entityType: text('entity_type').notNull(), // 'failure_cluster' | 'test_runs_case' | 'test_case' | 'test_run'
    entityId: integer('entity_id').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'done' | 'failed' | 'skipped'
    attempts: integer('attempts').notNull().default(0),
    scheduledFor: timestamp('scheduled_for', { mode: 'date' }),
    error: text('error'),
    payload: jsonb('payload').notNull(),
    result: jsonb('result'), // { key, url } | { commentId } | { pageId, version }
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: timestamp('finished_at', { mode: 'date' }),
  },
  (t) => ({
    dedupeKeyIdx: uniqueIndex('idx_integration_actions_dedupe').on(t.dedupeKey),
    projectStatusIdx: index('idx_integration_actions_project_status').on(t.projectId, t.status),
    statusScheduledIdx: index('idx_integration_actions_status').on(t.status, t.scheduledFor),
    connectionIdx: index('idx_integration_actions_connection').on(t.connectionId),
    requestedByIdx: index('idx_integration_actions_requested_by').on(t.requestedBy),
  }),
);

// Groups — named sets of users. A group receives project roles through role
// bindings, like a user does; it never carries the instance role.
export const groups = pgTable(
  'groups',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    description: text('description'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    createdByIdx: index('idx_groups_created_by').on(t.createdBy),
  }),
);

// Group members — one row per user in a group.
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: integer('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    userIdx: index('idx_group_members_user').on(t.userId),
    addedByIdx: index('idx_group_members_added_by').on(t.addedBy),
  }),
);

// Role bindings — a user or a group (exactly one) holds a ProjectRole on one
// project, or on all projects present and future when project_id is null.
// One role per subject per scope. SQLite and PostgreSQL both treat NULL as
// distinct in a unique index, so the all-projects bindings are deduped by a
// partial index over the subject, and the per-project ones by (subject, project).
export const roleBindings = pgTable(
  'role_bindings',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // ProjectRole: 'viewer' | 'contributor' | 'maintainer' | 'project_admin' | 'uploader'
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    oneSubject: check(
      'role_bindings_one_subject',
      sql`(${t.userId} is not null and ${t.groupId} is null) or (${t.userId} is null and ${t.groupId} is not null)`,
    ),
    userAllProjectsIdx: uniqueIndex('idx_role_bindings_user_all_projects')
      .on(t.userId)
      .where(sql`${t.projectId} is null`),
    userProjectIdx: uniqueIndex('idx_role_bindings_user_project').on(t.userId, t.projectId),
    groupAllProjectsIdx: uniqueIndex('idx_role_bindings_group_all_projects')
      .on(t.groupId)
      .where(sql`${t.projectId} is null`),
    groupProjectIdx: uniqueIndex('idx_role_bindings_group_project').on(t.groupId, t.projectId),
    projectIdx: index('idx_role_bindings_project').on(t.projectId),
    createdByIdx: index('idx_role_bindings_created_by').on(t.createdBy),
  }),
);

// API keys table - for reporter/CI authentication
// Test function catalog — per-project page-object methods/helpers, matched against
// recorded browser-extension sessions to substitute a raw locator span with a call
// to the project's own code. `params`, `steps` and `paramSources` are JSON — see
// `packages/core/src/function-match.ts` for the shapes they deserialize to
// (`FunctionParam[]`, `FunctionPatternStep[]`, `FunctionParamSource[]`).
export const testFunctions = pgTable(
  'test_functions',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // 'page-object-method' | 'helper' | 'fixture'
    module: text('module').notNull(), // import specifier, e.g. './pages/CartPage'
    receiver: text('receiver'), // instance variable name for page-object-method, e.g. 'cartPage'; null otherwise
    importName: text('import_name'), // class name to import + instantiate for page-object-method; null otherwise
    params: text('params').notNull(), // JSON: FunctionParam[]
    returnsPage: boolean('returns_page').notNull().default(false),
    urlPattern: text('url_pattern'), // glob matched against a recorded step's page URL; null matches any page
    steps: text('steps').notNull(), // JSON: FunctionPatternStep[] — the DOM pattern this function drives
    paramSources: text('param_sources').notNull(), // JSON: FunctionParamSource[]
    source: text('source').notNull().default('manual'), // 'manual' | 'scanned' | 'recorded' | 'ai-extracted'
    confidence: doublePrecision('confidence').notNull().default(1), // 0-1; 1 for manual/reviewed entries
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdIdx: index('idx_test_functions_project_id').on(table.projectId),
    uniqueName: uniqueIndex('idx_test_functions_project_module_name').on(table.projectId, table.module, table.name),
  }),
);

// Test selections — named, data-driven subsets of a project's tests. The
// `definition` is declarative JSON (SelectionDefinition in
// shared/selection/types.ts): rules over catalog facts resolved on demand,
// never a frozen list, so a saved selection keeps tracking the suite as tests
// are added, renamed and removed. `version` increments on every definition
// edit; a run resolved from a selection stamps the version it ran.
export const testSelections = pgTable(
  'test_selections',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // project-unique slug, e.g. 'smoke'
    name: text('name').notNull(),
    description: text('description'),
    definition: jsonb('definition').notNull(), // SelectionDefinition
    version: integer('version').notNull().default(1),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectIdIdx: index('idx_test_selections_project_id').on(table.projectId),
    createdByIdx: index('idx_test_selections_created_by').on(table.createdBy),
    keyUnique: uniqueIndex('idx_test_selections_project_key').on(table.projectId, table.key),
  }),
);

// Share links — read-only capability tokens for handing one execution or one
// failure cluster to someone without a dashboard account. The token itself is
// never stored: only its SHA-256 hash (unguessable 256-bit secrets need no
// salt, and the plain hash is what makes an indexed equality lookup possible).
// `entity_id` is polymorphic over test_runs_cases / failure_clusters, so it
// carries no FK; retention's orphan sweep removes rows whose entity is gone.
export const shareLinks = pgTable(
  'share_links',
  {
    id: serial('id').primaryKey(),
    // null for a report or a dashboard link, which can span several projects
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    entityKind: text('entity_kind').notNull(), // 'execution' | 'cluster' | 'report' | 'dashboard' (ShareLinkKind)
    entityId: integer('entity_id').notNull(), // test_runs_cases.id, failure_clusters.id, report_snapshots.id or analytics_dashboards.id
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 hash of the full psl_ token
    tokenPrefix: text('token_prefix').notNull(), // First 8 chars after "psl_" — shown in UI
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: timestamp('expires_at', { mode: 'date' }), // null = no expiry
    revokedAt: timestamp('revoked_at', { mode: 'date' }), // set on revoke; row kept for the audit trail
    lastViewedAt: timestamp('last_viewed_at', { mode: 'date' }),
    viewCount: integer('view_count').notNull().default(0),
  },
  (table) => ({
    projectIdIdx: index('idx_share_links_project_id').on(table.projectId),
    entityIdx: index('idx_share_links_entity').on(table.entityKind, table.entityId),
    createdByIdx: index('idx_share_links_created_by').on(table.createdBy),
  }),
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // Human-readable label, e.g. "CI pipeline"
    keyHash: text('key_hash').notNull().unique(), // SHA-256 hash of the full key
    keyPrefix: text('key_prefix').notNull(), // First 8 chars after "pd_" prefix – shown in UI
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
  },
  (table) => ({
    userIdIdx: index('idx_api_keys_user_id').on(table.userId),
  }),
);

// Browser-extension connect requests (an RFC 8628 device authorization grant).
// Both codes are stored as SHA-256 hashes only. A row goes pending → approved or
// denied → consumed; the API key is created by the token call that consumes an
// approved row, so its plaintext is never stored.
export const extensionDeviceCodes = pgTable(
  'extension_device_codes',
  {
    id: serial('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCodeHash: text('user_code_hash').notNull(),
    clientName: text('client_name').notNull(), // "Piwi Picker in Chrome on Windows"
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // who decided; null until then
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }), // the key the token call created
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { mode: 'date' }),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    decidedAt: timestamp('decided_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    deviceCodeIdx: uniqueIndex('idx_extension_device_codes_device').on(t.deviceCodeHash),
    userCodeIdx: uniqueIndex('idx_extension_device_codes_user').on(t.userCodeHash),
    expiresIdx: index('idx_extension_device_codes_expires').on(t.expiresAt),
    userIdx: index('idx_extension_device_codes_user_id').on(t.userId),
    apiKeyIdx: index('idx_extension_device_codes_api_key').on(t.apiKeyId),
  }),
);

// MCP clients registered through OAuth dynamic client registration (RFC 7591).
// A client that asked for one holds a secret, stored as a SHA-256 hash; a public
// client (the usual case) has none and proves itself with PKCE alone.
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: serial('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientSecretHash: text('client_secret_hash'), // null for a public client
    clientName: text('client_name').notNull(), // what the client calls itself; shown on the consent page
    clientUri: text('client_uri'),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }), // last authorization or token request
  },
  (t) => ({
    clientIdIdx: uniqueIndex('idx_oauth_clients_client_id').on(t.clientId),
  }),
);

// One MCP client connected for one user through OAuth. The grant owns an API key
// row named after the client: it carries the user's access, appears in their API
// keys, and revoking it there deletes the grant. That row's own key value is never
// handed out, so the grant's tokens are the only way to use it. Tokens are stored
// as SHA-256 hashes; each refresh replaces both and keeps the previous refresh
// token's hash, so a replayed one revokes the grant once its short grace period is over.
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: serial('id').primaryKey(),
    clientId: integer('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiKeyId: integer('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    resource: text('resource').notNull(), // the MCP endpoint URL the tokens were issued for
    accessTokenHash: text('access_token_hash').notNull(),
    accessExpiresAt: timestamp('access_expires_at', { mode: 'date' }).notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    refreshedAt: timestamp('refreshed_at', { mode: 'date' }),
    // The response of the last refresh, sealed with a key only the refresh token it replaced derives:
    // a client that presents that token again within seconds gets the same tokens back.
    previousTokenResponse: text('previous_token_response'),
  },
  (t) => ({
    accessIdx: uniqueIndex('idx_oauth_grants_access').on(t.accessTokenHash),
    refreshIdx: uniqueIndex('idx_oauth_grants_refresh').on(t.refreshTokenHash),
    previousRefreshIdx: index('idx_oauth_grants_previous_refresh').on(t.previousRefreshTokenHash),
    apiKeyIdx: uniqueIndex('idx_oauth_grants_api_key').on(t.apiKeyId),
    clientIdx: index('idx_oauth_grants_client').on(t.clientId),
    userIdx: index('idx_oauth_grants_user').on(t.userId),
    refreshExpiresIdx: index('idx_oauth_grants_refresh_expires').on(t.refreshExpiresAt),
  }),
);

// Authorization requests of the OAuth authorization code flow. The authorize
// endpoint stores the client's request and sends the browser to the consent
// page with the request id; the signed-in user's answer moves the row
// pending → approved or denied, and the token call that redeems the code
// moves it to consumed and records the grant it created. The request id and
// the code are stored as SHA-256 hashes.
export const oauthAuthorizationRequests = pgTable(
  'oauth_authorization_requests',
  {
    id: serial('id').primaryKey(),
    requestIdHash: text('request_id_hash').notNull(),
    clientId: integer('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    state: text('state'), // returned to the client unchanged
    codeChallenge: text('code_challenge').notNull(), // PKCE, S256
    scope: text('scope').notNull(),
    resource: text('resource').notNull(),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // who decided; null until then
    codeHash: text('code_hash'), // set when approved
    grantId: integer('grant_id').references(() => oauthGrants.id, { onDelete: 'set null' }), // the grant the code created
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    decidedAt: timestamp('decided_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    requestIdx: uniqueIndex('idx_oauth_authorization_requests_request').on(t.requestIdHash),
    codeIdx: uniqueIndex('idx_oauth_authorization_requests_code').on(t.codeHash),
    clientIdx: index('idx_oauth_authorization_requests_client').on(t.clientId),
    userIdx: index('idx_oauth_authorization_requests_user').on(t.userId),
    grantIdx: index('idx_oauth_authorization_requests_grant').on(t.grantId),
    expiresIdx: index('idx_oauth_authorization_requests_expires').on(t.expiresAt),
  }),
);

// The URLs a project's application is served at, as `*`/`**` globs over the
// whole URL (`urlMatches` in @piwitests/core/function-match). The browser
// extension resolves the project of the page it is on from them.
export const projectUrlPatterns = pgTable(
  'project_url_patterns',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    environment: text('environment'), // free label: 'staging', 'production'
    branch: text('branch'), // the branch deployed at these URLs; null for the default branch
    pathPrefix: text('path_prefix'), // the path the site serves its pages under and the tests did not ('/app')
    testPathPrefix: text('test_path_prefix'), // the path the tests ran the pages under and the site does not ('/app')
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectPatternIdx: uniqueIndex('idx_project_url_patterns_pattern').on(t.projectId, t.pattern),
  }),
);

// Feature graph — nodes. One typed node per object a project's surface exposes.
// A node's `key` is its stable identity within its `kind` (a route's
// `METHOD /pattern`, a page's URL). Populated on every ingest from the same
// evidence the suite already captures, and connected by `graph_edges`. Kept as
// one table with typed endpoints rather than a graph database, so recursive
// queries stay capped at a shallow depth. Route and page kinds are populated
// today; the remaining kinds are reserved. Run ids are intentionally NOT
// foreign keys — runs are pruned independently and a node must survive them.
export const graphNodes = pgTable(
  'graph_nodes',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'feature' | 'page' | 'control' | 'link' | 'route' | 'handler' | 'dependency' | 'file'
    key: text('key').notNull(), // stable identity within kind
    branch: text('branch'), // null = canonical (default-branch run); else the run's own branch
    attrs: jsonb('attrs'), // kind-specific extras; a feature carries { url_patterns, source }
    origin: text('origin').notNull().default('observed'), // 'observed' | 'manifest' | 'openapi' | 'convention' | 'import' | 'coverage' | 'usage' | 'manual'
    usage30d: integer('usage_30d'), // daily hit count from production instrumentation; null until usage is wired
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
    // Set when a staleness sweep removed the node's edges; the row is kept (a
    // soft delete) so first_seen survives a later re-appearance and surface
    // drift does not fire again. Cleared on the next ingest that sees the key.
    prunedAt: timestamp('pruned_at', { mode: 'date' }),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // The identity is (project, kind, key, branch). SQLite and PostgreSQL both
  // treat NULL as distinct in a unique index, so canonical rows (branch null)
  // are deduped by a partial index over (project, kind, key), and branch-tagged
  // rows by the full tuple — one row per identity in either case.
  (table) => ({
    canonicalIdx: uniqueIndex('idx_graph_nodes_canonical')
      .on(table.projectId, table.kind, table.key)
      .where(sql`${table.branch} is null`),
    branchIdx: uniqueIndex('idx_graph_nodes_branch')
      .on(table.projectId, table.kind, table.key, table.branch)
      .where(sql`${table.branch} is not null`),
    projectKindIdx: index('idx_graph_nodes_project_kind').on(table.projectId, table.kind),
    projectKindBranchIdx: index('idx_graph_nodes_project_kind_branch').on(table.projectId, table.kind, table.branch),
    lastSeenAtIdx: index('idx_graph_nodes_last_seen_at').on(table.lastSeenAt),
  }),
);

// Feature graph — edges. Each edge connects two typed endpoints; the endpoint
// kinds are the node kinds above plus 'test', 'cluster', 'commit', 'ticket' and
// 'owner', which are named by their id or key rather than stored as nodes.
// `reaches` (test → route/page) and `changes` (commit or ticket → file) are
// populated today; the remaining kinds are reserved. Upserted on every ingest,
// never truncated. Run ids are not foreign keys, for the same reason as nodes.
export const graphEdges = pgTable(
  'graph_edges',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromKind: text('from_kind').notNull(),
    fromKey: text('from_key').notNull(),
    toKind: text('to_kind').notNull(),
    toKey: text('to_key').notNull(),
    kind: text('kind').notNull(), // 'links' | 'contains' | 'triggers' | 'loads' | 'handled-by' | 'calls' | 'imports' | 'groups' | 'reaches' | 'checks' | 'uses' | 'drives' | 'changes' | 'affects' | 'caused-by' | 'owns'
    branch: text('branch'), // null = canonical (default-branch run); else the run's own branch
    confidence: doublePrecision('confidence'), // 0-1, how strongly the edge holds; null when unscored
    origin: text('origin').notNull().default('observed'),
    evidence: jsonb('evidence'), // edge-specific proof, e.g. { method, status }
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // The identity includes `branch`; canonical rows (branch null) dedupe by a
  // partial index over the endpoint tuple, branch-tagged rows by the full tuple.
  (table) => ({
    canonicalIdx: uniqueIndex('idx_graph_edges_canonical')
      .on(table.projectId, table.fromKind, table.fromKey, table.kind, table.toKind, table.toKey)
      .where(sql`${table.branch} is null`),
    branchUnique: uniqueIndex('idx_graph_edges_branch')
      .on(table.projectId, table.fromKind, table.fromKey, table.kind, table.toKind, table.toKey, table.branch)
      .where(sql`${table.branch} is not null`),
    fromIdx: index('idx_graph_edges_from').on(table.projectId, table.fromKind, table.fromKey),
    toIdx: index('idx_graph_edges_to').on(table.projectId, table.toKind, table.toKey),
    kindIdx: index('idx_graph_edges_kind').on(table.projectId, table.kind),
  }),
);

// Scenario gaps — a proposed test that does not exist yet (`kind = 'gap'`) or a
// resilience finding (`kind = 'finding'`), each carrying its evidence lines,
// exposure factors and a ranked score. A row's identity within its detector is
// `key`, so recomputation upserts in place and triage survives it: open rows
// persist, dismissed and accepted rows carry their verdict forward. Run ids are
// not foreign keys, for the same reason as the graph tables.
export const scenarioGaps = pgTable(
  'scenario_gaps',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('gap'), // 'gap' | 'finding'
    detector: text('detector').notNull(), // detector id that produced the row
    class: text('class').notNull(), // 'blind-spot' | 'false-comfort' | 'fragile' | 'unhandled' | 'degraded'
    key: text('key').notNull(), // stable identity within (project, detector)
    title: text('title').notNull(),
    evidence: jsonb('evidence'), // string[] — human-readable evidence lines
    factors: jsonb('factors'), // exposure factors: { churn, age, escapeHistory, priority }
    score: doublePrecision('score'), // exposure × (1 − protection); ranked descending
    featureNodeId: integer('feature_node_id').references(() => graphNodes.id, { onDelete: 'set null' }),
    ticket: text('ticket'), // ticket id joined at change time
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    failureClusterId: integer('failure_cluster_id').references(() => failureClusters.id, { onDelete: 'set null' }),
    testRunId: integer('test_run_id'), // the run that surfaced the gap
    prNumber: integer('pr_number'), // the pull request the gap was reported on, at change time
    status: text('status').notNull().default('open'), // 'open' | 'snoozed' | 'dismissed' | 'accepted' | 'closed'
    dismissReason: text('dismiss_reason'), // 'not-worth-testing' | 'covered-elsewhere' | 'wrong'
    assignedTo: text('assigned_to'),
    triagedBy: integer('triaged_by').references(() => users.id, { onDelete: 'set null' }), // the user who last gave a triage verdict; null when auth is off
    snoozedUntil: timestamp('snoozed_until', { mode: 'date' }), // a snoozed gap wakes at this time; null with status snoozed = until the node changes
    snoozedAtRunId: integer('snoozed_at_run_id'), // legacy; superseded by snoozed_at_signature for "until the node changes"
    snoozedAtSignature: text('snoozed_at_signature'), // the subject node's edge fingerprint when snoozed "until the node changes"; wakes once the node's shape differs
    acceptedAt: timestamp('accepted_at', { mode: 'date' }), // when a gap was accepted; feeds the accepted-but-unwritten inbox queue
    coveredAt: timestamp('covered_at', { mode: 'date' }), // when a gap was marked covered-by; a durable per-gap "for" verdict for detector precision
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    closedAt: timestamp('closed_at', { mode: 'date' }),
    closedByRunId: integer('closed_by_run_id'),
  },
  (table) => ({
    detectorKeyIdx: uniqueIndex('idx_scenario_gaps_detector_key').on(table.projectId, table.detector, table.key),
    projectStatusIdx: index('idx_scenario_gaps_project_status').on(table.projectId, table.status),
    projectScoreIdx: index('idx_scenario_gaps_project_score').on(table.projectId, table.score),
    prIdx: index('idx_scenario_gaps_pr').on(table.projectId, table.prNumber),
    featureNodeIdx: index('idx_scenario_gaps_feature_node').on(table.featureNodeId),
    testCaseIdx: index('idx_scenario_gaps_test_case').on(table.testCaseId),
    clusterIdx: index('idx_scenario_gaps_cluster').on(table.failureClusterId),
    triagedByIdx: index('idx_scenario_gaps_triaged_by').on(table.triagedBy),
  }),
);

// Probes — one row per (test, node, fault) probe outcome. A client probe
// mutates a response at the Playwright route boundary; a server probe sends
// a signed fault header. Each row writes or refreshes one `checks` edge from the
// test to the node with its outcome.
export const probes = pgTable(
  'probes',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    nodeId: integer('node_id').references(() => graphNodes.id, { onDelete: 'set null' }),
    routeKey: text('route_key'),
    level: text('level').notNull().default('client'), // 'client' | 'server'
    fault: text('fault').notNull(),
    applied: boolean('applied').notNull().default(true),
    outcome: text('outcome').notNull(), // 'noticed' | 'not-noticed' | 'inconclusive'
    handled: text('handled').notNull().default('n/a'), // 'graceful' | 'degraded' | 'unhandled' | 'n/a'
    runId: integer('run_id'),
    evidence: jsonb('evidence'),
    probedAt: timestamp('probed_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    pairIdx: uniqueIndex('idx_probes_pair').on(table.projectId, table.testCaseId, table.routeKey, table.fault),
    projectIdx: index('idx_probes_project').on(table.projectId),
    nodeIdx: index('idx_probes_node').on(table.nodeId),
    testIdx: index('idx_probes_test').on(table.testCaseId),
  }),
);

// Daily rollups: the precomputed aggregates of one cell (a project, a UTC day,
// an environment, a branch and a run kind). A cell has a retained row,
// recomputed from the runs still stored, and an archived row holding the
// numbers of the runs age-based deletion removed, added in the transaction that
// deletes them. Reads sum the two parts.
export const analyticsDailyRollups = pgTable(
  'analytics_daily_rollups',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // 'YYYY-MM-DD', UTC
    environment: text('environment').notNull().default(''), // '' when the run had none
    branch: text('branch').notNull().default(''), // '' when unknown
    fullRun: integer('full_run').notNull(), // 1 = full suite, 0 = partial
    part: text('part').notNull(), // 'retained' | 'archived'
    runs: integer('runs').notNull().default(0),
    passedRuns: integer('passed_runs').notNull().default(0),
    failedRuns: integer('failed_runs').notNull().default(0), // failed, timedout, interrupted
    totalTests: integer('total_tests').notNull().default(0),
    passedTests: integer('passed_tests').notNull().default(0),
    failedTests: integer('failed_tests').notNull().default(0),
    skippedTests: integer('skipped_tests').notNull().default(0),
    didNotRunTests: integer('did_not_run_tests').notNull().default(0),
    flakyTests: integer('flaky_tests').notNull().default(0),
    maxTotalTests: integer('max_total_tests').notNull().default(0),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
    avgTestDurationSumMs: bigint('avg_test_duration_sum_ms', { mode: 'number' }).notNull().default(0),
    p90TestDurationSumMs: bigint('p90_test_duration_sum_ms', { mode: 'number' }).notNull().default(0),
    durationRuns: integer('duration_runs').notNull().default(0), // runs with a duration: divides duration_ms
    testDurationRuns: integer('test_duration_runs').notNull().default(0), // runs with test durations: divides the two sums
    waitMs: bigint('wait_ms', { mode: 'number' }).notNull().default(0),
    failedExecMs: bigint('failed_exec_ms', { mode: 'number' }).notNull().default(0),
    newRegressions: integer('new_regressions').notNull().default(0),
    newFlaky: integer('new_flaky').notNull().default(0),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    cellIdx: uniqueIndex('idx_analytics_daily_rollups_cell').on(
      table.projectId,
      table.day,
      table.environment,
      table.branch,
      table.fullRun,
      table.part,
    ),
    projectDayIdx: index('idx_analytics_daily_rollups_project_day').on(table.projectId, table.day),
  }),
);

// Hand-back outcomes: one row each time something Piwi handed back (a locator
// heal, an auto-heal pull request, a diagnosis, a merge suggestion, a
// quarantine proposal, a Flake Lab verify, a bug spec, a gap draft) reaches an
// outcome. Rows are written through `recordOutcome` (`server/utils/outcomes.ts`),
// idempotent on `dedupe_key`. The value sets live in `shared/handback-outcomes.ts`.
export const handbackOutcomes = pgTable(
  'handback_outcomes',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // HandbackKind
    subjectType: text('subject_type').notNull(), // HandbackSubjectType: what subject_id points at
    subjectId: integer('subject_id').notNull(),
    suggestionKey: text('suggestion_key').notNull().default(''), // a stable key of what was suggested
    outcome: text('outcome').notNull(), // 'suggested' | 'applied' | 'verified' | 'rejected' | 'regressed'
    channel: text('channel').notNull(), // 'inferred' | 'ui' | 'mcp' | 'editor' | 'desktop' | 'cli' | 'ci'
    actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }), // null when inferred
    actorApiKeyId: integer('actor_api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }), // the run it was seen in
    commitSha: text('commit_sha'),
    details: jsonb('details'), // kind-specific facts (the recommended locator, the PR number, the diagnosis version)
    dedupeKey: text('dedupe_key').notNull(), // kind, subject, suggestion key, outcome and run
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    dedupeIdx: uniqueIndex('idx_handback_outcomes_dedupe').on(table.projectId, table.dedupeKey),
    projectKindIdx: index('idx_handback_outcomes_project_kind').on(table.projectId, table.kind, table.createdAt),
    subjectIdx: index('idx_handback_outcomes_subject').on(table.subjectType, table.subjectId),
    runIdx: index('idx_handback_outcomes_run').on(table.runId),
    actorUserIdx: index('idx_handback_outcomes_actor_user').on(table.actorUserId),
    actorApiKeyIdx: index('idx_handback_outcomes_actor_api_key').on(table.actorApiKeyId),
  }),
);

// Daily outcome counters of the hand-back outcome rows retention pruned, per
// project, UTC day, kind, outcome and channel. Only ever added to, in the
// transaction that deletes the rows; reads add the rows still stored.
export const handbackOutcomeRollups = pgTable(
  'handback_outcome_rollups',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // 'YYYY-MM-DD', UTC
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    channel: text('channel').notNull(),
    count: integer('count').notNull().default(0),
    computedAt: timestamp('computed_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    cellIdx: uniqueIndex('idx_handback_outcome_rollups_cell').on(
      table.projectId,
      table.day,
      table.kind,
      table.outcome,
      table.channel,
    ),
  }),
);

// The write log of agents: one row per call of a write tool over MCP (the API
// key, the tool, what it acted on and whether it succeeded). Read tools are
// never logged. Pruned with the notification outbox; an instance that declined
// the `agent-write-log` capability writes none.
export const mcpToolCalls = pgTable(
  'mcp_tool_calls',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null when the call named no project
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }), // null for a session or with auth off
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    subjectType: text('subject_type'), // 'cluster', 'execution', 'gap', 'bug-report', 'run', 'test-case', 'suggestion', 'diagnosis'
    subjectId: integer('subject_id'),
    result: text('result').notNull(), // 'ok' | 'error'
    error: text('error'), // the error text an agent was given, truncated
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    subjectIdx: index('idx_mcp_tool_calls_subject').on(table.subjectType, table.subjectId),
    projectIdx: index('idx_mcp_tool_calls_project').on(table.projectId, table.createdAt),
    createdIdx: index('idx_mcp_tool_calls_created').on(table.createdAt),
    apiKeyIdx: index('idx_mcp_tool_calls_api_key').on(table.apiKeyId),
    userIdx: index('idx_mcp_tool_calls_user').on(table.userId),
  }),
);

// One row per gate evaluation (`POST /api/test-runs/:id/gate`): the policy, the
// verdict and its violations, and the pull request it judged. The PR state
// sweep (`server/utils/gate-overrides.ts`) fills in what happened to the pull
// request after a failed gate, and the default-branch run where a cluster the
// gate caught came back.
export const gateEvaluations = pgTable(
  'gate_evaluations',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha'),
    prNumber: integer('pr_number'), // null when the run names no pull request
    policy: jsonb('policy').notNull(), // GatePolicy, plus maxUncoveredChanges and minPatchCoverage when asked
    policyHash: text('policy_hash').notNull(),
    passed: boolean('passed').notNull(),
    verdict: text('verdict').notNull(), // 'passed' | 'failed' | 'inconclusive'
    violations: jsonb('violations').notNull(), // GateViolation[]
    clusterIds: jsonb('cluster_ids'), // number[]: the clusters of the run's new regressions, read for an escape
    source: text('source').notNull(), // 'cli' | 'api'
    evaluatedAt: timestamp('evaluated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    prState: text('pr_state'), // 'open' | 'merged' | 'closed'; null until the sweep reads it
    prSettledAt: timestamp('pr_settled_at', { mode: 'date' }), // when the host last updated the merged or closed pull request
    overridden: boolean('overridden').notNull().default(false), // merged while its last gate evaluation failed
    escapedRunId: integer('escaped_run_id').references(() => testRuns.id, { onDelete: 'set null' }), // the default-branch run where a caught cluster failed again
    checkedAt: timestamp('checked_at', { mode: 'date' }), // the sweep's last look; null = never looked at
  },
  (table) => ({
    runIdx: index('idx_gate_evaluations_run').on(table.runId),
    projectPrIdx: index('idx_gate_evaluations_project_pr').on(table.projectId, table.prNumber),
    sweepIdx: index('idx_gate_evaluations_sweep').on(table.verdict, table.prState, table.checkedAt),
    escapedRunIdx: index('idx_gate_evaluations_escaped_run').on(table.escapedRunId),
  }),
);

// The pull-request feedback posted for a run: the host, the pull request and
// its comment, and the commit status contexts the host accepted.
export const prFeedbackPosts = pgTable(
  'pr_feedback_posts',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // ScmProviderName
    repositoryUrl: text('repository_url').notNull(),
    prNumber: integer('pr_number'), // null when only commit statuses were posted
    commentId: text('comment_id'), // the host's id of Piwi's comment; null when none was posted or the host returned none
    statuses: jsonb('statuses').notNull(), // string[]: the commit status contexts the host accepted
    fixes: jsonb('fixes'), // VerifiedFix[]: the clusters the run verified as fixed, which a refreshed comment reports again; null before the first comment
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    runIdx: uniqueIndex('idx_pr_feedback_posts_run').on(table.runId),
    projectIdx: index('idx_pr_feedback_posts_project').on(table.projectId, table.prNumber),
  }),
);

// Saved dashboards — a named arrangement of widgets in bands with a default
// scope (`DashboardDefinition` in `shared/analytics/dashboards.ts`). Private
// dashboards belong to their owner; shared ones are listed for every signed-in
// user. A dashboard stores filters and widget options, never data.
export const analyticsDashboards = pgTable(
  'analytics_dashboards',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }), // null when authentication is off
    visibility: text('visibility').notNull().default('private'), // 'private' | 'shared'
    definition: jsonb('definition').notNull(), // DashboardDefinition
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' }) // the save precondition
      .notNull()
      .$defaultFn(() => new Date()),
    updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
    lastViewedAt: timestamp('last_viewed_at', { mode: 'date' }), // throttled; feeds the Unused group
  },
  (t) => ({
    ownerIdx: index('idx_analytics_dashboards_owner').on(t.ownerId),
    visibilityIdx: index('idx_analytics_dashboards_visibility').on(t.visibility),
    updatedByIdx: index('idx_analytics_dashboards_updated_by').on(t.updatedBy),
  }),
);

// Report schedules — a saved recurring delivery of a quality report: a
// dashboard, a scope, a cadence and one or more notification channels. The
// `reports:schedule` task renders each due schedule into a snapshot and queues
// one outbox row per channel.
export const reportSchedules = pgTable(
  'report_schedules',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = global (admin-managed)
    scope: jsonb('scope'), // Partial<AnalyticsScope> applied over the dashboard's scope; the period comes from the cadence
    builtinDashboard: text('builtin_dashboard'), // 'overview' | 'executive' | 'engineering' | 'team' | 'gaps-digest'
    dashboardId: integer('dashboard_id').references(() => analyticsDashboards.id, { onDelete: 'set null' }), // a saved dashboard; set when builtin_dashboard is not
    cadence: text('cadence').notNull(), // 'daily' | 'weekly' | 'biweekly' | 'monthly'
    anchor: integer('anchor'), // weekday 1-7 (weekly, biweekly) or day of month 1-28 (monthly)
    at: text('at').notNull(), // 'HH:mm' in the instance time zone (UTC when that setting is auto)
    comparison: text('comparison').notNull().default('previous'), // 'previous' | 'year-ago' | 'none'
    includeShareLink: intBoolean('include_share_link').notNull().default(INT_BOOLEAN_FALSE),
    includeNarrative: intBoolean('include_narrative').notNull().default(INT_BOOLEAN_FALSE), // the AI narrative, off by default
    language: text('language'), // 'en' | 'fr' | null (project or instance default)
    channelIds: jsonb('channel_ids'), // number[] of notification_channels
    active: intBoolean('active').notNull().default(INT_BOOLEAN_TRUE),
    mutedUntil: timestamp('muted_until', { mode: 'date' }),
    lastRunAt: timestamp('last_run_at', { mode: 'date' }),
    nextRunAt: timestamp('next_run_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userIdx: index('idx_report_schedules_user').on(t.userId),
    dueIdx: index('idx_report_schedules_due').on(t.active, t.nextRunAt),
    dashboardIdx: index('idx_report_schedules_dashboard').on(t.dashboardId),
  }),
);

// Report snapshots — one generated quality report, stored with its frozen
// bundle so a report received in March reads the same in June, whatever
// retention did since. Pruned after PIWI_RETENTION_REPORT_DAYS.
export const reportSnapshots = pgTable(
  'report_snapshots',
  {
    id: serial('id').primaryKey(),
    scheduleId: integer('schedule_id').references(() => reportSchedules.id, { onDelete: 'set null' }), // null = generated by hand
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    dashboardRef: text('dashboard_ref').notNull(),
    dashboardName: text('dashboard_name').notNull(),
    scope: jsonb('scope'), // the AnalyticsScope the bundle was collected over
    projectIds: jsonb('project_ids'), // number[] the bundle covers; null = every project
    periodFrom: timestamp('period_from', { mode: 'date' }).notNull(),
    periodTo: timestamp('period_to', { mode: 'date' }).notNull(),
    comparisonFrom: timestamp('comparison_from', { mode: 'date' }),
    comparisonTo: timestamp('comparison_to', { mode: 'date' }),
    bundle: jsonb('bundle').notNull(), // ReportBundle
    sizeBytes: integer('size_bytes').notNull().default(0),
    generatedAt: timestamp('generated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    scheduleIdx: index('idx_report_snapshots_schedule').on(t.scheduleId),
    generatedIdx: index('idx_report_snapshots_generated').on(t.generatedAt),
    createdByIdx: index('idx_report_snapshots_created_by').on(t.createdBy),
  }),
);

// Type exports for TypeScript
export type AnalyticsDailyRollup = typeof analyticsDailyRollups.$inferSelect;
export type AnalyticsDashboard = typeof analyticsDashboards.$inferSelect;
export type ReportSchedule = typeof reportSchedules.$inferSelect;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type TestSuite = typeof testSuites.$inferSelect;
export type NewTestSuite = typeof testSuites.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type TestRun = typeof testRuns.$inferSelect;
export type NewTestRun = typeof testRuns.$inferInsert;
export type TestCase = typeof testCases.$inferSelect;
export type NewTestCase = typeof testCases.$inferInsert;
export type TestRunsCase = typeof testRunsCases.$inferSelect;
export type NewTestRunsCase = typeof testRunsCases.$inferInsert;
export type FailureCluster = typeof failureClusters.$inferSelect;
export type NewFailureCluster = typeof failureClusters.$inferInsert;
export type FailureDiagnosis = typeof failureDiagnoses.$inferSelect;
export type NewFailureDiagnosis = typeof failureDiagnoses.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type TraceBlob = typeof traceBlobs.$inferSelect;
export type NewTraceBlob = typeof traceBlobs.$inferInsert;
export type TraceResource = typeof traceResources.$inferSelect;
export type NewTraceResource = typeof traceResources.$inferInsert;
export type TraceBlobResource = typeof traceBlobResources.$inferSelect;
export type NewTraceBlobResource = typeof traceBlobResources.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ExtensionDeviceCode = typeof extensionDeviceCodes.$inferSelect;
export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type OAuthAuthorizationRequest = typeof oauthAuthorizationRequests.$inferSelect;
export type ProjectUrlPattern = typeof projectUrlPatterns.$inferSelect;
export type AccountToken = typeof accountTokens.$inferSelect;
export type NewAccountToken = typeof accountTokens.$inferInsert;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
export type Marker = typeof markers.$inferSelect;
export type NewMarker = typeof markers.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMember = typeof groupMembers.$inferSelect;
export type RoleBinding = typeof roleBindings.$inferSelect;
export type NewRoleBinding = typeof roleBindings.$inferInsert;
export type EntityLink = typeof entityLinks.$inferSelect;
export type NewEntityLink = typeof entityLinks.$inferInsert;
export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type ProjectIntegration = typeof projectIntegrations.$inferSelect;
export type NewProjectIntegration = typeof projectIntegrations.$inferInsert;
export type IntegrationAction = typeof integrationActions.$inferSelect;
export type NewIntegrationAction = typeof integrationActions.$inferInsert;
export type NetworkRequest = typeof networkRequests.$inferSelect;
export type NewNetworkRequest = typeof networkRequests.$inferInsert;
export type LocatorSnapshotRow = typeof locatorSnapshots.$inferSelect;
export type NewLocatorSnapshotRow = typeof locatorSnapshots.$inferInsert;
export type TestFunction = typeof testFunctions.$inferSelect;
export type ShareLink = typeof shareLinks.$inferSelect;
export type NewShareLink = typeof shareLinks.$inferInsert;
export type NewTestFunction = typeof testFunctions.$inferInsert;

// Bug reports: a steps document with the assertion that states the correct
// behavior, and the evidence collected on the page, sent from Piwi Picker.
// Screenshots live in storage under `bug-reports/<id>/`; `evidence.screenshots`
// names them. Status: 'open' | 'test-committed' | 'looks-fixed' | 'closed' | 'dismissed'.
export const bugReports = pgTable(
  'bug_reports',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note'),
    pageKey: text('page_key'),
    path: text('path'),
    origin: text('origin'),
    status: text('status').notNull().default('open'),
    steps: jsonb('steps').notNull(), // PiwiSteps
    evidence: jsonb('evidence').notNull(), // BugEvidence
    context: jsonb('context').notNull(), // BugContext
    language: text('language'), // the language the report was written in (`en`, `fr`, …)
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    statusRunId: integer('status_run_id').references(() => testRuns.id, { onDelete: 'set null' }), // the run that last moved the status
    closedAt: timestamp('closed_at', { mode: 'date' }),
    closedByRunId: integer('closed_by_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectStatusIdx: index('idx_bug_reports_project_status').on(t.projectId, t.status),
    testCaseIdx: index('idx_bug_reports_test_case').on(t.testCaseId),
    createdByIdx: index('idx_bug_reports_created_by').on(t.createdBy),
    statusRunIdx: index('idx_bug_reports_status_run').on(t.statusRunId),
    closedByRunIdx: index('idx_bug_reports_closed_by_run').on(t.closedByRunId),
  }),
);

// What happened when someone tried a bug report again: a replay in Piwi Picker
// or a Playwright run from the desktop app. Verdict: 'reproduced' | 'not-reproduced' | 'diverged'.
export const bugReproductions = pgTable(
  'bug_reproductions',
  {
    id: serial('id').primaryKey(),
    bugReportId: integer('bug_report_id')
      .notNull()
      .references(() => bugReports.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // 'replay' | 'desktop'
    verdict: text('verdict').notNull(),
    divergedAt: integer('diverged_at'), // 0-based step index, for a 'diverged' verdict
    origin: text('origin'),
    userAgent: text('user_agent'),
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    bugReportIdx: index('idx_bug_reproductions_report').on(t.bugReportId),
    runIdx: index('idx_bug_reproductions_run').on(t.runId),
    createdByIdx: index('idx_bug_reproductions_created_by').on(t.createdBy),
  }),
);

// Flake-lab experiments: one row per `piwi flake` (reproduce) or `piwi flake verify`
// session on a test. The plan endpoint creates the row; the results endpoint
// fills the verdict and `finished_at`. Deleted with the test case; retention keeps them.
export const flakeExperiments = pgTable(
  'flake_experiments',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'reproduce' | 'verify'
    commit: text('commit_sha'),
    failureCommit: text('failure_commit_sha'),
    source: text('source').notNull().default('cli'), // 'cli' | 'desktop' | 'ci'
    machine: text('machine'),
    playwrightProject: text('playwright_project'),
    verdict: text('verdict'),
    reproducingArmId: integer('reproducing_arm_id'),
    verifiesArmId: integer('verifies_arm_id'),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: timestamp('finished_at', { mode: 'date' }),
  },
  (t) => ({
    testCaseIdx: index('idx_flake_experiments_test_case').on(t.testCaseId, t.createdAt),
    projectIdx: index('idx_flake_experiments_project').on(t.projectId),
  }),
);

// The arms of a flake-lab experiment: the control and one row per condition set,
// with the counts the command line measured and the verdict the server computed.
export const flakeArms = pgTable(
  'flake_arms',
  {
    id: serial('id').primaryKey(),
    experimentId: integer('experiment_id')
      .notNull()
      .references(() => flakeExperiments.id, { onDelete: 'cascade' }),
    armKey: text('arm_key').notNull(),
    position: integer('position').notNull().default(0),
    suspectId: text('suspect_id'),
    label: text('label').notNull(),
    conditions: jsonb('conditions').notNull(),
    runs: integer('runs').notNull().default(0),
    matchingFailures: integer('matching_failures').notNull().default(0),
    otherFailures: integer('other_failures').notNull().default(0),
    discardedRounds: integer('discarded_rounds').notNull().default(0),
    stoppedEarly: boolean('stopped_early').notNull().default(false),
    pValue: doublePrecision('p_value'),
    verdict: text('verdict'),
  },
  (t) => ({
    experimentIdx: index('idx_flake_arms_experiment').on(t.experimentId),
  }),
);

// A resource finding across runs: one per project and identity (its verdict,
// kind, scope and where it was opened, line included;
// shared/resource-fingerprint.mjs), with the runs it first and last showed in.
// An edit above the line moves it to a new identity, which it takes on with its
// history. It is fixed once five full runs of the default branch, with the
// capture fixtures on, came without it, and reopened when it shows again.
export const resourceFindings = pgTable(
  'resource_findings',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    verdict: text('verdict').notNull(), // 'leaked' | 'idle' | 'piling' | 'handle' | 'probable'
    kind: text('kind').notNull(), // 'browser' | 'context' | 'page' | 'request' | 'handle'
    place: text('place').notNull(), // where it was opened, as the latest run named it, with its line
    site: text('site'), // the `file:line` that opened it, when known
    // Run ids are not foreign keys: findings outlive the runs retention deletes.
    firstSeenRunId: integer('first_seen_run_id').notNull(),
    lastSeenRunId: integer('last_seen_run_id').notNull(),
    // When those runs started: runs are ordered by start time, since an imported
    // run can be older than runs stored before it.
    firstSeenAt: timestamp('first_seen_at', { mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull(),
    occurrences: integer('occurrences').notNull().default(0), // runs it showed in
    status: text('status').notNull().default('open'), // 'open' | 'fixed'
    cleanRuns: integer('clean_runs').notNull().default(0), // full default-branch runs without it since it last showed
    lastCheckedRunId: integer('last_checked_run_id'), // the last run that counted as clean, so a retried finish counts once
    fixedRunId: integer('fixed_run_id'), // the first run without it since it last showed; it is fixed there once five came
    fixedAt: timestamp('fixed_at', { mode: 'date' }),
    reopenedRunId: integer('reopened_run_id'), // the run it showed in again after it was fixed
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectFingerprintIdx: uniqueIndex('idx_resource_findings_project_fingerprint').on(t.projectId, t.fingerprint),
    projectStatusIdx: index('idx_resource_findings_project_status').on(t.projectId, t.status),
  }),
);

// One run's showing of a resource finding, with what it held in that run and
// the branch the run was on (the gate and the pull-request comment read a
// finding as new when no earlier run of the base branch showed it).
export const resourceOccurrences = pgTable(
  'resource_occurrences',
  {
    id: serial('id').primaryKey(),
    findingId: integer('finding_id')
      .notNull()
      .references(() => resourceFindings.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    branch: text('branch'), // the run's branch; null when the reporter captured none
    count: integer('count').notNull().default(0),
    tests: integer('tests').notNull().default(0),
    heldMs: integer('held_ms'),
    afterTestCpuMs: integer('after_test_cpu_ms'),
    pages: integer('pages'),
  },
  (t) => ({
    findingRunIdx: uniqueIndex('idx_resource_occurrences_finding_run').on(t.findingId, t.runId),
    runIdx: index('idx_resource_occurrences_run').on(t.runId),
  }),
);

// What each reporter of a run measured about resources (WireResourceReport):
// one row per shard, 0 for a run that was not sharded. Each shard's finish
// writes its own row whole, so shards finishing at once never overwrite each
// other's, and a retried finish replaces its row. Read folded in shard order
// by shared/handlers/resource-reports.ts.
export const testRunResourceReports = pgTable(
  'test_run_resource_reports',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    shard: integer('shard').notNull().default(0),
    report: jsonb('report').notNull(), // rebuilt field by field on ingest (shared/resource-report.ts)
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    runShardIdx: uniqueIndex('idx_test_run_resource_reports_run_shard').on(t.runId, t.shard),
  }),
);

// One batch delivery of a run's results (`/submit`, `/upload`, a shard's for a
// sharded run), under the key the reporter generated for it, and the run it
// went to. A delivery repeated with the same key, such as a slow upload the
// reporter gave up on and sent again, answers with that run instead of storing
// the results twice.
export const runDeliveries = pgTable(
  'run_deliveries',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deliveryKey: text('delivery_key').notNull(),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectKeyIdx: uniqueIndex('idx_run_deliveries_project_key').on(t.projectId, t.deliveryKey),
    runIdx: index('idx_run_deliveries_run_id').on(t.runId),
  }),
);
