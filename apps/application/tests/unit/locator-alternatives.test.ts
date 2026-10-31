import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { getLocatorAlternatives } = await import('../../server/utils/locator-alternatives');
const { getProjectTestCases, parseTestCasesQuery } = await import('../../shared/handlers/projects');

let db: ReturnType<typeof drizzle<typeof schema>>;

const snapshot = (id: number, testCaseId: number, location: string, alternatives: unknown, at: number) => ({
  id,
  testCaseId,
  location,
  usedMethod: 'locator',
  usedArgs: '[]',
  usedArgsFp: `fp-${id}`,
  elementTag: 'tr',
  elementAttrs: '{}',
  elementText: '',
  alternatives: JSON.stringify(alternatives),
  lastSeenAt: new Date(at),
});

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'other' },
  ]);
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/checkout.spec.ts', title: 'pays' },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'adds' },
    { id: 3, projectId: 2, filePath: 'tests/checkout.spec.ts', title: 'elsewhere' },
  ]);
  const alt = (locator: string, score: number) => ({ locator, method: 'getByRole', args: {}, score });
  await db
    .insert(schema.locatorSnapshots)
    .values([
      snapshot(1, 1, 'tests/pages/checkout.page.ts:5:21', [alt("getByRole('row', { name: /Mug/ })", 85)], 2000),
      snapshot(2, 2, 'tests/pages/checkout.page.ts:9:3', [alt("getByRole('button', { name: 'Remove' })", 90)], 1000),
      snapshot(3, 2, 'tests/pages/cart.page.ts:5:21', [alt("getByRole('row')", 60)], 3000),
      snapshot(4, 3, 'tests/pages/checkout.page.ts:5:21', [alt('x', 1)], 4000),
    ]);
});

describe('getLocatorAlternatives', () => {
  test("lists a file's call sites in this project, newest capture first", async () => {
    const items = await getLocatorAlternatives(db as never, 1, 'tests/pages/checkout.page.ts');
    expect(items.map((i) => [i.location, i.alternatives[0]!.locator])).toEqual([
      ['tests/pages/checkout.page.ts:5:21', "getByRole('row', { name: /Mug/ })"],
      ['tests/pages/checkout.page.ts:9:3', "getByRole('button', { name: 'Remove' })"],
    ]);
  });

  test('matches a path suffix, not another file with the same name elsewhere', async () => {
    expect((await getLocatorAlternatives(db as never, 1, 'pages/checkout.page.ts')).length).toBe(2);
    expect(await getLocatorAlternatives(db as never, 1, 'other/checkout.page.ts')).toEqual([]);
  });
});

describe('the test catalog', () => {
  test('filters on an exact spec file', async () => {
    const result = await getProjectTestCases(db as never, 1, parseTestCasesQuery({ file: 'tests/checkout.spec.ts' }));
    expect(result.items.map((i: { title: string }) => i.title)).toEqual(['pays']);
  });
});
