import { beforeEach, describe, expect, it } from 'vitest';
import { addNamedPick } from '../../src/shared/session-add.js';
import { getSessionPicks } from '../../src/shared/session-storage.js';

const LOCATOR = "getByRole('button', { name: 'Apply coupon' })";
const PAGE = 'https://shop.test/cart';

let failWrites = false;

beforeEach(() => {
  failWrites = false;
  const store: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          if (failWrites) throw new Error('Session storage quota exceeded.');
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
});

describe('addNamedPick', () => {
  it('keeps the pick under a name the page object can take, reading the page only then', async () => {
    let reads = 0;
    const page = () => {
      reads++;
      return PAGE;
    };
    expect(await addNamedPick('', LOCATOR, page)).toBe('Type a name.');
    expect(await addNamedPick('page', LOCATOR, page)).toBe(
      'The page object already uses the name page: choose another one.',
    );
    expect(await addNamedPick('2fast', LOCATOR, page)).toBe(
      'Use only letters without accents, digits, _ or $, and do not start with a digit.',
    );
    expect(reads).toBe(0);
    expect(await addNamedPick('applyCoupon', LOCATOR, page)).toBeNull();
    expect(await addNamedPick('applyCoupon', LOCATOR, page)).toBe('"applyCoupon" is already in the list.');
    expect(reads).toBe(1);
    expect(await getSessionPicks()).toEqual([{ name: 'applyCoupon', locator: LOCATOR, pageUrl: PAGE }]);
  });

  it('says why the session storage refused the pick rather than failing', async () => {
    failWrites = true;
    expect(await addNamedPick('applyCoupon', LOCATOR, () => PAGE)).toBe(
      'Not added to the session: Session storage quota exceeded.',
    );
    expect(await getSessionPicks()).toEqual([]);
  });
});
