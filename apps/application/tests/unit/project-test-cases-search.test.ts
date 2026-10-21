import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { getProjectTestCases, getProjectTestCaseFacets } = await import('../../shared/handlers/projects');

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

let db: ReturnType<typeof drizzle<typeof schema>>;

interface CaseSeed {
  filePath: string;
  suitePath?: string[];
  title: string;
  tags?: string[];
  locks?: string[];
  owner?: string;
  priority?: string;
  feature?: string;
  externalId?: string;
  /** Where the latest execution reported the test; null = no execution. */
  at?: { line: number; column: number; daysAgo?: number } | null;
}

async function seedCase(seed: CaseSeed): Promise<void> {
  const inserted = await db
    .insert(schema.testCases)
    .values({
      projectId: 1,
      filePath: seed.filePath,
      suitePath: (seed.suitePath ?? []).join('\x1f'),
      title: seed.title,
      tags: seed.tags ?? null,
      locks: seed.locks ?? null,
      owner: seed.owner ?? null,
      priority: seed.priority ?? null,
      feature: seed.feature ?? null,
      externalId: seed.externalId ?? null,
    })
    .returning({ id: schema.testCases.id });
  if (seed.at === null) return;
  const at = seed.at ?? { line: 1, column: 1 };
  // An older execution at another line: the latest one decides the position.
  await db.insert(schema.testRunsCases).values({
    testRunId: 1,
    testCaseId: inserted[0]!.id,
    status: 'passed',
    duration: 100,
    line: at.line + 500,
    column: 1,
    createdAt: new Date(now - ((at.daysAgo ?? 0) + 3) * DAY_MS),
  });
  await db.insert(schema.testRunsCases).values({
    testRunId: 1,
    testCaseId: inserted[0]!.id,
    status: 'passed',
    duration: 100,
    line: at.line,
    column: at.column,
    createdAt: new Date(now - (at.daysAgo ?? 0) * DAY_MS),
  });
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await db.insert(schema.projects).values({ id: 1, name: 'search-project' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(now) });

  await seedCase({
    filePath: 'tests/auth/login.spec.ts',
    suitePath: ['Authentication', 'With password'],
    title: 'signs in',
    tags: ['smoke', 'Auth'],
    locks: ['db'],
    owner: '@team/identity',
    priority: 'high',
    feature: 'sign-in',
    externalId: 'TC-12',
    at: { line: 12, column: 5 },
  });
  await seedCase({
    filePath: 'tests/auth/login.spec.ts',
    suitePath: ['Authentication'],
    title: 'shows the form',
    tags: ['smoke'],
    at: { line: 4, column: 3 },
  });
  await seedCase({
    filePath: 'tests/auth/login.spec.ts',
    suitePath: ['Authentication', 'With password'],
    title: 'rejects a wrong password',
    at: { line: 12, column: 40 },
  });
  await seedCase({
    filePath: 'tests/shop/cart.spec.ts',
    suitePath: ['Cart'],
    title: 'adds 100% of items',
    tags: ['api'],
    owner: '@team/shop',
    feature: 'checkout',
    at: { line: 8, column: 3, daysAgo: 40 },
  });
  await seedCase({ filePath: 'tests/shop/cart_old.spec.ts', title: 'legacy cart', at: null });
});

async function titles(q: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const page = await getProjectTestCases(db, 1, { q, sort: 'title', dir: 'asc', ...extra });
  return page.items.map((item: any) => item.title);
}

describe('catalog search', () => {
  test('a free word looks in the title, the describe blocks and the file path', async () => {
    expect(await titles('password')).toEqual(['rejects a wrong password', 'signs in']);
    expect(await titles('AUTHENTICATION')).toEqual(['rejects a wrong password', 'shows the form', 'signs in']);
    expect(await titles('shop/')).toEqual(['adds 100% of items', 'legacy cart']);
  });

  test('every word must match', async () => {
    expect(await titles('password signs')).toEqual(['signs in']);
    expect(await titles('"wrong password"')).toEqual(['rejects a wrong password']);
    expect(await titles('password cart')).toEqual([]);
  });

  test('a qualifier matches its own field only', async () => {
    expect(await titles('title:password')).toEqual(['rejects a wrong password']);
    expect(await titles('describe:password')).toEqual(['rejects a wrong password', 'signs in']);
    expect(await titles('file:cart')).toEqual(['adds 100% of items', 'legacy cart']);
  });

  test('a star is a wildcard, and LIKE metacharacters are literal', async () => {
    expect(await titles('file:tests/*/cart')).toEqual(['adds 100% of items', 'legacy cart']);
    expect(await titles('100%')).toEqual(['adds 100% of items']);
    // An underscore is not LIKE's any-character wildcard: `cart_spec` does not match `cart.spec`.
    expect(await titles('file:cart_spec')).toEqual([]);
    expect(await titles('file:cart_old')).toEqual(['legacy cart']);
  });

  test('repeating a single-value qualifier widens', async () => {
    expect(await titles('file:login file:cart_old')).toEqual([
      'legacy cart',
      'rejects a wrong password',
      'shows the form',
      'signs in',
    ]);
    expect(await titles('owner:@team/identity owner:@TEAM/SHOP')).toEqual(['adds 100% of items', 'signs in']);
  });

  test('id matches a whole external ID', async () => {
    expect(await titles('id:tc-12')).toEqual(['signs in']);
    expect(await titles('id:TC-1')).toEqual([]);
  });

  test('tags and locks match a whole value in any case, every one required', async () => {
    expect(await titles('tag:smoke')).toEqual(['shows the form', 'signs in']);
    expect(await titles('tag:auth tag:@SMOKE')).toEqual(['signs in']);
    expect(await titles('tag:smo')).toEqual([]);
    expect(await titles('lock:db')).toEqual(['signs in']);
  });

  test('a minus excludes, keeping the tests with no value', async () => {
    expect(await titles('-tag:smoke')).toEqual(['adds 100% of items', 'legacy cart', 'rejects a wrong password']);
    expect(await titles('-owner:@team/shop')).toEqual([
      'legacy cart',
      'rejects a wrong password',
      'shows the form',
      'signs in',
    ]);
    expect(await titles('-describe:authentication -file:cart_old')).toEqual(['adds 100% of items']);
  });

  test('priority and feature match a whole value', async () => {
    expect(await titles('priority:HIGH')).toEqual(['signs in']);
    expect(await titles('feature:checkout')).toEqual(['adds 100% of items']);
  });

  test('a qualifier the catalog does not have is a free word', async () => {
    expect(await titles('error:timeout')).toEqual([]);
  });

  test('combines with the age window and the other filters', async () => {
    expect(await titles('file:cart', { maxAgeDays: 30 })).toEqual([]);
    expect(await titles('tag:smoke', { tags: ['auth'] })).toEqual(['signs in']);
  });
});

