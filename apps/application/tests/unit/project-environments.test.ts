import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const {
  backfillRunEnvironments,
  copyEnvironments,
  createEnvironment,
  deleteEnvironment,
  environmentRunSettings,
  listProjectEnvironments,
  resolveRunEnvironment,
  runEnvironmentFacts,
  updateEnvironment,
} = await import('../../shared/handlers/environments');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
const SHOP = 1;
const OTHER = 2;

async function run(label: string | null, values: Partial<typeof schema.testRuns.$inferInsert> = {}) {
  const [row] = await db
    .insert(schema.testRuns)
    .values({ projectId: SHOP, status: 'passed', startTime: new Date(), environment: label, ...values })
    .returning();
  return row!;
}

async function environmentOf(runId: number) {
  const [row] = await db
    .select({ environmentId: schema.testRuns.environmentId })
    .from(schema.testRuns)
    .where(eq(schema.testRuns.id, runId));
  return row!.environmentId;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: SHOP, name: 'shop', runVariables: [{ name: 'TENANT', value: 'acme' }] },
    { id: OTHER, name: 'shop-globex' },
  ]);
});

describe('a run label resolves to an environment', () => {
  test('a new label creates a discovered environment, and its variants resolve to it', async () => {
    const first = await resolveRunEnvironment(db as never, SHOP, ' staging ');
    expect(first.environment).toBe('staging');
    expect(first.environmentId).not.toBeNull();
    expect((await resolveRunEnvironment(db as never, SHOP, 'Staging')).environmentId).toBe(first.environmentId);
    const [listed] = await listProjectEnvironments(db as never, SHOP);
    expect(listed).toMatchObject({ key: 'staging', name: 'staging', discovered: true });
  });

  test('no label, and a label a key cannot hold, resolve to none', async () => {
    expect(await resolveRunEnvironment(db as never, SHOP, '   ')).toEqual({ environment: null, environmentId: null });
    expect(await resolveRunEnvironment(db as never, SHOP, 'it$s')).toEqual({
      environment: 'it$s',
      environmentId: null,
    });
  });

  test('the backfill gives the stored runs their environment, discovering what nothing takes', async () => {
    const a = await run('staging');
    const b = await run('production');
    const none = await run(null);
    expect(await backfillRunEnvironments(db as never)).toBe(2);
    expect(await environmentOf(a.id)).not.toBeNull();
    expect(await environmentOf(b.id)).not.toBe(await environmentOf(a.id));
    expect(await environmentOf(none.id)).toBeNull();
    expect(await backfillRunEnvironments(db as never)).toBe(0);
  });
});

describe('saving an environment', () => {
  test('takes over the discovered environments it names, with their runs', async () => {
    const stg = await run('stg');
    await backfillRunEnvironments(db as never);
    const saved = await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging', aliases: ['stg'] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(await environmentOf(stg.id)).toBe(saved.environment.id);
    expect((await listProjectEnvironments(db as never, SHOP)).map((e) => e.key)).toEqual(['staging']);
  });

  test('refuses a key or an alias that names another declared environment', async () => {
    await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging' });
    const clash = await createEnvironment(db as never, SHOP, { key: 'qa', name: 'QA', aliases: ['STAGING'] });
    expect(clash).toMatchObject({ ok: false, statusCode: 409 });
  });

  test('a renamed key stays an alias, so its runs stay', async () => {
    const created = await createEnvironment(db as never, SHOP, { key: 'stage', name: 'Staging' });
    if (!created.ok) throw new Error('not created');
    const old = await run('stage');
    await backfillRunEnvironments(db as never);
    const renamed = await updateEnvironment(db as never, SHOP, created.environment.id, { key: 'staging' });
    expect(renamed).toMatchObject({ ok: true, environment: { key: 'staging', aliases: ['stage'], discovered: false } });
    expect(await environmentOf(old.id)).toBe(created.environment.id);
  });

  test('a protected environment needs a required tag', async () => {
    const refused = await createEnvironment(db as never, SHOP, {
      key: 'production',
      name: 'Production',
      protected: true,
    });
    expect(refused).toMatchObject({ ok: false, statusCode: 400 });
  });

  test('a delete leaves the runs their label and no environment', async () => {
    const created = await createEnvironment(db as never, SHOP, { key: 'qa', name: 'QA' });
    if (!created.ok) throw new Error('not created');
    const qa = await run('qa', { environmentId: created.environment.id });
    expect(await deleteEnvironment(db as never, SHOP, created.environment.id)).toBe(true);
    expect(await environmentOf(qa.id)).toBeNull();
    expect(await deleteEnvironment(db as never, OTHER, created.environment.id)).toBe(false);
  });
});

