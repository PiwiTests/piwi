/**
 * The operator's notice: what the operator may send (one line of plain text, an http or https link, a level and an
 * audience), how it is kept, and who sees it: nobody once it has ended, and administrators only when it says so.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  operatorNoticeInputSchema,
  sameNotice,
  storedNotice,
  visibleNotice,
  type OperatorNotice,
} from '#shared/operator-notice';
import { openTempDb, type TempDb } from './temp-db';

delete process.env.PIWI_DATABASE_URL;

const { clearOperatorNotice, readOperatorNotice, writeOperatorNotice } =
  await import('../../server/utils/operator-notice');

const NOTICE: OperatorNotice = {
  level: 'warning',
  text: 'Maintenance on Sunday from 06:00 to 06:30 UTC.',
  link: { url: 'https://status.example.com', label: 'Status' },
  expiresAt: '2026-12-06T06:30:00.000Z',
  audience: 'everyone',
  setAt: '2026-11-27T12:00:00.000Z',
};

describe('the notice an operator sends', () => {
  const accepts = (input: unknown) => operatorNoticeInputSchema.safeParse(input).success;

  test('takes a level and one line of text, everyone being the audience unless it says administrators', () => {
    expect(operatorNoticeInputSchema.parse({ level: 'info', text: '  Hello  ' })).toEqual({
      level: 'info',
      text: 'Hello',
      audience: 'everyone',
    });
    expect(accepts({ level: 'critical', text: 'x', audience: 'administrators' })).toBe(true);
    expect(accepts({ level: 'critical', text: 'x'.repeat(500) })).toBe(true);
  });

  test('refuses an unknown level or audience, an empty or long text, a control character and an unknown field', () => {
    expect(accepts({ level: 'danger', text: 'x' })).toBe(false);
    expect(accepts({ level: 'info', text: 'x', audience: 'members' })).toBe(false);
    expect(accepts({ level: 'info', text: '   ' })).toBe(false);
    expect(accepts({ level: 'info', text: 'x'.repeat(501) })).toBe(false);
    expect(accepts({ level: 'info', text: 'one\ntwo' })).toBe(false);
    expect(accepts({ level: 'info', text: 'x', html: '<b>x</b>' })).toBe(false);
  });

  test('refuses what would hide, reorder or break the line, and what the database cannot store', () => {
    const hidden = [
      ...['\u0085', '\u2028', '\u2029', '\u202e', '\u2066', '\u200b', '\u200f', '\ufeff', '\ud800', '\udc00'],
      // The Arabic letter mark, and the invisible tag characters beyond the first plane.
      ...['\u061c', '\u{e0001}', '\u{e0041}'],
    ];
    for (const character of hidden) {
      const code = character.codePointAt(0)!.toString(16);
      expect(accepts({ level: 'info', text: `a${character}b` }), code).toBe(false);
      const link = { url: 'https://example.com', label: `a${character}b` };
      expect(accepts({ level: 'info', text: 'x', link }), code).toBe(false);
    }
    expect(accepts({ level: 'info', text: 'Déploiement à 06:00, 🚧 travaux' })).toBe(true);
    expect(accepts({ level: 'info', text: 'x', link: { url: 'https://example.com/\u0000' } })).toBe(false);
  });

  test('takes an http or https link only, and an end with its offset', () => {
    expect(accepts({ level: 'info', text: 'x', link: { url: 'https://example.com/a?b=c' } })).toBe(true);
    expect(
      accepts({ level: 'info', text: 'x', link: { url: 'http://intranet.example/status', label: 'Status' } }),
    ).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'example.com',
      '//example.com',
      'https://piwi.example.com@evil.example',
      'https://user:secret@example.com',
      'ftp://example.com',
    ]) {
      expect(accepts({ level: 'info', text: 'x', link: { url } }), url).toBe(false);
    }
    expect(accepts({ level: 'info', text: 'x', expiresAt: '2026-12-06T06:30:00Z' })).toBe(true);
    expect(accepts({ level: 'info', text: 'x', expiresAt: '2026-12-06T08:30:00+02:00' })).toBe(true);
    expect(accepts({ level: 'info', text: 'x', expiresAt: 'next Sunday' })).toBe(false);
  });
});

describe('the same notice set again', () => {
  test('is the same whatever its end and whenever it was set, and another once anything it says changes', () => {
    const again = { ...NOTICE, expiresAt: null, setAt: '2026-11-28T00:00:00.000Z' };
    expect(sameNotice(NOTICE, again)).toBe(true);
    expect(sameNotice(NOTICE, { ...again, text: 'Maintenance on Monday.' })).toBe(false);
    expect(sameNotice(NOTICE, { ...again, level: 'critical' })).toBe(false);
    expect(sameNotice(NOTICE, { ...again, audience: 'administrators' })).toBe(false);
    expect(sameNotice(NOTICE, { ...again, link: null })).toBe(false);
    expect(sameNotice(NOTICE, { ...again, link: { url: 'https://status.example.com', label: null } })).toBe(false);
  });
});

describe('who sees the notice', () => {
  const at = (iso: string) => new Date(iso);

  test('everyone, until its end', () => {
    expect(visibleNotice(NOTICE, { administrator: false, now: at('2026-12-06T06:29:59Z') })).toEqual(NOTICE);
    expect(visibleNotice(NOTICE, { administrator: true, now: at('2026-12-06T06:30:00Z') })).toBeNull();
    expect(
      visibleNotice({ ...NOTICE, expiresAt: null }, { administrator: false, now: at('2030-01-01T00:00:00Z') }),
    ).toEqual({ ...NOTICE, expiresAt: null });
    expect(visibleNotice(null, { administrator: true, now: at('2026-11-28T00:00:00Z') })).toBeNull();
  });

  test('administrators only, when it is for them', () => {
    const forAdministrators = { ...NOTICE, audience: 'administrators' as const };
    expect(visibleNotice(forAdministrators, { administrator: true, now: at('2026-11-28T00:00:00Z') })).toEqual(
      forAdministrators,
    );
    expect(visibleNotice(forAdministrators, { administrator: false, now: at('2026-11-28T00:00:00Z') })).toBeNull();
  });

  test('nobody, when what is stored is not a notice', () => {
    expect(storedNotice({ ...NOTICE, level: 'loud' })).toBeNull();
    expect(storedNotice('Maintenance')).toBeNull();
    expect(storedNotice(null)).toBeNull();
  });
});

describe('the stored notice', () => {
  let db: TempDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await openTempDb());
  });
  afterEach(async () => {
    await close();
  });

  test('is one at a time: a new notice replaces it, and clearing leaves none', async () => {
    expect(await readOperatorNotice(db)).toBeNull();
    await writeOperatorNotice(db, NOTICE);
    expect(await readOperatorNotice(db)).toEqual(NOTICE);
    const replaced = { ...NOTICE, level: 'info' as const, text: 'Done.', setAt: '2026-11-27T13:00:00.000Z' };
    await writeOperatorNotice(db, replaced);
    expect(await readOperatorNotice(db)).toEqual(replaced);
    await clearOperatorNotice(db);
    expect(await readOperatorNotice(db)).toBeNull();
  });
});
