import { afterAll, beforeAll, describe } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * Whether a later run posted on a run's pull request, on PostgreSQL. Runs against `PIWI_POSTGRES_TEST_URL`, in a
 * database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_pr_feedback_newer_post_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

describe.skipIf(!postgresUrl)('a later post on the pull request of a run, on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { newerPostCases } = await import('./pr-feedback-newer-post.cases');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let nextProject = 0;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url)),
    });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  newerPostCases(() => ({
    db: db as never,
    insertRuns: async (ids) => {
      const [project] = await db
        .insert(schema.projects)
        .values({ name: `newer-post-${++nextProject}` })
        .returning();
      await db
        .insert(schema.testRuns)
        .values(ids.map((id) => ({ id, projectId: project!.id, status: 'passed', startTime: new Date() })));
      return project!.id;
    },
  }));
});
