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
 * Each target's copy is settled by `settleDatabase` after its build's first start, whatever the server's own
 * autovacuum setting.
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

/**
 * The rows ANALYZE reads from each table at the largest statistics target (300 × 10,000). A table of at most this
 * many rows is read whole, so its statistics depend on its data alone.
 */
export const FULL_SAMPLE_ROWS = 3_000_000;

/**
 * Prepare database `name` for measuring, once its build's startup work is done: autovacuum is off on every table
 * for the rest of the run, the dead rows the startup work left are vacuumed, and every table is analyzed at the
 * largest statistics target. Two databases holding the same data get the same planner statistics. Returns the
 * largest table and its row count; a table past `FULL_SAMPLE_ROWS` is sampled, not read whole.
 * `pg_stat_statements.track_utility=off` keeps all of it out of the counted statements.
 */
export async function settleDatabase(adminUrl, name) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl(adminUrl, name), { max: 1, onnotice: () => {} });
  try {
    const tables = await sql`
      SELECT c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;
    for (const t of tables)
      await sql.unsafe(`ALTER TABLE ${t.name} SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`);
    await sql.unsafe('VACUUM');
    await sql.unsafe('SET default_statistics_target = 10000');
    await sql.unsafe('ANALYZE');
    const [largest] = await sql`
      SELECT c.oid::regclass::text AS name, c.reltuples::float8 AS rows FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY c.reltuples DESC LIMIT 1`;
    return largest ?? null;
  } finally {
    await sql.end();
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
