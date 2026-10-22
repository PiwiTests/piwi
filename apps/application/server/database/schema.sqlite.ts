import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Projects table
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    label: text('label'), // Display label (defaults to name if not set)
    description: text('description'),
    diagnosisInstructions: text('diagnosis_instructions'),
    aiLanguage: text('ai_language'), // per-project AI response language override (e.g. "French")
    scmToken: text('scm_token'), // Per-project SCM token for GitHub/GitLab/Bitbucket API access
    repositoryUrl: text('repository_url'), // The repository every SCM call of the project reads (normalized https URL); pinned by the first run that names one, changed by a project admin
    defaultBranch: text('default_branch'), // Repository default branch; null = resolve from SCM provider, else 'main'
    openApiUrl: text('openapi_url'), // Declared-surface OpenAPI document URL; fetched server-side into graph route nodes with origin 'openapi'
    externalIdUrl: text('external_id_url'), // link to a test in the team's test management tool, `{id}` replaced by its external ID; null = no link
    serverProbes: text('server_probes', { mode: 'json' }), // ServerProbeSettings — the level-two probe gate (enabled, allow-listed faults/routes); off by default
    routeOrigins: text('route_origins', { mode: 'json' }), // string[] — extra own origins whose requests become graph route nodes, beyond the run's Playwright baseURL
    ciRerun: text('ci_rerun', { mode: 'json' }), // CiRerunSettings — provider-specific "re-run from the dashboard" target (off by default)
    capabilities: text('capabilities', { mode: 'json' }), // Partial<Record<CapabilityId, 'declined' | 'enabled'>> — per-project capability decisions
    generatedSpecs: text('generated_specs', { mode: 'json' }), // GeneratedSpecSettings — test import and bugs folder for specs rendered from steps
    targets: text('targets', { mode: 'json' }), // ProjectTargets — per-project goals on catalog metrics (shared/analytics/targets.ts)
    coverageScope: text('coverage_scope', { mode: 'json' }), // CoverageScope — include and exclude patterns of the files coverage totals count; null = the default excludes
    coverageScopeVersion: integer('coverage_scope_version').notNull().default(0), // Bumped on every change of coverage_scope, so totals computed under another scope read as stale
    coverageAreas: text('coverage_areas', { mode: 'json' }), // CoverageArea[] — named areas of the code (`front`, `back`) by include patterns, each counted apart; null = none
    locatorIndexBuiltAt: integer('locator_index_built_at', { mode: 'timestamp' }), // when locator_usages was first built from stored executions; null = not yet
    quarantineFailsStatus: integer('quarantine_fails_status', { mode: 'boolean' }).notNull().default(false), // true = a quarantined failure turns the run's commit status red; false = the status ignores quarantined failures
    gateStatus: integer('gate_status', { mode: 'boolean' }).notNull().default(false), // true = each gate evaluation also posts the `<statusContext>/gate` commit status; off by default
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    updatedAtIdx: index('idx_projects_updated_at').on(table.updatedAt),
  }),
);

// Test runs table
export const testRuns = sqliteTable(
  'test_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: text('status').notNull(), // 'passed', 'failed', 'timedout', 'interrupted', 'running', 'cancelled', 'initializing', 'finalizing'
    startTime: integer('start_time', { mode: 'timestamp' }).notNull(),
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
    filterDetails: text('filter_details', { mode: 'json' }), // JSON: { grep?, grepInvert? }

    environment: text('environment'), // Deployment environment (e.g. 'production', 'staging', 'development')
    branch: text('branch'), // Scalar SCM branch (logical branch, never 'HEAD') for index efficiency; projects metadata.scm.branch
    metadata: text('metadata', { mode: 'json' }), // Additional metadata as JSON
    origin: text('origin').notNull().default('local'), // What launched the run, `runOrigin(metadata)`, written with every metadata write; read by the eligibility rule
    commit: text('commit_sha'), // The run's commit, `runCommit(metadata)` (metadata.scm.commit), written with every metadata write; null when the run names none
    setupSteps: text('setup_steps', { mode: 'json' }), // Array of suite-level hook/fixture steps (beforeAll/afterAll) for the timeline
    label: text('label'), // Optional human-readable label (e.g. "v2.3.1 release")
    streamToken: text('stream_token'), // Token for authenticating streaming updates
    instanceId: text('instance_id'), // Unique identifier for the reporter instance that created this run
    playwrightVersion: text('playwright_version'), // Playwright framework version used for this run
    reporterVersion: text('reporter_version'), // Piwi reporter package version that produced this run
    importHash: text('import_hash'), // SHA-256 of the imported archive; null for reported runs. Makes re-importing a no-op.
    keptAt: integer('kept_at', { mode: 'timestamp' }), // Set = kept forever: retention never deletes the run
    keptBy: integer('kept_by').references(() => users.id, { onDelete: 'set null' }), // User who kept the run; null for reporter/marker keeps or with auth off
    keepSource: text('keep_source'), // 'user' | 'reporter' | 'marker' — who asked for the keep; null when not kept
    keepReason: text('keep_reason'), // Optional free-text reason shown next to the keep
    serverCoverageGaps: text('server_coverage_gaps', { mode: 'json' }), // Array<{ origin, reason: 'restarted' | 'unreachable', at? }>: why part of the run's server coverage is missing; null when whole
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  },
  (table) => ({
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
export const testSuites = sqliteTable(
  'test_suites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    suitePath: text('suite_path').notNull(), // \x1f-delimited full path, e.g. 'Auth\x1fLogin'
    mode: text('mode').notNull().default('default'), // 'parallel' | 'serial' | 'default'
    annotations: text('annotations', { mode: 'json' }), // Array<{ type, description? }>
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    uniqueIdx: uniqueIndex('idx_test_suites_unique').on(table.projectId, table.filePath, table.suitePath),
  }),
);

// Test cases table - shared test definitions
export const testCases = sqliteTable(
  'test_cases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(), // relative path from project root
    suitePath: text('suite_path').notNull().default(''), // \x1f-delimited describe block path, e.g. 'Auth\x1fLogin'
    suiteId: integer('suite_id').references(() => testSuites.id), // FK to immediate parent describe block (null for root-level tests)
    title: text('title').notNull(),
    // The ID the team gives this test in its own test management tool (`piwi:id`, or read from the title with the
    // reporter's `externalId.pattern`). Matched before file + describe path + title, so a test keeps its history
    // when it is renamed or moved.
    externalId: text('external_id'),
    displayTitle: text('display_title'), // the title without its external ID, when the reporter is asked to remove it
    flakyRootCause: text('flaky_root_cause'), // 'timing' | 'network' | 'assertion' | 'environment' | 'order' | 'other'
    // Latest-known test-level tags and `piwi:` metadata, refreshed on every run
    // that reports this test. Per-execution truth lives on test_runs_cases;
    // these denormalized columns let project-wide views filter without a join.
    tags: text('tags', { mode: 'json' }), // string[] — normalized, '@' stripped
    locks: text('locks', { mode: 'json' }), // string[] — lock names this test most recently declared (best effort)
    owner: text('owner'),
    priority: text('priority'), // 'critical' | 'high' | 'medium' | 'low'
    feature: text('feature'),
    link: text('link'), // absolute http(s) URL
    bugReportId: integer('bug_report_id'), // the bug report this test reproduces (`piwi:bug`), once that report exists
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    filePathTitleIdx: index('idx_test_cases_file_path_title').on(
      table.projectId,
      table.filePath,
      table.suitePath,
      table.title,
    ),
    suiteIdIdx: index('idx_test_cases_suite').on(table.suiteId),
    ownerIdx: index('idx_test_cases_owner').on(table.projectId, table.owner),
    externalIdUnique: uniqueIndex('idx_test_cases_external_id')
      .on(table.projectId, table.externalId)
      .where(sql`external_id IS NOT NULL`),
  }),
);