describe('catalog search across accents', () => {
  beforeAll(async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'accents-project' });
    await db.insert(schema.testCases).values([
      {
        projectId: 2,
        filePath: 'tests/préférences.spec.ts',
        suitePath: 'Paramètres',
        title: 'Enregistre les PRÉFÉRENCES',
        tags: ['Été'],
        owner: 'José',
      },
      { projectId: 2, filePath: 'tests/compte.spec.ts', title: 'Supprime le compte' },
    ]);
  });

  async function accentTitles(q: string): Promise<string[]> {
    const page = await getProjectTestCases(db, 2, { q, sort: 'title', dir: 'asc' });
    return page.items.map((item: any) => item.title);
  }

  test('accents and case never matter, in the query or in the test', async () => {
    expect(await accentTitles('preferences')).toEqual(['Enregistre les PRÉFÉRENCES']);
    expect(await accentTitles('describe:PARAMETRES')).toEqual(['Enregistre les PRÉFÉRENCES']);
    expect(await accentTitles('file:prefer*spec')).toEqual(['Enregistre les PRÉFÉRENCES']);
    expect(await accentTitles('tag:ete owner:jose')).toEqual(['Enregistre les PRÉFÉRENCES']);
    expect(await accentTitles('cómpte')).toEqual(['Supprime le compte']);
    expect(await accentTitles('-tag:ÉTÉ')).toEqual(['Supprime le compte']);
  });
});

describe('file order', () => {
  test('sorts by file, then the line and column of the latest execution', async () => {
    const page = await getProjectTestCases(db, 1, { sort: 'file', dir: 'asc' });
    expect(page.items.map((item: any) => [item.title, item.line, item.column])).toEqual([
      ['shows the form', 4, 3],
      ['signs in', 12, 5],
      ['rejects a wrong password', 12, 40],
      ['adds 100% of items', 8, 3],
      ['legacy cart', null, null],
    ]);
  });

  test('descending reverses it and keeps a case with no position last', async () => {
    const page = await getProjectTestCases(db, 1, { sort: 'file', dir: 'desc' });
    expect(page.items.map((item: any) => item.title)).toEqual([
      'legacy cart',
      'adds 100% of items',
      'rejects a wrong password',
      'signs in',
      'shows the form',
    ]);
  });
});

describe('getProjectTestCaseFacets', () => {
  test('lists each value with how many test cases carry it', async () => {
    const { values } = await getProjectTestCaseFacets(db, 1);
    expect(values.file).toEqual([
      { value: 'tests/auth/login.spec.ts', count: 3 },
      { value: 'tests/shop/cart_old.spec.ts', count: 1 },
      { value: 'tests/shop/cart.spec.ts', count: 1 },
    ]);
    expect(values.describe).toEqual([
      { value: 'Authentication', count: 3 },
      { value: 'With password', count: 2 },
      { value: 'Cart', count: 1 },
    ]);
    expect(values.tag).toEqual([
      { value: 'smoke', count: 2 },
      { value: 'api', count: 1 },
      { value: 'Auth', count: 1 },
    ]);
    expect(values.owner).toEqual([
      { value: '@team/identity', count: 1 },
      { value: '@team/shop', count: 1 },
    ]);
    expect(values.lock).toEqual([{ value: 'db', count: 1 }]);
    expect(values).not.toHaveProperty('browser');
  });

  test('covers only the cases executed within the age window', async () => {
    const { values } = await getProjectTestCaseFacets(db, 1, { maxAgeDays: 30 });
    expect(values.file).toEqual([{ value: 'tests/auth/login.spec.ts', count: 3 }]);
    expect(values.feature).toEqual([{ value: 'sign-in', count: 1 }]);
  });
});
