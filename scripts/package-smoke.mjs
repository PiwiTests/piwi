#!/usr/bin/env node
// Smoke test for the npm packages, run the way a user runs them: installs the packed
// @piwitests/server and @piwitests/reporter tarballs into a new project, starts the
// dashboard with `npx @piwitests/server`, runs a small Playwright suite through the
// reporter, then checks the run and the dashboard pages. CI packs the tarballs on Linux
// and runs this on Linux, macOS and Windows (`package-smoke` in .github/workflows/ci.yml).
//
// Usage:
//   node scripts/package-smoke.mjs <dir> [--playwright floor]
//
// <dir> holds the two tarballs. The suite runs on the Playwright version the repository locks, or with
// `--playwright floor` on the oldest one the reporter supports (scripts/playwright-floor.mjs). From the repository root, after building the reporter and
// the application, pack them into an existing <dir>:
//   npm pack --workspace @piwitests/server --workspace @piwitests/reporter --pack-destination <dir>
//
// The project lives in the OS temp directory, so nothing resolves from the workspace's
// node_modules: a file missing from a tarball fails here the way it fails for a user.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { playwrightFloor } from './playwright-floor.mjs';

const PROJECT_NAME = 'package-smoke';
const SERVER_READY_TIMEOUT_MS = 180_000;
const RUN_SETTLED_TIMEOUT_MS = 60_000;
const ACTIVE_RUN_STATUSES = new Set(['initializing', 'running', 'finalizing']);
const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(import.meta.dirname, '..');

const usage = `Usage:
  node scripts/package-smoke.mjs <dir holding piwitests-server-*.tgz and piwitests-reporter-*.tgz> [--playwright floor]`;

// The suite: one passing, one failing and one skipped test. The capture fixtures load in
// the worker, and no test opens a page, so no browser is needed.
const SPEC = `import { test as base, expect } from '@playwright/test';
import { piwiFixtures } from '@piwitests/reporter';

const test = base.extend(piwiFixtures);

test('passes', () => {
  expect(1 + 1).toBe(2);
});

test('fails on purpose', () => {
  expect(1 + 1, 'the package smoke test expects exactly this failure').toBe(3);
});

test.skip('is skipped', () => {});
`;

const log = (message) => console.log(`[package-smoke] ${message}`);

function findTarball(dir, prefix) {
  const matches = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.tgz'));
  if (matches.length !== 1) throw new Error(`expected one ${prefix}*.tgz in ${dir}, found ${matches.length}`);
  return path.resolve(dir, matches[0]);
}

function lockedVersion(name) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`${name} is not in package-lock.json`);
  return version;
}

function installedVersion(projectDir, name) {
  return JSON.parse(fs.readFileSync(path.join(projectDir, 'node_modules', name, 'package.json'), 'utf8')).version;
}