// Quarantined tests — a test that still runs but no longer blocks a merge.
//
// Skipping a flaky test hides it: it stops running, so nothing ever proves it
// is fixed and the quarantine becomes permanent. Here a quarantined test keeps
// executing and keeps reporting; it is only excluded from the CI gate's
// verdict. That makes the exit ramp possible — consecutive passes are counted,
// and a release is proposed once the test has earned it.
export const quarantinedTests = sqliteTable(
  'quarantined_tests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Null while active; set when the test is let back out. */
    releasedAt: integer('released_at', { mode: 'timestamp' }),
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
export const failureClusters = sqliteTable(
  'failure_clusters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    fixLandedAt: integer('fix_landed_at', { mode: 'timestamp' }),
    fixCommit: text('fix_commit'), // commit of that run, when the reporter recorded one
    timeToResolutionMs: integer('time_to_resolution_ms'), // first seen → fix landed
    fixVerification: text('fix_verification'), // 'stopped-failing' | 'diagnosis-verified' | 'regressed'
    flakeEvidenceRunId: integer('flake_evidence_run_id'), // latest run in which every affected test passed at the commit the cluster last failed at: flake evidence, not a fix
    lastRerunDispatch: text('last_rerun_dispatch', { mode: 'json' }), // ClusterRerunDispatch — most recent "Re-run in CI" dispatch
    bisectResult: text('bisect_result', { mode: 'json' }), // BisectedCommit — first bad commit the desktop bisect found (sha, subject, author, date)
    // Inbox triage — orthogonal to `status`. A snooze hides a cluster from every
    // inbox queue until the deadline passes (or, in "until-recurs" mode, until a
    // new run adds an occurrence); `assignee` is the person a triager assigned it
    // to, taking precedence over the owner derived from the test's annotation.
    snoozedUntil: integer('snoozed_until', { mode: 'timestamp' }), // hidden from queues until this instant; null when not snoozed
    snoozeMode: text('snooze_mode'), // 'until' (wake at snoozedUntil) | 'until-recurs' (wake at snoozedUntil OR a new occurrence)
    assignee: text('assignee'), // person this cluster is assigned to (name or email); overrides the derived owner
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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

// Fingerprint → surviving cluster routing. When two clusters are merged (e.g. the
// embedding reconciler collapses near-duplicates), the absorbed cluster's
// fingerprint is recorded here so future failures with that fingerprint attach to
// the survivor instead of forking a fresh cluster.
export const failureClusterAliases = sqliteTable(
  'failure_cluster_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    clusterId: integer('cluster_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
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

// Per-test routing out of a cluster. Moving tests to a new cluster records, for
// each fingerprint that leads to the cluster they left, that their later failures
// with it join the new cluster instead.
export const failureClusterTestRoutes = sqliteTable(
  'failure_cluster_test_routes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    createdAt: integer('created_at', { mode: 'timestamp' })
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

// Proposed cluster merges awaiting human review. Surfaced when the
// embedding reconciler / LLM adjudicator find two clusters that are probably —
// but not certainly — the same root cause. Approving runs mergeFailureClusters.
export const clusterMergeSuggestions = sqliteTable(
  'cluster_merge_suggestions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Convention: clusterAId < clusterBId so a symmetric pair maps to one row.
    clusterAId: integer('cluster_a_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    clusterBId: integer('cluster_b_id')
      .notNull()
      .references(() => failureClusters.id, { onDelete: 'cascade' }),
    score: real('score'), // cosine similarity that surfaced the pair
    method: text('method').notNull(), // 'embedding' | 'llm'
    llmConfidence: text('llm_confidence'), // 'high' | 'medium' | 'low' (when method = 'llm')
    llmReason: text('llm_reason'), // adjudicator rationale
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'rejected'
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const failureDiagnoses = sqliteTable(
  'failure_diagnoses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    details: text('details', { mode: 'json' }), // full structured result: evidence, suggestedFix, preventionTips
    error: text('error'), // failure reason when status = 'failed'
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    feedback: text('feedback'), // 'up', 'down'
    feedbackNote: text('feedback_note'), // optional note from user
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    clusterScopeIdx: uniqueIndex('idx_failure_diagnoses_cluster_scope').on(table.clusterId, table.scope),
    executionIdx: uniqueIndex('idx_failure_diagnoses_execution').on(table.testRunsCaseId, table.scope),
  }),
);

// Diagnosis version history — snapshotted on each re-diagnose
export const failureDiagnosisVersions = sqliteTable(
  'failure_diagnosis_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    details: text('details', { mode: 'json' }),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    contextSha: text('context_sha'),
    feedback: text('feedback'), // 'up', 'down' — captured as of the snapshot
    feedbackNote: text('feedback_note'),
    createdAt: integer('created_at', { mode: 'timestamp' })
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
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Content-addressed storage for large per-execution text payloads (ARIA
// snapshots, test source snippets, source-frame JSON). One row per unique
// content per project — test_runs_cases rows reference payloads by id, so a
// test failing identically across many runs stores each payload once.
export const casePayloads = sqliteTable(
  'case_payloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(), // SHA-256 hex of content
    content: text('content').notNull(),
    size: integer('size').notNull(), // content length in characters, for storage stats
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectHashIdx: uniqueIndex('idx_case_payloads_project_hash').on(table.projectId, table.hash),
  }),
);

// Test runs cases table - junction table with run-specific data
export const testRunsCases = sqliteTable(
  'test_runs_cases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    repeatEachIndex: integer('repeat_each_index').notNull().default(0), // Playwright's repeatEachIndex: which `--repeat-each` repetition the row belongs to (0 without repeats)
    attempts: text('attempts', { mode: 'json' }), // Array of { retry, status, duration, startedAt } — per-attempt outcomes
    line: integer('line'), // line number in file
    column: integer('column'), // column number in file
    steps: text('steps', { mode: 'json' }), // Array of { title, duration, category, location?, startTime? } step objects
    stepEvents: text('step_events', { mode: 'json' }), // Array of { title, category, startedAt, duration, status, location } — hook/fixture steps for timeline
    slowestStep: text('slowest_step'), // Title of the slowest step
    slowestStepDuration: integer('slowest_step_duration'), // Duration of the slowest step in ms
    wastedTimeMs: integer('wasted_time_ms'), // Aggregated ms spent in wait steps
    webVitals: text('web_vitals', { mode: 'json' }), // { navigation: {...}, paint: {...} }
    resources: text('resources', { mode: 'json' }), // WireExecutionResources — what the execution cost its worker and browsers
    pageState: text('page_state', { mode: 'json' }), // URL/history/storage-keys/cookie-flags at test end (values never captured)
    aiUsage: text('ai_usage', { mode: 'json' }), // { entries: string[], intents?: {template,locator,kind}[] } — replayed AI-step artifacts + their prompts
    consoleLogs: text('console_logs', { mode: 'json' }), // Array of { type, text, timestamp, location } console entries
    dialogs: text('dialogs', { mode: 'json' }), // Array of { type, message, defaultValue, closedAt } browser dialogs
    evidenceSources: text('evidence_sources', { mode: 'json' }), // { console?, network?, aria?: 'trace' } — marks evidence recovered from the trace when the capture fixtures were absent
    // Inline payload columns: read, never written — rows store these payloads
    // content-addressed in case_payloads and reference them via the
    // *PayloadId columns below.
    ariaSnapshot: text('aria_snapshot'), // ARIA snapshot of the page (YAML-like string from locator.ariaSnapshot())
    ariaSnapshotJson: text('aria_snapshot_json'), // ARIA tree as JSON (from locator.ariaSnapshotJSON(), Playwright >= 1.63)
    testSource: text('test_source'), // Source snippet around the failing assertion (sent by reporter)
    testSourceFrames: text('test_source_frames', { mode: 'json' }), // Array<{ file, line, snippet }> — in-project call-stack frames (innermost first)
    ariaSnapshotPayloadId: integer('aria_snapshot_payload_id').references(() => casePayloads.id),
    ariaSnapshotJsonPayloadId: integer('aria_snapshot_json_payload_id').references(() => casePayloads.id),
    testSourcePayloadId: integer('test_source_payload_id').references(() => casePayloads.id),
    testSourceFramesPayloadId: integer('test_source_frames_payload_id').references(() => casePayloads.id),
    pageInventoryPayloadId: integer('page_inventory_payload_id').references(() => casePayloads.id), // Content-addressed page inventory (controls + links per visited page), passing runs
    locatorPagesPayloadId: integer('locator_pages_payload_id').references(() => casePayloads.id), // Content-addressed list of the page each locator call ran on (piwi-locator-pages)
    codeReachPayloadId: integer('code_reach_payload_id').references(() => casePayloads.id), // Content-addressed list of the source files the test executed (piwi-code-reach)
    coveragePayloadId: integer('coverage_payload_id').references(() => casePayloads.id), // Content-addressed list of the coverage fragments the execution recorded (coverage_fragments ids)
    browser: text('browser', { mode: 'json' }), // Playwright project/browser config: { projectName, browserName, channel, viewport }
    browserName: text('browser_name'), // Scalar browser identity (projectName) for index efficiency
    testAnnotations: text('test_annotations', { mode: 'json' }), // Array<{ type, description? }> — runtime test marks (@fixme, @slow …)
    tags: text('tags', { mode: 'json' }), // string[] — tags this execution declared ('@' stripped)
    locks: text('locks', { mode: 'json' }), // string[] — lock names this execution held (best effort; none from blob imports)
    testMeta: text('test_meta', { mode: 'json' }), // { owner?, priority?, feature?, link? } from `piwi:` annotations
    workerIndex: integer('worker_index'), // Parallel worker index (from Playwright's parallelIndex)
    shardIndex: integer('shard_index'), // Shard index (1-based) for sharded runs; null = not sharded
    startedAt: integer('started_at'), // Unix timestamp in ms when the test started (stored/read as a plain number)
    isNewRegression: integer('is_new_regression'), // boolean: passed in baseline, failed in this run
    isNewFlaky: integer('is_new_flaky'), // boolean: no retries in baseline, retry-pass in this run
    didNotRunReason: text('did_not_run_reason'), // Why a 'didnotrun' case never executed: 'previous-failure' | 'global-timeout' | 'max-failures' | 'interrupted'
    expectedStatus: text('expected_status'), // Playwright's expectedStatus: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
    blockedBy: text('blocked_by'), // For a 'previous-failure' cascade, the location (file:line:col) of the failing test that blocked it
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    // A run's executions are looked up on this index: PostgreSQL costs the same
    // lookup on the wider unique index below so high that a join reads the whole table.
    testRunIdIdx: index('idx_test_runs_cases_test_run_id').on(table.testRunId),
    // Composite: covers plain test_case_id lookups (prefix) and the
    // per-case recency sorts used by history/flakiness queries.
    testCaseCreatedIdx: index('idx_test_runs_cases_case_created').on(table.testCaseId, table.createdAt),
    failureClusterIdIdx: index('idx_test_runs_cases_failure_cluster_id').on(table.failureClusterId),
    runCaseBrowserUnique: uniqueIndex('idx_test_runs_cases_run_browser').on(
      table.testRunId,
      table.testCaseId,
      table.repeatEachIndex,
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
// Stores the latest element state and pre-computed alternative locators so
// that when a locator breaks, ranked replacements are immediately available.
export const locatorSnapshots = sqliteTable(
  'locator_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    uniqueLocation: uniqueIndex('idx_locator_snapshots_location').on(table.testCaseId, table.location),
    fingerprintIdx: index('idx_locator_snapshots_fp').on(table.testCaseId, table.usedMethod, table.usedArgsFp),
    // Cross-test healing looks a signature up across all of a project's cases.
    argsFpIdx: index('idx_locator_snapshots_args_fp').on(table.usedArgsFp),
    lastSeenRunIdx: index('idx_locator_snapshots_last_seen_run').on(table.lastSeenRunId),
  }),
);

// Locator usages — which locator chain each test used, from which call site, for
// which action. Built at ingest from the stored steps (Playwright reports the full
// chain on every locator step), one row per (test case, Playwright project, branch,
// call site, action, chain), with first/last seen runs. Answers "which tests use
// this locator" without any capture beyond the steps. A branch other than the
// default keeps its own rows, so a view of that branch replaces the default
// branch's uses for the tests that ran on it.
export const locatorUsages = sqliteTable(
  'locator_usages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    locator: text('locator').notNull(), // canonical chain, e.g. getByRole('form', { name: 'Shipping' }).getByLabel('Country')
    target: text('target').notNull(), // the last locating call of the chain, e.g. getByLabel('Country')
    action: text('action').notNull(), // click, fill, selectOption, expect.toHaveValue, …
    browserName: text('browser_name').notNull(), // Playwright project name of the execution, '' when unknown
    callSite: text('call_site').notNull(), // project-relative file:line:col, '' when unknown
    branch: text('branch').notNull().default(''), // '' = the project's default branch (or a run with none); else the run's own branch
    page: text('page').notNull().default(''), // page key the call ran on (`/orders/:id`, or origin + path off the app); '' when unknown
    arrival: integer('arrival', { mode: 'boolean' }).notNull().default(false), // the call ran on that page before any locator interaction there
    firstSeenRunId: integer('first_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
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

// Code reach: the application source files each test executed, one row per
// (test case, branch, runtime, file). Written on ingest from the files of the
// test's coverage, or from the reporter's `codeReach` list (browser files) when
// it sent no coverage; per runtime, the rows of a test's latest execution on a
// branch replace the previous ones. Route reach (a route's handler file) is
// read from the Test Map's edges instead of stored here.
export const codeReach = sqliteTable(
  'code_reach',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull().default(''), // '' = the project's default branch (or a run with none); else the run's own branch
    runtime: text('runtime').notNull().default('browser'), // where the file's code ran: 'browser' | 'server'
    file: text('file').notNull(), // repository-relative path
    origin: text('origin').notNull().default('client'), // 'client' for browser rows, 'server' for server rows
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    uniqueReach: uniqueIndex('idx_code_reach_unique').on(table.testCaseId, table.branch, table.runtime, table.file),
    projectFileIdx: index('idx_code_reach_project_file').on(table.projectId, table.file),
    lastSeenRunIdx: index('idx_code_reach_last_seen_run').on(table.lastSeenRunId),
  }),
);

// Coverage fragments: one file's coverage as one test recorded it (runtime,
// path, the git blob its lines refer to, the function and executed line
// ranges as `encodeLineRanges` text), content-addressed per project, so every
// test and execution that recorded the same coverage of a file shares one row.
// `last_seen_at` moves forward on each ingest that references the fragment.
export const coverageFragments = sqliteTable(
  'coverage_fragments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(), // SHA-256 hex of canonicalCoverageFile
    runtime: text('runtime').notNull(), // 'browser' | 'server'
    path: text('path').notNull(), // repository-relative path
    blob: text('blob'), // git blob id of the file version the line numbers refer to
    functions: text('functions'), // function ranges, `12-15,20`
    lines: text('lines'), // executed line ranges, `12-15,20`
    executable: text('executable'), // a coverage report's executable line ranges; null for a test's fragment
    allFunctions: text('all_functions'), // a coverage report's function ranges, run or not; null for a test's fragment
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectHashIdx: uniqueIndex('idx_coverage_fragments_project_hash').on(table.projectId, table.hash),
    projectPathIdx: index('idx_coverage_fragments_project_path').on(table.projectId, table.path),
  }),
);

// Test coverage: the fragments a test's latest run with coverage recorded on a
// branch, per runtime, one row per (test case, branch, fragment). Replaced like
// `code_reach`, whose rows are the files of these fragments.
export const testCoverage = sqliteTable(
  'test_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    branch: text('branch').notNull().default(''), // '' = the project's default branch (or a run with none); else the run's own branch
    runtime: text('runtime').notNull(), // the fragment's runtime: 'browser' | 'server'
    fragmentId: integer('fragment_id')
      .notNull()
      .references(() => coverageFragments.id, { onDelete: 'cascade' }),
    lastSeenRunId: integer('last_seen_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    uniqueCoverage: uniqueIndex('idx_test_coverage_unique').on(table.testCaseId, table.branch, table.fragmentId),
    fragmentIdx: index('idx_test_coverage_fragment').on(table.fragmentId),
    projectBranchIdx: index('idx_test_coverage_project_branch').on(table.projectId, table.branch),
    lastSeenRunIdx: index('idx_test_coverage_last_seen_run').on(table.lastSeenRunId),
  }),
);

// Run coverage: the coverage of a whole run per file, attributed to no test,
// as the reporter collects it at run end (merged across shards), with the
// executable line ranges of server files.
export const runCoverage = sqliteTable(
  'run_coverage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').notNull(), // the run's project
    runtime: text('runtime').notNull(), // 'browser' | 'server'
    path: text('path').notNull(), // repository-relative path
    blob: text('blob'), // git blob id of the file version the line numbers refer to
    functions: text('functions'), // function ranges, `12-15,20`
    lines: text('lines'), // executed line ranges, `12-15,20`
    executable: text('executable'), // executable line ranges (server files), `12-15,20`
  },
  (table) => ({
    uniqueFile: uniqueIndex('idx_run_coverage_unique').on(table.runId, table.runtime, table.path),
    projectPathIdx: index('idx_run_coverage_project_path').on(table.projectId, table.path),
  }),
);

