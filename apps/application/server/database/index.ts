// Import SQLite drizzle for static type inference.
// At runtime the correct driver is selected based on PIWI_DATABASE_URL;
// TypeScript uses the SQLite types as the canonical reference throughout.
import { drizzle as sqliteDrizzle } from 'drizzle-orm/libsql/sqlite3';
import * as sqliteSchema from './schema.sqlite';
import {
  ALIAS_SAMPLES_BACKFILLED_SETTING,
  backfillAliasSamples,
  reclusterFailureFingerprints,
} from '#shared/handlers/failure-cluster-recluster';
import { applyMigrations } from './migration-history';
import { postgresMigrationTarget, sqliteMigrationTarget } from './migration-targets';
import { configureSqliteConnections, sqliteClientConfig } from './sqlite-connections';
import { isOtelTracingEnabled, traceSqlStatements } from '../utils/otel';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

type DB = ReturnType<typeof sqliteDrizzle<typeof sqliteSchema>>;

/** The resolved database client returned by getDatabase(). Import this instead of re-deriving it locally. */
export type DbClient = Awaited<ReturnType<typeof getDatabase>>;

let db: DB;
let initPromise: Promise<DB> | null = null;
let migrationPromise: Promise<void> | null = null;

// Detect which database backend to use
const databaseUrl = process.env.PIWI_DATABASE_URL;

/**
 * Which SQL dialect the runtime database speaks. Use this to guard
 * dialect-specific statements (PRAGMA, VACUUM) — the drizzle client is typed
 * against the SQLite API even when PostgreSQL is the actual backend.
 */
export function getDialect(): 'postgres' | 'sqlite' {
  return databaseUrl ? 'postgres' : 'sqlite';
}

/**
 * Kick off the trace-resource link backfill in the background, then the
 * measuring of every blob whose `stored_size` is null. Detached on purpose:
 * the first run after upgrade may read many trace manifests, and blocking
 * startup on it would delay the first request. Per-resource cleanup keeps its
 * safe whole-project fallback until a project is fully indexed, so running this
 * lazily never risks a premature delete; until a blob is measured, the storage
 * stats count it at its uploaded size. Imported dynamically to avoid a module
 * cycle (the util imports this file for `getDatabase`).
 */
function backfillTraceResourceLinks(): void {
  void (async () => {
    try {
      const { backfillTraceBlobResources } = await import('../utils/trace-blobs');
      const indexed = await backfillTraceBlobResources(db);
      if (indexed > 0) console.log(`[Database] Trace-resource backfill indexed ${indexed} blob(s)`);
    } catch (err) {
      console.error('[Database] Trace-resource backfill failed:', err);
    }
    try {
      const { backfillTraceBlobStoredSizes } = await import('../utils/trace-blobs');
      const measured = await backfillTraceBlobStoredSizes(db);
      if (measured > 0) console.log(`[Database] Trace-blob size backfill measured ${measured} blob(s)`);
    } catch (err) {
      console.error('[Database] Trace-blob size backfill failed:', err);
    }
  })();
}

/**
 * Take the query out of the route keys stored with one, once per instance,
 * without blocking startup; a failure is logged and the next start tries again.
 */
function rewriteRouteKeys(target: DB): void {
  void (async () => {
    try {
      const { rewriteQueryRouteKeysOnce } = await import('../utils/graph-route-keys');
      const rewrite = await rewriteQueryRouteKeysOnce(target as any);
      if (rewrite && rewrite.nodes + rewrite.edges + rewrite.probes + rewrite.gaps > 0) {
        console.log(
          `[Database] Route keys without the query: ${rewrite.nodes} node(s), ${rewrite.edges} edge(s), ${rewrite.probes} probe(s), ${rewrite.gaps} gap(s)`,
        );
      }
    } catch (err) {
      console.error('[Database] Route-key rewrite failed:', err);
    }
  })();
}

/**
 * Compute the daily rollups of the runs already stored, once per instance,
 * without blocking startup. Recomputing is idempotent, so an interrupted
 * backfill simply runs again at the next start.
 */
function backfillAnalyticsRollups(): void {
  void (async () => {
    try {
      const { getAppSetting, setAppSetting } = await import('../utils/app-settings');
      const { backfillDailyRollups, ROLLUPS_BACKFILLED_SETTING } = await import('#shared/handlers/analytics/rollups');
      if (await getAppSetting(db as any, ROLLUPS_BACKFILLED_SETTING)) return;
      const cells = await backfillDailyRollups(db as any);
      await setAppSetting(db as any, ROLLUPS_BACKFILLED_SETTING, new Date().toISOString());
      if (cells > 0) console.log(`[Database] Analytics rollup backfill computed ${cells} cell(s)`);
    } catch (err) {
      console.error('[Database] Analytics rollup backfill failed:', err);
    }
  })();
}

