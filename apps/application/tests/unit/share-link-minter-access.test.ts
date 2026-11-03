import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import { InstanceRole } from '#shared/permissions';

/**
 * A share link opens only while the person who minted it can read what it
 * opens: deleting them revokes it, and losing read access to its project makes
 * it answer like an unknown token until the access comes back.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/rate-limit', () => ({
  checkRateLimit: () => true,
  rateLimitClientIp: () => 'test',
  rateLimitedError: () => new Error('rate limited'),
}));

interface FakeEvent {
  params: Record<string, string>;
  status?: number;
}
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params[name]);
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('setResponseStatus', (event: FakeEvent, status: number) => {
  event.status = status;
});
vi.stubGlobal('apiError', apiError);
// Authentication is on through PIWI_AUTH_ENABLED, which wins over the runtime config.
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));

const { mintShareLink } = await import('../../server/utils/share-links');
const { openShareLink } = await import('../../server/utils/share-view');
const { deleteUserRecord } = await import('../../shared/handlers/users');

let db: TempDb;
let close: () => Promise<void>;

const WEB = 10;
const API = 11;
const ROBIN = 2;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
  vi.stubEnv('PIWI_SHARE_LINKS_ENABLED', 'true');
  await db.insert(schema.users).values([
    { id: 1, username: 'avery', password: '', role: InstanceRole.ADMINISTRATOR },
    { id: ROBIN, username: 'robin', password: '', role: InstanceRole.MEMBER },
  ]);
  await db.insert(schema.projects).values([
    { id: WEB, name: 'web' },
    { id: API, name: 'api' },
  ]);
  await db.insert(schema.roleBindings).values([
    { userId: ROBIN, projectId: WEB, role: 'maintainer' },
    { userId: ROBIN, projectId: API, role: 'maintainer' },
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

/** What a view of the link answers: the link it opens, the gone page, or the refusal's status. */
async function open(token: string, image = false): Promise<'opens' | 'gone' | number> {
  try {
    const opened = await openShareLink({ params: { token } } as never, { gonePage: !image, image });
    return 'gone' in opened ? 'gone' : 'opens';
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

async function mintExecution(createdBy: number | null, projectId = WEB) {
  return (await mintShareLink(db, { projectId, entityKind: 'execution', entityId: 42, createdBy })).token;
}

async function mintReport(projectIds: number[] | null) {
  const [snapshot] = await db
    .insert(schema.reportSnapshots)
    .values({
      dashboardRef: 'overview',
      dashboardName: 'Overview',
      projectIds,
      periodFrom: new Date(0),
      periodTo: new Date(1000),
      bundle: {},
    })
    .returning();
  return (await mintShareLink(db, { projectId: null, entityKind: 'report', entityId: snapshot!.id, createdBy: ROBIN }))
    .token;
}

async function unbind(projectId: number) {
  await db
    .delete(schema.roleBindings)
    .where(and(eq(schema.roleBindings.userId, ROBIN), eq(schema.roleBindings.projectId, projectId)));
}

describe('a share link and the access of its minter', () => {
  test('an execution link opens while its minter reads the project, and again once they read it again', async () => {
    const token = await mintExecution(ROBIN);
    expect(await open(token)).toBe('opens');

    await unbind(WEB);
    expect(await open(token)).toBe(404);

    await db.insert(schema.roleBindings).values({ userId: ROBIN, projectId: WEB, role: 'viewer' });
    expect(await open(token)).toBe('opens');
  });

  test('losing another project leaves an execution link open', async () => {
    const token = await mintExecution(ROBIN);
    await unbind(API);
    expect(await open(token)).toBe('opens');
  });

  test('a report link needs its minter to read every project of the snapshot', async () => {
    const token = await mintReport([WEB, API]);
    expect(await open(token)).toBe('opens');
    expect(await open(token, true)).toBe('opens');

    await unbind(API);
    expect(await open(token)).toBe(404);
    expect(await open(token, true)).toBe(404);
  });

  test('a report link over every project needs a minter who reads every project', async () => {
    const token = await mintReport(null);
    expect(await open(token)).toBe(404);

    await db.insert(schema.roleBindings).values({ userId: ROBIN, projectId: null, role: 'viewer' });
    expect(await open(token)).toBe('opens');
  });

  test('deleting the minter revokes their links', async () => {
    const token = await mintExecution(ROBIN);
    const kept = await mintExecution(1);

    await deleteUserRecord(db as never, ROBIN);

    expect(await open(token)).toBe('gone');
    expect(await open(token, true)).toBe(404);
    expect(await open(kept)).toBe('opens');
  });

  test('a link nobody minted opens, as one an issue filed by Piwi carries', async () => {
    expect(await open(await mintExecution(null))).toBe('opens');
  });

  test('with authentication off, a link opens whatever its minter reads', async () => {
    const token = await mintExecution(ROBIN);
    await unbind(WEB);
    vi.stubEnv('PIWI_AUTH_ENABLED', 'false');
    expect(await open(token)).toBe('opens');
  });
});
