/**
 * Single source of truth for every `PIWI_*` environment variable the
 * application understands. Each entry pairs the variable name (the object key,
 * so it is a compile-time-checked literal) with a human description, a
 * functional category, and the machine-readable metadata (type, default,
 * clamping range, version range, relevance/requirement conditions) that powers
 * the configuration reference and generator on the docs site.
 *
 * Consumed by:
 * - `docs/scripts/generate-configuration.mjs` — generates the entire
 *   `docs/configuration.md` reference page from this registry at docs build
 *   time. The page is NOT hand-written; edit this file instead.
 * - `docs/.vitepress/components/EnvWizard.vue` — the interactive configuration
 *   generator on the docs site reads this registry directly.
 * - `shared/help-content.ts` — `HelpTopic.envVars` is typed as
 *   `PiwiEnvVarName[]`, so a help tooltip can never reference an env var that
 *   does not exist here.
 * - `shared/settings-metadata.ts` — settings fields reference env vars by
 *   typed name.
 * - `app/components/shared/EnvManagedBadge.vue` / `EnvManagedAlert.vue` —
 *   tooltips/banners render the name + description.
 * - server utils may read descriptions for logging/validation.
 *
 * When you add a new `PIWI_*` var to `nuxt.config.ts` or a server util, add it
 * here in the same change — and stamp it with `since: '<next release>'` so the
 * docs generator can filter by server version (a unit test enforces this for
 * vars added after the baseline). Defaults recorded here are asserted against
 * the real code constants by `tests/unit/piwi-env-vars.test.ts`.
 *
 * Note: the reporter package (`reporter/src/internal/config/env.ts`) has its
 * own `PIWI_ENV_KEYS` map for the vars it reads in CI — those overlap with the
 * ingestion vars here but are owned by the reporter, not this registry. So are
 * `PIWI_ORIGIN` and `PIWI_ORIGIN_REF`, which a launcher sets on the Playwright
 * process to stamp the run's origin: the app reads them only as the run's
 * `piwiOrigin` metadata (`shared/run-eligibility.ts`), and the test metadata
 * reference documents them.
 */

import {
  DEFAULT_INTEGRATIONS_SYNC_MINUTES,
  MIN_INTEGRATIONS_SYNC_MINUTES,
  MAX_INTEGRATIONS_SYNC_MINUTES,
} from '#shared/integrations/sync-config';

export type PiwiEnvVarCategory =
  | 'general'
  | 'localization'
  | 'database'
  | 'storage'
  | 'auth'
  | 'oauth'
  | 'ai'
  | 'ai-limits'
  | 'ai-steps'
  | 'assistant'
  | 'ingest'
  | 'export'
  | 'markers'
  | 'clustering'
  | 'smtp'
  | 'integrations'
  | 'testing'
  | 'wasted-time'
  | 'demo'
  | 'build'
  | 'desktop'
  | 'test';

/** How a variable's string value is interpreted by the server. */
export type PiwiEnvVarType = 'string' | 'boolean' | 'number' | 'enum' | 'url' | 'path' | 'list';

/**
 * Condition map used by `relevantWhen` / `requiredWhen`. Keys are env var
 * names (validated against the registry by a unit test — the type stays
 * `string` to avoid a circular type reference). Values match against the
 * OTHER variable's effective value (its configured value, falling back to its
 * default):
 * - `'*'`  — the other variable is set to any non-empty value
 * - `''`   — the other variable is unset/empty
 * - other  — exact string match
 */
export type PiwiEnvVarCondition = Readonly<Record<string, string>>;

export interface PiwiEnvVarMeta {
  /** Short human description of what the variable controls. */
  description: string;
  /** Functional grouping used for filtering/docs anchors. */
  category: PiwiEnvVarCategory;
  /** Whether the value is a secret (API key / password). Never logged or returned by the API. */
  secret?: boolean;
  /** True for build/test-harness-only vars that are not runtime settings. */
  runtimeOnly?: boolean;
  /** Value type. Defaults to 'string' when omitted. */
  type?: PiwiEnvVarType;
  /** Allowed values when `type` is 'enum'. */
  enum?: readonly string[];
  /**
   * Effective default applied by the server when the variable is unset, as the
   * env string a user would write. Omitted when there is no fixed default
   * (never set, or the default is conditional — see `notes`).
   */
  default?: string;
  /** Example value shown as a placeholder in the generator. */
  example?: string;
  /** Lower clamp/validity bound for 'number' vars (values below are raised/ignored). */
  min?: number;
  /** Upper clamp bound for 'number' vars (values above are lowered). */
  max?: number;
  /**
   * First release (semver) whose server understands this variable. Omitted for
   * baseline variables that predate version tracking (0.14.0 and earlier).
   */
  since?: string;
  /** First release (semver) that removed the variable — exclusive bound. */
  until?: string;
  /** The variable only has an effect when this condition holds. */
  relevantWhen?: PiwiEnvVarCondition;
  /** The server requires this variable when this condition holds. */
  requiredWhen?: PiwiEnvVarCondition;
  /** Docs-site page (+ optional `#anchor`) with the full story, e.g. 'storage#s3'. */
  docs?: string;
  /** Behavioral fine print appended to the description in the reference table. */
  notes?: string;
}

export interface PiwiEnvVarCategoryMeta {
  /** Section title as rendered on the configuration reference page. */
  title: string;
  /** Section order on the reference page and in the generator. */
  order: number;
  /** Intro prose (markdown) rendered under the section heading. */
  intro?: string;
  /** Trailing prose (markdown) rendered after the section table. */
  note?: string;
  /** Render this category's rows inside another category's section/table. */
  mergeInto?: PiwiEnvVarCategory;
  /** Internal harness vars: excluded from the reference table and generator. */
  internal?: boolean;
}

