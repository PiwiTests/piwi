import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PIWI_ENV_VARS,
  PIWI_ENV_CATEGORIES,
  compareVersions,
  envVarAppliesToVersion,
  knownRegistryVersions,
  type PiwiEnvVarCategory,
  type PiwiEnvVarMeta,
  type PiwiEnvVarName,
} from '#shared/piwi-env-vars';
import { CONTEXT_LIMIT_FIELDS, DEFAULT_CONTEXT_LIMITS } from '#shared/ai-context-limits';
import { DEFAULT_INGEST_LIMITS, INGEST_LIMIT_FIELDS } from '#shared/ingest-limits';
import { DEFAULT_WASTED_WAIT_PATTERNS } from '#shared/utils/wasted-waits';
import {
  DEFAULT_INTEGRATIONS_SYNC_MINUTES,
  MIN_INTEGRATIONS_SYNC_MINUTES,
  MAX_INTEGRATIONS_SYNC_MINUTES,
} from '#shared/integrations/sync-config';

const ROOT = resolve(__dirname, '../..');

/**
 * Snapshot of the registry as of 0.14.0, when version tracking started. Vars
 * in this list are "baseline" (available in every selectable version). Any var
 * NOT in this list is new and MUST declare `since: '<first release>'` so the
 * docs-site configuration generator can filter by server version. Do not add
 * new names here — stamp them with `since` instead.
 */
