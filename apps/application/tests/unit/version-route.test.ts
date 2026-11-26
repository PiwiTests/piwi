import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiError } from '../../server/utils/api-error';

/**
 * `GET /api/version` tells the version and the runtime only to a signed-in caller when authentication is on, and
 * `/_openapi.json`, which names the version too, answers such a caller alone.
 */

const state = vi.hoisted(() => ({ authEnabled: false, signedIn: false }));
vi.mock('../../server/utils/auth', () => ({
  isAuthEnabled: () => state.authEnabled,
  optionalCaller: async () => (state.signedIn ? { id: 1 } : null),
}));

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
vi.stubGlobal('useRuntimeConfig', () => ({
  appVersion: '0.78.0',
  buildSha: 'abc1234',
  buildTime: '2026-11-20T10:00:00.000Z',
  public: {},
}));

type Handler = (event: { path: string }) => Promise<unknown>;
const version = (await import('../../server/api/version.get')).default as unknown as Handler;
const openapiAccess = (await import('../../server/middleware/openapi-access')).default as unknown as Handler;

beforeEach(() => {
  state.authEnabled = false;
  state.signedIn = false;
});

describe('GET /api/version', () => {
  test('tells everything with authentication off', async () => {
    expect(await version({ path: '/api/version' })).toMatchObject({
      appVersion: '0.78.0',
      buildSha: 'abc1234',
      buildTime: '2026-11-20T10:00:00.000Z',
      node: process.version,
    });
  });

  test('tells nothing to a caller not signed in when authentication is on', async () => {
    state.authEnabled = true;
    const answer = (await version({ path: '/api/version' })) as Record<string, unknown>;
    expect(Object.keys(answer).length).toBeGreaterThan(0);
    expect(Object.values(answer).every((value) => value === null)).toBe(true);
  });

  test('tells everything to a signed-in caller', async () => {
    state.authEnabled = true;
    state.signedIn = true;
    expect(await version({ path: '/api/version' })).toMatchObject({ appVersion: '0.78.0', node: process.version });
  });
});

describe('the API description', () => {
  const refused = async (path: string) => {
    try {
      await openapiAccess({ path });
      return null;
    } catch (error) {
      return (error as ReturnType<typeof apiError>).statusCode;
    }
  };

  test('answers a caller not signed in 401 when authentication is on, however the path is written', async () => {
    state.authEnabled = true;
    for (const path of [
      '/_openapi.json',
      '/_openapi.json?x=1',
      '/%5Fopenapi.json',
      '/_openapi%2Ejson',
      '/_openapi.json/',
      '//_OpenAPI.json//',
    ]) {
      expect(await refused(path), path).toBe(401);
    }
    expect(await refused('/api/health')).toBeNull();
    expect(await refused('/%E0')).toBeNull();
  });

  test('serves a signed-in caller, and everyone with authentication off', async () => {
    state.authEnabled = true;
    state.signedIn = true;
    expect(await refused('/_openapi.json')).toBeNull();
    state.authEnabled = false;
    state.signedIn = false;
    expect(await refused('/_openapi.json')).toBeNull();
  });
});
