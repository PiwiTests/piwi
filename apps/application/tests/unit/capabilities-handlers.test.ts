import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;
const { getCapabilityEvidence } = await import('../../shared/handlers/setup-status');
const {
  getInstanceCapabilities,
  getProjectCapabilities,
  setInstanceDecisions,
  setProjectDecisions,
  resolveProjectStates,
} = await import('../../shared/handlers/capabilities');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;

async function freshDb(): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(next);
  return next;
}

/** Insert a project with a passing run and one network request (fixture evidence). */
async function seedWithFixtures(projectId: number, name: string): Promise<void> {
  await db.insert(schema.projects).values({ id: projectId, name });
  const [run] = await db
    .insert(schema.testRuns)
    .values({ projectId, status: 'passed', startTime: new Date(), duration: 1, totalTests: 1, passedTests: 1 })
    .returning({ id: schema.testRuns.id });
  await db.insert(schema.testCases).values({ id: projectId * 100, projectId, filePath: 'a.spec.ts', title: 'a' });
  const [runCase] = await db
    .insert(schema.testRunsCases)
    .values({ testRunId: run!.id, testCaseId: projectId * 100, status: 'passed', duration: 1 })
    .returning({ id: schema.testRunsCases.id });
  await db.insert(schema.networkRequests).values({
    testRunsCaseId: runCase!.id,
    testRunId: run!.id,
    url: 'https://example.test/api',
    method: 'GET',
    status: 200,
  });
}

function stateOf(items: { id: string; state: string }[], id: string): string {
  return items.find((i) => i.id === id)!.state;
}

beforeEach(async () => {
  db = await freshDb();
  delete process.env.PIWI_AI_API_KEY;
  delete process.env.PIWI_AI_MODEL;
});

describe('getCapabilityEvidence', () => {
  test('scopes fixture evidence to the project it belongs to', async () => {
    await seedWithFixtures(1, 'has-fixtures');
    await db.insert(schema.projects).values({ id: 2, name: 'no-fixtures' });

    const instance = await getCapabilityEvidence(db);
    expect(instance.fixtures).toBe(true);

    const withFixtures = await getCapabilityEvidence(db, 1);
    expect(withFixtures.fixtures).toBe(true);

    const withoutFixtures = await getCapabilityEvidence(db, 2);
    expect(withoutFixtures.fixtures).toBe(false);
  });
});

describe('instance decisions', () => {
  test('a declined capability resolves to declined; clearing it returns it to undecided', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'p' });

    let items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'notifications')).toBe('undecided');

    await setInstanceDecisions(db, { notifications: 'declined' });
    items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'notifications')).toBe('declined');

    await setInstanceDecisions(db, { notifications: null });
    items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'notifications')).toBe('undecided');
  });

  test('mcp reads available even with no evidence', async () => {
    const items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'mcp')).toBe('available');
  });

  test('a whole decisions map is applied in one write, and a later null clears one', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'p' });

    // The shape the composables' decideMany sends: several ids at once.
    await setInstanceDecisions(db, { notifications: 'declined', tags: 'declined' });
    let items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'notifications')).toBe('declined');
    expect(stateOf(items, 'tags')).toBe('declined');

    // Clearing one leaves the other in place.
    await setInstanceDecisions(db, { notifications: null });
    items = (await getInstanceCapabilities(db)).items;
    expect(stateOf(items, 'notifications')).toBe('undecided');
    expect(stateOf(items, 'tags')).toBe('declined');
  });
});

describe('project decisions', () => {
  test('a project enable overrides an instance decline', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'p' });
    await setInstanceDecisions(db, { quarantine: 'declined' });

    // The instance decline reaches the project by default.
    let states = await resolveProjectStates(db, 1);
    expect(states.quarantine).toBe('declined');

    // Enabling it for this project lifts the decline.
    await setProjectDecisions(db, 1, { quarantine: 'enabled' });
    states = await resolveProjectStates(db, 1);
    expect(states.quarantine).not.toBe('declined');
  });

  test('a project decline hides a capability the instance left undecided', async () => {
    await db.insert(schema.projects).values({ id: 1, name: 'p' });

    await setProjectDecisions(db, 1, { markers: 'declined' });
    const items = (await getProjectCapabilities(db, 1)).items;
    expect(stateOf(items, 'markers')).toBe('declined');
  });

  test('setProjectDecisions rejects a missing project', async () => {
    await expect(setProjectDecisions(db, 999, { markers: 'declined' })).rejects.toThrow('Project not found');
  });
});

describe('the Test Map decline holds over passive ingest data', () => {
  // Ingest writes graph nodes on every run, so the Test Map's evidence arrives
  // passively. A decline must still turn it off — otherwise declining it on any
  // project with history does nothing.
  async function seedGraphNode(projectId: number, name: string): Promise<void> {
    await db.insert(schema.projects).values({ id: projectId, name });
    await db.insert(schema.graphNodes).values({ projectId, kind: 'route', key: 'GET /api/x' });
  }

  test('a project decline hides the Test Map even with graph nodes present', async () => {
    await seedGraphNode(1, 'has-graph');

    // Passive data alone reads active.
    let states = await resolveProjectStates(db, 1);
    expect(states['test-map']).toBe('active');

    await setProjectDecisions(db, 1, { 'test-map': 'declined' });
    states = await resolveProjectStates(db, 1);
    expect(states['test-map']).toBe('declined');
  });

  test('an instance decline hides the Test Map even with graph nodes present', async () => {
    await seedGraphNode(2, 'has-graph-2');

    await setInstanceDecisions(db, { 'test-map': 'declined' });
    const states = await resolveProjectStates(db, 2);
    expect(states['test-map']).toBe('declined');

    // The instance-wide state drives the Home inbox card and the MCP tool filter,
    // so it must read declined too — not active off the instance-wide graph node.
    const instance = (await getInstanceCapabilities(db)).items;
    expect(stateOf(instance, 'test-map')).toBe('declined');
  });

  test('a project enable over an instance decline lets the graph data read active', async () => {
    await seedGraphNode(3, 'has-graph-3');
    await setInstanceDecisions(db, { 'test-map': 'declined' });

    await setProjectDecisions(db, 3, { 'test-map': 'enabled' });
    const states = await resolveProjectStates(db, 3);
    expect(states['test-map']).toBe('active');
  });
});
