/**
 * The window's session bootstrap (`GET /__piwi/session`, with a session code) and the shell's stream (`GET /api/desktop/notifications`) as
 * Nitro routes: they answer what the editor service's own host answers
 * (`packages/editor/tests/run-target-routes.test.ts`), the stream passes the run target's stops on, and it ends them
 * when the shell leaves.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { TOKEN_COOKIE } from '@piwitests/editor/host-guard';
import { mintSessionCode, SESSION_CODE_TTL_MS } from '@piwitests/editor/run-target-session';
import { apiError } from '../../server/utils/api-error';

const TOKEN = `pd_${'d'.repeat(64)}`;

const shell = vi.hoisted(() => ({
  send: null as ((message: unknown) => void) | null,
  ended: 0,
}));

vi.mock('../../server/utils/auth', () => ({ requireAuth: async () => ({}) }));
vi.mock('../../server/database', () => ({ getDatabase: async () => ({}) }));
vi.mock('../../server/utils/project-access', () => ({ getProjectScope: async () => 'all' }));
vi.mock('@piwitests/editor/run-target-stream', () => ({
  openShellStream: (send: (message: unknown) => void) => {
    shell.send = send;
    return () => void shell.ended++;
  },
}));

interface Cookie {
  name: string;
  value: string;
  options: unknown;
}

const set: Cookie[] = [];
const redirected: string[] = [];

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('apiError', apiError);
vi.stubGlobal('getQuery', (event: { query: Record<string, unknown> }) => event.query);
vi.stubGlobal('setCookie', (_event: unknown, name: string, value: string, options: unknown) => {
  set.push({ name, value, options });
});
vi.stubGlobal('setResponseHeader', () => {});
vi.stubGlobal('getRouterParam', () => undefined);
vi.stubGlobal('sendRedirect', (_event: unknown, location: string) => {
  redirected.push(location);
  return location;
});

let session: (event: unknown) => Promise<unknown> | unknown;
let mintCode: (event: unknown) => Promise<unknown>;
let notifications: (event: unknown) => Promise<Response>;

beforeAll(async () => {
  session = (await import('../../server/routes/__piwi/session.get')).default as unknown as typeof session;
  mintCode = (await import('../../server/api/desktop/run-target/session-code.post'))
    .default as unknown as typeof mintCode;
  notifications = (await import('../../server/api/desktop/notifications.get'))
    .default as unknown as typeof notifications;
});

beforeEach(() => {
  process.env.PIWI_DESKTOP_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.PIWI_DESKTOP_TOKEN;
  set.length = 0;
  redirected.length = 0;
  shell.send = null;
  shell.ended = 0;
});

const visit = (query: Record<string, unknown>) => session({ query });

/** The shell's `POST` for a session code, as the Nitro route reads it. */
const shellAsks = (headers: Record<string, string> = {}) => ({
  context: {},
  node: {
    req: Object.assign(Readable.from([Buffer.from('{}')]), {
      headers: { 'content-type': 'application/json', ...headers },
    }),
    res: {},
  },
});

describe('the window session', () => {
  test('answers 404 on the server build, which has no token', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    await expect(Promise.resolve().then(() => visit({ code: mintSessionCode() }))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  test('answers 403 to a code that is missing, unknown or sent twice', async () => {
    const code = mintSessionCode();
    for (const value of [undefined, '', `${code}0`, [code, code], { 0: code }]) {
      await expect(
        Promise.resolve().then(() => visit({ code: value })),
        String(value),
      ).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'Invalid session code',
      });
    }
    expect(set).toEqual([]);
  });

  test('opens nothing for the access token on the URL', async () => {
    for (const query of [{ token: TOKEN }, { code: TOKEN }]) {
      await expect(Promise.resolve().then(() => visit(query))).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(set).toEqual([]);
  });

  test('exchanges the code for the cookie and redirects to the home page', async () => {
    await visit({ code: mintSessionCode() });
    expect(set).toEqual([
      { name: TOKEN_COOKIE, value: TOKEN, options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 31536000 } },
    ]);
    expect(redirected).toEqual(['/']);
  });

  test('exchanges a code the Nitro route gave the shell, once, and refuses a code a browser asked for', async () => {
    const { code } = (await mintCode(shellAsks())) as { code: string };
    expect(code).toMatch(/^pds_[0-9a-f]{64}$/);
    await visit({ code });
    expect(set).toEqual([
      { name: TOKEN_COOKIE, value: TOKEN, options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 31536000 } },
    ]);
    expect(redirected).toEqual(['/']);
    await expect(Promise.resolve().then(() => visit({ code }))).rejects.toMatchObject({ statusCode: 403 });

    await expect(mintCode(shellAsks({ origin: 'http://127.0.0.1:3000' }))).rejects.toMatchObject({ statusCode: 403 });
    expect(set).toHaveLength(1);
  });

  test('takes a code once, and refuses it after its lifetime', async () => {
    const code = mintSessionCode();
    await visit({ code });
    await expect(Promise.resolve().then(() => visit({ code }))).rejects.toMatchObject({ statusCode: 403 });
    const expired = mintSessionCode();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + SESSION_CODE_TTL_MS);
      await expect(Promise.resolve().then(() => visit({ code: expired }))).rejects.toMatchObject({ statusCode: 403 });
    } finally {
      vi.useRealTimers();
    }
    expect(set).toHaveLength(1);
  });

  test('redirects to the dashboard page `to` names, and to the home page for anything else', async () => {
    const to = async (page: unknown) => {
      redirected.length = 0;
      await visit({ code: mintSessionCode(), to: page });
      return redirected[0];
    };
    expect(await to('/projects/3/runs?tab=failed#top')).toBe('/projects/3/runs?tab=failed');
    for (const refused of ['//evil.example', '/\\evil.example', '/api/projects', '/_nuxt/a', '/logo.svg', 'x', 7]) {
      expect(await to(refused), String(refused)).toBe('/');
    }
  });
});

describe('the shell stream', () => {
  test('answers 404 on the server build', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    await expect(notifications({ node: { req: new EventEmitter() } })).rejects.toMatchObject({ statusCode: 404 });
    expect(shell.send).toBeNull();
  });

  test('passes on the run target’s stop, and ends the run target’s part when the shell leaves', async () => {
    const req = Object.assign(new EventEmitter(), { destroyed: false });
    const response = await notifications({ node: { req } });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();

    shell.send!({ type: 'requested-run-stop', requestId: 'c'.repeat(32) });
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(
      `data: ${JSON.stringify({ type: 'requested-run-stop', requestId: 'c'.repeat(32) })}\n\n`,
    );

    expect(shell.ended).toBe(0);
    req.emit('close');
    expect(shell.ended).toBe(1);
  });
});