const BASELINE_VARS: readonly string[] = [
  'PIWI_AI_API_KEY',
  'PIWI_AI_AUTO_DIAGNOSE',
  'PIWI_AI_AUTO_DIAGNOSE_MAX',
  'PIWI_AI_BASE_URL',
  'PIWI_AI_EMBEDDING_API_KEY',
  'PIWI_AI_EMBEDDING_BASE_URL',
  'PIWI_AI_EMBEDDING_MODEL',
  'PIWI_AI_EMBEDDING_PROVIDER',
  'PIWI_AI_IMAGE_MAX_EDGE',
  'PIWI_AI_MAX_AFFECTED_TESTS',
  'PIWI_AI_MAX_ARIA_SNAPSHOT_CHARS',
  'PIWI_AI_MAX_CONSOLE_ENTRIES',
  'PIWI_AI_MAX_CONSOLE_ENTRY_CHARS',
  'PIWI_AI_MAX_CONSOLE_WINDOW',
  'PIWI_AI_MAX_DOM_SNAPSHOT_CHARS',
  'PIWI_AI_MAX_IMAGES',
  'PIWI_AI_MAX_NETWORK_REQUESTS',
  'PIWI_AI_MAX_PASSED_PEERS',
  'PIWI_AI_MAX_SAMPLE_ERROR_CHARS',
  'PIWI_AI_MAX_SCM_PATCH_BUDGET',
  'PIWI_AI_MAX_SERVER_LOG_ENTRIES',
  'PIWI_AI_MAX_SERVER_LOG_ENTRY_CHARS',
  'PIWI_AI_MAX_SOURCE_FILES',
  'PIWI_AI_MAX_SOURCE_FILE_CHARS',
  'PIWI_AI_MAX_STEPS',
  'PIWI_AI_MAX_TEST_SOURCE_CHARS',
  'PIWI_AI_MAX_TRACE_ACTIONS',
  'PIWI_AI_MAX_TRACE_NETWORK_REQUESTS',
  'PIWI_AI_MAX_TRACE_STACK_FRAMES',
  'PIWI_AI_MODEL',
  'PIWI_AI_PROVIDER',
  'PIWI_AI_RESEARCH_API_KEY',
  'PIWI_AI_RESEARCH_BASE_URL',
  'PIWI_AI_RESEARCH_MODEL',
  'PIWI_AI_RESEARCH_PROVIDER',
  'PIWI_AI_SLOW_REQUEST_MS',
  'PIWI_AI_TRACE_DOM_CHARS',
  'PIWI_AUTH_ENABLED',
  'PIWI_AUTH_SECRET',
  'PIWI_AUTO_MARKERS',
  'PIWI_BASE_URL',
  'PIWI_BUILD_DIR',
  'PIWI_BUILD_SHA',
  'PIWI_CLUSTER_SIMILARITY_THRESHOLD',
  'PIWI_CLUSTER_SUGGEST_THRESHOLD',
  'PIWI_DATABASE_PATH',
  'PIWI_DATABASE_URL',
  'PIWI_DEMO_MODE',
  'PIWI_EMAIL_SERVER_URL',
  'PIWI_INGEST_MAX_ARIA_CHARS',
  'PIWI_INGEST_MAX_CONSOLE_ENTRIES',
  'PIWI_INGEST_MAX_CONSOLE_ENTRY_CHARS',
  'PIWI_INGEST_MAX_ERROR_CHARS',
  'PIWI_INGEST_MAX_SAMPLE_ERROR_CHARS',
  'PIWI_INGEST_MAX_SOURCE_FRAMES',
  'PIWI_INGEST_MAX_SOURCE_FRAME_CHARS',
  'PIWI_INGEST_MAX_STEPS',
  'PIWI_INGEST_MAX_STEP_EVENTS',
  'PIWI_INGEST_MAX_TEST_SOURCE_CHARS',
  'PIWI_MAILPIT_SMTP_PORT',
  'PIWI_MAILPIT_URL',
  'PIWI_OAUTH_ALLOWED_DOMAINS',
  'PIWI_OAUTH_GITHUB_ALLOWED_ORGS',
  'PIWI_OAUTH_GITHUB_CLIENT_ID',
  'PIWI_OAUTH_GITHUB_CLIENT_SECRET',
  'PIWI_OAUTH_GOOGLE_CLIENT_ID',
  'PIWI_OAUTH_GOOGLE_CLIENT_SECRET',
  'PIWI_POSTGRES_TEST_URL',
  'PIWI_RETENTION_DAYS',
  'PIWI_RETENTION_DIAGNOSIS_VERSIONS',
  'PIWI_RETENTION_NOTIFICATION_DAYS',
  'PIWI_S3_ACCESS_KEY_ID',
  'PIWI_S3_BUCKET',
  'PIWI_S3_ENDPOINT',
  'PIWI_S3_FORCE_PATH_STYLE',
  'PIWI_S3_REGION',
  'PIWI_S3_SECRET_ACCESS_KEY',
  'PIWI_S3_TEST_ACCESS_KEY_ID',
  'PIWI_S3_TEST_BUCKET',
  'PIWI_S3_TEST_ENDPOINT',
  'PIWI_S3_TEST_REGION',
  'PIWI_S3_TEST_SECRET_ACCESS_KEY',
  'PIWI_SECRET_KEY',
  'PIWI_SITE_URL',
  'PIWI_SMTP_FROM',
  'PIWI_SMTP_FROM_NAME',
  'PIWI_SMTP_HOST',
  'PIWI_SMTP_PASS',
  'PIWI_SMTP_PORT',
  'PIWI_SMTP_SECURE',
  'PIWI_SMTP_USER',
  'PIWI_STORAGE_PATH',
  'PIWI_STORAGE_TYPE',
  'PIWI_TEST_LOGS_DISABLED',
  'PIWI_WASTED_WAIT_PATTERNS',
];

const allEntries = Object.entries(PIWI_ENV_VARS) as Array<[PiwiEnvVarName, PiwiEnvVarMeta]>;
const registered = new Set(Object.keys(PIWI_ENV_VARS));

/** Recursively collect files under a dir, skipping build/dep folders. */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.data', '.output', 'dist', '.nuxt', '.test-temp'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (/\.(ts|mjs|js|vue|example)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every PIWI_* name literally referenced in the application source. */
function referencedEnvVars(): Set<string> {
  const files = [
    ...collectFiles(join(ROOT, 'shared')),
    ...collectFiles(join(ROOT, 'server')),
    ...collectFiles(join(ROOT, 'app')),
    join(ROOT, 'nuxt.config.ts'),
    join(ROOT, '.env.example'),
  ];
  const re = /\bPIWI_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;
  const names = new Set<string>();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names.add(m[0]);
  }
  return names;
}