// Executable lines per file version: the lines of every statement of one
// version (blob) of a file, as the span table of the build that compiled it
// lists them, and every function known in it (run or not). They depend on the
// file's content alone, so they are stored once per version: the union of what
// the run coverages naming the version sent.
export const coverageExecutable = sqliteTable(
  'coverage_executable',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runtime: text('runtime').notNull(), // 'browser' | 'server'
    path: text('path').notNull(), // repository-relative path
    blob: text('blob').notNull(), // git blob id of the file version
    lines: text('lines'), // executable line ranges, `12-15,20`
    functions: text('functions'), // every function's range, run or not, `12-15,20`
    createdAt: integer('created_at', { mode: 'timestamp' })
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
export const coverageReports = sqliteTable(
  'coverage_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    commit: text('commit_sha').notNull(), // full commit id, lowercase hex
    branch: text('branch').notNull().default(''), // '' = the project's default branch; else the branch it ran on
    suite: text('suite').notNull(), // the name the team uploads it under, e.g. 'unit-back'
    kind: text('kind').notNull(), // 'unit' | 'e2e'
    tool: text('tool'), // 'cobertura' | 'lcov' | 'piwi', with the writer when the report names it
    incomplete: integer('incomplete', { mode: 'boolean' }).notNull().default(false), // true when part of the report was left out (a cap, a file version that disagreed)
    fileCount: integer('file_count').notNull().default(0),
    inventoryPayloadId: integer('inventory_payload_id').references(() => casePayloads.id), // The commit's file inventory, `[[path, blob], ...]`
    inventoryCount: integer('inventory_count'), // How many files the inventory names; null without one
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const coverageReportFiles = sqliteTable(
  'coverage_report_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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

// Coverage totals: per project, commit and suite (`combined` for every suite
// together), the counts combined coverage computed on the commit's reference
// lines, recomputed after each upload and each run coverage of the commit.
// `scope_version` is the project's coverage scope version they were computed
// under; another version reads as stale. `commit_seen_at` is when the commit's
// coverage first arrived (its first report or run), the order commits follow;
// `computation_started_at` keeps an older computation from replacing a newer.
// `detail_removed_at` is when the commit's report files went (a newer commit
// superseded them, `superseded_by`): its totals are final from then on.
export const coverageTotals = sqliteTable(
  'coverage_totals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    incomplete: integer('incomplete', { mode: 'boolean' }).notNull().default(false),
    scopeVersion: integer('scope_version').notNull().default(0),
    commitSeenAt: integer('commit_seen_at', { mode: 'timestamp' }),
    computationStartedAt: integer('computation_started_at', { mode: 'timestamp_ms' }),
    computedAt: integer('computed_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    detailRemovedAt: integer('detail_removed_at', { mode: 'timestamp' }), // null while the commit's reports are kept
    supersededBy: text('superseded_by'), // the newer commit whose coverage made the reports go
  },
  (table) => ({
    uniqueSuite: uniqueIndex('idx_coverage_totals_unique').on(table.projectId, table.commit, table.suite, table.area),
    projectBranchIdx: index('idx_coverage_totals_project_branch').on(table.projectId, table.branch, table.commitSeenAt),
  }),
);

// Coverage per day: per project, day (UTC, `YYYY-MM-DD`), branch and suite, the
// totals of the last commit whose coverage arrived that day (`commit_seen_at`),
// for trends kept after the reports themselves are pruned.
export const coverageDaily = sqliteTable(
  'coverage_daily',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    commitSeenAt: integer('commit_seen_at', { mode: 'timestamp' }),
    computedAt: integer('computed_at', { mode: 'timestamp' })
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
export const runLocatorBreaks = sqliteTable(
  'run_locator_breaks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    locator: text('locator').notNull(), // canonical chain the diff breaks
    rewrite: text('rewrite'), // the same chain with the new string; null for a removal or a regex
    replacements: text('replacements', { mode: 'json' }), // Array<[before, after]> string arguments the rewrite changes
    anchor: text('anchor', { mode: 'json' }).notNull(), // DiffAnchor: file, line, kind, attribute?, key?, before, after?
    confidence: text('confidence').notNull(), // 'likely' | 'possible'
    callSites: text('call_sites', { mode: 'json' }).notNull(), // string[] — file:line:col of every use
    testCaseIds: text('test_case_ids', { mode: 'json' }).notNull(), // number[] — the tests that use the chain
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    runIdx: index('idx_run_locator_breaks_run').on(table.runId),
    projectIdx: index('idx_run_locator_breaks_project').on(table.projectId),
  }),
);

// Network requests table - normalized child table of test_runs_cases
// Stores one row per filtered network request (API/document types only).
// Normalized URLs enable endpoint-grouped stats without parsing JSON.
// Populated at ingest time alongside test_runs_cases.
export const networkRequests = sqliteTable(
  'network_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testRunsCaseId: integer('test_runs_case_id')
      .notNull()
      .references(() => testRunsCases.id, { onDelete: 'cascade' }),
    testRunId: integer('test_run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    url: text('url'), // Raw URL (query-params stripped by sanitizeUrl)
    normalizedUrl: text('normalized_url'), // Route pattern for grouping: ids collapsed, the query's names kept with their values redacted; a route node's key drops the query
    status: integer('status').notNull(),
    duration: integer('duration'), // Response time in ms
    startTime: integer('start_time'), // Request start, Unix timestamp in ms (null for older captures)
    resourceType: text('resource_type'), // 'fetch', 'xhr', 'document', 'other'
    contentType: text('content_type'), // Response content-type header
    serverLogs: text('server_logs', { mode: 'json' }), // Backend server logs from X-Piwi-Logs header
    serverTraces: text('server_traces', { mode: 'json' }), // Server-side spans from X-Piwi-Trace header
    failure: text('failure'), // Why the request failed (Playwright's error text, e.g. net::ERR_CONNECTION_RESET); null when it finished
    fulfilled: integer('fulfilled', { mode: 'boolean' }), // true when no server sent the response (the test's route handler fulfilled it, or a cache or service worker); null otherwise
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
// Playwright names resources by content hash, so the filename IS the dedup key
export const traceResources = sqliteTable(
  'trace_resources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // filename as stored in resources/ dir, e.g. "abc123.net"
    path: text('path').notNull(), // project-{id}/trace-resources/{name}
    size: integer('size').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectNameIdx: uniqueIndex('idx_trace_resources_project_name').on(table.projectId, table.name),
  }),
);

// Trace blobs table - content-addressed storage deduplicating trace files across runs
export const traceBlobs = sqliteTable(
  'trace_blobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    resourcesIndexed: integer('resources_indexed', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
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
export const traceBlobResources = sqliteTable(
  'trace_blob_resources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testRunId: integer('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }),
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'report', 'trace', 'screenshot', etc.
    subtype: text('subtype'), // 'html', 'monocart', 'blob' for reports; null for traces
    label: text('label'), // Display label e.g. 'HTML Report'
    path: text('path').notNull(), // Relative path in storage
    size: integer('size'), // File/directory size in bytes
    blobId: integer('blob_id').references(() => traceBlobs.id), // Set when the file is a deduplicated trace blob
    metadata: text('metadata', { mode: 'json' }), // Type-specific extras (e.g. visual-diff metrics)
    createdAt: integer('created_at', { mode: 'timestamp' })
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
export const integrationConnections = sqliteTable(
  'integration_connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider').notNull(), // 'jira' | 'confluence' | 'github-issues' | …
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    config: text('config', { mode: 'json' }), // provider-specific, non-secret (flavor, site id, default space…)
    credentials: text('credentials'), // AES-256-GCM JSON: { email, apiToken } | { token } | { pat }
    status: text('status').notNull().default('unverified'), // 'unverified' | 'ok' | 'failed'
    lastCheckedAt: integer('last_checked_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    managedBy: text('managed_by').notNull().default('db'), // 'db' | 'env'
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    providerIdx: index('idx_integration_connections_provider').on(t.provider),
  }),
);

