import { describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import {
  DESKTOP_CHALLENGE_HEADER,
  DESKTOP_PROOF_HEADER,
  desktopTokenProof,
  newDesktopChallenge,
} from '@piwitests/core/desktop-proof';
import { answerDesktopChallenge, presentsDesktopToken } from '../../server/utils/desktop-access';

const TOKEN = 'pd_desktop_token';

/** A request carrying just these headers. */
function withHeaders(headers: Record<string, string>): H3Event {
  return { context: {}, node: { req: { headers }, res: {} } } as unknown as H3Event;
}

describe('the desktop access token', () => {
  it('is accepted from the cookie, a bearer, the x-piwi-token header and the X-API-Key header', () => {
    expect(presentsDesktopToken(withHeaders({ cookie: `piwi_token=${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ authorization: `bearer ${TOKEN}` }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ 'x-piwi-token': TOKEN }), TOKEN)).toBe(true);
    expect(presentsDesktopToken(withHeaders({ 'x-api-key': TOKEN }), TOKEN)).toBe(true);
  });

  it('is refused when absent or wrong, whichever header carries it', () => {
    expect(presentsDesktopToken(withHeaders({}), TOKEN)).toBe(false);
    expect(presentsDesktopToken(withHeaders({ 'x-api-key': 'pd_other' }), TOKEN)).toBe(false);
    expect(presentsDesktopToken(withHeaders({ authorization: 'Bearer pd_other' }), TOKEN)).toBe(false);
  });
});

describe("the shell's and Piwi Picker's challenge", () => {
  /** A request to `/api/health` on loopback port `port`, and the response headers it gets. */
  function healthRequest(headers: Record<string, string>, port = 3000) {
    const sent = new Map<string, string>();
    const event = {
      context: {},
      node: {
        req: { headers, socket: { localPort: port } },
        res: { setHeader: (name: string, value: string) => sent.set(name.toLowerCase(), value) },
      },
    } as unknown as H3Event;
    return { event, sent };
  }

  it('is answered with the proof of the token, for the port the request reached', async () => {
    const challenge = newDesktopChallenge();
    const { event, sent } = healthRequest({ [DESKTOP_CHALLENGE_HEADER]: challenge }, 4318);
    await answerDesktopChallenge(event, TOKEN);
    expect(sent.get(DESKTOP_PROOF_HEADER)).toBe(await desktopTokenProof(TOKEN, 4318, challenge));
  });

  it('is left unanswered outside the desktop app, and when it is not a challenge', async () => {
    const outside = healthRequest({ [DESKTOP_CHALLENGE_HEADER]: newDesktopChallenge() });
    await answerDesktopChallenge(outside.event, '');
    expect(outside.sent.size).toBe(0);
    const malformed = healthRequest({ [DESKTOP_CHALLENGE_HEADER]: 'not-a-challenge' });
    await answerDesktopChallenge(malformed.event, TOKEN);
    expect(malformed.sent.size).toBe(0);
  });
});

describe('/api/health in the desktop app', () => {
  /** Runs the health route itself, answering a request on loopback port `port` with `headers`. */
  async function getHealth(headers: Record<string, string>, port = 4318) {
    vi.resetModules();
    vi.doMock('../../server/database', () => ({
      getDatabase: async () => ({ select: () => ({ from: () => ({ limit: async () => [] }) }) }),
    }));
    const sent = new Map<string, string>();
    const statuses: number[] = [];
    vi.stubGlobal('defineRouteMeta', () => {});
    vi.stubGlobal('eventHandler', (handler: unknown) => handler);
    vi.stubGlobal('setResponseStatus', (_event: unknown, status: number) => statuses.push(status));
    vi.stubEnv('PIWI_DESKTOP_TOKEN', TOKEN);
    try {
      const health = (await import('../../server/api/health.get')).default as unknown as (
        e: H3Event,
      ) => Promise<unknown>;
      const event = {
        context: {},
        node: {
          req: { headers, socket: { localPort: port } },
          res: { setHeader: (name: string, value: string) => sent.set(name.toLowerCase(), value) },
        },
      } as unknown as H3Event;
      return { body: await health(event), sent, statuses };
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.doUnmock('../../server/database');
    }
  }

  it('answers a challenge with the proof of the token, on a 200', async () => {
    const challenge = newDesktopChallenge();
    const { body, sent, statuses } = await getHealth({ [DESKTOP_CHALLENGE_HEADER]: challenge }, 4318);
    expect(body).toEqual({ status: 'ok', database: 'ok' });
    expect(statuses).toEqual([]);
    expect(sent.get(DESKTOP_PROOF_HEADER)).toBe(await desktopTokenProof(TOKEN, 4318, challenge));
  });

  it('sets no proof without a challenge, or with one that is not a challenge', async () => {
    const none = await getHealth({});
    expect(none.body).toEqual({ status: 'ok', database: 'ok' });
    expect(none.sent.size).toBe(0);
    const malformed = await getHealth({ [DESKTOP_CHALLENGE_HEADER]: 'not-a-challenge' });
    expect(malformed.sent.size).toBe(0);
  });
});
