import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * The project-scoped capability probes on PostgreSQL, under its generic plan: for a project with none of the rows a
 * probe looks for, on an instance whose other projects have them all, no probe reads a whole large table. Runs
 * against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_capability_probes_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

/** The tables a probe must read through an index: each holds rows per run or per test, of every project. */
const LARGE_TABLES = ['network_requests', 'test_runs_cases', 'locator_snapshots', 'test_run_resource_reports'];

/** The project that only sends reports, beside twenty that use the fixtures, a backend, healing and flaky retries. */
const BARE_PROJECT = 21;

describe.skipIf(!postgresUrl)('the capability probes on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { getCapabilityEvidence } = await import('../../shared/handlers/setup-status');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 1 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
    await db
      .insert(schema.projects)
      .values(Array.from({ length: BARE_PROJECT }, (_, i) => ({ id: i + 1, name: `probes-${i + 1}` })));
    await client.unsafe(`insert into test_runs (id, project_id, status, start_time, created_at)
      select g, 1 + (g % ${BARE_PROJECT}), 'passed', now(), now() from generate_series(1, 1050) g`);
    await client.unsafe(`insert into test_cases (id, project_id, file_path, title, created_at, updated_at)
      select p * 100 + i, p, 'a.spec.ts', 't' || i, now(), now() from generate_series(1, ${BARE_PROJECT}) p, generate_series(1, 20) i`);
    await client.unsafe(`insert into test_runs_cases (test_run_id, test_case_id, status, duration, retries, aria_snapshot, passed_after_failure, created_at)
      select r.id, r.project_id * 100 + i, 'passed', 1, 0,
        case when r.project_id <> ${BARE_PROJECT} then '- main' end,
        r.project_id <> ${BARE_PROJECT} and i = 1, now()
      from test_runs r, generate_series(1, 20) i`);
    await client.unsafe(`insert into network_requests (test_runs_case_id, test_run_id, method, url, normalized_url, status, server_logs)
      select c.id, c.test_run_id, 'GET', 'u', 'u', 200, '[]'::jsonb
      from test_runs_cases c join test_runs r on r.id = c.test_run_id, generate_series(1, 10) i
      where r.project_id <> ${BARE_PROJECT}`);
    await client.unsafe(`insert into locator_snapshots (test_case_id, location, used_method, used_args, used_args_fp, element_attrs, alternatives, last_seen_at)
      select c.id, 'a.spec.ts:' || i, 'getByRole', '[]', 'fp', '{}', '[]', now()
      from test_cases c, generate_series(1, 100) i where c.project_id <> ${BARE_PROJECT}`);
    await client.unsafe(`insert into test_run_resource_reports (run_id, shard, report, updated_at)
      select id, 0, '{}'::jsonb, now() from test_runs where project_id <> ${BARE_PROJECT}`);
    await client.unsafe('analyze');
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('find each row of a project that has them', async () => {
    const evidence = await getCapabilityEvidence(db as never, 1, { fresh: true });
    for (const id of [
      'fixtures',
      'backend-logs',
      'locator-healing',
      'green-samples',
      'flake-lab',
      'resources',
    ] as const) {
      expect(evidence[id], id).toBe(true);
    }
  });

  test('read no large table whole for a project that has none of their rows', async () => {
    const statements: Array<{ query: string; params: unknown[] }> = [];
    const logged = drizzle(client, {
      schema,
      logger: { logQuery: (query, params) => statements.push({ query, params }) },
    });
    const evidence = await getCapabilityEvidence(logged as never, BARE_PROJECT, { fresh: true });
    expect(evidence.reporter).toBe(true);
    for (const id of [
      'fixtures',
      'backend-logs',
      'locator-healing',
      'green-samples',
      'flake-lab',
      'resources',
    ] as const) {
      expect(evidence[id], id).toBe(false);
    }

    await client.unsafe('SET plan_cache_mode = force_generic_plan');
    const scans: string[] = [];
    for (const [index, statement] of statements.entries()) {
      const name = `probe_${index}`;
      await client.unsafe(`PREPARE ${name} AS ${statement.query}`);
      const args = statement.params.map((value) =>
        typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value),
      );
      const plan = await client.unsafe(`EXPLAIN EXECUTE ${name}${args.length ? `(${args.join(', ')})` : ''}`);
      await client.unsafe(`DEALLOCATE ${name}`);
      for (const row of plan) {
        const line = String(row['QUERY PLAN']);
        const table = LARGE_TABLES.find((t) => line.includes(`Seq Scan on ${t}`));
        if (table) scans.push(`${table}: ${statement.query}`);
      }
    }
    expect(scans).toEqual([]);
  });
});
