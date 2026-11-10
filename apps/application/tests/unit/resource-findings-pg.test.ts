import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { WireResourceFinding } from '../../shared/types';

/**
 * A project's resource finding history on PostgreSQL, where runs that finish
 * together record their findings in transactions that run at the same time.
 * Runs against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_resource_findings_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));
/** How many projects each race is run in: one race may come out right by chance. */
const ROUNDS = 6;

describe.skipIf(!postgresUrl)('resource finding history on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const { eq } = await import('drizzle-orm');
  const schema = await import('../../server/database/schema.pg');
  const { demoResourceReport } = await import('../../shared/demo/demo-resources.mjs');
  const { saveResourceReportPart } = await import('../../shared/handlers/resource-reports');
  const { recordRunResourceFindings, FIXED_AFTER_CLEAN_RUNS } = await import('../../shared/handlers/resource-findings');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let minute = 0;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 6 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  const leakAt = (line: number): WireResourceFinding => ({
    verdict: 'leaked',
    kind: 'context',
    where: `tests/cart.spec.ts:${line}`,
    site: `tests/cart.spec.ts:${line}`,
    scope: 'test',
    tests: 1,
    count: 1,
  });

  async function project(name: string): Promise<number> {
    const [row] = await db.insert(schema.projects).values({ name, defaultBranch: 'main' }).returning();
    return row!.id;
  }

  /** A finished full run of the default branch, a minute after the one before, with these findings. */
  async function run(projectId: number, findings: WireResourceFinding[]): Promise<number> {
    const [row] = await db
      .insert(schema.testRuns)
      .values({
        projectId,
        status: 'passed',
        startTime: new Date(Date.UTC(2026, 0, 1) + ++minute * 60_000),
        branch: 'main',
      })
      .returning();
    const part = demoResourceReport({
      leaky: false,
      wallMs: 60_000,
      workers: [{ worker: 0, tests: 2 }],
      fixtureFile: 'tests/fixtures.ts',
      handleTest: { title: 'exports', file: 'tests/reports.spec.ts' },
      artifactBytes: 0,
      shardIndex: null,
    });
    await saveResourceReportPart(db as any, row!.id, { ...part, findings });
    return row!.id;
  }

  const record = (id: number) => recordRunResourceFindings(db as any, id);
  const findingsOf = (projectId: number) =>
    db.select().from(schema.resourceFindings).where(eq(schema.resourceFindings.projectId, projectId));

  test('two runs that each show one of two open findings both record, whichever finishes first', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await project(`two-findings-${round}`);
      await record(await run(id, [leakAt(10), leakAt(40)]));
      const [a, b] = [await run(id, [leakAt(10)]), await run(id, [leakAt(40)])];
      await Promise.all([record(a), record(b)]);
      const occurrences = await db.select().from(schema.resourceOccurrences);
      expect(occurrences.filter((o) => o.runId === a || o.runId === b)).toHaveLength(2);
    }
  });

  test('a finding shown by the later of two runs that finish together stays open', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await project(`fifth-clean-${round}`);
      await record(await run(id, [leakAt(10)]));
      for (let i = 1; i < FIXED_AFTER_CLEAN_RUNS; i++) await record(await run(id, []));
      // The fifth clean run, and a run started after it that shows the leak.
      const [clean, shows] = [await run(id, []), await run(id, [leakAt(10)])];
      await Promise.all([record(clean), record(shows)]);
      const [finding] = await findingsOf(id);
      expect(finding).toMatchObject({ status: 'open', lastSeenRunId: shows });
    }
  });

  test('two runs that show the same new leak at once both keep their showing', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const id = await project(`same-new-leak-${round}`);
      const [a, b] = [await run(id, [leakAt(10)]), await run(id, [leakAt(10)])];
      await Promise.all([record(a), record(b)]);
      const findings = await findingsOf(id);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ occurrences: 2, firstSeenRunId: a, lastSeenRunId: b });
    }
  });
});
