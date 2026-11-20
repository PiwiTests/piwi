import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { findPlaywright } from '../../src/start';
import { warmAddress } from '../../src/warm-protocol';
import { version as packageVersion } from '../../package.json';

const cli = join(__dirname, '..', '..', 'dist', 'cli.js');
const project = join(__dirname, 'cli-project');

/**
 * The environment of `piwi-turbo` in the CLI project: a cache in the test's output folder, and none of this run's
 * Playwright variables (but where the browsers are installed) or a compile cache or coverage set by the caller.
 */
function runEnv(cacheDir: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(
    ([key]) =>
      !/^(TEST_|PW_|PWTEST|PLAYWRIGHT(?!_BROWSERS_PATH$)|PIWI_|NODE_COMPILE_CACHE$|NODE_DISABLE_COMPILE_CACHE$|NODE_V8_COVERAGE$)/.test(
        key,
      ),
  );
  return {
    ...Object.fromEntries(inherited),
    PIWI_TURBO_DEBUG: '1',
    PIWI_TURBO_CACHE_DIR: cacheDir,
    CLI_PROJECT_OUTPUT: join(cacheDir, '..', 'results'),
    ...env,
  };
}

/** Runs `piwi-turbo` in the CLI project. */
function run(args: string[], cacheDir: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
    env: runEnv(cacheDir, env),
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Whether a process with this id runs. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  expect(result.output).toMatch(/spare worker \d+ not used: CI changed/);
  expect(result.output).toContain('2 passed');
});

test("the first worker takes the browser the last run's first worker launched", () => {
  const cache = test.info().outputPath('cache');
  const first = run(['test', '--config', 'browser.config.ts'], cache);
  expect(first.status, first.output).toBe(0);
  expect(first.output).toContain('early browser: false');
  const next = run(['test', '--config', 'browser.config.ts'], cache);
  expect(next.status, next.output).toBe(0);
  expect(next.output).toContain('early browser: true');
  const off = run(['test', '--config', 'browser.config.ts'], cache, { PIWI_TURBO_EARLY_BROWSER: '0' });
  expect(off.status, off.output).toBe(0);
  expect(off.output).toContain('early browser: false');
});

test('launches its own browser when the config sets a variable the launch reads', () => {
  const cache = test.info().outputPath('cache');
  run(['test', '--config', 'browser.config.ts'], cache);
  const zoned = run(['test', '--config', 'browser.config.ts'], cache, { CLI_PROJECT_SET: 'TZ=Asia/Tokyo' });
  expect(zoned.status, zoned.output).toBe(0);
  expect(zoned.output).toContain('early browser not used: TZ changed');
  expect(zoned.output).toContain('early browser: false');
  expect(zoned.output).toContain('page time zone: Asia/Tokyo');
  const legacy = run(['test', '--config', 'browser.config.ts'], cache, {
    CLI_PROJECT_SET: 'PLAYWRIGHT_LEGACY_SCREENSHOT=1',
  });
  expect(legacy.status, legacy.output).toBe(0);
  expect(legacy.output).toContain('early browser not used: PLAYWRIGHT_LEGACY_SCREENSHOT changed');
});

test('records no launch whose options an early browser does not take, and forgets the last one', () => {
  const cache = test.info().outputPath('cache');
  const records = () => readdirSync(join(cache, 'early-browser')).filter((file) => file.endsWith('.json'));
  run(['test', '--config', 'browser.config.ts'], cache);
  expect(records()).toHaveLength(1);
  const secret = 'a value only the launch options hold';
  const own = run(['test', '--config', 'browser.config.ts'], cache, { CLI_PROJECT_LAUNCH_ENV: secret });
  expect(own.status, own.output).toBe(0);
  expect(own.output).toContain(
    'early browser not used: the worker launches with options an early browser does not take',
  );
  expect(records()).toHaveLength(0);
  const next = run(['test', '--config', 'browser.config.ts'], cache, { CLI_PROJECT_LAUNCH_ENV: secret });
  expect(next.status, next.output).toBe(0);
  expect(next.output).toContain('early browser: false');
  expect(next.output).not.toContain('early browser not used');
  expect(records()).toHaveLength(0);
});

test('reads no record from a cache folder other users can write to', () => {
  test.skip(process.platform === 'win32', 'folders carry no such modes on Windows');
  const cache = test.info().outputPath('cache');
  run(['test', '--config', 'browser.config.ts'], cache);
  chmodSync(cache, 0o777);
  const result = run(['test', '--config', 'browser.config.ts'], cache);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('no caches: other users can write to');
  expect(result.output).toContain('early browser: false');
  expect(result.output).not.toContain('early browser not used');
});

