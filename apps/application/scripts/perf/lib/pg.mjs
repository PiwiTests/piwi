/**
 * PostgreSQL side of the suite: the databases each target runs on, and the
 * statements each request ran there, read from `pg_stat_statements`. The
 * extension sees every build, old or new, with no help from the application,
 * so it is what compares a build that predates the suite's tracing.
 *
 * The server must load the extension at startup:
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine \
 *     -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track_utility=off
 *
 * The seed is settled by `settleSeed` and each target's copy by `settleCopy` after its build's first start,
 * whatever the server's own autovacuum setting.
 */

const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** Connect to the maintenance database of the server `adminUrl` points at. */
export async function connectAdmin(adminUrl) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(adminUrl, { max: 2, onnotice: () => {} });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
    await sql`SELECT 1 FROM pg_stat_statements LIMIT 1`;
  } catch (error) {
    await sql.end();
    throw new Error(
      `pg_stat_statements is not available on ${redact(adminUrl)} (${error.message}). Start PostgreSQL with ` +
        '`-c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track_utility=off`.',
    );
  }
  const [{ version }] = await sql`SELECT current_setting('server_version') AS version`;
  return { sql, version };
}

/** The URL of database `name` on the same server. */
export function databaseUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export function redact(url) {
  const u = new URL(url);
  if (u.password) u.password = '***';
  return u.toString();
}

export async function recreateDatabase(sql, name, template = null) {
  await sql.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  await sql.unsafe(`CREATE DATABASE ${quote(name)}${template ? ` TEMPLATE ${quote(template)}` : ''}`);
}

export async function dropDatabase(sql, name) {
  await sql.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
}

/** The ordinary tables of the database `sql` is connected to, and whether autovacuum is off on each. */
async function userTables(sql) {
  return sql`
    SELECT c.oid::regclass::text AS name,
           coalesce('autovacuum_enabled=false' = ANY(c.reloptions), false) AS frozen
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
}

const freeze = (sql, table) =>
  sql.unsafe(`ALTER TABLE ${table} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`);

/** The largest statistics target PostgreSQL takes; ANALYZE reads up to 300 rows and 300 blocks per unit of it. */
export const MAX_STATISTICS_TARGET = 10_000;

/**
 * The statistics target at which ANALYZE reads every row and every block of a table of `rows` rows in `blocks`
 * blocks: never below the server's `defaultTarget`, null past `MAX_STATISTICS_TARGET`.
 */
export function fullReadTarget(rows, blocks, defaultTarget) {
  const target = Math.max(defaultTarget, Math.ceil(Math.max(rows, blocks) / 300));
  return target <= MAX_STATISTICS_TARGET ? target : null;
}

/**
 * Prepare the seed database `name` once it holds the whole dataset: autovacuum off on every table, then vacuumed and
 * analyzed at the server's statistics target. A copy made from it (`CREATE DATABASE … TEMPLATE`) carries the same
 * planner statistics and storage parameters. `pg_stat_statements.track_utility=off` keeps it out of the counts.
 */
export async function settleSeed(adminUrl, name) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl(adminUrl, name), { max: 1, onnotice: () => {} });
  try {
    for (const t of await userTables(sql)) await freeze(sql, t.name);
    await sql.unsafe('VACUUM (ANALYZE)');
  } finally {
    await sql.end();
  }
}

/**
 * Prepare copy `name` for measuring, once its build's startup work is done and its server stopped (a stopped
 * server's writes are in the cumulative statistics): autovacuum off on every table the build created, the copy
 * vacuumed, and each table the build wrote to (`n_mod_since_analyze`, zero on a fresh copy) analyzed at the target
 * that reads every row of it (`fullReadTarget`), so the same data gets the same statistics. The other tables keep
 * the seed's. Returns the tables analyzed, with their rows and the target, null where the table is too large to read
 * whole and was sampled at `MAX_STATISTICS_TARGET`.
 */
export async function settleCopy(adminUrl, name) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl(adminUrl, name), { max: 1, onnotice: () => {} });
  try {
    for (const t of await userTables(sql)) if (!t.frozen) await freeze(sql, t.name);
    const modified = await sql`
      SELECT relid::regclass::text AS name FROM pg_stat_user_tables WHERE n_mod_since_analyze > 0 ORDER BY 1`;
    await sql.unsafe('VACUUM');
    const [{ target: defaultTarget }] = await sql`
      SELECT current_setting('default_statistics_target')::int AS target`;
    const analyzed = [];
    for (const { name: table } of modified) {
      const [{ rows, blocks }] = await sql.unsafe(
        `SELECT count(*)::float8 AS rows,
                (pg_relation_size('${table.replaceAll("'", "''")}') / current_setting('block_size')::int)::float8 AS blocks
         FROM ${table}`,
      );
      const target = fullReadTarget(rows, blocks, defaultTarget);
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL default_statistics_target = ${target ?? MAX_STATISTICS_TARGET}`);
        await tx.unsafe(`ANALYZE ${table}`);
      });
      analyzed.push({ table, rows, target });
    }
    return analyzed;
  } finally {
    await sql.end();
  }
}