// Entity links table - attach external URLs (Jira, GitHub, etc.) to runs, test-case runs, or test cases
export const entityLinks = sqliteTable(
  'entity_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    testRunId: integer('test_run_id').references(() => testRuns.id, { onDelete: 'cascade' }),
    testRunsCaseId: integer('test_runs_case_id').references(() => testRunsCases.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'cascade' }),
    failureClusterId: integer('failure_cluster_id').references(() => failureClusters.id, { onDelete: 'cascade' }),
    bugReportId: integer('bug_report_id').references(() => bugReports.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),

    // Detected nature — drives the icon
    provider: text('provider').notNull().default('generic'),
    // 'jira' | 'github-issue' | 'github-pr' | 'gitlab-issue' | 'gitlab-mr' |
    // 'bitbucket' | 'confluence' | 'slack' | 'linear' | 'notion' | 'generic'

    // Smart-link enrichment (best-effort; null until/if unfurled)
    key: text('key'), // compact id, e.g. 'PROJ-123' or '#456'
    title: text('title'), // fetched or user-supplied label
    statusText: text('status_text'), // e.g. 'In Progress', 'open', 'closed'
    statusColor: text('status_color'), // resolved badge color token (e.g. 'success')
    metadata: text('metadata', { mode: 'json' }), // raw unfurl payload
    unfurledAt: integer('unfurled_at', { mode: 'timestamp_ms' }), // last successful fetch

    // The connection that can read/write this record, and the tracker's stable id.
    connectionId: integer('connection_id').references(() => integrationConnections.id, { onDelete: 'set null' }),
    externalId: text('external_id'), // tracker's stable id (Jira issue id, not the key — keys change on move)
    origin: text('origin').notNull().default('pinned'), // 'pinned' | 'created' | 'annotation' | 'reporter'

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
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
export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    text: text('text').notNull().unique(),
    color: text('color').notNull().default('neutral'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    updatedAtIdx: index('idx_tags_updated_at').on(table.updatedAt),
  }),
);

