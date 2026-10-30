import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// clear it before importing the handler (which imports the barrel).
delete process.env.PIWI_DATABASE_URL;
const {
  createTestFunction,
  updateTestFunction,
  deleteTestFunction,
  listProjectTestFunctions,
  getProjectFunctionCatalog,
} = await import('../../shared/handlers/test-functions');

let db: ReturnType<typeof drizzle<typeof schema>>;

const loginInput = {
  name: 'login',
  kind: 'page-object-method' as const,
  module: './pages/LoginPage',
  receiver: 'loginPage',
  importName: 'LoginPage',
  params: [
    { name: 'username', type: 'string' as const },
    { name: 'password', type: 'string' as const },
  ],
  urlPattern: '**/login',
  steps: [
    { action: 'fill' as const, target: { role: 'textbox', name: 'Username' } },
    { action: 'fill' as const, target: { role: 'textbox', name: 'Password' } },
    { action: 'click' as const, target: { role: 'button', name: 'Log in' } },
  ],
  paramSources: [
    { param: 'username', stepIndex: 0, from: 'value' as const },
    { param: 'password', stepIndex: 1, from: 'value' as const },
  ],
};

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'catalog-project' });
});

describe('test function catalog CRUD', () => {
  test('create defaults source to manual and confidence to 1, JSON round-trips through toTestFunctionEntry', async () => {
    const { testFunction } = await createTestFunction(db, 1, loginInput);
    expect(testFunction.source).toBe('manual');
    expect(testFunction.confidence).toBe(1);

    const { testFunctions } = await listProjectTestFunctions(db, 1);
    expect(testFunctions).toHaveLength(1);
    expect(testFunctions[0]!.entry).toEqual({
      id: testFunction.id,
      name: 'login',
      kind: 'page-object-method',
      module: './pages/LoginPage',
      receiver: 'loginPage',
      importName: 'LoginPage',
      params: loginInput.params,
      urlPattern: '**/login',
      steps: loginInput.steps,
      paramSources: loginInput.paramSources,
    });
  });

  test('a second project never sees another project’s catalog', async () => {
    await db.insert(schema.projects).values({ id: 2, name: 'other-project' });
    await createTestFunction(db, 1, loginInput);
    const { testFunctions } = await listProjectTestFunctions(db, 2);
    expect(testFunctions).toHaveLength(0);
  });

  test('update changes fields and re-serializes JSON columns', async () => {
    const { testFunction } = await createTestFunction(db, 1, loginInput);
    const { testFunction: updated } = await updateTestFunction(db, testFunction.id, {
      urlPattern: '**/signin',
      params: [{ name: 'username', type: 'string' }],
    });
    expect(updated.urlPattern).toBe('**/signin');
    expect(JSON.parse(updated.params)).toEqual([{ name: 'username', type: 'string' }]);
    // Untouched JSON columns are preserved as-is.
    expect(JSON.parse(updated.steps)).toEqual(loginInput.steps);
  });

  test('delete removes the row', async () => {
    const { testFunction } = await createTestFunction(db, 1, loginInput);
    await deleteTestFunction(db, testFunction.id);
    const { testFunctions } = await listProjectTestFunctions(db, 1);
    expect(testFunctions).toHaveLength(0);
  });

  test('update/delete on a missing row throws not-found', async () => {
    await expect(updateTestFunction(db, 999, { name: 'x' })).rejects.toThrow('Test function not found');
    await expect(deleteTestFunction(db, 999)).rejects.toThrow('Test function not found');
  });

  test('the project+module+name unique index rejects a duplicate', async () => {
    await createTestFunction(db, 1, loginInput);
    await expect(createTestFunction(db, 1, loginInput)).rejects.toThrow();
  });

  test('getProjectFunctionCatalog returns entries ready for @piwitests/core/function-match', async () => {
    await createTestFunction(db, 1, loginInput);
    const catalog = await getProjectFunctionCatalog(db, 1);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.name).toBe('login');
    expect(catalog[0]!.steps).toHaveLength(3);
  });
});
