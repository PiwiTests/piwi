import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PIWI_ENV_VARS } from '#shared/piwi-env-vars';

// The shim is preloaded ahead of the bundled server in the Docker image and imported by
// `npx @piwitests/server`, so it is exercised the same way here: a child Node process
// imports it and prints the environment it leaves behind.
const SHIM = fileURLToPath(new URL('../../../../packages/server/bin/server-env.mjs', import.meta.url));

function envAfterShim(env: Record<string, string>): Record<string, string | undefined> {
  const output = execFileSync(
    process.execPath,
    ['--import', SHIM, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' },
  );
  return JSON.parse(output) as Record<string, string | undefined>;
}

describe('server-env', () => {
  test('maps PIWI_AUTH_* onto the NUXT_* overrides', () => {
    const env = envAfterShim({ PIWI_AUTH_ENABLED: 'true', PIWI_AUTH_SECRET: 's3cret' });

    expect(env.NUXT_AUTH_ENABLED).toBe('true');
    expect(env.NUXT_PUBLIC_AUTH_ENABLED).toBe('true');
    expect(env.NUXT_AUTH_SECRET).toBe('s3cret');
  });

  test('maps every PIWI_OAUTH_* variable and lists the configured providers', () => {
    const env = envAfterShim({
      PIWI_OAUTH_GOOGLE_CLIENT_ID: 'g-id',
      PIWI_OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      PIWI_OAUTH_GITHUB_CLIENT_ID: 'gh-id',
      PIWI_OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
      PIWI_OAUTH_ALLOWED_DOMAINS: 'example.com',
      PIWI_OAUTH_GITHUB_ALLOWED_ORGS: 'acme',
    });

    expect(env.NUXT_OAUTH_GOOGLE_CLIENT_ID).toBe('g-id');
    expect(env.NUXT_OAUTH_GOOGLE_CLIENT_SECRET).toBe('g-secret');
    expect(env.NUXT_OAUTH_GITHUB_CLIENT_ID).toBe('gh-id');
    expect(env.NUXT_OAUTH_GITHUB_CLIENT_SECRET).toBe('gh-secret');
    expect(env.NUXT_OAUTH_ALLOWED_DOMAINS).toBe('example.com');
    expect(env.NUXT_OAUTH_GITHUB_ALLOWED_ORGS).toBe('acme');
    expect(JSON.parse(env.NUXT_PUBLIC_OAUTH_PROVIDERS ?? '[]')).toEqual(['google', 'github']);
  });

  test('a provider missing its secret is not listed', () => {
    const env = envAfterShim({
      PIWI_OAUTH_GOOGLE_CLIENT_ID: 'g-id',
      PIWI_OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      PIWI_OAUTH_GITHUB_CLIENT_ID: 'gh-id',
    });

    expect(JSON.parse(env.NUXT_PUBLIC_OAUTH_PROVIDERS ?? '[]')).toEqual(['google']);
  });

  test('maps the site URL, locale, time zone and wasted-wait patterns', () => {
    const env = envAfterShim({
      PIWI_SITE_URL: 'https://piwi.example.com',
      PIWI_LOCALE: 'fr-FR',
      PIWI_TIME_ZONE: 'Europe/Paris',
      PIWI_WASTED_WAIT_PATTERNS: '*waitForTimeout*,Sleep*',
    });

    expect(env.NUXT_PUBLIC_SITE_URL).toBe('https://piwi.example.com');
    expect(env.NUXT_PUBLIC_DATE_LOCALE).toBe('fr-FR');
    expect(env.NUXT_PUBLIC_DATE_TIME_ZONE).toBe('Europe/Paris');
    expect(env.NUXT_WASTED_WAIT_PATTERNS).toBe('*waitForTimeout*,Sleep*');
  });

  test('takes the site URL from the Fly.io app name when none is set', () => {
    const fly = envAfterShim({ FLY_APP_NAME: 'piwi-acme' });
    expect(fly.PIWI_SITE_URL).toBe('https://piwi-acme.fly.dev');
    expect(fly.NUXT_PUBLIC_SITE_URL).toBe('https://piwi-acme.fly.dev');

    expect(envAfterShim({ FLY_APP_NAME: 'piwi-acme', PIWI_SITE_URL: 'https://piwi.acme.dev' }).PIWI_SITE_URL).toBe(
      'https://piwi.acme.dev',
    );
    expect(
      envAfterShim({ FLY_APP_NAME: 'piwi-acme', NUXT_PUBLIC_SITE_URL: 'https://piwi.acme.dev' }).PIWI_SITE_URL,
    ).toBeUndefined();
    expect(envAfterShim({ FLY_APP_NAME: 'evil.example/x' }).PIWI_SITE_URL).toBeUndefined();
  });

  test('maps the AI provider, research and embedding settings', () => {
    const env = envAfterShim({
      PIWI_AI_PROVIDER: 'openai',
      PIWI_AI_API_KEY: 'key',
      PIWI_AI_MODEL: 'gpt-test',
      PIWI_AI_BASE_URL: 'http://localhost:1234/v1',
      PIWI_AI_AUTO_DIAGNOSE: 'true',
      PIWI_AI_TEMPERATURE: '0',
      PIWI_AI_RESEARCH_PROVIDER: 'anthropic',
      PIWI_AI_RESEARCH_API_KEY: 'research-key',
      PIWI_AI_RESEARCH_MODEL: 'research-model',
      PIWI_AI_RESEARCH_BASE_URL: 'http://localhost:1235/v1',
      PIWI_AI_RESEARCH_TEMPERATURE: '0.2',
      PIWI_AI_EMBEDDING_PROVIDER: 'openai',
      PIWI_AI_EMBEDDING_API_KEY: 'embedding-key',
      PIWI_AI_EMBEDDING_MODEL: 'embedding-model',
      PIWI_AI_EMBEDDING_BASE_URL: 'http://localhost:1236/v1',
    });

    expect(env.NUXT_AI_PROVIDER).toBe('openai');
    expect(env.NUXT_AI_API_KEY).toBe('key');
    expect(env.NUXT_AI_MODEL).toBe('gpt-test');
    expect(env.NUXT_AI_BASE_URL).toBe('http://localhost:1234/v1');
    expect(env.NUXT_AI_AUTO_DIAGNOSE).toBe('true');
    expect(env.NUXT_AI_TEMPERATURE).toBe('0');
    expect(env.NUXT_AI_RESEARCH_PROVIDER).toBe('anthropic');
    expect(env.NUXT_AI_RESEARCH_API_KEY).toBe('research-key');
    expect(env.NUXT_AI_RESEARCH_MODEL).toBe('research-model');
    expect(env.NUXT_AI_RESEARCH_BASE_URL).toBe('http://localhost:1235/v1');
    expect(env.NUXT_AI_RESEARCH_TEMPERATURE).toBe('0.2');
    expect(env.NUXT_AI_EMBEDDING_PROVIDER).toBe('openai');
    expect(env.NUXT_AI_EMBEDDING_API_KEY).toBe('embedding-key');
    expect(env.NUXT_AI_EMBEDDING_MODEL).toBe('embedding-model');
    expect(env.NUXT_AI_EMBEDDING_BASE_URL).toBe('http://localhost:1236/v1');
  });

  test('a NUXT_* value set by the operator wins over the PIWI_* one', () => {
    const env = envAfterShim({
      PIWI_OAUTH_GOOGLE_CLIENT_ID: 'from-piwi',
      PIWI_OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      NUXT_OAUTH_GOOGLE_CLIENT_ID: 'from-nuxt',
      NUXT_PUBLIC_OAUTH_PROVIDERS: '["github"]',
      PIWI_SITE_URL: 'https://from-piwi.example.com',
      NUXT_PUBLIC_SITE_URL: 'https://from-nuxt.example.com',
      PIWI_AI_PROVIDER: 'anthropic',
      NUXT_AI_PROVIDER: 'openai',
    });

    expect(env.NUXT_OAUTH_GOOGLE_CLIENT_ID).toBe('from-nuxt');
    expect(env.NUXT_PUBLIC_OAUTH_PROVIDERS).toBe('["github"]');
    expect(env.NUXT_PUBLIC_SITE_URL).toBe('https://from-nuxt.example.com');
    expect(env.NUXT_AI_PROVIDER).toBe('openai');
  });

  test('does not mirror the variables the server reads straight from process.env', () => {
    const env = envAfterShim({
      PIWI_SECRET_KEY: 'k',
      PIWI_AI_LANGUAGE: 'French',
      PIWI_AI_AUTO_DIAGNOSE_MAX: '5',
      PIWI_AI_MAX_IMAGES: '0',
      PIWI_INTEGRATIONS_SYNC_MINUTES: '5',
    });

    expect(Object.keys(env).filter((key) => key.startsWith('NUXT_'))).toEqual([]);
  });

  test('leaves the environment alone when nothing is configured', () => {
    const env = envAfterShim({});

    const touched = Object.keys(env).filter((key) => key.startsWith('NUXT_'));
    expect(touched).toEqual([]);
  });
});

// Nuxt overrides a runtime config key with `NUXT_` plus the upper-snake-case of its path.
function nuxtOverrideName(path: string[]): string {
  return `NUXT_${path.join('_').replace(/([a-z0-9])([A-Z])/g, '$1_$2')}`.toUpperCase();
}

function stringLeaves(node: Record<string, unknown>, path: string[] = []): Array<{ path: string[]; value: string }> {
  return Object.entries(node).flatMap(([key, value]) => {
    if (typeof value === 'string') return [{ path: [...path, key], value }];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return stringLeaves(value as Record<string, unknown>, [...path, key]);
    }
    return [];
  });
}

