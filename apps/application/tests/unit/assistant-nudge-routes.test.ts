/**
 * The nudge dismissal routes (`/api/assistant/nudge-dismissals`): a dismissal
 * belongs to the user who made it, so no list reaches another user's,
 * administrators included; with authentication off every visitor is the same
 * virtual administrator and shares one list. Only the nudges the dashboard
 * offers can be dismissed, once per owner, also while the assistant is
 * declined, and a user's dismissals go with the user.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import { ASSISTANT_NUDGE_IDS, type AssistantNudgeDismissal } from '#shared/assistant-nudges';
import { buildAccessSummary, InstanceRole } from '#shared/permissions';
import { recordRouteMeta, underRoutePermission, type RouteAccessState } from './route-access';

delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(
  () =>
    ({ db: null, caller: null, routePermission: [], authEnabled: true }) as RouteAccessState & { authEnabled: boolean },
);
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => ({
  ...(await import('./route-access')).authMock(state),
  isAuthEnabled: () => state.authEnabled,
}));

interface FakeEvent {
  params?: Record<string, string>;
}

vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: true, public: { appVersion: '0.59.0' } }));
vi.stubGlobal('defineRouteMeta', (meta: { openAPI?: Record<string, unknown> }) => recordRouteMeta(state, meta));
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Route<T> = (event: FakeEvent) => Promise<T>;
const list = underRoutePermission(
  state,
  (await import('../../server/api/assistant/nudge-dismissals/index.get')).default as unknown as Route<{
    items: AssistantNudgeDismissal[];
  }>,
);
const put = underRoutePermission(
  state,
  (await import('../../server/api/assistant/nudge-dismissals/[nudgeId].put'))
    .default as unknown as Route<AssistantNudgeDismissal>,
);
const remove = underRoutePermission(
  state,
  (await import('../../server/api/assistant/nudge-dismissals/[nudgeId].delete')).default as unknown as Route<{
    success: boolean;
  }>,
);
const { deleteUserRecord } = await import('#shared/handlers/users');
const { setInstanceDecisions } = await import('#shared/handlers/capabilities');

const ALICE = { id: 1, username: 'alice', role: 'member' } as User;
const BOB = { id: 2, username: 'bob', role: 'administrator' } as User;
const as = (user: User) => {
  state.caller = { user, access: buildAccessSummary(user.role as InstanceRole, []) };
};
const dismiss = (nudgeId: string) => put({ params: { nudgeId } });
const undo = (nudgeId: string) => remove({ params: { nudgeId } });
const listed = async () => (await list({})).items.map((item) => item.nudgeId);

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.authEnabled = true;
  await db.insert(schema.users).values([
    { id: 1, username: 'alice', password: 'x', role: 'member' },
    { id: 2, username: 'bob', password: 'x', role: 'administrator' },
  ]);
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

describe('the nudge dismissal routes', () => {
  test('are for any signed-in user', async () => {
    for (const route of [list, put, remove]) {
      state.caller = null;
      await expect(route({ params: { nudgeId: 'undecided-capabilities' } })).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    as(ALICE);
    expect(await listed()).toEqual([]);
  });

  test("keep a dismissal for its owner only: another user's list never shows it, an administrator's included", async () => {
    as(ALICE);
    const dismissal = await dismiss('diagnosis-without-diff');
    expect(dismissal).toEqual({ nudgeId: 'diagnosis-without-diff', dismissedAt: expect.any(String) });
    expect(await listed()).toEqual(['diagnosis-without-diff']);

    as(BOB);
    expect(await listed()).toEqual([]);
    await expect(undo('diagnosis-without-diff')).rejects.toMatchObject({ statusCode: 404 });

    as(ALICE);
    expect(await listed()).toEqual(['diagnosis-without-diff']);
  });

  test('keep one dismissal per owner and nudge, with its first date', async () => {
    as(ALICE);
    const first = await dismiss('failure-without-fixtures');
    const again = await dismiss('failure-without-fixtures');
    expect(again).toEqual(first);
    expect(await listed()).toEqual(['failure-without-fixtures']);
    const rows = await db.select().from(schema.assistantNudgeDismissals);
    expect(rows).toHaveLength(1);
  });

  test('with authentication off, keep one list every visitor shares', async () => {
    state.authEnabled = false;
    as(ALICE);
    await dismiss('undecided-capabilities');
    await dismiss('undecided-capabilities');
    as(BOB);
    expect(await listed()).toEqual(['undecided-capabilities']);
    const rows = await db.select().from(schema.assistantNudgeDismissals);
    expect(rows).toEqual([expect.objectContaining({ ownerId: null, nudgeId: 'undecided-capabilities' })]);

    // A signed-in user's list is their own, apart from the shared one.
    state.authEnabled = true;
    expect(await listed()).toEqual([]);
  });

  test('show a nudge again once its dismissal is removed', async () => {
    as(ALICE);
    await dismiss('undecided-capabilities');
    expect(await undo('undecided-capabilities')).toEqual({ success: true });
    expect(await listed()).toEqual([]);
    await expect(undo('undecided-capabilities')).rejects.toMatchObject({ statusCode: 404 });
  });

  test('answer 400 for a nudge the dashboard does not offer', async () => {
    as(ALICE);
    await expect(dismiss('made-up')).rejects.toMatchObject({ statusCode: 400 });
    await expect(undo('made-up')).rejects.toMatchObject({ statusCode: 400 });
    expect(await listed()).toEqual([]);
  });

  test('keep working while the assistant or AI is declined, when the nudges offering a guide still show', async () => {
    as(ALICE);
    for (const decisions of [{ assistant: 'declined' as const }, { assistant: null, ai: 'declined' as const }]) {
      await setInstanceDecisions(db as never, decisions);
      expect(await dismiss('failure-without-fixtures')).toMatchObject({ nudgeId: 'failure-without-fixtures' });
      expect(await listed()).toEqual(['failure-without-fixtures']);
      expect(await undo('failure-without-fixtures')).toEqual({ success: true });
      expect(await listed()).toEqual([]);
    }
  });

  test("delete a user's dismissals with the user", async () => {
    as(ALICE);
    await dismiss('undecided-capabilities');
    as(BOB);
    await dismiss('undecided-capabilities');
    await deleteUserRecord(db as never, ALICE.id);
    const rows = await db.select().from(schema.assistantNudgeDismissals);
    expect(rows.map((row) => row.ownerId)).toEqual([BOB.id]);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, ALICE.id))).toEqual([]);
  });

  test('document every nudge id in the routes taking one', () => {
    for (const file of ['[nudgeId].put.ts', '[nudgeId].delete.ts']) {
      const src = readFileSync(new URL(`../../server/api/assistant/nudge-dismissals/${file}`, import.meta.url), 'utf8');
      const literal = /enum: \[([^\]]*)\]/.exec(src)?.[1] ?? '';
      expect(
        [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1]),
        file,
      ).toEqual([...ASSISTANT_NUDGE_IDS]);
    }
  });
});