function writeProject(projectDir, serverUrl) {
  const files = {
    'package.json': JSON.stringify({ name: 'piwi-package-smoke', private: true, type: 'module' }, null, 2),
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';

export default wrapConfig(defineConfig({ testDir: 'tests' }), {
  serverUrl: ${JSON.stringify(serverUrl)},
  projectName: ${JSON.stringify(PROJECT_NAME)},
  outputFile: 'piwi-run.json',
});
`,
    'tests/smoke.spec.ts': SPEC,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(projectDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

// No PIWI_*, NUXT_* or NITRO_* setting from the calling shell reaches the server or the
// reporter, so the server always starts on a fresh SQLite database inside the project.
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PIWI|NUXT|NITRO)_/i.test(key)));
  return { ...env, ...extra };
}

// The smoke run's results stay out of the CI job: no step outputs, job summary or
// annotation from the reporter's GitHub Actions integration.
function reporterEnv() {
  const env = cleanEnv();
  delete env.GITHUB_ACTIONS;
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_STEP_SUMMARY;
  return env;
}

// Commands run through the shell so `npm` and `npx` resolve to their .cmd shims on Windows.
function commandLine(command, args) {
  return [command, ...args].map((part) => (/[\s"&|<>^]/.test(part) ? `"${part}"` : part)).join(' ');
}

function run(command, args, options) {
  const result = spawnSync(commandLine(command, args), { shell: true, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function startServer(projectDir, port) {
  const child = spawn(commandLine('npx', ['--no', '@piwitests/server']), {
    cwd: projectDir,
    env: cleanEnv({ PORT: String(port) }),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it also stops the node process npx starts.
    detached: !isWindows,
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`[server] ${line}`));
  }
  return child;
}

function killServer(child, signal = 'SIGTERM') {
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  killServer(child);
  // Unref'd, so the timer does not hold the process open once the server has stopped.
  const timedOut = await Promise.race([exited.then(() => false), delay(10_000, true, { ref: false })]);
  if (timedOut) killServer(child, 'SIGKILL');
}

async function get(url, timeoutMs = 30_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`the server exited (code ${server.exitCode ?? server.signalCode}) before /api/health answered`);
    }
    const response = await get(`${baseUrl}/api/health`, 5_000).catch(() => null);
    if (response?.ok) return;
    await delay(1_000);
  }
  throw new Error(`the server did not answer /api/health within ${SERVER_READY_TIMEOUT_MS / 1000}s`);
}

async function expectPage(url, what) {
  const response = await get(url);
  const body = await response.text();
  if (response.status !== 200 || !body.includes('<title>')) {
    throw new Error(`${what} (${url}) answered HTTP ${response.status} instead of a rendered page`);
  }
}

async function waitForSettledRun(baseUrl, runId) {
  const deadline = Date.now() + RUN_SETTLED_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await get(`${baseUrl}/api/test-runs/${runId}`);
    } catch (error) {
      // The server can reset a connection while it is still storing the run's
      // files; the run is settling, so ask again rather than failing here.
      lastError = error;
      await delay(1_000);
      continue;
    }
    lastError = null;
    if (!response.ok) throw new Error(`GET /api/test-runs/${runId} answered HTTP ${response.status}`);
    const testRun = await response.json();
    if (!ACTIVE_RUN_STATUSES.has(testRun.status)) return testRun;
    await delay(1_000);
  }
  if (lastError) {
    throw new Error(`GET /api/test-runs/${runId} kept failing: ${lastError.message} (${lastError.cause ?? 'no cause'})`);
  }
  throw new Error(`run ${runId} was still active after ${RUN_SETTLED_TIMEOUT_MS / 1000}s`);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function smoke(tarballDir, projectDir, playwright, onServer) {
  const serverTarball = findTarball(tarballDir, 'piwitests-server-');
  const reporterTarball = findTarball(tarballDir, 'piwitests-reporter-');
  const playwrightVersion = playwright === 'floor' ? playwrightFloor() : lockedVersion('@playwright/test');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  log(`Project: ${projectDir}`);
  writeProject(projectDir, baseUrl);

  log(
    `Installing ${path.basename(serverTarball)}, ${path.basename(reporterTarball)} and @playwright/test@${playwrightVersion}`,
  );
  const install = run(
    'npm',
    ['install', '--no-audit', '--no-fund', serverTarball, reporterTarball, `@playwright/test@${playwrightVersion}`],
    { cwd: projectDir },
  );
  if (install.status !== 0) throw new Error(`npm install exited with code ${install.status}`);
  const serverVersion = installedVersion(projectDir, '@piwitests/server');
  const reporterVersion = installedVersion(projectDir, '@piwitests/reporter');

  log('Running the reporter CLI');
  const cli = run('npx', ['--no', '@piwitests/reporter', '--help'], {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (cli.status !== 0 || !cli.stdout.includes('Usage:')) {
    throw new Error(`npx @piwitests/reporter --help exited with code ${cli.status}:\n${cli.stdout}${cli.stderr}`);
  }

  log(`Starting the server with npx @piwitests/server on port ${port}`);
  const server = startServer(projectDir, port);
  onServer(server);
  await waitForServer(baseUrl, server);

  const version = await (await get(`${baseUrl}/api/version`)).json();
  expectEqual(version.appVersion, serverVersion, 'the version the server reports');
  await expectPage(`${baseUrl}/`, 'the home page');
  // The files route loads sharp, so a native binary missing for this platform answers 500.
  const files = await get(`${baseUrl}/api/files/${PROJECT_NAME}/missing.png`);
  if (files.status >= 500) throw new Error(`the files route answered HTTP ${files.status}; sharp may not load here`);

  log('Running the Playwright suite through the reporter');
  const tests = run('npx', ['--no', 'playwright', 'test'], { cwd: projectDir, env: reporterEnv() });
  expectEqual(tests.status, 1, 'the playwright test exit code (the suite has one failing test)');

  const output = JSON.parse(fs.readFileSync(path.join(projectDir, 'piwi-run.json'), 'utf8'));
  const testRun = await waitForSettledRun(baseUrl, output.runId);
  expectEqual(testRun.passedTests, 1, 'passed tests in the run');
  expectEqual(testRun.failedTests, 1, 'failed tests in the run');
  expectEqual(testRun.skippedTests, 1, 'skipped tests in the run');
  expectEqual(testRun.reporterVersion, reporterVersion, 'the reporter version the run records');
  await expectPage(output.runUrl, 'the run page');

  if (!fs.existsSync(path.join(projectDir, '.data', 'piwi.db'))) {
    throw new Error('the server did not create .data/piwi.db in the directory it was started from');
  }
  log(
    `Passed: server ${serverVersion} and reporter ${reporterVersion} with Playwright ${playwrightVersion} on ${process.platform}, Node ${process.version}`,
  );
}

async function main() {
  const [tarballDir, ...options] = process.argv.slice(2);
  const playwright = options[0] === '--playwright' ? options[1] : undefined;
  if (!tarballDir || options.length !== (playwright === 'floor' ? 2 : 0)) {
    console.error(usage);
    return 2;
  }

  // The real path: the temp directory is a short 8.3 name on Windows runners and a
  // symlink on macOS, neither of which a project directory usually is.
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'piwi-smoke-'));
  let server = null;
  process.once('SIGINT', () => {
    if (server) killServer(server, 'SIGKILL');
    process.exit(130);
  });

  try {
    await smoke(tarballDir, projectDir, playwright, (started) => (server = started));
  } catch (error) {
    console.error(`[package-smoke] FAILED: ${error.message}`);
    if (error.cause) console.error(`[package-smoke] Cause: ${error.cause}`);
    if (server) console.error(`[package-smoke] Server exit code: ${server.exitCode ?? 'still running'}`);
    log(`Left the project at ${projectDir}`);
    return 1;
  } finally {
    if (server) await stopServer(server);
  }
  try {
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    log(`Could not remove ${projectDir}: ${error.message}`);
  }
  return 0;
}

process.exitCode = await main();