describe('what a run Piwi starts gets', () => {
  test('the project variables alone, or merged with an environment, whose protection needs a manager', async () => {
    const created = await createEnvironment(db as never, SHOP, {
      key: 'production',
      name: 'Production',
      runVariables: [{ name: 'TEST_ENV', value: 'production' }],
      protected: true,
      requiredTags: ['@smoke'],
      envFile: '.env.production',
    });
    if (!created.ok) throw new Error('not created');
    expect(await environmentRunSettings(db as never, SHOP, null, { canManage: false })).toEqual({
      ok: true,
      runVariables: [{ name: 'TENANT', value: 'acme' }],
      environment: null,
    });
    expect(await environmentRunSettings(db as never, SHOP, created.environment.id, { canManage: false })).toMatchObject(
      { ok: false, statusCode: 403 },
    );
    expect(await environmentRunSettings(db as never, SHOP, created.environment.id, { canManage: true })).toEqual({
      ok: true,
      runVariables: [
        { name: 'TENANT', value: 'acme' },
        { name: 'TEST_ENV', value: 'production' },
      ],
      environment: {
        id: created.environment.id,
        key: 'production',
        name: 'Production',
        protected: true,
        requiredTags: ['@smoke'],
        envFile: '.env.production',
      },
    });
    expect(await environmentRunSettings(db as never, OTHER, created.environment.id, { canManage: true })).toMatchObject(
      { ok: false, statusCode: 404 },
    );
  });

  test('a protected environment lists its variables to managers only', async () => {
    await createEnvironment(db as never, SHOP, {
      key: 'production',
      name: 'Production',
      runVariables: [{ name: 'TEST_ENV', value: 'production' }],
      protected: true,
      requiredTags: ['@smoke'],
    });
    expect((await listProjectEnvironments(db as never, SHOP))[0]!.runVariables).toEqual([]);
    expect((await listProjectEnvironments(db as never, SHOP, { canManage: true }))[0]!.runVariables).toHaveLength(1);
  });
});

describe('copying environments', () => {
  test('copies the declared ones, and leaves a key the target names', async () => {
    await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging', aliases: ['stg'] });
    await createEnvironment(db as never, SHOP, { key: 'production', name: 'Production' });
    await resolveRunEnvironment(db as never, SHOP, 'preview');
    await createEnvironment(db as never, OTHER, { key: 'production', name: 'Prod' });
    const result = await copyEnvironments(db as never, SHOP, OTHER);
    expect(result.copied.map((e) => e.key)).toEqual(['staging']);
    expect(result.skipped).toEqual(['production']);
    expect((await listProjectEnvironments(db as never, OTHER)).map((e) => e.name)).toEqual(['Prod', 'Staging']);
  });
});

describe('the run page facts', () => {
  test('names the environment and warns of a baseURL outside its URL patterns', async () => {
    const created = await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging' });
    if (!created.ok) throw new Error('not created');
    await db.insert(schema.projectUrlPatterns).values({
      projectId: SHOP,
      pattern: 'https://staging.example.com/**',
      environment: 'staging',
    });
    const metadata = { htmlReport: { projects: [{ use: { baseURL: 'http://localhost:3000' } }] } };
    const outside = await run('staging', { environmentId: created.environment.id, metadata });
    expect(await runEnvironmentFacts(db as never, outside as never)).toEqual({
      environmentName: 'Staging',
      environmentWarnings: ['The tests opened http://localhost:3000, which no URL pattern of Staging matches.'],
    });
    const inside = await run('staging', {
      environmentId: created.environment.id,
      metadata: { htmlReport: { projects: [{ use: { baseURL: 'https://staging.example.com' } }] } },
    });
    expect((await runEnvironmentFacts(db as never, inside as never)).environmentWarnings).toEqual([]);
  });

  test('warns when a requested run reported another environment than the one it was started for', async () => {
    const staging = await createEnvironment(db as never, SHOP, { key: 'staging', name: 'Staging' });
    if (!staging.ok) throw new Error('not created');
    await db.insert(schema.users).values({ id: 7, username: 'robin', password: 'x', role: 'member', name: 'Robin' });
    const requested = await run('production', { origin: 'request' });
    await db.insert(schema.runRequests).values({
      id: 'a'.repeat(32),
      projectId: SHOP,
      requesterId: 7,
      kind: 'run',
      tests: [],
      options: {},
      source: { runId: requested.id },
      environmentId: staging.environment.id,
      runId: requested.id,
      state: 'ended',
      expiresAt: new Date(),
    });
    expect(
      (await runEnvironmentFacts(db as never, { ...requested, environmentId: null } as never)).environmentWarnings,
    ).toEqual(['Started for Staging; the config reported production.']);
  });
});
