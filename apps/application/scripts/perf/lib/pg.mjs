/**
 * PostgreSQL side of the suite: the databases each target runs on, and the
 * statements each request ran there, read from `pg_stat_statements`. The
 * extension sees every build, old or new, with no help from the application,
 * so it is what compares a build that predates the suite's tracing.
 *
 * The server must load the extension at startup:
 *   docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine \
 *     -c shared_preload_libraries=pg_stat_statements -c pg_stat_statements.track_utility=off
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
