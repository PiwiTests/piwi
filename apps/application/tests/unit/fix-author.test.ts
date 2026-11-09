import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set;
// the module under test imports it, so clear it before importing.
delete process.env.PIWI_DATABASE_URL;

// SMTP is up, and the outbox is swept by nobody: the queued rows stay as written.
vi.mock('../../server/utils/email', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isEmailConfigured: () => true,
}));
vi.mock('../../server/utils/notifications/dispatch', () => ({ sweepOutbox: async () => {} }));
// Authentication is on through PIWI_AUTH_ENABLED, which wins over the runtime config.
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));

const { notifyFixAuthor, selectFixAuthorRecipient } = await import('../../server/utils/notifications/fix-author');

const USERS = [
  { id: 1, email: 'ada@example.com' },
  { id: 2, email: 'Grace@Example.com' },
  { id: 3, email: null },
];

describe('selectFixAuthorRecipient — registered users only', () => {
  test('matches a registered user by email, case-insensitively', () => {
    expect(selectFixAuthorRecipient({ name: 'Ada', email: 'ada@example.com' }, USERS)).toEqual({
      userId: 1,
      email: 'ada@example.com',
    });
    // The commit email casing differs from the account email — still the same person.
    expect(selectFixAuthorRecipient({ name: 'Grace', email: 'grace@example.com' }, USERS)).toEqual({
      userId: 2,
      email: 'Grace@Example.com',
    });
  });

  test('never targets an author who is not a registered user', () => {
    expect(selectFixAuthorRecipient({ name: 'Outside', email: 'contributor@other.org' }, USERS)).toBeNull();
  });

  test('returns null when the author or its email is missing', () => {
    expect(selectFixAuthorRecipient(undefined, USERS)).toBeNull();
    expect(selectFixAuthorRecipient(null, USERS)).toBeNull();
    expect(selectFixAuthorRecipient({ name: 'No email', email: '' }, USERS)).toBeNull();
    expect(selectFixAuthorRecipient({ name: 'Spaces', email: '   ' }, USERS)).toBeNull();
  });

  test('a user row without an email is never a match', () => {
    expect(selectFixAuthorRecipient({ name: 'Ghost', email: '' }, [{ id: 3, email: null }])).toBeNull();
  });
});

describe('notifyFixAuthor — only an author who can open the project', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    process.env.PIWI_AUTH_ENABLED = 'true';
    await db.insert(schema.users).values([
      { id: 1, username: 'ada', password: '', role: 'member', email: 'ada@example.com', emailVerified: true },
      { id: 2, username: 'grace', password: '', role: 'member', email: 'grace@example.com', emailVerified: true },
      { id: 3, username: 'lin', password: '', role: 'member', email: 'lin@example.com', emailVerified: true },
    ]);
    await db.insert(schema.projects).values([
      { id: 10, name: 'web' },
      { id: 11, name: 'billing' },
    ]);
    await db.insert(schema.groups).values({ id: 100, name: 'QA' });
    await db.insert(schema.groupMembers).values({ groupId: 100, userId: 3 });
    await db.insert(schema.roleBindings).values([
      // ada reads web; grace reads billing only; lin reads every project through QA.
      { userId: 1, projectId: 10, role: 'viewer' },
      { userId: 2, projectId: 11, role: 'maintainer' },
      { groupId: 100, projectId: null, role: 'viewer' },
    ]);
  });

  afterEach(async () => {
    delete process.env.PIWI_AUTH_ENABLED;
    await close();
  });

  /** A fix landed on web (project 10), committed by `email`. */
  const fixedOnWeb = (email: string) =>
    ({
      clusterId: 5,
      projectId: 10,
      projectName: 'web',
      signature: 'TimeoutError',
      runId: 42,
      verification: 'stopped-failing',
      fixAuthor: { name: 'Author', email },
    }) as const;

  async function queued() {
    return db
      .select({ channelId: schema.notificationDeliveries.channelId, event: schema.notificationDeliveries.event })
      .from(schema.notificationDeliveries);
  }

  test('a registered author who cannot open the project gets no email and no browser notification', async () => {
    expect(await notifyFixAuthor(db as never, 'cluster.fixed', fixedOnWeb('Grace@example.com'))).toEqual({
      targetUserId: null,
    });
    expect(await notifyFixAuthor(db as never, 'cluster.regressed', fixedOnWeb('grace@example.com') as never)).toEqual({
      targetUserId: null,
    });
    expect(await queued()).toEqual([]);
    // Not even the account-email channel is created for them.
    expect(await db.select().from(schema.notificationChannels)).toEqual([]);
  });

  test('an author who can open the project, directly or through a group, is emailed and targeted', async () => {
    expect(await notifyFixAuthor(db as never, 'cluster.fixed', fixedOnWeb('ada@example.com'))).toEqual({
      targetUserId: 1,
    });
    expect(await notifyFixAuthor(db as never, 'cluster.fixed', fixedOnWeb('lin@example.com'))).toEqual({
      targetUserId: 3,
    });
    const channels = await db.select().from(schema.notificationChannels);
    expect(channels.map((c) => [c.type, c.userId])).toEqual([
      ['personal_email', 1],
      ['personal_email', 3],
    ]);
    expect((await queued()).map((d) => d.event)).toEqual(['cluster.fixed', 'cluster.fixed']);
  });

  test('a payload naming no project reaches nobody', async () => {
    const { projectId: _projectId, ...noProject } = fixedOnWeb('ada@example.com');
    expect(await notifyFixAuthor(db as never, 'cluster.fixed', noProject as never)).toEqual({ targetUserId: null });
    expect(await queued()).toEqual([]);
  });

  test('with authentication off, the registered author is reached whatever their roles', async () => {
    delete process.env.PIWI_AUTH_ENABLED;
    expect(await notifyFixAuthor(db as never, 'cluster.fixed', fixedOnWeb('grace@example.com'))).toEqual({
      targetUserId: 2,
    });
  });
});
