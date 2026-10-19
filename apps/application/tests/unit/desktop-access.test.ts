import { describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import {
  DESKTOP_LAUNCH_NONCE_HEADER,
  desktopLaunchNonce,
  presentsDesktopToken,
} from '../../server/utils/desktop-access';

const TOKEN = 'pd_desktop_token';

/** A request carrying just these headers. */
function withHeaders(headers: Record<string, string>): H3Event {
  return { context: {}, node: { req: { headers }, res: {} } } as unknown as H3Event;
}

describe('the desktop access token', () => {
  it('is accepted from the cookie, a bearer, the x-piwi-token header and the X-API-Key header', () => {
    expect(presentsDesktopToken(withHeaders({ cookie: `piwi_token=${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ 'x-piwi-token': TOKEN }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ 'x-api-key': TOKEN }), TOKEN)).toBe(true);
  });

  it('is refused when absent or wrong, whichever header carries it', () => {
    expect(presentsDesktopToken(withHeaders({}), TOKEN)).toBe(false);
    expect(presentsDesktopToken(withHeaders({ 'x-api-key': 'pd_other' }), TOKEN)).toBe(false);
    expect(presentsDesktopToken(withHeaders({ authorization: 'Bearer pd_other' }), TOKEN)).toBe(false);
  });
});

describe('the desktop launch nonce', () => {
  it('is the value the shell gave the sidecar, and absent outside the desktop app', () => {
    expect(desktopLaunchNonce({ PIWI_DESKTOP_LAUNCH_NONCE: 'a1b2' })).toBe('a1b2');
    expect(desktopLaunchNonce({})).toBeNull();
    expect(desktopLaunchNonce({ PIWI_DESKTOP_LAUNCH_NONCE: '' })).toBeNull();
  });

  it('is echoed by /api/health once the database answers, so the shell knows its own server', async () => {
    vi.resetModules();
    vi.doMock('../../server/database', () => ({
      getDatabase: async () => ({ select: () => ({ from: () => ({ limit: async () => [] }) }) }),
    }));
    const headers = new Map<string, string>();
    vi.stubGlobal('defineRouteMeta', () => {});
    vi.stubGlobal('eventHandler', (handler: unknown) => handler);
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: string) => headers.set(name, value));
    vi.stubGlobal('setResponseStatus', () => {});
    vi.stubEnv('PIWI_DESKTOP_LAUNCH_NONCE', 'launch-nonce');
    try {
      const health = (await import('../../server/api/health.get')).default as unknown as (
        e: unknown,
      ) => Promise<unknown>;
      expect(await health({})).toEqual({ status: 'ok', database: 'ok' });
      expect(headers.get(DESKTOP_LAUNCH_NONCE_HEADER)).toBe('launch-nonce');
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.doUnmock('../../server/database');
    }
  });
});