/**
 * Wait until no session of a stopped server is still connected to `database`: a session's writes reach the
 * cumulative statistics as it ends.
 */
export async function waitForDisconnect(sql, database, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${database} AND pid <> pg_backend_pid()`;
    if (n === 0) return;
    if (Date.now() > deadline) throw new Error(`${n} sessions still connected to ${database}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** How many statements of `database` are running right now. */
export async function activeStatements(sql, database) {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = ${database} AND state = 'active' AND pid <> pg_backend_pid()`;
  return n;
}

/**
 * Every statement recorded for `database`, keyed by query id, without its
 * text: reading the texts reads every text the server keeps, the seed's bulk
 * inserts included (tens of MB), which took longer than most requests the
 * suite measures. `nameStatements` reads the texts once, at the end.
 */
export async function statementSnapshot(sql, database) {
  const rows = await sql`
    SELECT s.queryid::text AS id, s.calls::float8 AS calls, s.total_exec_time AS exec_ms,
           s.rows::float8 AS rows, (s.shared_blks_hit + s.shared_blks_read)::float8 AS blocks
    FROM pg_stat_statements(false) s JOIN pg_database d ON d.oid = s.dbid
    WHERE d.datname = ${database}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * What ran between two snapshots: totals and one entry per distinct statement,
 * most-called first. Each entry names its statement by query id until
 * `nameStatements` gives it its text.
 */
export function statementDelta(before, after) {
  const queries = [];
  for (const [id, now] of after) {
    const then = before.get(id);
    const calls = now.calls - (then?.calls ?? 0);
    if (calls <= 0) continue;
    queries.push({
      id,
      calls,
      ms: now.exec_ms - (then?.exec_ms ?? 0),
      rows: now.rows - (then?.rows ?? 0),
      blocks: now.blocks - (then?.blocks ?? 0),
    });
  }
  queries.sort((a, b) => b.calls - a.calls || b.ms - a.ms);
  const sum = (key) => queries.reduce((total, q) => total + q[key], 0);
  return { statements: sum('calls'), ms: sum('ms'), rows: sum('rows'), blocks: sum('blocks'), queries };
}

/** Replace the query id of each entry of `queries` (from `statementDelta` on `database`) by its text, in one read. */
export async function nameStatements(sql, database, queries) {
  const unnamed = queries.filter((q) => q.id !== undefined);
  const ids = [...new Set(unnamed.map((q) => q.id))];
  if (ids.length === 0) return;
  const rows = await sql`
    SELECT s.queryid::text AS id, s.query
    FROM pg_stat_statements(true) s JOIN pg_database d ON d.oid = s.dbid
    WHERE d.datname = ${database} AND s.queryid::text = ANY(${ids})`;
  const texts = new Map(rows.map((r) => [r.id, r.query]));
  for (const q of unnamed) {
    q.query = texts.get(q.id) ?? `(statement ${q.id})`;
    delete q.id;
  }
}
