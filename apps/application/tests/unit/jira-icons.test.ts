import { afterEach, describe, test, expect, vi } from 'vitest';
import {
  fetchExternalAvatar,
  isExternalAvatarUrl,
  isJiraIconPath,
  jiraAvatar,
  jiraIconPath,
} from '../../server/utils/integrations/jira/icons';

const SITE = 'https://acme.atlassian.net';
const AVATAR = '/rest/api/2/universal_avatar/view/type/issuetype/avatar/10303?size=medium';

describe('Jira icon paths', () => {
  test('an icon on the site, relative, or through the gateway keeps its site path', () => {
    expect(jiraIconPath(`${SITE}${AVATAR}`, SITE)).toBe(AVATAR);
    expect(jiraIconPath(AVATAR, SITE)).toBe(AVATAR);
    expect(jiraIconPath(`https://api.atlassian.com/ex/jira/abc-123${AVATAR}`, SITE)).toBe(AVATAR);
    expect(jiraIconPath(`${SITE}/images/icons/issuetypes/bug.svg`, SITE)).toBe('/images/icons/issuetypes/bug.svg');
    expect(jiraIconPath(`${SITE}/secure/projectavatar?pid=10000&avatarId=10400`, SITE)).toBe(
      '/secure/projectavatar?pid=10000&avatarId=10400',
    );
  });

  test('an icon hosted elsewhere, or a path that is not an icon, is dropped', () => {
    expect(jiraIconPath(`https://evil.example${AVATAR}`, SITE)).toBeNull();
    expect(jiraIconPath(`${SITE}/rest/api/3/myself`, SITE)).toBeNull();
    expect(jiraIconPath(undefined, SITE)).toBeNull();
    expect(jiraIconPath('not a url ::', 'not a site')).toBeNull();
  });

  test('only icon paths are served, with no way out of them', () => {
    expect(isJiraIconPath(AVATAR)).toBe(true);
    expect(isJiraIconPath('/rest/api/3/myself')).toBe(false);
    expect(isJiraIconPath('/images/icons/../../rest/api/3/myself')).toBe(false);
    expect(isJiraIconPath('//evil.example/images/icons/x.svg')).toBe(false);
    expect(isJiraIconPath('https://evil.example/images/icons/x.svg')).toBe(false);
  });
});

const GRAVATAR =
  'https://secure.gravatar.com/avatar/abc?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJD-5.png';
const ATL_PAAS = 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/JD-5.png';

describe("a person's avatar", () => {
  afterEach(() => vi.unstubAllGlobals());

  test('is kept as its URL on a public avatar host, else as a path on the site', () => {
    expect(jiraAvatar(GRAVATAR, SITE)).toBe(GRAVATAR);
    expect(jiraAvatar(ATL_PAAS, SITE)).toBe(ATL_PAAS);
    expect(jiraAvatar(`${SITE}/secure/useravatar?avatarId=10122`, SITE)).toBe('/secure/useravatar?avatarId=10122');
    expect(jiraAvatar('https://evil.example/avatar.png', SITE)).toBeNull();
    expect(isExternalAvatarUrl('http://secure.gravatar.com/avatar/abc')).toBe(false);
    expect(isExternalAvatarUrl('https://user:pw@secure.gravatar.com/avatar/abc')).toBe(false);
    expect(isExternalAvatarUrl('https://avatar-management--avatars.evil.example/x.png')).toBe(false);
  });

  test('follows redirects only between avatar hosts, and never sends credentials', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url === GRAVATAR) return new Response(null, { status: 302, headers: { location: ATL_PAAS } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      }),
    );
    const icon = await fetchExternalAvatar(GRAVATAR);
    expect(icon).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(calls.map((c) => c.url)).toEqual([GRAVATAR, ATL_PAAS]);
    for (const c of calls) expect(new Headers(c.init.headers).has('authorization')).toBe(false);
  });

  test('stops at a redirect off the avatar hosts, and at anything but an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.png' } })),
    );
    expect(await fetchExternalAvatar(GRAVATAR)).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    );
    expect(await fetchExternalAvatar(ATL_PAAS)).toBeNull();
    expect(await fetchExternalAvatar('https://evil.example/x.png')).toBeNull();
  });
});
