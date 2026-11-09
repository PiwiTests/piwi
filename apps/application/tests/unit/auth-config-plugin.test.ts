import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_INSECURE_SECRET } from '../../server/utils/crypto';

/**
 * The startup check of the session secret: with authentication on, the server
 * refuses to start without one, with the built-in default, or with one shorter
 * than the 32 characters the session cookie's sealing needs.
 */

vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin);
vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false, authSecret: DEFAULT_INSECURE_SECRET }));

const plugin = (await import('../../server/plugins/auth-config')).default as unknown as () => void;

afterEach(() => vi.unstubAllEnvs());

describe('auth secret startup check', () => {
  test('passes with authentication off, whatever the secret', () => {
    vi.stubEnv('PIWI_AUTH_ENABLED', '');
    vi.stubEnv('PIWI_AUTH_SECRET', 'short');
    expect(plugin).not.toThrow();
  });

  test('refuses a missing or built-in secret', () => {
    vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
    vi.stubEnv('PIWI_AUTH_SECRET', '');
    expect(plugin).toThrow(/PIWI_AUTH_SECRET is missing or set to the built-in default/);
  });

  test('refuses a secret shorter than 32 characters, naming the variable and the minimum', () => {
    vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
    vi.stubEnv('PIWI_AUTH_SECRET', 'x'.repeat(31));
    expect(plugin).toThrow(/PIWI_AUTH_SECRET is shorter than 32 characters/);
  });

  test('accepts a secret of 32 characters', () => {
    vi.stubEnv('PIWI_AUTH_ENABLED', 'true');
    vi.stubEnv('PIWI_AUTH_SECRET', 'x'.repeat(32));
    expect(plugin).not.toThrow();
  });
});
