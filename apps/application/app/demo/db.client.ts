/**
 * In-browser SQLite database for demo mode.
 *
 * Uses sql.js (SQLite compiled to WASM) and exposes a Drizzle ORM instance
 * via the sqlite-proxy driver so the same query code used on the server can
 * run unmodified in the browser.
 *
 * The SQLite database is kept in memory during the session and persisted to
 * IndexedDB so that changes survive page reloads.  On first load the database
 * is seeded from `public/demo/seed.sql`.
 *
 * This module is designed to work in both the browser main thread and in a
 * service worker context.  Call `configureDemoDb(baseUrl)` before the first
 * `getDemoDb()` call to set the base URL used to locate the WASM binary and
 * the seed SQL file.
 */

import type { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import * as initSqlJsLib from 'sql.js';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '~~/server/database/schema.sqlite';
import { backfillUnindexedProjects } from '~~/server/utils/locator-usages';
import { getAppSetting, setAppSetting } from '~~/server/utils/app-settings';
import { backfillDailyRollups, ROLLUPS_BACKFILLED_SETTING } from '#shared/handlers/analytics/rollups';
import { seedDemoReports } from './report-seed';
import { storeCommitTotals } from '~~/server/utils/coverage-totals';

/** Set once the demo computed the combined coverage of its seeded commits. */
const COVERAGE_TOTALS_SETTING = 'demo_coverage_totals_computed';

const initSqlJs = initSqlJsLib.default || initSqlJsLib;

type DemoDB = ReturnType<typeof drizzle<typeof schema>>;

// ── IndexedDB helpers ──────────────────────────────────────────────────────
const IDB_NAME = 'piwi-dashboard-demo';
const IDB_STORE = 'state';
const IDB_DB_KEY = 'sqlite';
const IDB_VERSION_KEY = 'seed-version';
/**
 * Key prefix for files an imported run brought with it (traces, screenshots).
 * They live beside the database rather than inside it: the SQLite image is
 * serialized whole on every persist, so megabytes of binary in a column would
 * be rewritten on each save.
 */
const IDB_BLOB_PREFIX = 'import-file:';

function adoptConnection(db: IDBDatabase): IDBDatabase {
  // Auto-close when another context (window vs service worker) runs an
  // upgrade, otherwise its open request would stay blocked forever.
  db.onversionchange = () => {
    db.close();
    if (idbInstance === db) idbInstance = null;
  };
  return db;
}

function createStoreOnUpgrade(req: IDBOpenDBRequest): void {
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(IDB_STORE)) {
      req.result.createObjectStore(IDB_STORE);
    }
  };
}

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // No explicit version: creates the DB at version 1 on first run and
    // opens whatever version exists otherwise.
    const req = indexedDB.open(IDB_NAME);
    createStoreOnUpgrade(req);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(IDB_STORE)) {
        resolve(adoptConnection(db));
        return;
      }
      // The DB exists but the store is missing: Firefox can leave an empty
      // database behind when the initial upgrade transaction is interrupted.
      // Re-open with a bumped version so onupgradeneeded fires and heals it.
      const retry = indexedDB.open(IDB_NAME, db.version + 1);
      db.close();
      createStoreOnUpgrade(retry);
      retry.onblocked = () => console.warn('[Demo DB] store repair blocked by another open connection');
      retry.onerror = () => reject(retry.error);
      retry.onsuccess = () => resolve(adoptConnection(retry.result));
    };
  });
}

