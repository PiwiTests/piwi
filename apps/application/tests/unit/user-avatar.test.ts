import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isOAuthAvatarUrl, oauthAvatar } from '../../server/utils/user-avatar';
import { accountPictureSrc, profilePictureSrc } from '../../app/utils/user-avatar';
import {
  LETTER_AVATAR_COLORS,
  accountInitials,
  accountPictureVersion,
  letterAvatarColor,
  profilePictureVersion,
  uploadedPictureVersion,
} from '../../shared/user-avatar';

const GITHUB = 'https://avatars.githubusercontent.com/u/583231?v=4';
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isOAuthAvatarUrl', () => {
  test("accepts GitHub's and Google's picture hosts over https", () => {
    expect(isOAuthAvatarUrl(GITHUB)).toBe(true);
    expect(isOAuthAvatarUrl(GOOGLE)).toBe(true);
  });

  test('refuses any other host, scheme, port or credentials', () => {
    expect(isOAuthAvatarUrl('http://avatars.githubusercontent.com/u/1')).toBe(false);
    expect(isOAuthAvatarUrl('https://avatars.githubusercontent.com:8443/u/1')).toBe(false);
    expect(isOAuthAvatarUrl('https://user:pw@avatars.githubusercontent.com/u/1')).toBe(false);
    expect(isOAuthAvatarUrl('https://evil.example/u/1')).toBe(false);
    expect(isOAuthAvatarUrl('https://avatars.githubusercontent.com.evil.example/u/1')).toBe(false);
    expect(isOAuthAvatarUrl('https://lh3.googleusercontent.com.evil.example/a')).toBe(false);
    expect(isOAuthAvatarUrl('not a url')).toBe(false);
  });
});

describe('oauthAvatar', () => {
  test("fetches GitHub's picture at the menu's size and remembers it", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const url = `${GITHUB}&remembered`;
    expect(await oauthAvatar(url)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(await oauthAvatar(url)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get('s')).toBe('96');
  });

  test("leaves Google's picture address as the provider sized it", async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(new Uint8Array([4]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const url = `${GOOGLE}&as-named`;
    await oauthAvatar(url);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
  });

  test('a picture over the size limit, or a refusal, is no picture and is remembered', async () => {
    const oversized = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024) },
        }),
    );
    vi.stubGlobal('fetch', oversized);
    expect(await oauthAvatar(`${GITHUB}&oversized`)).toBeNull();

    const refused = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', refused);
    expect(await oauthAvatar(`${GITHUB}&refused`)).toBeNull();
    expect(await oauthAvatar(`${GITHUB}&refused`)).toBeNull();
    expect(refused).toHaveBeenCalledTimes(1);
  });

  test('never fetches a URL off the picture hosts, nor follows a redirect off them', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await oauthAvatar('https://evil.example/x.png')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await oauthAvatar(`${GOOGLE}&redirected`)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a host that cannot answer for now throws and is asked again next time', async () => {
    const url = `${GITHUB}&outage`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(oauthAvatar(url)).rejects.toThrow('503');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/jpeg' } })),
    );
    expect(await oauthAvatar(url)).toEqual({ bytes: new Uint8Array([9]), mime: 'image/jpeg' });
  });
});

describe('profilePictureSrc', () => {
  test("points at the instance's own route under its base URL, carrying the version", () => {
    expect(profilePictureSrc('/', '1xgtbvx')).toBe('/api/auth/avatar?v=1xgtbvx');
    expect(profilePictureSrc('/demo/', '1xgtbvx')).toBe('/demo/api/auth/avatar?v=1xgtbvx');
  });
});

describe('accountPictureSrc', () => {
  test("is the signed-in account's own picture, on its own avatar only", () => {
    const signedIn = { id: 7, avatarVersion: '1xgtbvx' };
    expect(accountPictureSrc('/', signedIn, 7)).toBe('/api/auth/avatar?v=1xgtbvx');
    expect(accountPictureSrc('/', signedIn, 8)).toBeUndefined();
    expect(accountPictureSrc('/', { id: 7, avatarVersion: null }, 7)).toBeUndefined();
    expect(accountPictureSrc('/', null, 7)).toBeUndefined();
  });
});

