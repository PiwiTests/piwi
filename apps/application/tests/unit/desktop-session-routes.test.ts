/**
 * The window's session bootstrap (`GET /__piwi/session`) and the shell's stream (`GET /api/desktop/notifications`) as
 * Nitro routes: they answer what the editor service's own host answers
 * (`packages/editor/tests/run-target-routes.test.ts`), the stream passes the run target's stops on, and it ends them
 * when the shell leaves.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { TOKEN_COOKIE } from '@piwitests/editor/host-guard';
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
vi.stubGlobal('sendRedirect', (_event: unknown, location: string) => {
  redirected.push(location);
  return location;
});

let session: (event: unknown) => Promise<unknown> | unknown;
let notifications: (event: unknown) => Promise<Response>;

beforeAll(async () => {
  session = (await import('../../server/routes/__piwi/session.get')).default as unknown as typeof session;
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

describe('the window session', () => {
  test('answers 404 on the server build, which has no token', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    await expect(Promise.resolve().then(() => visit({ token: TOKEN }))).rejects.toMatchObject({ statusCode: 404 });
  });

  test('answers 403 to a token that is missing, wrong or sent twice', async () => {
    for (const token of [undefined, '', `${TOKEN}0`, [TOKEN, TOKEN], { 0: TOKEN }]) {
      await expect(
        Promise.resolve().then(() => visit({ token })),
        String(token),
      ).rejects.toMatchObject({
        statusCode: 403,
        statusMessage: 'Invalid desktop token',
      });
    }
    expect(set).toEqual([]);
  });

  test('exchanges the token for the cookie and redirects to the home page', async () => {
    await visit({ token: TOKEN });
    expect(set).toEqual([
      { name: TOKEN_COOKIE, value: TOKEN, options: { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 31536000 } },
    ]);
    expect(redirected).toEqual(['/']);
  });

  test('redirects to the dashboard page `to` names, and to the home page for anything else', async () => {
    const to = async (page: unknown) => {
      redirected.length = 0;
      await visit({ token: TOKEN, to: page });
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