function idbGet(idb: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(idb: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbKeys(idb: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result.map(String));
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(idb: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Module-level singletons ───────────────────────────────────────────────
let sqliteDb: SqlJsDatabase | null = null;
let drizzleDb: DemoDB | null = null;
let initPromise: Promise<void> | null = null;
let idbInstance: IDBDatabase | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let cachedStoredVersion: string | null = null;

/**
 * Base URL used to locate the WASM binary and seed SQL (without trailing
 * slash).  Defaults to '/' but should be overridden via `configureDemoDb`
 * before the first `getDemoDb()` call.
 */
let demoDbBaseUrl: string = '/';

/**
 * Set the base URL for the demo database assets (WASM binary and seed SQL).
 * Must be called before the first `getDemoDb()`.
 *
 * In the browser main thread, pass `config.app.baseURL` from `useRuntimeConfig()`.
 * In a service worker, pass the directory URL derived from `self.location.href`.
 */
export function configureDemoDb(baseUrl: string): void {
  demoDbBaseUrl = baseUrl;
}

/**
 * The configured demo base URL (see `configureDemoDb`). Used by demo API
 * handlers that fetch static assets (e.g. committed screenshots/traces), which
 * live under the same base as the WASM binary and seed SQL.
 */
export function getDemoDbBaseUrl(): string {
  return demoDbBaseUrl;
}

async function doPersist(): Promise<void> {
  if (!sqliteDb) {
    console.warn('[Demo DB] doPersist called but db not ready – skipping');
    return;
  }
  const data = sqliteDb.export();
  // The connection may have been closed by a versionchange from another
  // context; reopen on demand.
  idbInstance ??= await openIDB();
  await idbPut(idbInstance, IDB_DB_KEY, data);
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(doPersist, 500);
}

/**
 * Fetch the current build's demo seed version hash from the deployed
 * `seed.version.json`. That marker is regenerated alongside the seed on every
 * build and its hash covers the schema + data, so it is the source of truth for
 * what the running build expects. Fetched with `cache: 'no-cache'` so a
 * returning visitor always compares against the freshly-deployed marker rather
 * than a stale HTTP-cached one. Returns `null` when it can't be read (offline /
 * missing), in which case the caller keeps the persisted copy as-is.
 */
async function fetchCurrentSeedVersion(base: string): Promise<string | null> {
  try {
    const resp = await fetch(`${base}/demo/seed.version.json`, { cache: 'no-cache' });
    if (!resp.ok) return null;
    const info = (await resp.json()) as { hash?: string };
    return typeof info.hash === 'string' && info.hash.length > 0 ? info.hash : null;
  } catch {
    return null;
  }
}

/**
 * Seed a fresh in-memory database from the static `seed.sql` dump, persist it to
 * IndexedDB, and record the build version it was seeded from.
 */
async function seedFreshDatabase(SQL: SqlJsStatic, base: string, version: string | null): Promise<void> {
  // Fetched with `cache: 'no-cache'` so the SQL matches the freshly-deployed
  // seed the version marker was compared against — a reseed triggered by a new
  // marker must not pull a stale HTTP-cached dump, or it would record the new
  // version against old data and never reseed again.
  const resp = await fetch(`${base}/demo/seed.sql`, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`[Demo] Failed to load seed.sql: ${resp.status} ${resp.statusText}`);
  }
  const seedSql = await resp.text();
  sqliteDb = new SQL.Database();
  sqliteDb.run(seedSql);
  await doPersist();
  cachedStoredVersion = version;
  if (idbInstance && version) {
    await idbPut(idbInstance, IDB_VERSION_KEY, version);
  }
}

/**
 * Decide whether a persisted demo database may be reused as-is, or must be
 * discarded and reseeded because its schema/data is obsolete.
 *
 * The in-browser demo DB is seeded once and then persisted to IndexedDB, so a
 * returning visitor keeps whatever schema they were first seeded with. When the
 * app later adds a column (or otherwise changes the seed), queries against that
 * frozen schema fail with "no such column". Reuse the persisted copy ONLY when
 * we can prove it was seeded by the current build (`stored === current`):
 *   - a mismatch means the schema/seed changed since → reseed;
 *   - a missing stored version (legacy data from before version tracking) is
 *     treated as a mismatch → reseed;
 *   - an unknown current version (the marker fetch failed, e.g. offline) can't
 *     prove staleness, so keep the usable persisted copy rather than wiping it.
 */
export function canReusePersistedDemoDb(storedVersion: string | null, currentVersion: string | null): boolean {
  if (currentVersion === null) return true;
  return storedVersion === currentVersion;
}

async function initialize(): Promise<void> {
  const base = demoDbBaseUrl.replace(/\/$/, '');

  const SQL = await initSqlJs({
    locateFile: (file: string) => `${base}/demo/${file}`,
  });

  idbInstance = await openIDB();
  const savedData = (await idbGet(idbInstance, IDB_DB_KEY)) as Uint8Array | undefined | null;
  const hasSaved = savedData instanceof Uint8Array && savedData.length > 0;

  // The version the current build expects — the yardstick for staleness.
  const currentVersion = await fetchCurrentSeedVersion(base);

  if (hasSaved) {
    const v = await idbGet(idbInstance, IDB_VERSION_KEY);
    const storedVersion = typeof v === 'string' ? v : null;

    if (canReusePersistedDemoDb(storedVersion, currentVersion)) {
      // Persisted schema matches the current build (or we can't verify) — reuse.
      sqliteDb = new SQL.Database(savedData);
      cachedStoredVersion = storedVersion;
    } else {
      // Persisted schema is obsolete (a column/table changed since it was
      // seeded) — discard and reseed so the demo never queries a stale schema.
      console.info('[Demo DB] seed version changed — reseeding with the latest demo data');
      await seedFreshDatabase(SQL, base, currentVersion);
    }
  } else {
    // First run: seed from the static SQL dump.
    await seedFreshDatabase(SQL, base, currentVersion);
  }

  drizzleDb = drizzle(
    async (sql, params, method) => {
      try {
        if (method === 'run') {
          sqliteDb!.run(sql, params as import('sql.js').BindParams);
          schedulePersist();
          return { rows: [] };
        }

        // 'all' or 'get'
        const stmt = sqliteDb!.prepare(sql);
        stmt.bind(params as import('sql.js').BindParams);
        const rows: unknown[][] = [];
        while (stmt.step()) {
          rows.push(stmt.get() as unknown[]);
        }
        stmt.free();
        return { rows };
      } catch (e) {
        console.error('[Demo DB] query error', e, '\nSQL:', sql, '\nParams:', params);
        throw e;
      }
    },
    { schema },
  );

  // The server builds each project's locator index from its stored runs at
  // startup; the demo does the same when its database opens. Projects already
  // built are marked, so a reopened database skips them.
  await backfillUnindexedProjects(drizzleDb).catch((e) =>
    console.warn('[Demo DB] could not build the locator index', e),
  );

  // Daily rollups of the seeded runs, computed once, as the server's startup
  // backfill does.
  await (async () => {
    if (await getAppSetting(drizzleDb as any, ROLLUPS_BACKFILLED_SETTING)) return;
    await backfillDailyRollups(drizzleDb as any);
    await setAppSetting(drizzleDb as any, ROLLUPS_BACKFILLED_SETTING, new Date().toISOString());
  })()
    .catch((e) => console.warn('[Demo DB] could not compute the daily rollups', e))
    // The seeded report schedule and snapshots are rendered from the rollups, so they come after.
    .then(() => seedDemoReports(drizzleDb as any))
    .catch((e) => console.warn('[Demo DB] could not seed the report snapshots', e));

  // The combined coverage of each seeded commit with uploaded reports, as the
  // upload computes it on the server: today's point of the coverage trend.
  await (async () => {
    if (await getAppSetting(drizzleDb as any, COVERAGE_TOTALS_SETTING)) return;
    const commits = await drizzleDb!
      .selectDistinct({ projectId: schema.coverageReports.projectId, commit: schema.coverageReports.commit })
      .from(schema.coverageReports);
    for (const { projectId, commit } of commits) await storeCommitTotals(drizzleDb as any, projectId, commit);
    await setAppSetting(drizzleDb as any, COVERAGE_TOTALS_SETTING, new Date().toISOString());
  })().catch((e) => console.warn('[Demo DB] could not compute the coverage totals', e));
}

/**
 * Returns the singleton in-browser Drizzle instance, initializing it on
 * first call (fetching the seed SQL and opening IndexedDB).
 */
export async function getDemoDb(): Promise<DemoDB> {
  if (!initPromise) {
    initPromise = initialize().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  await initPromise;
  return drizzleDb!;
}

/**
 * Returns the seed version hash stored alongside the demo database in
 * IndexedDB.  Returns `null` if no version has been persisted yet (e.g.
 * first load or legacy data from before version tracking was added).
 *
 * Callers can compare this value against the current build's version
 * (e.g. `runtimeConfig.public.demoDataVersion`) to detect stale data.
 */
export async function getStoredDemoVersion(): Promise<string | null> {
  if (cachedStoredVersion !== null) return cachedStoredVersion;
  // Open IDB independently if not yet initialized
  idbInstance ??= await openIDB();
  const v = await idbGet(idbInstance, IDB_VERSION_KEY);
  cachedStoredVersion = typeof v === 'string' ? v : null;
  return cachedStoredVersion;
}

/**
 * Store the bytes of a file an import brought in, under the same storage path
 * the run's `files` rows point at, so serving it is a straight lookup.
 */
export async function putDemoImportedFile(path: string, bytes: Uint8Array | Blob): Promise<void> {
  idbInstance ??= await openIDB();
  // A Blob is stored by reference rather than copied through the heap, so an
  // imported archive can be handed over exactly as it was uploaded.
  await idbPut(idbInstance, IDB_BLOB_PREFIX + path, bytes);
}

/** Read back a file an import stored, or null when the demo never had it. */
export async function getDemoImportedFile(path: string): Promise<Uint8Array | null> {
  idbInstance ??= await openIDB();
  const value = await idbGet(idbInstance, IDB_BLOB_PREFIX + path);
  if (value instanceof Uint8Array) return value;
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return null;
}

/**
 * Wipes the persisted database from IndexedDB so the next call to
 * getDemoDb() re-seeds from the original seed.sql.
 */
export async function resetDemoDb(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  sqliteDb?.close();
  sqliteDb = null;
  drizzleDb = null;
  initPromise = null;
  cachedStoredVersion = null;
  if (idbInstance) {
    await idbDelete(idbInstance, IDB_DB_KEY);
    await idbDelete(idbInstance, IDB_VERSION_KEY);
    // Imported files belong to the database that referenced them; a reset that
    // left them behind would leak megabytes no run can reach.
    for (const key of await idbKeys(idbInstance)) {
      if (key.startsWith(IDB_BLOB_PREFIX)) await idbDelete(idbInstance, key);
    }
    idbInstance.close();
    idbInstance = null;
  }
}