/** Display metadata for every category, driving the generated reference page. */
export const PIWI_ENV_CATEGORIES: Record<PiwiEnvVarCategory, PiwiEnvVarCategoryMeta> = {
  general: { title: 'General', order: 1 },
  localization: {
    title: 'Localization',
    order: 1.5,
    intro:
      'Controls how dates and times are formatted (day/month order, 12h vs 24h) and which time zone they display in. When set, these lock the instance-default fields in **Settings → Localization**; each viewer can still pick their own format there, overriding the instance default in their own browser.',
    note: "Values are a BCP-47 locale (e.g. `fr-FR`) or an IANA time zone (e.g. `Europe/Paris`); the keyword `auto` follows the viewer's browser. See [Localization](/operate/localization).",
  },
  database: {
    title: 'Database',
    order: 2,
    intro:
      'Piwi uses SQLite by default. Setting `PIWI_DATABASE_URL` switches it to PostgreSQL; migrations run automatically on startup.',
    note: 'See [Database](/operate/database) for SQLite versus PostgreSQL and [Storage → Data retention](/operate/storage#data-retention) for how the nightly sweep works.',
  },
  storage: {
    title: 'Storage',
    order: 3,
    intro: 'Controls where test artifacts (HTML reports, traces, attachments) are stored.',
    note: 'Full details and IAM examples: [Storage & retention](/operate/storage).',
  },
  auth: {
    title: 'Authentication',
    order: 4,
    intro:
      'Authentication is optional and off by default. When disabled, all endpoints behave as a single virtual administrator.',
    note: '> Behind a reverse proxy, set `PIWI_SITE_URL` so the OAuth `redirect_uri` is built from your public URL and matches what you registered with the provider (instead of being inferred from the request `Host`).\n\nSee [Authentication](/operate/authentication) for instance roles, [API keys](/operate/api-keys) for keys, and [Access, roles and groups](/operate/project-access) for project roles and groups.',
  },
  oauth: { title: 'OAuth (SSO)', order: 5, mergeInto: 'auth' },
  'wasted-time': {
    title: 'Wasted time',
    order: 6,
    intro:
      'Controls which Playwright wait steps are counted as "wasted time" on the run timeline and in per-test/run totals. Classification happens when a run is viewed, so changing it re-classifies historical runs immediately.',
    note: 'When unset, configure the patterns from **Settings → Wasted time** (administrator only). The default counts only explicit `waitForTimeout` sleeps, since framework-injected waits (load-state, wait-for-function) are usually unavoidable.',
  },
  ai: {
    title: 'AI diagnosis',
    order: 7,
    intro:
      '`PIWI_AI_PROVIDER` is the master switch: when it is set, AI configuration is environment-managed (the Settings UI shows the fields read-only) and the other `PIWI_AI_*` variables apply. When it is unset, AI diagnosis is configured from **Settings → AI** instead and the variables below are ignored.',
    note: 'See [AI diagnosis](/features/ai-diagnosis) for how diagnosis, the research stage, and semantic clustering work.',
  },
  'ai-limits': {
    title: 'AI context limits',
    order: 8,
    intro:
      'Cap how much evidence (and how many tokens) go into each AI diagnosis. Resolution order: defaults ← values stored from **Settings → AI** ← environment; the environment wins and locks the field in the UI. Values are clamped to the min–max range; a `0` disables a section only where the minimum is `0`.',
    note: 'See [AI provider → Context limits](/guide/ai-provider#context-limits-and-token-cost) for how the caps work.',
  },
  'ai-steps': {
    title: 'AI steps',
    // Sits between the diagnosis limits (8) and ingest limits (9); a fractional
    // order keeps it there without renumbering every later category.
    order: 8.5,
    intro:
      "Bounds on the reporter's AI-step **authoring** pass (`page.piwiLocator(...)` / `page.piwiRun(...)` in `resolve`/`heal` mode), which calls the model through this server. They cap how much of the page snapshot and how many output tokens go into each authoring iteration. They never apply during normal `replay` runs, which make no model calls. Values are clamped to the min–max range.",
    note: 'Reasoning models spend output tokens on hidden chain-of-thought, so raise `PIWI_AI_STEP_MAX_OUTPUT_TOKENS` for them. See [AI steps](/features/ai-steps) for the full authoring/replay model and the reporter-side `PIWI_AI*` options.',
  },
  assistant: {
    title: 'Assistant',
    order: 8.7,
    intro:
      "Bounds on the in-app assistant: how many tools it may call and how long it may take for one question, how many tokens one model call may write, and how many tokens it may spend in 24 hours, per user and for the instance. A cap reached stops the turn before the next model call. Values are clamped to the min–max range; `0` turns a daily cap off. The assistant's model is the `PIWI_AI_ASSISTANT_*` role above.",
    note: 'See [Assistant](/features/assistant) for what it reads and what leaves the instance.',
  },
  ingest: {
    title: 'Ingest limits',
    order: 9,
    intro:
      'Caps applied to per-execution payloads (console output, steps, ARIA snapshots, error text, source snippets) before they are stored. They bound database growth against verbose or hostile submitters; values above each limit are truncated with a visible marker. Distinct from the `PIWI_AI_MAX_*` limits, which bound what enters an AI diagnosis prompt — the storage defaults sit at or above the AI maxima so the AI limits stay the binding constraint for prompts. Environment-only (no settings UI).',
  },
  export: {
    title: 'Offline export',
    order: 10,
    intro:
      'Bounds on the offline export of a test execution or a failure cluster (HTML, ZIP, PDF). Evidence that does not fit is listed in the report as omitted rather than dropped silently. The total cap is also the memory an export costs to build, since the archive is assembled before it is sent.',
  },
  markers: { title: 'Timeline markers', order: 11 },
  smtp: {
    title: 'Email (SMTP)',
    order: 12,
    intro:
      'Required for email notifications and account flows (verification, password reset, invites). Set via environment only.',
    note: 'Email sending activates once `PIWI_SMTP_HOST` and `PIWI_SMTP_FROM` are set; add `PIWI_SMTP_USER`/`PIWI_SMTP_PASS` when the server requires authentication. See [Notifications](/features/notifications) for channels and subscriptions.',
  },
  integrations: {
    title: 'Integrations',
    order: 13,
    intro:
      'Connect an issue tracker so pinned links unfurl and stay in sync. Setting `PIWI_JIRA_BASE_URL`, `PIWI_JIRA_EMAIL` and `PIWI_JIRA_API_TOKEN` creates a read-only, environment-managed Jira Cloud connection; otherwise connections are managed from **Settings → Integrations**.',
    note: 'A connection base URL is administrator-supplied and trusted, so a self-hosted Jira on a private host works. See [Integrations](/operate/integrations).',
  },
  clustering: {
    title: 'Failure clustering',
    order: 14,
    intro:
      'Tunes the similarity thresholds used when grouping failures into clusters by their error fingerprint (and optional embeddings). Only used when an embedding model is configured.',
    note: 'See [Failure clusters → How failures are grouped](/features/failure-clusters#how-failures-are-grouped).',
  },
  testing: {
    title: 'Backend logs',
    order: 15,
    intro:
      'Controls the `X-Piwi-Logs` response-header capture that attaches backend logs to test failures. See [Backend logs](/guide/backend-logs).',
  },
  build: {
    title: 'Build-time',
    order: 16,
    intro:
      'These affect how the app is built rather than how a running instance behaves, and are mostly for contributors.',
  },
  demo: { title: 'Demo', order: 17, mergeInto: 'build' },
  test: { title: 'Test harness', order: 18, internal: true },
  desktop: { title: 'Desktop app', order: 19, internal: true },
};

