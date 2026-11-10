import { describe, expect, test } from 'vitest';
import { parseDotEnv, resolvePiwiConnection } from '../src/dotenv';

describe('parseDotEnv', () => {
  test('reads plain, quoted and exported values, and skips comments', () => {
    expect(
      parseDotEnv(
        [
          '# Piwi',
          'PIWI_DASHBOARD_URL=http://localhost:3000',
          'export PIWI_PROJECT_NAME="Acme Mugs"',
          "PIWI_API_KEY='pd_123' ",
          'PIWI_LABEL=nightly # the job',
          'not a line',
        ].join('\n'),
      ),
    ).toEqual({
      PIWI_DASHBOARD_URL: 'http://localhost:3000',
      PIWI_PROJECT_NAME: 'Acme Mugs',
      PIWI_API_KEY: 'pd_123',
      PIWI_LABEL: 'nightly',
    });
  });
});

describe('resolvePiwiConnection', () => {
  test('flags, then the environment, then .env', () => {
    expect(
      resolvePiwiConnection({
        flags: { project: 'web' },
        env: { PIWI_DASHBOARD_URL: 'https://piwi.example/', PIWI_API_KEY: 'pd_env' },
        dotEnv: { PIWI_DASHBOARD_URL: 'http://ignored', PIWI_API_KEY: 'pd_dotenv' },
      }),
    ).toEqual({ serverUrl: 'https://piwi.example', apiKey: 'pd_env', project: 'web' });
    expect(
      resolvePiwiConnection({
        dotEnv: { PIWI_DASHBOARD_URL: 'https://piwi.example', PIWI_API_KEY: 'pd_dotenv', PIWI_PROJECT_NAME: 'web' },
      }),
    ).toEqual({ serverUrl: 'https://piwi.example', apiKey: 'pd_dotenv', project: 'web' });
  });

  test('a flag URL takes the key from the environment: both are the person’s own', () => {
    expect(
      resolvePiwiConnection({ flags: { serverUrl: 'https://piwi.example' }, env: { PIWI_API_KEY: 'pd_env' } })!.apiKey,
    ).toBe('pd_env');
  });

  test("the environment's key never goes to a URL a workspace .env names", () => {
    const found = resolvePiwiConnection({
      env: { PIWI_API_KEY: 'pd_mine' },
      dotEnv: { PIWI_DASHBOARD_URL: 'https://evil.example' },
    });
    expect(found).toEqual({ serverUrl: 'https://evil.example', apiKey: null, project: '' });
  });

  test("a workspace .env's key never goes to the environment's URL", () => {
    const found = resolvePiwiConnection({
      env: { PIWI_DASHBOARD_URL: 'https://piwi.example' },
      dotEnv: { PIWI_DASHBOARD_URL: 'https://piwi.example', PIWI_API_KEY: 'pd_dotenv' },
    });
    expect(found!.apiKey).toBeNull();
  });

  test("the desktop app's token serves only its own URL", () => {
    const desktop = { url: 'http://127.0.0.1:3000', token: 'pd_desk' };
    expect(resolvePiwiConnection({ desktop })).toEqual({
      serverUrl: 'http://127.0.0.1:3000',
      apiKey: 'pd_desk',
      project: '',
      desktop: true,
    });
    expect(resolvePiwiConnection({ env: { PIWI_DASHBOARD_URL: 'https://other' }, desktop })!.apiKey).toBeNull();
    // A URL from any layer that is the desktop app's own gets its token when that layer has no key.
    expect(resolvePiwiConnection({ dotEnv: { PIWI_DASHBOARD_URL: 'http://127.0.0.1:3000/' }, desktop })!.apiKey).toBe(
      'pd_desk',
    );
    expect(resolvePiwiConnection({})).toBeNull();
  });

  test("a key is the desktop app's when the app's file gave it or the app's own run marks it", () => {
    const desktop = { url: 'http://127.0.0.1:3000', token: 'pd_desk' };
    const run = { PIWI_DASHBOARD_URL: 'http://127.0.0.1:3000', PIWI_API_KEY: 'pd_desk', PIWI_DESKTOP_KEY: '1' };
    expect(resolvePiwiConnection({ env: run })!.desktop).toBe(true);
    expect(resolvePiwiConnection({ dotEnv: { PIWI_DASHBOARD_URL: 'http://127.0.0.1:3000/' }, desktop })!.desktop).toBe(
      true,
    );
    // A key the person chose is theirs, with or without the mark in the environment.
    expect(resolvePiwiConnection({ flags: { apiKey: 'pd_mine' }, env: run })!.desktop).toBeUndefined();
    expect(resolvePiwiConnection({ env: { ...run, PIWI_DESKTOP_KEY: undefined } })!.desktop).toBeUndefined();
    expect(
      resolvePiwiConnection({
        env: { PIWI_DASHBOARD_URL: 'https://piwi.example', PIWI_API_KEY: 'pd_team' },
        dotEnv: { PIWI_DASHBOARD_URL: 'http://127.0.0.1:3000', PIWI_API_KEY: 'pd_desk' },
        desktop,
      })!.desktop,
    ).toBeUndefined();
  });

  test("a key equal to the app's token is the app's, wherever it was set", () => {
    const base = { PIWI_DASHBOARD_URL: 'https://piwi.example', PIWI_API_KEY: 'pd_desk' };
    const desktopToken = 'pd_desk';
    expect(resolvePiwiConnection({ env: base, desktopToken })!.desktop).toBe(true);
    expect(resolvePiwiConnection({ dotEnv: base, desktopToken })!.desktop).toBe(true);
    expect(resolvePiwiConnection({ flags: { apiKey: 'pd_desk' }, env: base, desktopToken })!.desktop).toBe(true);
    expect(resolvePiwiConnection({ env: base, desktopToken: 'pd_unrelated' })!.desktop).toBeUndefined();
    expect(resolvePiwiConnection({ env: base, desktopToken: null })!.desktop).toBeUndefined();
  });
});
