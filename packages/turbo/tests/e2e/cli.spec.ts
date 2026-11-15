import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const cli = join(__dirname, '..', '..', 'dist', 'cli.js');
const project = join(__dirname, 'cli-project');

/**
 * Runs `piwi-turbo` in the CLI project, with a cache in the test's output folder, and without this run's Playwright
 * variables or a compile cache or coverage set by the caller.
 */
function run(args: string[], cacheDir: string, env: NodeJS.ProcessEnv = {}) {
  const inherited = Object.entries(process.env).filter(
    ([key]) =>
      !/^(TEST_|PW_|PWTEST|PLAYWRIGHT|PIWI_|NODE_COMPILE_CACHE$|NODE_DISABLE_COMPILE_CACHE$|NODE_V8_COVERAGE$)/.test(
        key,
      ),
  );
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...Object.fromEntries(inherited),
      PIWI_TURBO_DEBUG: '1',
      PIWI_TURBO_CACHE_DIR: cacheDir,
      CLI_PROJECT_OUTPUT: join(cacheDir, '..', 'results'),
      ...env,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test.beforeAll(() => {
  if (!existsSync(cli)) throw new Error('Build the package first: npm run turbo:build');
});

test('runs the tests in the spare worker, with the environment Playwright gives a worker', () => {
  const cache = test.info().outputPath('cache');
  const cold = run(['test'], cache);
  expect(cold.status, cold.output).toBe(0);
  const versions = readdirSync(join(cache, 'code'));
  expect(versions).toHaveLength(1);
  expect(readdirSync(join(cache, 'code', versions[0])).length).toBeGreaterThan(0);
  expect(readdirSync(join(cache, 'compile')).length).toBeGreaterThan(0);

  const warm = run(['test'], cache);
  expect(warm.status, warm.output).toBe(0);
  expect(warm.output).toContain('2 passed');
  const handedOff = warm.output.match(/spare worker (\d+) handed off/)?.[1];
  expect(handedOff, warm.output).toBeDefined();
  expect(warm.output).toContain(`worker pid ${handedOff}`);
});

test('forks a worker as usual when the config changes a variable the spare read as it loaded', () => {
  const cache = test.info().outputPath('cache');
  run(['test'], cache);
  const result = run(['test'], cache, { CLI_PROJECT_CHANGE: 'CI' });
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('spare worker not used: CI changed');
  expect(result.output).toContain('2 passed');
});

test('starts no spare for other commands', () => {
  const result = run(['--version'], test.info().outputPath('cache'));
  expect(result.status, result.output).toBe(0);
  expect(result.output).toMatch(/^Version \d+\.\d+\.\d+/m);
  expect(result.output).not.toContain('spare');
});

test('removes the code caches of other Playwright or Node versions', () => {
  const cache = test.info().outputPath('cache');
  mkdirSync(join(cache, 'code', '1.0.0-v20.0.0-x64'), { recursive: true });
  writeFileSync(join(cache, 'code', '1.0.0-v20.0.0-x64', 'stale.bin'), '');
  expect(run(['--version'], cache).status).toBe(0);
  expect(readdirSync(join(cache, 'code'))).not.toContain('1.0.0-v20.0.0-x64');
});