test('a spare the runner does not use exits at once, with its early browser', async () => {
  const cache = test.info().outputPath('cache');
  run(['test', '--config', 'browser.config.ts'], cache);
  const child = spawn(process.execPath, [cli, 'test', '--config', 'browser.config.ts'], {
    cwd: project,
    env: runEnv(cache, { CLI_PROJECT_SET: 'CI=changed by the config', CLI_PROJECT_SLEEP: '10000' }),
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await expect
      .poll(() => output.match(/spare worker (\d+) not used: CI changed/)?.[1], { timeout: 30_000 })
      .toBeTruthy();
    const spare = Number(output.match(/spare worker (\d+) not used/)![1]);
    await expect.poll(() => running(spare), { timeout: 5_000 }).toBe(false);
    expect(child.exitCode, output).toBeNull();
  } finally {
    child.kill();
    await exited;
  }
});

test('starts no spare for other commands', () => {
  const result = run(['--version'], test.info().outputPath('cache'));
  expect(result.status, result.output).toBe(0);
  expect(result.output).toMatch(/^Version \d+\.\d+\.\d+/m);
  expect(result.output).not.toContain('spare');
});

test('removes the code caches of other Playwright or Node versions, and nothing else', () => {
  const cache = test.info().outputPath('cache');
  for (const folder of ['1.0.0-v20.0.0-x64', 'notes']) {
    mkdirSync(join(cache, 'code', folder), { recursive: true });
    writeFileSync(join(cache, 'code', folder, 'kept.txt'), '');
  }
  expect(run(['--version'], cache).status).toBe(0);
  const left = readdirSync(join(cache, 'code'));
  expect(left).not.toContain('1.0.0-v20.0.0-x64');
  expect(left).toContain('notes');
});

test('prints no warning of its own in an ES module project', () => {
  const result = run(['test', '--config', 'esm.config.mts'], test.info().outputPath('cache'));
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('1 passed');
  expect(result.output).not.toContain('Warning');
});

test.describe('with --warm', () => {
  /** Runs `--warm` commands until one goes to a warm runner, as the daemon the first one started gets ready. */
  async function warmRun(args: string[], cache: string, env: NodeJS.ProcessEnv = {}) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = run(['--warm', ...args], cache, env);
      if (/warm runner \d+ runs the command/.test(result.output)) return result;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('no command went to a warm runner');
  }

  test.afterEach(() => {
    run(['--warm-stop'], test.info().outputPath('cache'));
  });

  test("runs a test command in a warm runner, with the caller's environment and exit code", async () => {
    const cache = test.info().outputPath('cache');
    await warmRun(['test'], cache, { CLI_PROJECT_CALLER: 'the first caller' });
    const passed = await warmRun(['test'], cache, { CLI_PROJECT_CALLER: 'the second caller' });
    expect(passed.status, passed.output).toBe(0);
    expect(passed.output).toContain('2 passed');
    expect(passed.output).toContain('caller: the second caller');
    const none = await warmRun(['test', '--grep', 'no test has this title'], cache);
    expect(none.status, none.output).toBe(1);
    expect(none.output).toContain('No tests found');
  });

  test('runs the command in its own process when a variable the runner read as it loaded changed', async () => {
    const cache = test.info().outputPath('cache');
    await warmRun(['test'], cache, { CI: 'one value' });
    const result = run(['--warm', 'test'], cache, { CI: 'another value' });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('no warm runner: CI changed');
    expect(result.output).toContain('2 passed');
  });

  test('answers no request without the token, and stops when asked', async () => {
    const cache = test.info().outputPath('cache');
    await warmRun(['test'], cache);
    const install = findPlaywright(project)!;
    const address = warmAddress(install, cache, packageVersion);
    const contact = JSON.parse(readFileSync(address.contactFile, 'utf8')) as { address: string };
    const replies = await new Promise<string>((resolve) => {
      const socket = connect(contact.address);
      let received = '';
      socket.on('data', (chunk) => (received += chunk));
      socket.on('close', () => resolve(received));
      socket.on('connect', () =>
        socket.write(
          `${JSON.stringify({ type: 'run', token: 'not the token', args: ['test'], env: {}, cwd: project })}\n`,
        ),
      );
    });
    expect(replies).toBe('');
    run(['--warm-stop'], cache);
    await expect.poll(() => existsSync(address.contactFile)).toBe(false);
  });
});
