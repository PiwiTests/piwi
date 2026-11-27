/**
 * The session cookie is `__Host-piwi_session`: Secure, HttpOnly, `Path=/` and no `Domain`, so another host under the
 * same domain cannot plant one. A sealed session sent under the unprefixed name is never read.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createEvent } from 'h3';
import { afterAll, describe, expect, test, vi } from 'vitest';

vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: 'true', authSecret: 'session-cookie-test-secret-0123456789' }));
vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
afterAll(() => vi.unstubAllEnvs());

const { SESSION_COOKIE_NAME, getUserSession, setUserSession } = await import('../../server/utils/auth');

/** A request carrying `cookie`, and the cookies its response sets. */
function request(cookie?: string) {
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = '/';
  if (cookie) req.headers.cookie = cookie;
  const res = new ServerResponse(req);
  const event = createEvent(req, res);
  const setCookies = () => {
    const header = res.getHeader('set-cookie');
    return (Array.isArray(header) ? header : header ? [String(header)] : []).map(String);
  };
  return { event, setCookies };
}

describe('the session cookie', () => {
  test('is written under the __Host- prefix, with the attributes the prefix requires', async () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-piwi_session');
    const signIn = request();
    await setUserSession(signIn.event, { userId: 7, sessionEpoch: 0 });
    const [cookie] = signIn.setCookies().filter((line) => line.startsWith('__Host-piwi_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).not.toMatch(/; Domain=/i);

    const value = cookie!.slice('__Host-piwi_session='.length).split(';')[0];
    expect(await getUserSession(request(`__Host-piwi_session=${value}`).event)).toMatchObject({ userId: 7 });
  });

  test('never reads a sealed session sent without the prefix, nor writes over that cookie', async () => {
    const signIn = request();
    await setUserSession(signIn.event, { userId: 7, sessionEpoch: 0 });
    const value = signIn
      .setCookies()
      .find((line) => line.startsWith('__Host-piwi_session='))!
      .slice('__Host-piwi_session='.length)
      .split(';')[0];

    const planted = request(`piwi_session=${value}`);
    expect(await getUserSession(planted.event)).toBeNull();
    // Another Piwi on the same host may still use that name: its cookie is left alone.
    expect(planted.setCookies().some((line) => line.startsWith('piwi_session='))).toBe(false);
  });
});
