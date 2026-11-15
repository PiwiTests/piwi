import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cacheKey, isCachedModule } from '../src/code-cache';
import { spareRefusal, type ForkRequest, type SpareStart } from '../src/spare';
import { cacheRoot, codeCacheFolder, isCodeCacheFolder, runsWorkers } from '../src/startup-env';

const start: SpareStart = {
  entry: '/app/node_modules/playwright/lib/worker/workerProcessEntry.js',
  execArgv: ['--require', '/hook.js'],
  cwd: '/app',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { PATH: '/bin', CI: '1', FORCE_COLOR: '1' },
};
const envRead = new Set(['CI', 'FORCE_COLOR', 'PWDEBUG']);

function request(env: NodeJS.ProcessEnv, change: Partial<ForkRequest> = {}): ForkRequest {
  return {
    args: [],
    options: { detached: false, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    execArgv: ['--require', '/hook.js'],
    cwd: '/app',
    ...change,
  };
}

describe('spareRefusal', () => {
  test('accepts a worker fork with new variables the bundles did not read', () => {
    const env = { ...start.env, BASE_URL: 'http://localhost:3000', PLAYWRIGHT_TEST_BASE_URL: 'http://localhost:3000' };
    expect(spareRefusal(start, envRead, request(env))).toBeUndefined();
  });

  test('refuses while the spare is still loading', () => {
    expect(spareRefusal(start, undefined, request(start.env))).toBe('it was still loading');
  });

  test('refuses when a variable the bundles read has changed or appeared', () => {
    expect(spareRefusal(start, envRead, request({ ...start.env, CI: '' }))).toBe('CI changed');
    expect(spareRefusal(start, envRead, request({ ...start.env, PWDEBUG: '1' }))).toBe('PWDEBUG changed');
  });

  test('refuses when a variable Node reads at start or a debug option has changed', () => {
    expect(spareRefusal(start, envRead, request({ ...start.env, NODE_OPTIONS: '--inspect' }))).toBe(
      'NODE_OPTIONS changed',
    );
    expect(spareRefusal(start, envRead, request({ ...start.env, LC_ALL: 'fr_FR' }))).toBe('LC_ALL changed');
    expect(spareRefusal(start, envRead, request({ ...start.env, HOME: '/home/other' }))).toBe('HOME changed');
    expect(spareRefusal(start, envRead, request({ ...start.env, TMPDIR: '/scratch' }))).toBe('TMPDIR changed');
    expect(spareRefusal(start, envRead, request({ ...start.env, DEBUG_DEPTH: '4' }))).toBe('DEBUG_DEPTH changed');
  });

  test('refuses a fork with other arguments, options, Node options, folder or stdio', () => {
    expect(spareRefusal(start, envRead, request(start.env, { args: ['--x'] }))).toMatch(/options/);
    const options = { env: start.env, stdio: start.stdio, execPath: '/other/node' };
    expect(spareRefusal(start, envRead, request(start.env, { options }))).toMatch(/options/);
    expect(spareRefusal(start, envRead, request(start.env, { execArgv: [] }))).toBe('the Node options changed');
    expect(spareRefusal(start, envRead, request(start.env, { cwd: '/elsewhere' }))).toBe('the working folder changed');
    const inherit = { env: start.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] as const };
    expect(
      spareRefusal(start, envRead, request(start.env, { options: { ...inherit, stdio: [...inherit.stdio] } })),
    ).toBe('the fork asks for other stdio');
  });
});

describe('cacheRoot', () => {
  test('uses the nearest node_modules above the folder', () => {
    const exists = (path: string) => path === join('/repo', 'node_modules');
    expect(cacheRoot(join('/repo', 'packages', 'app'), exists, '/tmp', '1000')).toBe(
      join('/repo', 'node_modules', '.cache', 'piwi-turbo'),
    );
  });

  test("falls back to a folder of the user's own in the temporary folder", () => {
    expect(cacheRoot(join('/repo', 'app'), () => false, '/tmp', '1000')).toBe(join('/tmp', 'piwi-turbo-1000'));
  });
});

describe('isCodeCacheFolder', () => {
  test("recognizes the code cache's folders only", () => {
    expect(isCodeCacheFolder(codeCacheFolder('1.64.1'))).toBe(true);
    expect(isCodeCacheFolder('1.65.0-alpha-1767225600000-v24.11.0-arm64')).toBe(true);
    for (const name of ['my-notes', 'v24.11.0', '1.64.1', 'node_modules', '.git'])
      expect(isCodeCacheFolder(name)).toBe(false);
  });
});

describe('runsWorkers', () => {
  test('is true for a test run', () => {
    expect(runsWorkers(['test'])).toBe(true);
    expect(runsWorkers(['test', 'tests/login.spec.ts', '--grep', 'signs in', '--workers=2'])).toBe(true);
  });

  test('is false for other commands, UI mode, listing, help and debugging', () => {
    for (const args of [['show-report'], ['test', '--ui'], ['test', '--ui-port=0'], ['test', '--list']])
      expect(runsWorkers(args)).toBe(false);
    for (const args of [['test', '--help'], ['test', '-h'], ['test', '--debug'], []])
      expect(runsWorkers(args)).toBe(false);
  });
});

describe('the code cache', () => {
  test("covers Playwright's own modules only", () => {
    expect(isCachedModule('/app/node_modules/playwright-core/lib/coreBundle.js', '"use strict";')).toBe(true);
    expect(isCachedModule('/app/node_modules/@playwright/test/index.js', '')).toBe(true);
    expect(isCachedModule('/app/node_modules/playwright/cli.js', '#!/usr/bin/env node')).toBe(false);
    expect(isCachedModule('/app/node_modules/lodash/index.js', '')).toBe(false);
    expect(isCachedModule('/app/tests/playwright/login.js', '')).toBe(false);
  });

  test('keys a cache by module, size, modification time and role', () => {
    const key = cacheKey('/a.js', 10, 1, 'worker');
    expect(cacheKey('/a.js', 10, 1, 'worker')).toBe(key);
    expect(new Set([cacheKey('/a.js', 11, 1, 'worker'), cacheKey('/a.js', 10, 2, 'worker')]).has(key)).toBe(false);
    expect(cacheKey('/a.js', 10, 1, 'runner test')).not.toBe(key);
  });
});