describe('PIWI_ENV_VARS registry', () => {
  test('every entry has a non-empty description and valid category', () => {
    for (const [name, meta] of allEntries) {
      expect(meta.description.length, `${name} description`).toBeGreaterThan(0);
      expect(meta.category.length, `${name} category`).toBeGreaterThan(0);
    }
  });

  test('covers every PIWI_* env var referenced in the application', () => {
    const referenced = referencedEnvVars();
    // The reporter package owns its own env map; ignore the ingestion vars it
    // also reads (they overlap with AI/auth vars already registered here).
    const missing = [...referenced].filter((v) => !registered.has(v));
    // Allow literal prefix strings used in dynamic env construction, plus the
    // registry/identifier names that happen to start with PIWI_ but are not env
    // vars (this registry's own constant, and the reporter's PIWI_ENV_KEYS map
    // referenced in comments), plus reporter-side vars the app only *mentions*
    // in generated setup copy (the wizard, the API-key modal, the demo
    // assistant's CI steps) without reading them itself — they belong to the
    // reporter's own env map, not this one.
    const knownFalsePositives = new Set([
      'PIWI_AI',
      'PIWI_AI_MAX',
      'PIWI_ENV_VARS',
      'PIWI_ENV_CATEGORIES',
      'PIWI_ENV_KEYS',
      'PIWI_FEATURE_GROUPS',
      'PIWI_API_KEY',
      'PIWI_DASHBOARD_URL',
      'PIWI_OUTPUT_FILE',
      // Desktop-shell debug flag, read only by the Tauri Rust process (see
      // `desktop/src-tauri/src/lib.rs`), not the server — the app just names it
      // in the snapshot picker's "couldn't start" hint.
      'PIWI_DEBUG',
      // Set by the desktop shell for a repro run and read by the spec it
      // writes (see `shared/desktop-repro.ts`), never by the server.
      'PIWI_REPRO_RESULT',
      // Set by a launcher on the Playwright process and read by the reporter,
      // which stamps them on the run as `piwiOrigin`; the app reads the stamp.
      'PIWI_ORIGIN',
      'PIWI_ORIGIN_REF',
    ]);
    const realMissing = missing.filter((v) => !knownFalsePositives.has(v));
    expect(realMissing.sort()).toEqual([]);
  });

  test('registry defaults and clamps match the AI context-limit code constants', () => {
    for (const field of CONTEXT_LIMIT_FIELDS) {
      const meta = PIWI_ENV_VARS[field.envVar as PiwiEnvVarName] as PiwiEnvVarMeta | undefined;
      expect(meta, `${field.envVar} registered`).toBeDefined();
      expect(meta!.type, `${field.envVar} type`).toBe('number');
      expect(meta!.default, `${field.envVar} default`).toBe(String(DEFAULT_CONTEXT_LIMITS[field.key]));
      expect(meta!.min, `${field.envVar} min`).toBe(field.min);
      expect(meta!.max, `${field.envVar} max`).toBe(field.max);
    }
  });

  test('registry defaults and clamps match the ingest-limit code constants', () => {
    for (const field of INGEST_LIMIT_FIELDS) {
      const meta = PIWI_ENV_VARS[field.envVar as PiwiEnvVarName] as PiwiEnvVarMeta | undefined;
      expect(meta, `${field.envVar} registered`).toBeDefined();
      expect(meta!.type, `${field.envVar} type`).toBe('number');
      expect(meta!.default, `${field.envVar} default`).toBe(String(DEFAULT_INGEST_LIMITS[field.key]));
      expect(meta!.min, `${field.envVar} min`).toBe(field.min);
      expect(meta!.max, `${field.envVar} max`).toBe(field.max);
    }
  });

  test('registry default for wasted-wait patterns matches the code constant', () => {
    expect(PIWI_ENV_VARS.PIWI_WASTED_WAIT_PATTERNS.default).toBe(DEFAULT_WASTED_WAIT_PATTERNS.join(','));
  });

  test('registry default and clamps for the integrations sync interval match the code constants', () => {
    const meta = PIWI_ENV_VARS.PIWI_INTEGRATIONS_SYNC_MINUTES;
    expect(meta.type).toBe('number');
    expect(meta.default).toBe(String(DEFAULT_INTEGRATIONS_SYNC_MINUTES));
    expect(meta.min).toBe(MIN_INTEGRATIONS_SYNC_MINUTES);
    expect(meta.max).toBe(MAX_INTEGRATIONS_SYNC_MINUTES);
  });

  test('relevantWhen/requiredWhen only reference registered vars, never themselves', () => {
    for (const [name, meta] of allEntries) {
      for (const condition of [meta.relevantWhen, meta.requiredWhen]) {
        if (!condition) continue;
        for (const key of Object.keys(condition)) {
          expect(registered.has(key), `${name} condition references unknown var ${key}`).toBe(true);
          expect(key, `${name} condition references itself`).not.toBe(name);
        }
      }
    }
  });

  test('enum values only appear on enum-typed vars, and defaults are valid', () => {
    for (const [name, meta] of allEntries) {
      if (meta.enum) expect(meta.type, `${name} has enum values but type '${meta.type}'`).toBe('enum');
      if (meta.type === 'enum') {
        expect(meta.enum?.length, `${name} enum values`).toBeGreaterThan(0);
        if (meta.default !== undefined) expect(meta.enum, `${name} default in enum`).toContain(meta.default);
      }
      if (meta.type === 'number') {
        if (meta.min !== undefined && meta.max !== undefined) {
          expect(meta.min, `${name} min <= max`).toBeLessThanOrEqual(meta.max);
        }
        if (meta.default !== undefined) {
          const value = Number(meta.default);
          expect(Number.isFinite(value), `${name} numeric default`).toBe(true);
          if (meta.min !== undefined) expect(value, `${name} default >= min`).toBeGreaterThanOrEqual(meta.min);
          if (meta.max !== undefined) expect(value, `${name} default <= max`).toBeLessThanOrEqual(meta.max);
        }
      }
    }
  });

  test('secrets never carry a default value', () => {
    for (const [name, meta] of allEntries) {
      if (meta.secret) expect(meta.default, `${name} secret default`).toBeUndefined();
    }
  });

  test('vars added after the 0.14.0 baseline declare a semver `since`', () => {
    const baseline = new Set(BASELINE_VARS);
    for (const [name, meta] of allEntries) {
      if (baseline.has(name)) continue;
      expect(meta.since, `${name} is new and must declare since: '<first release>'`).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // The baseline list itself must not reference vars that no longer exist —
    // when a var is removed, drop it here and record `until` semantics in git.
    for (const name of BASELINE_VARS) {
      expect(registered.has(name), `baseline var ${name} no longer registered`).toBe(true);
    }
  });

  test('category metadata is complete and merge targets are renderable', () => {
    const orders = new Set<number>();
    for (const [category, meta] of Object.entries(PIWI_ENV_CATEGORIES)) {
      expect(meta.title.length, `${category} title`).toBeGreaterThan(0);
      expect(orders.has(meta.order), `${category} duplicate order ${meta.order}`).toBe(false);
      orders.add(meta.order);
      if (meta.mergeInto) {
        const target = PIWI_ENV_CATEGORIES[meta.mergeInto as PiwiEnvVarCategory];
        expect(target, `${category} merges into unknown category`).toBeDefined();
        expect(target.mergeInto, `${category} merges into a merged category`).toBeUndefined();
        expect(target.internal, `${category} merges into an internal category`).toBeFalsy();
      }
    }
  });

  test('version helpers order semvers and apply since/until ranges', () => {
    expect(compareVersions('0.14.0', '0.14.0')).toBe(0);
    expect(compareVersions('0.9.0', '0.14.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.9')).toBeGreaterThan(0);
    expect(compareVersions('0.14', '0.14.0')).toBe(0);
    // Baseline vars exist in every version.
    expect(envVarAppliesToVersion('PIWI_SITE_URL', '0.1.0')).toBe(true);
    // No baseline var declares a range yet, so the known-version list is empty
    // until the first post-baseline var lands.
    for (const version of knownRegistryVersions()) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