/**
 * Give the retries stored without an attempt history one from their run's
 * stored attempts (`backfillAttemptHistoriesOnce`), once per instance, without
 * blocking startup; an interrupted backfill resumes at the next start.
 */
function backfillAttemptHistories(): void {
  void (async () => {
    try {
      const { backfillAttemptHistoriesOnce } = await import('../utils/attempt-history-backfill');
      const filled = await backfillAttemptHistoriesOnce(db as any);
      if (filled) console.log(`[Database] Attempt-history backfill filled ${filled} execution(s)`);
    } catch (err) {
      console.error('[Database] Attempt-history backfill failed:', err);
    }
  })();
}

/**
 * Hide each credential's shape in the test errors stored before ingest hid
 * them (`hideSecretShapesInStoredErrorsOnce`): the executions' errors, their
 * steps' and hooks' errors, the runs' errors. Once per instance, without
 * blocking startup; an interrupted pass resumes at the next start.
 */
function hideSecretsInStoredErrors(): void {
  void (async () => {
    try {
      const { hideSecretShapesInStoredErrorsOnce } = await import('../utils/error-secrets-backfill');
      const hidden = await hideSecretShapesInStoredErrorsOnce(db as any);
      if (hidden) console.log(`[Database] Credentials hidden in ${hidden} stored error(s)`);
    } catch (err) {
      console.error('[Database] Hiding credentials in stored errors failed:', err);
    }
  })();
}

/**
 * Re-fingerprint the failure clusters (`reclusterFailureFingerprints`), after
 * giving a sample to the aliases stored without one (`backfillAliasSamples`),
 * then hiding each credential's shape in the clusters' and aliases' samples
 * (`hideSecretShapesInClusterSamples`), each once per instance. Startup waits
 * for all three, so a sample that changed is fingerprinted again before ingest
 * fingerprints the same failure. A failure is logged, and the next start tries
 * again.
 */
async function reclusterFailureClusters(target: DB): Promise<void> {
  try {
    const { getAppSetting, setAppSetting } = await import('../utils/app-settings');
    if (!(await getAppSetting(target, ALIAS_SAMPLES_BACKFILLED_SETTING))) {
      const found = await backfillAliasSamples(target);
      await setAppSetting(target, ALIAS_SAMPLES_BACKFILLED_SETTING, new Date().toISOString());
      if (found > 0) console.log(`[Database] Failure-cluster alias backfill found ${found} sample(s)`);
    }
    const { CLUSTER_SAMPLE_SECRETS_SETTING, hideSecretShapesInClusterSamples } =
      await import('../utils/error-secrets-backfill');
    if (!(await getAppSetting(target, CLUSTER_SAMPLE_SECRETS_SETTING))) {
      const hidden = await hideSecretShapesInClusterSamples(target);
      await setAppSetting(target, CLUSTER_SAMPLE_SECRETS_SETTING, new Date().toISOString());
      if (hidden > 0) console.log(`[Database] Credentials hidden in ${hidden} failure-cluster sample(s)`);
    }
    const { updated, merged } = await reclusterFailureFingerprints(target);
    if (updated || merged) {
      console.log(`[Database] Failure-cluster re-fingerprinting: ${updated} updated, ${merged} merged`);
    }
  } catch (err) {
    console.error('[Database] Failure-cluster re-fingerprinting failed:', err);
  }
}

/**
 * Release the `cluster.new` claim the migration adding `announced_at` set on
 * the clusters no run announced (`releaseUnannouncedClusterClaimsOnce`), once
 * per instance. Startup waits for it, so no run claims a cluster before it. A
 * failure is logged, and the next start tries again.
 */
async function releaseUnannouncedClusterClaims(target: DB): Promise<void> {
  try {
    const { releaseUnannouncedClusterClaimsOnce } = await import('../utils/notifications/run-notifications');
    const released = await releaseUnannouncedClusterClaimsOnce(target as any);
    if (released) console.log(`[Database] ${released} failure cluster(s) left for a run to announce`);
  } catch (err) {
    console.error('[Database] Releasing unannounced failure-cluster claims failed:', err);
  }
}

/**
 * Open the database and bring its schema up to date, once per process: the
 * callers that arrive while it is still opening (the startup plugins, the first
 * requests) share the same connection and the same migration run.
 */
export function initDatabase(): Promise<DB> {
  initPromise ??= openDatabase();
  return initPromise;
}