const SENTINEL = 'piwi-env-sentinel:';

// The config is built with every registered PIWI_* variable set to a unique value, so the leaves that
// carry one show which runtimeConfig key each variable feeds. The two switches are left out: they
// change the config's shape (demo build) or arrive as booleans, and their tests are above.
async function builtRuntimeConfigLeaves(): Promise<Array<{ path: string[]; value: string }>> {
  const names = Object.keys(PIWI_ENV_VARS).filter((name) => name !== 'PIWI_DEMO_MODE' && name !== 'PIWI_AUTH_ENABLED');
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const globals = globalThis as { defineNuxtConfig?: (config: unknown) => unknown };
  for (const name of names) process.env[name] = `${SENTINEL}${name}`;
  globals.defineNuxtConfig = (config) => config;
  try {
    const { default: config } = await import('../../nuxt.config');
    return stringLeaves((config as { runtimeConfig: Record<string, unknown> }).runtimeConfig);
  } finally {
    delete globals.defineNuxtConfig;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('server-env covers the runtime config', () => {
  // Stamped into the bundle when it is built; there is no run-time value to override.
  const BUILD_STAMPS = new Set(['PIWI_BUILD_SHA']);

  test('every PIWI_* variable in nuxt.config.ts runtimeConfig is mirrored onto the override Nuxt reads', async () => {
    const leaves = (await builtRuntimeConfigLeaves())
      .filter((leaf) => leaf.value.startsWith(SENTINEL))
      .map((leaf) => ({ ...leaf, variable: leaf.value.slice(SENTINEL.length) }))
      .filter((leaf) => !BUILD_STAMPS.has(leaf.variable));

    expect(leaves.map((leaf) => leaf.variable)).toContain('PIWI_SITE_URL');

    const env = envAfterShim(Object.fromEntries(leaves.map((leaf) => [leaf.variable, leaf.value])));

    for (const leaf of leaves) {
      const override = nuxtOverrideName(leaf.path);
      expect(env[override], `${leaf.variable} -> ${override}`).toBe(leaf.value);
    }
  });
});