// Project tags junction table
export const projectTags = sqliteTable(
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
export const markers = sqliteTable(
  'markers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(), // The event time; drives the chart x-position
    label: text('label').notNull(),
    description: text('description'),
    category: text('category').notNull().default('event'), // 'deploy', 'config', 'infra', 'incident', 'release', 'event'
    environment: text('environment'), // Optional scope; null = applies to all environments
    source: text('source').notNull().default('manual'), // 'manual' | 'auto'
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }), // Optional link to the run that triggered/relates to the marker
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    projectOccurredIdx: index('idx_markers_project_occurred').on(table.projectId, table.occurredAt),
    runIdIdx: index('idx_markers_run_id').on(table.runId),
  }),
);

// Users table - for authentication
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull().unique(),
    password: text('password').notNull(), // hashed password (empty string for OAuth-only users)
    role: text('role').notNull(), // InstanceRole: 'administrator' | 'member'
    name: text('name'), // Display name
    email: text('email'), // Email address (nullable; OAuth callback can populate it)
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    avatarUrl: text('avatar_url'), // Avatar from OAuth provider
    oauthProvider: text('oauth_provider'), // 'google', 'github', etc.
    oauthProviderId: text('oauth_provider_id'), // User ID from the OAuth provider
    // Incremented to revoke all of a user's existing sessions (password change/reset, role change, unlink).
    sessionEpoch: integer('session_epoch').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const accountTokens = sqliteTable(
  'account_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // 'reset' | 'verify' | 'invite'
    tokenHash: text('token_hash').notNull(), // SHA-256 of the emailed token
    // The address the token was sent to: it acts only while the account still holds it.
    email: text('email'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    hashIdx: uniqueIndex('idx_account_tokens_hash').on(t.tokenHash),
    userIdx: index('idx_account_tokens_user').on(t.userId),
  }),
);

// Notification channels table - a configured delivery destination (email / Slack / webhook)
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').notNull(), // 'email' | 'slack' | 'webhook'
    config: text('config', { mode: 'json' }), // { address } | { webhookUrl } | { url, secret (encrypted) }
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = global (admin-managed)
    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userIdx: index('idx_notification_channels_user').on(t.userId),
  }),
);