async function openDatabase(): Promise<DB> {
  if (!db) {
    if (databaseUrl) {
      // PostgreSQL path
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      const { default: postgres } = await import('postgres');

      const client = postgres(databaseUrl);
      const pgDb = drizzle(client);
      if (isOtelTracingEnabled()) await traceSqlStatements('postgres', pgDb, client);
      // Cast to the canonical SQLite DB type so callers retain typed query results
      db = pgDb as unknown as DB;

      migrationPromise = (async () => {
        try {
          const migrationsFolder = await resolveMigrationsFolder('migrations-pg');
          console.log(`[Database] Running PostgreSQL migrations from ${migrationsFolder}`);
          const target = postgresMigrationTarget(client, () => migrate(pgDb, { migrationsFolder }));
          await applyMigrations(target, migrationsFolder);
          console.log('[Database] PostgreSQL migrations completed successfully');
          await reclusterFailureClusters(db);
          await releaseUnannouncedClusterClaims(db);
          rewriteRouteKeys(db as any);
          backfillTraceResourceLinks();
          backfillAnalyticsRollups();
          backfillAttemptHistories();
          hideSecretsInStoredErrors();
        } catch (error) {
          console.error('[Database] Migration error:', error);
          throw error;
        }
      })();
    } else {
      // SQLite path (default)
      const { migrate } = await import('drizzle-orm/libsql/migrator');
      const { pathToFileURL } = await import('url');

      if (!process.env.PIWI_DATABASE_PATH && !existsSync('.data')) {
        mkdirSync('.data');
      }

      const dbPath = process.env.PIWI_DATABASE_PATH || '.data/piwi.db';
      const absolutePath = resolve(dbPath);
      const dbUrl = pathToFileURL(absolutePath).href;
      const isFreshDatabase = !existsSync(absolutePath);

      // Create client with WAL mode for better concurrent read/write performance.
      // The local-file entry: the package's main one also loads its remote clients.
      const { createClient } = await import('@libsql/client/sqlite3');
      const client = createClient(sqliteClientConfig(dbUrl));
      if (isFreshDatabase) {
        // Must be set before the first table is created (a no-op on existing
        // databases unless a full VACUUM runs) — enables `PRAGMA
        // incremental_vacuum` to reclaim pages after bulk deletes.
        await client.execute('PRAGMA auto_vacuum=INCREMENTAL');
      }
      await client.execute('PRAGMA journal_mode=WAL');
      await configureSqliteConnections(client);
      const sqliteDb = sqliteDrizzle(client, { schema: sqliteSchema });
      if (isOtelTracingEnabled()) await traceSqlStatements('sqlite', sqliteDb, client);
      db = sqliteDb;

      migrationPromise = (async () => {
        try {
          const migrationsFolder = await resolveMigrationsFolder('migrations');
          console.log(`[Database] Running SQLite migrations from ${migrationsFolder}`);
          // A history repair needs a client with a single connection.
          const migrationClient = createClient(sqliteClientConfig(dbUrl, 1));
          try {
            const target = sqliteMigrationTarget(migrationClient, () => migrate(db, { migrationsFolder }));
            await applyMigrations(target, migrationsFolder);
          } finally {
            migrationClient.close();
          }
          console.log('[Database] SQLite migrations completed successfully');
          await reclusterFailureClusters(db);
          await releaseUnannouncedClusterClaims(db);
          rewriteRouteKeys(db);
          backfillTraceResourceLinks();
          backfillAnalyticsRollups();
          backfillAttemptHistories();
          hideSecretsInStoredErrors();
        } catch (error) {
          console.error('[Database] Migration error:', error);
          throw error;
        }
      })();
    }
  }

  // Wait for migrations to complete before returning
  if (migrationPromise) {
    await migrationPromise;
    migrationPromise = null;
  }

  return db;
}

async function resolveMigrationsFolder(folderName: string): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Nitro sets import.meta.url to the server entry (.output/server/index.mjs),
  // so __dirname is the server output dir — migrations are a direct sibling folder.
  const candidates = [
    resolve(__dirname, `database/${folderName}`),
    // Fallback: when __dirname is the chunks/nitro/ subdirectory
    resolve(__dirname, `../../database/${folderName}`),
    // Development: source tree path (CWD = application/)
    resolve(process.cwd(), `server/database/${folderName}`),
    // Running from app root with .output present
    resolve(process.cwd(), `.output/server/database/${folderName}`),
    // Docker: CWD is /app but the app lives under /app/application/
    resolve(process.cwd(), `application/.output/server/database/${folderName}`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  console.error(`[Database] Migrations folder not found. Tried:`);
  for (const candidate of candidates) {
    console.error(`  - ${candidate}`);
  }
  console.error(`[Database] __dirname: ${__dirname}`);
  console.error(`[Database] process.cwd(): ${process.cwd()}`);
  throw new Error(`Migrations folder not found: ${candidates[candidates.length - 1]}`);
}

export async function getDatabase() {
  if (!db) {
    return await initDatabase();
  }

  // Wait for migrations to complete if they're still running
  if (migrationPromise) {
    await migrationPromise;
    migrationPromise = null;
  }

  return db;
}
