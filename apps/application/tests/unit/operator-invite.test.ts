/**
 * The administrator invitation whoever runs the instance asks for: an account without a password, a one-time link sent
 * to the invited address only, every other administrator told, nothing kept when the link cannot be sent, and an
 * address an account holds refused. The invitation stays pending, on the Users page, until a password is set or a
 * sign-in provider linked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { AdminInviteRefused, adminInviteSchema, inviteAdministrator, usernameBase } =
  await import('../../server/utils/operator-invite');
const { pendingOperatorInvitations } = await import('#shared/handlers/operator-invitations');
const { listUserItems } = await import('#shared/handlers/project-access');
const { mintAccountToken } = await import('../../server/utils/account-tokens');

describe('the username of an invited address', () => {
  test('is its part before the @, in letters, digits, dots, underscores and hyphens, three characters at least', () => {
    expect(usernameBase('Alice.Martin@example.com')).toBe('alice.martin');
    expect(usernameBase('a+b c@example.com')).toBe('a-b-c');
    expect(usernameBase('jo@example.com')).toBe('jo-admin');
    expect(usernameBase('+@example.com')).toBe('admin');
    expect(usernameBase(`${'x'.repeat(300)}@example.com`).length).toBeLessThanOrEqual(192);
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

  test('is still invited when an administrator could not be told', async () => {
    const sent = {
      sendInvite: vi.fn(async () => {}),
      tellAdministrator: vi.fn(async () => Promise.reject(new Error('x'))),
    };
    await inviteAdministrator(db, { email: 'new@example.com' }, sent);
    expect(await pendingOperatorInvitations(db)).toHaveLength(1);
  });

  test('stops being pending once a password is set, a provider linked, the link used, or an administrator resends it', async () => {
    const pendingFor = async (email: string) =>
      (await pendingOperatorInvitations(db)).filter((invitation) => invitation.email === email).length;
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
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

    for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
      expect(await pendingFor(email), email).toBe(0);
    }
  });
});
