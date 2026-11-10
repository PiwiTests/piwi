import { beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DrizzleDB } from '../../shared/handlers/db';
import {
  DEMO_TEST_MANAGEMENT_CASES,
  DEMO_TEST_MANAGEMENT_CONNECTION,
  DEMO_TEST_MANAGEMENT_CONNECTION_ID,
  DEMO_TEST_MANAGEMENT_PROJECT_KEY,
} from '../../shared/demo/demo-test-management.mjs';
import {
  demoTestManagementCases,
  demoTestManagementKeyConfig,
  demoTestManagementOptions,
  demoTestManagementSettings,
  demoTestManagementSummary,
  refreshDemoTestManagementCatalog,
  saveDemoTestManagement,
} from '../../app/demo/api/test-management';

/**
 * The demo's test management binding: the server's own reads and validation over the browser's database, with the
 * canned Zephyr Scale project standing in for the tool. Nothing here reaches a network.
 */

let db: DrizzleDB;
const ID = DEMO_TEST_MANAGEMENT_CONNECTION_ID;

async function status(promise: Promise<unknown> | (() => unknown)): Promise<number | null> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
    return null;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? -1;
  }
}

beforeEach(async () => {
  const client = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(client, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });
  await client.insert(schema.projects).values({ id: 1, name: 'e2e-checkout', label: 'E2E Checkout' });
  await client.insert(schema.integrationConnections).values({
    id: ID,
    provider: DEMO_TEST_MANAGEMENT_CONNECTION.provider,
    name: DEMO_TEST_MANAGEMENT_CONNECTION.name,
    baseUrl: DEMO_TEST_MANAGEMENT_CONNECTION.baseUrl,
    config: DEMO_TEST_MANAGEMENT_CONNECTION.config,
  });
  db = client as unknown as DrizzleDB;
});

describe('demo test management settings', () => {
  test('offer the canned Zephyr Scale connection, and the defaults before a binding is saved', async () => {
    const settings = await demoTestManagementSettings(db, 1);
    expect(settings.binding.connectionId).toBeNull();
    expect(settings.connections).toEqual([
      { id: ID, provider: 'zephyr-scale', name: DEMO_TEST_MANAGEMENT_CONNECTION.name, status: 'ok' },
    ]);
  });

  test('save a binding the way the server does, and clear it with a null connection', async () => {
    const saved = await saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: 'SHOP', dryRun: true });
    expect(saved.binding).toMatchObject({ connectionId: ID, providerProjectKey: 'SHOP', enabled: true, dryRun: true });
    expect((await demoTestManagementSettings(db, 1)).binding.providerProjectKey).toBe('SHOP');
    const cleared = await saveDemoTestManagement(db, 1, { connectionId: null });
    expect(cleared.binding.connectionId).toBeNull();
  });

  test('refuse what the server refuses', async () => {
    expect(await status(saveDemoTestManagement(db, 1, null))).toBe(400);
    expect(await status(saveDemoTestManagement(db, 1, { connectionId: 'x' }))).toBe(400);
    expect(await status(saveDemoTestManagement(db, 1, { connectionId: 99, providerProjectKey: 'SHOP' }))).toBe(400);
    expect(await status(saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: 'shop key' }))).toBe(400);
    expect(
      await status(
        saveDemoTestManagement(db, 1, {
          connectionId: ID,
          providerProjectKey: 'SHOP',
          runPolicy: { nameTemplate: 'no run id here' },
        }),
      ),
    ).toBe(400);
    expect((await demoTestManagementSettings(db, 1)).binding.connectionId).toBeNull();
  });
});

describe('demo test management pickers', () => {
  test('list the canned projects, and statuses and folders only for a project', () => {
    const projects = demoTestManagementOptions(ID, null);
    expect(projects.projects.map((p) => p.key)).toEqual(['SHOP', 'WEB_APP', 'LEGACY']);
    expect(projects.statuses).toEqual([]);
    expect(projects.folders).toEqual([]);
    const shop = demoTestManagementOptions(ID, 'SHOP');
    expect(shop.statuses.filter((s) => s.isDefault).map((s) => s.name)).toEqual(['Not Executed']);
    expect(shop.folders.map((f) => f.path)).toEqual(['Nightly', 'Nightly / Release 4.2']);
  });

  test('refuse a connection that is not the canned one and a project key that is not a key', () => {
    expect(() => demoTestManagementOptions(0, null)).toThrow('Invalid connection');
    expect(() => demoTestManagementOptions(ID, 'not a key')).toThrow('Invalid project key');
    expect(() => demoTestManagementOptions(ID + 1, null)).toThrow('Connection not found');
  });
});

describe('demo test management catalog', () => {
  test('Refresh answers 409 until the project is bound', async () => {
    expect(await status(refreshDemoTestManagementCatalog(db, 1))).toBe(409);
  });

  test('Refresh stores the canned cases of the bound project, and again without duplicating them', async () => {
    await saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: DEMO_TEST_MANAGEMENT_PROJECT_KEY });
    const first = await refreshDemoTestManagementCatalog(db, 1);
    expect(first.size).toBe(DEMO_TEST_MANAGEMENT_CASES.length);
    await refreshDemoTestManagementCatalog(db, 1);
    const stored = await db.select().from(schema.testManagementCases);
    expect(stored).toHaveLength(DEMO_TEST_MANAGEMENT_CASES.length);
  });

  test('Refresh of a project the canned tool has no cases for leaves an empty catalog', async () => {
    await saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: 'WEB_APP' });
    expect((await refreshDemoTestManagementCatalog(db, 1)).size).toBe(0);
  });

  test('a lookup finds a stored case, reports an absent key as null, and has no address for the case', async () => {
    await saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: 'SHOP' });
    await refreshDemoTestManagementCatalog(db, 1);
    const found = await demoTestManagementCases(db, 1, 'SHOP-T123,SHOP-T124');
    expect(found.bound).toBe(true);
    expect(found.cases['SHOP-T123']).toEqual({ name: 'Customer pays with Apple Pay', status: 'Approved', url: null });
    expect(found.cases['SHOP-T124']).toBeNull();
  });

  test('a lookup of keys that are not keys answers 400', async () => {
    expect(await status(demoTestManagementCases(db, 1, ''))).toBe(400);
    expect(await status(demoTestManagementCases(db, 1, 'not a key'))).toBe(400);
  });
});

describe('demo test management reads', () => {
  test('key-config and summary say the project is not bound before a binding is saved', async () => {
    expect(await demoTestManagementKeyConfig(db, 1)).toEqual({ bound: false });
    expect((await demoTestManagementSummary(db, 1)).bound).toBe(false);
  });

  test('key-config carries the key pattern once bound', async () => {
    await saveDemoTestManagement(db, 1, { connectionId: ID, providerProjectKey: 'SHOP' });
    const config = await demoTestManagementKeyConfig(db, 1);
    expect(config).toMatchObject({ bound: true, projectKey: 'SHOP' });
  });
});