// Subscriptions table - who wants notifications for which projects/events
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = all projects
    events: text('events', { mode: 'json' }), // string[] of event keys
    filters: text('filters', { mode: 'json' }), // { branches?, tags?, statuses?, defaultBranchOnly?, flakinessThreshold?, perfRegressionPct? }
    mode: text('mode').notNull().default('realtime'), // 'realtime' | 'digest'
    digestAt: text('digest_at'), // 'HH:mm' UTC for daily digest
    mutedUntil: integer('muted_until', { mode: 'timestamp_ms' }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: text('payload', { mode: 'json' }),
    dedupeKey: text('dedupe_key'), // e.g. `${event}:${runId}:${channelId}` — prevents double-send
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'sent' | 'failed' | 'skipped'
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }), // digest batching / backoff / claim lease
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const healActions = sqliteTable(
  'heal_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull().default('open-pr'),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'opened' | 'merged' | 'closed' | 'failed' | 'skipped'
    attempts: integer('attempts').notNull().default(0),
    payload: text('payload', { mode: 'json' }).notNull(),
    result: text('result', { mode: 'json' }),
    error: text('error'),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const projectIntegrations = sqliteTable(
  'project_integrations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => integrationConnections.id, { onDelete: 'cascade' }),
    projectKey: text('project_key'), // Jira project key (tracker binding)
    issueType: text('issue_type'),
    labels: text('labels', { mode: 'json' }), // string[]
    defaultAssignee: text('default_assignee'), // account id / name
    locale: text('locale'), // ticket language for this project ('en' | 'fr'); overrides the connection default
    include: text('include', { mode: 'json' }), // { includeDiagnosis, includePatch, includeScreenshot, includeShareLink }
    policies: text('policies', { mode: 'json' }), // { commentOnFix, transitionOnFix, commentOnRegression, resolveOnClose, … }
    ownerRoutes: text('owner_routes', { mode: 'json' }), // { owner, projectKey?, componentId?, assigneeAccountId?, labels? }[]
    autoCreate: text('auto_create', { mode: 'json' }), // { enabled, minOccurrences, minRuns, dailyCap, routeUnmatched } — disabled by default
    fieldDefaults: text('field_defaults', { mode: 'json' }), // { [trackerFieldId]: { value, label } } — values for fields the tracker requires
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const integrationActions = sqliteTable(
  'integration_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }),
    error: text('error'),
    payload: text('payload', { mode: 'json' }).notNull(),
    result: text('result', { mode: 'json' }), // { key, url } | { commentId } | { pageId, version }
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
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
export const groups = sqliteTable(
  'groups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    description: text('description'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    createdByIdx: index('idx_groups_created_by').on(t.createdBy),
  }),
);

// Group members — one row per user in a group.
export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedBy: integer('added_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const roleBindings = sqliteTable(
  'role_bindings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // ProjectRole: 'viewer' | 'contributor' | 'maintainer' | 'project_admin' | 'uploader'
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const testFunctions = sqliteTable(
  'test_functions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // 'page-object-method' | 'helper' | 'fixture'
    module: text('module').notNull(), // import specifier, e.g. './pages/CartPage'
    receiver: text('receiver'), // instance variable name for page-object-method, e.g. 'cartPage'; null otherwise
    importName: text('import_name'), // class name to import + instantiate for page-object-method; null otherwise
    params: text('params').notNull(), // JSON: FunctionParam[]
    returnsPage: integer('returns_page', { mode: 'boolean' }).notNull().default(false),
    urlPattern: text('url_pattern'), // glob matched against a recorded step's page URL; null matches any page
    steps: text('steps').notNull(), // JSON: FunctionPatternStep[] — the DOM pattern this function drives
    paramSources: text('param_sources').notNull(), // JSON: FunctionParamSource[]
    source: text('source').notNull().default('manual'), // 'manual' | 'scanned' | 'recorded' | 'ai-extracted'
    confidence: real('confidence').notNull().default(1), // 0-1; 1 for manual/reviewed entries
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const testSelections = sqliteTable(
  'test_selections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // project-unique slug, e.g. 'smoke'
    name: text('name').notNull(),
    description: text('description'),
    definition: text('definition', { mode: 'json' }).notNull(), // SelectionDefinition
    version: integer('version').notNull().default(1),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const shareLinks = sqliteTable(
  'share_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // null for a report or a dashboard link, which can span several projects
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    entityKind: text('entity_kind').notNull(), // 'execution' | 'cluster' | 'report' | 'dashboard' (ShareLinkKind)
    entityId: integer('entity_id').notNull(), // test_runs_cases.id, failure_clusters.id, report_snapshots.id or analytics_dashboards.id
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 hash of the full psl_ token
    tokenPrefix: text('token_prefix').notNull(), // First 8 chars after "psl_" — shown in UI
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer('expires_at', { mode: 'timestamp' }), // null = no expiry
    revokedAt: integer('revoked_at', { mode: 'timestamp' }), // set on revoke; row kept for the audit trail
    lastViewedAt: integer('last_viewed_at', { mode: 'timestamp' }),
    viewCount: integer('view_count').notNull().default(0),
  },
  (table) => ({
    projectIdIdx: index('idx_share_links_project_id').on(table.projectId),
    entityIdx: index('idx_share_links_entity').on(table.entityKind, table.entityId),
    createdByIdx: index('idx_share_links_created_by').on(table.createdBy),
  }),
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // Human-readable label, e.g. "CI pipeline"
    keyHash: text('key_hash').notNull().unique(), // SHA-256 hash of the full key
    keyPrefix: text('key_prefix').notNull(), // First 8 chars after "pd_" prefix – shown in UI
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
  },
  (table) => ({
    userIdIdx: index('idx_api_keys_user_id').on(table.userId),
  }),
);

// Browser-extension connect requests (an RFC 8628 device authorization grant).
// Both codes are stored as SHA-256 hashes only. A row goes pending → approved or
// denied → consumed; the API key is created by the token call that consumes an
// approved row, so its plaintext is never stored.
export const extensionDeviceCodes = sqliteTable(
  'extension_device_codes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCodeHash: text('user_code_hash').notNull(),
    clientName: text('client_name').notNull(), // "Piwi Picker in Chrome on Windows"
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // who decided; null until then
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }), // the key the token call created
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const oauthClients = sqliteTable(
  'oauth_clients',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: text('client_id').notNull(),
    clientSecretHash: text('client_secret_hash'), // null for a public client
    clientName: text('client_name').notNull(), // what the client calls itself; shown on the consent page
    clientUri: text('client_uri'),
    redirectUris: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }), // last authorization or token request
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
export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    accessExpiresAt: integer('access_expires_at', { mode: 'timestamp_ms' }).notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    previousRefreshTokenHash: text('previous_refresh_token_hash'),
    refreshExpiresAt: integer('refresh_expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    refreshedAt: integer('refreshed_at', { mode: 'timestamp_ms' }),
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
export const oauthAuthorizationRequests = sqliteTable(
  'oauth_authorization_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const projectUrlPatterns = sqliteTable(
  'project_url_patterns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    environment: text('environment'), // free label: 'staging', 'production'
    branch: text('branch'), // the branch deployed at these URLs; null for the default branch
    pathPrefix: text('path_prefix'), // the path the site serves its pages under and the tests did not ('/app')
    testPathPrefix: text('test_path_prefix'), // the path the tests ran the pages under and the site does not ('/app')
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const graphNodes = sqliteTable(
  'graph_nodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'feature' | 'page' | 'control' | 'link' | 'route' | 'handler' | 'dependency' | 'file'
    key: text('key').notNull(), // stable identity within kind
    branch: text('branch'), // null = canonical (default-branch run); else the run's own branch
    attrs: text('attrs', { mode: 'json' }), // kind-specific extras; a feature carries { url_patterns, source }
    origin: text('origin').notNull().default('observed'), // 'observed' | 'manifest' | 'openapi' | 'convention' | 'import' | 'coverage' | 'usage' | 'manual'
    usage30d: integer('usage_30d'), // daily hit count from production instrumentation; null until usage is wired
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
    // Set when a staleness sweep removed the node's edges; the row is kept (a
    // soft delete) so first_seen survives a later re-appearance and surface
    // drift does not fire again. Cleared on the next ingest that sees the key.
    prunedAt: integer('pruned_at', { mode: 'timestamp_ms' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const graphEdges = sqliteTable(
  'graph_edges',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromKind: text('from_kind').notNull(),
    fromKey: text('from_key').notNull(),
    toKind: text('to_kind').notNull(),
    toKey: text('to_key').notNull(),
    kind: text('kind').notNull(), // 'links' | 'contains' | 'triggers' | 'loads' | 'handled-by' | 'calls' | 'imports' | 'groups' | 'reaches' | 'checks' | 'uses' | 'drives' | 'changes' | 'affects' | 'caused-by' | 'owns'
    branch: text('branch'), // null = canonical (default-branch run); else the run's own branch
    confidence: real('confidence'), // 0-1, how strongly the edge holds; null when unscored
    origin: text('origin').notNull().default('observed'),
    evidence: text('evidence', { mode: 'json' }), // edge-specific proof, e.g. { method, status }
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const scenarioGaps = sqliteTable(
  'scenario_gaps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('gap'), // 'gap' | 'finding'
    detector: text('detector').notNull(), // detector id that produced the row
    class: text('class').notNull(), // 'blind-spot' | 'false-comfort' | 'fragile' | 'unhandled' | 'degraded'
    key: text('key').notNull(), // stable identity within (project, detector)
    title: text('title').notNull(),
    evidence: text('evidence', { mode: 'json' }), // string[] — human-readable evidence lines
    factors: text('factors', { mode: 'json' }), // exposure factors: { churn, age, escapeHistory, priority }
    score: real('score'), // exposure × (1 − protection); ranked descending
    ticket: text('ticket'), // ticket id joined at change time
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    failureClusterId: integer('failure_cluster_id').references(() => failureClusters.id, { onDelete: 'set null' }),
    testRunId: integer('test_run_id'), // the run that surfaced the gap
    prNumber: integer('pr_number'), // the pull request the gap was reported on, at change time
    status: text('status').notNull().default('open'), // 'open' | 'snoozed' | 'dismissed' | 'accepted' | 'closed'
    dismissReason: text('dismiss_reason'), // 'not-worth-testing' | 'covered-elsewhere' | 'wrong'
    assignedTo: text('assigned_to'),
    triagedBy: integer('triaged_by').references(() => users.id, { onDelete: 'set null' }), // the user who last gave a triage verdict; null when auth is off
    snoozedUntil: integer('snoozed_until', { mode: 'timestamp_ms' }), // a snoozed gap wakes at this time; null with status snoozed = until the node changes
    snoozedAtSignature: text('snoozed_at_signature'), // the subject node's edge fingerprint when snoozed "until the node changes"; wakes once the node's shape differs
    acceptedAt: integer('accepted_at', { mode: 'timestamp_ms' }), // when a gap was accepted; feeds the accepted-but-unwritten inbox queue
    coveredAt: integer('covered_at', { mode: 'timestamp_ms' }), // when a gap was marked covered-by; a durable per-gap "for" verdict for detector precision
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
    closedByRunId: integer('closed_by_run_id'),
  },
  (table) => ({
    detectorKeyIdx: uniqueIndex('idx_scenario_gaps_detector_key').on(table.projectId, table.detector, table.key),
    projectStatusIdx: index('idx_scenario_gaps_project_status').on(table.projectId, table.status),
    projectScoreIdx: index('idx_scenario_gaps_project_score').on(table.projectId, table.score),
    prIdx: index('idx_scenario_gaps_pr').on(table.projectId, table.prNumber),
    testCaseIdx: index('idx_scenario_gaps_test_case').on(table.testCaseId),
    clusterIdx: index('idx_scenario_gaps_cluster').on(table.failureClusterId),
    triagedByIdx: index('idx_scenario_gaps_triaged_by').on(table.triagedBy),
  }),
);

// Probes — one row per (test, node, fault) probe outcome. A client probe
// mutates a response at the Playwright route boundary; a server probe sends
// a signed fault header. Each row writes or refreshes one `checks` edge from the
// test to the node with its outcome. Run ids are not foreign keys, matching the
// graph tables; the node id references the graph node the probe targeted.
export const probes = sqliteTable(
  'probes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    nodeId: integer('node_id').references(() => graphNodes.id, { onDelete: 'set null' }), // the route or dependency probed
    routeKey: text('route_key'), // the route node key, kept for lookups when the node row is pruned
    level: text('level').notNull().default('client'), // 'client' | 'server'
    fault: text('fault').notNull(), // 'status-500' | 'empty-body' | 'drop-field' | 'stale-value' | 'slow' | 'throw' | …
    applied: integer('applied', { mode: 'boolean' }).notNull().default(true), // client probes always true; server from X-Piwi-Trace
    outcome: text('outcome').notNull(), // 'noticed' | 'not-noticed' | 'inconclusive'
    handled: text('handled').notNull().default('n/a'), // 'graceful' | 'degraded' | 'unhandled' | 'n/a'
    runId: integer('run_id'), // the probe run that produced the outcome
    evidence: text('evidence', { mode: 'json' }), // { mutation, note } and any resilience signals
    probedAt: integer('probed_at', { mode: 'timestamp_ms' })
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
export const analyticsDailyRollups = sqliteTable(
  'analytics_daily_rollups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    durationMs: integer('duration_ms').notNull().default(0),
    avgTestDurationSumMs: integer('avg_test_duration_sum_ms').notNull().default(0),
    p90TestDurationSumMs: integer('p90_test_duration_sum_ms').notNull().default(0),
    durationRuns: integer('duration_runs').notNull().default(0), // runs with a duration: divides duration_ms
    testDurationRuns: integer('test_duration_runs').notNull().default(0), // runs with test durations: divides the two sums
    waitMs: integer('wait_ms').notNull().default(0),
    failedExecMs: integer('failed_exec_ms').notNull().default(0),
    newRegressions: integer('new_regressions').notNull().default(0),
    newFlaky: integer('new_flaky').notNull().default(0),
    computedAt: integer('computed_at', { mode: 'timestamp' })
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
export const handbackOutcomes = sqliteTable(
  'handback_outcomes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    details: text('details', { mode: 'json' }), // kind-specific facts (the recommended locator, the PR number, the diagnosis version)
    dedupeKey: text('dedupe_key').notNull(), // kind, subject, suggestion key, outcome and run
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const handbackOutcomeRollups = sqliteTable(
  'handback_outcome_rollups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // 'YYYY-MM-DD', UTC
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    channel: text('channel').notNull(),
    count: integer('count').notNull().default(0),
    computedAt: integer('computed_at', { mode: 'timestamp_ms' })
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
export const mcpToolCalls = sqliteTable(
  'mcp_tool_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null when the call named no project
    apiKeyId: integer('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }), // null for a session or with auth off
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    subjectType: text('subject_type'), // 'cluster', 'execution', 'gap', 'bug-report', 'run', 'test-case', 'suggestion', 'diagnosis'
    subjectId: integer('subject_id'),
    result: text('result').notNull(), // 'ok' | 'error'
    error: text('error'), // the error text an agent was given, truncated
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
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
export const gateEvaluations = sqliteTable(
  'gate_evaluations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha'),
    prNumber: integer('pr_number'), // null when the run names no pull request
    policy: text('policy', { mode: 'json' }).notNull(), // GatePolicy, plus maxUncoveredChanges and minPatchCoverage when asked
    policyHash: text('policy_hash').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    verdict: text('verdict').notNull(), // 'passed' | 'failed' | 'inconclusive'
    violations: text('violations', { mode: 'json' }).notNull(), // GateViolation[]
    clusterIds: text('cluster_ids', { mode: 'json' }), // number[]: the clusters of the run's new regressions, read for an escape
    source: text('source').notNull(), // 'cli' | 'api'
    evaluatedAt: integer('evaluated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    prState: text('pr_state'), // 'open' | 'merged' | 'closed'; null until the sweep reads it
    prSettledAt: integer('pr_settled_at', { mode: 'timestamp_ms' }), // when the host last updated the merged or closed pull request
    overridden: integer('overridden', { mode: 'boolean' }).notNull().default(false), // merged while its last gate evaluation failed
    escapedRunId: integer('escaped_run_id').references(() => testRuns.id, { onDelete: 'set null' }), // the default-branch run where a caught cluster failed again
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }), // the sweep's last look; null = never looked at
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
export const prFeedbackPosts = sqliteTable(
  'pr_feedback_posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    statuses: text('statuses', { mode: 'json' }).notNull(), // string[]: the commit status contexts the host accepted
    fixes: text('fixes', { mode: 'json' }), // VerifiedFix[]: the clusters the run verified as fixed, which a refreshed comment reports again; null before the first comment
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const analyticsDashboards = sqliteTable(
  'analytics_dashboards',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }), // null when authentication is off
    visibility: text('visibility').notNull().default('private'), // 'private' | 'shared'
    definition: text('definition', { mode: 'json' }).notNull(), // DashboardDefinition
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }) // the save precondition
      .notNull()
      .$defaultFn(() => new Date()),
    updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
    lastViewedAt: integer('last_viewed_at', { mode: 'timestamp_ms' }), // throttled; feeds the Unused group
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
export const reportSchedules = sqliteTable(
  'report_schedules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }), // null = global (admin-managed)
    scope: text('scope', { mode: 'json' }), // Partial<AnalyticsScope> applied over the dashboard's scope; the period comes from the cadence
    builtinDashboard: text('builtin_dashboard'), // 'overview' | 'executive' | 'engineering' | 'team' | 'gaps-digest'
    dashboardId: integer('dashboard_id').references(() => analyticsDashboards.id, { onDelete: 'set null' }), // a saved dashboard; set when builtin_dashboard is not
    cadence: text('cadence').notNull(), // 'daily' | 'weekly' | 'biweekly' | 'monthly'
    anchor: integer('anchor'), // weekday 1-7 (weekly, biweekly) or day of month 1-28 (monthly)
    at: text('at').notNull(), // 'HH:mm' in the instance time zone (UTC when that setting is auto)
    comparison: text('comparison').notNull().default('previous'), // 'previous' | 'year-ago' | 'none'
    includeShareLink: integer('include_share_link', { mode: 'boolean' }).notNull().default(false),
    includeNarrative: integer('include_narrative', { mode: 'boolean' }).notNull().default(false), // the AI narrative, off by default
    language: text('language'), // 'en' | 'fr' | null (project or instance default)
    channelIds: text('channel_ids', { mode: 'json' }), // number[] of notification_channels
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    mutedUntil: integer('muted_until', { mode: 'timestamp_ms' }),
    lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
    nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
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
export const reportSnapshots = sqliteTable(
  'report_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scheduleId: integer('schedule_id').references(() => reportSchedules.id, { onDelete: 'set null' }), // null = generated by hand
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    dashboardRef: text('dashboard_ref').notNull(),
    dashboardName: text('dashboard_name').notNull(),
    scope: text('scope', { mode: 'json' }), // the AnalyticsScope the bundle was collected over
    projectIds: text('project_ids', { mode: 'json' }), // number[] the bundle covers; null = every project
    periodFrom: integer('period_from', { mode: 'timestamp_ms' }).notNull(),
    periodTo: integer('period_to', { mode: 'timestamp_ms' }).notNull(),
    comparisonFrom: integer('comparison_from', { mode: 'timestamp_ms' }),
    comparisonTo: integer('comparison_to', { mode: 'timestamp_ms' }),
    bundle: text('bundle', { mode: 'json' }).notNull(), // ReportBundle
    sizeBytes: integer('size_bytes').notNull().default(0),
    generatedAt: integer('generated_at', { mode: 'timestamp_ms' })
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
export type FailureClusterAlias = typeof failureClusterAliases.$inferSelect;
export type NewFailureClusterAlias = typeof failureClusterAliases.$inferInsert;
export type ClusterMergeSuggestion = typeof clusterMergeSuggestions.$inferSelect;
export type NewClusterMergeSuggestion = typeof clusterMergeSuggestions.$inferInsert;
export type FailureDiagnosis = typeof failureDiagnoses.$inferSelect;
export type NewFailureDiagnosis = typeof failureDiagnoses.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type TraceBlob = typeof traceBlobs.$inferSelect;
export type NewTraceBlob = typeof traceBlobs.$inferInsert;
export type CasePayload = typeof casePayloads.$inferSelect;
export type NewCasePayload = typeof casePayloads.$inferInsert;
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
export type HealActionRow = typeof healActions.$inferSelect;
export type NewHealActionRow = typeof healActions.$inferInsert;
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
export type TestSelection = typeof testSelections.$inferSelect;
export type NewTestSelection = typeof testSelections.$inferInsert;
export type GraphNode = typeof graphNodes.$inferSelect;
export type NewGraphNode = typeof graphNodes.$inferInsert;
export type GraphEdge = typeof graphEdges.$inferSelect;
export type NewGraphEdge = typeof graphEdges.$inferInsert;
export type ScenarioGap = typeof scenarioGaps.$inferSelect;
export type NewScenarioGap = typeof scenarioGaps.$inferInsert;
export type Probe = typeof probes.$inferSelect;
export type NewProbe = typeof probes.$inferInsert;

// Bug reports: a steps document with the assertion that states the correct
// behavior, and the evidence collected on the page, sent from Piwi Picker.
// Screenshots live in storage under `bug-reports/<id>/`; `evidence.screenshots`
// names them. Status: 'open' | 'test-committed' | 'looks-fixed' | 'closed' | 'dismissed'.
export const bugReports = sqliteTable(
  'bug_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note'),
    pageKey: text('page_key'),
    path: text('path'),
    origin: text('origin'),
    status: text('status').notNull().default('open'),
    steps: text('steps', { mode: 'json' }).notNull(), // PiwiSteps
    evidence: text('evidence', { mode: 'json' }).notNull(), // BugEvidence
    context: text('context', { mode: 'json' }).notNull(), // BugContext
    language: text('language'), // the language the report was written in (`en`, `fr`, …)
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    testCaseId: integer('test_case_id').references(() => testCases.id, { onDelete: 'set null' }),
    statusRunId: integer('status_run_id').references(() => testRuns.id, { onDelete: 'set null' }), // the run that last moved the status
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    closedByRunId: integer('closed_by_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const bugReproductions = sqliteTable(
  'bug_reproductions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    createdAt: integer('created_at', { mode: 'timestamp' })
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
export const flakeExperiments = sqliteTable(
  'flake_experiments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    testCaseId: integer('test_case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'reproduce' | 'verify'
    commit: text('commit_sha'), // the commit the lab ran
    failureCommit: text('failure_commit_sha'), // the commit of the test's latest failure when planned
    source: text('source').notNull().default('cli'), // 'cli' | 'desktop' | 'ci'
    machine: text('machine'),
    playwrightProject: text('playwright_project'),
    verdict: text('verdict'), // reproduce: 'reproduced' | 'amplified' | 'not-reproduced'; verify: 'verified' | 'still-fails' | 'inconclusive'
    reproducingArmId: integer('reproducing_arm_id'), // the flake_arms row that reproduced (reproduce) or was rerun (verify)
    verifiesArmId: integer('verifies_arm_id'), // verify only: the reproducing arm of an earlier experiment it reruns
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    testCaseIdx: index('idx_flake_experiments_test_case').on(t.testCaseId, t.createdAt),
    projectIdx: index('idx_flake_experiments_project').on(t.projectId),
  }),
);

// The arms of a flake-lab experiment: the control and one row per condition set,
// with the counts the command line measured and the verdict the server computed.
export const flakeArms = sqliteTable(
  'flake_arms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    experimentId: integer('experiment_id')
      .notNull()
      .references(() => flakeExperiments.id, { onDelete: 'cascade' }),
    armKey: text('arm_key').notNull(), // the plan's arm id: 'control', 'suspect-1', 'combined', 'verify'
    position: integer('position').notNull().default(0),
    suspectId: text('suspect_id'), // the flake profile suspect it tests (`slow-route:GET /api/cart`)
    label: text('label').notNull(),
    conditions: text('conditions', { mode: 'json' }).notNull(), // FlakeCondition[] in the plan-file shape
    runs: integer('runs').notNull().default(0),
    matchingFailures: integer('matching_failures').notNull().default(0),
    otherFailures: integer('other_failures').notNull().default(0),
    discardedRounds: integer('discarded_rounds').notNull().default(0), // alongside/after rounds without the overlap or order asked for
    stoppedEarly: integer('stopped_early', { mode: 'boolean' }).notNull().default(false),
    pValue: real('p_value'), // one-sided Fisher exact against the control; null on the control
    verdict: text('verdict'), // null on the control
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
export const resourceFindings = sqliteTable(
  'resource_findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
    occurrences: integer('occurrences').notNull().default(0), // runs it showed in
    status: text('status').notNull().default('open'), // 'open' | 'fixed'
    cleanRuns: integer('clean_runs').notNull().default(0), // full default-branch runs without it since it last showed
    lastCheckedRunId: integer('last_checked_run_id'), // the last run that counted as clean, so a retried finish counts once
    fixedRunId: integer('fixed_run_id'), // the first run without it since it last showed; it is fixed there once five came
    fixedAt: integer('fixed_at', { mode: 'timestamp' }),
    reopenedRunId: integer('reopened_run_id'), // the run it showed in again after it was fixed
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const resourceOccurrences = sqliteTable(
  'resource_occurrences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
export const testRunResourceReports = sqliteTable(
  'test_run_resource_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    shard: integer('shard').notNull().default(0),
    report: text('report', { mode: 'json' }).notNull(), // rebuilt field by field on ingest (shared/resource-report.ts)
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
export const runDeliveries = sqliteTable(
  'run_deliveries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deliveryKey: text('delivery_key').notNull(),
    runId: integer('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    projectKeyIdx: uniqueIndex('idx_run_deliveries_project_key').on(t.projectId, t.deliveryKey),
    runIdx: index('idx_run_deliveries_run_id').on(t.runId),
  }),
);
