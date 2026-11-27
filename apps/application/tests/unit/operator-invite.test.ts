/**
 * The administrator invitation whoever runs the instance asks for: an account without a password, a one-time link sent
 * to the invited address only, every other administrator who can sign in told, nothing kept when the link cannot be
 * sent, and an address another account holds refused. The invitation stays pending, on the Users page and to
 * administrators only on the banner, until it is taken; the same address invited again meanwhile gets a new link.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { AdminInviteRefused, adminInviteSchema, inviteAdministrator, usernameBase } =
  await import('../../server/utils/operator-invite');
const { invitationsShownTo, pendingOperatorInvitations } = await import('#shared/handlers/operator-invitations');
const { listUserItems } = await import('#shared/handlers/project-access');
const { mintAccountToken } = await import('../../server/utils/account-tokens');

describe('the username of an invited address', () => {
  test('is its part before the @, in letters, digits, dots, underscores and hyphens, three characters at least', () => {
    expect(usernameBase('Alice.Martin@example.com')).toBe('alice.martin');
    expect(usernameBase('a+b c@example.com')).toBe('a-b-c');
    expect(usernameBase('jo@example.com')).toBe('jo-admin');
    expect(usernameBase('+@example.com')).toBe('admin');
    expect(usernameBase(`${'x'.repeat(300)}@example.com`).length).toBeLessThanOrEqual(192);
    expect(usernameBase(`${'x'.repeat(191)}-y@example.com`)).toBe('x'.repeat(191));
  });
});

describe('what the operator sends', () => {
  test('is an address, and an optional name on one line', () => {
    expect(adminInviteSchema.safeParse({ email: 'new@example.com' }).success).toBe(true);
    expect(adminInviteSchema.safeParse({ email: 'new@example.com', name: 'New Admin' }).success).toBe(true);
    expect(adminInviteSchema.safeParse({ email: 'not an address' }).success).toBe(false);
    expect(adminInviteSchema.safeParse({ email: 'new@example.com', name: 'a\nb' }).success).toBe(false);
    expect(adminInviteSchema.safeParse({ email: 'new@example.com', role: 'member' }).success).toBe(false);
  });
});

describe('inviting an administrator', () => {
  let db: TempDb;
  let close: () => Promise<void>;
  const mail = () => ({ sendInvite: vi.fn(async () => {}), tellAdministrator: vi.fn(async () => {}) });

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
    await db.insert(schema.users).values([
      { username: 'owner', password: 'hash', role: 'administrator', email: 'owner@example.com' },
      { username: 'second', password: 'hash', role: 'administrator', email: null },
      { username: 'member', password: 'hash', role: 'member', email: 'member@example.com' },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
  });

  test('makes an administrator without a password, sends the link to the address only, and tells the others', async () => {
    const sent = mail();
    const { expiresAt } = await inviteAdministrator(db, { email: 'new@example.com', name: 'New Admin' }, sent);

    const [created] = await db.select().from(schema.users).where(eq(schema.users.email, 'new@example.com'));
    expect(created).toMatchObject({ username: 'new', role: 'administrator', password: '', name: 'New Admin' });
    expect(sent.sendInvite).toHaveBeenCalledOnce();
    expect(sent.sendInvite).toHaveBeenCalledWith('new@example.com', expect.stringMatching(/^[0-9a-f]{64}$/), 'new');
    expect(sent.tellAdministrator.mock.calls).toEqual([['owner@example.com', 'new@example.com']]);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);

    const pending = await pendingOperatorInvitations(db);
    expect(pending).toEqual([
      { userId: created!.id, email: 'new@example.com', invitedAt: expect.any(Date), expiresAt },
    ]);
    const items = await listUserItems(db);
    expect(items.find((item) => item.id === created!.id)?.operatorInvitation).toEqual({
      invitedAt: expect.any(Date),
      expiresAt,
    });
    expect(items.find((item) => item.username === 'owner')?.operatorInvitation).toBeNull();
  });

  test('gives an untaken invitation a new link when the address is invited again, and refuses one taken', async () => {
    const first = mail();
    await inviteAdministrator(db, { email: 'new@example.com' }, first);
    const again = mail();
    await inviteAdministrator(db, { email: 'NEW@example.com' }, again);

    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'new@example.com'))).toHaveLength(1);
    expect(again.sendInvite).toHaveBeenCalledWith('new@example.com', expect.any(String), 'new');
    expect(again.sendInvite.mock.calls[0]![1]).not.toBe(first.sendInvite.mock.calls[0]![1]);
    const tokens = await db.select().from(schema.accountTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ issuedBy: 'operator', usedAt: null });

    await db.update(schema.users).set({ password: 'hash' }).where(eq(schema.users.email, 'new@example.com'));
    await expect(inviteAdministrator(db, { email: 'new@example.com' }, mail())).rejects.toMatchObject({
      errorCode: 'EMAIL_TAKEN',
    });
  });

  test('tells no other invitee who has not signed in yet', async () => {
    await inviteAdministrator(db, { email: 'first@example.com' }, mail());
    const sent = mail();
    await inviteAdministrator(db, { email: 'second@example.com' }, sent);
    expect(sent.tellAdministrator.mock.calls).toEqual([['owner@example.com', 'second@example.com']]);
  });

  test('refuses an address an account holds, whatever its letter case, and takes a free username', async () => {
    await expect(inviteAdministrator(db, { email: 'MEMBER@example.com' }, mail())).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'EMAIL_TAKEN',
    });
    await inviteAdministrator(db, { email: 'owner@other.example' }, mail());
    const [taken] = await db.select().from(schema.users).where(eq(schema.users.email, 'owner@other.example'));
    expect(taken?.username).toBe('owner-2');
  });

  test('keeps nothing when the link cannot be sent', async () => {
    const failing = {
      sendInvite: vi.fn(async () => Promise.reject(new Error('SMTP down'))),
      tellAdministrator: vi.fn(),
    };
    const refused = inviteAdministrator(db, { email: 'new@example.com' }, failing);
    await expect(refused).rejects.toBeInstanceOf(AdminInviteRefused);
    await expect(refused).rejects.toMatchObject({ statusCode: 502, errorCode: 'INVITE_NOT_SENT' });
    expect(await db.select().from(schema.users).where(eq(schema.users.email, 'new@example.com'))).toEqual([]);
    expect(await db.select().from(schema.accountTokens)).toEqual([]);
    expect(failing.tellAdministrator).not.toHaveBeenCalled();
  });

  test('keeps an untaken invitation when its new link cannot be sent', async () => {
    await inviteAdministrator(db, { email: 'new@example.com' }, mail());
    const failing = {
      sendInvite: vi.fn(async () => Promise.reject(new Error('SMTP down'))),
      tellAdministrator: vi.fn(),
    };
    await expect(inviteAdministrator(db, { email: 'new@example.com' }, failing)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(await pendingOperatorInvitations(db)).toHaveLength(1);
  });

  test('is still invited when an administrator could not be told', async () => {
    const sent = {
      sendInvite: vi.fn(async () => {}),
      tellAdministrator: vi.fn(async () => Promise.reject(new Error('x'))),
    };
    await inviteAdministrator(db, { email: 'new@example.com' }, sent);
    expect(await pendingOperatorInvitations(db)).toHaveLength(1);
  });

  test('stops being pending once taken, resent by an administrator, moved to another address or demoted', async () => {
    const pendingFor = async (email: string) =>
      (await pendingOperatorInvitations(db)).filter((invitation) => invitation.email === email).length;
    const emails = [
      'a@example.com',
      'b@example.com',
      'c@example.com',
      'd@example.com',
      'e@example.com',
      'f@example.com',
    ];
    for (const email of emails) {
      await inviteAdministrator(db, { email }, mail());
    }
    const idOf = async (email: string) =>
      (await db.select().from(schema.users).where(eq(schema.users.email, email)))[0]!.id;

    await db
      .update(schema.users)
      .set({ password: 'hash' })
      .where(eq(schema.users.id, await idOf('a@example.com')));
    await db
      .update(schema.users)
      .set({ oauthProvider: 'github', oauthProviderId: '1' })
      .where(eq(schema.users.id, await idOf('b@example.com')));
    await db
      .update(schema.accountTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.accountTokens.userId, await idOf('c@example.com')));
    await mintAccountToken(db, await idOf('d@example.com'), 'invite', 'd@example.com');
    const movedId = await idOf('e@example.com');
    await db.update(schema.users).set({ email: 'moved@example.com' }).where(eq(schema.users.id, movedId));
    await db
      .update(schema.users)
      .set({ role: 'member' })
      .where(eq(schema.users.id, await idOf('f@example.com')));

    for (const email of emails) {
      expect(await pendingFor(email), email).toBe(0);
    }
    expect(await pendingFor('moved@example.com')).toBe(0);
  });

  test('is named on the banner to administrators only, and only until it ends', async () => {
    const { expiresAt } = await inviteAdministrator(db, { email: 'new@example.com' }, mail());
    const before = new Date(expiresAt.getTime() - 1000);
    expect(await invitationsShownTo(db, { administrator: false, now: before })).toEqual([]);
    expect(await invitationsShownTo(db, { administrator: true, now: before })).toEqual([
      { userId: expect.any(Number), email: 'new@example.com', expiresAt: expiresAt.toISOString() },
    ]);
    expect(await invitationsShownTo(db, { administrator: true, now: expiresAt })).toEqual([]);
    // Ended, it is still pending: the Users page says it ended.
    expect(await pendingOperatorInvitations(db)).toHaveLength(1);
  });
});
