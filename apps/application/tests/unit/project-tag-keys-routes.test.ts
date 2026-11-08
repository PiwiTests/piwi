import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';

/**
 * Saving the tag key patterns through the server's project route and through the demo router: both answer HTTP 400 for
 * a pattern that is not valid, and both store a valid one trimmed.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));
vi.mock('../../server/utils/project-access', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireProjectAccess: async () => undefined,
}));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<{ project: { tagKeys: unknown } }>;
const patchProject = (await import('../../server/api/projects/[id].patch')).default as unknown as Handler;
const { handleDemoRequest } = await import('~~/app/demo/api/router');

const TEST_CASE = '^SHOP-T[0-9]+$';
const serverPatch = (tagKeys: unknown) => patchProject({ params: { id: '1' }, body: { tagKeys } });
const demoPatch = (tagKeys: unknown) =>
  handleDemoRequest('/api/projects/1', 'PATCH', { tagKeys }) as Promise<{ project: { tagKeys: unknown } }>;

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
});

afterAll(() => close());

const routes = [
  ['the server route', serverPatch],
  ['the demo router', demoPatch],
] as const;

describe.each(routes)('PATCH of the tag key patterns through %s', (_name, patch) => {
  test.each([
    ['nested quantifiers', '^(a+)+$'],
    ['an alternation', '^(a|a)*$'],
    ['no anchors', 'SHOP-T[0-9]+'],
    ['the slash form', '/^SHOP-T[0-9]+$/i'],
    ['an expression that does not compile', '^[z-a]+$'],
  ])('answers 400 for %s', async (_label, pattern) => {
    await expect(patch({ issue: pattern, testCase: TEST_CASE })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('names the field that was refused', async () => {
    await expect(patch({ testCase: '^(a+)+$' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('tagKeys.testCase'),
    });
  });

  test('stores a valid pattern trimmed and clears it with null', async () => {
    const saved = await patch({ testCase: `  ${TEST_CASE}  ` });
    expect(saved.project.tagKeys).toEqual({ issue: null, testCase: TEST_CASE });
    expect((await patch(null)).project.tagKeys).toBeNull();
  });
});
