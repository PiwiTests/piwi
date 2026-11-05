import { afterEach, describe, expect, test, vi } from 'vitest';
import { isOAuthAvatarUrl, oauthAvatar } from '../../server/utils/user-avatar';
import { profilePictureSrc } from '../../app/utils/user-avatar';
import { accountPictureVersion, profilePictureVersion, uploadedPictureVersion } from '../../shared/user-avatar';

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