describe('accountPictureVersion', () => {
  const KEY = `avatars/7/${'0a'.repeat(32)}-1122334455667788.webp`;

  test("is the uploaded picture's file name, else the provider's version, else null", () => {
    expect(accountPictureVersion({ avatarKey: KEY, avatarUrl: GITHUB })).toBe(`${'0a'.repeat(32)}-1122334455667788`);
    expect(accountPictureVersion({ avatarKey: null, avatarUrl: GITHUB })).toBe(profilePictureVersion(GITHUB));
    expect(accountPictureVersion({ avatarKey: null, avatarUrl: null })).toBeNull();
  });

  test('matches the version the upload route answers', () => {
    expect(accountPictureVersion({ avatarKey: KEY, avatarUrl: null })).toBe(uploadedPictureVersion(KEY));
  });
});

describe('accountInitials', () => {
  const initials = (name: string | null, username = 'someone') => accountInitials({ name, username });

  test('takes the first and last words of the display name', () => {
    expect(initials('Jane Doe')).toBe('JD');
    expect(initials('jane van der Berg')).toBe('JB');
    expect(initials('Jean-Luc Picard')).toBe('JP');
  });

  test('falls back to the username when the display name is empty or blank', () => {
    expect(initials(null, 'jane.doe')).toBe('JD');
    expect(initials('', 'ci-uploader')).toBe('CU');
    expect(initials('   ', 'jane_doe')).toBe('JD');
  });

  test('gives one letter for a name in one word', () => {
    expect(initials('Avery')).toBe('A');
    expect(initials(null, 'root')).toBe('R');
  });

  test('leaves out a part in parentheses or brackets', () => {
    expect(initials('Avery (Admin)')).toBe('A');
    expect(initials('Jane Doe [contractor]')).toBe('JD');
    expect(initials('(Admin)', 'jane.doe')).toBe('JD');
  });

  test('reads an email address only before its @', () => {
    expect(initials(null, 'jane.doe@example.com')).toBe('JD');
    expect(initials('jane.doe@example.com')).toBe('JD');
  });

  test('keeps accents and scripts other than Latin', () => {
    expect(initials('élodie Ørsted')).toBe('ÉØ');
    expect(initials('e\u0301lodie')).toBe('É');
    expect(initials('王小明')).toBe('王');
    expect(initials('Ольга Петрова')).toBe('ОП');
    expect(initials('प्रिया शर्मा')).toBe('पश');
  });

  test('keeps one character per word when uppercasing gives more', () => {
    expect(initials('ß straße')).toBe('SS');
    expect(initials('ﬁona')).toBe('F');
  });

  test('is null when nothing holds a letter or a digit', () => {
    expect(initials('---', '...')).toBeNull();
    expect(initials('(Admin)', '___')).toBeNull();
  });
});

describe('letterAvatarColor', () => {
  test('gives an account the same color on every screen and every visit', () => {
    expect([1, 2, 4, 6].map((id) => letterAvatarColor(id).hue)).toEqual(['teal', 'orange', 'sky', 'lime']);
  });

  test('spreads accounts over every color', () => {
    const used = new Set(Array.from({ length: 60 }, (_, i) => letterAvatarColor(i + 1).hue));
    expect(used.size).toBe(LETTER_AVATAR_COLORS.length);
  });

  /** WCAG 2 contrast ratio of two `#rrggbb` colors. */
  function contrast(a: string, b: string): number {
    const luminance = (hex: string) => {
      const [r, g, bl] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
    };
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  }

  test('every tint meets WCAG AA contrast in the light and the dark theme', () => {
    for (const color of LETTER_AVATAR_COLORS) {
      expect(contrast(color.light.background, color.light.text), `${color.hue} light`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color.dark.background, color.dark.text), `${color.hue} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('uses no hue of a test outcome, a status color or the accent', () => {
    const css = readFileSync(new URL('../../app/assets/css/main.css', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../../app/app.config.ts', import.meta.url), 'utf8');
    const statusHues = [...css.matchAll(/--color-status-[\w-]+:\s*var\(--color-([a-z]+)-\d+\)/g)].map((m) => m[1]);
    const configHues = [...config.matchAll(/^\s+(?:primary|success|error|warning|flaky|info): '([a-z]+)'/gm)].map(
      (m) => m[1],
    );
    expect(statusHues.length).toBeGreaterThan(0);
    expect(configHues).toContain('violet');
    const reserved = new Set([...statusHues, ...configHues]);
    for (const color of LETTER_AVATAR_COLORS) expect(reserved.has(color.hue), color.hue).toBe(false);
  });
});
