import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getAriaSampling } = await import('#shared/handlers/aria-sampling');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'sampling-project' });
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'never' });
});

describe('green ARIA sampling and the green-samples capability', () => {
  test('a project that declines green samples is due none', async () => {
    expect((await getAriaSampling(db as never, 1)).tests.map((t) => t.title)).toEqual(['never']);

    await setProjectDecisions(db as never, 1, { 'green-samples': 'declined' });

    expect((await getAriaSampling(db as never, 1)).tests).toEqual([]);
  });

  test('an instance decline applies unless the project enables them', async () => {
    await setInstanceDecisions(db as never, { 'green-samples': 'declined' });
    expect((await getAriaSampling(db as never, 1)).tests).toEqual([]);

    await setProjectDecisions(db as never, 1, { 'green-samples': 'enabled' });
    expect((await getAriaSampling(db as never, 1)).tests.map((t) => t.title)).toEqual(['never']);
  });
});