export const PIWI_ENV_VARS = {
  // ── General ──────────────────────────────────────────────────────────────
  PIWI_SITE_URL: {
    description: 'Public base URL of the instance (e.g. https://piwi.example.com). Used to build links in emails.',
    category: 'general',
    type: 'url',
    example: 'https://piwi.example.com',
    notes:
      'When unset, links in emails point to http://localhost:3000 (on Fly.io, to https://<app>.fly.dev, from `FLY_APP_NAME`) and OAuth callback URLs are inferred from the request host — set it when running behind a reverse proxy.',
  },
  PIWI_SECRET_KEY: {
    description:
      'Master key for AES-256-GCM encryption of secrets stored in the database (AI API keys, SCM tokens, webhook and integration secrets). Required before the dashboard can save any of them.',
    category: 'general',
    secret: true,
    example: 'a 64-char random hex string',
    notes:
      "Unset, or set to the built-in development key, the dashboard cannot save a secret: the save answers HTTP 409 with a message naming this variable. Generate one with `node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"`.",
  },
  // ── Localization ─────────────────────────────────────────────────────────
  PIWI_LOCALE: {
    description:
      'Instance-default BCP-47 locale for formatting dates and times (e.g. "fr-FR" → 22/09/2026 14:30). The keyword "auto" follows each viewer\'s browser. Unset keeps the built-in en-US format.',
    category: 'localization',
    example: 'fr-FR',
    since: '0.36.0',
    docs: 'operate/localization',
    notes:
      'When set, the instance-default locale is locked in Settings → Localization (read-only), but each viewer can still override the format for their own browser. Any valid BCP-47 tag works, not only the ones the settings dropdown lists.',
  },
  PIWI_TIME_ZONE: {
    description:
      'Instance-default IANA time zone dates and times are shown in (e.g. "Europe/Paris"). The keyword "auto" (the default) uses each viewer\'s own browser time zone.',
    category: 'localization',
    example: 'Europe/Paris',
    since: '0.36.0',
    docs: 'operate/localization',
    notes:
      'When set, the instance-default time zone is locked in Settings → Localization (read-only), but each viewer can still override it for their own browser.',
  },

  PIWI_BUILD_DIR: {
    description: 'Overrides the Nuxt build output directory. Used by the test harness to isolate parallel builds.',
    category: 'build',
    runtimeOnly: true,
    type: 'path',
  },
  PIWI_BUILD_SHA: {
    description: 'Commit SHA baked into the build for provenance. Shown on Settings → About. Set as a build-time arg.',
    category: 'build',
    runtimeOnly: true,
  },
  PIWI_DESKTOP_TOKEN: {
    description:
      'Per-install access token the desktop (Tauri) app injects to gate its local server. Set automatically by the desktop shell — not user-configurable. Absent on the server build.',
    category: 'desktop',
    secret: true,
    runtimeOnly: true,
    since: '0.16.0',
  },
  PIWI_DESKTOP_LAUNCH_NONCE: {
    description:
      'Random value the desktop (Tauri) app gives its local server at each launch; `/api/health` echoes it so the app only loads its session from the server it started. Set automatically by the desktop shell — not user-configurable. Absent on the server build.',
    category: 'desktop',
    secret: true,
    runtimeOnly: true,
    since: '0.55.1',
  },

  // ── Database ─────────────────────────────────────────────────────────────
  PIWI_DATABASE_PATH: {
    description: 'Path to the SQLite database file (used when PIWI_DATABASE_URL is not set).',
    category: 'database',
    type: 'path',
    default: '.data/piwi.db',
    relevantWhen: { PIWI_DATABASE_URL: '' },
  },
  PIWI_DATABASE_URL: {
    description:
      'PostgreSQL connection string. When set, PostgreSQL is used instead of SQLite and migrations run automatically on startup.',
    category: 'database',
    secret: true,
    example: 'postgres://piwi:piwi@db:5432/piwi',
    docs: 'operate/database#postgresql',
  },
  PIWI_RETENTION_DAYS: {
    description:
      'Days of test-run history the nightly retention sweep keeps. Unset or 0 disables automatic run pruning (the default — pruning is opt-in). Kept runs are never pruned.',
    category: 'database',
    type: 'number',
    min: 0,
    docs: 'operate/storage#data-retention',
  },
  PIWI_RETENTION_MIN_RUNS: {
    description:
      'Newest runs of each project that age-based pruning (the nightly sweep and the manual cleanup) always leaves in place, however old — so a project that stops reporting keeps its last runs. Unset or 0 sets no floor.',
    category: 'database',
    type: 'number',
    default: '0',
    min: 0,
    docs: 'operate/storage#data-retention',
    since: '0.38.0',
  },
  PIWI_RETENTION_NOTIFICATION_DAYS: {
    description:
      "Days to keep sent/failed notification outbox rows before the nightly sweep prunes them (default 30; 0 keeps them forever). Settled auto-heal and integration actions and the agents' write log follow the same horizon.",
    category: 'database',
    type: 'number',
    default: '30',
    min: 0,
  },
  PIWI_RETENTION_REPORT_DAYS: {
    description:
      'Days to keep report snapshots (the stored quality reports on the Reports page) before the nightly sweep prunes them (default 365; 0 keeps them forever).',
    category: 'database',
    type: 'number',
    default: '365',
    min: 0,
    since: '0.39.0',
    docs: 'features/quality-reports#report-schedules',
  },
  PIWI_ASSISTANT_RETENTION_DAYS: {
    description:
      'Days an assistant conversation is kept after its last message before the nightly sweep deletes it (default 90; 0 keeps them forever). The assistant usage counted in Settings → AI follows the same horizon.',
    category: 'database',
    type: 'number',
    default: '90',
    min: 0,
    since: '0.59.0',
    docs: 'features/assistant#privacy',
  },
  PIWI_RETENTION_DIAGNOSIS_VERSIONS: {
    description:
      'AI-diagnosis history versions kept per diagnosis by the nightly sweep (default 20; 0 disables capping).',
    category: 'database',
    type: 'number',
    default: '20',
    min: 0,
  },

  // ── Storage ──────────────────────────────────────────────────────────────
  PIWI_STORAGE_TYPE: {
    description: 'Storage backend for test artifacts (HTML reports, traces, attachments): "local" or "s3".',
    category: 'storage',
    type: 'enum',
    enum: ['local', 's3'],
    default: 'local',
    notes: 'Only the exact value `s3` selects S3; any other value falls back to local storage.',
  },
  PIWI_STORAGE_PATH: {
    description: 'Directory for local file storage (when PIWI_STORAGE_TYPE is "local").',
    category: 'storage',
    type: 'path',
    default: '.data/storage',
    relevantWhen: { PIWI_STORAGE_TYPE: 'local' },
  },
  PIWI_S3_BUCKET: {
    description: 'S3 bucket name for artifact storage (when PIWI_STORAGE_TYPE is "s3").',
    category: 'storage',
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
    requiredWhen: { PIWI_STORAGE_TYPE: 's3' },
    docs: 'operate/storage#s3-compatible-storage',
  },
  PIWI_S3_REGION: {
    description: 'S3 bucket region (when PIWI_STORAGE_TYPE is "s3").',
    category: 'storage',
    example: 'us-east-1',
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
    requiredWhen: { PIWI_STORAGE_TYPE: 's3' },
  },
  PIWI_S3_ACCESS_KEY_ID: {
    description: 'Optional static S3 access key id. When omitted, the AWS SDK default credential chain is used.',
    category: 'storage',
    secret: true,
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
  },
  PIWI_S3_SECRET_ACCESS_KEY: {
    description: 'Optional static S3 secret access key. Set it together with PIWI_S3_ACCESS_KEY_ID.',
    category: 'storage',
    secret: true,
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
  },
  PIWI_S3_ENDPOINT: {
    description: 'Custom endpoint for S3-compatible services (MinIO, R2, Spaces).',
    category: 'storage',
    type: 'url',
    example: 'https://minio.example.com',
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
  },
  PIWI_S3_FORCE_PATH_STYLE: {
    description: 'Use path-style addressing (required by some S3-compatible services).',
    category: 'storage',
    type: 'boolean',
    relevantWhen: { PIWI_STORAGE_TYPE: 's3' },
    notes:
      'Defaults to on when a custom endpoint is set, off otherwise; only the exact value `false` turns it off explicitly.',
  },

  // ── Authentication ───────────────────────────────────────────────────────
  PIWI_AUTH_ENABLED: {
    description: 'Set to "true" to enable role-based access control and API keys. Off by default.',
    category: 'auth',
    type: 'boolean',
    default: 'false',
  },
  PIWI_AUTH_SECRET: {
    description: 'Secret used to sign/encrypt session cookies. Required when PIWI_AUTH_ENABLED is true.',
    category: 'auth',
    secret: true,
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    requiredWhen: { PIWI_AUTH_ENABLED: 'true' },
    notes: 'The server refuses to start when auth is enabled and this is unset.',
  },
  PIWI_SETUP_TOKEN: {
    description:
      "A token the first-admin form asks for (`setupToken` in `POST /api/auth/setup`), so only whoever can read the server's settings creates the first administrator. The one-click deploy templates generate it. Unset, the first visitor to an instance with no administrator can create one.",
    category: 'auth',
    secret: true,
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    since: '0.55.1',
  },
  PIWI_METRICS_ENABLED: {
    description:
      'Set to "true" to serve GET /api/metrics: the metric catalog\'s current values per project in the OpenMetrics text format, for a Prometheus or a Grafana you run to pull (Piwi sends nothing anywhere). Off by default. With authentication on, the scraper sends an API key, and sees the projects of its user.',
    category: 'general',
    type: 'boolean',
    default: 'false',
    since: '0.39.0',
    docs: 'operate/metrics',
  },
  PIWI_SHARE_LINKS_ENABLED: {
    description:
      'Set to "true" to allow minting read-only public share links for executions and failure clusters. Off by default; turning it off again immediately dead-ends every outstanding link without deleting anything.',
    category: 'auth',
    type: 'boolean',
    default: 'false',
    since: '0.26.0',
  },
  PIWI_SHARE_LINK_MAX_TTL_DAYS: {
    description:
      'Longest allowed share-link lifetime, in days. The creation dialog offers expiries up to this; 0 lifts the cap and allows links with no expiry.',
    category: 'auth',
    type: 'number',
    default: '30',
    min: 0,
    max: 3650,
    relevantWhen: { PIWI_SHARE_LINKS_ENABLED: 'true' },
    since: '0.26.0',
  },
  PIWI_TRUST_PROXY: {
    description:
      'Set to "true" when a reverse proxy sits in front of Piwi, so per-IP rate limits on the auth endpoints key on the client address your proxy appends to X-Forwarded-For instead of on the proxy\'s own address (which would pool every client into one bucket). Leave off when clients connect directly: the header is client-controlled then, and trusting it would let a caller choose its own bucket.',
    category: 'auth',
    type: 'boolean',
    default: 'false',
    since: '0.26.0',
  },

  // ── OAuth ────────────────────────────────────────────────────────────────
  PIWI_OAUTH_GOOGLE_CLIENT_ID: {
    description: 'Google OAuth client id (optional single sign-on).',
    category: 'oauth',
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    requiredWhen: { PIWI_OAUTH_GOOGLE_CLIENT_SECRET: '*' },
    docs: 'operate/authentication#oauth-google-github',
  },
  PIWI_OAUTH_GOOGLE_CLIENT_SECRET: {
    description: 'Google OAuth client secret.',
    category: 'oauth',
    secret: true,
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    requiredWhen: { PIWI_OAUTH_GOOGLE_CLIENT_ID: '*' },
  },
  PIWI_OAUTH_GITHUB_CLIENT_ID: {
    description: 'GitHub OAuth client id (optional single sign-on).',
    category: 'oauth',
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    requiredWhen: { PIWI_OAUTH_GITHUB_CLIENT_SECRET: '*' },
    docs: 'operate/authentication#oauth-google-github',
  },
  PIWI_OAUTH_GITHUB_CLIENT_SECRET: {
    description: 'GitHub OAuth client secret.',
    category: 'oauth',
    secret: true,
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    requiredWhen: { PIWI_OAUTH_GITHUB_CLIENT_ID: '*' },
  },
  PIWI_OAUTH_ALLOWED_DOMAINS: {
    description: 'Comma-separated verified email domains allowed to sign in via OAuth (all providers).',
    category: 'oauth',
    type: 'list',
    example: 'example.com,corp.example.com',
    relevantWhen: { PIWI_AUTH_ENABLED: 'true' },
    notes: 'Only verified emails in these domains are accepted. Empty means no domain restriction.',
  },
  PIWI_OAUTH_GITHUB_ALLOWED_ORGS: {
    description: 'Comma-separated GitHub org logins a user must belong to (requests read:org scope).',
    category: 'oauth',
    type: 'list',
    relevantWhen: { PIWI_OAUTH_GITHUB_CLIENT_ID: '*' },
  },

  // ── AI — diagnosis model ─────────────────────────────────────────────────
  PIWI_AI_PROVIDER: {
    description:
      'AI provider for failure diagnosis: "anthropic", "openai" (OpenAI-compatible), "codex-cli" (the local Codex CLI), or "claude-cli" (the local Claude Code CLI — offered in the desktop app, or wherever PIWI_CLAUDE_CLI_PATH points at it).',
    category: 'ai',
    type: 'enum',
    enum: ['anthropic', 'openai', 'claude-cli', 'codex-cli'],
  },
  PIWI_AI_API_KEY: {
    description: 'API key for the diagnosis provider. Takes precedence over the DB-stored key.',
    category: 'ai',
    secret: true,
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
    requiredWhen: { PIWI_AI_PROVIDER: 'anthropic' },
    notes:
      'Optional for OpenAI-compatible providers that need no key (e.g. a local model). Unused by "claude-cli" and "codex-cli" — the CLI carries its own login.',
  },
  PIWI_AI_MODEL: {
    description:
      'Diagnosis model name (default: claude-opus-4-8 for Anthropic; for "claude-cli" an alias like "opus"/"sonnet", or empty for the CLI default).',
    category: 'ai',
    example: 'claude-opus-4-8',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
    requiredWhen: { PIWI_AI_PROVIDER: 'openai' },
  },
  PIWI_AI_BASE_URL: {
    description:
      'Base URL of the provider API. Required for "openai" — OpenAI itself (https://api.openai.com/v1) as well as compatible servers (e.g. http://localhost:11434/v1); optional for "anthropic" (a gateway or proxy).',
    category: 'ai',
    type: 'url',
    example: 'http://localhost:11434/v1',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
    requiredWhen: { PIWI_AI_PROVIDER: 'openai' },
  },
  PIWI_AI_TEMPERATURE: {
    description: 'Sampling temperature override for the diagnosis model (OpenAI-compatible only), range 0-2.',
    category: 'ai',
    type: 'number',
    min: 0,
    max: 2,
    since: '0.27.0',
    relevantWhen: { PIWI_AI_PROVIDER: 'openai' },
    notes:
      'Omitted from requests when unset (provider default applies). Reasoning models (o1, o3, GPT-5-class) reject any explicit value — leave this unset for them.',
  },
  PIWI_AI_AUTO_DIAGNOSE: {
    description:
      'Set to "true" to diagnose, when a run finishes, the failure clusters that failed in it and have no completed diagnosis yet (up to PIWI_AI_AUTO_DIAGNOSE_MAX).',
    category: 'ai',
    type: 'boolean',
    default: 'false',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
  },
  PIWI_AI_LANGUAGE: {
    description:
      'Language for AI-written prose (diagnosis, root cause, cluster titles), e.g. "French". Unset keeps English. Code, locators, paths and error text stay verbatim.',
    category: 'ai',
    example: 'French',
    since: '0.29.0',
    docs: 'guide/ai-provider#response-language',
  },
  PIWI_AI_AUTO_DIAGNOSE_MAX: {
    description: 'Max clusters auto-diagnosed per finished run (budget cap; default 3).',
    category: 'ai',
    type: 'number',
    default: '3',
    min: 1,
    relevantWhen: { PIWI_AI_AUTO_DIAGNOSE: 'true' },
  },

  // ── AI — research model ──────────────────────────────────────────────────
  PIWI_AI_RESEARCH_PROVIDER: {
    description: 'Provider for the optional research (pre-analysis) stage. Falls back to PIWI_AI_PROVIDER.',
    category: 'ai',
    type: 'enum',
    enum: ['anthropic', 'openai', 'claude-cli', 'codex-cli'],
    relevantWhen: { PIWI_AI_RESEARCH_MODEL: '*' },
  },
  PIWI_AI_RESEARCH_MODEL: {
    description: 'Cheaper/faster model for the research stage. Empty disables the two-stage pipeline.',
    category: 'ai',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
  },
  PIWI_AI_RESEARCH_BASE_URL: {
    description: 'Base URL for the research-stage provider. Falls back to PIWI_AI_BASE_URL.',
    category: 'ai',
    type: 'url',
    relevantWhen: { PIWI_AI_RESEARCH_MODEL: '*' },
  },
  PIWI_AI_RESEARCH_API_KEY: {
    description: 'API key for the research-stage provider. Falls back to PIWI_AI_API_KEY.',
    category: 'ai',
    secret: true,
    relevantWhen: { PIWI_AI_RESEARCH_MODEL: '*' },
  },
  PIWI_AI_RESEARCH_TEMPERATURE: {
    description: 'Sampling temperature override for the research model (OpenAI-compatible only), range 0-2.',
    category: 'ai',
    type: 'number',
    min: 0,
    max: 2,
    since: '0.27.0',
    relevantWhen: { PIWI_AI_RESEARCH_MODEL: '*' },
    notes:
      'Omitted from requests when unset (provider default applies). Reasoning models (o1, o3, GPT-5-class) reject any explicit value — leave this unset for them.',
  },

  // ── AI — embedding model ─────────────────────────────────────────────────
  PIWI_AI_EMBEDDING_PROVIDER: {
    description: 'Provider for embeddings (semantic failure clustering). Falls back to PIWI_AI_PROVIDER.',
    category: 'ai',
    type: 'enum',
    enum: ['openai'],
    relevantWhen: { PIWI_AI_EMBEDDING_MODEL: '*' },
    notes:
      'Must resolve to an OpenAI-compatible provider — Anthropic has no embeddings API — so the fallback only helps when the main provider is "openai".',
  },
  PIWI_AI_EMBEDDING_MODEL: {
    description: 'Embedding model name (e.g. text-embedding-3-small).',
    category: 'ai',
    example: 'text-embedding-3-small',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
    notes: 'Empty disables semantic clustering (and the embedding fallbacks).',
  },
  PIWI_AI_EMBEDDING_BASE_URL: {
    description: 'Base URL for the embedding provider. Falls back to PIWI_AI_BASE_URL.',
    category: 'ai',
    type: 'url',
    relevantWhen: { PIWI_AI_EMBEDDING_MODEL: '*' },
  },
  PIWI_AI_EMBEDDING_API_KEY: {
    description: 'API key for the embedding provider. Falls back to PIWI_AI_API_KEY.',
    category: 'ai',
    secret: true,
    relevantWhen: { PIWI_AI_EMBEDDING_MODEL: '*' },
  },

  // ── AI — assistant model ─────────────────────────────────────────────────
  PIWI_AI_ASSISTANT_PROVIDER: {
    description: 'Provider for the assistant. Falls back to PIWI_AI_PROVIDER.',
    category: 'ai',
    type: 'enum',
    enum: ['anthropic', 'openai', 'claude-cli', 'codex-cli'],
    since: '0.59.0',
    relevantWhen: { PIWI_AI_ASSISTANT_MODEL: '*' },
  },
  PIWI_AI_ASSISTANT_MODEL: {
    description: 'Model the in-app assistant answers with. Empty uses the diagnosis model.',
    category: 'ai',
    since: '0.59.0',
    relevantWhen: { PIWI_AI_PROVIDER: '*' },
    docs: 'features/assistant#the-model',
  },
  PIWI_AI_ASSISTANT_BASE_URL: {
    description: 'Base URL for the assistant provider. Falls back to PIWI_AI_BASE_URL.',
    category: 'ai',
    type: 'url',
    since: '0.59.0',
    relevantWhen: { PIWI_AI_ASSISTANT_MODEL: '*' },
  },
  PIWI_AI_ASSISTANT_API_KEY: {
    description: 'API key for the assistant provider. Falls back to PIWI_AI_API_KEY.',
    category: 'ai',
    secret: true,
    since: '0.59.0',
    relevantWhen: { PIWI_AI_ASSISTANT_MODEL: '*' },
  },
  PIWI_AI_ASSISTANT_TEMPERATURE: {
    description: 'Sampling temperature override for the assistant model (OpenAI-compatible only), range 0-2.',
    category: 'ai',
    type: 'number',
    min: 0,
    max: 2,
    since: '0.59.0',
    relevantWhen: { PIWI_AI_ASSISTANT_MODEL: '*' },
    notes:
      'Omitted from requests when unset (provider default applies). Reasoning models (o1, o3, GPT-5-class) reject any explicit value — leave this unset for them.',
  },

  // ── AI — local Claude CLI ────────────────────────────────────────────────
  PIWI_CODEX_CLI_PATH: {
    description:
      'Absolute path to the local Codex CLI. Enables codex-cli outside the desktop app. Uses the local file-backed ChatGPT login without an API key.',
    category: 'ai',
    since: '0.61.0',
    type: 'string',
    default: '',
    docs: 'guide/codex-cli#setup',
    example: '/usr/local/bin/codex',
  },
  PIWI_CLAUDE_CLI_PATH: {
    description:
      'Absolute path to the `claude` binary for the "claude-cli" provider. Set only when the CLI is not on PATH, or to enable the provider outside the desktop app. Auto-detected otherwise.',
    category: 'ai',
    since: '0.30.0',
    example: '/usr/local/bin/claude',
  },

  // ── AI — diagnosis context limits ────────────────────────────────────────
  PIWI_AI_MAX_SAMPLE_ERROR_CHARS: {
    description: 'Max characters of raw error text (per error block).',
    category: 'ai-limits',
    type: 'number',
    default: '10000',
    min: 200,
    max: 50000,
  },
  PIWI_AI_MAX_SCM_PATCH_BUDGET: {
    description: 'Total characters of diff patches across changed files.',
    category: 'ai-limits',
    type: 'number',
    default: '15000',
    min: 0,
    max: 50000,
  },
  PIWI_AI_MAX_AFFECTED_TESTS: {
    description: 'Max affected tests listed in the diagnosis context.',
    category: 'ai-limits',
    type: 'number',
    default: '30',
    min: 1,
    max: 200,
  },
  PIWI_AI_MAX_STEPS: {
    description: 'Max recent test steps included.',
    category: 'ai-limits',
    type: 'number',
    default: '50',
    min: 1,
    max: 200,
  },
  PIWI_AI_MAX_CONSOLE_ENTRIES: {
    description: 'Max console error/warning entries included.',
    category: 'ai-limits',
    type: 'number',
    default: '30',
    min: 0,
    max: 200,
  },
  PIWI_AI_MAX_CONSOLE_ENTRY_CHARS: {
    description: 'Max characters per console entry.',
    category: 'ai-limits',
    type: 'number',
    default: '1000',
    min: 50,
    max: 5000,
  },
  PIWI_AI_MAX_NETWORK_REQUESTS: {
    description: 'Max failed network requests included.',
    category: 'ai-limits',
    type: 'number',
    default: '25',
    min: 0,
    max: 200,
  },
  PIWI_AI_MAX_ARIA_SNAPSHOT_CHARS: {
    description: 'Max characters of the page ARIA snapshot.',
    category: 'ai-limits',
    type: 'number',
    default: '12000',
    min: 0,
    max: 50000,
  },
  PIWI_AI_MAX_TEST_SOURCE_CHARS: {
    description: 'Max characters of the test source snippet.',
    category: 'ai-limits',
    type: 'number',
    default: '8000',
    min: 0,
    max: 50000,
  },
  PIWI_AI_MAX_SOURCE_FILES: {
    description: 'Max full source files fetched from SCM to ground patches (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '4',
    min: 0,
    max: 20,
  },
  PIWI_AI_MAX_SOURCE_FILE_CHARS: {
    description: 'Max characters per fetched full source file.',
    category: 'ai-limits',
    type: 'number',
    default: '12000',
    min: 0,
    max: 50000,
  },
  PIWI_AI_MAX_SERVER_LOG_ENTRIES: {
    description: 'Max backend server log entries (from X-Piwi-Logs header) included.',
    category: 'ai-limits',
    type: 'number',
    default: '50',
    min: 0,
    max: 200,
  },
  PIWI_AI_MAX_SERVER_LOG_ENTRY_CHARS: {
    description: 'Max characters per backend server log entry.',
    category: 'ai-limits',
    type: 'number',
    default: '1000',
    min: 50,
    max: 5000,
  },
  PIWI_AI_MAX_SERVER_TRACE_SPANS: {
    description: 'Max backend server spans (from X-Piwi-Trace header) included in AI diagnosis (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '40',
    min: 0,
    max: 500,
    since: '0.16.0',
  },
  PIWI_AI_MAX_STEP_INTENTS: {
    description:
      'Max AI-step intent mappings (natural-language prompt → compiled locator) included in a diagnosis (0 disables the section).',
    category: 'ai-limits',
    type: 'number',
    default: '20',
    min: 0,
    max: 100,
    since: '0.24.0',
  },
  PIWI_AI_ASSISTANT_MAX_TOOL_CALLS: {
    description: 'Max tool calls the assistant makes to answer one question.',
    category: 'assistant',
    type: 'number',
    default: '8',
    min: 1,
    max: 30,
    since: '0.59.0',
  },
  PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS: {
    description:
      'Max output tokens of one assistant model call. Reasoning models count hidden chain-of-thought against this.',
    category: 'assistant',
    type: 'number',
    default: '2048',
    min: 256,
    max: 16384,
    since: '0.59.0',
  },
  PIWI_AI_ASSISTANT_TURN_TIMEOUT_SECONDS: {
    description: 'Seconds the assistant may spend answering one question, model calls and tool calls together.',
    category: 'assistant',
    type: 'number',
    default: '180',
    min: 15,
    max: 900,
    since: '0.59.0',
  },
  PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER: {
    description: 'Tokens (input and output) one user may spend on the assistant in 24 hours. 0 sets no cap.',
    category: 'assistant',
    type: 'number',
    default: '1000000',
    min: 0,
    max: 1000000000,
    since: '0.59.0',
  },
  PIWI_AI_ASSISTANT_DAILY_TOKENS: {
    description: 'Tokens (input and output) the whole instance may spend on the assistant in 24 hours. 0 sets no cap.',
    category: 'assistant',
    type: 'number',
    default: '5000000',
    min: 0,
    max: 1000000000,
    since: '0.59.0',
  },
  PIWI_AI_STEP_MAX_SNAPSHOT_CHARS: {
    description: 'Max characters of the page ARIA snapshot the reporter sends per AI-step authoring iteration.',
    category: 'ai-steps',
    type: 'number',
    default: '24000',
    min: 0,
    max: 100000,
    since: '0.24.0',
  },
  PIWI_AI_STEP_MAX_OUTPUT_TOKENS: {
    description:
      'Max output tokens the model may return per AI-step authoring iteration. Reasoning models count hidden chain-of-thought against this, so raise it (up to 8192) when authoring with one.',
    category: 'ai-steps',
    type: 'number',
    default: '1024',
    min: 256,
    max: 8192,
    since: '0.24.0',
  },
  PIWI_AI_MAX_IMAGES: {
    description: 'Max screenshots auto-included in the diagnosis context.',
    category: 'ai-limits',
    type: 'number',
    default: '5',
    min: 0,
    max: 20,
  },
  PIWI_AI_MAX_PASSED_PEERS: {
    description: 'Max peer tests in the same file listed when they passed.',
    category: 'ai-limits',
    type: 'number',
    default: '20',
    min: 0,
    max: 100,
  },
  PIWI_AI_MAX_CONSOLE_WINDOW: {
    description: 'Max console entries of any type in the window before failure.',
    category: 'ai-limits',
    type: 'number',
    default: '50',
    min: 0,
    max: 200,
  },
  PIWI_AI_SLOW_REQUEST_MS: {
    description: 'Network request duration (ms) threshold for flagging as slow.',
    category: 'ai-limits',
    type: 'number',
    default: '1500',
    min: 100,
    max: 30000,
  },
  PIWI_AI_MAX_TRACE_ACTIONS: {
    description: 'Max actions extracted from trace ZIP for failing-action context (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '10',
    min: 0,
    max: 50,
  },
  PIWI_AI_TRACE_DOM_CHARS: {
    description: 'Max characters for the trace-derived DOM/ARIA excerpt in failing-action context.',
    category: 'ai-limits',
    type: 'number',
    default: '6000',
    min: 0,
    max: 20000,
  },
  PIWI_AI_MAX_TRACE_STACK_FRAMES: {
    description: 'Max call-stack frames (with source windows) from the trace call-stack section (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '10',
    min: 0,
    max: 50,
  },
  PIWI_AI_MAX_TRACE_NETWORK_REQUESTS: {
    description: 'Max requests included from the trace network stream (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '20',
    min: 0,
    max: 200,
  },
  PIWI_AI_MAX_DOM_SNAPSHOT_CHARS: {
    description: 'Max characters of the failure-time DOM snapshot rendered from the trace (0 disables).',
    category: 'ai-limits',
    type: 'number',
    default: '8000',
    min: 0,
    max: 50000,
  },
  PIWI_AI_IMAGE_MAX_EDGE: {
    description: 'Screenshots are downscaled to at most this many pixels on the long edge before being sent.',
    category: 'ai-limits',
    type: 'number',
    default: '1920',
    min: 512,
    max: 8192,
  },

  // ── Ingest storage limits ────────────────────────────────────────────────
  PIWI_INGEST_MAX_CONSOLE_ENTRIES: {
    description: 'Max console entries stored per test execution.',
    category: 'ingest',
    type: 'number',
    default: '200',
    min: 10,
    max: 5000,
  },
  PIWI_IMPORT_MAX_BYTES: {
    description:
      'Max size of a single multipart upload (report upload or blob-report import), in bytes. Lower it to match a reverse proxy that rejects large bodies, so the import page rejects an oversized archive before uploading it.',
    category: 'ingest',
    type: 'number',
    default: String(500 * 1024 * 1024),
    min: 1024 * 1024,
    max: 5 * 1024 * 1024 * 1024,
    since: '0.19.0',
  },
  // ── Offline export limits ───────────────────────────────────────────────
  PIWI_EXPORT_MAX_INLINE_BYTES: {
    description:
      'Max size of a single evidence file embedded as a data: URI in an HTML export, in bytes. Larger files are left out of the single-file HTML (and listed as omitted); the ZIP export still carries them at full size.',
    category: 'export',
    type: 'number',
    default: String(8 * 1024 * 1024),
    min: 64 * 1024,
    max: 512 * 1024 * 1024,
    since: '0.19.0',
  },
  PIWI_EXPORT_MAX_BYTES: {
    description:
      "Max total size of one export, in bytes. Evidence is added in order (each execution's attachments, then its traces); a file that would pass the budget is left out and listed as omitted. The archive is built in memory, so this also bounds what a single export costs the server.",
    category: 'export',
    type: 'number',
    default: String(500 * 1024 * 1024),
    min: 1024 * 1024,
    max: 4 * 1024 * 1024 * 1024,
    since: '0.19.0',
  },
  PIWI_EXPORT_MAX_CASES: {
    description:
      'Max member executions carrying full evidence in a failure-cluster export. Remaining affected tests are listed by name without their evidence.',
    category: 'export',
    type: 'number',
    default: '25',
    min: 1,
    max: 200,
    since: '0.19.0',
  },
  PIWI_INGEST_MAX_CONSOLE_ENTRY_CHARS: {
    description: 'Max characters stored per console entry.',
    category: 'ingest',
    type: 'number',
    default: '2000',
    min: 200,
    max: 20000,
  },
  PIWI_INGEST_MAX_STEPS: {
    description:
      'Max test steps stored per execution. Past it, the steps that failed are kept first, and one marker step counts the steps dropped.',
    category: 'ingest',
    type: 'number',
    default: '500',
    min: 20,
    max: 5000,
  },
  PIWI_INGEST_MAX_STEP_PARAM_KEYS: {
    description: 'Max param keys stored per step.',
    category: 'ingest',
    type: 'number',
    default: '20',
    min: 1,
    max: 100,
    since: '0.27.0',
  },
  PIWI_INGEST_MAX_STEP_PARAM_VALUE_CHARS: {
    description: 'Max characters stored per step param value.',
    category: 'ingest',
    type: 'number',
    default: '200',
    min: 20,
    max: 2000,
    since: '0.27.0',
  },
  PIWI_INGEST_MAX_STEP_EVENTS: {
    description: 'Max step events stored per execution.',
    category: 'ingest',
    type: 'number',
    default: '1000',
    min: 20,
    max: 10000,
  },
  PIWI_INGEST_MAX_LOCKS: {
    description: 'Max lock names stored per execution.',
    category: 'ingest',
    type: 'number',
    default: '20',
    min: 1,
    max: 100,
    since: '0.27.0',
  },
  PIWI_INGEST_MAX_DIALOGS: {
    description: 'Max browser dialogs stored per execution.',
    category: 'ingest',
    type: 'number',
    default: '50',
    min: 1,
    max: 500,
    since: '0.27.0',
  },
  PIWI_INGEST_MAX_ARIA_CHARS: {
    description: 'Max characters of the ARIA snapshot stored per failing execution.',
    category: 'ingest',
    type: 'number',
    default: '100000',
    min: 1000,
    max: 1000000,
  },
  PIWI_INGEST_MAX_ERROR_CHARS: {
    description: 'Max characters of error text stored per execution (head and tail are kept).',
    category: 'ingest',
    type: 'number',
    default: '20000',
    min: 1000,
    max: 100000,
  },
  PIWI_INGEST_MAX_SAMPLE_ERROR_CHARS: {
    description: 'Max characters of the sample error stored per failure cluster.',
    category: 'ingest',
    type: 'number',
    default: '50000',
    min: 1000,
    max: 200000,
  },
  PIWI_INGEST_MAX_TEST_SOURCE_CHARS: {
    description: 'Max characters of the test source snippet stored per failing execution.',
    category: 'ingest',
    type: 'number',
    default: '50000',
    min: 1000,
    max: 200000,
  },
  PIWI_INGEST_MAX_SOURCE_FRAMES: {
    description: 'Max source stack frames stored per failing execution.',
    category: 'ingest',
    type: 'number',
    default: '8',
    min: 1,
    max: 32,
  },
  PIWI_INGEST_MAX_SOURCE_FRAME_CHARS: {
    description: 'Max characters per stored source frame snippet.',
    category: 'ingest',
    type: 'number',
    default: '4000',
    min: 500,
    max: 20000,
  },
  PIWI_AUTO_MARKERS: {
    description:
      'Automatically create a timeline marker when a run’s Playwright or reporter version differs from the previous run in the same environment, and when a run is flagged as an environment incident (default: enabled). Set to false to disable.',
    category: 'markers',
    type: 'boolean',
    default: 'true',
    docs: 'features/timeline-markers',
    notes: 'Only the exact value `false` disables auto-markers.',
  },

  PIWI_TEST_LOGS_DISABLED: {
    description:
      'Disable X-Piwi-Logs response header emission (default: auto-disabled in production, enabled in development).',
    category: 'testing',
    type: 'boolean',
    docs: 'guide/backend-logs',
    notes:
      'Set on the instrumented backend (Nitro or ASP.NET Core). Unset: capture is on in development and off in production builds; `true` forces it off everywhere, `false` forces it on even in production. Overrides every other environment setting.',
  },
  PIWI_TEST_LOGS_ENVIRONMENTS: {
    description:
      'Comma-separated ASP.NET Core environment names the X-Piwi-Logs middleware is active in (default: Development,Test).',
    category: 'testing',
    type: 'list',
    example: 'Development,Podman,Integration',
    docs: 'guide/backend-logs#choosing-the-environments',
    since: '0.39.0',
    notes:
      'Set on the ASP.NET Core backend. Used only when the app configures no environments itself (a `UsePiwiTestLogs` argument or `PiwiTestLogsOptions`). Names match case-insensitively.',
  },

  // ── Failure clustering ───────────────────────────────────────────────────
  PIWI_CLUSTER_SIMILARITY_THRESHOLD: {
    description: 'Cosine similarity (0–1) above which two failure embeddings merge into one cluster.',
    category: 'clustering',
    type: 'number',
    default: '0.92',
    min: 0,
    max: 1,
    relevantWhen: { PIWI_AI_EMBEDDING_MODEL: '*' },
    notes: 'Must be greater than 0 and at most 1; invalid values fall back to the default.',
  },
  PIWI_CLUSTER_SUGGEST_THRESHOLD: {
    description: 'Similarity at which a failure is suggested (not auto-merged) as related to a cluster.',
    category: 'clustering',
    type: 'number',
    default: '0.80',
    min: 0,
    max: 1,
    relevantWhen: { PIWI_AI_EMBEDDING_MODEL: '*' },
    notes: 'Capped at the merge threshold.',
  },

  // ── SMTP ─────────────────────────────────────────────────────────────────
  PIWI_SMTP_HOST: {
    description: 'SMTP server hostname for outbound email.',
    category: 'smtp',
    example: 'smtp.example.com',
  },
  PIWI_SMTP_PORT: {
    description: 'SMTP port (default 587; 465 for implicit TLS).',
    category: 'smtp',
    type: 'number',
    default: '587',
    min: 1,
    max: 65535,
    relevantWhen: { PIWI_SMTP_HOST: '*' },
  },
  PIWI_SMTP_USER: {
    description: 'SMTP username. Optional — only when the server requires authentication.',
    category: 'smtp',
    relevantWhen: { PIWI_SMTP_HOST: '*' },
  },
  PIWI_SMTP_PASS: {
    description: 'SMTP password. Optional — only when the server requires authentication. Never returned by the API.',
    category: 'smtp',
    secret: true,
    relevantWhen: { PIWI_SMTP_HOST: '*' },
  },
  PIWI_SMTP_FROM: {
    description: 'From address for outbound email (e.g. noreply@example.com).',
    category: 'smtp',
    example: 'noreply@example.com',
    relevantWhen: { PIWI_SMTP_HOST: '*' },
    requiredWhen: { PIWI_SMTP_HOST: '*' },
  },
  PIWI_SMTP_FROM_NAME: {
    description: 'Display name for the from address (optional).',
    category: 'smtp',
    default: 'Piwi Dashboard',
    relevantWhen: { PIWI_SMTP_HOST: '*' },
  },
  PIWI_SMTP_SECURE: {
    description: 'Set to "true" for implicit TLS on port 465 (default false → STARTTLS/plain).',
    category: 'smtp',
    type: 'boolean',
    relevantWhen: { PIWI_SMTP_HOST: '*' },
    notes: 'Defaults to on when the port is 465, off otherwise.',
  },

  // ── Integrations ─────────────────────────────────────────────────────────
  PIWI_SCM_GITLAB_HOSTS: {
    description:
      'Self-hosted GitLab host names (comma-separated, e.g. gitlab.example.com) Piwi may call with the SCM token. The GitLab cloud needs no entry; a self-hosted GitLab not listed here is not read.',
    category: 'integrations',
    type: 'list',
    example: 'gitlab.example.com',
    since: '0.43.0',
    docs: 'guide/source-control#which-repository',
  },
  PIWI_JIRA_BASE_URL: {
    description: 'Base URL of the Jira Cloud site to connect (e.g. https://your-team.atlassian.net).',
    category: 'integrations',
    type: 'url',
    example: 'https://your-team.atlassian.net',
    since: '0.29.0',
    docs: 'operate/integrations#connecting-jira-cloud',
  },
  PIWI_JIRA_EMAIL: {
    description: 'Atlassian account email the API token belongs to.',
    category: 'integrations',
    example: 'you@example.com',
    since: '0.29.0',
    relevantWhen: { PIWI_JIRA_BASE_URL: '*' },
    requiredWhen: { PIWI_JIRA_BASE_URL: '*' },
  },
  PIWI_JIRA_API_TOKEN: {
    description: 'Jira Cloud API token (from id.atlassian.com). Never returned by the API.',
    category: 'integrations',
    secret: true,
    since: '0.29.0',
    relevantWhen: { PIWI_JIRA_BASE_URL: '*' },
    requiredWhen: { PIWI_JIRA_BASE_URL: '*' },
  },
  PIWI_INTEGRATIONS_SYNC_MINUTES: {
    description: 'How often, in minutes, Piwi reads ticket statuses back from the tracker.',
    category: 'integrations',
    type: 'number',
    default: String(DEFAULT_INTEGRATIONS_SYNC_MINUTES),
    min: MIN_INTEGRATIONS_SYNC_MINUTES,
    max: MAX_INTEGRATIONS_SYNC_MINUTES,
    since: '0.29.0',
    docs: 'operate/integrations#status-sync',
  },

  // ── Wasted-time analysis ─────────────────────────────────────────────────
  PIWI_WASTED_WAIT_PATTERNS: {
    description:
      'Glob patterns (comma or newline separated) defining which wait steps count as wasted time. Locks the UI when set.',
    category: 'wasted-time',
    type: 'list',
    default: 'Wait for timeout*,*waitForTimeout*',
    notes:
      'Case-insensitive globs (`*` and `?`) matched against a wait step’s title or source location. Use `*` to count every wait.',
  },

  PIWI_CI_MINUTE_COST: {
    description:
      'Cost of one CI minute as an amount and an ISO 4217 currency code (e.g. "0.008 USD"). When set, every wasted-time number in the analytics widgets and quality reports is followed by its cost, and the setting in Settings → Performance is read-only. Unset shows minutes only.',
    category: 'wasted-time',
    example: '0.008 USD',
    since: '0.39.0',
    docs: 'features/quality-reports#cost-of-a-ci-minute',
  },

  // ── Demo / build mode ────────────────────────────────────────────────────
  PIWI_DEMO_MODE: {
    description: 'Set to "true" to build the standalone client-side demo SPA (no server).',
    category: 'demo',
    runtimeOnly: true,
    type: 'boolean',
  },

  // ── Test harness only (not user settings) ────────────────────────────────
  PIWI_BASE_URL: {
    description: 'Base URL the metadata test spec targets (defaults to http://localhost:3000).',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_POSTGRES_TEST_URL: {
    description: 'PostgreSQL connection string used by the Postgres test suite.',
    category: 'test',
    runtimeOnly: true,
    secret: true,
  },
  PIWI_S3_TEST_BUCKET: {
    description: 'S3 bucket for the storage integration tests.',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_S3_TEST_REGION: {
    description: 'Region for the S3 storage integration tests.',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_S3_TEST_ACCESS_KEY_ID: {
    description: 'Access key id for the S3 storage integration tests.',
    category: 'test',
    runtimeOnly: true,
    secret: true,
  },
  PIWI_S3_TEST_SECRET_ACCESS_KEY: {
    description: 'Secret access key for the S3 storage integration tests.',
    category: 'test',
    runtimeOnly: true,
    secret: true,
  },
  PIWI_S3_TEST_ENDPOINT: {
    description: 'Custom endpoint for the S3 storage integration tests.',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_MAILPIT_URL: {
    description: 'Mailpit base URL; when set, the email/notification E2E tests run against it.',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_LIVE_JIRA_PROJECT_KEY: {
    description: 'Jira project key the live Jira E2E files into (with PIWI_JIRA_* credentials).',
    category: 'test',
    runtimeOnly: true,
    since: '0.29.0',
  },
  PIWI_MAILPIT_SMTP_PORT: {
    description: 'SMTP port the email E2E tests send to (Mailpit).',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_EMAIL_SERVER_URL: {
    description: 'Base URL the email test spec targets.',
    category: 'test',
    runtimeOnly: true,
  },
  PIWI_TEST_CLEANUP_ENABLED: {
    description:
      'Allow the E2E cleanup endpoint (`DELETE /api/tests/cleanup`) on a production build, which CI needs because it runs the suite against one. Never set it on a real deployment.',
    category: 'test',
    runtimeOnly: true,
    type: 'boolean',
    since: '0.19.0',
  },
} as const satisfies Record<string, PiwiEnvVarMeta>;

/** Typed union of every `PIWI_*` env var name. */
export type PiwiEnvVarName = keyof typeof PIWI_ENV_VARS;

/** Metadata for a single env var. */
export function getEnvVarMeta(name: PiwiEnvVarName): PiwiEnvVarMeta {
  return PIWI_ENV_VARS[name];
}

/** All env var names in a given category. */
export function envVarsByCategory(category: PiwiEnvVarCategory): PiwiEnvVarName[] {
  return (Object.keys(PIWI_ENV_VARS) as PiwiEnvVarName[]).filter((name) => PIWI_ENV_VARS[name].category === category);
}

/** Numeric semver comparison (missing segments count as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a variable exists in the given server version, per its
 * `since`/`until` range. Baseline vars (no `since`) exist in every version.
 */
export function envVarAppliesToVersion(name: PiwiEnvVarName, version: string): boolean {
  const meta: PiwiEnvVarMeta = getEnvVarMeta(name);
  if (meta.since && compareVersions(version, meta.since) < 0) return false;
  if (meta.until && compareVersions(version, meta.until) >= 0) return false;
  return true;
}

/** Every distinct version mentioned in a `since`/`until` range, ascending. */
export function knownRegistryVersions(): string[] {
  const versions = new Set<string>();
  for (const meta of Object.values(PIWI_ENV_VARS) as PiwiEnvVarMeta[]) {
    if (meta.since) versions.add(meta.since);
    if (meta.until) versions.add(meta.until);
  }
  return [...versions].sort(compareVersions);
}
